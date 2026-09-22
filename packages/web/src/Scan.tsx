import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CurrentScanResponse, ScanProgress } from '@vvv/shared';
import { cancelScan, getCurrentScan, getScanDirs, getScanErrors, startScan } from './api';
import { elapsedScan, mergeScan, parseProgress, scanLabels, scanState } from './scan-state';
import { previousCursor, visitCursor } from './group-review';
import { PageHeading } from './PageHeading';

const scanKey = ['scan-current'];
export function Scan() {
  const cache = useQueryClient();
  const [now, setNow] = useState(Date.now);
  const [reconnecting, setReconnecting] = useState(false);
  const query = useQuery({
    queryKey: scanKey,
    queryFn: async ({ signal }) => {
      const snapshot = await getCurrentScan(signal);
      return mergeScan(cache.getQueryData<CurrentScanResponse>(scanKey), snapshot);
    },
    retry: false,
    refetchInterval: 5000,
  });
  const dirs = useQuery({
    queryKey: ['scan-dirs'],
    queryFn: ({ signal }) => getScanDirs(signal),
    retry: false,
  });
  const scan = query.data;
  const state = scanState(scan);
  const id = scan?.id;
  const { refetch } = query;
  useEffect(() => {
    setReconnecting(false);
    if (state !== 'running' || id === undefined) return;
    let failures = 0;
    const source = new EventSource(`/api/scans/${id}/events`);
    source.onopen = () => {
      failures = 0;
      setReconnecting(false);
      void refetch();
    };
    source.onerror = () => {
      setReconnecting(++failures > 1);
      void refetch();
    };
    source.addEventListener('progress', (event: MessageEvent<string>) => {
      const snapshot = parseProgress(event.data);
      if (snapshot?.id === id)
        cache.setQueryData<CurrentScanResponse>(scanKey, (current) => mergeScan(current, snapshot));
      else void refetch();
    });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      source.close();
      clearInterval(timer);
    };
  }, [cache, id, state, refetch]);
  const action = useMutation({
    mutationFn: (command: 'start' | number) =>
      command === 'start' ? startScan() : cancelScan(command),
    onSettled: () => refetch(),
  });
  const cancelling = action.isSuccess && action.variables === id && state === 'running';
  return (
    <>
      <PageHeading>Scan</PageHeading>
      {query.isPending && <p role="status">Loading scan…</p>}
      {query.isError && (
        <p role="alert">
          Progress unavailable; displayed values may be stale. {query.error.message}
        </p>
      )}
      {dirs.isError && (
        <p role="alert">
          {dirs.error.message}{' '}
          <button onClick={() => void dirs.refetch()}>Retry directories</button>
        </p>
      )}
      {action.isError && <p role="alert">{action.error.message}</p>}
      <section aria-label="Scan progress" aria-live="polite">
        {query.data !== undefined && <h2>{scanLabels[state]}</h2>}
        {state === 'interrupted' && (
          <p>Start a scan to continue; already-processed, unchanged files will not be reworked.</p>
        )}
        {state === 'cancelled' && (
          <p>Work already completed is saved. Start another scan to continue.</p>
        )}
        {scan && (
          <>
            {(state === 'running' || (state === 'done' && scan.discovered > 0)) && (
              <progress
                className="scan-progress"
                aria-label="Files processed out of discovered files"
                max={Math.max(1, scan.discovered)}
                value={
                  scan.discovered > 0 && (state === 'done' || scan.current_file)
                    ? scan.processed
                    : undefined
                }
              />
            )}
            <p>
              {scan.processed} processed · {scan.discovered} discovered · {scan.errors} errors
            </p>
            <p className="metadata">Elapsed: {elapsedScan(scan, now)}</p>
            {state === 'running' && (
              <>
                <p>Discovering and processing files — total may grow. No percentage estimate.</p>
                <p className="metadata">
                  Current file: {scan.current_file ?? 'Discovering files or waiting for work…'}
                </p>
              </>
            )}
          </>
        )}
        {reconnecting && (
          <p>Reconnecting to live updates… Checking saved progress every 5 seconds.</p>
        )}
        {cancelling && <p>Cancellation requested — waiting for current files to finish.</p>}
      </section>
      {dirs.data?.items.length === 0 && (
        <p>
          No scan directories registered. <Link to="/directories">Add a scan directory</Link> first.
        </p>
      )}
      <div className="toolbar">
        {state === 'running' ? (
          <button
            disabled={action.isPending || cancelling}
            onClick={() => {
              if (
                id &&
                window.confirm(
                  'Cancel this scan? Completed work is saved. Current files may finish before it stops.'
                )
              )
                action.mutate(id);
            }}
          >
            Cancel scan
          </button>
        ) : (
          <button
            disabled={
              action.isPending ||
              query.data === undefined ||
              query.isError ||
              !dirs.data?.items.length
            }
            onClick={() => action.mutate('start')}
          >
            {action.isPending ? 'Starting scan…' : 'Start scan'}
          </button>
        )}
        <button disabled={query.isFetching} onClick={() => void refetch()}>
          Refresh progress
        </button>
        <Link to="/directories">Manage directories</Link>
        <Link to="/groups">View duplicate groups</Link>
      </div>
      {state === 'done' && (
        <p>
          Scanning is complete. Duplicate matching may still be finishing; refresh Groups to see
          results.
        </p>
      )}
      {scan && <ScanErrors key={scan.id} scan={scan} />}
    </>
  );
}

function ScanErrors({ scan }: { scan: ScanProgress }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState(['']);
  const cursor = history.at(-1) ?? '';
  const query = useQuery({
    queryKey: ['scan-errors', scan.id, cursor, scan.status],
    queryFn: ({ signal }) => getScanErrors(scan.id, cursor, signal),
    enabled: open,
    retry: false,
    refetchInterval: scan.status === 'running' ? 5000 : false,
  });
  const previous = previousCursor(history, cursor);
  const next = query.data?.next_cursor;
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Per-file errors ({scan.errors})</summary>
      {open && (
        <>
          {query.isPending && <p role="status">Loading errors…</p>}
          {query.isError && <p role="alert">{query.error.message}</p>}
          {query.data?.items.length === 0 && <p>No stored errors on this page.</p>}
          <ul className="scan-list">
            {query.data?.items.map((error) => (
              <li key={error.file_id}>
                <p>
                  <strong>{error.path}</strong>
                  <br />
                  {error.error}
                </p>
              </li>
            ))}
          </ul>
          <nav className="toolbar" aria-label="Error pages">
            <button
              disabled={previous === undefined || query.isFetching}
              onClick={() => setHistory(history.slice(0, -1))}
            >
              Previous errors
            </button>
            <button
              disabled={!next || query.isFetching || query.isError}
              onClick={() => next && setHistory(visitCursor(history, cursor, next))}
            >
              Next errors
            </button>
            <button disabled={query.isFetching} onClick={() => void query.refetch()}>
              Refresh errors
            </button>
          </nav>
        </>
      )}
    </details>
  );
}
