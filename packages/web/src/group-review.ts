import type { DuplicateGroup, GroupMember, GroupSort, SortDirection } from '@vvv/shared';
import type { QueryClient } from '@tanstack/react-query';
import { getGroups, GroupMissingError, ResultsChangedError, type KindFilter } from './api';

// Members omit kind; mirror the scanner's extension-based video classification.
export const isVideo = (path: string) =>
  /\.(mp4|mkv|avi|mov|webm|m4v|mpg|mpeg|ts|m2ts|wmv|flv)$/i.test(path);
export const groupsKey = (
  kind: KindFilter,
  cursor = '',
  sort: GroupSort = 'reclaimable_bytes',
  direction: SortDirection = 'desc'
) => ['groups', 'list', kind, cursor, sort, direction];
export const groupSort = (value: string | null): GroupSort =>
  value === 'member_count' ? 'member_count' : 'reclaimable_bytes';
export const sortDirection = (value: string | null): SortDirection =>
  value === 'asc' ? 'asc' : 'desc';
export function kindFilter(value: string | null): KindFilter {
  return value === 'exact' || value === 'image' || value === 'video' || value === 'audio_partial'
    ? value
    : '';
}
export function visitCursor(history: string[], current: string, next: string) {
  if (!next) return [''];
  const visited = history.indexOf(next);
  if (visited >= 0) return history.slice(0, visited + 1);
  const index = history.indexOf(current);
  return [...(index < 0 ? [current] : history.slice(0, index + 1)), next];
}
export function previousCursor(history: string[], current: string) {
  return history[history.indexOf(current) - 1];
}
export async function recoverGroups(
  cache: QueryClient,
  kind: KindFilter,
  restart: () => void,
  sort: GroupSort = 'reclaimable_bytes',
  direction: SortDirection = 'desc'
) {
  await cache.cancelQueries({ queryKey: ['groups'] });
  cache.removeQueries({ queryKey: ['groups'] });
  restart();
  await cache.fetchQuery({
    queryKey: groupsKey(kind, '', sort, direction),
    queryFn: ({ signal }) => getGroups(kind, '', signal, sort, direction),
    retry: false,
  });
}
export function toggleMarked(marked: Set<number>, id: number) {
  const next = new Set(marked);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export type AutoMarkCriterion =
  | 'largest_size'
  | 'smallest_size'
  | 'highest_resolution'
  | 'lowest_resolution'
  | 'longest_duration'
  | 'shortest_duration';
type AutoMarkMember = Pick<GroupMember, 'file_id' | 'size' | 'width' | 'height' | 'duration_ms'>;
export const autoMarkCriteria: readonly { criterion: AutoMarkCriterion; label: string }[] = [
  { criterion: 'largest_size', label: 'Keep largest size' },
  { criterion: 'smallest_size', label: 'Keep smallest size' },
  { criterion: 'highest_resolution', label: 'Keep highest resolution' },
  { criterion: 'lowest_resolution', label: 'Keep lowest resolution' },
  { criterion: 'longest_duration', label: 'Keep longest duration' },
  { criterion: 'shortest_duration', label: 'Keep shortest duration' },
];
function criterionValue(member: AutoMarkMember, criterion: AutoMarkCriterion) {
  switch (criterion) {
    case 'largest_size':
    case 'smallest_size':
      return member.size;
    case 'highest_resolution':
    case 'lowest_resolution':
      return member.width === null || member.height === null ? null : member.width * member.height;
    case 'longest_duration':
    case 'shortest_duration':
      return member.duration_ms;
  }
}
const keepSmallest = (criterion: AutoMarkCriterion) =>
  criterion === 'smallest_size' ||
  criterion === 'lowest_resolution' ||
  criterion === 'shortest_duration';
/** Auto-marking replaces existing markings for the group's members: the best
 * member by the chosen attribute keeps the unmarked slot (lowest file_id wins
 * ties) and every other member is marked for discard — the user still reviews
 * and confirms the quarantine. The reference member has no special role; the
 * attribute alone decides. Members missing the attribute (images have no
 * duration, videos may lack dimensions) can never win but are still marked when
 * another member wins. When no member carries the attribute the criterion is
 * unavailable and prior markings are returned unchanged. Clear markings remains
 * the reset. Marked ids outside the member list, which the review screen never
 * produces, are preserved. */
export function autoMark(
  members: AutoMarkMember[],
  criterion: AutoMarkCriterion,
  marked: Set<number>
) {
  let best: AutoMarkMember | undefined;
  let bestValue = 0;
  for (const member of members) {
    const value = criterionValue(member, criterion);
    if (value === null) continue;
    if (
      !best ||
      (keepSmallest(criterion) ? value < bestValue : value > bestValue) ||
      (value === bestValue && member.file_id < best.file_id)
    ) {
      best = member;
      bestValue = value;
    }
  }
  if (!best) return new Set(marked);
  const next = new Set(
    [...marked].filter((id) => !members.some((member) => member.file_id === id))
  );
  for (const member of members) if (member.file_id !== best.file_id) next.add(member.file_id);
  return next;
}
/** A criterion is available — and its menu item enabled — when at least one
 * member carries the attribute it compares; with the attribute missing across
 * the whole group there is nothing to keep by it. */
export function autoMarkAvailable(members: AutoMarkMember[], criterion: AutoMarkCriterion) {
  return members.some((member) => criterionValue(member, criterion) !== null);
}

export type ApplyRecovery = 'advance' | 'stale' | 'none';
/** Decides recovery after a quarantined apply, before any failed-item rendering:
 * a dissolved group refetch (404) advances, a stale generation (409) restarts
 * browsing, and only then do partial failures keep the user on the group. */
export function applyRecovery(
  queryError: unknown,
  apply: { isPending: boolean; failedCount: number }
): ApplyRecovery {
  if (queryError instanceof GroupMissingError) return 'advance';
  if (queryError instanceof ResultsChangedError) return 'stale';
  void apply;
  return 'none';
}
export function reviewShortcut(
  key: string,
  target: { tagName?: string; isContentEditable?: boolean },
  modified = false
) {
  if (
    modified ||
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName ?? '')
  )
    return null;
  if ((key === ' ' || key === 'Enter') && ['BUTTON', 'A'].includes(target.tagName ?? ''))
    return null;
  if (key === 'j' || key === 'ArrowDown') return 'next';
  if (key === 'k' || key === 'ArrowUp') return 'previous';
  if (key === 'x' || key === ' ') return 'toggle';
  if (key === 'Enter') return 'apply';
  return key === 'Escape' ? 'back' : null;
}
export function nextMember(active: number, loaded: number, hasNextPage: boolean) {
  if (active < loaded - 1) return active + 1;
  return hasNextPage ? 'load' : 'end';
}
export function nextGroup(items: DuplicateGroup[], current: number, before = items, wrap = true) {
  const index = before.findIndex((item) => item.id === current);
  const ordered = [
    ...before.slice(index + 1),
    ...(wrap ? [...before.slice(0, index + 1), ...items] : []),
  ];
  return ordered
    .map((old) => items.find((item) => item.id === old.id))
    .find((item) => item && item.id !== current && item.member_count >= 2);
}
export function formatBytes(bytes: number) {
  const unit = Math.min(4, Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)));
  return `${Number((bytes / 1024 ** unit).toFixed(1))} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
}
export function formatDuration(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
