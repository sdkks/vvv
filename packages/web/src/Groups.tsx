import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getGroups, groupsSearch, ResultsChangedError, runMatching } from './api';
import {
  formatBytes,
  groupsKey,
  kindFilter,
  previousCursor,
  recoverGroups,
  visitCursor,
} from './group-review';
import { GroupDetail } from './GroupDetail';

export function Groups() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const kind = kindFilter(search.get('kind'));
  const cursor = search.get('cursor') ?? '';
  const [history, setHistory] = useState([cursor]);
  const [notice, setNotice] = useState('');
  const [observing, setObserving] = useState<string | null>(null);
  const location = useLocation();
  const recovering = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const navigate = useNavigate();
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: groupsKey(kind, cursor),
    queryFn: ({ signal }) => getGroups(kind, cursor, signal),
    enabled: !id,
    retry: false,
  });
  const onStale = useCallback(() => {
    if (recovering.current) return;
    recovering.current = true;
    setObserving(null);
    setNotice('Results changed — a new match completed');
    void recoverGroups(cache, kind, () => {
      setHistory(['']);
      void navigate(`/groups${groupsSearch(kind)}`, { replace: true });
    })
      .catch(() => {
        /* The list query renders recovery errors. */
      })
      .finally(() => {
        recovering.current = false;
      });
  }, [cache, kind, navigate]);
  useEffect(() => {
    if (!id && query.error instanceof ResultsChangedError) onStale();
  }, [id, query.error, onStale]);
  useEffect(() => {
    setObserving(null);
    if (!id) heading.current?.focus();
  }, [location.key, id]);
  useEffect(() => {
    if (observing !== location.key) return;
    let attempts = 0;
    // No completion signal exists: observe for 20s, then leave Refresh available.
    const timer = setInterval(() => {
      void cache.invalidateQueries({ queryKey: groupsKey(kind, cursor), exact: true });
      if (++attempts === 10) {
        setObserving(null);
        setNotice('Automatic checks paused. Use Refresh groups if matching is still running.');
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [cache, kind, cursor, observing, location.key]);
  const match = useMutation({
    mutationFn: (route: string) => runMatching().then(() => route),
    onSuccess: setObserving,
  });
  function page(next: string | undefined) {
    if (next === undefined) return;
    setHistory(visitCursor(history, cursor, next));
    void navigate(`/groups${groupsSearch(kind, next)}`);
  }
  const previous = previousCursor(history, cursor);
  const next = query.data?.next_cursor ?? undefined;
  if (id)
    return (
      <GroupDetail
        key={id}
        id={id}
        back={`/groups${groupsSearch(kind, cursor)}`}
        onStale={onStale}
      />
    );
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        Duplicate groups
      </h1>
      <p role="status">{observing === location.key ? 'Matching in progress…' : notice}</p>
      <div className="toolbar">
        <label>
          Kind{' '}
          <select
            value={kind}
            onChange={(event) => {
              setHistory(['']);
              void navigate(`/groups${groupsSearch(kindFilter(event.target.value))}`);
            }}
          >
            <option value="">All</option>
            <option value="exact">Exact</option>
            <option value="image">Image</option>
            <option value="video">Video</option>
          </select>
        </label>
        <button
          disabled={match.isPending || observing === location.key}
          onClick={() => match.mutate(location.key)}
        >
          {match.isPending ? 'Starting matching…' : 'Re-run matching'}
        </button>
        <button disabled={query.isFetching} onClick={() => void query.refetch()}>
          Refresh groups
        </button>
      </div>
      {match.isError && <p role="alert">{match.error.message}</p>}
      {query.isPending && <p role="status">Loading groups…</p>}
      {query.isError && !(query.error instanceof ResultsChangedError) && (
        <p role="alert">{query.error.message}</p>
      )}
      <p>Biggest reclaimable space first.</p>
      {query.data?.items.length === 0 && (
        <p>
          No duplicates for this filter. Add scan directories and run a scan, or re-run matching.
        </p>
      )}
      <ul className="groups-list">
        {query.data?.items.map((group) => (
          <li key={group.id}>
            <Link to={`/groups/${group.id}${groupsSearch(kind, cursor)}`}>
              {group.kind} Group {group.id} · {group.member_count} members
              <br />
              {formatBytes(group.total_bytes)} total ·{' '}
              <strong>{formatBytes(group.reclaimable_bytes)} reclaimable</strong>
            </Link>
          </li>
        ))}
      </ul>
      <nav className="toolbar" aria-label="Group pages">
        <button
          disabled={previous === undefined || query.isFetching}
          onClick={() => page(previous)}
        >
          Previous
        </button>
        <button disabled={!next || query.isFetching || query.isError} onClick={() => page(next)}>
          Next
        </button>
        {cursor && <button onClick={() => page('')}>First page</button>}
      </nav>
    </>
  );
}
