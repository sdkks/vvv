import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
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
  autoMark,
  autoMarkAvailable,
  autoMarkCriteria,
  formatBytes,
  formatDuration,
  nextMember,
  reviewShortcut,
  toggleMarked,
  type AutoMarkCriterion,
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
  const paging = useRef(false);
  const pendingFocus = useRef<number | null>(null);
  const [memberNotice, setMemberNotice] = useState('');
  const [autoMarkOpen, setAutoMarkOpen] = useState(false);
  const autoMarkTrigger = useRef<HTMLButtonElement>(null);
  const autoMarkMenu = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    if (autoMarkOpen)
      autoMarkMenu.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, [autoMarkOpen]);
  useEffect(() => {
    if (query.isFetching || pendingFocus.current === null) return;
    const index = pendingFocus.current;
    pendingFocus.current = null;
    (list.current?.children[index] as HTMLElement | undefined)?.focus();
  }, [members.length, query.isFetching, query.dataUpdatedAt]);
  function loadMore(advance = false) {
    if (paging.current || query.isFetching || !query.hasNextPage) return;
    paging.current = true;
    if (advance) pendingFocus.current = members.length;
    setMemberNotice('Loading more members…');
    void query
      .fetchNextPage()
      .then((result) => {
        setMemberNotice(
          result.isError
            ? 'Unable to load more members.'
            : result.hasNextPage
              ? ''
              : 'End of members'
        );
      })
      .finally(() => {
        paging.current = false;
      });
  }
  function next() {
    if (paging.current || pendingFocus.current !== null) return;
    const target = nextMember(active, members.length, query.hasNextPage);
    if (target === 'load') loadMore(true);
    else if (target === 'end') setMemberNotice('End of members');
    else focus(target);
  }
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
  function applyAutoMark(criterion: AutoMarkCriterion) {
    const next = autoMark(members, criterion, marked);
    setMarked(next);
    setAutoMarkOpen(false);
    const count = members.filter((member) => next.has(member.file_id)).length;
    setMemberNotice(`Marked ${count} of ${members.length} members — review and apply`);
    autoMarkTrigger.current?.focus();
  }
  function autoMarkKeys(event: ReactKeyboardEvent) {
    if (!autoMarkOpen || event.key === 'Tab') return;
    // While the menu is open it owns the keyboard: the section-level shortcuts
    // (member movement, Escape-to-back) must not fire from inside it.
    event.stopPropagation();
    if (event.key === 'Escape') {
      setAutoMarkOpen(false);
      autoMarkTrigger.current?.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const items = Array.from(
        autoMarkMenu.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []
      );
      const index = items.indexOf(event.target as HTMLElement);
      const step = event.key === 'ArrowDown' ? 1 : items.length - 1;
      items[(index + step) % items.length]?.focus();
    }
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
        if (action === 'next') next();
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
        <button disabled={active >= members.length - 1 && !query.hasNextPage} onClick={next}>
          Next member
        </button>
      </div>
      <p role="status" aria-live="polite">
        {memberNotice}
      </p>
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
              <p className="file-path">{member.path}</p>
              <p className="metadata">
                {formatBytes(member.size)}
                {member.width !== null &&
                  member.height !== null &&
                  ` · ${member.width}×${member.height}`}
                {member.duration_ms !== null && ` · ${formatDuration(member.duration_ms)}`}
              </p>
              <p className="comparison">
                {member.similarity === null
                  ? 'Exact copy'
                  : index > 0
                    ? `Distance from reference: ${member.similarity}`
                    : null}
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
        <button disabled={query.isFetching} onClick={() => loadMore()}>
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
        <div className="auto-mark" onKeyDown={autoMarkKeys}>
          <button
            ref={autoMarkTrigger}
            aria-expanded={autoMarkOpen}
            aria-controls="auto-mark-menu"
            disabled={apply.isPending || !members.length}
            onClick={() => setAutoMarkOpen((open) => !open)}
          >
            Auto-mark
          </button>
          <div
            id="auto-mark-menu"
            className="auto-mark-menu"
            role="group"
            aria-label="Auto-mark criteria"
            hidden={!autoMarkOpen}
            ref={autoMarkMenu}
          >
            {autoMarkCriteria.map(({ criterion, label }) => (
              <button
                key={criterion}
                disabled={apply.isPending || !autoMarkAvailable(members, criterion)}
                onClick={() => applyAutoMark(criterion)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <small>Quarantined files can be restored from Trash until permanently purged.</small>
        {apply.isError && <p role="alert">{apply.error.message}</p>}
      </div>
    </section>
  );
}
