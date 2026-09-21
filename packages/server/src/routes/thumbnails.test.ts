import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDatabase } from '../db.js';
import { createServer } from '../server.js';
import * as video from '../video.js';

const config = { password: 'thumb-test-password', sessionSecret: 'thumb-test-session', port: 8080 };
let root: string;
let app: Awaited<ReturnType<typeof createServer>>;
let db: Database.Database;
let cookie: string;
let media: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vvv-thumbnails-'));
  media = join(root, 'media');
  await mkdir(media);
  app = await createServer({ ...config, dataDir: join(root, 'data') }, false);
  db = openDatabase(join(root, 'data')).db;
  db.prepare('INSERT INTO scan_dirs(path) VALUES (?)').run(media);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: config.password },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});
const get = (id: number | string) =>
  app.inject({ url: `/api/files/${id}/thumb`, headers: { cookie } });
const cache = (id: number) => join(root, 'data', 'thumbs', `${id}.jpg`);
function put(path = 'image.jpg', kind = 'image', status = 'done') {
  return Number(
    db
      .prepare(
        `INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status)
      VALUES (1,?,?,1,0,?)`
      )
      .run(path, kind, status).lastInsertRowid
  );
}
async function image(path = 'image.jpg', width = 640, height = 320, background = 'red') {
  await sharp({ create: { width, height, channels: 3, background } })
    .jpeg()
    .toFile(join(media, path));
}
function expectMissing(response: Awaited<ReturnType<typeof get>>) {
  expect(response.statusCode).toBe(404);
  expect(response.headers['content-type']).toContain('application/json');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toEqual({ error: 'thumbnail_not_found' });
}

it('creates the cache at boot and generates once for concurrent and later requests, including restart', async () => {
  expect((await stat(join(root, 'data', 'thumbs'))).isDirectory()).toBe(true);
  await image();
  const id = put();
  const encode = vi.spyOn(sharp.prototype, 'toBuffer');
  const results = await Promise.all(Array.from({ length: 8 }, () => get(id)));
  expect(encode).toHaveBeenCalledTimes(1);
  for (const response of results) {
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.headers['cache-control']).toBe('private, no-cache');
    expect(response.headers['cache-control']).not.toContain('immutable');
    expect(response.rawPayload).toEqual(results[0]!.rawPayload);
  }
  expect(await sharp(results[0]!.rawPayload).metadata()).toMatchObject({
    format: 'jpeg',
    width: 256,
    height: 128,
  });
  const before = await stat(cache(id), { bigint: true });
  expect(await readFile(cache(id))).toEqual(results[0]!.rawPayload);
  expect((await get(id)).rawPayload).toEqual(results[0]!.rawPayload);
  await app.close();
  app = await createServer({ ...config, dataDir: join(root, 'data') }, false);
  expect((await get(id)).rawPayload).toEqual(results[0]!.rawPayload);
  expect((await stat(cache(id), { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  expect(encode).toHaveBeenCalledTimes(1);
  expect(await readdir(join(root, 'data', 'thumbs'))).toEqual([`${id}.jpg`, `${id}.jpg.key`]);
});

it('does not enlarge small images and fits portrait images inside 256 pixels', async () => {
  for (const [width, height, expectedWidth, expectedHeight] of [
    [32, 16, 32, 16],
    [320, 640, 128, 256],
  ]) {
    const name = `${width}.jpg`;
    await image(name, width, height);
    const response = await get(put(name));
    expect(response.statusCode).toBe(200);
    expect(await sharp(response.rawPayload).metadata()).toMatchObject({
      width: expectedWidth,
      height: expectedHeight,
      format: 'jpeg',
    });
  }
});

it('rejects unauthenticated access before generating anything', async () => {
  await image();
  const id = put();
  const response = await app.inject(`/api/files/${id}/thumb`);
  expect(response.statusCode).toBe(401);
  expect(response.json()).toEqual({ error: 'unauthorized' });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(await readdir(join(root, 'data', 'thumbs'))).toEqual([]);
});

it('returns JSON 404 for unknown ids, missing videos, non-done files, and vanished cached sources', async () => {
  await image();
  expectMissing(await get(999));
  expectMissing(await get(put('video.mp4', 'video')));
  for (const status of ['pending', 'hashed', 'error', 'quarantined', 'missing'])
    expectMissing(await get(put(`${status}.jpg`, 'image', status)));
  expectMissing(await get(put('absent.jpg')));
  const id = put();
  expect((await get(id)).statusCode).toBe(200);
  db.prepare("UPDATE files SET status='quarantined' WHERE id=?").run(id);
  expectMissing(await get(id));
  db.prepare("UPDATE files SET status='done' WHERE id=?").run(id);
  await unlink(join(media, 'image.jpg'));
  expectMissing(await get(id));
});

it.each([new Error('spawn ffmpeg ENOENT'), new Error('EIO'), new video.VideoFailure('timeout')])(
  'logs video operational failures as 500: %s',
  async (error) => {
    await writeFile(join(media, 'video.mp4'), 'source');
    const id = put('video.mp4', 'video');
    db.prepare('UPDATE files SET duration_ms=2000 WHERE id=?').run(id);
    vi.spyOn(video, 'videoThumbnail').mockRejectedValue(error);
    const log = vi.spyOn(app.log, 'error');
    expect((await get(id)).statusCode).toBe(500);
    expect(log).toHaveBeenCalledWith(
      { file_id: String(id), err: error },
      'Thumbnail generation failed'
    );
  }
);

it('aborts in-flight thumbnail extraction before shutdown waits for requests', async () => {
  await writeFile(join(media, 'video.mp4'), 'source');
  const id = put('video.mp4', 'video');
  db.prepare('UPDATE files SET duration_ms=2000 WHERE id=?').run(id);
  let signal: AbortSignal | undefined;
  vi.spyOn(video, 'videoThumbnail').mockImplementation(async (_path, _duration, options) => {
    signal = options.signal;
    return new Promise<never>((_resolve, reject) =>
      signal!.addEventListener('abort', () => reject(new video.VideoFailure('cancelled')), {
        once: true,
      })
    );
  });
  const response = get(id).then((r) => r);
  await vi.waitFor(() => expect(signal).toBeDefined());
  await app.close();
  expect(signal!.aborted).toBe(true);
  expect((await response).statusCode).toBe(500);
});

it('validates ids without allowing paths in cache filenames', async () => {
  for (const id of ['0', '-1', '1.5', '01', 'abc', '9999999999999999'])
    expect((await get(id)).statusCode).toBe(400);
});

it('returns 404 for unsupported and corrupt media and retries successfully after repair', async () => {
  await writeFile(join(media, 'unsupported.jpg'), 'not an image');
  await writeFile(join(media, 'corrupt.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]));
  for (const name of ['unsupported.jpg', 'corrupt.jpg']) {
    const id = put(name);
    for (const response of await Promise.all([get(id), get(id)])) expectMissing(response);
    expect(await readdir(join(root, 'data', 'thumbs'))).not.toContain(`${id}.jpg`);
    await image(name);
    expect((await get(id)).statusCode).toBe(200);
  }
});

it.each(
  [
    ...['ENOENT', 'EACCES', 'EISDIR', 'EIO', 'EMFILE', 'ENOSPC', 'EFBIG'].map(
      (code) => `VipsJpeg: corrupt header\n${code}: source read failed`
    ),
    'VipsPng: out of memory',
    'VipsWebp: truncated input\nout-of-memory',
    'VipsTiff: resource exhaustion',
    'VipsGif: memory allocation failed',
    'VipsHeif: corrupt bitstream\nstd::bad_alloc',
    'VipsJp2k: invalid header\ntoo many open files',
    'VipsJpeg: corrupt header\nPermission denied',
    'VipsJpeg: failed to initialize',
    'pngload: read error',
    'VipsJpeg: unable to open /corrupt.jpg',
    'Input file is missing: /gone.jpg',
    'unrecognized native error',
  ].flatMap((message) => [message, `Input file has corrupt header: ${message}`])
)('logs native I/O, resource, and unknown errors as JSON 500: %s', async (message) => {
  await image();
  const id = put();
  const error = new Error(message);
  const log = vi.spyOn(app.log, 'error');
  const warn = vi.spyOn(app.log, 'warn');
  vi.spyOn(sharp.prototype, 'toBuffer').mockRejectedValueOnce(error);
  const response = await get(id);
  expect(response.statusCode).toBe(500);
  expect(response.json()).toEqual({ error: 'thumbnail_failed' });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(log).toHaveBeenCalledWith(
    { file_id: String(id), err: error },
    'Thumbnail generation failed'
  );
  expect(warn).not.toHaveBeenCalled();
  expect(await readdir(join(root, 'data', 'thumbs'))).toEqual([]);
});

it.each(
  [
    'Input file contains unsupported image format',
    'VipsJpeg: premature end of JPEG image',
    'VipsPng: truncated image',
    'VipsWebp: corrupt bitstream',
    'VipsTiff: invalid header',
    'VipsGif: unexpected end of file',
    'VipsHeif: invalid bitstream',
    'VipsJp2k: corrupted data',
    'pngload: CRC error',
    'gifload: truncated file',
    'webpload: corrupt header',
  ].flatMap((message) => [message, `Input file has corrupt header: ${message}`])
)('logs clear decoder content rejections as JSON 404: %s', async (message) => {
  await image();
  const id = put();
  const error = new Error(message);
  const warn = vi.spyOn(app.log, 'warn');
  const log = vi.spyOn(app.log, 'error');
  vi.spyOn(sharp.prototype, 'toBuffer').mockRejectedValueOnce(error);
  expectMissing(await get(id));
  expect(warn).toHaveBeenCalledWith(
    { file_id: String(id), err: error },
    'Thumbnail source is undecodable'
  );
  expect(log).not.toHaveBeenCalled();
  expect(await readdir(join(root, 'data', 'thumbs'))).toEqual([]);
});

it('logs unexpected native errors as JSON 500 and allows a later retry', async () => {
  await image();
  const id = put();
  const log = vi.spyOn(app.log, 'error');
  const encode = vi
    .spyOn(sharp.prototype, 'toBuffer')
    .mockRejectedValueOnce(new Error('native allocation failed'));
  const response = await get(id);
  expect(response.statusCode).toBe(500);
  expect(response.json()).toEqual({ error: 'thumbnail_failed' });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(log).toHaveBeenCalled();
  encode.mockRestore();
  expect((await get(id)).statusCode).toBe(200);
});

it('reports filesystem failures as logged JSON 500, removes temp files, and retries', async () => {
  await image();
  const id = put();
  const log = vi.spyOn(app.log, 'error');
  // A directory at the final filename forces rename failure after the temp write.
  await mkdir(cache(id));
  const response = await get(id);
  expect(response.statusCode).toBe(500);
  expect(response.json()).toEqual({ error: 'thumbnail_failed' });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(log).toHaveBeenCalled();
  expect(await readdir(join(root, 'data', 'thumbs'))).toEqual([`${id}.jpg`]);
  await rm(cache(id), { recursive: true });
  await chmod(join(media, 'image.jpg'), 0);
  try {
    expect((await get(id)).statusCode).toBe(500);
  } finally {
    await chmod(join(media, 'image.jpg'), 0o600);
  }
  expect((await get(id)).statusCode).toBe(200);
});

it('refreshes modified images and never serves a deleted directory cache for a reused file id', async () => {
  await image();
  const id = put();
  const first = await get(id);
  await image('image.jpg', 640, 320, 'blue');
  const changed = await get(id);
  expect(changed.statusCode).toBe(200);
  expect(changed.rawPayload).not.toEqual(first.rawPayload);
  expect(
    (await app.inject({ method: 'DELETE', url: '/api/scan-dirs/1', headers: { cookie } }))
      .statusCode
  ).toBe(204);
  expectMissing(await get(id));
  db.prepare('INSERT INTO scan_dirs(path) VALUES (?)').run(media);
  await image('replacement.jpg', 40, 20, 'green');
  expect(put('replacement.jpg')).toBe(id);
  const replacement = await get(id);
  expect(replacement.statusCode).toBe(200);
  expect(await sharp(replacement.rawPayload).metadata()).toMatchObject({ width: 40, height: 20 });
});

it('rechecks directory eligibility after generation was already in flight', async () => {
  await image();
  const id = put();
  const bytes = await sharp(join(media, 'image.jpg')).jpeg().toBuffer();
  let finish: (bytes: Buffer) => void = () => {};
  const encode = vi.spyOn(sharp.prototype, 'toBuffer').mockImplementationOnce(
    () =>
      new Promise<Buffer>((resolve) => {
        finish = resolve;
      })
  );
  const response = get(id).then((value) => value);
  await vi.waitFor(() => expect(encode).toHaveBeenCalledTimes(1));
  expect(
    (await app.inject({ method: 'DELETE', url: '/api/scan-dirs/1', headers: { cookie } }))
      .statusCode
  ).toBe(204);
  finish(bytes);
  expectMissing(await response);
});
