import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDatabase } from './db.js';
import { Matcher, refreshFileGroups, refreshGroup } from './matcher.js';
import { matchPartialAudio } from './partial-matcher.js';

let root: string;
let db: ReturnType<typeof openDatabase>['db'];
let matcher: Matcher;
const log = Fastify({ logger: false }).log;
// The same refresh the match-run lifecycle passes, so aggregates stay live in assertions.
const refresh = (groupId: number) => refreshGroup(db, groupId);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vvv-partial-'));
  ({ db } = openDatabase(root));
  db.exec("INSERT INTO scan_dirs(path) VALUES ('/media')");
  matcher = new Matcher(db, log);
  // Direct matchPartialAudio calls publish into a run row, like the real lifecycle.
  insertRun(1);
});
afterEach(async () => {
  await matcher.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function putFile(
  path: string,
  options: { size?: number; sha?: string | null; durationMs?: number | null; kind?: string } = {}
) {
  return Number(
    db
      .prepare(
        `INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status,sha256,duration_ms)
      VALUES (1,?,?,?,0,'done',?,?)`
      )
      .run(
        path,
        options.kind ?? 'audio',
        options.size ?? 100,
        options.sha ?? null,
        options.durationMs ?? null
      ).lastInsertRowid
  );
}
function fingerprint(id: number, values: number[]) {
  const insert = db.prepare('INSERT INTO audio_subfingerprints(file_id,idx,value) VALUES (?,?,?)');
  db.transaction(() => values.forEach((value, idx) => insert.run(id, idx, value)))();
}
const sequence = (base: number, length: number) =>
  Array.from({ length }, (_, index) => base + index);
const groups = () =>
  db
    .prepare(
      `SELECT g.subset_file_id AS subset,g.offset_seconds AS offset,g.member_count,
    (SELECT similarity FROM dup_group_members m WHERE m.group_id=g.id
      AND m.file_id=g.subset_file_id) AS subset_similarity,
    (SELECT similarity FROM dup_group_members m WHERE m.group_id=g.id
      AND m.file_id<>g.subset_file_id) AS superset_similarity
    FROM dup_groups g WHERE g.kind='audio_partial' ORDER BY g.subset_file_id`
    )
    .all();
const setting = (key: string, value: string) =>
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(key, value);
const insertRun = (id: number) =>
  db.prepare("INSERT INTO match_runs(id,status) VALUES (?,'building')").run(id);

it('detects a subset with offset and confidence on both members', async () => {
  const clip = putFile('clip.mp3', { durationMs: 5000, size: 400 });
  const parent = putFile('parent.mp3', { durationMs: 8000, size: 600 });
  fingerprint(clip, sequence(1000, 40));
  fingerprint(parent, [...sequence(500, 10), ...sequence(1000, 40), 9999]);
  const stats = await matchPartialAudio(db, 1, refresh);
  expect(stats).toEqual({ candidate_pairs: 1, groups: 1, hot_values: 0 });
  // Offset lands on the superset's timeline: shift 10 of the parent's 51 values over
  // 8s is 1.57s, which rounds to 2.
  expect(groups()).toEqual([
    {
      subset: clip,
      offset: 2,
      member_count: 2,
      subset_similarity: 100,
      superset_similarity: 100,
    },
  ]);
  const aggregates = db
    .prepare('SELECT total_bytes,reclaimable_bytes FROM dup_groups WHERE kind=?')
    .get('audio_partial') as { total_bytes: number; reclaimable_bytes: number };
  expect(aggregates).toEqual({ total_bytes: 1000, reclaimable_bytes: 400 });
});

it('leaves unrelated audio ungrouped', async () => {
  const one = putFile('one.mp3', { durationMs: 5000 });
  const two = putFile('two.mp3', { durationMs: 5000 });
  fingerprint(one, sequence(1000, 40));
  fingerprint(two, sequence(5000, 40));
  const stats = await matchPartialAudio(db, 1, refresh);
  expect(stats).toEqual({ candidate_pairs: 0, groups: 0, hot_values: 0 });
  expect(groups()).toEqual([]);
});

it('honors the confidence threshold inclusively and reads it from settings', async () => {
  const clip = putFile('clip.mp3', { durationMs: 5000 });
  const parent = putFile('parent.mp3', { durationMs: 6000 });
  // Twenty of the clip's forty values align: exactly the default 50% threshold. The
  // mismatched tail sits far from the parent's own tail in bits (synthetic sequences
  // must keep their distance, or unrelated words pass the 8-bit tolerance), so only
  // the aligned half verifies.
  const strayA = 0x0000f000;
  const strayB = 0x0fff0000;
  fingerprint(clip, [...sequence(1000, 20), ...sequence(strayA, 20)]);
  fingerprint(parent, [...sequence(50, 10), ...sequence(1000, 20), ...sequence(strayB, 15)]);
  expect((await matchPartialAudio(db, 1, refresh)).groups).toBe(1);
  setting('audio_confidence_threshold', '51');
  insertRun(2);
  expect((await matchPartialAudio(db, 2, refresh)).groups).toBe(0);
});

it('enforces the minimum subset duration with a settings override', async () => {
  const clip = putFile('clip.mp3', { durationMs: 3000 });
  const parent = putFile('parent.mp3', { durationMs: 8000 });
  fingerprint(clip, sequence(1000, 40));
  fingerprint(parent, [...sequence(50, 10), ...sequence(1000, 40), ...sequence(70, 15)]);
  expect((await matchPartialAudio(db, 1, refresh)).groups).toBe(0);
  setting('audio_min_subset_seconds', '3');
  insertRun(2);
  expect((await matchPartialAudio(db, 2, refresh)).groups).toBe(1);
});

it('derives the offset from stored subfingerprints when duration is missing', async () => {
  const clip = putFile('clip.mp3', { durationMs: null });
  const parent = putFile('parent.mp3', { durationMs: null });
  fingerprint(clip, sequence(1000, 60));
  fingerprint(parent, [...sequence(50, 12), ...sequence(1000, 60)]);
  const stats = await matchPartialAudio(db, 1, refresh);
  // 60 values at ~7.7/s is long enough for the duration floor; shift 12 ≈ 1.56s.
  expect(stats.groups).toBe(1);
  expect(groups()).toEqual([
    { subset: clip, offset: 2, member_count: 2, subset_similarity: 100, superset_similarity: 100 },
  ]);
});

it('keeps byte-identical pairs with the exact matcher', async () => {
  putFile('a.mp3', { size: 500, sha: 'same', durationMs: 5000 });
  putFile('b.mp3', { size: 500, sha: 'same', durationMs: 5000 });
  const values = sequence(1000, 40);
  fingerprint(1, values);
  fingerprint(2, values);
  matcher.start();
  await matcher.close();
  expect(db.prepare("SELECT count(*) AS n FROM dup_groups WHERE kind='exact'").get()).toEqual({
    n: 1,
  });
  expect(
    db.prepare("SELECT count(*) AS n FROM dup_groups WHERE kind='audio_partial'").get()
  ).toEqual({
    n: 0,
  });
});

it('orients equal-length pairs toward the lower file id', async () => {
  const first = putFile('a.mp3', { size: 100, durationMs: 5000 });
  const second = putFile('b.mp3', { size: 200, durationMs: 5000 });
  const values = sequence(1000, 40);
  fingerprint(first, values);
  fingerprint(second, values);
  await matchPartialAudio(db, 1, refresh);
  expect(groups()).toEqual([
    {
      subset: Math.min(first, second),
      offset: 0,
      member_count: 2,
      subset_similarity: 100,
      superset_similarity: 100,
    },
  ]);
});

it('publishes chains as separate directional groups, never one union', async () => {
  const a = putFile('a.mp3', { durationMs: 5000 });
  const b = putFile('b.mp3', { durationMs: 6000 });
  const c = putFile('c.mp3', { durationMs: 7000 });
  const inner = sequence(1000, 40);
  const middle = [...sequence(50, 5), ...inner, ...sequence(60, 5)];
  fingerprint(a, inner);
  fingerprint(b, middle);
  fingerprint(c, [...sequence(70, 3), ...middle]);
  await matchPartialAudio(db, 1, refresh);
  // A⊂B at 1s, B⊂C at 0s, and the transitive A⊂C at 1s — three independent verdicts.
  expect(groups()).toEqual([
    { subset: a, offset: 1, member_count: 2, subset_similarity: 100, superset_similarity: 100 },
    { subset: a, offset: 1, member_count: 2, subset_similarity: 100, superset_similarity: 100 },
    { subset: b, offset: 0, member_count: 2, subset_similarity: 100, superset_similarity: 100 },
  ]);
  const members = db
    .prepare(
      'SELECT m.file_id FROM dup_group_members m JOIN dup_groups g ON g.id=m.group_id WHERE g.subset_file_id=?'
    )
    .all(a) as { file_id: number }[];
  expect(members.map((row) => row.file_id).sort((x, y) => x - y)).toEqual([a, a, a + 1, a + 2]);
});

it('dissolves directional groups when either member leaves done status, and re-matches regenerate', async () => {
  const clip1 = putFile('clip1.mp3', { durationMs: 5000 });
  const parent1 = putFile('parent1.mp3', { durationMs: 8000 });
  const clip2 = putFile('clip2.mp3', { durationMs: 5000 });
  const parent2 = putFile('parent2.mp3', { durationMs: 8000 });
  fingerprint(clip1, sequence(1000, 40));
  fingerprint(parent1, [...sequence(50, 10), ...sequence(1000, 40)]);
  fingerprint(clip2, sequence(2000, 40));
  fingerprint(parent2, [...sequence(60, 10), ...sequence(2000, 40)]);
  matcher.start();
  await matcher.close();
  expect(
    db.prepare("SELECT count(*) AS n FROM dup_groups WHERE kind='audio_partial'").get()
  ).toEqual({
    n: 2,
  });
  // Quarantining the subset of the first pair dissolves exactly that group.
  db.prepare("UPDATE files SET status='quarantined' WHERE id=?").run(clip1);
  refreshFileGroups(db, clip1);
  expect(
    db
      .prepare('SELECT subset_file_id FROM dup_groups WHERE kind=? ORDER BY subset_file_id')
      .all('audio_partial')
  ).toEqual([{ subset_file_id: clip2 }]);
  // Quarantining the superset of the second pair dissolves it too.
  db.prepare("UPDATE files SET status='quarantined' WHERE id=?").run(parent2);
  refreshFileGroups(db, parent2);
  expect(
    db.prepare("SELECT count(*) AS n FROM dup_groups WHERE kind='audio_partial'").get()
  ).toEqual({
    n: 0,
  });
  // Both files restored: the next match run regenerates the directional groups.
  db.prepare("UPDATE files SET status='done' WHERE id IN (?,?)").run(clip1, parent2);
  matcher.start();
  await matcher.close();
  expect(
    db
      .prepare('SELECT subset_file_id FROM dup_groups WHERE kind=? ORDER BY subset_file_id')
      .all('audio_partial')
  ).toEqual([{ subset_file_id: clip1 }, { subset_file_id: clip2 }]);
  expect(db.prepare('SELECT count(*) AS n FROM match_runs').get()).toEqual({ n: 1 });
});

it('skips partial matching entirely when audio matching is disabled', async () => {
  setting('match_audio_enabled', '0');
  const clip = putFile('clip.mp3', { durationMs: 5000 });
  const parent = putFile('parent.mp3', { durationMs: 8000 });
  fingerprint(clip, sequence(1000, 40));
  fingerprint(parent, [...sequence(50, 10), ...sequence(1000, 40)]);
  const stats = await matchPartialAudio(db, 1, refresh);
  expect(stats).toEqual({ candidate_pairs: 0, groups: 0, hot_values: 0 });
  matcher.start();
  await matcher.close();
  expect(
    db.prepare("SELECT count(*) AS n FROM dup_groups WHERE kind='audio_partial'").get()
  ).toEqual({
    n: 0,
  });
});

it('counts shared values in SQL across bounded batches without losing pairs', async () => {
  const pairCount = 450;
  db.transaction(() => {
    for (let pair = 0; pair < pairCount; pair++) {
      const base = 1000 + pair * 100;
      const clip = putFile(`clip-${pair}.mp3`, { durationMs: 5000, size: 100 + pair });
      // The parent's duration drives the offset conversion (the shift counts parent
      // indexes), so it must scale with the subset's here: shift 10 of 50 values over
      // 5s is exactly 1s.
      const parent = putFile(`parent-${pair}.mp3`, { durationMs: 5000, size: 200 + pair });
      fingerprint(clip, sequence(base, 40));
      fingerprint(parent, [...sequence(base - 10, 10), ...sequence(base, 40)]);
    }
  })();
  matcher.start();
  await matcher.close();
  expect(
    db.prepare("SELECT count(*) AS n FROM dup_groups WHERE kind='audio_partial'").get()
  ).toEqual({
    n: pairCount,
  });
  expect(
    db
      .prepare(
        "SELECT count(*) AS n FROM dup_group_members m JOIN dup_groups g ON g.id=m.group_id WHERE g.kind='audio_partial'"
      )
      .get()
  ).toEqual({ n: pairCount * 2 });
  const offsets = db
    .prepare("SELECT count(*) AS n FROM dup_groups WHERE kind='audio_partial' AND offset_seconds=1")
    .get() as { n: number };
  expect(offsets.n).toBe(pairCount);
});

it('excludes over-common values from candidate generation via the bucket cap', async () => {
  const clip = putFile('clip.mp3', { durationMs: 5000 });
  const parent = putFile('parent.mp3', { durationMs: 8000 });
  // Thirty shared values, each repeated six times per file; with the cap at five they
  // are all "hot" and the pair has no informative shared values left.
  const values = sequence(1000, 30).flatMap((value) => Array.from({ length: 6 }, () => value));
  fingerprint(clip, values);
  fingerprint(parent, [...sequence(50, 5), ...values]);
  setting('phash_bucket_cap', '5');
  expect((await matchPartialAudio(db, 1, refresh)).groups).toBe(0);
  setting('phash_bucket_cap', '2000');
  insertRun(2);
  expect((await matchPartialAudio(db, 2, refresh)).groups).toBe(1);
});

it('matches a pair sharing a hot value through its non-hot votes alone', async () => {
  const clip = putFile('clip.mp3', { durationMs: 5000 });
  const parent = putFile('parent.mp3', { durationMs: null });
  // Sixty rows of one value make it hot on both sides. Its same-index self-alignment
  // would dominate the histogram if hot values voted (thirty votes on shift 0 against
  // five informative ones) and drag the verdict to offset 0; the informative tail
  // truly aligns at shift 5, so the offset below proves hot values never voted.
  const repeated = Array.from({ length: 30 }, () => 7);
  fingerprint(clip, [...repeated, ...sequence(1000, 5)]);
  fingerprint(parent, [...repeated, ...sequence(50, 5), ...sequence(1000, 5)]);
  setting('phash_bucket_cap', '5');
  expect((await matchPartialAudio(db, 1, refresh)).hot_values).toBe(1);
  // Shift 5 over the parent's 40 values at ~7.7/s (no stored duration) rounds to 1s.
  expect(groups()).toEqual([
    { subset: clip, offset: 1, member_count: 2, subset_similarity: 100, superset_similarity: 100 },
  ]);
});

it('counts hot values only from done files, like every other matching stage', async () => {
  const done = putFile('done.mp3', { durationMs: 5000 });
  const quarantined = putFile('gone.mp3', { durationMs: 5000 });
  db.prepare("UPDATE files SET status='quarantined' WHERE id=?").run(quarantined);
  // Both values have six rows, over the cap of five — but quarantined audio is
  // invisible to candidates and verification, so its rows must not inflate the
  // census either: only the done file's value is hot.
  fingerprint(
    done,
    Array.from({ length: 6 }, () => 8)
  );
  fingerprint(
    quarantined,
    Array.from({ length: 6 }, () => 9)
  );
  setting('phash_bucket_cap', '5');
  expect((await matchPartialAudio(db, 1, refresh)).hot_values).toBe(1);
});

it('seeks candidates through the value index instead of scanning subfingerprints', async () => {
  const prepare = vi.spyOn(Database.prototype, 'prepare');
  putFile('clip.mp3', { durationMs: 5000 });
  putFile('parent.mp3', { durationMs: 8000 });
  fingerprint(1, sequence(1000, 40));
  fingerprint(2, [...sequence(50, 10), ...sequence(1000, 40)]);
  await matchPartialAudio(db, 1, refresh);
  const sql = prepare.mock.calls.find(([query]) =>
    query.startsWith('INSERT INTO audio_candidates')
  )?.[0];
  prepare.mockRestore();
  expect(sql).toBeDefined();
  db.exec('CREATE TEMP TABLE audio_hot(value INTEGER PRIMARY KEY)');
  db.exec('CREATE TEMP TABLE audio_candidates(a INTEGER,b INTEGER,PRIMARY KEY(a,b))');
  try {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0, 100, 20) as { detail: string }[];
    expect(
      plan.some(({ detail }) =>
        detail.includes('SEARCH b USING INDEX idx_audio_subfingerprints_value (value=?)')
      )
    ).toBe(true);
    expect(
      plan.some(({ detail }) =>
        detail.includes('SEARCH a USING INDEX sqlite_autoindex_audio_subfingerprints_1')
      )
    ).toBe(true);
    expect(
      plan.some(({ detail }) => detail.includes('USING ROWID SEARCH ON TABLE audio_hot'))
    ).toBe(true);
  } finally {
    db.exec('DROP TABLE audio_hot');
    db.exec('DROP TABLE audio_candidates');
  }
});
