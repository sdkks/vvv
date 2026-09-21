import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDatabase } from './db.js';
import { Matcher } from './matcher.js';
import { Quarantine, exists, retention, type Operation, type OperationKind } from './quarantine.js';
import { reconcile } from './reconcile.js';

vi.mock('node:fs/promises', { spy: true });
const realFs = await vi.importActual<typeof fs>('node:fs/promises');
const log = Fastify({ logger: false }).log;
let root: string;
let media: string;
let db: ReturnType<typeof openDatabase>['db'];
let quarantine: Quarantine;
beforeEach(async () => {
  vi.mocked(fs.rename).mockImplementation(realFs.rename).mockClear();
  vi.mocked(fs.unlink).mockImplementation(realFs.unlink).mockClear();
  vi.mocked(fs.lstat).mockImplementation(realFs.lstat).mockClear();
  root = await mkdtemp(join(tmpdir(), 'vvv-quarantine-'));
  media = join(root, 'media');
  await mkdir(media);
  db = openDatabase(root).db;
  new Matcher(db, log);
  quarantine = new Quarantine(db, log);
  db.prepare('INSERT INTO scan_dirs(path) VALUES (?)').run(media);
});
afterEach(async () => {
  vi.useRealTimers();
  await quarantine.close();
  db.close();
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function seed(name = 'original.jpg') {
  await writeFile(join(media, name), 'original content');
  return Number(
    db
      .prepare(
        `INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status,sha256)
    VALUES (1,?,'image',16,0,'done','hash')`
      )
      .run(name).lastInsertRowid
  );
}
function trashPath(id: number) {
  const row = db.prepare('SELECT trash_rel_path FROM trash WHERE id=?').get(id) as {
    trash_rel_path: string;
  };
  return join(media, row.trash_rel_path);
}
function journal() {
  return db.prepare('SELECT * FROM file_operations ORDER BY id').all();
}
function snapshot() {
  return {
    journal: journal(),
    files: db.prepare('SELECT * FROM files ORDER BY id').all(),
    trash: db.prepare('SELECT * FROM trash ORDER BY id').all(),
    groups: db.prepare('SELECT * FROM dup_groups ORDER BY id').all(),
    members: db.prepare('SELECT * FROM dup_group_members ORDER BY group_id,file_id').all(),
  };
}
async function intent(kind: OperationKind): Promise<Operation> {
  const file = await seed();
  const original = join(media, 'original.jpg');
  const token = (db.prepare('SELECT token FROM scan_dirs').get() as { token: string }).token;
  let src = original;
  let dst: string | null = join(media, '.vvv-trash', token, 'injected');
  if (kind !== 'quarantine') {
    src = trashPath((await quarantine.change('quarantine', file)).trash_id);
    dst = kind === 'restore' ? original : null;
  }
  if (dst) await mkdir(dirname(dst), { recursive: true });
  const id = Number(
    db
      .prepare(
        `INSERT INTO file_operations(kind,file_id,src_path,dst_path,status)
    VALUES (?,?,?,?,'pending')`
      )
      .run(kind, file, src, dst).lastInsertRowid
  );
  return db.prepare('SELECT * FROM file_operations WHERE id=?').get(id) as Operation;
}
async function perform(op: Operation) {
  if (op.dst_path) await rename(op.src_path, op.dst_path);
  else await unlink(op.src_path);
}

it.each(
  (['quarantine', 'restore', 'purge'] as const).flatMap((kind) =>
    (['intent', 'filesystem', 'fs_done', 'committed'] as const).map((stage) => ({ kind, stage }))
  )
)('reconciles $kind after $stage twice with identical durable state', async ({ kind, stage }) => {
  const op = await intent(kind);
  if (stage !== 'intent') await perform(op);
  if (stage === 'fs_done')
    db.prepare("UPDATE file_operations SET status='fs_done' WHERE id=?").run(op.id);
  if (stage === 'committed') quarantine.finish(op);
  db.close();
  db = openDatabase(root).db;
  new Matcher(db, log);
  quarantine = new Quarantine(db, log);
  await reconcile(db, quarantine);
  expect(db.prepare('SELECT status,error FROM file_operations WHERE id=?').get(op.id)).toEqual(
    stage === 'intent'
      ? { status: 'failed', error: 'interrupted' }
      : { status: 'committed', error: null }
  );
  expect(await exists(op.src_path)).toBe(stage === 'intent');
  if (op.dst_path) {
    expect(await exists(op.dst_path)).toBe(stage !== 'intent');
    expect(await readFile(stage === 'intent' ? op.src_path : op.dst_path, 'utf8')).toBe(
      'original content'
    );
  }
  const applied = stage !== 'intent';
  expect(db.prepare('SELECT status FROM files').all()).toEqual(
    kind === 'purge' && applied
      ? []
      : [
          {
            status:
              kind === 'quarantine'
                ? applied
                  ? 'quarantined'
                  : 'done'
                : kind === 'restore' && applied
                  ? 'done'
                  : 'quarantined',
          },
        ]
  );
  expect(db.prepare('SELECT restored FROM trash').all()).toEqual(
    (kind === 'quarantine' && !applied) || (kind === 'purge' && applied)
      ? []
      : [{ restored: Number(kind === 'restore' && applied) }]
  );
  const settled = snapshot();
  await reconcile(db, quarantine);
  expect(snapshot()).toEqual(settled);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

it('writes durable intent before rename and rolls back the entire catalog transaction on a commit fault', async () => {
  const id = await seed();
  db.exec(`INSERT INTO match_runs(status) VALUES ('active');
    INSERT INTO settings VALUES ('active_match_run','1');
    INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status) VALUES (1,'other.jpg','image',16,0,'done');
    INSERT INTO dup_groups(kind,member_count,total_bytes,reclaimable_bytes,match_run) VALUES ('exact',2,32,16,1);
    INSERT INTO dup_group_members VALUES (1,1,NULL),(1,2,NULL);
    CREATE TRIGGER commit_fault BEFORE UPDATE OF status ON file_operations
    WHEN new.status='committed' BEGIN SELECT RAISE(ABORT,'commit fault'); END`);
  vi.mocked(fs.rename).mockImplementation(async (src, dst) => {
    const reader = new Database(join(root, 'vvv.db'), { readonly: true, fileMustExist: true });
    try {
      expect(reader.prepare('SELECT status,src_path,dst_path FROM file_operations').get()).toEqual({
        status: 'pending',
        src_path: src,
        dst_path: dst,
      });
      expect(reader.prepare('SELECT status FROM files WHERE id=?').get(id)).toEqual({
        status: 'done',
      });
    } finally {
      reader.close();
    }
    await realFs.rename(src, dst);
  });
  await expect(quarantine.change('quarantine', id)).rejects.toThrow('commit fault');
  expect(db.prepare('SELECT status FROM file_operations').get()).toEqual({ status: 'fs_done' });
  expect(db.prepare('SELECT status FROM files WHERE id=?').get(id)).toEqual({ status: 'done' });
  expect(db.prepare('SELECT * FROM trash').all()).toEqual([]);
  expect(
    db.prepare('SELECT member_count,total_bytes,reclaimable_bytes FROM dup_groups').get()
  ).toEqual({ member_count: 2, total_bytes: 32, reclaimable_bytes: 16 });
  db.exec('DROP TRIGGER commit_fault');
  await reconcile(db, quarantine);
  expect(db.prepare('SELECT * FROM dup_groups').all()).toEqual([]);
  const settled = snapshot();
  await reconcile(db, quarantine);
  expect(snapshot()).toEqual(settled);
});

it('records EXDEV per item without copying, unlinking or changing the catalog', async () => {
  const id = await seed();
  vi.mocked(fs.rename).mockRejectedValueOnce(
    Object.assign(new Error('cross device'), { code: 'EXDEV' })
  );
  await expect(quarantine.change('quarantine', id)).rejects.toThrow('exdev');
  expect(await readFile(join(media, 'original.jpg'), 'utf8')).toBe('original content');
  expect(fs.unlink).not.toHaveBeenCalled();
  expect(db.prepare('SELECT status FROM files').get()).toEqual({ status: 'done' });
  expect(db.prepare('SELECT * FROM trash').all()).toEqual([]);
  expect(db.prepare('SELECT status,error FROM file_operations').get()).toEqual({
    status: 'failed',
    error: 'exdev',
  });
  await reconcile(db, quarantine);
  expect(fs.rename).toHaveBeenCalledTimes(1);
  expect((await quarantine.change('quarantine', id)).file_id).toBe(id);
});

it('refuses an occupied restore destination, including dangling symlinks, without overwriting either file', async () => {
  const id = await seed();
  const { trash_id } = await quarantine.change('quarantine', id);
  const stored = trashPath(trash_id);
  const original = join(media, 'original.jpg');
  for (const symlink of [false, true]) {
    if (symlink) await fs.symlink(join(media, 'absent'), original);
    else await writeFile(original, 'replacement');
    await expect(quarantine.change('restore', trash_id)).rejects.toThrow('destination_exists');
    expect(await readFile(stored, 'utf8')).toBe('original content');
    if (symlink) expect((await fs.lstat(original)).isSymbolicLink()).toBe(true);
    else expect(await readFile(original, 'utf8')).toBe('replacement');
    expect(db.prepare('SELECT status FROM files').get()).toEqual({ status: 'quarantined' });
    await unlink(original);
  }
  await quarantine.change('restore', trash_id);
  expect(await readFile(original, 'utf8')).toBe('original content');
  expect(db.prepare('SELECT restored FROM trash').get()).toEqual({ restored: 1 });
  await expect(quarantine.change('restore', trash_id)).rejects.toThrow('trash_not_found');
});

it('keeps concurrent operations on the same file from creating another intent', async () => {
  const id = await seed();
  const first = quarantine.change('quarantine', id);
  // No yield yet: the intent must already be visible to a competing delete request.
  expect(db.prepare('SELECT file_id,status FROM file_operations').all()).toEqual([
    { file_id: id, status: 'pending' },
  ]);
  await expect(quarantine.change('quarantine', id)).rejects.toThrow('operation_pending');
  await first;
  expect(journal()).toHaveLength(1);
  await expect(quarantine.change('quarantine', id)).rejects.toThrow('file_not_eligible');
});

it.each(['quarantine', 'restore'] as const)(
  'settles known fs_done %s even if a replacement appeared at its source',
  async (kind) => {
    const op = await intent(kind);
    await perform(op);
    db.prepare("UPDATE file_operations SET status='fs_done' WHERE id=?").run(op.id);
    await writeFile(op.src_path, 'replacement');
    await reconcile(db, quarantine);
    expect(await readFile(op.src_path, 'utf8')).toBe('replacement');
    expect(await readFile(op.dst_path!, 'utf8')).toBe('original content');
    expect(db.prepare('SELECT status FROM file_operations WHERE id=?').get(op.id)).toEqual({
      status: 'committed',
    });
    const settled = snapshot();
    await reconcile(db, quarantine);
    expect(snapshot()).toEqual(settled);
  }
);

it('discards a stale intent when unregister/re-register reuses both ids, never touching the replacement', async () => {
  const op = await intent('quarantine');
  await perform(op);
  db.exec('DELETE FROM scan_dirs');
  db.prepare('INSERT INTO scan_dirs(path) VALUES (?)').run(media);
  await seed();
  await unlink(op.src_path);
  await reconcile(db, quarantine);
  expect(db.prepare('SELECT status,error FROM file_operations').get()).toEqual({
    status: 'failed',
    error: 'file_unregistered',
  });
  expect(db.prepare('SELECT status FROM files').get()).toEqual({ status: 'done' });
  expect(db.prepare('SELECT * FROM trash').all()).toEqual([]);
  expect(await readFile(op.dst_path!, 'utf8')).toBe('original content');
  const settled = snapshot();
  await reconcile(db, quarantine);
  expect(snapshot()).toEqual(settled);
});

it('does not interpret permission failures as absence during recovery', async () => {
  await intent('quarantine');
  vi.mocked(fs.lstat).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
  await expect(reconcile(db, quarantine)).rejects.toThrow('denied');
  expect(db.prepare('SELECT status FROM file_operations').get()).toEqual({ status: 'pending' });
});

it('defaults to opt-out and purges only expired, unrestored entries in batches of at most 100', async () => {
  expect(retention(db)).toEqual({ days: 30, enabled: false });
  for (let i = 0; i < 103; i++) await quarantine.change('quarantine', await seed(`${i}.jpg`));
  db.exec("UPDATE trash SET quarantined_at=datetime('now','-31 days') WHERE id<=101");
  db.exec("UPDATE trash SET quarantined_at=datetime('now','-29 days') WHERE id=102");
  await quarantine.change('restore', 103);
  db.exec("UPDATE trash SET quarantined_at=datetime('now','-40 days') WHERE id=103");
  expect(await quarantine.purgeExpired(true)).toEqual({ purged: 0, failed: [] });
  expect(db.prepare('SELECT count(*) AS n FROM trash').get()).toEqual({ n: 103 });
  db.exec("UPDATE settings SET value='1' WHERE key='auto_purge_enabled'");
  expect(await quarantine.purgeExpired(true)).toEqual({ purged: 100, failed: [] });
  expect(await quarantine.purgeExpired(true)).toEqual({ purged: 1, failed: [] });
  expect(await quarantine.purgeExpired(true)).toEqual({ purged: 0, failed: [] });
  expect(db.prepare('SELECT id,restored FROM trash ORDER BY id').all()).toEqual([
    { id: 102, restored: 0 },
    { id: 103, restored: 1 },
  ]);
  expect(await exists(trashPath(102))).toBe(true);
  expect(await readFile(join(media, '102.jpg'), 'utf8')).toBe('original content');
  db.exec(
    "UPDATE settings SET value='0' WHERE key='auto_purge_enabled'; UPDATE settings SET value='29' WHERE key='retention_days'"
  );
  expect(await quarantine.purgeExpired()).toEqual({ purged: 1, failed: [] });
  expect(db.prepare('SELECT id FROM trash').all()).toEqual([{ id: 103 }]);
});

it('records individual purge failures while continuing to other expired files', async () => {
  await quarantine.change('quarantine', await seed('one.jpg'));
  await quarantine.change('quarantine', await seed('two.jpg'));
  db.exec("UPDATE settings SET value='0' WHERE key='retention_days'");
  vi.mocked(fs.unlink).mockRejectedValueOnce(
    Object.assign(new Error('denied'), { code: 'EACCES' })
  );
  expect(await quarantine.purgeExpired()).toEqual({
    purged: 1,
    failed: [{ trash_id: 1, error: 'eacces' }],
  });
  expect(await exists(trashPath(1))).toBe(true);
  expect(
    db.prepare("SELECT status,error FROM file_operations WHERE kind='purge' ORDER BY id").all()
  ).toEqual([
    { status: 'failed', error: 'eacces' },
    { status: 'committed', error: null },
  ]);
});

it.each(['-1', '1.5', 'NaN', '365001'])(
  'refuses invalid stored retention %s before deleting anything',
  async (value) => {
    db.prepare("UPDATE settings SET value=? WHERE key='retention_days'").run(value);
    await expect(quarantine.purgeExpired()).rejects.toThrow('invalid_retention_days');
    expect(fs.unlink).not.toHaveBeenCalled();
  }
);

it('ticks hourly without overlapping work and waits for an active tick on shutdown', async () => {
  vi.useFakeTimers();
  let finish!: (value: { purged: number; failed: [] }) => void;
  const purge = vi.spyOn(quarantine, 'purgeExpired').mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  quarantine.start();
  await vi.advanceTimersByTimeAsync(3599999);
  expect(purge).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(purge).toHaveBeenCalledExactlyOnceWith(true);
  await vi.advanceTimersByTimeAsync(3600000);
  expect(purge).toHaveBeenCalledTimes(1);
  let closed = false;
  const closing = quarantine.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  finish({ purged: 0, failed: [] });
  await closing;
  await vi.advanceTimersByTimeAsync(3600000);
  expect(purge).toHaveBeenCalledTimes(1);
});
