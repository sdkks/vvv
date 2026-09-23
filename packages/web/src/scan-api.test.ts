import { afterEach, expect, it, vi } from 'vitest';
import {
  addScanDir,
  cancelScan,
  getCurrentScan,
  getScanDirs,
  getScanErrors,
  removeScanDir,
  startScan,
  updateScanDir,
} from './api';

afterEach(() => vi.unstubAllGlobals());
it('uses authenticated JSON CRUD and accepts empty cancellation responses', async () => {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ items: [] })));
  vi.stubGlobal('fetch', fetch);
  const signal = new AbortController().signal;
  await getScanDirs(signal);
  expect(fetch).toHaveBeenLastCalledWith('/api/scan-dirs', { signal, credentials: 'same-origin' });
  await addScanDir({ path: '/media/a b', follow_symlinks: true });
  expect(fetch).toHaveBeenLastCalledWith('/api/scan-dirs', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/media/a b', follow_symlinks: true }),
  });
  await updateScanDir(3, { cross_filesystems: true });
  expect(fetch).toHaveBeenLastCalledWith(
    '/api/scan-dirs/3',
    expect.objectContaining({ method: 'PATCH', body: '{"cross_filesystems":true}' })
  );
  fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await expect(removeScanDir(3)).resolves.toBeUndefined();
  expect(fetch).toHaveBeenLastCalledWith('/api/scan-dirs/3', {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  fetch.mockResolvedValueOnce(new Response(null, { status: 202 }));
  await expect(cancelScan(8)).resolves.toBeUndefined();
  expect(fetch).toHaveBeenLastCalledWith('/api/scans/8/cancel', {
    method: 'POST',
    credentials: 'same-origin',
  });
  await startScan({ images: true, videos: false, audio: true });
  expect(fetch).toHaveBeenLastCalledWith('/api/scans', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: true, videos: false, audio: true }),
  });
  await getCurrentScan(signal);
  expect(fetch).toHaveBeenLastCalledWith('/api/scans/current', {
    signal,
    credentials: 'same-origin',
  });
  await getScanErrors(8, 'opaque/a+=', signal);
  expect(fetch).toHaveBeenLastCalledWith('/api/scans/8/errors?cursor=opaque%2Fa%2B%3D&limit=50', {
    signal,
    credentials: 'same-origin',
  });
});
it.each([
  [409, 'directory_registered', 'already registered'],
  [400, 'invalid_directory', 'not found or not accessible'],
  [400, 'not_a_directory', 'not a directory'],
  [409, 'scan_running', 'already running'],
])('explains scan setup failures (%s %s)', async (status, error, message) => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ error }, { status: Number(status) }))
  );
  await expect(startScan({ images: true, videos: true, audio: true })).rejects.toThrow(
    String(message)
  );
});
it('uses current-scan resync to recover an SSE auth failure through the existing return-location flow', async () => {
  const replace = vi.fn();
  vi.stubGlobal('window', { location: { pathname: '/scan', search: '', hash: '', replace } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
  await expect(getCurrentScan()).rejects.toThrow('Please sign in again');
  expect(replace).toHaveBeenCalledWith('/login?returnTo=%2Fscan');
});
