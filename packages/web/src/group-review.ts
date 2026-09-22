import type { DuplicateGroup } from '@vvv/shared';
import type { QueryClient } from '@tanstack/react-query';
import { getGroups, GroupMissingError, ResultsChangedError, type KindFilter } from './api';

// Members omit kind; mirror the scanner's extension-based video classification.
export const isVideo = (path: string) =>
  /\.(mp4|mkv|avi|mov|webm|m4v|mpg|mpeg|ts|m2ts|wmv|flv)$/i.test(path);
export const groupsKey = (kind: KindFilter, cursor = '') => ['groups', 'list', kind, cursor];
export function kindFilter(value: string | null): KindFilter {
  return value === 'exact' || value === 'image' || value === 'video' ? value : '';
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
export async function recoverGroups(cache: QueryClient, kind: KindFilter, restart: () => void) {
  await cache.cancelQueries({ queryKey: ['groups'] });
  cache.removeQueries({ queryKey: ['groups'] });
  restart();
  await cache.fetchQuery({
    queryKey: groupsKey(kind),
    queryFn: ({ signal }) => getGroups(kind, '', signal),
    retry: false,
  });
}
export function toggleMarked(marked: Set<number>, id: number) {
  const next = new Set(marked);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
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
