import type { ScanDecision } from '@vvv/shared';

export const decisionLabel: Record<ScanDecision, string> = {
  folder: 'Folder — open to explore',
  would_process: 'Would be processed',
  excluded_by_size: 'Excluded by size',
  unsupported_type: 'Not a supported media type',
  symlink_not_followed: 'Symlink not followed',
  filesystem_boundary: 'Across a filesystem boundary',
  permission_denied: 'Permission denied',
  inside_trash: 'Inside trash',
  other: 'Unavailable',
};
export function breadcrumbs(path: string) {
  const parts = path ? path.split('/') : [];
  return [
    { name: 'Root', path: '' },
    ...parts.map((name, index) => ({
      name,
      path: parts.slice(0, index + 1).join('/'),
    })),
  ];
}
export function pageCursors(history: string[], next?: string | null) {
  return next ? [...history, next] : history.length > 1 ? history.slice(0, -1) : [''];
}
