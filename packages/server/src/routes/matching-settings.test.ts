import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GroupsResponse, Settings, UpdateSettingsResponse } from '@vvv/shared';
import { createServer } from '../server.js';
import { openDatabase } from '../db.js';
import { storeHashes } from '../hashing.js';
import { activeMatchRun } from '../matcher.js';

const config = { password: 'matching-fixture', sessionSecret: 'matching-test-secret', port: 8080 };
let root: string;
let app: Awaited<ReturnType<typeof createServer>>;
let db: ReturnType<typeof openDatabase>['db'];
let cookie: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vvv-matching-settings-'));
  app = await createServer({ ...config, dataDir: root }, false);
  db = openDatabase(root).db;
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: config.password },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  db.prepare('INSERT INTO scan_dirs(path) VALUES (?)').run(join(root, 'media'));
});
afterEach(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});
const get = (url = '/api/settings') => app.inject({ url, headers: { cookie } });
const patch = (payload: object) =>
  app.inject({ method: 'PATCH', url: '/api/settings', headers: { cookie }, payload });
const catalog = () =>
  ['files', 'phashes', 'phash_bands'].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
function file(kind: string, status = 'done', hash = Buffer.alloc(8)) {
  const id = Number(
    db
      .prepare(
        `INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status,sha256)
    VALUES (1,?,?,10,0,?,?)`
      )
      .run(`${kind}-${Math.random()}`, kind, status, `sha-${Math.random()}`).lastInsertRowid
  );
  storeHashes(db, id, kind === 'video' ? Array.from({ length: 9 }, () => hash) : [hash]);
  return id;
}
async function match() {
  const response = await app.inject({
    method: 'POST',
    url: '/api/matches/run',
    headers: { cookie },
  });
  expect(response.statusCode).toBe(202);
  const run = response.json<{ match_run: number }>().match_run;
  await vi.waitFor(() => {
    expect(activeMatchRun(db)).toBe(run);
    expect(db.prepare('SELECT count(*) AS n FROM match_runs').get()).toEqual({ n: 1 });
  });
  await tick();
  await tick();
  return run;
}
it.each([
  ['image_phash_threshold', 0, 64],
  ['video_phash_threshold', 0, 64],
  ['video_frame_count', 1, 64],
  ['video_timeout_ms', 10000, 3600000],
  ['min_file_size_mb', 0, Number.MAX_SAFE_INTEGER],
  ['max_file_size_mb', 0, Number.MAX_SAFE_INTEGER],
] as const)('validates %s strictly and atomically with field detail', async (key, min, max) => {
  for (const value of [min - 1, max + 1, min + 0.5, String(min), null, true, [], {}]) {
    const before = (await get()).json();
    const response = await patch({ [key]: value, retention_days: 12, auto_purge_enabled: true });
    expect(response.statusCode, JSON.stringify(value)).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'invalid_settings',
      fields: { [key]: expect.any(String) },
    });
    expect((await get()).json()).toEqual(before);
  }
  for (const value of [min, max]) expect((await patch({ [key]: value })).statusCode).toBe(200);
});
it.each(['image', 'video'] as const)(
  'strictly validates and persists the %s switch with change-only consequences and auth',
  async (kind) => {
    const key = `match_${kind}s_enabled`;
    for (const value of [0, 1, 'true', 'false', '0', null, [], {}]) {
      expect((await patch({ [key]: value, retention_days: 12 })).statusCode).toBe(400);
      expect((await get()).json<Settings>().retention_days).toBe(30);
    }
    expect(
      (await app.inject({ method: 'PATCH', url: '/api/settings', payload: { [key]: false } }))
        .statusCode
    ).toBe(401);
    expect((await app.inject('/api/settings')).statusCode).toBe(401);
    expect((await patch({ match_exact_enabled: false })).statusCode).toBe(400);
    expect((await patch({ [key]: true })).json<UpdateSettingsResponse>().consequences).toEqual([]);
    const before = catalog();
    const disabled = (await patch({ [key]: false })).json<UpdateSettingsResponse>();
    expect(disabled.consequences).toEqual([
      {
        type: 'match_disabled',
        kind,
        message: `Future scans skip ${kind} perceptual hashing; existing ${kind} groups remain until re-match; re-match removes them.`,
      },
    ]);
    expect(disabled.matching.methods.find((m) => m.id === `${kind}_dhash`)?.enabled).toBe(false);
    expect(disabled.matching.methods.find((m) => m.id === 'exact')?.enabled).toBe(true);
    expect((await patch({ [key]: false })).json<UpdateSettingsResponse>().consequences).toEqual([]);
    await app.close();
    app = await createServer({ ...config, dataDir: root }, false);
    expect(
      (await get()).json<Settings>().matching.methods.find((m) => m.id === `${kind}_dhash`)?.enabled
    ).toBe(false);
    expect((await patch({ [key]: true })).json<UpdateSettingsResponse>().consequences).toEqual([
      {
        type: 'match_enabled',
        kind,
        message: `Existing ${kind} files will be analyzed on the next scan (no content re-hashing).`,
      },
      { type: 'rematch_required', reason: 'match_enabled', kind },
    ]);
    expect(catalog()).toEqual(before);
  }
);
it.each(['image', 'video'] as const)(
  're-match skips disabled %s candidates without losing exact or other-kind groups',
  async (kind) => {
    for (const mediaKind of ['image', 'video']) {
      const a = file(mediaKind),
        b = file(mediaKind);
      file(mediaKind);
      db.prepare('UPDATE files SET sha256=? WHERE id IN (?,?)').run(`exact-${mediaKind}`, a, b);
      const missing = file(mediaKind);
      storeHashes(db, missing, []);
    }
    await match();
    expect((await get(`/api/groups?kind=${kind}`)).json<GroupsResponse>().items).toHaveLength(1);
    const before = catalog();
    expect((await patch({ [`match_${kind}s_enabled`]: false })).statusCode).toBe(200);
    expect((await get(`/api/groups?kind=${kind}`)).json<GroupsResponse>().items).toHaveLength(1);
    await match();
    expect((await get(`/api/groups?kind=${kind}`)).json<GroupsResponse>().items).toEqual([]);
    expect(
      (await get(`/api/groups?kind=${kind === 'image' ? 'video' : 'image'}`)).json<GroupsResponse>()
        .items
    ).toHaveLength(1);
    expect((await get('/api/groups?kind=exact')).json<GroupsResponse>().items).toHaveLength(2);
    expect(catalog()).toEqual(before);
    await patch({ match_images_enabled: false, match_videos_enabled: false });
    await match();
    expect(db.prepare('SELECT candidate_pairs,skipped_buckets FROM match_runs').get()).toEqual({
      candidate_pairs: 0,
      skipped_buckets: '[]',
    });
    expect(
      (await get('/api/groups')).json<GroupsResponse>().items.every((g) => g.kind === 'exact')
    ).toBe(true);
    await patch({ match_images_enabled: true, match_videos_enabled: true });
    await match();
    expect((await get('/api/groups?kind=image')).json<GroupsResponse>().items).toHaveLength(1);
    expect((await get('/api/groups?kind=video')).json<GroupsResponse>().items).toHaveLength(1);
  }
);
it('validates the hash enum strictly, authorizes access, and treats unchanged defaults as a no-op', async () => {
  file('image');
  const before = catalog();
  expect((await get()).json<Settings>().matching.file_hash_algorithm).toBe('sha256');
  for (const value of ['', 'SHA-256', 'md5', 'blake2b', ' sha256 ', 0, true, null, [], {}]) {
    const response = await patch({ file_hash_algorithm: value, retention_days: 12 });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'invalid_settings',
      fields: { file_hash_algorithm: expect.any(String) },
    });
    expect((await get()).json<Settings>().retention_days).toBe(30);
    expect(catalog()).toEqual(before);
  }
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        payload: { file_hash_algorithm: 'blake2b512' },
      })
    ).statusCode
  ).toBe(401);
  expect((await app.inject('/api/settings')).statusCode).toBe(401);
  expect(
    (await patch({ file_hash_algorithm: 'sha256' })).json<UpdateSettingsResponse>().consequences
  ).toEqual([]);
  expect(catalog()).toEqual(before);
});
it('invalidates all content hashes atomically, preserves unavailable statuses and perceptual work across restart', async () => {
  const statuses = ['done', 'hashed', 'error', 'missing', 'quarantined', 'excluded', 'pending'];
  for (const status of statuses) file('image', status);
  const hashes = db.prepare('SELECT * FROM phashes').all();
  const bands = db.prepare('SELECT * FROM phash_bands').all();
  for (const algorithm of ['blake2b512', 'sha256']) {
    statuses.forEach((status, i) =>
      db
        .prepare('UPDATE files SET status=?,sha256=? WHERE id=?')
        .run(status, 'old-checkpoint', i + 1)
    );
    const response = await patch({ file_hash_algorithm: algorithm, retention_days: 12 });
    expect(response.statusCode).toBe(200);
    expect(response.json<UpdateSettingsResponse>()).toMatchObject({
      retention_days: 12,
      matching: {
        file_hash_algorithm: algorithm,
        methods: [
          expect.objectContaining({ id: 'exact', algorithm }),
          expect.anything(),
          expect.anything(),
        ],
      },
      consequences: [
        {
          type: 'rehash_required',
          message: 'All files will be re-hashed with the new algorithm on the next scan.',
        },
      ],
    });
    await app.close();
    db.close();
    app = await createServer({ ...config, dataDir: root }, false);
    db = openDatabase(root).db;
    expect((await get()).json<Settings>().matching.file_hash_algorithm).toBe(algorithm);
    expect(db.prepare('SELECT status,sha256 FROM files ORDER BY id').all()).toEqual(
      statuses.map((status) => ({
        status: status === 'done' || status === 'hashed' ? 'pending' : status,
        sha256: null,
      }))
    );
    expect(db.prepare('SELECT * FROM phashes').all()).toEqual(hashes);
    expect(db.prepare('SELECT * FROM phash_bands').all()).toEqual(bands);
    expect(
      (await patch({ file_hash_algorithm: algorithm })).json<UpdateSettingsResponse>().consequences
    ).toEqual([]);
  }
});
it('rolls back the algorithm, hashes and other settings when re-queue invalidation fails', async () => {
  file('image');
  file('video', 'quarantined');
  const before = catalog();
  db.exec(
    `CREATE TRIGGER fail_requeue BEFORE UPDATE OF status ON files BEGIN SELECT RAISE(ABORT,'fixture'); END`
  );
  expect((await patch({ file_hash_algorithm: 'blake2b512', retention_days: 2 })).statusCode).toBe(
    500
  );
  expect(catalog()).toEqual(before);
  expect((await get()).json<Settings>()).toMatchObject({
    retention_days: 30,
    matching: { file_hash_algorithm: 'sha256', video_frame_count: 9 },
  });
});
it('refuses algorithm changes during scans or matching before mutation, but accepts no-ops', async () => {
  file('image');
  const before = catalog();
  for (const table of ['scans', 'match_runs']) {
    db.prepare(`INSERT INTO ${table}(status) VALUES (?)`).run(
      table === 'scans' ? 'running' : 'building'
    );
    const response = await patch({ file_hash_algorithm: 'blake2b512', retention_days: 1 });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: table === 'scans' ? 'settings_scan_running' : 'settings_match_running',
    });
    expect((await patch({ file_hash_algorithm: 'sha256' })).statusCode).toBe(200);
    expect(catalog()).toEqual(before);
    expect((await get()).json<Settings>()).toMatchObject({
      retention_days: 30,
      matching: { file_hash_algorithm: 'sha256' },
    });
    db.prepare(`DELETE FROM ${table}`).run();
  }
});
it('validates merged size ranges atomically and persists explicit disabling with consequences', async () => {
  const video = file('video', 'excluded');
  const before = catalog();
  expect(
    (await patch({ min_file_size_mb: 1, max_file_size_mb: 2 })).json<UpdateSettingsResponse>()
  ).toMatchObject({
    matching: { min_file_size_mb: 1, max_file_size_mb: 2 },
    consequences: [{ type: 'next_scan_required', reason: 'size_filter_change' }],
  });
  for (const payload of [{ min_file_size_mb: 3 }, { min_file_size_mb: 2, max_file_size_mb: 1 }]) {
    const response = await patch({ ...payload, retention_days: 12 });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_settings',
      fields: {
        max_file_size_mb: 'Maximum must be at least minimum when both are enabled.',
      },
    });
    expect((await get()).json()).toMatchObject({
      retention_days: 30,
      matching: { min_file_size_mb: 1, max_file_size_mb: 2 },
    });
  }
  expect(
    (await patch({ max_file_size_mb: 2 })).json<UpdateSettingsResponse>().consequences
  ).toEqual([]);
  db.exec("INSERT INTO scans(status) VALUES ('running')");
  expect((await patch({ max_file_size_mb: 0 })).statusCode).toBe(200);
  expect((await patch({ min_file_size_mb: 0 })).statusCode).toBe(200);
  expect(catalog()).toEqual(before);
  await app.close();
  app = await createServer({ ...config, dataDir: root }, false);
  expect((await get()).json()).toMatchObject({
    matching: { min_file_size_mb: 0, max_file_size_mb: 0 },
  });
  expect(db.prepare('SELECT status FROM files WHERE id=?').get(video)).toEqual({
    status: 'excluded',
  });
});
it('persists mixed updates and invalidation together across a database reopen, leaving images and SHA intact', async () => {
  const video = file('video');
  const hashed = file('video', 'hashed');
  const image = file('image');
  const trash = file('video', 'quarantined');
  const missing = file('video', 'missing');
  const before = db.prepare('SELECT id,sha256 FROM files ORDER BY id').all();
  const imageHashes = db.prepare('SELECT * FROM phashes WHERE file_id=?').all(image);
  const response = await patch({
    retention_days: 15,
    auto_purge_enabled: true,
    image_phash_threshold: 0,
    video_phash_threshold: 64,
    video_frame_count: 3,
    video_timeout_ms: 90000,
  });
  expect(response.statusCode).toBe(200);
  const { consequences, ...effective } = response.json<UpdateSettingsResponse>();
  expect(consequences).toEqual([
    { type: 'rematch_required', reason: 'threshold_change' },
    { type: 'rescan_required', reason: 'frame_count_change' },
    { type: 'future_sampling_only', reason: 'timeout_change' },
  ]);
  expect((await get()).json()).toEqual(effective);
  await app.close();
  db.close();
  app = await createServer({ ...config, dataDir: root }, false);
  db = openDatabase(root).db;
  expect((await get()).json()).toEqual(effective);
  expect(db.prepare('SELECT id,sha256 FROM files ORDER BY id').all()).toEqual(before);
  expect(db.prepare('SELECT id,status FROM files ORDER BY id').all()).toEqual([
    { id: video, status: 'pending' },
    { id: hashed, status: 'pending' },
    { id: image, status: 'done' },
    { id: trash, status: 'quarantined' },
    { id: missing, status: 'missing' },
  ]);
  expect(db.prepare('SELECT * FROM phashes').all()).toEqual(imageHashes);
  expect(db.prepare('SELECT DISTINCT file_id FROM phash_bands').all()).toEqual([
    { file_id: image },
  ]);
  expect(
    (await patch({ video_frame_count: 3 })).json<UpdateSettingsResponse>().consequences
  ).toEqual([]);
});
it('rolls back settings and hash deletions if invalidation fails', async () => {
  file('video');
  const before = catalog();
  db.exec(
    `CREATE TRIGGER fail_invalidation BEFORE UPDATE OF status ON files BEGIN SELECT RAISE(ABORT,'fixture'); END`
  );
  expect((await patch({ video_frame_count: 2, retention_days: 2 })).statusCode).toBe(500);
  expect(catalog()).toEqual(before);
  expect((await get()).json<Settings>()).toMatchObject({
    retention_days: 30,
    matching: { video_frame_count: 9 },
  });
});
it('changes timeout and thresholds without invalidation; unchanged values have no consequences', async () => {
  file('video');
  file('image');
  const before = catalog();
  expect(
    (await patch({ video_timeout_ms: 10000 })).json<UpdateSettingsResponse>().consequences
  ).toEqual([{ type: 'future_sampling_only', reason: 'timeout_change' }]);
  expect(
    (
      await patch({ image_phash_threshold: 0, video_phash_threshold: 1 })
    ).json<UpdateSettingsResponse>().consequences
  ).toEqual([{ type: 'rematch_required', reason: 'threshold_change' }]);
  expect(catalog()).toEqual(before);
  expect(
    (
      await patch({
        video_timeout_ms: 10000,
        image_phash_threshold: 0,
        video_phash_threshold: 1,
        video_frame_count: 9,
      })
    ).json<UpdateSettingsResponse>().consequences
  ).toEqual([]);
  expect(catalog()).toEqual(before);
});
it('preserves groups until the requested re-match publishes a new generation and invalidates cursors', async () => {
  file('image');
  file('image', 'done', Buffer.from('0000000000000001', 'hex'));
  for (const sha of ['exact-a', 'exact-b']) {
    const a = file('video'),
      b = file('video');
    db.prepare('UPDATE files SET sha256=? WHERE id IN (?,?)').run(sha, a, b);
  }
  const run = await match();
  const page = (await get('/api/groups?limit=1')).json<GroupsResponse>();
  expect(page.next_cursor).toBeTruthy();
  const oldImages = (await get('/api/groups?kind=image')).json<GroupsResponse>();
  expect(oldImages.items).toHaveLength(1);
  expect((await patch({ image_phash_threshold: 0 })).statusCode).toBe(200);
  expect(activeMatchRun(db)).toBe(run);
  expect((await get('/api/groups?kind=image')).json()).toEqual(oldImages);
  const next = await match();
  expect(next).not.toBe(run);
  expect((await get('/api/groups?kind=image')).json<GroupsResponse>().items).toEqual([]);
  const stale = await get(`/api/groups?cursor=${encodeURIComponent(page.next_cursor!)}`);
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toEqual({ error: 'stale_cursor', match_run: next });
});
it('rejects conflicting changes during active work before any partial write', async () => {
  db.exec("INSERT INTO scans(status) VALUES ('running')");
  expect((await patch({ video_frame_count: 2, retention_days: 1 })).statusCode).toBe(409);
  expect((await patch({ video_timeout_ms: 10000 })).statusCode).toBe(200);
  db.exec("UPDATE scans SET status='done'; INSERT INTO match_runs(status) VALUES ('building')");
  expect((await patch({ image_phash_threshold: 2, retention_days: 1 })).statusCode).toBe(409);
  expect((await patch({ video_frame_count: 2 })).statusCode).toBe(409);
  expect((await patch({ match_images_enabled: false, retention_days: 1 })).statusCode).toBe(409);
  expect((await patch({ match_videos_enabled: false })).statusCode).toBe(409);
  expect((await patch({ match_videos_enabled: true })).statusCode).toBe(200);
  expect((await get()).json<Settings>()).toMatchObject({
    retention_days: 30,
    matching: { video_frame_count: 9 },
  });
});
