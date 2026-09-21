import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDatabase } from './db.js';
import { activeMatchRun, deleteScanDir, Matcher } from './matcher.js';
import { storeImageHash } from './hashing.js';
let root: string;
let db: ReturnType<typeof openDatabase>['db'];
let matcher: Matcher;
const log = Fastify({ logger: false }).log;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vvv-image-match-'));
  db = openDatabase(root).db;
  db.exec("INSERT INTO scan_dirs(path) VALUES ('/media'),('/other')");
  matcher = new Matcher(db, log);
});
afterEach(async () => {
  await matcher.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function put(n: bigint, sha?: string, status = 'done', dir = 1, kind = 'image') {
  const id = Number(
    db
      .prepare(
        `INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status,sha256)
    VALUES (?,?,?,10,0,?,?)`
      )
      .run(dir, `${Math.random()}.jpg`, kind, status, sha ?? String(n)).lastInsertRowid
  );
  const hash = Buffer.alloc(8);
  hash.writeBigUInt64BE(n);
  db.transaction(() => storeImageHash(db, id, hash))();
  return id;
}
const groups = () =>
  db.prepare('SELECT id,kind,member_count FROM dup_groups ORDER BY id').all() as {
    id: number;
    kind: string;
    member_count: number;
  }[];
async function match() {
  const run = matcher.start();
  await matcher.close();
  expect(activeMatchRun(db)).toBe(run);
  return run;
}

it.each([6, 7])('verifies the default threshold boundary at distance %i', async (distance) => {
  put(0n);
  put((1n << BigInt(distance)) - 1n);
  await match();
  expect(groups()).toHaveLength(distance === 6 ? 1 : 0);
  expect(db.prepare('SELECT candidate_pairs FROM match_runs').get()).toEqual({
    candidate_pairs: 1,
  });
});
it('merges exact and perceptual edges, keeps exact-only groups, and measures to the smallest id', async () => {
  const ids = [put(0n, 'same'), put(0n, 'same'), put(63n), put(4095n)];
  put(0xffffffffffffffffn, 'other');
  put(0xffffffffffffffffn, 'other');
  for (const status of ['pending', 'hashed', 'error', 'missing', 'quarantined'])
    put(0n, status, status);
  put(0n, 'video', 'done', 1, 'video');
  await match();
  expect(groups().map(({ kind, member_count }) => ({ kind, member_count }))).toEqual([
    { kind: 'exact', member_count: 2 },
    { kind: 'exact', member_count: 2 },
    { kind: 'image', member_count: 4 },
  ]);
  expect(
    db
      .prepare(`SELECT file_id,similarity FROM dup_group_members WHERE group_id=? ORDER BY file_id`)
      .all(groups()[2]!.id)
  ).toEqual(ids.map((file_id, i) => ({ file_id, similarity: [0, 0, 6, 12][i] })));
  expect(
    db
      .prepare(
        `SELECT count(*) AS n FROM dup_group_members m JOIN dup_groups g ON g.id=m.group_id
    WHERE g.kind='exact' AND m.similarity IS NOT NULL`
      )
      .get()
  ).toEqual({ n: 0 });
  expect(db.prepare('SELECT candidate_pairs FROM match_runs').get()).toEqual({
    candidate_pairs: 5,
  });
  await match();
  expect(db.prepare('SELECT count(*) AS n FROM match_runs').get()).toEqual({ n: 1 });
});
it('records skipped hot buckets, excludes exact pairs and preserves exact matching', async () => {
  db.exec("INSERT INTO settings VALUES ('phash_bucket_cap','2')");
  put(0n, 'same');
  put(0n, 'same');
  put(0n, 'other');
  await match();
  expect(groups().map(({ kind }) => kind)).toEqual(['exact']);
  const run = db.prepare('SELECT candidate_pairs,skipped_buckets FROM match_runs').get() as {
    candidate_pairs: number;
    skipped_buckets: string;
  };
  expect(run.candidate_pairs).toBe(0);
  expect(JSON.parse(run.skipped_buckets)).toEqual(
    [0, 1, 2, 3].map((band_idx) => ({ band_idx, frame_idx: 0, band_val: 0, size: 3 }))
  );
  db.exec("UPDATE settings SET value='3' WHERE key='phash_bucket_cap'");
  await match();
  expect(groups().map(({ kind }) => kind)).toEqual(['exact', 'image']);
  expect(db.prepare('SELECT candidate_pairs FROM match_runs').get()).toEqual({
    candidate_pairs: 2,
  });
});
it('counts only active image frame-zero rows when deciding and reporting hot buckets', async () => {
  db.exec("INSERT INTO settings VALUES ('phash_bucket_cap','2')");
  const first = put(0n, 'first');
  put(0n, 'second');
  for (const status of ['missing', 'error', 'quarantined', 'pending', 'hashed'])
    for (let i = 0; i < 25; i++) put(0n, `${status}-${i}`, status);
  put(0n, 'video', 'done', 1, 'video');
  for (let band = 0; band < 4; band++)
    db.prepare('INSERT INTO phash_bands VALUES (?,1,0,?)').run(band, first);
  await match();
  expect(groups()).toMatchObject([{ kind: 'image', member_count: 2 }]);
  expect(db.prepare('SELECT candidate_pairs,skipped_buckets FROM match_runs').get()).toEqual({
    candidate_pairs: 1,
    skipped_buckets: '[]',
  });
  put(0n, 'third');
  await match();
  expect(groups()).toEqual([]);
  const run = db.prepare('SELECT skipped_buckets FROM match_runs').get() as {
    skipped_buckets: string;
  };
  expect(JSON.parse(run.skipped_buckets)).toEqual(
    [0, 1, 2, 3].map((band_idx) => ({ band_idx, frame_idx: 0, band_val: 0, size: 3 }))
  );
});
it('can retrieve via a later usable band when earlier buckets are hot', async () => {
  db.exec("INSERT INTO settings VALUES ('phash_bucket_cap','2')");
  put(0x1234567800000000n);
  put(0x1234567800000001n);
  put(0xffffeeee00000000n);
  await match();
  expect(groups()).toMatchObject([{ kind: 'image', member_count: 2 }]);
});
it('recomputes the reference distance when its scan directory is removed', async () => {
  put(0n, 'one');
  const second = put(63n, 'two', 'done', 2);
  const third = put(4095n, 'three', 'done', 2);
  await match();
  deleteScanDir(db, 1);
  expect(groups()).toMatchObject([{ kind: 'image', member_count: 2 }]);
  expect(
    db.prepare('SELECT file_id,similarity FROM dup_group_members ORDER BY file_id').all()
  ).toEqual([
    { file_id: second, similarity: 0 },
    { file_id: third, similarity: 6 },
  ]);
});
it('keeps chunked image publication invisible and consistent if the reference directory disappears', async () => {
  db.transaction(() => {
    put(0n, 'base', 'done', 1);
    for (let i = 0; i < 1001; i++) put(1n, 'copies', 'done', 2);
  })();
  const old = await match();
  const run = matcher.start();
  let sawBuilding = false;
  while (activeMatchRun(db) === old) {
    await tick();
    const row = db
      .prepare("SELECT id FROM dup_groups WHERE match_run=? AND kind='image'")
      .get(run) as { id: number } | undefined;
    if (row && !sawBuilding) {
      expect(
        db.prepare('SELECT count(*) AS n FROM dup_group_members WHERE group_id=?').get(row.id)
      ).toEqual({ n: 1000 });
      deleteScanDir(db, 1);
      sawBuilding = true;
    }
  }
  await matcher.close();
  expect(sawBuilding).toBe(true);
  expect(groups().find(({ kind }) => kind === 'image')).toMatchObject({ member_count: 1001 });
  expect(
    db.prepare('SELECT count(*) AS n FROM dup_group_members WHERE similarity<>0').get()
  ).toEqual({ n: 0 });
}, 15000);
