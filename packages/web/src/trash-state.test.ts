import { afterEach, expect, it, vi } from 'vitest';
import {
  getSettings,
  getTrash,
  purgeTrash,
  quarantineFiles,
  restoreTrash,
  updateSettings,
} from './api';
import { displayDate, fileFailure, policySummary, purgeAfter, validRetention } from './trash-state';
import { nextGroup } from './group-review';

afterEach(() => vi.unstubAllGlobals());
it.each([0, -1, 3651, 1.5, NaN, Infinity])('rejects retention %s', (days) =>
  expect(validRetention(days)).toBe(false)
);
it.each([1, 30, 3650])('accepts retention %s', (days) => expect(validRetention(days)).toBe(true));
it('explains disabled policy, irreversible hourly policy and server-provided UTC deadlines', () => {
  expect(policySummary({ retention_days: 2, auto_purge_enabled: false })).toContain(
    'kept until manually purged'
  );
  expect(policySummary({ retention_days: 2, auto_purge_enabled: true })).toContain(
    'permanently deleted after 2 days'
  );
  expect(policySummary({ retention_days: 2, auto_purge_enabled: true })).toContain('hourly');
  expect(purgeAfter(null)).toBe('Auto-purge off');
  const deadline = '2026-09-23 12:00:00';
  expect(purgeAfter(deadline, Date.parse('2026-09-21T13:00:00Z'))).toBe(
    `${displayDate(deadline)} · 2 days remaining`
  );
  expect(purgeAfter(deadline, Date.parse('2026-09-23T12:00:00Z'))).toContain(
    'due on next purge check'
  );
  expect(displayDate(deadline)).toBe(new Date('2026-09-23T12:00:00Z').toLocaleString());
});
it('maps per-item failures to actionable explanations without hiding unknown failures', () => {
  expect(fileFailure('destination_exists')).toContain('Original path now occupied');
  expect(fileFailure('exdev')).toContain('different filesystem — move it manually');
  expect(fileFailure('eacces')).toContain('Permission denied');
  expect(fileFailure('unexpected')).toContain('unexpected');
});
it('selects the next actionable group, wraps, skips the current group and tolerates its deletion', () => {
  const items = [1, 2, 3].map((id) => ({
    id,
    kind: 'exact' as const,
    member_count: 2,
    total_bytes: 10,
    reclaimable_bytes: 5,
  }));
  expect(nextGroup(items, 1)?.id).toBe(2);
  expect(nextGroup([items[1]!, items[0]!, items[2]!], 1, items)?.id).toBe(2);
  expect(nextGroup(items.slice(1), 1, items)?.id).toBe(2);
  expect(nextGroup(items, 3)?.id).toBe(1);
  expect(nextGroup(items.slice(1), 1)?.id).toBe(2);
  expect(nextGroup([{ ...items[0]!, member_count: 1 }, items[1]!], 2)).toBeUndefined();
  expect(nextGroup([items[0]!], 1)).toBeUndefined();
  expect(nextGroup([], 1)).toBeUndefined();
});
it('uses the authenticated API path, bounded cursor and exact request bodies; keeps mixed results', async () => {
  const mixed = { moved: [{ file_id: 1, trash_id: 9 }], failed: [{ file_id: 2, error: 'exdev' }] };
  const fetch = vi.fn().mockImplementation(async () => Response.json(mixed));
  vi.stubGlobal('fetch', fetch);
  expect(await quarantineFiles([1, 2])).toEqual(mixed);
  await restoreTrash([9]);
  await purgeTrash([10]);
  await updateSettings({ retention_days: 7, auto_purge_enabled: true });
  await getSettings();
  await getTrash('50');
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    '/api/files/quarantine',
    '/api/trash/restore',
    '/api/trash/purge',
    '/api/settings',
    '/api/settings',
    '/api/trash?cursor=50&limit=50',
  ]);
  expect(fetch.mock.calls.slice(0, 4).map(([, options]) => JSON.parse(options.body))).toEqual([
    { file_ids: [1, 2] },
    { trash_ids: [9] },
    { trash_ids: [10] },
    { retention_days: 7, auto_purge_enabled: true },
  ]);
  for (const [, options] of fetch.mock.calls) expect(options.credentials).toBe('same-origin');
});
it.each([
  () => quarantineFiles([1]),
  () => restoreTrash([1]),
  () => purgeTrash([1]),
  () => getSettings(),
  () => updateSettings({ retention_days: 2 }),
  () => getTrash('50'),
])('redirects a mid-flow 401 preserving the route/cursor', async (operation) => {
  const replace = vi.fn();
  vi.stubGlobal('window', {
    location: { pathname: '/trash', search: '?cursor=50', hash: '', replace },
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
  await expect(operation()).rejects.toThrow('Please sign in again');
  expect(replace).toHaveBeenCalledWith('/login?returnTo=%2Ftrash%3Fcursor%3D50');
});
