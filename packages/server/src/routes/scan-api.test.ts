import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { get, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ScanDir, ScanErrorsResponse, ScanProgress } from '@vvv/shared';
import sharp from 'sharp';
import { createServer } from '../server.js';
import { openDatabase } from '../db.js';
import * as hashing from '../hashing.js';

vi.mock('../hashing.js', { spy: true });
const realHashing = await vi.importActual<typeof hashing>('../hashing.js');
const config = {
  password: 'scan-api-test-password',
  sessionSecret: 'scan-api-test-session',
  port: 8080,
};
let root: string;
let media: string;
let app: Awaited<ReturnType<typeof createServer>>;
let db: ReturnType<typeof openDatabase>['db'];
let cookie: string;
let streams: IncomingMessage[];
beforeEach(async () => {
  vi.mocked(hashing.processFile).mockImplementation(realHashing.processFile).mockClear();
  root = await mkdtemp(join(tmpdir(), 'vvv-scan-api-'));
  media = join(root, 'media');
  await mkdir(media);
  app = await createServer({ ...config, dataDir: root }, false);
  db = openDatabase(root).db;
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: config.password },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  streams = [];
});
afterEach(async () => {
  for (const stream of streams) stream.destroy();
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});
const register = (payload: object = { path: media }) =>
  app.inject({ method: 'POST', url: '/api/scan-dirs', headers: { cookie }, payload });
const patch = (id: number | string, payload: object) =>
  app.inject({ method: 'PATCH', url: `/api/scan-dirs/${id}`, headers: { cookie }, payload });
const list = () => app.inject({ url: '/api/scan-dirs', headers: { cookie } });
const errors = (query = '', id = 1) =>
  app.inject({ url: `/api/scans/${id}/errors${query}`, headers: { cookie } });
const start = () => app.inject({ method: 'POST', url: '/api/scans', headers: { cookie } });
const current = () => app.inject({ url: '/api/scans/current', headers: { cookie } });
async function stream(address: string, id: number, lastId?: string) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    get(
      `${address}/api/scans/${id}/events`,
      { headers: { cookie, ...(lastId ? { 'Last-Event-ID': lastId } : {}) } },
      resolve
    ).on('error', reject);
  });
  streams.push(response);
  let body = '';
  response.setEncoding('utf8');
  response.on('data', (chunk: string) => {
    body += chunk;
  });
  response.on('error', () => undefined);
  return {
    response,
    body: () => body,
    snapshots: () =>
      [...body.matchAll(/^data: (.+)$/gm)].map(
        (match) => JSON.parse(match[1] ?? '') as ScanProgress
      ),
  };
}

it('requires authentication on every added method before schema validation or side effects', async () => {
  for (const [method, url] of [
    ['GET', '/api/scan-dirs'],
    ['POST', '/api/scan-dirs'],
    ['PATCH', '/api/scan-dirs/1'],
    ['DELETE', '/api/scan-dirs/1'],
    ['GET', '/api/scans/1/events'],
    ['GET', '/api/scans/1/errors'],
  ] as const) {
    const denied = await app.inject({ method, url });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toEqual({ error: 'unauthorized' });
  }
  expect((await list()).json()).toEqual({ items: [] });
});

it('registers multiple normalized directories, rejects duplicate paths and toggles only the supplied options', async () => {
  const relativePath = relative(process.cwd(), media);
  const added = await register({ path: `${relativePath}/../media/`, follow_symlinks: true });
  expect(added.statusCode).toBe(201);
  expect(added.json()).toEqual({
    id: 1,
    path: media,
    follow_symlinks: true,
    cross_filesystems: false,
    file_count: 0,
  });
  expect((await register()).statusCode).toBe(409);
  const nested = join(media, 'nested');
  await mkdir(nested);
  expect((await register({ path: nested, cross_filesystems: true })).statusCode).toBe(201);
  const changed = await patch(1, { cross_filesystems: true });
  expect(changed.statusCode).toBe(200);
  expect(changed.json()).toMatchObject({ follow_symlinks: true, cross_filesystems: true });
  expect(
    (await patch(1, { follow_symlinks: false, cross_filesystems: false })).json()
  ).toMatchObject({ follow_symlinks: false, cross_filesystems: false });
  expect((await list()).json().items).toHaveLength(2);
  expect((await patch(99, { follow_symlinks: true })).statusCode).toBe(404);
});

it('rejects malformed CRUD bodies/ids, non-directories and nonexistent paths without changing state', async () => {
  const file = join(media, 'not-directory.jpg');
  await writeFile(file, 'keep');
  for (const payload of [
    {},
    { path: '' },
    { path: '   ' },
    { path: 123 },
    { path: file },
    { path: join(media, 'missing') },
    { path: 'bad\0path' },
    { path: media, follow_symlinks: 'true' },
    { path: media, cross_filesystems: 1 },
    { path: media, unexpected: true },
  ]) {
    expect((await register(payload)).statusCode).toBe(400);
  }
  await register();
  for (const payload of [
    {},
    { path: file },
    { follow_symlinks: 'false' },
    { cross_filesystems: null },
    { other: true },
  ])
    expect((await patch(1, payload)).statusCode).toBe(400);
  for (const id of ['0', '-1', '1.5', 'abc', '9999999999999999']) {
    expect((await patch(id, { follow_symlinks: true })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/scan-dirs/${id}`, headers: { cookie } }))
        .statusCode
    ).toBe(400);
  }
  expect((await list()).json().items[0]).toMatchObject({ path: media, follow_symlinks: false });
});

it('counts files and deletes their database rows without touching any media or trash on disk', async () => {
  await writeFile(join(media, 'keep.jpg'), 'media content');
  await mkdir(join(media, '.vvv-trash'));
  await writeFile(join(media, '.vvv-trash/kept.jpg'), 'trash content');
  await register();
  await start();
  await vi.waitFor(async () => expect((await current()).json().status).toBe('done'));
  expect((await list()).json().items[0].file_count).toBe(1);
  const deleted = await app.inject({
    method: 'DELETE',
    url: '/api/scan-dirs/1',
    headers: { cookie },
  });
  expect(deleted.statusCode).toBe(204);
  expect(deleted.body).toBe('');
  expect(db.prepare('SELECT count(*) AS n FROM files').get()).toEqual({ n: 0 });
  expect((await list()).json()).toEqual({ items: [] });
  expect(await readFile(join(media, 'keep.jpg'), 'utf8')).toBe('media content');
  expect(await readFile(join(media, '.vvv-trash/kept.jpg'), 'utf8')).toBe('trash content');
  expect(
    (await app.inject({ method: 'DELETE', url: '/api/scan-dirs/1', headers: { cookie } }))
      .statusCode
  ).toBe(404);
});

it('paginates stored errors by file id, scopes to scan/status, caps page size and validates query input', async () => {
  const dir = (await register()).json<ScanDir>();
  db.exec("INSERT INTO scans(status) VALUES ('done'), ('done')");
  const put = db.prepare(
    "INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status,error,last_seen_scan_id) VALUES (?,?,'image',0,0,?,?,?)"
  );
  db.transaction(() => {
    put.run(dir.id, 'ok.jpg', 'done', null, 1);
    put.run(dir.id, 'other.jpg', 'error', 'other scan', 2);
    for (let i = 0; i < 503; i++) put.run(dir.id, `error-${i}.jpg`, 'error', `failed-${i}`, 1);
  })();
  const first = (await errors('?cursor=&limit=2')).json<ScanErrorsResponse>();
  expect(first).toEqual({
    items: [
      { file_id: 3, path: join(media, 'error-0.jpg'), error: 'failed-0' },
      { file_id: 4, path: join(media, 'error-1.jpg'), error: 'failed-1' },
    ],
    next_cursor: '4',
  });
  // Deleting an earlier row must not shift the next page as offset pagination would.
  db.prepare('DELETE FROM files WHERE id=3').run();
  const second = (await errors(`?cursor=${first.next_cursor}&limit=2`)).json<ScanErrorsResponse>();
  expect(second.items.map((item) => item.file_id)).toEqual([5, 6]);
  expect((await errors('?limit=999')).json().items).toHaveLength(500);
  expect((await errors()).json().items).toHaveLength(100);
  expect((await errors('?cursor=504&limit=2')).json()).toEqual({
    items: [{ file_id: 505, path: join(media, 'error-502.jpg'), error: 'failed-502' }],
    next_cursor: null,
  });
  expect((await errors('?cursor=505')).json()).toEqual({ items: [], next_cursor: null });
  for (const query of [
    '?cursor=-1',
    '?cursor=1.5',
    '?cursor=abc',
    '?cursor=9999999999999999',
    '?limit=0',
    '?limit=1000',
    '?limit=2.5',
    '?limit=',
    '?other=1',
    '?limit=1&limit=2',
  ])
    expect((await errors(query)).statusCode).toBe(400);
  expect((await errors('', 99)).statusCode).toBe(404);
  for (const path of ['/api/scans/abc/errors', '/api/scans/0/events', '/api/scans/99/events'])
    expect((await app.inject({ url: path, headers: { cookie } })).statusCode).toBe(
      path.endsWith('99/events') ? 404 : 400
    );
});

it('retrieves real traversal errors after completion and reopening the database', async () => {
  await symlink(join(media, 'missing'), join(media, 'broken.jpg'));
  await register({ path: media, follow_symlinks: true });
  await start();
  await vi.waitFor(async () => expect((await current()).json().status).toBe('done'));
  await app.close();
  app = await createServer({ ...config, dataDir: root }, false);
  expect((await errors()).json()).toEqual({
    items: [
      { file_id: 1, path: join(media, 'broken.jpg'), error: expect.stringContaining('ENOENT') },
    ],
    next_cursor: null,
  });
});

it('streams real scanner snapshots, cancellation and reconnect resync, and closes active SSE on shutdown', async () => {
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } })
        .png()
        .toFile(join(media, `${i}.png`))
    )
  );
  await register();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(hashing.processFile).mockImplementation(async (path) => {
    await blocked;
    return realHashing.processFile(path);
  });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  await start();
  let live: Awaited<ReturnType<typeof stream>>;
  try {
    await vi.waitFor(() => expect(hashing.processFile).toHaveBeenCalledTimes(4));
    live = await stream(address, 1);
    expect(live.response.statusCode).toBe(200);
    expect(live.response.headers['content-type']).toBe('text/event-stream');
    expect(live.response.headers['cache-control']).toBe('no-store');
    expect(live.response.headers['x-accel-buffering']).toBe('no');
    await vi.waitFor(() =>
      expect(live.snapshots()).toContainEqual({
        id: 1,
        status: 'running',
        started_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
        finished_at: null,
        discovered: 8,
        processed: 0,
        errors: 0,
        current_file: expect.any(String),
      })
    );
    expect(
      (await app.inject({ method: 'POST', url: '/api/scans/1/cancel', headers: { cookie } }))
        .statusCode
    ).toBe(202);
  } finally {
    release();
  }
  await vi.waitFor(() =>
    expect(live.snapshots().at(-1)).toEqual({
      id: 1,
      status: 'cancelled',
      started_at: expect.any(String),
      finished_at: expect.any(String),
      discovered: 8,
      processed: 4,
      errors: 0,
    })
  );
  live.response.destroy();
  const reconnected = await stream(address, 1, 'old-event-id');
  await vi.waitFor(() => expect(reconnected.snapshots()).toHaveLength(1));
  expect(reconnected.snapshots()[0]).toEqual((await current()).json());
  const saved = db.prepare('SELECT started_at,finished_at FROM scans WHERE id=1').get() as Pick<
    ScanProgress,
    'started_at' | 'finished_at'
  >;
  expect(reconnected.snapshots()[0]).toMatchObject(saved);
  db.exec("INSERT INTO scans(status) VALUES ('done')");
  const older = await stream(address, 1);
  await vi.waitFor(() => expect(older.snapshots()).toHaveLength(1));
  expect(older.snapshots()[0]).toEqual(reconnected.snapshots()[0]);
  await app.close();
  await vi.waitFor(() => expect(reconnected.response.destroyed).toBe(true));
});
