import type {
  GroupKind,
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
} from '@vvv/shared';

export class ResultsChangedError extends Error {
  constructor() {
    super('Results changed — a new match completed');
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
    if (
      (response.status === 409 && code === 'stale_cursor') ||
      (response.status === 404 && code === 'group_not_found')
    )
      throw new ResultsChangedError();
    const messages: Record<string, string> = {
      match_running: 'Matching is already running. Try again shortly.',
      scan_running: 'A scan is already running. Refresh to see its progress.',
      directory_registered: 'This directory is already registered.',
      invalid_directory: 'Directory not found or not accessible on the server.',
      not_a_directory: 'This path is not a directory.',
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
export function groupsSearch(kind: KindFilter, cursor = '') {
  const query = new URLSearchParams();
  if (kind) query.set('kind', kind);
  if (cursor) query.set('cursor', cursor);
  return query.size ? `?${query}` : '';
}
export const getGroups = (kind: KindFilter, cursor = '', signal?: AbortSignal) =>
  api<GroupsResponse>(`/groups${groupsSearch(kind, cursor)}`, { signal });
export const getGroup = (id: string, cursor = '', signal?: AbortSignal) =>
  api<GroupResponse>(`/groups/${encodeURIComponent(id)}${groupsSearch('', cursor)}`, { signal });
export const runMatching = () => api<StartMatchResponse>('/matches/run', { method: 'POST' });

const jsonBody = (method: string, body: object): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
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
