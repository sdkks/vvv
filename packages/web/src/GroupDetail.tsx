import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { GroupMember } from '@vvv/shared';
import { getGroup, getThumbnail, ResultsChangedError } from './api';
import { formatBytes, formatDuration, isVideo, reviewShortcut, toggleMarked } from './group-review';

function Thumbnail({ member }: { member: GroupMember }) {
  const [src, setSrc] = useState('');
  const video = isVideo(member.path);
  useEffect(() => {
    if (video) return;
    const controller = new AbortController();
    let url = '';
    void getThumbnail(member.file_id, controller.signal)
      .then((blob) => {
        if (!controller.signal.aborted) setSrc((url = URL.createObjectURL(blob)));
      })
      .catch(() => setSrc(''));
    return () => {
      controller.abort();
      URL.revokeObjectURL(url);
    };
  }, [member.file_id, video]);
  return src ? (
    <img
      className="thumbnail"
      src={src}
      alt={member.path}
      loading="lazy"
      onError={() => setSrc('')}
    />
  ) : (
    <span className={`thumbnail fallback ${video ? 'video' : ''}`}>
      {video
        ? 'No preview yet — video thumbnails arrive with video support'
        : 'No thumbnail available'}
    </span>
  );
}
export function GroupDetail({
  id,
  back,
  onStale,
}: {
  id: string;
  back: string;
  onStale: () => void;
}) {
  const query = useInfiniteQuery({
    queryKey: ['groups', 'detail', id],
    queryFn: ({ pageParam, signal }) => getGroup(id, pageParam, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.members.next_cursor ?? undefined,
    retry: false,
  });
  const [marked, setMarked] = useState(new Set<number>());
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const navigate = useNavigate();
  const group = query.data?.pages[0];
  const members = query.data?.pages.flatMap((page) => page.members.items) ?? [];
  const loaded = Boolean(group);
  useEffect(() => {
    if (query.error instanceof ResultsChangedError) onStale();
  }, [query.error, onStale]);
  useEffect(() => {
    if (loaded) (list.current?.children[0] as HTMLElement | undefined)?.focus();
  }, [loaded]);
  function focus(index: number) {
    const next = Math.max(0, Math.min(members.length - 1, index));
    (list.current?.children[next] as HTMLElement | undefined)?.focus();
  }
  function toggle(id = members[active]?.file_id) {
    if (id !== undefined) setMarked((value) => toggleMarked(value, id));
  }
  return (
    <section
      onKeyDown={(event) => {
        const action = reviewShortcut(
          event.key,
          event.target as HTMLElement,
          event.altKey || event.ctrlKey || event.metaKey
        );
        if (!action) return;
        event.preventDefault();
        if (action === 'next') focus(active + 1);
        if (action === 'previous') focus(active - 1);
        if (action === 'toggle') toggle();
        if (action === 'back') void navigate(back);
      }}
    >
      <Link to={back}>Back to groups</Link>
      <h1>Group {id}</h1>
      {query.isPending && <p role="status">Loading members…</p>}
      {query.isError && !(query.error instanceof ResultsChangedError) && (
        <p role="alert">
          {query.error.message} <button onClick={() => void query.refetch()}>Retry</button>
        </p>
      )}
      {group && (
        <p>
          {group.kind} · {group.member_count} members · {formatBytes(group.total_bytes)} total ·{' '}
          {formatBytes(group.reclaimable_bytes)} reclaimable
        </p>
      )}
      <p>
        Shortcuts: j / ↓ next · k / ↑ previous · x / Space mark · Enter apply and advance
        (unavailable) · Esc back
      </p>
      <div className="toolbar">
        <button disabled={active === 0} onClick={() => focus(active - 1)}>
          Previous member
        </button>
        <button disabled={active >= members.length - 1} onClick={() => focus(active + 1)}>
          Next member
        </button>
      </div>
      <ul className="members" ref={list}>
        {members.map((member, index) => (
          <li
            className="member-card"
            key={member.file_id}
            tabIndex={index === active ? 0 : -1}
            onFocus={() => setActive(index)}
            aria-label={`Member ${index + 1}: ${member.path.split('/').at(-1)}`}
          >
            <Thumbnail member={member} />
            <div>
              {index === 0 && (
                <strong title="Similarity is measured against this member; it is not necessarily the best copy.">
                  Reference
                </strong>
              )}
              <p>{member.path}</p>
              <p>
                {formatBytes(member.size)}
                {member.width !== null &&
                  member.height !== null &&
                  ` · ${member.width}×${member.height}`}
                {member.duration_ms !== null && ` · ${formatDuration(member.duration_ms)}`}
              </p>
              <button
                aria-pressed={marked.has(member.file_id)}
                onClick={() => toggle(member.file_id)}
              >
                {marked.has(member.file_id) ? 'Discard — marked' : 'Keep — not marked'}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {query.hasNextPage && (
        <button disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>
          Load more members
        </button>
      )}
      <div className="toolbar" aria-live="polite">
        <button disabled title="Arriving in a future update" aria-describedby="apply-hint">
          Quarantine {marked.size} marked files
        </button>
        <button onClick={() => setMarked(new Set())} disabled={!marked.size}>
          Clear markings
        </button>
        <small id="apply-hint">
          Arriving in a future update — apply and advance is unavailable. No files will be moved.
        </small>
      </div>
    </section>
  );
}
