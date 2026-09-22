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
import { Matcher } from './matcher.js';
import { Quarantine } from './quarantine.js';
import { settingsRoutes } from './routes/settings.js';
import * as hashing from './hashing.js';
import * as video from './video.js';

vi.mock('./hashing.js', { spy: true });
vi.mock('./video.js', async (importOriginal) => {
  const original = await importOriginal<typeof video>();
  return {
    ...original,
    videoHash: vi.fn(original.videoHash),
    videoMetadata: vi.fn(original.videoMetadata),
  };
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
  vi.mocked(fs.realpath).mockImplementation(realFs.realpath);
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
    const inside = join(media, 'inside');
    await put('inside/clip.mp4', 'video');
    await symlink(inside, join(media, 'linked-dir'));
    await symlink(join(inside, 'clip.mp4'), join(media, 'linked.mp4'));
    await symlink(media, join(inside, 'loop'));
    await symlink(media, join(media, 'self'));
    await scan();
    const paths = follow
      ? ['inside/clip.mp4', 'linked-dir/clip.mp4', 'linked.mp4', 'local.jpg']
      : ['inside/clip.mp4', 'local.jpg'];
    expect(files()).toEqual(
      paths.map((rel_path) => expect.objectContaining({ rel_path, status: 'done', error: null }))
    );
    expect(hash).toHaveBeenCalledTimes(paths.length);
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

it.each([false, true])(
  'confines same-device links, records both kinds of escape and preserves rescans (aliased root=%s)',
  async (aliased) => {
    await put('inside/local.jpg');
    await symlink(join(media, 'inside'), join(media, 'inside-dir'));
    await symlink(join(media, 'inside/local.jpg'), join(media, 'inside.jpg'));
    const outside = join(directory, 'media-outside');
    await mkdir(outside);
    await writeFile(join(outside, 'external.jpg'), 'outside');
    await symlink(outside, join(media, 'outside-dir'));
    await symlink(join(outside, 'external.jpg'), join(media, 'outside.jpg'));
    expect((await stat(outside)).dev).toBe((await stat(media)).dev);
    const registered = aliased ? join(directory, 'root-link') : media;
    if (aliased) await symlink(media, registered);
    seed(registered, 1, 1);
    let rowIds: unknown[] | undefined;
    for (let scanId = 1; scanId <= 2; scanId++) {
      vi.mocked(fs.stat).mockClear();
      vi.mocked(fs.realpath).mockClear();
      vi.mocked(fs.opendir).mockClear();
      hash.mockClear();
      await scan();
      expect(scanner.current()).toMatchObject({ discovered: 5, processed: 5, errors: 2 });
      expect(files()).toEqual([
        ...['inside-dir/local.jpg', 'inside.jpg', 'inside/local.jpg'].map((rel_path) =>
          expect.objectContaining({ rel_path, status: 'done', last_seen_scan_id: scanId })
        ),
        ...[
          { rel_path: 'outside-dir', kind: 'other' },
          { rel_path: 'outside.jpg', kind: 'image' },
        ].map((file) => ({
          ...file,
          status: 'error',
          sha256: null,
          error: 'Symlink target is outside the registered directory.',
          last_seen_scan_id: scanId,
        })),
      ]);
      expect(hash).toHaveBeenCalledTimes(scanId === 1 ? 3 : 0);
      expect(hash.mock.calls.every(([path]) => !path.includes('outside'))).toBe(true);
      for (const operation of [fs.stat, fs.opendir])
        expect(
          vi.mocked(operation).mock.calls.every(([path]) => !String(path).includes('outside'))
        ).toBe(true);
      expect(
        vi.mocked(fs.realpath).mock.calls.filter(([path]) => path === registered)
      ).toHaveLength(1);
      const currentIds = db.prepare('SELECT id,rel_path FROM files ORDER BY id').all();
      if (rowIds) expect(currentIds).toEqual(rowIds);
      rowIds = currentIds;
    }
  }
);

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
  setSizes(1);
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
  setSizes(1);
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
it('interrupts root resolution failures without sweeping existing files missing', async () => {
  seed();
  await put('good.jpg');
  await scan();
  const before = files();
  vi.mocked(fs.realpath).mockRejectedValueOnce(
    Object.assign(new Error('Root vanished'), { code: 'ENOENT' })
  );
  await scanInterrupted();
  expect(files()).toEqual(before);
  expect(scanner.current()).toMatchObject({ discovered: 0, processed: 0, errors: 0 });
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
  expect(hash).toHaveBeenCalledExactlyOnceWith(path, 'sha256');
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

it.each(['image', 'video'] as const)(
  'skips %s perceptual work, retains metadata and backfills only after enable without SHA',
  async (kind) => {
    seed();
    const image = join(media, 'image.png');
    await sharp({ create: { width: 18, height: 16, channels: 3, background: 'white' } })
      .png()
      .toFile(image);
    await put('clip.mp4');
    vi.mocked(video.videoMetadata).mockResolvedValue({
      width: 320,
      height: 240,
      duration: 2,
      duration_ms: 2000,
    });
    const setEnabled = (enabled: boolean) =>
      db
        .prepare('INSERT OR REPLACE INTO settings VALUES (?,?)')
        .run(`match_${kind}s_enabled`, enabled ? '1' : '0');
    setEnabled(false);
    const perceptual = kind === 'image' ? hashing.imageHash : video.videoHash;
    const metadata = kind === 'image' ? hashing.imageMetadata : video.videoMetadata;
    await scan();
    expect(perceptual).not.toHaveBeenCalled();
    expect(metadata).toHaveBeenCalledTimes(1);
    const row = db
      .prepare('SELECT id,status,sha256,width,height,duration_ms FROM files WHERE kind=?')
      .get(kind) as { id: number; sha256: string };
    expect(row).toMatchObject({
      status: 'done',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      width: kind === 'image' ? 18 : 320,
      height: kind === 'image' ? 16 : 240,
      duration_ms: kind === 'image' ? null : 2000,
    });
    expect(db.prepare('SELECT count(*) AS n FROM phashes WHERE file_id=?').get(row.id)).toEqual({
      n: 0,
    });
    expect(db.prepare('SELECT count(*) AS n FROM phashes').get()).toEqual({
      n: kind === 'image' ? 9 : 1,
    });
    hash.mockClear();
    vi.mocked(metadata).mockClear();
    await scan();
    expect(perceptual).not.toHaveBeenCalled();
    expect(metadata).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    setEnabled(true);
    await scan();
    expect(hash).not.toHaveBeenCalled();
    expect(perceptual).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT count(*) AS n FROM phashes WHERE file_id=?').get(row.id)).toEqual({
      n: kind === 'image' ? 1 : 9,
    });
    expect(db.prepare('SELECT sha256 FROM files WHERE id=?').get(row.id)).toEqual({
      sha256: row.sha256,
    });
    vi.mocked(perceptual).mockClear();
    await scan();
    expect(perceptual).not.toHaveBeenCalled();
  }
);

it('uses the scan-start switches even when a switch changes before traversal finishes', async () => {
  seed();
  await put('clip.mp4');
  vi.mocked(video.videoMetadata).mockResolvedValue({
    width: 320,
    height: 240,
    duration: 2,
    duration_ms: 2000,
  });
  db.exec("INSERT INTO settings VALUES ('match_videos_enabled','0')");
  scanner.start();
  db.exec("UPDATE settings SET value='1' WHERE key='match_videos_enabled'");
  await finished();
  expect(video.videoHash).not.toHaveBeenCalled();
  expect(video.videoMetadata).toHaveBeenCalledTimes(1);
  hash.mockClear();
  await scan();
  expect(video.videoHash).toHaveBeenCalledTimes(1);
  expect(hash).not.toHaveBeenCalled();
});

it('removes stale perceptual hashes when a file changes while its kind is disabled', async () => {
  seed();
  await put('clip.mp4');
  await scan();
  db.exec("INSERT INTO settings VALUES ('match_videos_enabled','0')");
  await put('clip.mp4', 'changed content');
  vi.mocked(video.videoMetadata).mockResolvedValue({
    width: 320,
    height: 240,
    duration: 2,
    duration_ms: 2000,
  });
  vi.mocked(video.videoHash).mockClear();
  hash.mockClear();
  await scan();
  expect(video.videoHash).not.toHaveBeenCalled();
  expect(hash).toHaveBeenCalledTimes(1);
  expect(db.prepare('SELECT count(*) AS n FROM phashes').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT count(*) AS n FROM phash_bands').get()).toEqual({ n: 0 });
});

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

it('re-samples after a frame-count PATCH without repeating SHA and uses the saved timeout', async () => {
  seed();
  await put('clip.mp4');
  await put('image.jpg');
  await scan();
  const route = Fastify({ ajv: { customOptions: { coerceTypes: false } } });
  settingsRoutes(route, db);
  try {
    const response = await route.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: {
        video_frame_count: 3,
        video_timeout_ms: 10000,
      },
    });
    expect(response.statusCode).toBe(200);
    hash.mockClear();
    vi.mocked(hashing.imageHash).mockClear();
    const decode = vi.mocked(video.videoHash).mockResolvedValue({
      hashes: Array.from({ length: 3 }, () => Buffer.alloc(8)),
      width: 320,
      height: 240,
      duration: 2,
      duration_ms: 2000,
    });
    await scan();
    expect(hash).not.toHaveBeenCalled();
    expect(hashing.imageHash).not.toHaveBeenCalled();
    expect(decode).toHaveBeenLastCalledWith(join(media, 'clip.mp4'), 3, {
      timeout: 10000,
      signal: expect.any(AbortSignal),
    });
    expect(db.prepare('SELECT count(*) AS n FROM phashes').get()).toEqual({ n: 4 });
    expect(files().every((f) => (f as { status: string }).status === 'done')).toBe(true);
    decode.mockClear();
    expect(
      (
        await route.inject({
          method: 'PATCH',
          url: '/api/settings',
          payload: { video_timeout_ms: 20000 },
        })
      ).statusCode
    ).toBe(200);
    await scan();
    expect(decode).not.toHaveBeenCalled();
    await put('new.mp4');
    await scan();
    expect(decode).toHaveBeenLastCalledWith(join(media, 'new.mp4'), 3, {
      timeout: 20000,
      signal: expect.any(AbortSignal),
    });
  } finally {
    await route.close();
  }
});

async function setAlgorithm(algorithm: 'sha256' | 'blake2b512', extra: object = {}) {
  const route = Fastify({ ajv: { customOptions: { coerceTypes: false } } });
  settingsRoutes(route, db);
  try {
    const response = await route.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { file_hash_algorithm: algorithm, ...extra },
    });
    expect(response.statusCode).toBe(200);
  } finally {
    await route.close();
  }
}
it.each(['image', 'video'] as const)(
  're-hashes %s files after switching and restoring without re-sampling, then exact-matches them',
  async (kind) => {
    seed();
    const extension = kind === 'image' ? 'jpg' : 'mp4';
    for (const name of ['a', 'b', 'trash', 'purge']) await put(`${name}.${extension}`, 'duplicate');
    await scan();
    const rows = db.prepare('SELECT id,rel_path FROM files ORDER BY rel_path').all() as {
      id: number;
      rel_path: string;
    }[];
    const quarantine = new Quarantine(db, log);
    const moved = await quarantine.change('quarantine', rows[3]!.id);
    const purged = await quarantine.change('quarantine', rows[2]!.id);
    const perceptual = kind === 'image' ? hashing.imageHash : video.videoHash;
    const savedHashes = db.prepare('SELECT * FROM phashes WHERE file_id!=?').all(rows[2]!.id);
    const savedBands = db.prepare('SELECT * FROM phash_bands WHERE file_id!=?').all(rows[2]!.id);
    await setAlgorithm('blake2b512');
    expect(db.prepare('SELECT sha256 FROM files WHERE id=?').get(rows[3]!.id)).toEqual({
      sha256: null,
    });
    await quarantine.change('purge', purged.trash_id);
    hash.mockClear();
    vi.mocked(perceptual).mockClear();
    await scan();
    expect(hash).toHaveBeenCalledTimes(2);
    expect(vi.mocked(perceptual)).not.toHaveBeenCalled();
    const digest = createHash('blake2b512').update('duplicate').digest('hex');
    expect(db.prepare("SELECT sha256 FROM files WHERE status='done'").all()).toEqual([
      { sha256: digest },
      { sha256: digest },
    ]);
    await quarantine.change('restore', moved.trash_id);
    expect(db.prepare('SELECT status,sha256 FROM files WHERE id=?').get(rows[3]!.id)).toEqual({
      status: 'done',
      sha256: null,
    });
    const matcher = new Matcher(db, log);
    const exactMembers = () =>
      db
        .prepare(
          "SELECT m.file_id FROM dup_group_members m JOIN dup_groups g ON g.id=m.group_id WHERE g.kind='exact' ORDER BY m.file_id"
        )
        .all();
    matcher.start();
    await matcher.close();
    expect(exactMembers()).not.toContainEqual({ file_id: rows[3]!.id });
    hash.mockClear();
    await scan();
    expect(hash).toHaveBeenCalledExactlyOnceWith(join(media, rows[3]!.rel_path), 'blake2b512');
    expect(perceptual).not.toHaveBeenCalled();
    matcher.start();
    await matcher.close();
    expect(exactMembers()).toHaveLength(3);
    expect(exactMembers()).toContainEqual({ file_id: rows[3]!.id });
    await setAlgorithm('sha256');
    hash.mockClear();
    await scan();
    expect(hash).toHaveBeenCalledTimes(3);
    expect(perceptual).not.toHaveBeenCalled();
    expect(db.prepare('SELECT sha256 FROM files').all()).toEqual(
      Array.from({ length: 3 }, () => ({
        sha256: createHash('sha256').update('duplicate').digest('hex'),
      }))
    );
    expect(db.prepare('SELECT * FROM phashes').all()).toEqual(savedHashes);
    expect(db.prepare('SELECT * FROM phash_bands').all()).toEqual(savedBands);
  }
);
it('snapshots the content hash algorithm before traversal starts', async () => {
  seed();
  await put('image.jpg');
  await setAlgorithm('blake2b512');
  scanner.start();
  // The public API refuses this; verify the worker snapshot independently.
  db.exec("UPDATE settings SET value='sha256' WHERE key='file_hash_algorithm'");
  await finished();
  expect(hash).toHaveBeenCalledExactlyOnceWith(join(media, 'image.jpg'), 'blake2b512');
});
it('replaces changed-content perceptual hashes while reusing only unchanged re-hash checkpoints', async () => {
  seed();
  await put('image.jpg', 'before');
  await put('clip.mp4', 'before');
  await scan();
  await setAlgorithm('blake2b512');
  await put('image.jpg', 'new image content');
  await put('clip.mp4', 'new video content');
  vi.mocked(hashing.imageHash).mockResolvedValue({
    hash: Buffer.alloc(8, 1),
    width: 18,
    height: 16,
  });
  vi.mocked(video.videoHash).mockResolvedValue({
    hashes: Array.from({ length: 9 }, () => Buffer.alloc(8, 2)),
    width: 640,
    height: 480,
    duration: 3,
    duration_ms: 3000,
  });
  hash.mockClear();
  await scan();
  expect(hash).toHaveBeenCalledTimes(2);
  expect(hashing.imageHash).toHaveBeenCalledTimes(2);
  expect(video.videoHash).toHaveBeenCalledTimes(2);
  expect(
    db
      .prepare("SELECT hash FROM phashes p JOIN files f ON f.id=p.file_id WHERE f.kind='image'")
      .all()
  ).toEqual([{ hash: Buffer.alloc(8, 1) }]);
  expect(
    db
      .prepare("SELECT hash FROM phashes p JOIN files f ON f.id=p.file_id WHERE f.kind='video'")
      .all()
  ).toEqual(Array.from({ length: 9 }, () => ({ hash: Buffer.alloc(8, 2) })));
  expect(db.prepare('SELECT count(*) AS n FROM phash_bands').get()).toEqual({ n: 40 });
});
it('does not reuse stale perceptual work after changed traversal is interrupted and reopened', async () => {
  seed();
  const path = await put('image.jpg', 'before');
  await scan();
  await put('image.jpg', 'changed content');
  const lstat = vi.mocked(fs.lstat).mockImplementation(async (file, options) => {
    const info = await realFs.lstat(file, options);
    if (String(file) === path) scanner.cancel(scanner.current()!.id);
    return info;
  });
  scanner.start();
  await finished('cancelled');
  expect(db.prepare('SELECT count(*) AS n FROM phashes').get()).toEqual({ n: 0 });
  lstat.mockImplementation(realFs.lstat);
  await scanner.close();
  db.close();
  db = openDatabase(directory).db;
  scanner = new Scanner(db, log);
  await setAlgorithm('blake2b512');
  hash.mockClear();
  vi.mocked(hashing.imageHash).mockClear();
  await scan();
  expect(hash).toHaveBeenCalledExactlyOnceWith(path, 'blake2b512');
  expect(hashing.imageHash).toHaveBeenCalledExactlyOnceWith(path);
});
it('re-hashes excluded and missing returns and samples only content changed while excluded', async () => {
  seed();
  await put('unchanged.jpg', 'content');
  await put('changed.jpg', 'content');
  await put('returned.jpg', 'content');
  await scan();
  const returned = join(media, 'returned.jpg');
  const absent = join(directory, 'absent.jpg');
  await fs.rename(returned, absent);
  setSizes(1);
  await scan();
  await put('changed.jpg', 'changed while excluded');
  await scan();
  await setAlgorithm('blake2b512');
  await fs.rename(absent, returned);
  setSizes(0);
  hash.mockClear();
  vi.mocked(hashing.imageHash).mockClear();
  await scan();
  expect(hash).toHaveBeenCalledTimes(3);
  expect(hashing.imageHash).toHaveBeenCalledExactlyOnceWith(join(media, 'changed.jpg'));
  expect(files().every((file) => (file as { status: string }).status === 'done')).toBe(true);
});
it('combines algorithm changes with frame backfill without resampling unchanged images', async () => {
  seed();
  await put('image.jpg');
  await put('clip.mp4');
  await scan();
  await setAlgorithm('blake2b512', { video_frame_count: 3 });
  hash.mockClear();
  vi.mocked(hashing.imageHash).mockClear();
  const decode = vi
    .mocked(video.videoHash)
    .mockClear()
    .mockResolvedValue({
      hashes: Array.from({ length: 3 }, () => Buffer.alloc(8)),
      width: 320,
      height: 240,
      duration: 2,
      duration_ms: 2000,
    });
  await scan();
  expect(hash).toHaveBeenCalledTimes(2);
  expect(hashing.imageHash).not.toHaveBeenCalled();
  expect(decode).toHaveBeenCalledTimes(1);
  expect(db.prepare('SELECT count(*) AS n FROM phashes').get()).toEqual({ n: 4 });
});
const setSizes = (min: number, max = 0) => {
  db.prepare("UPDATE settings SET value=? WHERE key='min_file_size_mb'").run(String(min));
  db.prepare("UPDATE settings SET value=? WHERE key='max_file_size_mb'").run(String(max));
};
it('records inclusive size exclusions without hashing or errors and fully processes them on widening', async () => {
  seed();
  const mib = 1048576;
  for (const [path, size] of [
    ['small.jpg', mib - 1],
    ['min.jpg', mib],
    ['max.mp4', 2 * mib],
    ['large.mp4', 2 * mib + 1],
  ] as const)
    await writeFile(join(media, path), Buffer.alloc(size));
  setSizes(1, 2);
  await scan();
  expect(scanner.current()).toMatchObject({ discovered: 4, processed: 4, errors: 0 });
  expect(hash.mock.calls.map(([path]) => basename(path)).sort()).toEqual(['max.mp4', 'min.jpg']);
  for (const [path, reason] of [
    ['small.jpg', 'below minimum'],
    ['large.mp4', 'above maximum'],
  ] as const)
    expect(files()).toContainEqual(
      expect.objectContaining({
        rel_path: path,
        status: 'excluded',
        sha256: null,
        error: expect.stringContaining(reason),
      })
    );
  expect(
    db
      .prepare(
        "SELECT count(*) AS n FROM phashes p JOIN files f ON f.id=p.file_id WHERE f.status='excluded'"
      )
      .get()
  ).toEqual({ n: 0 });
  const ids = db.prepare('SELECT id,rel_path FROM files ORDER BY id').all();
  hash.mockClear();
  hash.mockImplementation(async (path) => {
    expect(
      db.prepare('SELECT status,error FROM files WHERE rel_path=?').get(basename(path))
    ).toEqual({ status: 'pending', error: null });
    return realHashing.processFile(path);
  });
  setSizes(0);
  await scan();
  expect(hash.mock.calls.map(([path]) => basename(path)).sort()).toEqual([
    'large.mp4',
    'small.jpg',
  ]);
  expect(files().every((file) => (file as { status: string }).status === 'done')).toBe(true);
  expect(db.prepare('SELECT id,rel_path FROM files ORDER BY id').all()).toEqual(ids);
});
it('tightens done rows, retains checkpoints across reopen, and reuses SHA when widened', async () => {
  seed();
  await put('keep.jpg');
  await scan();
  const sha = db.prepare('SELECT sha256 FROM files').get();
  const hashes = db.prepare('SELECT * FROM phashes').all();
  setSizes(1);
  hash.mockClear();
  vi.mocked(hashing.imageHash).mockClear();
  await scan();
  expect(hash).not.toHaveBeenCalled();
  expect(hashing.imageHash).not.toHaveBeenCalled();
  expect(files()).toEqual([
    expect.objectContaining({
      status: 'excluded',
      error: 'excluded_by_size: 8 B below minimum 1 MiB',
    }),
  ]);
  expect(db.prepare('SELECT sha256 FROM files').get()).toEqual(sha);
  expect(db.prepare('SELECT * FROM phashes').all()).toEqual(hashes);
  await scanner.close();
  db.close();
  db = openDatabase(directory).db;
  scanner = new Scanner(db, log);
  setSizes(0);
  await scan();
  expect(hash).not.toHaveBeenCalled();
  expect(hashing.imageHash).toHaveBeenCalledExactlyOnceWith(join(media, 'keep.jpg'));
  expect(files()).toEqual([expect.objectContaining({ status: 'done', error: null })]);
  setSizes(1);
  await scan();
  await put('keep.jpg', 'changed while excluded');
  await scan();
  expect(db.prepare('SELECT sha256 FROM files').get()).toEqual({ sha256: null });
  setSizes(0);
  await scan();
  expect(hash).toHaveBeenCalledTimes(1);
});
it('refreshes published group counts immediately during exclusion, before another match run', async () => {
  seed();
  for (const name of ['small-a.jpg', 'small-b.jpg']) await put(name, 'same');
  for (const name of ['large-a.jpg', 'large-b.jpg'])
    await writeFile(join(media, name), Buffer.alloc(1048576));
  await scan();
  const matcher = new Matcher(db, log);
  matcher.start();
  await matcher.close();
  expect(db.prepare("SELECT count(*) AS n FROM dup_groups WHERE kind='exact'").get()).toEqual({
    n: 2,
  });
  const run = db.prepare("SELECT value FROM settings WHERE key='active_match_run'").get();
  setSizes(1);
  await scan();
  expect(db.prepare("SELECT value FROM settings WHERE key='active_match_run'").get()).toEqual(run);
  expect(db.prepare("SELECT count(*) AS n FROM dup_groups WHERE kind='exact'").get()).toEqual({
    n: 1,
  });
  for (const group of db
    .prepare('SELECT member_count,total_bytes,reclaimable_bytes FROM dup_groups')
    .all())
    expect(group).toEqual({ member_count: 2, total_bytes: 2097152, reclaimable_bytes: 1048576 });
  expect(
    db
      .prepare(
        "SELECT count(*) AS n FROM dup_group_members m JOIN files f ON f.id=m.file_id WHERE f.status='excluded'"
      )
      .get()
  ).toEqual({ n: 0 });
});
it('sweeps excluded files missing on deletion and re-evaluates size policy on rediscovery', async () => {
  seed();
  await put('first.jpg');
  setSizes(1);
  await scan();
  await unlink(join(media, 'first.jpg'));
  await scan();
  expect(files()).toEqual([expect.objectContaining({ status: 'missing', last_seen_scan_id: 1 })]);
  await put('first.jpg');
  // Simulate a settings save while traversal is yielding to filesystem I/O.
  vi.mocked(fs.lstat).mockImplementation(async (path, options) => {
    setSizes(0);
    return realFs.lstat(path, options);
  });
  await scan();
  expect(files()).toEqual([expect.objectContaining({ status: 'excluded', last_seen_scan_id: 3 })]);
  expect(hash).not.toHaveBeenCalled();
  await scan();
  expect(files()).toEqual([expect.objectContaining({ status: 'done', error: null })]);
  expect(hash).toHaveBeenCalledTimes(1);
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
