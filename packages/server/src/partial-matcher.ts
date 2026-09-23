import type Database from 'better-sqlite3';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { matchingEnabled, matchingSetting, numericSetting } from './matching-settings.js';

// Observed fpcalc output density varies by codec (5.9–7.7 per second across m4a/mp3
// encodes of the same audio), so rate-based estimates are the last resort, used only
// when files.duration_ms is unavailable, which completed files normally carry.
const SUBFINGERPRINTS_PER_SECOND = 7.7;
// Re-encoding flips a handful of low bits per 32-bit subfingerprint (measured across
// aac→mp3→aac chains: median 1–2, p90 3, max 6), while unrelated words sit near 16.
// Words within this distance count as aligned; independent words clear it ~0.35% of
// the time, far below any usable confidence threshold.
const MAX_WORD_DISTANCE = 8;
// Batch sizing mirrors the perceptual matcher: small statements, event-loop yields.
const ANCHOR_BATCH = 16;
const PAIR_BATCH = 200;

export type PartialMatchStats = {
  candidate_pairs: number;
  groups: number;
  hot_values: number;
};

type Sequence = { id: number; values: number[]; durationMs: number | null };
type Verdict = { confidence: number; offset_seconds: number };

/**
 * Directional audio matching over stored Chromaprint subfingerprints.
 *
 * Candidates are pairs of completed files sharing at least audio_candidate_min_shared
 * distinct subfingerprint values, generated entirely inside SQLite in bounded anchor
 * ranges so no pair list is ever held in memory. The floor is deliberately low:
 * re-encoding keeps only a handful of exact values per ten seconds of shared audio,
 * while exact 32-bit collisions between unrelated files are rare enough that such a
 * weak filter produces almost no false candidates. Each candidate is verified
 * independently: the shorter sequence is the potential subset (ties orient toward the
 * lower file id), every shared non-hot value votes for the time shift
 * parent_idx - clip_idx, and the histogram peak aligns the pair. Confidence is then
 * measured bit-tolerantly — the share of subset positions whose word at the aligned
 * parent position differs by at most MAX_WORD_DISTANCE bits — because exact values
 * do not survive re-encoding, but the underlying audio bits largely do. A pair matches when that confidence
 * reaches audio_confidence_threshold percent and the subset is at least
 * audio_min_subset_seconds long; byte-identical pairs stay with the exact matcher.
 * Matched pairs publish as two-member 'audio_partial' groups carrying subset_file_id
 * and offset_seconds, converted onto the superset's own timeline (per-file emission
 * rates differ across codecs, so the shift must scale by the parent's duration).
 * Hot values are excluded from voting as well as candidacy: their occurrence counts
 * multiply across the pair, so a single long silent stretch could cost seconds of
 * synchronous vote work per pair while contributing no alignment information.
 */
export async function matchPartialAudio(
  db: Database.Database,
  run: number,
  refresh: (groupId: number) => void,
  kinds: { images: boolean; videos: boolean; audio: boolean } = {
    images: true,
    videos: true,
    audio: true,
  }
): Promise<PartialMatchStats> {
  if (!matchingEnabled(db, 'audio')) return { candidate_pairs: 0, groups: 0, hot_values: 0 };
  const minShared = matchingSetting(db, 'audio_candidate_min_shared');
  const threshold = matchingSetting(db, 'audio_confidence_threshold');
  const minSeconds = matchingSetting(db, 'audio_min_subset_seconds');
  const hotCap = numericSetting(db, 'phash_bucket_cap', 2000, Number.MAX_SAFE_INTEGER);
  let slice = performance.now();
  const pause = async () => {
    await yieldLoop();
    slice = performance.now();
  };
  // Per-run staging lives in temp tables so nothing pair-shaped reaches JS memory.
  db.exec('CREATE TEMP TABLE audio_hot(value INTEGER PRIMARY KEY)');
  db.exec('CREATE TEMP TABLE audio_candidates(a INTEGER,b INTEGER,PRIMARY KEY(a,b))');
  try {
    // Values shared by too many rows carry no timing information (silence, constant
    // tones); excluding them keeps the join proportional to informative audio, the
    // same hot-bucket contract the perceptual matcher honors, including its
    // done-status census: quarantined rows must not inflate a value's count.
    db.prepare(
      `INSERT INTO audio_hot(value) SELECT s.value FROM audio_subfingerprints s
      JOIN files f ON f.id=s.file_id AND f.status='done'
      WHERE (f.kind='video' AND ?) OR (f.kind='audio' AND ?)
      GROUP BY s.value HAVING count(*)>?`
    ).run(Number(kinds.videos), Number(kinds.audio), hotCap);
    const hot_values = (db.prepare('SELECT count(*) AS n FROM audio_hot').get() as { n: number }).n;
    // The census is a once-per-run snapshot, so the vote-side set is loaded once too;
    // it stays exactly consistent with the temp table for the whole run and is small
    // by construction (a value needs more than cap rows to be hot).
    const hot = new Set<number>(
      (db.prepare('SELECT value FROM audio_hot').all() as { value: number }[]).map(
        (row) => row.value
      )
    );
    const anchors = db.prepare(
      `SELECT id FROM files f WHERE f.id>? AND f.status='done'
      AND ((f.kind='video' AND ?) OR (f.kind='audio' AND ?))
      AND EXISTS(SELECT 1 FROM audio_subfingerprints s WHERE s.file_id=f.id)
      ORDER BY f.id LIMIT ${ANCHOR_BATCH}`
    );
    // The join counts shared values on the SQL side and keeps only pairs above the
    // minimum; anchor ranges partition the work into bounded single passes.
    const join = db.prepare(
      `INSERT INTO audio_candidates(a,b)
      SELECT a.file_id,b.file_id FROM audio_subfingerprints a
      JOIN audio_subfingerprints b ON b.value=a.value AND b.file_id>a.file_id
      WHERE a.file_id>? AND a.file_id<=?
      AND EXISTS(SELECT 1 FROM files f WHERE f.id=a.file_id AND f.status='done' AND ((f.kind='video' AND ?) OR (f.kind='audio' AND ?)))
      AND EXISTS(SELECT 1 FROM files f WHERE f.id=b.file_id AND f.status='done' AND ((f.kind='video' AND ?) OR (f.kind='audio' AND ?)))
      AND a.value NOT IN (SELECT value FROM audio_hot)
      GROUP BY a.file_id,b.file_id HAVING count(DISTINCT a.value)>=?`
    );
    let after = 0;
    let candidate_pairs = 0;
    for (;;) {
      const batch = anchors.all(after, Number(kinds.videos), Number(kinds.audio)) as {
        id: number;
      }[];
      if (!batch.length) break;
      const top = batch[batch.length - 1]!.id;
      candidate_pairs += Number(
        join.run(
          after,
          top,
          Number(kinds.videos),
          Number(kinds.audio),
          Number(kinds.videos),
          Number(kinds.audio),
          minShared
        ).changes
      );
      after = top;
      await pause();
    }
    const create = db.prepare(
      `INSERT INTO dup_groups(kind,member_count,total_bytes,reclaimable_bytes,match_run,
      subset_file_id,offset_seconds) VALUES ('audio_partial',0,0,0,?,?,?)`
    );
    const addMember = db.prepare(
      'INSERT INTO dup_group_members(group_id,file_id,similarity) VALUES (?,?,?)'
    );
    const meta = db.prepare('SELECT status,size,sha256,duration_ms FROM files WHERE id=?');
    const load = db.prepare('SELECT value FROM audio_subfingerprints WHERE file_id=? ORDER BY idx');
    const pending = db.prepare(
      `SELECT a,b FROM audio_candidates WHERE (a,b)>(?,?) ORDER BY a,b LIMIT ${PAIR_BATCH}`
    );
    let groups = 0;
    let lastA = 0,
      lastB = 0;
    for (;;) {
      const batch = pending.all(lastA, lastB) as { a: number; b: number }[];
      if (!batch.length) break;
      for (const { a, b } of batch) {
        lastA = a;
        lastB = b;
        const left = meta.get(a) as
          | { status: string; size: number; sha256: string | null; duration_ms: number | null }
          | undefined;
        const right = meta.get(b) as
          | { status: string; size: number; sha256: string | null; duration_ms: number | null }
          | undefined;
        // Status can flip mid-run; byte-identical pairs belong to the exact matcher.
        if (!left || !right || left.status !== 'done' || right.status !== 'done') continue;
        if (left.size === right.size && left.sha256 !== null && left.sha256 === right.sha256)
          continue;
        const leftValues = (load.all(a) as { value: number }[]).map((row) => row.value);
        const rightValues = (load.all(b) as { value: number }[]).map((row) => row.value);
        const first: Sequence = { id: a, values: leftValues, durationMs: left.duration_ms };
        const second: Sequence = { id: b, values: rightValues, durationMs: right.duration_ms };
        const [subset, parent] =
          first.values.length <= second.values.length ? [first, second] : [second, first];
        const verdict = await verify(subset, parent, threshold, minSeconds, hot);
        if (!verdict) continue;
        const groupId = Number(create.run(run, subset.id, verdict.offset_seconds).lastInsertRowid);
        db.transaction(() => {
          // The alignment confidence is the pair's similarity on both member rows.
          addMember.run(groupId, subset.id, verdict.confidence);
          addMember.run(groupId, parent.id, verdict.confidence);
          refresh(groupId);
        })();
        groups++;
        if (performance.now() - slice >= 15) await pause();
      }
      await pause();
    }
    return { candidate_pairs, groups, hot_values };
  } finally {
    db.exec('DROP TABLE audio_hot');
    db.exec('DROP TABLE audio_candidates');
  }
}

/**
 * Time-shift voting followed by bit-tolerant verification. Exact shared values vote
 * for parent_idx - clip_idx; a genuine subset concentrates its votes on one exact
 * shift, because both sides were sampled by the same fingerprinter, so the peak —
 * never absent when candidates exist — aligns the pair. Hot values are skipped when
 * the parent positions are indexed, so they contribute no votes (and no multiplicative
 * cost); the candidate join guarantees enough non-hot shared values remain. Confidence
 * then counts how many subset positions find a near-identical parent word at that one
 * shift; exact equality would collapse to noise across re-encodes, while the aligned
 * audio keeps its bits. Shifts stay exact integers and ties resolve to the lower
 * shift, keeping verdicts deterministic. Long subsets yield every 15ms like the rest
 * of the pipeline, so verification cannot pin the event loop.
 */
async function verify(
  subset: Sequence,
  parent: Sequence,
  threshold: number,
  minSeconds: number,
  hot: Set<number>
): Promise<Verdict | null> {
  if (!subset.values.length || !parent.values.length) return null;
  let slice = performance.now();
  const maybePause = async () => {
    if (performance.now() - slice >= 15) {
      await yieldLoop();
      slice = performance.now();
    }
  };
  const positions = new Map<number, number[]>();
  for (let index = 0; index < parent.values.length; index++) {
    const value = parent.values[index]!;
    if (!hot.has(value)) {
      const list = positions.get(value);
      if (list) list.push(index);
      else positions.set(value, [index]);
    }
    if ((index & 0x1ff) === 0x1ff) await maybePause();
  }
  // Hot subset values find no indexed positions, so they vote zero times.
  const votes = new Map<number, number>();
  for (let index = 0; index < subset.values.length; index++) {
    for (const parentIndex of positions.get(subset.values[index]!) ?? [])
      votes.set(parentIndex - index, (votes.get(parentIndex - index) ?? 0) + 1);
    if ((index & 0x1ff) === 0x1ff) await maybePause();
  }
  let peak = 0;
  let shift = 0;
  for (const [candidate, count] of votes)
    if (count > peak || (count === peak && candidate < shift)) {
      peak = count;
      shift = candidate;
    }
  if (!peak) return null;
  let hits = 0;
  for (let index = 0; index < subset.values.length; index++) {
    const aligned = index + shift;
    if (
      aligned >= 0 &&
      aligned < parent.values.length &&
      wordDistance(subset.values[index]!, parent.values[aligned]!) <= MAX_WORD_DISTANCE
    )
      hits++;
    if ((index & 0x1ff) === 0x1ff) await maybePause();
  }
  const confidence = (hits / subset.values.length) * 100;
  if (confidence < threshold) return null;
  const durationS =
    subset.durationMs && subset.durationMs > 0
      ? subset.durationMs / 1000
      : subset.values.length / SUBFINGERPRINTS_PER_SECOND;
  if (durationS < minSeconds) return null;
  // The shift counts parent indexes, so the offset lands on the superset's own
  // timeline: its duration divided by its own sequence length. The duration floor
  // above is the only subset-side quantity — it is the subset's physical length.
  const parentDurationS =
    parent.durationMs && parent.durationMs > 0
      ? parent.durationMs / 1000
      : parent.values.length / SUBFINGERPRINTS_PER_SECOND;
  return {
    confidence,
    offset_seconds: Math.round((shift * parentDurationS) / parent.values.length),
  };
}

/** Popcount of the XOR of two unsigned 32-bit subfingerprint words. */
function wordDistance(a: number, b: number) {
  let x = (a ^ b) >>> 0;
  let distance = 0;
  while (x) {
    x &= x - 1;
    distance++;
  }
  return distance;
}
