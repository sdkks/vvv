import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DirectoryEntries, ExportResponse, GroupsResponse, ScanProgress } from '@vvv/shared';
import { createServer } from '../server.js';
import { openDatabase } from '../db.js';

let root: string;
let media: string;
let cookie: string;
let app: Awaited<ReturnType<typeof createServer>>;
let db: ReturnType<typeof openDatabase>['db'];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vvv-size-filters-'));
  media = join(root, 'media');
  await mkdir(media);
  const png = await sharp({ create: { width: 18, height: 16, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  for (const [prefix, size] of [
    ['small', png.length],
    ['large', 1048576],
  ] as const) {
    const contents = Buffer.alloc(size);
    png.copy(contents);
    await writeFile(join(media, `${prefix}-a.png`), contents);
    await writeFile(join(media, `${prefix}-b.png`), contents);
  }
  app = await createServer(
    { password: 'size-fixture', sessionSecret: 'size-fixture-secret', dataDir: root, port: 8080 },
    false
  );
  db = openDatabase(root).db;
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'size-fixture' },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/scan-dirs',
        headers: { cookie },
        payload: { path: media },
      })
    ).statusCode
  ).toBe(201);
});
afterEach(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});
const get = (url: string) => app.inject({ url, headers: { cookie } });
const patch = (payload: object) =>
  app.inject({ method: 'PATCH', url: '/api/settings', headers: { cookie }, payload });
async function scan() {
  const response = await app.inject({ method: 'POST', url: '/api/scans', headers: { cookie } });
  expect(response.statusCode).toBe(202);
  await vi.waitFor(async () => {
    expect((await get('/api/scans/current')).json<ScanProgress>()).toMatchObject({
      status: 'done',
      discovered: 4,
      processed: 4,
      errors: 0,
    });
    expect(db.prepare("SELECT 1 FROM match_runs WHERE status='building'").get()).toBeUndefined();
  });
}
it('previews, excludes, removes results without Trash effects and restores after widening with real image processing', async () => {
  await scan();
  expect((await get('/api/groups?kind=exact')).json<GroupsResponse>().items).toHaveLength(2);
  const before = db.prepare('SELECT id,rel_path,sha256 FROM files ORDER BY id').all();
  expect((await patch({ min_file_size_mb: 1, max_file_size_mb: 2 })).statusCode).toBe(200);
  // Saving is not retroactive; only the following scan changes catalog eligibility.
  expect(db.prepare("SELECT count(*) AS n FROM files WHERE status='done'").get()).toEqual({ n: 4 });
  const preview = (await get('/api/scan-dirs/1/entries')).json<DirectoryEntries>();
  for (const item of preview.items) {
    if (item.name.startsWith('small')) {
      expect(item.decision).toBe('excluded_by_size');
      expect(item.decision_detail).toContain('below minimum 1 MiB');
      expect(item.decision_detail).toContain('minimum 1 MiB, maximum 2 MiB');
    } else expect(item.decision).toBe('would_process');
  }
  await scan();
  const excluded = db
    .prepare("SELECT id,rel_path,status,error FROM files WHERE status='excluded' ORDER BY rel_path")
    .all() as { id: number; rel_path: string; status: string; error: string }[];
  expect(excluded).toHaveLength(2);
  for (const row of excluded)
    expect(row.error).toMatch(/^excluded_by_size: .* below minimum 1 MiB$/);
  expect(db.prepare('SELECT id,rel_path,sha256 FROM files ORDER BY id').all()).toEqual(before);
  const groups = (await get('/api/groups')).json<GroupsResponse>().items;
  expect(groups.length).toBeGreaterThan(0);
  for (const group of groups) {
    expect(group.member_count).toBe(2);
    expect(group.total_bytes).toBe(2 * 1048576);
    expect((await get(`/api/groups/${group.id}`)).body).not.toContain('small-');
  }
  const exported = (await get('/api/export.json')).json<ExportResponse>();
  expect(exported.groups.length).toBeGreaterThan(0);
  expect(JSON.stringify(exported)).not.toContain('small-');
  expect((await get('/api/export.csv')).body).not.toContain('small-');
  expect((await get('/api/trash')).json().items).toEqual([]);
  const quarantine = await app.inject({
    method: 'POST',
    url: '/api/files/quarantine',
    headers: { cookie },
    payload: { file_ids: excluded.map(({ id }) => id) },
  });
  expect(quarantine.json().moved).toEqual([]);
  expect(quarantine.json().failed).toHaveLength(2);
  expect(db.prepare('SELECT count(*) AS n FROM file_operations').get()).toEqual({ n: 0 });
  const current = (await get('/api/scans/current')).json<ScanProgress>();
  expect((await get(`/api/scans/${current.id}/errors`)).json().items).toEqual([]);
  expect((await patch({ min_file_size_mb: 0, max_file_size_mb: 0 })).statusCode).toBe(200);
  await scan();
  expect(
    db.prepare("SELECT count(*) AS n FROM files WHERE status='done' AND error IS NULL").get()
  ).toEqual({ n: 4 });
  expect(db.prepare('SELECT id,rel_path,sha256 FROM files ORDER BY id').all()).toEqual(before);
  expect((await get('/api/groups?kind=exact')).json<GroupsResponse>().items).toHaveLength(2);
  expect((await get('/api/export.json')).body).toContain('small-');
});
it('keeps size settings, preview, scans, exports, and groups behind authentication', async () => {
  for (const url of [
    '/api/settings',
    '/api/scan-dirs/1/entries',
    '/api/groups',
    '/api/export.json',
    '/api/export.csv',
    '/api/trash',
  ])
    expect((await app.inject({ url })).statusCode).toBe(401);
  expect(
    (await app.inject({ method: 'PATCH', url: '/api/settings', payload: { min_file_size_mb: 1 } }))
      .statusCode
  ).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/scans' })).statusCode).toBe(401);
});
