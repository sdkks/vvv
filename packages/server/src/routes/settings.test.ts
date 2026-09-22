import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Page, QuarantineResponse, Settings, TrashItem } from '@vvv/shared';
import { createServer } from '../server.js';
import { openDatabase } from '../db.js';
import { exists, Quarantine } from '../quarantine.js';

const config = {
  password: 'settings-fixture',
  sessionSecret: 'settings-fixture-secret',
  port: 8080,
};
let root: string;
let app: Awaited<ReturnType<typeof createServer>>;
let db: ReturnType<typeof openDatabase>['db'];
let cookie: string;
const matching: Settings['matching'] = {
  methods: [
    {
      id: 'exact',
      label: 'Exact duplicates (SHA-256)',
      scope: 'all files',
      enabled: true,
      threshold: null,
    },
    {
      id: 'image_dhash',
      label: 'Near-duplicate images (perceptual dHash)',
      scope: 'image files',
      enabled: true,
      threshold: 6,
    },
    {
      id: 'video_dhash',
      label: 'Near-duplicate videos (frame perceptual dHash)',
      scope: 'video files',
      enabled: true,
      threshold: 10,
    },
  ],
  video_frame_count: 9,
  video_timeout_ms: 600000,
};
const defaults = { retention_days: 30, auto_purge_enabled: false, matching };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vvv-settings-'));
  app = await createServer({ ...config, dataDir: root }, false);
  db = openDatabase(root).db;
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: config.password },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
});
afterEach(async () => {
  vi.useRealTimers();
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});
const get = () => app.inject({ url: '/api/settings', headers: { cookie } });
const patch = (payload: unknown) =>
  app.inject({
    method: 'PATCH',
    url: '/api/settings',
    headers: { cookie },
    payload: JSON.stringify(payload),
  });
const update = (payload: unknown) =>
  app.inject({
    method: 'PATCH',
    url: '/api/settings',
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });

it('requires authentication before validation or mutation', async () => {
  for (const method of ['GET', 'PATCH'] as const) {
    const response = await app.inject({ method, url: '/api/settings' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  }
  expect((await get()).json()).toEqual(defaults);
});
it('reports effective matching defaults without inserting absent keys', async () => {
  db.prepare('DELETE FROM settings WHERE key IN (?,?,?,?)').run(
    'image_phash_threshold',
    'video_phash_threshold',
    'video_frame_count',
    'video_timeout_ms'
  );
  const before = db.prepare('SELECT * FROM settings ORDER BY key').all();
  const response = await get();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(defaults);
  expect(db.prepare('SELECT * FROM settings ORDER BY key').all()).toEqual(before);
});
it('reports independently seeded effective values, including a zero threshold', async () => {
  db.exec(
    "INSERT OR REPLACE INTO settings VALUES ('image_phash_threshold','0'),('video_phash_threshold','12'),('video_frame_count','3'),('video_timeout_ms','90000')"
  );
  const response = await get();
  expect(response.statusCode).toBe(200);
  expect(response.json<Settings>().matching).toEqual({
    methods: matching.methods.map((method) => ({
      ...method,
      threshold: method.id === 'exact' ? null : method.id === 'image_dhash' ? 0 : 12,
    })),
    video_frame_count: 3,
    video_timeout_ms: 90000,
  });
  db.prepare("DELETE FROM settings WHERE key='image_phash_threshold'").run();
  expect((await get()).json<Settings>().matching.methods[1]?.threshold).toBe(6);
});
it('strictly rejects invalid settings without partial writes', async () => {
  for (const payload of [
    null,
    [],
    {},
    { retention_days: 0 },
    { retention_days: -1 },
    { retention_days: 3651 },
    { retention_days: 1.2 },
    { retention_days: '2' },
    { retention_days: null },
    { auto_purge_enabled: 1 },
    { auto_purge_enabled: 'true' },
    { auto_purge_enabled: null },
    { active_match_run: '2' },
    { matching },
    { retention_days: 2, matching },

    { retention_days: 2, auto_purge_enabled: true, unknown: false },
  ]) {
    expect((await update(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    expect((await get()).json()).toEqual(defaults);
  }
  expect((await patch({ retention_days: 2 })).statusCode).toBe(415);
  expect(db.prepare('SELECT * FROM file_operations').all()).toEqual([]);
});
it('round-trips partial updates and boundaries through persistent storage after restart', async () => {
  expect((await update({ retention_days: 1 })).json<Settings>()).toEqual({
    retention_days: 1,
    auto_purge_enabled: false,
    matching,
    consequences: [],
  });
  expect((await update({ auto_purge_enabled: true })).json<Settings>()).toEqual({
    retention_days: 1,
    auto_purge_enabled: true,
    matching,
    consequences: [],
  });
  expect((await update({ retention_days: 3650 })).statusCode).toBe(200);
  await app.close();
  app = await createServer({ ...config, dataDir: root }, false);
  expect((await get()).json<Settings>()).toEqual({
    retention_days: 3650,
    auto_purge_enabled: true,
    matching,
  });
  expect((await update({ auto_purge_enabled: false })).json<Settings>()).toEqual({
    retention_days: 3650,
    auto_purge_enabled: false,
    matching,
    consequences: [],
  });
  expect(db.prepare('SELECT * FROM file_operations').all()).toEqual([]);
});
it('applies changed retention on the next automatic purge tick and in trash deadlines', async () => {
  const media = join(root, 'media');
  await mkdir(media);
  await writeFile(join(media, 'photo.jpg'), 'fixture');
  db.prepare('INSERT INTO scan_dirs(path) VALUES (?)').run(media);
  db.exec(
    "INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status) VALUES (1,'photo.jpg','image',7,0,'done')"
  );
  const moved = await app.inject({
    method: 'POST',
    url: '/api/files/quarantine',
    headers: { cookie },
    payload: { file_ids: [1] },
  });
  const id = moved.json<QuarantineResponse>().moved[0]!.trash_id;
  db.prepare("UPDATE trash SET quarantined_at=datetime('now','-2 days') WHERE id=?").run(id);
  await update({ auto_purge_enabled: true });
  const readTrash = () => app.inject({ url: '/api/trash', headers: { cookie } });
  const before = (await readTrash()).json<Page<TrashItem>>().items[0]!;
  const path = join(media, before.trash_rel_path);
  const scheduler = new Quarantine(db, app.log);
  expect(await scheduler.purgeExpired(true)).toEqual({ purged: 0, failed: [] });
  await update({ retention_days: 1 });
  const after = (await readTrash()).json<Page<TrashItem>>().items[0]!;
  expect(after.purge_after).not.toBe(before.purge_after);
  expect(after.purge_after).toBe(
    (
      db
        .prepare("SELECT datetime(quarantined_at,'+1 day') AS deadline FROM trash WHERE id=?")
        .get(id) as { deadline: string }
    ).deadline
  );
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  scheduler.start();
  await vi.advanceTimersByTimeAsync(3600000);
  await scheduler.close();
  expect(await exists(path)).toBe(false);
  expect((await readTrash()).json<Page<TrashItem>>().items).toEqual([]);
});
