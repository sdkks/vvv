import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { ScanLogEntry } from '@vvv/shared';
import { getCurrentScan, getScanLogs, scanLogsStream } from './api';
import {
  appendLogEntry,
  atTail,
  durationLabel,
  formatDuration,
  levelLabels,
  logTime,
  logTimeFull,
  logsLevel,
  logsScope,
  logsView,
  parseLogEntry,
  stepLabels,
  type LogLevelFilter,
} from './logs-state';
import { PageHeading } from './PageHeading';

export function Logs() {
  const [search, setSearch] = useSearchParams();
  const scanId = logsScope(search);
  const level = logsLevel(search);
  const current = useQuery({
    queryKey: ['scan-current'],
    queryFn: ({ signal }) => getCurrentScan(signal),
    retry: false,
    refetchInterval: 5000,
  });
  const running = current.data?.status === 'running' ? current.data.id : undefined;
  // A scoped scan stays streamable after it finishes: the server replays the retained tail.
  const liveTarget = scanId ?? running;
  const liveRunning = liveTarget !== undefined && liveTarget === running;
  const view = logsView(search, scanId !== undefined && liveRunning);
  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(changes))
      if (value) next.set(key, value);
      else next.delete(key);
    void setSearch(next);
  };
  const allScans = new URLSearchParams(search);
  allScans.delete('scan_id');
  return (
    <>
      <PageHeading>Logs</PageHeading>
      <p>Scan activity and step timing.</p>
      <div className="log-controls">
        <fieldset>
          <legend>View</legend>
          <label className="scan-option">
            <input
              type="radio"
              name="log-view"
              checked={view === 'history'}
              onChange={() => update({ view: 'history' })}
            />
            History
          </label>
          <label className="scan-option">
            <input
              type="radio"
              name="log-view"
              checked={view === 'live'}
              disabled={liveTarget === undefined}
              onChange={() => update({ view: 'live' })}
            />
            Live
          </label>
        </fieldset>
        <div className="log-level">
          <label htmlFor="log-level">Level</label>
          <select
            id="log-level"
            value={level}
            onChange={(event) => update({ level: event.target.value })}
          >
            <option value="">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warnings</option>
            <option value="error">Errors</option>
          </select>
        </div>
        <p className="metadata">
          {scanId === undefined ? (
            'All scans'
          ) : (
            <>
              Scan {scanId} · <Link to={`/logs?${allScans}`}>Show all scans</Link>
            </>
          )}
        </p>
      </div>
      {view === 'history' ? (
        <History
          key={`${scanId ?? 'all'}:${level}`}
          scanId={scanId}
          level={level}
          allScans={`/logs?${allScans}`}
          showAllLevels={() => update({ level: '' })}
        />
      ) : liveTarget === undefined ? (
        <p>No scan is running. Switch to History to review saved logs.</p>
      ) : (
        <Live key={liveTarget} scanId={liveTarget} level={level} running={liveRunning} />
      )}
    </>
  );
}

function LogItem({ entry, scoped }: { entry: ScanLogEntry; scoped: boolean }) {
  return (
    <li className={`log-entry log-${entry.level}`}>
      <time dateTime={entry.ts} title={logTimeFull(entry.ts)}>
        {logTime(entry.ts)}
      </time>
      <span className={`log-badge log-level-${entry.level}`}>{levelLabels[entry.level]}</span>
      <span className="log-badge">{stepLabels[entry.step]}</span>
      <span className="log-detail">{entry.detail}</span>
      {entry.duration_ms !== undefined && (
        <span className="log-duration">
          <span className="visually-hidden">{durationLabel(entry.duration_ms)}</span>
          <span aria-hidden="true">{formatDuration(entry.duration_ms)}</span>
        </span>
      )}
      {!scoped && entry.scan_id > 0 && (
        <Link className="log-scan" to={`/logs?scan_id=${entry.scan_id}`}>
          Scan {entry.scan_id}
        </Link>
      )}
    </li>
  );
}

function History({
  scanId,
  level,
  allScans,
  showAllLevels,
}: {
  scanId: number | undefined;
  level: LogLevelFilter;
  allScans: string;
  showAllLevels: () => void;
}) {
  const [cursor, setCursor] = useState('');
  const [older, setOlder] = useState<ScanLogEntry[]>([]);
  const query = useQuery({
    queryKey: ['scan-logs', scanId ?? 0, level, cursor],
    queryFn: ({ signal }) => getScanLogs(scanId, level, cursor, signal),
    retry: false,
  });
  // Older pages accumulate so loading one never scrolls the operator away from what they read.
  const items = useMemo(() => {
    const seen = new Set(older.map((entry) => entry.id));
    return [...older, ...(query.data?.items ?? []).filter((entry) => !seen.has(entry.id))];
  }, [older, query.data]);
  const next = query.data?.next_cursor;
  const refresh = () => {
    setOlder([]);
    if (cursor) setCursor('');
    else void query.refetch();
  };
  const loadOlder = () => {
    if (!next || !query.data) return;
    setOlder((previous) => [...previous, ...query.data.items]);
    setCursor(next);
  };
  return (
    <section aria-label="Log history">
      <div className="toolbar">
        <button disabled={query.isFetching} onClick={refresh}>
          Refresh logs
        </button>
      </div>
      {query.isPending && !items.length && <p role="status">Loading logs…</p>}
      {query.isError && (
        <p role="alert">
          {query.error.message} <button onClick={() => void query.refetch()}>Retry</button>
        </p>
      )}
      {query.data && !items.length && (
        <p>
          No log entries for this scan and level.{' '}
          {level !== '' && <button onClick={showAllLevels}>Show all levels</button>}{' '}
          {scanId !== undefined && <Link to={allScans}>Show all scans</Link>}
        </p>
      )}
      {items.length > 0 && (
        <ul className="log-list" aria-label="Scan log history" aria-busy={query.isFetching}>
          {items.map((entry) => (
            <LogItem key={entry.id} entry={entry} scoped={scanId !== undefined} />
          ))}
        </ul>
      )}
      {next && (
        <button disabled={query.isFetching} onClick={loadOlder}>
          Load older logs
        </button>
      )}
    </section>
  );
}

function Live({
  scanId,
  level,
  running,
}: {
  scanId: number;
  level: LogLevelFilter;
  running: boolean;
}) {
  const [entries, setEntries] = useState<ScanLogEntry[]>([]);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [following, setFollowing] = useState(true);
  const [anchor, setAnchor] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const source = new EventSource(scanLogsStream(scanId));
    source.onopen = () => setStatus('connected');
    source.onerror = () => setStatus('reconnecting');
    source.addEventListener('log', (event: MessageEvent<string>) => {
      const entry = parseLogEntry(event.data);
      if (entry) setEntries((previous) => appendLogEntry(previous, entry));
    });
    return () => source.close();
  }, [scanId]);
  // Follow the tail only while the operator stays at the bottom; never move their position.
  useEffect(() => {
    const node = viewport.current;
    if (node && following) node.scrollTop = node.scrollHeight;
  }, [entries, following]);
  const onScroll = () => {
    const node = viewport.current;
    if (!node) return;
    const tail = atTail(node);
    if (tail !== following) {
      setFollowing(tail);
      setAnchor(entries.length);
    }
  };
  const jump = () => {
    const node = viewport.current;
    if (node) node.scrollTop = node.scrollHeight;
    setFollowing(true);
    setAnchor(entries.length);
  };
  const unseen = following ? 0 : Math.max(0, entries.length - anchor);
  const visible = level ? entries.filter((entry) => entry.level === level) : entries;
  return (
    <section aria-label="Live scan log">
      <p role="status">
        {status === 'connecting'
          ? 'Connecting to live logs…'
          : status === 'reconnecting'
            ? 'Reconnecting to live logs…'
            : running
              ? 'Live — connected.'
              : 'Scan finished — no new entries expected.'}
      </p>
      <div className="log-viewport" ref={viewport} onScroll={onScroll}>
        <ol className="log-list" role="log" aria-label="Live scan log entries">
          {visible.map((entry) => (
            <LogItem key={entry.id} entry={entry} scoped />
          ))}
        </ol>
      </div>
      {!entries.length && status === 'connected' && <p>Waiting for log entries…</p>}
      {unseen > 0 && (
        <button className="log-jump" onClick={jump}>
          {unseen} new {unseen === 1 ? 'entry' : 'entries'} — Jump to latest
        </button>
      )}
    </section>
  );
}
