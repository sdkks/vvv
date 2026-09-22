import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import type { GroupMember, QuarantineResponse } from '@vvv/shared';
import {
  getGroup,
  getThumbnail,
  quarantineFiles,
  ResultsChangedError,
  ThumbnailUnavailableError,
} from './api';
import { fileFailure } from './trash-state';
import {
  applyRecovery,
  formatBytes,
  formatDuration,
  reviewShortcut,
  toggleMarked,
} from './group-review';

function Thumbnail({ member }: { member: GroupMember }) {
  const [src, setSrc] = useState('');
  const [message, setMessage] = useState('Loading thumbnail…');
  useEffect(() => {
    setSrc('');
    setMessage('Loading thumbnail…');
    const controller = new AbortController();
    let url = '';
    void getThumbnail(member.file_id, controller.signal)
      .then((blob) => {
        if (!controller.signal.aborted) setSrc((url = URL.createObjectURL(blob)));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setMessage(
            error instanceof ThumbnailUnavailableError
              ? 'No thumbnail available'
              : 'Thumbnail failed to load'
          );
      });
    return () => {
      controller.abort();
      URL.revokeObjectURL(url);
    };
  }, [member.file_id]);
  return src ? (
    <img
      className="thumbnail"
      src={src}
      alt={member.path}
      loading="lazy"
      onError={() => {
        setSrc('');
        setMessage('Thumbnail failed to load');
      }}
    />
  ) : (
    <span className="thumbnail fallback">{message}</span>
  );
}
export function GroupDetail({
  id,
  back,
  onStale,
  onApplied,
}: {
  id: string;
  back: string;
  onStale: () => void;
  onApplied: (result: QuarantineResponse) => Promise<void>;
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
  const apply = useMutation({
    mutationFn: () => quarantineFiles([...marked]),
    onSuccess: async (result) => {
      setMarked(new Set(result.failed.map((item) => item.file_id)));
      await onApplied(result);
      if (result.failed.length) await query.refetch();
    },
  });
  const list = useRef<HTMLUListElement>(null);
  const navigate = useNavigate();
  const group = query.data?.pages[0];
  const members = (query.data?.pages.flatMap((page) => page.members.items) ?? []).filter(
    (member) =>
      query.dataUpdatedAt > apply.submittedAt ||
      !apply.data?.moved.some((item) => item.file_id === member.file_id)
  );
  const loaded = Boolean(group);
  useEffect(() => {
    // Recovery from generation-stale or vanished-group refetches must run even when
    // the apply response carried per-item failures; otherwise the UI stays on a
    // stale or dissolved group with errors rendered (FR-23).
    const recovery = applyRecovery(query.error, {
      isPending: apply.isPending,
      failedCount: apply.data?.failed.length ?? 0,
    });
    if (recovery === 'advance') return void onApplied({ moved: [], failed: [] }).catch(onStale);
    if (recovery === 'stale') return onStale();
    if (apply.error instanceof ResultsChangedError) onStale();
    if (apply.isPending || apply.data?.failed.length) return;
  }, [query.error, onStale, onApplied, apply.isPending, apply.data, apply.error]);
  useEffect(() => {
    if (loaded) (list.current?.children[0] as HTMLElement | undefined)?.focus();
  }, [loaded]);
  function focus(index: number) {
    const next = Math.max(0, Math.min(members.length - 1, index));
    (list.current?.children[next] as HTMLElement | undefined)?.focus();
  }
  function toggle(id = members[active]?.file_id) {
    if (id !== undefined && !apply.isPending) setMarked((value) => toggleMarked(value, id));
  }
  function confirmApply(trigger: HTMLElement) {
    if (!marked.size || apply.isPending) return;
    if (window.confirm(`Move ${marked.size} marked files to Trash? They remain restorable there.`))
      apply.mutate();
    else trigger.focus();
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
        if (action === 'apply') confirmApply(event.target as HTMLElement);
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
        Shortcuts: j / ↓ next · k / ↑ previous · x / Space mark · Enter apply and advance · Esc back
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
                disabled={apply.isPending}
                aria-pressed={marked.has(member.file_id)}
                onClick={() => toggle(member.file_id)}
              >
                {marked.has(member.file_id) ? 'Discard — marked' : 'Keep — not marked'}
              </button>
              {apply.data?.failed
                .filter((item) => item.file_id === member.file_id)
                .map((item) => (
                  <p role="alert" key={item.file_id}>
                    {fileFailure(item.error)}
                  </p>
                ))}
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
        <button
          disabled={!marked.size || apply.isPending}
          onClick={(event) => confirmApply(event.currentTarget)}
        >
          {apply.isPending ? 'Quarantining…' : `Quarantine ${marked.size} marked files`}
        </button>
        <button onClick={() => setMarked(new Set())} disabled={!marked.size || apply.isPending}>
          Clear markings
        </button>
        <small>Quarantined files can be restored from Trash until permanently purged.</small>
        {apply.isError && <p role="alert">{apply.error.message}</p>}
      </div>
    </section>
  );
}
