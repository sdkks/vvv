import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import type { ScanLog } from './scan-log.js';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { hamming } from './hashing.js';
import { matchPerceptual } from './perceptual-matcher.js';
import { matchPartialAudio } from './partial-matcher.js';

type Candidate = { size: number; sha256: string };
export function refreshGroup(db: Database.Database, id: number, scanDirId = 0) {
  db.prepare(
    `DELETE FROM dup_group_members AS m WHERE group_id=? AND EXISTS (
    SELECT 1 FROM files f WHERE f.id=m.file_id
    AND (f.scan_dir_id=? OR f.status NOT IN ('done','quarantined')))`
  ).run(id, scanDirId);
  db.prepare(
    `UPDATE dup_groups SET (member_count,total_bytes,reclaimable_bytes)=(
    SELECT count(*),coalesce(sum(f.size),0),coalesce(sum(f.size)-max(f.size),0)
    FROM dup_group_members m JOIN files f ON f.id=m.file_id
    WHERE m.group_id=? AND f.status='done') WHERE id=?`
  ).run(id, id);
  db.prepare(
    `UPDATE dup_group_members AS m SET similarity=(
      SELECT avg(phash_distance(p.hash,r.hash)) FROM phashes p
      JOIN phashes r ON r.frame_idx=p.frame_idx WHERE p.file_id=m.file_id
      AND r.file_id=(SELECT min(n.file_id) FROM dup_group_members n JOIN files f ON f.id=n.file_id
        WHERE n.group_id=m.group_id AND f.status='done'))
    WHERE group_id=? AND EXISTS (SELECT 1 FROM dup_groups WHERE id=? AND kind IN ('image','video'))`
  ).run(id, id);
}
/**
 * Refresh every group a file belongs to after its status changed. Directional
 * audio_partial groups hold exactly the two members of a subset/superset relation and
 * dissolve under the same rule as every other kind: a quarantined or re-scanned member
 * stops counting toward member_count, which drops a two-member group below two and
 * deletes it. That is the intended directional semantics — a clip without its source
 * is not actionable, and neither is a source whose clip is gone. Groups come back when
 * the next match run re-verifies the restored pair.
 */
export function refreshFileGroups(db: Database.Database, fileId: number) {
  let after = 0;
  for (;;) {
    const rows = db
      .prepare(
        `SELECT group_id AS id FROM dup_group_members
      WHERE file_id=? AND group_id>? ORDER BY group_id LIMIT 100`
      )
      .all(fileId, after) as { id: number }[];
    if (!rows.length) break;
    for (const { id } of rows) {
      refreshGroup(db, id);
      db.prepare('DELETE FROM dup_groups WHERE id=? AND member_count<2 AND match_run=?').run(
        id,
        activeMatchRun(db)
      );
      after = id;
    }
  }
}
export function deleteScanDir(db: Database.Database, scanDirId: number): number | null {
  const remove = db.transaction(() => {
    // Hold the writer lock from the journal check through all catalog deletions.
    const pending = db
      .prepare(
        `SELECT 1 FROM file_operations o JOIN files f ON f.id=o.file_id
        WHERE o.status != 'committed' AND o.status IN ('pending','fs_done') AND f.scan_dir_id=? LIMIT 1`
      )
      .get(scanDirId);
    if (pending) return null;
    const active = activeMatchRun(db);
    const affected = db.prepare(`SELECT g.id FROM dup_groups g WHERE g.id>?
      AND (g.match_run=? OR g.match_run IN (SELECT id FROM match_runs WHERE status='building'))
      AND EXISTS (SELECT 1 FROM dup_group_members m JOIN files f ON f.id=m.file_id
        WHERE m.group_id=g.id AND f.scan_dir_id=?) ORDER BY g.id LIMIT 1000`);
    let after = 0;
    for (;;) {
      const batch = affected.all(after, active, scanDirId) as { id: number }[];
      if (!batch.length) break;
      for (const { id } of batch) {
        refreshGroup(db, id, scanDirId);
        // A building group may still be receiving member chunks; keep its id until activation.
        db.prepare('DELETE FROM dup_groups WHERE id=? AND member_count<2 AND match_run=?').run(
          id,
          active
        );
        after = id;
      }
    }
    return db.prepare('DELETE FROM scan_dirs WHERE id=?').run(scanDirId).changes;
  });
  return remove.immediate();
}
export function activeMatchRun(db: Database.Database): number | null {
  const row = db.prepare("SELECT value FROM settings WHERE key='active_match_run'").get() as
    { value: string } | undefined;
  return row ? Number(row.value) : null;
}
/** Most recent scan id, or 0 before the first scan; manual match runs log under it. */
export function latestScan(db: Database.Database): number {
  const row = db.prepare('SELECT max(id) AS id FROM scans').get() as { id: number | null };
  return row.id ?? 0;
}
export class Matcher {
  private task?: Promise<void>;
  private queued = false;
  private logScanId?: number;
  constructor(
    private db: Database.Database,
    private log: FastifyBaseLogger,
    private logs?: ScanLog
  ) {
    db.function('phash_distance', { deterministic: true }, (a, b) =>
      a instanceof Uint8Array && b instanceof Uint8Array ? hamming(a, b) : null
    );
    db.exec("UPDATE match_runs SET status='superseded' WHERE status='building'");
  }
  /** Called when a scan completes; the triggered match run logs under that scan. */
  afterScan(scanId: number) {
    this.logScanId = scanId;
    if (this.task) this.queued = true;
    else this.start();
  }
  start(): number | null {
    if (this.task) return null;
    const id = Number(
      this.db.prepare("INSERT INTO match_runs(status) VALUES ('building')").run().lastInsertRowid
    );
    this.task = this.run(id)
      .catch((error: unknown) => {
        this.db
          .prepare("UPDATE match_runs SET status='superseded' WHERE id=? AND status='building'")
          .run(id);
        this.log.error({ match_run: id, err: error }, 'Matching failed');
        this.logs?.add(
          this.logScanId ?? latestScan(this.db),
          'error',
          'complete',
          `Matching failed — run ${id}`
        );
      })
      .finally(() => {
        this.task = undefined;
        if (this.queued) {
          this.queued = false;
          this.start();
        }
      });
    return id;
  }
  async close() {
    this.queued = false;
    await this.task;
  }
  private async run(id: number) {
    await yieldLoop();
    const db = this.db;
    // Match timing lands in the triggering scan's ring; manual runs use the latest scan.
    const scanId = this.logScanId ?? latestScan(db);
    this.logScanId = undefined;
    const startedAt = Date.now();
    this.log.info({ match_run: id }, 'Matching started');
    this.logs?.add(scanId, 'info', 'match', `Matching started — run ${id}`);
    const candidates = db.prepare(`SELECT size,sha256 FROM files INDEXED BY idx_files_exact
      WHERE status='done' AND sha256 IS NOT NULL AND (size,sha256)>(?,?)
      GROUP BY size,sha256 HAVING count(*)>1 ORDER BY size,sha256 LIMIT 1000`);
    const group =
      db.prepare(`INSERT INTO dup_groups(kind,member_count,total_bytes,reclaimable_bytes,match_run)
      VALUES ('exact',0,0,0,?)`);
    const members = db.prepare(`INSERT INTO dup_group_members(group_id,file_id)
      SELECT ?,id FROM files INDEXED BY idx_files_exact
      WHERE status='done' AND size=? AND sha256=? AND id>?
      ORDER BY id LIMIT ?`);
    let size = -1,
      hash = '';
    for (;;) {
      const batch = candidates.all(size, hash) as Candidate[];
      if (!batch.length) break;
      let index = 0,
        groupId = 0,
        after = 0;
      while (index < batch.length) {
        db.transaction(() => {
          let budget = 10000;
          while (index < batch.length && budget > 0) {
            const item = batch[index]!;
            if (!groupId) groupId = Number(group.run(id).lastInsertRowid);
            const { changes } = members.run(groupId, item.size, item.sha256, after, budget);
            if (changes < budget) {
              refreshGroup(db, groupId);
              index++;
              groupId = 0;
              after = 0;
            } else
              after = (
                db
                  .prepare('SELECT max(file_id) AS id FROM dup_group_members WHERE group_id=?')
                  .get(groupId) as { id: number }
              ).id;
            budget -= changes;
          }
        })();
        await yieldLoop();
      }
      ({ size, sha256: hash } = batch[batch.length - 1]!);
    }
    const stats = [];
    for (const kind of ['image', 'video'] as const) {
      const kindStart = Date.now();
      const result = await matchPerceptual(db, id, (groupId) => refreshGroup(db, groupId), kind);
      stats.push(result);
      const kindMs = Date.now() - kindStart;
      this.log.info({ match_run: id, kind, ...result }, 'Perceptual matching finished');
      this.logs?.add(
        scanId,
        'info',
        'match',
        `${kind} perceptual matching: ${result.candidate_pairs} candidates — run ${id}`,
        kindMs
      );
    }
    const audioStart = Date.now();
    const audio = await matchPartialAudio(db, id, (groupId) => refreshGroup(db, groupId));
    this.log.info({ match_run: id, ...audio }, 'Audio partial matching finished');
    this.logs?.add(
      scanId,
      'info',
      'match',
      `Audio partial matching: ${audio.candidate_pairs} candidates, ${audio.hot_values} over-common values — run ${id}`,
      Date.now() - audioStart
    );
    db.prepare('UPDATE match_runs SET candidate_pairs=?,skipped_buckets=? WHERE id=?').run(
      stats.reduce((sum, result) => sum + result.candidate_pairs, 0) + audio.candidate_pairs,
      JSON.stringify(stats.flatMap((result) => result.skipped_buckets)),
      id
    );
    while (
      db
        .prepare(
          `DELETE FROM dup_groups WHERE id IN (
      SELECT id FROM dup_groups WHERE match_run=? AND member_count<2 LIMIT 1000)`
        )
        .run(id).changes
    )
      await yieldLoop();
    db.transaction(() => {
      db.exec("UPDATE match_runs SET status='superseded' WHERE status='active'");
      db.prepare(
        "INSERT INTO settings(key,value) VALUES ('active_match_run',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      ).run(String(id));
      db.prepare(
        "UPDATE match_runs SET status='active',finished_at=datetime('now') WHERE id=?"
      ).run(id);
    })();
    this.log.info({ match_run: id }, 'Matching activated');
    this.logs?.add(
      scanId,
      'info',
      'complete',
      `Matching complete — run ${id}`,
      Date.now() - startedAt
    );
    for (;;) {
      const removed = db.transaction(
        () =>
          db
            .prepare(
              `DELETE FROM dup_group_members WHERE rowid IN (
        SELECT m.rowid FROM dup_group_members m JOIN dup_groups g ON g.id=m.group_id
        WHERE g.match_run<>? LIMIT 10000)`
            )
            .run(id).changes
      )();
      await yieldLoop();
      if (!removed) break;
    }
    while (
      db.transaction(
        () =>
          db
            .prepare(
              'DELETE FROM dup_groups WHERE id IN (SELECT id FROM dup_groups WHERE match_run<>? LIMIT 1000)'
            )
            .run(id).changes
      )()
    )
      await yieldLoop();
    db.prepare('DELETE FROM match_runs WHERE id<>?').run(id);
  }
}
