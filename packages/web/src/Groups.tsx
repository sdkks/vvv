import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GroupSort, QuarantineResponse, SortDirection } from '@vvv/shared';
import {
  clearMatches,
  getGroups,
  GroupCursorError,
  groupsSearch,
  ResultsChangedError,
  runMatching,
  type KindFilter,
} from './api';
import { UndoToast } from './UndoToast';
import {
  formatBytes,
  groupsKey,
  groupSort,
  sortDirection,
  kindFilter,
  nextGroup,
  previousCursor,
  recoverGroups,
  visitCursor,
} from './group-review';
import { GroupDetail } from './GroupDetail';
import { GroupPreview } from './GroupPreview';

const capabilityHints = {
  exact: "Same file bytes only; re-encoded or resized copies won't match.",
  image: 'Finds similar images after resizing or re-encoding; it does not find different scenes.',
  video:
    'Finds re-encoded or resized videos with aligned frames. Trims, clips, or changed intros may not match.',
  audio_partial:
    'Finds a shorter recording inside a longer one, even with an offset. Both need audio; standalone audio files are included.',
};

export function Groups() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const kind = kindFilter(search.get('kind'));
  const sort = groupSort(search.get('sort'));
  const direction = sortDirection(search.get('direction'));
  const cursor = search.get('cursor') ?? '';
  const [history, setHistory] = useState([cursor]);
  const [notice, setNotice] = useState('');
  const [observing, setObserving] = useState<string | null>(null);
  const location = useLocation();
  const [toast, setToast] = useState<{ ids: number[]; path: string }>();
  const route = location.pathname + location.search;
  const recovering = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const changingControls = useRef(false);
  const navigate = useNavigate();
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: groupsKey(kind, cursor, sort, direction),
    queryFn: ({ signal }) => getGroups(kind, cursor, signal, sort, direction),
    placeholderData: keepPreviousData,
    enabled: !id,
    retry: false,
  });
  const onStale = useCallback(
    (message = 'Results changed — a new match completed') => {
      if (recovering.current) return;
      recovering.current = true;
      setObserving(null);
      setNotice(message);
      void recoverGroups(
        cache,
        kind,
        () => {
          setHistory(['']);
          void navigate(`/groups${groupsSearch(kind, '', sort, direction)}`, { replace: true });
        },
        sort,
        direction
      )
        .catch(() => {
          /* The list query renders recovery errors. */
        })
        .finally(() => {
          recovering.current = false;
        });
    },
    [cache, kind, sort, direction, navigate]
  );
  useEffect(() => {
    if (
      !id &&
      (query.error instanceof ResultsChangedError || query.error instanceof GroupCursorError)
    )
      onStale(query.error.message);
  }, [id, query.error, onStale]);
  useEffect(() => {
    setObserving(null);
    setToast((current) => (current?.path === route ? current : undefined));
    if (!id && !changingControls.current) heading.current?.focus();
    changingControls.current = false;
  }, [location.key, id, route]);
  useEffect(() => {
    if (observing !== location.key) return;
    let attempts = 0;
    // No completion signal exists: observe for 20s, then leave Refresh available.
    const timer = setInterval(() => {
      void cache.invalidateQueries({
        queryKey: groupsKey(kind, cursor, sort, direction),
        exact: true,
      });
      if (++attempts === 10) {
        setObserving(null);
        setNotice('Automatic checks paused. Use Refresh groups if matching is still running.');
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [cache, kind, cursor, sort, direction, observing, location.key]);
  const match = useMutation({
    mutationFn: (route: string) => runMatching().then(() => route),
    onSuccess: setObserving,
  });
  const clear = useMutation({
    mutationFn: clearMatches,
    onSuccess: async () => {
      setNotice('Generated matches were cleared. Registered directories and indexed files remain.');
      await cache.invalidateQueries({ queryKey: ['groups'] });
    },
    onError: (error) => {
      if (error.message.includes('Matching is already running'))
        setNotice('Matching is in progress; matches were not cleared. Try again when it finishes.');
    },
  });
  function page(next: string | undefined) {
    if (next === undefined) return;
    setHistory(visitCursor(history, cursor, next));
    void navigate(`/groups${groupsSearch(kind, next, sort, direction)}`);
  }
  function changeOrder(nextKind: KindFilter, nextSort: GroupSort, nextDirection: SortDirection) {
    changingControls.current = true;
    setHistory(['']);
    setNotice('');
    void navigate(`/groups${groupsSearch(nextKind, '', nextSort, nextDirection)}`);
  }
  const applied = useCallback(
    async (result: QuarantineResponse) => {
      await cache.invalidateQueries({ queryKey: ['groups'], refetchType: 'none' });
      await cache.invalidateQueries({ queryKey: ['trash'] });
      if (window.location.pathname + window.location.search !== route) return;
      const ids = result.moved.map((item) => item.trash_id);
      if (ids.length) setToast({ ids, path: route });
      if (result.failed.length) return;
      let position = cursor;
      let fresh = await cache.fetchQuery({
        queryKey: groupsKey(kind, position, sort, direction),
        queryFn: () => getGroups(kind, position, undefined, sort, direction),
      });
      let next = nextGroup(fresh.items, Number(id), query.data?.items, false);
      const fallback = nextGroup(fresh.items, Number(id), query.data?.items);
      if (!next && fresh.next_cursor) {
        position = fresh.next_cursor;
        fresh = await cache.fetchQuery({
          queryKey: groupsKey(kind, position, sort, direction),
          queryFn: () => getGroups(kind, position, undefined, sort, direction),
        });
        next = nextGroup(fresh.items, Number(id));
      }
      if (!next) {
        next = fallback;
        position = cursor;
      }
      if (window.location.pathname + window.location.search !== route) return;
      const target = `/groups${next ? `/${next.id}` : ''}${groupsSearch(kind, position, sort, direction)}`;
      setHistory(visitCursor(history, cursor, position));
      if (ids.length) setToast({ ids, path: target });
      await navigate(target);
    },
    [cache, cursor, history, id, kind, sort, direction, navigate, route, query.data]
  );
  const previous = previousCursor(history, cursor);
  const next = query.data?.next_cursor ?? undefined;
  const undo = toast?.path === route && <UndoToast key={toast.ids.join(',')} ids={toast.ids} />;
  if (id)
    return (
      <>
        {undo}
        <GroupDetail
          key={id}
          id={id}
          back={`/groups${groupsSearch(kind, cursor, sort, direction)}`}
          onStale={onStale}
          onApplied={applied}
        />
      </>
    );
  return (
    <>
      {undo}
      <h1 ref={heading} tabIndex={-1}>
        Duplicate groups
      </h1>
      <p role="status">{observing === location.key ? 'Matching in progress…' : notice}</p>
      <div className="toolbar">
        <label>
          Kind{' '}
          <select
            value={kind}
            aria-describedby="kind-hint"
            onChange={(event) => changeOrder(kindFilter(event.target.value), sort, direction)}
          >
            <option value="">All</option>
            <option value="exact">Exact</option>
            <option value="image">Image</option>
            <option value="video">Video</option>
            <option value="audio_partial">Audio partial</option>
          </select>
        </label>
        <label>
          Sort by{' '}
          <select
            value={sort}
            onChange={(event) => changeOrder(kind, groupSort(event.target.value), direction)}
          >
            <option value="reclaimable_bytes">Reclaimable space</option>
            <option value="member_count">Members</option>
          </select>
        </label>
        <button
          aria-label={`Sort direction: ${direction === 'desc' ? 'Highest first' : 'Lowest first'}`}
          onClick={() => changeOrder(kind, sort, direction === 'desc' ? 'asc' : 'desc')}
        >
          {direction === 'desc' ? 'Highest first' : 'Lowest first'}
        </button>
        <button
          disabled={match.isPending || observing === location.key}
          onClick={() => match.mutate(location.key)}
        >
          {match.isPending ? 'Starting matching…' : 'Re-run matching'}
        </button>
        <p>
          Clear matches removes generated duplicate groups and results only; registered directories,
          indexed files, and hashes remain.
        </p>
        <button
          disabled={clear.isPending || observing === location.key}
          onClick={() => {
            if (
              window.confirm(
                'Clear generated duplicate groups and results only? Registered directories and indexed files and hashes will remain.'
              )
            )
              clear.mutate();
          }}
        >
          {clear.isPending ? 'Clearing matches…' : 'Clear matches'}
        </button>
        <button disabled={query.isFetching} onClick={() => void query.refetch()}>
          Refresh groups
        </button>
      </div>
      <p>
        Manual matching uses the media selection from the latest completed scan; before any scan
        completes, all media kinds are included.
      </p>
      {clear.isError && !clear.error.message.includes('Matching is already running') && (
        <p role="alert">{clear.error.message}</p>
      )}
      <p id="kind-hint">
        {kind ? (
          capabilityHints[kind]
        ) : (
          <>
            Different match types find different kinds of duplicates. See Matching behavior in{' '}
            <Link to="/settings">Settings</Link>.
          </>
        )}
      </p>
      {match.isError && <p role="alert">{match.error.message}</p>}
      {query.isFetching && (
        <p role="status">
          {query.isPlaceholderData
            ? 'Loading groups… Previous results shown until ready.'
            : 'Loading groups…'}
        </p>
      )}
      {query.isError &&
        !(query.error instanceof ResultsChangedError) &&
        !(query.error instanceof GroupCursorError) && <p role="alert">{query.error.message}</p>}
      {!query.isPlaceholderData && (
        <p>
          {sort === 'member_count' ? 'Members' : 'Reclaimable space'} —{' '}
          {direction === 'desc' ? 'highest first' : 'lowest first'}.
        </p>
      )}
      {!query.isPlaceholderData && query.data?.items.length === 0 && (
        <p>
          No duplicates for this filter. Add scan directories and run a scan, or re-run matching.
        </p>
      )}
      <ul className="groups-list" aria-busy={query.isFetching} inert={query.isPlaceholderData}>
        {query.data?.items.map((group) => (
          <li key={group.id}>
            <Link to={`/groups/${group.id}${groupsSearch(kind, cursor, sort, direction)}`}>
              <GroupPreview
                key={group.representative?.file_id ?? 'empty'}
                representative={group.representative}
              />
              <span className="group-summary">
                <span className="group-kind">{group.kind}</span> Group {group.id}
                <span className="metadata">
                  {group.member_count} members · {formatBytes(group.total_bytes)} total
                </span>
              </span>
              <strong className="reclaimable">
                {formatBytes(group.reclaimable_bytes)} reclaimable
              </strong>
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
