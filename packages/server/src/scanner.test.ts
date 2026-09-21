import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import Fastify from 'fastify';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDatabase } from './db.js';
import { Scanner } from './scanner.js';
import { Quarantine } from './quarantine.js';
import * as hashing from './hashing.js';
import * as video from './video.js';

vi.mock('./hashing.js', { spy: true });
vi.mock('./video.js', async (importOriginal) => {
  const original = await importOriginal<typeof video>();
  return { ...original, videoHash: vi.fn(original.videoHash) };
});
vi.mock('node:fs/promises', { spy: true });
const realFs = await vi.importActual<typeof fs>('node:fs/promises');
const realHashing = await vi.importActual<typeof hashing>('./hashing.js');
let directory: string;
let media: string;
let db: ReturnType<typeof openDatabase>['db'];
let scanner: Scanner;
const log = Fastify({ logger: false }).log;
const hash = vi.mocked(hashing.processFile);
const seed = (path = media, follow = 0, cross = 0) =>
  db
    .prepare('INSERT INTO scan_dirs(path,follow_symlinks,cross_filesystems) VALUES (?,?,?)')
    .run(path, follow, cross);
const files = () =>
  db
    .prepare(
      'SELECT rel_path,kind,status,sha256,error,last_seen_scan_id FROM files ORDER BY rel_path'
    )
    .all();
async function put(path: string, body = path) {
  const full = join(media, path);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, body);
  return full;
}
async function finished(status = 'done') {
  await vi.waitFor(() => expect(scanner.current()?.status).toBe(status), {
    timeout: 5000,
    interval: 10,
  });
}
async function scan() {
  expect(scanner.start()).not.toBeNull();
  await finished();
}

beforeEach(async () => {
  vi.clearAllMocks();
  hash.mockImplementation(realHashing.processFile);
  // Traversal tests use text files; real image decoding is covered separately below.
  vi.mocked(hashing.imageHash).mockResolvedValue({ hash: Buffer.alloc(8), width: 9, height: 8 });
  vi.mocked(video.videoHash).mockResolvedValue({
    hashes: Array.from({ length: 9 }, () => Buffer.alloc(8)),
    width: 320,
    height: 240,
    duration: 2,
    duration_ms: 2000,
  });
  vi.mocked(fs.lstat).mockImplementation(realFs.lstat);
  directory = await mkdtemp(join(tmpdir(), 'vvv-scanner-'));
  media = join(directory, 'media');
  await mkdir(media);
  db = openDatabase(directory).db;
  scanner = new Scanner(db, log);
});
afterEach(async () => {
  await scanner.close();
  db.close();
  await rm(directory, { recursive: true, force: true });
});

it('discovers allowlisted images/videos in multiple roots, streams SHA-256, and excludes other types', async () => {
  expect(scanner.current()).toBeNull();
  seed();
  const allowed = [
    'a.JPG',
    'b.jpeg',
    'c.png',
    'd.gif',
    'e.webp',
    'f.tiff',
    'g.avif',
    'nested/a.mp4',
    'b.mkv',
    'c.avi',
    'd.mov',
    'e.webm',
    'f.m4v',
    'g.mpg',
    'h.mpeg',
    'i.ts',
    'j.m2ts',
    'k.wmv',
    'l.flv',
  ];
  await Promise.all(
    [...allowed, 'text.txt', 'unsupported.bmp', 'unsupported.heic'].map((path) => put(path))
  );
  const other = join(directory, 'other');
  await mkdir(other);
  await writeFile(join(other, 'duplicate.jpg'), 'a.JPG');
  seed(other);
  await scan();
  expect(files()).toHaveLength(allowed.length + 1);
  expect(hash).toHaveBeenCalledTimes(allowed.length + 1);
  const sha = createHash('sha256').update('a.JPG').digest('hex');
  expect(files()).toContainEqual(
    expect.objectContaining({ rel_path: 'a.JPG', kind: 'image', status: 'done', sha256: sha })
  );
  expect(files()).toContainEqual(
    expect.objectContaining({ rel_path: 'duplicate.jpg', status: 'done', sha256: sha })
  );
  expect(files()).toContainEqual(
    expect.objectContaining({ rel_path: 'nested/a.mp4', kind: 'video', status: 'done' })
  );
  expect(scanner.current()).toEqual({
    id: 1,
    status: 'done',
    started_at: expect.any(String),
    finished_at: expect.any(String),
    discovered: allowed.length + 1,
    processed: allowed.length + 1,
    errors: 0,
  });
});

it.each([0, 1])(
  'follows directory/file symlinks only when enabled (%s) and terminates ancestor loops',
  async (follow) => {
    seed(media, follow);
    await put('local.jpg');
    const external = join(directory, 'external');
    await mkdir(external);
    await writeFile(join(external, 'external.mp4'), 'video');
    await symlink(external, join(media, 'linked-dir'));
    await symlink(join(external, 'external.mp4'), join(media, 'linked.mp4'));
    await symlink(media, join(external, 'loop'));
    await symlink(media, join(media, 'self'));
    await scan();
    expect(files().map((file) => (file as { rel_path: string }).rel_path)).toEqual(
      follow ? ['linked-dir/external.mp4', 'linked.mp4', 'local.jpg'] : ['local.jpg']
    );
  }
);

it.each([0, 1])('honors the follow flag for a symlink scan root (%s)', async (follow) => {
  await put('a.jpg');
  const linked = join(directory, 'linked-root');
  await symlink(media, linked);
  seed(linked, follow);
  await scan();
  expect(files()).toHaveLength(follow ? 1 : 0);
});

it('ignores broken non-media symlinks when following links', async () => {
  seed(media, 1);
  await put('good.jpg');
  await symlink(join(media, 'not-here'), join(media, 'junk-link'));
  await scan();
  expect(scanner.current()).toMatchObject({
    status: 'done',
    discovered: 1,
    processed: 1,
    errors: 0,
  });
  expect(files()).toEqual([expect.objectContaining({ rel_path: 'good.jpg', status: 'done' })]);
});

it.each([0, 1])(
  'prunes trash directories, aliases, nested trash and trash roots (%s)',
  async (follow) => {
    seed(media, follow);
    await put('keep.jpg');
    await put('.vvv-trash/hidden.jpg');
    await put('nested/.vvv-trash/hidden.mp4');
    await symlink(join(media, '.vvv-trash'), join(media, 'trash-alias'));
    await symlink(join(media, '.vvv-trash/hidden.jpg'), join(media, 'hidden-alias.jpg'));
    seed(join(media, '.vvv-trash'), follow);
    await scan();
    expect(files()).toEqual([expect.objectContaining({ rel_path: 'keep.jpg' })]);
  }
);

it.each([0, 1])('honors device boundaries for child directories and files (%s)', async (cross) => {
  seed(media, 0, cross);
  await put('local.jpg');
  const boundary = await put('mounted/remote.jpg');
  const remoteFile = await put('remote.mp4');
  // A deterministic st_dev seam exercises the real walk without requiring mount privileges.
  vi.mocked(fs.lstat).mockImplementation(async (path, options) => {
    const info = await realFs.lstat(path, options);
    if (
      String(path) === join(media, 'mounted') ||
      String(path) === boundary ||
      String(path) === remoteFile
    )
      Object.defineProperty(info, 'dev', { value: BigInt(info.dev) + 1n });
    return info;
  });
  await scan();
  expect(files()).toHaveLength(cross ? 3 : 1);
  expect(hash).toHaveBeenCalledTimes(cross ? 3 : 1);
});

it('skips unchanged done files using exact bigint nanosecond timestamps, but retries changes and errors', async () => {
  seed();
  const path = await put('a.jpg', 'same size');
  const stamp = (await stat(path, { bigint: true })).mtimeNs;
  expect(stamp).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  await scan();
  expect(db.prepare('SELECT mtime_ns FROM files').safeIntegers().get()).toEqual({
    mtime_ns: stamp,
  });
  hash.mockClear();
  await scan();
  expect(hash).not.toHaveBeenCalled();
  expect(scanner.current()).toMatchObject({ discovered: 1, processed: 1 });
  // A single-nanosecond difference must not be rounded away by SQLite reads.
  db.prepare('UPDATE files SET mtime_ns=?').run(stamp - 1n);
  await scan();
  expect(hash).toHaveBeenCalledTimes(1);
  await writeFile(path, 'a larger replacement');
  await scan();
  expect(hash).toHaveBeenCalledTimes(2);
  db.exec("UPDATE files SET status='error',error='old failure'");
  await scan();
  expect(hash).toHaveBeenCalledTimes(2);
  expect(files()).toEqual([
    expect.objectContaining({ status: 'done', error: null, last_seen_scan_id: 5 }),
  ]);
});

it('marks unseen files missing in bounded batches, leaves quarantined rows alone, and rediscovers returns', async () => {
  seed();
  await put('gone.jpg');
  await put('keep.jpg');
  await scan();
  await unlink(join(media, 'gone.jpg'));
  const insert = db.prepare(
    "INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status) VALUES (1,?,'image',0,0,?)"
  );
  db.transaction(() => {
    for (let i = 0; i < 205; i++) insert.run(`old-${i}.jpg`, 'pending');
    insert.run('quarantined.jpg', 'quarantined');
  })();
  hash.mockClear();
  await scan();
  expect(db.prepare("SELECT count(*) AS n FROM files WHERE status='missing'").get()).toEqual({
    n: 206,
  });
  expect(db.prepare("SELECT status FROM files WHERE rel_path='quarantined.jpg'").get()).toEqual({
    status: 'quarantined',
  });
  expect(hash).not.toHaveBeenCalled();
  await put('gone.jpg');
  await scan();
  expect(hash).toHaveBeenCalledTimes(1);
  expect(files()).toContainEqual(
    expect.objectContaining({ rel_path: 'gone.jpg', status: 'done', last_seen_scan_id: 3 })
  );
});

it('skips and logs replacement files at quarantined paths without corrupting trash identity', async () => {
  seed();
  await put('original.jpg', 'original');
  await scan();
  const quarantine = new Quarantine(db, log);
  const moved = await quarantine.change('quarantine', 1);
  const before = db.prepare('SELECT * FROM files').get();
  await put('original.jpg', 'replacement with a different size');
  hash.mockClear();
  const info = vi.spyOn(log, 'info');
  try {
    await scan();
    expect(hash).not.toHaveBeenCalled();
    expect(db.prepare('SELECT * FROM files').get()).toEqual(before);
    expect(db.prepare('SELECT file_id,restored FROM trash WHERE id=?').get(moved.trash_id)).toEqual(
      { file_id: 1, restored: 0 }
    );
    expect(info).toHaveBeenCalledWith(
      { scan_dir_id: 1, path: 'original.jpg' },
      'Skipped quarantined path'
    );
    await expect(quarantine.change('restore', moved.trash_id)).rejects.toThrow(
      'destination_exists'
    );
  } finally {
    info.mockRestore();
  }
});

it('does not rediscover or sweep paths with an unsettled filesystem intent', async () => {
  seed();
  await put('present.jpg');
  await put('moved.jpg');
  await scan();
  const before = files();
  db.prepare(
    `INSERT INTO file_operations(kind,file_id,src_path,status)
    SELECT 'quarantine',id,? || rel_path,'pending' FROM files`
  ).run(media + '/');
  await unlink(join(media, 'moved.jpg'));
  await put('present.jpg', 'changed');
  hash.mockClear();
  await scan();
  expect(hash).not.toHaveBeenCalled();
  expect(files()).toEqual(before);
});

it('recovers interrupted scans and hashed files on reopen without rehashing completed work', async () => {
  seed();
  await put('done.jpg');
  await put('hashed.mp4');
  await put('pending.jpg');
  await scan();
  await scanner.close();
  db.exec(
    "UPDATE scans SET status='running',finished_at=NULL; UPDATE files SET status='hashed' WHERE rel_path='hashed.mp4'; UPDATE files SET status='pending',sha256=NULL WHERE rel_path='pending.jpg'"
  );
  db.close();
  db = openDatabase(directory).db;
  scanner = new Scanner(db, log);
  expect(scanner.current()).toMatchObject({ status: 'interrupted' });
  expect(db.prepare("SELECT status FROM files WHERE rel_path='hashed.mp4'").get()).toEqual({
    status: 'hashed',
  });
  expect(db.prepare('SELECT finished_at FROM scans').get()).toEqual({
    finished_at: expect.any(String),
  });
  hash.mockClear();
  await scan();
  expect(hash.mock.calls.map(([path]) => basename(path)).sort()).toEqual(['pending.jpg']);
  expect(files().every((file) => (file as { status: string }).status === 'done')).toBe(true);
});

it('records per-file stat and read failures, continues, and retries successfully on the next scan', async () => {
  seed(media, 1);
  await put('good.jpg');
  await put('unreadable.mp4');
  await symlink(join(media, 'not-here'), join(media, 'broken.jpg'));
  hash.mockImplementation(async (path) => {
    if (basename(path) === 'unreadable.mp4') throw new Error('EACCES: test read failure');
    return realHashing.processFile(path);
  });
  await scan();
  expect(scanner.current()).toMatchObject({ discovered: 3, processed: 3, errors: 2 });
  expect(files()).toEqual([
    expect.objectContaining({
      rel_path: 'broken.jpg',
      status: 'error',
      error: expect.stringContaining('ENOENT'),
    }),
    expect.objectContaining({ rel_path: 'good.jpg', status: 'done', error: null }),
    expect.objectContaining({
      rel_path: 'unreadable.mp4',
      status: 'error',
      error: 'EACCES: test read failure',
    }),
  ]);
  await put('not-here');
  hash.mockImplementation(realHashing.processFile);
  await scan();
  expect(scanner.current()).toMatchObject({ discovered: 3, processed: 3, errors: 0 });
});

it('interrupts an incomplete directory walk without incorrectly sweeping existing files missing', async () => {
  seed();
  await put('good.jpg');
  await scan();
  await rm(media, { recursive: true });
  await scanInterrupted();
  expect(files()).toEqual([expect.objectContaining({ status: 'done' })]);
});
async function scanInterrupted() {
  expect(scanner.start()).not.toBeNull();
  await finished('interrupted');
}

it('bounds hashing to four workers and cancels between files, preserving pending work for the next scan', async () => {
  seed();
  await Promise.all(Array.from({ length: 9 }, (_, i) => put(`${i}.jpg`)));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let maximum = 0;
  hash.mockImplementation(async (path) => {
    maximum = Math.max(maximum, ++active);
    await blocked;
    const sha = await realHashing.processFile(path);
    active--;
    return sha;
  });
  const id = scanner.start();
  try {
    expect(scanner.start()).toBeNull();
    await vi.waitFor(() => expect(hash).toHaveBeenCalledTimes(4));
    expect(scanner.current()).toMatchObject({
      status: 'running',
      current_file: expect.any(String),
    });
    scanner.cancel(Number(id) + 1);
    expect(scanner.current()?.status).toBe('running');
    scanner.cancel(Number(id));
  } finally {
    release();
  }
  await finished('cancelled');
  expect(maximum).toBe(4);
  expect(hash).toHaveBeenCalledTimes(4);
  expect(scanner.current()).toEqual({
    id,
    status: 'cancelled',
    started_at: expect.any(String),
    finished_at: expect.any(String),
    discovered: 9,
    processed: 4,
    errors: 0,
  });
  expect(db.prepare("SELECT count(*) AS n FROM files WHERE status='pending'").get()).toEqual({
    n: 5,
  });
  hash.mockImplementation(realHashing.processFile).mockClear();
  await scan();
  expect(hash).toHaveBeenCalledTimes(5);
});

it('does not record stale files when a directory is deleted and its id is reused for the same path', async () => {
  seed();
  const oldFile = await put('old.jpg');
  let release!: () => void;
  let reached!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const walking = new Promise<void>((resolve) => {
    reached = resolve;
  });
  vi.mocked(fs.lstat).mockImplementation(async (path, options) => {
    if (String(path) === oldFile) {
      reached();
      await blocked;
    }
    return realFs.lstat(path, options);
  });
  scanner.start();
  try {
    await walking;
    db.exec('DELETE FROM scan_dirs WHERE id=1');
    expect(Number(seed(media).lastInsertRowid)).toBe(1);
  } finally {
    release();
  }
  await finished();
  expect(files()).toEqual([]);
  expect(hash).not.toHaveBeenCalled();
  await scan();
  expect(files()).toEqual([expect.objectContaining({ rel_path: 'old.jpg', status: 'done' })]);
});

it('retries decoding unchanged invalid images without repeating successful SHA work, even after reopen', async () => {
  seed();
  const path = await put('invalid.jpg', 'not an image');
  const sha = createHash('sha256').update('not an image').digest('hex');
  const checkpoints: unknown[] = [];
  const decode = vi.mocked(hashing.imageHash).mockImplementation(async (path) => {
    checkpoints.push(db.prepare('SELECT status FROM files').get());
    return realHashing.imageHash(path);
  });
  await scan();
  expect(hash).toHaveBeenCalledTimes(1);
  for (let retry = 0; retry < 3; retry++) {
    if (retry === 1) {
      await scanner.close();
      db.close();
      db = openDatabase(directory).db;
      scanner = new Scanner(db, log);
    }
    // A restart between discovery and decode also leaves a reusable pending checkpoint.
    if (retry === 2) db.exec("UPDATE files SET status='pending'");
    hash.mockClear();
    decode.mockClear();
    checkpoints.length = 0;
    await scan();
    expect(checkpoints).toEqual([{ status: 'hashed' }]);
    expect(hash).not.toHaveBeenCalled();
    expect(decode).toHaveBeenCalledExactlyOnceWith(path);
    expect(scanner.current()).toMatchObject({ processed: 1, errors: 1 });
    expect(files()).toEqual([
      expect.objectContaining({ sha256: sha, status: 'error', error: expect.any(String) }),
    ]);
    expect(db.prepare('SELECT count(*) AS n FROM phashes').get()).toEqual({ n: 0 });
  }
  await sharp({ create: { width: 18, height: 16, channels: 3, background: 'white' } })
    .jpeg()
    .toFile(path);
  await scan();
  expect(hash).toHaveBeenCalledExactlyOnceWith(path);
  expect(scanner.current()).toMatchObject({ processed: 1, errors: 0 });
  expect(files()).toEqual([expect.objectContaining({ status: 'done', error: null })]);
  expect(db.prepare('SELECT count(*) AS n FROM phash_bands').get()).toEqual({ n: 4 });
});

it('resumes an image SHA checkpoint, records decode errors and refreshes changed image bands', async () => {
  seed();
  vi.mocked(hashing.imageHash).mockImplementation(realHashing.imageHash);
  const path = join(media, 'real.png');
  await sharp({ create: { width: 18, height: 16, channels: 3, background: 'white' } })
    .png()
    .toFile(path);
  await put('broken.jpg', 'not an image');
  await scan();
  expect(scanner.current()).toMatchObject({ processed: 2, errors: 1 });
  expect(db.prepare('SELECT width,height FROM files WHERE rel_path=?').get('real.png')).toEqual({
    width: 18,
    height: 16,
  });
  expect(db.prepare('SELECT count(*) AS n FROM phash_bands').get()).toEqual({ n: 4 });
  // An older catalog retains its published exact results until the next scan fills missing pHashes.
  db.exec('DELETE FROM phashes; DELETE FROM phash_bands');
  hash.mockClear();
  await scan();
  expect(hash).not.toHaveBeenCalled();
  expect(db.prepare('SELECT count(*) AS n FROM phashes').get()).toEqual({ n: 1 });
  db.exec(
    "UPDATE files SET status='hashed' WHERE rel_path='real.png'; DELETE FROM phashes; DELETE FROM phash_bands"
  );
  await scanner.close();
  db.close();
  db = openDatabase(directory).db;
  scanner = new Scanner(db, log);
  hash.mockClear();
  await scan();
  expect(hash).not.toHaveBeenCalled();
  expect(db.prepare('SELECT count(*) AS n FROM phashes').get()).toEqual({ n: 1 });
  await sharp({ create: { width: 36, height: 32, channels: 3, background: 'black' } })
    .png()
    .toFile(path);
  await scan();
  expect(db.prepare('SELECT width,height FROM files WHERE rel_path=?').get('real.png')).toEqual({
    width: 36,
    height: 32,
  });
  expect(db.prepare('SELECT count(*) AS n FROM phash_bands').get()).toEqual({ n: 4 });
});

it.each(['no_duration', 'incomplete_frames', 'timeout'])(
  'records video %s per-file, continues, and retries without repeating SHA',
  async (failure) => {
    seed();
    await put('bad.mp4');
    await put('good.jpg');
    const decode = vi.mocked(video.videoHash).mockRejectedValue(new video.VideoFailure(failure));
    await scan();
    expect(scanner.current()).toMatchObject({ processed: 2, errors: 1, status: 'done' });
    expect(files()).toContainEqual(
      expect.objectContaining({ rel_path: 'bad.mp4', error: failure, status: 'error' })
    );
    expect(
      db
        .prepare(
          'SELECT count(*) AS n FROM phashes WHERE file_id=(SELECT id FROM files WHERE rel_path=?)'
        )
        .get('bad.mp4')
    ).toEqual({ n: 0 });
    hash.mockClear();
    decode.mockResolvedValue({
      hashes: Array.from({ length: 9 }, () => Buffer.alloc(8)),
      width: 320,
      height: 240,
      duration: 2,
      duration_ms: 2000,
    });
    await scan();
    expect(hash).not.toHaveBeenCalled();
    expect(scanner.current()).toMatchObject({ processed: 2, errors: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM phashes').get()).toEqual({ n: 10 });
  }
);

it.each(['cancel', 'shutdown'])(
  'aborts in-flight video processing on %s and leaves a reusable SHA checkpoint',
  async (action) => {
    seed();
    await put('clip.mp4');
    let signal: AbortSignal | undefined;
    vi.mocked(video.videoHash).mockImplementation(async (_path, _frames, options) => {
      signal = options.signal;
      await new Promise<void>((_resolve, reject) =>
        signal!.addEventListener('abort', () => reject(new video.VideoFailure('cancelled')), {
          once: true,
        })
      );
      throw new Error('unreachable');
    });
    const id = scanner.start();
    await vi.waitFor(() => expect(signal).toBeDefined());
    if (action === 'cancel') scanner.cancel(Number(id));
    else await scanner.close();
    await finished('cancelled');
    expect(signal!.aborted).toBe(true);
    expect(files()).toContainEqual(
      expect.objectContaining({ status: 'hashed', sha256: expect.any(String), error: null })
    );
    expect(scanner.current()).toMatchObject({ errors: 0, processed: 0 });
  }
);

it('backfills videos from an exact-only catalog without rehashing and applies settings', async () => {
  seed();
  await put('clip.mp4');
  await scan();
  db.exec('DELETE FROM phashes; DELETE FROM phash_bands');
  db.exec("INSERT INTO settings VALUES ('video_frame_count','3'),('video_timeout_ms','4567')");
  hash.mockClear();
  const decode = vi.mocked(video.videoHash).mockResolvedValue({
    hashes: Array.from({ length: 3 }, () => Buffer.alloc(8)),
    width: 320,
    height: 240,
    duration: 2,
    duration_ms: 2000,
  });
  await scan();
  expect(hash).not.toHaveBeenCalled();
  expect(decode).toHaveBeenLastCalledWith(join(media, 'clip.mp4'), 3, {
    timeout: 4567,
    signal: expect.any(AbortSignal),
  });
  expect(db.prepare('SELECT count(*) AS n FROM phashes').get()).toEqual({ n: 3 });
});

it('cancels traversal before the missing sweep and drains cleanly on close', async () => {
  seed();
  await put('keep.jpg');
  await scan();
  const id = scanner.start();
  scanner.cancel(Number(id));
  await scanner.close();
  expect(scanner.current()).toMatchObject({ status: 'cancelled', discovered: 0, processed: 0 });
  expect(files()).toEqual([expect.objectContaining({ status: 'done' })]);
});
