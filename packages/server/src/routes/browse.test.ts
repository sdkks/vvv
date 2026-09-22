import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowseResponse } from '@vvv/shared';
import { createServer } from '../server.js';
import { openDatabase } from '../db.js';

vi.mock('node:fs/promises', { spy: true });
const realFs = await vi.importActual<typeof fs>('node:fs/promises');
let root: string;
let media: string;
let cookie: string;
let app: Awaited<ReturnType<typeof createServer>>;
let db: ReturnType<typeof openDatabase>['db'];
beforeEach(async () => {
  vi.mocked(fs.stat).mockImplementation(realFs.stat);
  vi.mocked(fs.opendir).mockImplementation(realFs.opendir);
  root = await realFs.realpath(await fs.mkdtemp(join(tmpdir(), 'vvv-browse-')));
  media = join(root, 'media');
  await fs.mkdir(media);
  app = await createServer(
    { password: 'browse-test', sessionSecret: 'browse-test', dataDir: root, port: 8080 },
    false
  );
  db = openDatabase(root).db;
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'browse-test' },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
});
afterEach(async () => {
  await app.close();
  db.close();
  await fs.rm(root, { recursive: true, force: true });
});
const list = (query: Record<string, string> = {}) =>
  app.inject({
    url: `/api/browse?${new URLSearchParams(query)}`,
    headers: { cookie },
  });
async function page(query: Record<string, string> = { path: media }) {
  const response = await list(query);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return response.json<BrowseResponse>();
}

it('authenticates before validation and rejects relative, NUL, and malformed queries', async () => {
  expect((await app.inject({ url: '/api/browse?path=relative' })).statusCode).toBe(401);
  for (const path of ['', 'relative', '../media', 'C:\\media', '/media\0']) {
    expect((await list({ path })).statusCode).toBe(400);
  }
  const invalid: Record<string, string>[] = [
    { limit: '0' },
    { limit: '1.5' },
    { cursor: 'broken' },
    { other: '1' },
  ];
  for (const query of invalid) {
    expect((await list({ path: media, ...query })).statusCode).toBe(400);
  }
  expect(
    (await app.inject({ url: '/api/browse?limit=1&limit=2', headers: { cookie } })).statusCode
  ).toBe(400);
});

it('lists only folders with sorted names, keeps folder-link paths, and never reads file content', async () => {
  await fs.mkdir(join(media, 'z-last'));
  await fs.mkdir(join(media, 'a-first'));
  await fs.mkdir(join(root, 'outside'));
  await fs.writeFile(join(media, 'image.jpg'), 'unchanged');
  await fs.writeFile(join(media, 'video.mp4'), 'unchanged');
  await fs.symlink(join(root, 'outside'), join(media, 'linked-folder'));
  await fs.symlink(join(media, 'image.jpg'), join(media, 'linked-file'));
  await fs.symlink(join(media, 'missing'), join(media, 'broken'));
  vi.clearAllMocks();
  const result = await page();
  expect(result).toEqual({
    path: media,
    items: ['a-first', 'linked-folder', 'z-last'].map((name) => ({
      name,
      path: join(media, name),
    })),
    next_cursor: null,
  });
  expect(fs.readFile).not.toHaveBeenCalled();
  expect(fs.readdir).not.toHaveBeenCalled();
  expect(fs.stat).toHaveBeenCalledTimes(3); // Only symlinks need target metadata.
  expect(fs.opendir).toHaveBeenCalledExactlyOnceWith(media);
  expect(db.prepare('SELECT count(*) AS n FROM files').get()).toEqual({ n: 0 });
  expect((await page({ path: join(media, 'linked-folder') })).path).toBe(
    join(media, 'linked-folder')
  );
});

it('normalizes absolute dot segments and reports missing or non-directory paths as 404', async () => {
  expect((await page({ path: `${media}/../media//./` })).path).toBe(resolve(media));
  await fs.writeFile(join(media, 'file'), 'data');
  for (const path of [join(media, 'gone'), join(media, 'file')]) {
    const response = await list({ path });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'directory_unavailable' });
  }
  vi.mocked(fs.opendir).mockRejectedValueOnce(
    Object.assign(new Error('private detail'), { code: 'EACCES' })
  );
  const denied = await list({ path: media });
  expect(denied.statusCode).toBe(403);
  expect(denied.json()).toEqual({ error: 'permission_denied' });
});

it('defaults to the first registered path and does not silently replace a missing registered path', async () => {
  db.prepare('INSERT INTO scan_dirs(path) VALUES (?)').run(media);
  db.prepare('INSERT INTO scan_dirs(path) VALUES (?)').run(root);
  expect((await page({})).path).toBe(media);
  await fs.rmdir(media);
  expect((await list()).statusCode).toBe(404);
});

it.each([true, false])(
  'defaults to /media if it is a directory, otherwise / (available=%s)',
  async (available) => {
    vi.mocked(fs.stat).mockImplementation(async (path, options) =>
      realFs.stat(
        String(path) === '/media' ? (available ? media : join(media, 'missing')) : path,
        options
      )
    );
    vi.mocked(fs.opendir).mockImplementation(async (path, options) =>
      realFs.opendir(String(path) === '/media' ? media : path, options)
    );
    expect((await page({})).path).toBe(available ? '/media' : '/');
  }
);

it('caps pages at 100 and pages by name without duplicates despite earlier entries disappearing', async () => {
  for (let i = 204; i >= 0; i--) await fs.mkdir(join(media, String(i).padStart(3, '0')));
  const first = await page();
  expect(first.items).toHaveLength(100);
  expect(first.items[0]?.name).toBe('000');
  expect(first.items.at(-1)?.name).toBe('099');
  expect((await page({ path: media, limit: '999' })).items).toEqual(first.items);
  expect((await list({ path: root, cursor: first.next_cursor ?? '' })).statusCode).toBe(400);
  await fs.rmdir(join(media, '000'));
  const second = await page({ path: media, cursor: first.next_cursor ?? '' });
  expect(second.items.map((item) => item.name)).toEqual(
    Array.from({ length: 100 }, (_, i) => String(i + 100))
  );
  const last = await page({ path: media, cursor: second.next_cursor ?? '' });
  expect(last.items.map((item) => item.name)).toEqual(['200', '201', '202', '203', '204']);
  expect(last.next_cursor).toBeNull();
  expect((await page({ path: join(media, '001') })).items).toEqual([]);
});
