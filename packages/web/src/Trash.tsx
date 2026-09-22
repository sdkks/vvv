import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PurgeResponse, RestoreResponse } from '@vvv/shared';
import { getSettings, getTrash, purgeTrash, restoreTrash } from './api';
import { formatBytes, previousCursor, toggleMarked, visitCursor } from './group-review';
import { displayDate, fileFailure, policySummary, purgeAfter } from './trash-state';
import { PageHeading } from './PageHeading';

export function Trash() {
  const [search, setSearch] = useSearchParams();
  const cursor = search.get('cursor') ?? '';
  const [history, setHistory] = useState([cursor]);
  const [selected, setSelected] = useState(new Set<number>());
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ['trash', cursor],
    queryFn: () => getTrash(cursor),
    retry: false,
  });
  const policy = useQuery({ queryKey: ['settings'], queryFn: getSettings, retry: false });
  const action = useMutation({
    mutationFn: (operation: () => Promise<PurgeResponse | RestoreResponse>) => operation(),
    onSuccess: async (result) => {
      setSelected(new Set(result.failed.map((item) => item.trash_id)));
      await cache.invalidateQueries({ queryKey: ['trash'] });
      await cache.invalidateQueries({ queryKey: ['groups'] });
    },
  });
  function page(next: string | undefined) {
    if (next === undefined) return;
    setHistory(visitCursor(history, cursor, next));
    setSelected(new Set());
    action.reset();
    void setSearch(next ? { cursor: next } : {});
  }
  const items = query.data?.items ?? [];
  const chosen = items.filter((item) => selected.has(item.id));
  const previous = previousCursor(history, cursor);
  return (
    <>
      <PageHeading>Trash</PageHeading>
      {policy.data && <p>{policySummary(policy.data)}</p>}
      {policy.isError && (
        <p role="alert">
          {policy.error.message} <button onClick={() => void policy.refetch()}>Retry policy</button>
        </p>
      )}
      {query.isPending && <p role="status">Loading Trash…</p>}
      {query.isError && (
        <p role="alert">
          {query.error.message} <button onClick={() => void query.refetch()}>Retry</button>
        </p>
      )}
      {query.data && !items.length && (
        <p>
          {cursor
            ? 'No more files on this page. Go back to see earlier items.'
            : 'Trash is empty. Files you quarantine appear here.'}
        </p>
      )}
      {action.isError && <p role="alert">{action.error.message}</p>}
      {action.data && (
        <p role="status">
          {'purged' in action.data
            ? `${action.data.purged} permanently deleted`
            : `${action.data.restored.length} restored`}
          ; {action.data.failed.length} failed.
        </p>
      )}
      <ul className="scan-list trash-list">
        {items.map((item) => (
          <li key={item.id}>
            <label className="scan-option">
              <input
                type="checkbox"
                disabled={action.isPending}
                checked={selected.has(item.id)}
                onChange={() => setSelected(toggleMarked(selected, item.id))}
              />
              <span className="file-path">{item.path}</span>
            </label>
            <p className="metadata">
              {formatBytes(item.size)} · Quarantined: {displayDate(item.quarantined_at)}
              <br />
              Purge after: {purgeAfter(item.purge_after)}
            </p>
            <button
              disabled={action.isPending}
              onClick={() => action.mutate(() => restoreTrash([item.id]))}
            >
              Restore
            </button>
            {action.data?.failed
              .filter((failure) => failure.trash_id === item.id)
              .map((failure) => (
                <p role="alert" key={failure.trash_id}>
                  {fileFailure(failure.error)}
                </p>
              ))}
          </li>
        ))}
      </ul>
      <button
        disabled={!chosen.length || action.isPending || !policy.data}
        onClick={() => {
          if (
            policy.data &&
            window.confirm(
              `Permanently delete ${chosen.length} files (${formatBytes(chosen.reduce((sum, item) => sum + item.size, 0))})? This cannot be undone. ${policySummary(policy.data)}`
            )
          )
            action.mutate(() => purgeTrash(chosen.map((item) => item.id)));
        }}
      >
        Purge selected ({chosen.length})
      </button>
      <nav className="toolbar" aria-label="Trash pages">
        <button
          disabled={previous === undefined || query.isFetching || action.isPending}
          onClick={() => page(previous)}
        >
          Previous
        </button>
        <button
          disabled={!query.data?.next_cursor || query.isFetching || action.isPending}
          onClick={() => page(query.data?.next_cursor ?? undefined)}
        >
          Next
        </button>
        {cursor && (
          <button disabled={action.isPending} onClick={() => page('')}>
            First page
          </button>
        )}
      </nav>
    </>
  );
}
