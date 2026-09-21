import type { QueryClient } from '@tanstack/react-query';
import { getGroups, type KindFilter } from './api';

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
export function formatBytes(bytes: number) {
  const unit = Math.min(4, Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)));
  return `${Number((bytes / 1024 ** unit).toFixed(1))} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
}
export function formatDuration(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
