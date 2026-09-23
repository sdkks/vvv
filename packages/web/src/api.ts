import type {
  LoginRequest,
  GroupKind,
  GroupSort,
  SortDirection,
  GroupResponse,
  GroupsResponse,
  StartMatchResponse,
  ScanDirsResponse,
  CreateScanDirRequest,
  ScanDir,
  UpdateScanDirRequest,
  CurrentScanResponse,
  StartScanResponse,
  ScanErrorsResponse,
  ScanLogsResponse,
  Settings,
  UpdateSettingsResponse,
  UpdateSettingsRequest,
  QuarantineResponse,
  RestoreResponse,
  PurgeResponse,
  Page,
  TrashItem,
} from '@vvv/shared';

import type { LogLevelFilter } from './logs-state';

export class ThumbnailUnavailableError extends Error {}

export class SettingsValidationError extends Error {
  constructor(public fields: Record<string, string>) {
    super('Check the matching values and try again.');
  }
}

export class ResultsChangedError extends Error {
  constructor() {
    super('Results changed — a new match completed');
  }
}

export class GroupMissingError extends ResultsChangedError {}

export class GroupCursorError extends Error {
  constructor() {
    super('This groups page is no longer valid. Showing the first page.');
  }
}

export function returnLocation(search: string, origin: string) {
  const target = new URLSearchParams(search).get('returnTo') ?? '/';
  try {
    const url = new URL(target, origin);
    return url.origin === origin && url.pathname !== '/login'
      ? url.pathname + url.search + url.hash
      : '/';
  } catch {
    return '/';
  }
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`/api${path}`, { ...init, credentials: 'same-origin' });
  if (response.status === 401) {
    if (path !== '/auth/login' && window.location.pathname !== '/login') {
      const { pathname, search, hash } = window.location;
      window.location.replace(`/login?returnTo=${encodeURIComponent(pathname + search + hash)}`);
    }
    throw new Error(
      path === '/auth/login' ? 'Incorrect password. Try again.' : 'Please sign in again.'
    );
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const code = body && typeof body === 'object' && 'error' in body ? body.error : null;
    if (response.status === 404 && code === 'group_not_found') throw new GroupMissingError();
    if (response.status === 409 && code === 'stale_cursor') throw new ResultsChangedError();
    if (response.status === 400 && code === 'invalid_cursor' && path.split('?')[0] === '/groups')
      throw new GroupCursorError();
    if (response.status === 404 && code === 'thumbnail_not_found')
      throw new ThumbnailUnavailableError('No thumbnail available');
    if (code === 'invalid_settings' && body && typeof body === 'object' && 'fields' in body) {
      const fields = body.fields;
      if (fields && typeof fields === 'object')
        throw new SettingsValidationError(
          Object.fromEntries(Object.entries(fields).filter((entry) => typeof entry[1] === 'string'))
        );
    }
    const messages: Record<string, string> = {
      settings_scan_running:
        'Wait for the current scan to finish before changing frames per video.',
      settings_match_running:
        'Wait for matching to finish before changing thresholds or frame count.',
      match_running: 'Matching is already running. Try again shortly.',
      scan_running: 'A scan is already running. Refresh to see its progress.',
      directory_registered: 'This directory is already registered.',
      invalid_directory: 'Directory not found or not accessible on the server.',
      not_a_directory: 'This path is not a directory.',
      permission_denied: 'Permission denied. Check directory access on the server.',
      directory_unavailable: 'Directory unavailable. It may have moved or changed.',
      directory_not_found: 'This directory is no longer registered.',
      symlink_not_followed: 'This directory is a symlink and following links is disabled.',
      filesystem_boundary: 'This directory is across a filesystem boundary.',
      inside_trash: 'Trash contents are excluded from previews.',
      invalid_preview_path: 'The preview path must stay inside the registered directory.',
      invalid_browse_path: 'Enter an absolute container directory path, such as /media.',
      invalid_browse_cursor: 'This folder page is no longer valid. Go to the path again.',
      invalid_cursor: 'This preview page is no longer valid. Restart the preview.',
    };
    throw new Error(
      (typeof code === 'string' && messages[code]) ||
        'Request failed. Check the server and try again.'
    );
  }
  return response;
}
export async function api<T = void>(path: string, init?: RequestInit): Promise<T> {
  const response = await request(path, init);
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}
// Fetch bytes through the client so expired sessions follow the same login flow as JSON.
export const getThumbnail = (id: number, signal: AbortSignal) =>
  request(`/files/${id}/thumb`, { signal }).then((response) => response.blob());

export type KindFilter = GroupKind | '';
export function groupsSearch(
  kind: KindFilter,
  cursor = '',
  sort: GroupSort = 'reclaimable_bytes',
  direction: SortDirection = 'desc'
) {
  const query = new URLSearchParams();
  if (kind) query.set('kind', kind);
  if (cursor) query.set('cursor', cursor);
  if (sort !== 'reclaimable_bytes') query.set('sort', sort);
  if (direction !== 'desc') query.set('direction', direction);
  return query.size ? `?${query}` : '';
}
export const getGroups = (
  kind: KindFilter,
  cursor = '',
  signal?: AbortSignal,
  sort: GroupSort = 'reclaimable_bytes',
  direction: SortDirection = 'desc'
) => api<GroupsResponse>(`/groups${groupsSearch(kind, cursor, sort, direction)}`, { signal });
export const getGroup = (id: string, cursor = '', signal?: AbortSignal) =>
  api<GroupResponse>(`/groups/${encodeURIComponent(id)}${groupsSearch('', cursor)}`, { signal });
export const runMatching = () => api<StartMatchResponse>('/matches/run', { method: 'POST' });

const jsonBody = (method: string, body: object): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
export const login = (body: LoginRequest) => api('/auth/login', jsonBody('POST', body));
export const getSettings = () => api<Settings>('/settings');
export const updateSettings = (body: UpdateSettingsRequest) =>
  api<UpdateSettingsResponse>('/settings', jsonBody('PATCH', body));
export const getTrash = (cursor = '') =>
  api<Page<TrashItem>>(`/trash?${new URLSearchParams({ cursor, limit: '50' })}`);
export const quarantineFiles = (file_ids: number[]) =>
  api<QuarantineResponse>('/files/quarantine', jsonBody('POST', { file_ids }));
export const restoreTrash = (trash_ids: number[]) =>
  api<RestoreResponse>('/trash/restore', jsonBody('POST', { trash_ids }));
export const purgeTrash = (trash_ids: number[]) =>
  api<PurgeResponse>('/trash/purge', jsonBody('POST', { trash_ids }));
export const getScanDirs = (signal?: AbortSignal) =>
  api<ScanDirsResponse>('/scan-dirs', { signal });
export const addScanDir = (body: CreateScanDirRequest) =>
  api<ScanDir>('/scan-dirs', jsonBody('POST', body));
export const updateScanDir = (id: number, body: UpdateScanDirRequest) =>
  api<ScanDir>(`/scan-dirs/${id}`, jsonBody('PATCH', body));
export const removeScanDir = (id: number) => api(`/scan-dirs/${id}`, { method: 'DELETE' });
export const getCurrentScan = (signal?: AbortSignal) =>
  api<CurrentScanResponse>('/scans/current', { signal });
export const startScan = () => api<StartScanResponse>('/scans', { method: 'POST' });
export const cancelScan = (id: number) =>
  request(`/scans/${id}/cancel`, { method: 'POST' }).then(() => undefined);
export const getScanErrors = (id: number, cursor: string, signal?: AbortSignal) =>
  api<ScanErrorsResponse>(`/scans/${id}/errors?${new URLSearchParams({ cursor, limit: '50' })}`, {
    signal,
  });
export const getScanLogs = (
  scanId: number | undefined,
  level: LogLevelFilter,
  cursor = '',
  signal?: AbortSignal
) => {
  const query = new URLSearchParams();
  if (scanId) query.set('scan_id', String(scanId));
  if (level) query.set('level', level);
  if (cursor) query.set('cursor', cursor);
  query.set('limit', '50');
  return api<ScanLogsResponse>(`/scans/logs?${query}`, { signal });
};
export const scanLogsStream = (id: number) => `/api/scans/${id}/logs-stream`;
