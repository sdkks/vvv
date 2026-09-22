import type { RetentionSettings } from '@vvv/shared';

export const validRetention = (days: number) => Number.isInteger(days) && days >= 1 && days <= 3650;
export const policySummary = (policy: RetentionSettings) =>
  policy.auto_purge_enabled
    ? `Auto-purge is on: files are permanently deleted after ${policy.retention_days} days in Trash (checked hourly).`
    : `Auto-purge is off: files are kept until manually purged. Retention when enabled: ${policy.retention_days} days.`;
export function fileFailure(error: string) {
  const messages: Record<string, string> = {
    destination_exists: 'Original path now occupied. Move that file before restoring.',
    exdev: 'File is on a different filesystem — move it manually.',
    enoent: 'File no longer exists on disk.',
    eacces: 'Permission denied. Check filesystem permissions.',
    file_not_eligible: 'File is no longer eligible. Refresh to see its current state.',
    operation_pending: 'Another operation is still running. Try again shortly.',
    trash_not_found: 'This file is no longer in Trash. Refresh the list.',
  };
  return messages[error] ?? `Operation failed (${error}).`;
}
export const displayDate = (value: string) =>
  new Date(value.replace(' ', 'T') + 'Z').toLocaleString();
export function purgeAfter(value: string | null, now = Date.now()) {
  if (!value) return 'Auto-purge off';
  const days = Math.ceil((new Date(value.replace(' ', 'T') + 'Z').getTime() - now) / 86400000);
  return `${displayDate(value)} · ${days <= 0 ? 'due on next purge check' : `${days} days remaining`}`;
}
