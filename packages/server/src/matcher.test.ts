import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDatabase } from './db.js';
import { activeMatchRun, deleteScanDir, Matcher } from './matcher.js';

let root: string;
let db: ReturnType<typeof openDatabase>['db'];
let matcher: Matcher;
let openReadOnly: ReturnType<typeof openDatabase>['openReadOnly'];
const log = Fastify({ logger: false }).log;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vvv-matcher-'));
  ({ db, openReadOnly } = openDatabase(root));
  db.exec("INSERT INTO scan_dirs(path) VALUES ('/media')");
  matcher = new Matcher(db, log);
});
afterEach(async () => {
  await matcher.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function put(path: string, size: number, hash: string | null, status = 'done', kind = 'image') {
  db.prepare(
    `INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status,sha256)
    VALUES (1,?,?,?,0,?,?)`
  ).run(path, kind, size, status, hash);
}
const groups = () =>
  db
    .prepare(
      'SELECT kind,member_count,total_bytes,reclaimable_bytes FROM dup_groups ORDER BY total_bytes'
    )
    .all();

it('groups only completed equal-size equal-hash files, across directories and media kinds', async () => {
  put('one.jpg', 20, 'same');
  put('two.mp4', 20, 'same', 'done', 'video');
  db.exec("INSERT INTO scan_dirs(path) VALUES ('/other')");
  db.exec(`INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status,sha256)
    VALUES (2,'third.jpg','image',20,0,'done','same')`);
  put('wrong-size.jpg', 21, 'same');
  put('wrong-hash.jpg', 20, 'different');
  for (const status of ['pending', 'hashed', 'error', 'quarantined', 'missing'])
    put(`${status}.jpg`, 20, 'same', status);
  put('no-hash.jpg', 20, null);
  put('also-no-hash.jpg', 20, null);
  put('empty.jpg', 0, 'empty');
  put('empty-copy.jpg', 0, 'empty');
  const id = matcher.start();
  expect(id).toBe(1);
  expect(matcher.start()).toBeNull();
  await matcher.close();
  expect(activeMatchRun(db)).toBe(id);
  expect(groups()).toEqual([
    { kind: 'exact', member_count: 2, total_bytes: 0, reclaimable_bytes: 0 },
    { kind: 'exact', member_count: 3, total_bytes: 60, reclaimable_bytes: 40 },
  ]);
  expect(
    db.prepare('SELECT count(*) AS n FROM dup_group_members WHERE similarity IS NOT NULL').get()
  ).toEqual({ n: 0 });
});

it('publishes bounded chunks behind the old generation, atomically activates, then cleans up in chunks', async () => {
  put('old-a.jpg', 1, 'old');
  put('old-b.jpg', 1, 'old');
  const old = matcher.start();
  await matcher.close();
  db.transaction(() => {
    for (let i = 0; i < 12001; i++) put(`large-${i}.jpg`, 10, 'large');
    for (let i = 0; i < 1001; i++) {
      put(`pair-${i}-a.jpg`, 20, `hash-${String(i).padStart(4, '0')}`);
      put(`pair-${i}-b.jpg`, 20, `hash-${String(i).padStart(4, '0')}`);
    }
  })();
  const id = matcher.start();
  const reader = openReadOnly();
  try {
    expect(activeMatchRun(reader)).toBe(old);
    let previousMembers = 0;
    let previousGroups = 0;
    let buildingTicks = 0;
    for (let i = 0; i < 20 && activeMatchRun(reader) !== id; i++) {
      await tick();
      const current = reader
        .prepare(
          `SELECT count(*) AS n FROM dup_group_members m
        JOIN dup_groups g ON g.id=m.group_id WHERE g.match_run=?`
        )
        .get(id) as { n: number };
      const currentGroups = reader
        .prepare('SELECT count(*) AS n FROM dup_groups WHERE match_run=?')
        .get(id) as { n: number };
      expect(current.n - previousMembers).toBeLessThanOrEqual(10000);
      expect(currentGroups.n - previousGroups).toBeLessThanOrEqual(1000);
      previousMembers = current.n;
      previousGroups = currentGroups.n;
      const run = activeMatchRun(reader);
      if (run === old) {
        buildingTicks++;
        expect(
          reader.prepare('SELECT member_count FROM dup_groups WHERE match_run=?').all(run)
        ).toEqual([{ member_count: 2 }]);
        expect(reader.prepare('SELECT status FROM match_runs WHERE id=?').get(id)).toEqual({
          status: 'building',
        });
      } else {
        expect(run).toBe(id);
        expect(current.n).toBe(14005);
        expect(currentGroups.n).toBe(1003);
        expect(reader.prepare('SELECT status FROM match_runs WHERE id=?').get(id)).toEqual({
          status: 'active',
        });
      }
    }
    expect(buildingTicks).toBeGreaterThan(1);
    expect(activeMatchRun(reader)).toBe(id);
    await matcher.close();
    expect(db.prepare('SELECT id,status FROM match_runs').all()).toEqual([
      { id, status: 'active' },
    ]);
    expect(db.prepare('SELECT count(*) AS n FROM dup_groups WHERE match_run<>?').get(id)).toEqual({
      n: 0,
    });
    // Another activation deletes more than one member-cleanup batch.
    matcher.start();
    await matcher.close();
    expect(db.prepare('SELECT count(*) AS n FROM dup_group_members').get()).toEqual({ n: 14005 });
  } finally {
    reader.close();
  }
});

it('leaves the active lifecycle and pointer intact when post-activation cleanup fails', async () => {
  put('a.jpg', 1, 'same');
  put('b.jpg', 1, 'same');
  matcher.start();
  await matcher.close();
  db.exec(`CREATE TRIGGER fail_cleanup BEFORE DELETE ON dup_group_members BEGIN
    SELECT RAISE(ABORT, 'cleanup fault'); END`);
  const error = vi.spyOn(log, 'error');
  const id = matcher.start();
  await matcher.close();
  expect(error).toHaveBeenCalledWith(expect.objectContaining({ match_run: id }), 'Matching failed');
  expect(activeMatchRun(db)).toBe(id);
  expect(db.prepare('SELECT status FROM match_runs WHERE id=?').get(id)).toEqual({
    status: 'active',
  });
  expect(db.prepare('SELECT member_count FROM dup_groups WHERE match_run=?').all(id)).toEqual([
    { member_count: 2 },
  ]);
  db.exec('DROP TRIGGER fail_cleanup');
  matcher.start();
  await matcher.close();
  expect(db.prepare('SELECT count(*) AS n FROM match_runs').get()).toEqual({ n: 1 });
});

it('never activates a failed building run and recovers abandoned runs on restart', async () => {
  put('a.jpg', 1, 'same');
  put('b.jpg', 1, 'same');
  const old = matcher.start();
  await matcher.close();
  db.exec(`CREATE TRIGGER fail_build BEFORE INSERT ON dup_group_members BEGIN
    SELECT RAISE(ABORT, 'build fault'); END`);
  const id = matcher.start();
  await matcher.close();
  expect(activeMatchRun(db)).toBe(old);
  expect(db.prepare('SELECT status FROM match_runs WHERE id=?').get(id)).toEqual({
    status: 'superseded',
  });
  db.exec("DROP TRIGGER fail_build; INSERT INTO match_runs(status) VALUES ('building')");
  matcher = new Matcher(db, log);
  expect(db.prepare("SELECT count(*) AS n FROM match_runs WHERE status='building'").get()).toEqual({
    n: 0,
  });
  matcher.start();
  await matcher.close();
  expect(db.prepare('SELECT count(*) AS n FROM match_runs').get()).toEqual({ n: 1 });
});

it('seeks member publication by exact hash instead of rescanning all completed files per group', async () => {
  put('a.jpg', 1, 'same');
  put('b.jpg', 1, 'same');
  const prepare = vi.spyOn(Database.prototype, 'prepare');
  matcher.start();
  await matcher.close();
  const sql = prepare.mock.calls.find(([query]) =>
    query.startsWith('INSERT INTO dup_group_members')
  )?.[0];
  expect(sql).toBeDefined();
  prepare.mockRestore();
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1, 1, 'same', 0, 10000) as {
    detail: string;
  }[];
  expect(
    plan.some(({ detail }) => detail.includes('idx_files_exact (size=? AND sha256=? AND rowid>?)'))
  ).toBe(true);
  expect(
    plan.some(({ detail }) => detail.includes('idx_files_status') || detail.includes('TEMP B-TREE'))
  ).toBe(false);
});

it.each(['pending', 'fs_done'])(
  'blocks only the directory owning a %s journal row and allows deletion once it settles',
  (status) => {
    put('one.jpg', 1, 'same');
    db.exec("INSERT INTO scan_dirs(path) VALUES ('/other')");
    db.prepare(
      `INSERT INTO file_operations(kind,file_id,src_path,dst_path,status)
       VALUES ('quarantine',1,'/media/one.jpg','/media/.vvv-trash/one.jpg',?)`
    ).run(status);
    expect(deleteScanDir(db, 1)).toBeNull();
    expect(db.prepare('SELECT scan_dir_id FROM files').all()).toEqual([{ scan_dir_id: 1 }]);
    expect(deleteScanDir(db, 2)).toBe(1);
    expect(deleteScanDir(db, 999)).toBe(0);
    db.prepare('UPDATE file_operations SET status=?').run(
      status === 'pending' ? 'failed' : 'committed'
    );
    expect(deleteScanDir(db, 1)).toBe(1);
    expect(db.prepare('SELECT * FROM scan_dirs').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM files').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM file_operations').all()).toHaveLength(1);
  }
);

it('coalesces scan completion during a match into one subsequent run', async () => {
  const started = vi.spyOn(log, 'info');
  matcher.start();
  matcher.afterScan();
  matcher.afterScan();
  await vi.waitFor(() =>
    expect(started.mock.calls.filter((call) => call[1] === 'Matching activated')).toHaveLength(2)
  );
  await matcher.close();
  expect(activeMatchRun(db)).toBe(2);
});
