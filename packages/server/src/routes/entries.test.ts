import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DirectoryEntries } from '@vvv/shared';
import { createServer } from '../server.js';
import { openDatabase } from '../db.js';
import * as hashing from '../hashing.js';
import * as video from '../video.js';

vi.mock('node:fs/promises', { spy: true });
vi.mock('../hashing.js', { spy: true });
vi.mock('../video.js', async (importOriginal) => {
  const original = await importOriginal<typeof video>();
  return { ...original, videoHash: vi.fn(original.videoHash) };
});
const realFs = await vi.importActual<typeof fs>('node:fs/promises');
let root: string;
let media: string;
let cookie: string;
let app: Awaited<ReturnType<typeof createServer>>;
let db: ReturnType<typeof openDatabase>['db'];
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(fs.lstat).mockImplementation(realFs.lstat);
  vi.mocked(fs.stat).mockImplementation(realFs.stat);
  vi.mocked(fs.opendir).mockImplementation(realFs.opendir);
  root = await realFs.realpath(await mkdtemp(join(tmpdir(), 'vvv-entries-')));
  media = join(root, 'media');
  await mkdir(media);
  app = await createServer(
    { password: 'preview-test', sessionSecret: 'preview-test', dataDir: root, port: 8080 },
    false
  );
  db = openDatabase(root).db;
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'preview-test' },
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
const list = (query: Record<string, string> = {}, id = 1) =>
  app.inject({
    url: `/api/scan-dirs/${id}/entries?${new URLSearchParams(query)}`,
    headers: { cookie },
  });
const page = async (query: Record<string, string> = {}) => {
  const response = await list(query);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return response.json<DirectoryEntries>();
};
const policy = (follow = false, cross = false) =>
  db
    .prepare('UPDATE scan_dirs SET follow_symlinks=?,cross_filesystems=? WHERE id=1')
    .run(Number(follow), Number(cross));
const put = async (path: string, contents = 'unchanged') => {
  await mkdir(join(media, path, '..'), { recursive: true });
  await writeFile(join(media, path), contents);
};

it('authenticates before validation; rejects unknown roots and malformed query inputs', async () => {
  expect((await app.inject({ url: '/api/scan-dirs/no/entries?path=/etc' })).statusCode).toBe(401);
  expect((await list({}, 999)).statusCode).toBe(404);
  const invalid: Record<string, string>[] = [
    { limit: '0' },
    { limit: '-1' },
    { limit: '1.5' },
    { filter: 'images' },
    { unknown: '1' },
    { cursor: 'broken' },
  ];
  for (const query of invalid) expect((await list(query)).statusCode).toBe(400);
  expect(
    (await app.inject({ url: '/api/scan-dirs/1/entries?limit=1&limit=2', headers: { cookie } }))
      .statusCode
  ).toBe(400);
});

it.each([
  '/etc',
  '../',
  '../../..',
  'nested/../../outside',
  '\0bad',
  'C:\\media',
  '\\\\server\\share',
])('rejects unsafe path %j', async (path) => {
  vi.mocked(fs.opendir).mockClear();
  const response = await list({ path });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: 'invalid_preview_path' });
  expect(fs.opendir).not.toHaveBeenCalled();
});

it('uses scanner allowlists, folder-first stable names, filters, metadata sizes and never processes content', async () => {
  const images = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'tiff', 'avif'];
  const videos = [
    'mp4',
    'mkv',
    'avi',
    'mov',
    'webm',
    'm4v',
    'mpg',
    'mpeg',
    'ts',
    'm2ts',
    'wmv',
    'flv',
  ];
  await mkdir(join(media, 'z-folder'));
  for (const extension of [...images, ...videos, 'txt', 'bmp', 'heic'])
    await put(`file.${extension.toUpperCase()}`);
  const names = await page({ filter: 'all' });
  expect(names.items[0]).toEqual({
    name: 'z-folder',
    type: 'folder',
    kind: 'folder',
    size: null,
    decision: 'folder',
  });
  for (const extension of [...images, ...videos])
    expect(names.items).toContainEqual({
      name: `file.${extension.toUpperCase()}`,
      type: 'file',
      kind: images.includes(extension) ? 'image' : 'video',
      size: 9,
      decision: 'would_process',
    });
  for (const extension of ['TXT', 'BMP', 'HEIC'])
    expect(names.items).toContainEqual({
      name: `file.${extension}`,
      type: 'file',
      kind: 'other',
      size: 9,
      decision: 'unsupported_type',
    });
  expect(names.items.slice(1).map((item) => item.name)).toEqual(
    names.items
      .slice(1)
      .map((item) => item.name)
      .sort()
  );
  expect((await page()).items).toHaveLength(images.length + videos.length + 1);
  expect(hashing.processFile).not.toHaveBeenCalled();
  expect(hashing.imageHash).not.toHaveBeenCalled();
  expect(video.videoHash).not.toHaveBeenCalled();
  expect(db.prepare('SELECT count(*) AS n FROM scans').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT count(*) AS n FROM files').get()).toEqual({ n: 0 });
});

it('navigates and normalizes relative paths without exposing trash, including followed aliases', async () => {
  await put('folder/sub/a.jpg');
  await put('.vvv-trash/a.jpg');
  await put('folder/.vvv-trash/b.jpg');
  await symlink(join(media, '.vvv-trash'), join(media, 'trash-alias'));
  await symlink(join(media, '.vvv-trash/a.jpg'), join(media, 'alias.jpg'));
  policy(true);
  expect((await page({ filter: 'all' })).items.map((item) => item.name)).toEqual(['folder']);
  expect((await page({ path: 'folder' })).items.map((item) => item.name)).toEqual(['sub']);
  expect((await page({ path: './folder/../folder/sub/' })).path).toBe('folder/sub');
  for (const path of ['.vvv-trash', 'folder/.vvv-trash', '.vvv-trash/../folder', 'trash-alias'])
    expect((await list({ path })).statusCode).toBe(403);
});

it('does not follow disabled links; reports escapes and never opens escaped descendants even when following', async () => {
  await mkdir(join(root, 'outside/sub'), { recursive: true });
  await writeFile(join(root, 'outside/secret.jpg'), 'private');
  await put('inside/sub/local.jpg');
  await symlink(join(root, 'outside'), join(media, 'outside-link'));
  await symlink(join(root, 'outside/secret.jpg'), join(media, 'escaped.jpg'));
  await symlink(join(media, 'inside'), join(media, 'inside-link'));
  await symlink(join(media, 'missing'), join(media, 'broken.jpg'));
  vi.mocked(fs.stat).mockClear();
  vi.mocked(fs.realpath).mockClear();
  const disabled = await page();
  expect(disabled.items.filter((item) => item.type === 'symlink')).toHaveLength(4);
  expect(
    disabled.items
      .filter((item) => item.type === 'symlink')
      .every((item) => item.decision === 'symlink_not_followed')
  ).toBe(true);
  expect(fs.stat).not.toHaveBeenCalled();
  expect(fs.realpath).toHaveBeenCalledTimes(1); // Only the registered root.
  expect((await list({ path: 'inside-link/sub' })).statusCode).toBe(403);
  policy(true);
  vi.mocked(fs.opendir).mockClear();
  for (const path of ['outside-link', 'outside-link/sub'])
    expect((await list({ path })).statusCode).toBe(403);
  expect(fs.opendir).not.toHaveBeenCalled();
  const followed = await page();
  expect(followed.items.find((item) => item.name === 'escaped.jpg')).toMatchObject({
    type: 'symlink',
    decision: 'other',
    size: null,
    decision_detail: 'Symlink target is outside the registered directory.',
  });
  expect(followed.items.find((item) => item.name === 'inside-link')).toMatchObject({
    type: 'symlink',
    kind: 'folder',
    decision: 'folder',
  });
  expect(followed.items.find((item) => item.name === 'broken.jpg')).toMatchObject({
    decision: 'other',
  });
  expect((await page({ path: 'inside-link/sub' })).items.map((item) => item.name)).toEqual([
    'local.jpg',
  ]);
  expect(JSON.stringify(followed)).not.toContain(join(root, 'outside'));
});

it.each([false, true])(
  'enforces device boundaries for directories, files, and followed links (cross=%s)',
  async (cross) => {
    await put('mounted/sub/local.jpg');
    await put('remote.jpg');
    await symlink(join(media, 'remote.jpg'), join(media, 'link.jpg'));
    vi.mocked(fs.lstat).mockImplementation(async (path, options) => {
      const info = await realFs.lstat(path, options);
      if (String(path).includes('/mounted') || String(path) === join(media, 'remote.jpg'))
        Object.defineProperty(info, 'dev', { value: BigInt(info.dev) + 1n });
      return info;
    });
    vi.mocked(fs.stat).mockImplementation(async (path, options) => {
      const info = await realFs.stat(path, options);
      if (String(path) === join(media, 'remote.jpg'))
        Object.defineProperty(info, 'dev', { value: BigInt(info.dev) + 1n });
      return info;
    });
    policy(true, cross);
    const result = await page();
    expect(result.items.map((item) => item.decision)).toEqual(
      cross
        ? ['folder', 'would_process', 'would_process']
        : ['filesystem_boundary', 'filesystem_boundary', 'filesystem_boundary']
    );
    expect((await list({ path: 'mounted/sub' })).statusCode).toBe(cross ? 200 : 403);
    policy(false, cross);
    expect((await page()).items.find((item) => item.name === 'link.jpg')?.decision).toBe(
      'symlink_not_followed'
    );
  }
);

it('reports lstat/stat permission failures and unreadable requested directories without leaking paths', async () => {
  await put('denied.jpg');
  await put('folder/a.jpg');
  await put('target.jpg');
  await symlink(join(media, 'target.jpg'), join(media, 'link.jpg'));
  policy(true);
  vi.mocked(fs.lstat).mockImplementation(async (path, options) => {
    if (String(path).endsWith('/denied.jpg'))
      throw Object.assign(new Error('private server path'), { code: 'EACCES' });
    return realFs.lstat(path, options);
  });
  vi.mocked(fs.stat).mockRejectedValue(
    Object.assign(new Error('private server path'), { code: 'EPERM' })
  );
  const result = await page();
  for (const name of ['denied.jpg', 'link.jpg'])
    expect(result.items.find((item) => item.name === name)).toMatchObject({
      decision: 'permission_denied',
      size: null,
    });
  vi.mocked(fs.opendir).mockRejectedValue(
    Object.assign(new Error('private server path'), { code: 'EACCES' })
  );
  const denied = await list({ path: 'folder' });
  expect(denied.statusCode).toBe(403);
  expect(denied.json()).toEqual({ error: 'permission_denied' });
});

it('pages by class/name without duplicates, binds cursors to context, and tolerates removed earlier entries', async () => {
  for (const name of ['z-dir', 'a-dir']) await mkdir(join(media, name));
  for (const name of ['b.jpg', 'a.jpg', 'c.txt']) await put(name);
  const first = await page({ limit: '2', filter: 'all' });
  expect(first.items.map((item) => item.name)).toEqual(['a-dir', 'z-dir']);
  expect(first.has_more).toBe(true);
  const cursor = first.next_cursor ?? '';
  expect((await list({ cursor, filter: 'media' })).statusCode).toBe(400);
  expect((await list({ cursor, filter: 'all', path: 'z-dir' })).statusCode).toBe(400);
  const second = await page({ cursor, limit: '2', filter: 'all' });
  expect(second.items.map((item) => item.name)).toEqual(['a.jpg', 'b.jpg']);
  await unlink(join(media, 'a.jpg'));
  const last = await page({ cursor: second.next_cursor ?? '', limit: '2', filter: 'all' });
  expect(last).toEqual({
    path: '',
    items: [{ name: 'c.txt', type: 'file', kind: 'other', size: 9, decision: 'unsupported_type' }],
    next_cursor: null,
    has_more: false,
  });
  policy(true);
  expect((await list({ cursor, filter: 'all' })).statusCode).toBe(400);
});

it('uses async directory iteration and caps responses for 1,205 entries without recursive totals', async () => {
  for (let i = 1204; i >= 0; i--) await put(`${String(i).padStart(4, '0')}.jpg`);
  vi.mocked(fs.readdir).mockClear();
  const first = await page({ limit: '999' });
  expect(first.items).toHaveLength(100);
  expect(first.items[0]?.name).toBe('0000.jpg');
  expect(first.items.at(-1)?.name).toBe('0099.jpg');
  const second = await page({ cursor: first.next_cursor ?? '', limit: '100' });
  expect(second.items[0]?.name).toBe('0100.jpg');
  expect(second.items).toHaveLength(100);
  expect((await page()).items).toHaveLength(50);
  expect(fs.readdir).not.toHaveBeenCalled();
  expect(fs.opendir).toHaveBeenCalled();
});

it('returns honest empty and missing-directory states and honors root symlink policy', async () => {
  expect(await page({ filter: 'all' })).toEqual({
    path: '',
    items: [],
    has_more: false,
    next_cursor: null,
  });
  expect((await list({ path: 'gone' })).statusCode).toBe(403);
  const alias = join(root, 'alias');
  await symlink(media, alias);
  db.prepare('UPDATE scan_dirs SET path=? WHERE id=1').run(alias);
  expect((await list()).json()).toEqual({ error: 'symlink_not_followed' });
  policy(true);
  expect((await page()).items).toEqual([]);
});
