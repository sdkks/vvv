import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase } from './db.js';
import { Matcher, activeMatchRun, deleteScanDir } from './matcher.js';
import { storeHashes } from './hashing.js';
let root: string;
let db: ReturnType<typeof openDatabase>['db'];
let matcher: Matcher;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vvv-video-match-'));
  db = openDatabase(root).db;
  db.exec("INSERT INTO scan_dirs(path) VALUES ('/media'),('/other')");
  matcher = new Matcher(db, Fastify({ logger: false }).log);
});
afterEach(async () => {
  await matcher.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function put(values: bigint[], status = 'done', dir = 1, sha = String(Math.random())) {
  const id = Number(
    db
      .prepare(
        "INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status,sha256) VALUES (?,?,'video',10,0,?,?)"
      )
      .run(dir, `${Math.random()}.mp4`, status, sha).lastInsertRowid
  );
  db.transaction(() =>
    storeHashes(
      db,
      id,
      values.map((n) => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64BE(n);
        return b;
      })
    )
  )();
  return id;
}
const repeat = (n: bigint) => Array<bigint>(9).fill(n);
async function match() {
  const id = matcher.start();
  await matcher.close();
  expect(activeMatchRun(db)).toBe(id);
}
const groups = () =>
  db.prepare("SELECT id,member_count FROM dup_groups WHERE kind='video'").all() as {
    id: number;
    member_count: number;
  }[];

it.each([10, 11])('verifies mean over all nine frames at threshold %i', async (distance) => {
  put(repeat(0n));
  put(repeat((1n << BigInt(distance)) - 1n));
  await match();
  expect(groups()).toHaveLength(distance === 10 ? 1 : 0);
  if (distance === 10)
    expect(db.prepare('SELECT similarity FROM dup_group_members ORDER BY file_id').all()).toEqual([
      { similarity: 0 },
      { similarity: 10 },
    ]);
  expect(db.prepare('SELECT candidate_pairs FROM match_runs').get()).toEqual({
    candidate_pairs: 1,
  });
});
it('uses aligned frames, not minimum or cross-frame distance, and refuses partial sequences', async () => {
  put([0n, ...Array<bigint>(8).fill(0xffffffffffffffffn)]);
  put([0n, ...Array<bigint>(8).fill(0n)]);
  put([0n]);
  await match();
  expect(groups()).toEqual([]);
  expect(db.prepare('SELECT candidate_pairs FROM match_runs').get()).toEqual({
    candidate_pairs: 1,
  });
});
it('never retrieves from unequal frame indices even with a permissive verification threshold', async () => {
  db.exec("INSERT INTO settings VALUES ('video_phash_threshold','64')");
  const a = Array.from({ length: 9 }, (_, i) => BigInt(i) * 0x0101010101010101n);
  const b = a.map((_, i) => a[(i + 1) % 9]!);
  // Remove all but one band row on each side; only cross-index rows collide.
  const one = put(a),
    two = put(b);
  db.prepare('DELETE FROM phash_bands WHERE file_id=? AND (frame_idx<>0 OR band_idx<>0)').run(one);
  db.prepare('DELETE FROM phash_bands WHERE file_id=? AND (frame_idx<>8 OR band_idx<>0)').run(two);
  await match();
  expect(groups()).toEqual([]);
  expect(db.prepare('SELECT candidate_pairs FROM match_runs').get()).toEqual({
    candidate_pairs: 0,
  });
});
it('publishes fractional mean reference distances, seeds exact components and refreshes a removed reference', async () => {
  put(repeat(0n), 'done', 1);
  const next = put([63n, ...Array<bigint>(8).fill(0n)], 'done', 2, 'same');
  const copy = put([63n, ...Array<bigint>(8).fill(0n)], 'done', 2, 'same');
  const last = put([4095n, ...Array<bigint>(8).fill(0n)], 'done', 2);
  await match();
  expect(groups()).toMatchObject([{ member_count: 4 }]);
  const distances = () =>
    db
      .prepare('SELECT file_id,similarity FROM dup_group_members WHERE group_id=? ORDER BY file_id')
      .all(groups()[0]!.id);
  expect(distances()).toMatchObject([
    { similarity: 0 },
    { similarity: 6 / 9 },
    { similarity: 6 / 9 },
    { similarity: 12 / 9 },
  ]);
  deleteScanDir(db, 1);
  expect(distances()).toEqual([
    { file_id: next, similarity: 0 },
    { file_id: copy, similarity: 0 },
    { file_id: last, similarity: 6 / 9 },
  ]);
});
it('counts only active same-kind frame buckets, skips hot buckets, and stores replacement frames', async () => {
  db.exec("INSERT INTO settings VALUES ('phash_bucket_cap','2')");
  const first = put(repeat(0n));
  put(repeat(0n));
  for (const status of ['pending', 'hashed', 'error', 'quarantined', 'missing'])
    put(repeat(0n), status);
  await match();
  expect(groups()).toHaveLength(1);
  expect(db.prepare('SELECT skipped_buckets FROM match_runs').get()).toEqual({
    skipped_buckets: '[]',
  });
  put(repeat(0n));
  await match();
  expect(groups()).toEqual([]);
  const skipped = JSON.parse(
    (db.prepare('SELECT skipped_buckets FROM match_runs').get() as { skipped_buckets: string })
      .skipped_buckets
  ) as unknown[];
  expect(skipped).toHaveLength(36);
  expect(skipped).toContainEqual({ band_idx: 3, frame_idx: 8, band_val: 0, size: 3 });
  db.transaction(() =>
    storeHashes(
      db,
      first,
      repeat(1n).map(() => Buffer.alloc(8, 255))
    )
  )();
  expect(db.prepare('SELECT count(*) AS n FROM phashes WHERE file_id=?').get(first)).toEqual({
    n: 9,
  });
  expect(db.prepare('SELECT count(*) AS n FROM phash_bands WHERE file_id=?').get(first)).toEqual({
    n: 36,
  });
});
