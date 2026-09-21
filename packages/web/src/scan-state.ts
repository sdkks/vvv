import type { CurrentScanResponse, ScanProgress } from '@vvv/shared';

export const scanState = (scan: CurrentScanResponse | undefined) => scan?.status ?? 'idle';
export const scanLabels = {
  idle: 'Ready to scan',
  running: 'Scan running',
  interrupted: 'Previous scan was interrupted',
  done: 'Scan complete',
  cancelled: 'Scan cancelled',
};
export function elapsedScan(scan: ScanProgress, now: number) {
  // SQLite datetime() is UTC, but its space-separated value has no zone suffix.
  const timestamp = (value: string) =>
    Date.parse(
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + 'Z' : value
    );
  const start = timestamp(scan.started_at);
  const end =
    scan.status === 'running' ? now : scan.finished_at ? timestamp(scan.finished_at) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Unavailable';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
export function mergeScan(
  current: CurrentScanResponse | undefined,
  incoming: CurrentScanResponse
): CurrentScanResponse {
  if (!current) return incoming;
  if (!incoming || incoming.id < current.id) return current;
  if (
    incoming.id === current.id &&
    ((current.status !== 'running' && incoming.status === 'running') ||
      incoming.discovered < current.discovered ||
      incoming.processed < current.processed ||
      incoming.errors < current.errors)
  )
    return current;
  return incoming;
}
function isProgress(value: unknown): value is ScanProgress {
  if (!value || typeof value !== 'object') return false;
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  return (
    'id' in value &&
    count(value.id) &&
    value.id !== 0 &&
    'status' in value &&
    typeof value.status === 'string' &&
    ['running', 'interrupted', 'done', 'cancelled'].includes(value.status) &&
    'discovered' in value &&
    count(value.discovered) &&
    'processed' in value &&
    count(value.processed) &&
    'errors' in value &&
    count(value.errors) &&
    'started_at' in value &&
    typeof value.started_at === 'string' &&
    (!('finished_at' in value) ||
      value.finished_at === null ||
      typeof value.finished_at === 'string') &&
    (!('current_file' in value) || typeof value.current_file === 'string')
  );
}
export function parseProgress(text: string): ScanProgress | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isProgress(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
