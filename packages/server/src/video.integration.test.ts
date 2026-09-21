import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from './server.js';
import { openDatabase } from './db.js';
import { hamming } from './hashing.js';
import { videoHash } from './video.js';

const exec = promisify(execFile);
let fixtures: string, media: string, root: string;
let app: Awaited<ReturnType<typeof createServer>>;
let db: ReturnType<typeof openDatabase>['db'];
let cookie: string;
const password = 'video-integration-password';
const ffmpeg = (...args: string[]) =>
  exec('ffmpeg', ['-v', 'error', '-y', ...args], { timeout: 30000 });
beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), 'vvv-video-fixtures-'));
  media = join(fixtures, 'media');
  await mkdir(media);
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=24:duration=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    join(media, 'source.mp4')
  );
  await ffmpeg(
    '-i',
    join(media, 'source.mp4'),
    '-vf',
    'scale=160:120',
    '-c:v',
    'libx264',
    '-crf',
    '30',
    join(media, 'resized.mp4')
  );
  await ffmpeg(
    '-i',
    join(media, 'source.mp4'),
    '-c:v',
    'mpeg4',
    '-q:v',
    '6',
    join(media, 'reencoded.avi')
  );
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'color=red:size=320x240:rate=24:duration=3',
    '-c:v',
    'libx264',
    join(media, 'different.mp4')
  );
}, 30000);
afterAll(async () => {
  await rm(fixtures, { recursive: true, force: true });
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vvv-video-integration-'));
  app = await createServer(
    { password, sessionSecret: 'video-integration-session', port: 8080, dataDir: root },
    false
  );
  db = openDatabase(root).db;
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});
const request = (url: string, method: 'GET' | 'POST' = 'GET') =>
  app.inject({ method, url, headers: { cookie } });
async function scan() {
  expect((await request('/api/scans', 'POST')).statusCode).toBe(202);
  await vi.waitFor(
    () =>
      expect(db.prepare('SELECT status FROM scans ORDER BY id DESC LIMIT 1').get()).toEqual({
        status: 'done',
      }),
    { timeout: 30000, interval: 20 }
  );
  await vi.waitFor(
    () =>
      expect(db.prepare('SELECT status FROM match_runs ORDER BY id DESC LIMIT 1').get()).toEqual({
        status: 'active',
      }),
    { timeout: 10000, interval: 20 }
  );
}
it('scans synthetic clips, groups re-encodes/resizes but not different sources, and preserves checkpoints', async () => {
  db.prepare('INSERT INTO scan_dirs(path) VALUES (?)').run(media);
  await scan();
  expect(db.prepare('SELECT errors,processed FROM scans').get()).toEqual({
    errors: 0,
    processed: 4,
  });
  const rows = db
    .prepare('SELECT id,rel_path,width,height,duration_ms,sha256 FROM files ORDER BY id')
    .all() as {
    id: number;
    rel_path: string;
    width: number;
    height: number;
    duration_ms: number;
    sha256: string;
  }[];
  expect(rows.find((r) => r.rel_path === 'resized.mp4')).toMatchObject({
    width: 160,
    height: 120,
    duration_ms: 2000,
  });
  expect(db.prepare('SELECT count(*) AS n FROM phashes').get()).toEqual({ n: 36 });
  expect(db.prepare('SELECT count(*) AS n FROM phash_bands').get()).toEqual({ n: 144 });
  const groups = (await request('/api/groups?kind=video')).json().items as {
    id: number;
    member_count: number;
  }[];
  expect(groups).toHaveLength(1);
  expect(groups[0]!.member_count).toBe(3);
  const detail = (await request(`/api/groups/${groups[0]!.id}`)).json();
  expect(detail.kind).toBe('video');
  expect(
    detail.members.items.map((m: { path: string }) => m.path.split('/').at(-1)).sort()
  ).toEqual(['reencoded.avi', 'resized.mp4', 'source.mp4']);
  expect(
    detail.members.items.every(
      (m: { similarity: number }) => Number.isFinite(m.similarity) && m.similarity <= 10
    )
  ).toBe(true);
  const hashes = db.prepare('SELECT * FROM phashes ORDER BY file_id,frame_idx').all();
  await scan();
  expect(db.prepare('SELECT * FROM phashes ORDER BY file_id,frame_idx').all()).toEqual(hashes);
  expect(
    db.prepare('SELECT id,rel_path,width,height,duration_ms,sha256 FROM files ORDER BY id').all()
  ).toEqual(rows);
  for (const url of [
    '/api/scans/current',
    '/api/groups?kind=video',
    `/api/files/${rows[0]!.id}/thumb`,
  ])
    expect((await app.inject(url)).statusCode).toBe(401);
}, 45000);
it('serves cached middle-frame JPEGs, invalidates changes, and returns genuine 404s', async () => {
  db.prepare('INSERT INTO scan_dirs(path) VALUES (?)').run(fixtures);
  const path = join(fixtures, 'preview.mp4');
  await writeFile(path, await readFile(join(media, 'source.mp4')));
  const id = Number(
    db
      .prepare(
        "INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status,duration_ms) VALUES (1,'preview.mp4','video',1,0,'done',2000)"
      )
      .run().lastInsertRowid
  );
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => request(`/api/files/${id}/thumb`))
  );
  expect(
    responses.every((r) => r.statusCode === 200 && r.headers['content-type'] === 'image/jpeg')
  ).toBe(true);
  expect(await sharp(responses[0]!.rawPayload).metadata()).toMatchObject({
    format: 'jpeg',
    width: 256,
    height: 192,
  });
  const cache = join(root, 'thumbs', `${id}.jpg`),
    before = await stat(cache, { bigint: true });
  expect((await request(`/api/files/${id}/thumb`)).rawPayload).toEqual(responses[0]!.rawPayload);
  expect((await stat(cache, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  await writeFile(path, 'broken video');
  expect((await request(`/api/files/${id}/thumb`)).statusCode).toBe(404);
  db.prepare("UPDATE files SET status='quarantined' WHERE id=?").run(id);
  expect((await request(`/api/files/${id}/thumb`)).statusCode).toBe(404);
  expect((await app.inject(`/api/files/${id}/thumb`)).statusCode).toBe(401);
});
const corpus = resolve('..', '..', 'tests/fixtures/data/video');
const variants = [
  'original-video1-small-360p.mp4',
  'original-video1-webm.webm',
  'original-video2-small-360p.mp4',
];
it.skipIf(!variants.every((file) => existsSync(join(corpus, file))))(
  'matches available local variants without treating different original sources as duplicates',
  async () => {
    const [a, b, c] = await Promise.all(
      variants.map((name) => videoHash(join(corpus, name), 9, { timeout: 120000 }))
    );
    const distance = (x: typeof a, y: typeof a) =>
      x!.hashes.reduce((sum, hash, i) => sum + hamming(hash, y!.hashes[i]!), 0) / 9;
    expect(distance(a, b)).toBeLessThanOrEqual(10);
    expect(distance(a, c)).toBeGreaterThan(10);
  },
  150000
);
