import type { ScanLogEntry, ScanLogLevel, ScanLogStep } from '@vvv/shared';

export type LogLevelFilter = ScanLogLevel | '';
export type LogsView = 'history' | 'live';

export const levelLabels: Record<ScanLogLevel, string> = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};
export const stepLabels: Record<ScanLogStep, string> = {
  scan: 'SCAN',
  traversal: 'TRAVERSAL',
  hash: 'HASH',
  sample: 'SAMPLE',
  match: 'MATCH',
  error: 'ERROR',
  complete: 'COMPLETE',
};

const levels = new Set<string>(['info', 'warn', 'error']);
const steps = new Set<string>(['scan', 'traversal', 'hash', 'sample', 'match', 'error', 'complete']);

export function parseLogEntry(text: string): ScanLogEntry | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object') return undefined;
    const entry = value as Record<string, unknown>;
    if (typeof entry.id !== 'number' || !Number.isSafeInteger(entry.id) || entry.id < 1)
      return undefined;
    if (typeof entry.ts !== 'string' || Number.isNaN(Date.parse(entry.ts))) return undefined;
    if (
      typeof entry.scan_id !== 'number' ||
      !Number.isSafeInteger(entry.scan_id) ||
      entry.scan_id < 0
    )
      return undefined;
    if (typeof entry.step !== 'string' || !steps.has(entry.step)) return undefined;
    if (typeof entry.level !== 'string' || !levels.has(entry.level)) return undefined;
    if (typeof entry.detail !== 'string') return undefined;
    if (
      entry.duration_ms !== undefined &&
      (typeof entry.duration_ms !== 'number' || entry.duration_ms < 0)
    )
      return undefined;
    return value as ScanLogEntry;
  } catch {
    return undefined;
  }
}

/** Append a live entry in id order, dropping duplicates/replays, bounded from the front. */
export function appendLogEntry(
  entries: ScanLogEntry[],
  entry: ScanLogEntry,
  cap = 1000
): ScanLogEntry[] {
  const last = entries.at(-1);
  if (last && entry.id <= last.id) return entries;
  const next = [...entries, entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** True while the viewport is pinned close enough to the tail to keep following new entries. */
export const atTail = (viewport: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}) => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24;

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function durationLabel(ms: number): string {
  if (ms < 1000) return `Duration: ${Math.round(ms)} milliseconds`;
  if (ms < 60_000) return `Duration: ${(ms / 1000).toFixed(1)} seconds`;
  return `Duration: ${Math.floor(ms / 60_000)} minutes ${Math.round((ms % 60_000) / 1000)} seconds`;
}

export function logTime(ts: string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleTimeString(undefined, { hour12: false });
}

export function logTimeFull(ts: string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime())
    ? ts
    : date.toLocaleString(undefined, { timeZoneName: 'short' });
}

export function logsScope(search: URLSearchParams): number | undefined {
  const value = Number(search.get('scan_id'));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function logsLevel(search: URLSearchParams): LogLevelFilter {
  const value = search.get('level') ?? '';
  return levels.has(value) ? (value as ScanLogLevel) : '';
}

export function logsView(search: URLSearchParams, liveDefault: boolean): LogsView {
  const value = search.get('view');
  return value === 'live' ? 'live' : value === 'history' ? 'history' : liveDefault ? 'live' : 'history';
}
