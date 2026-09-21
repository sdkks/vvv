import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { hamming } from './hashing.js';
import { matchImages } from './image-matcher.js';

type Candidate = { size: number; sha256: string };
function refreshGroup(db: Database.Database, id: number, scanDirId = 0) {
  db.prepare(
    `DELETE FROM dup_group_members AS m WHERE group_id=? AND EXISTS (
    SELECT 1 FROM files f WHERE f.id=m.file_id AND (f.scan_dir_id=? OR f.status<>'done'))`
  ).run(id, scanDirId);
  db.prepare(
    `UPDATE dup_groups SET (member_count,total_bytes,reclaimable_bytes)=(
    SELECT count(*),coalesce(sum(f.size),0),coalesce(sum(f.size)-max(f.size),0)
    FROM dup_group_members m JOIN files f ON f.id=m.file_id WHERE m.group_id=?) WHERE id=?`
  ).run(id, id);
  db.prepare(
    `UPDATE dup_group_members AS m SET similarity=phash_distance(
    (SELECT hash FROM phashes WHERE file_id=m.file_id AND frame_idx=0),
    (SELECT p.hash FROM dup_group_members r JOIN phashes p ON p.file_id=r.file_id
      WHERE r.group_id=m.group_id AND p.frame_idx=0 ORDER BY r.file_id LIMIT 1))
    WHERE group_id=? AND EXISTS (SELECT 1 FROM dup_groups WHERE id=? AND kind='image')`
  ).run(id, id);
}
export function deleteScanDir(db: Database.Database, scanDirId: number): number {
  return db.transaction(() => {
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
  })();
}
export function activeMatchRun(db: Database.Database): number | null {
  const row = db.prepare("SELECT value FROM settings WHERE key='active_match_run'").get() as
    { value: string } | undefined;
  return row ? Number(row.value) : null;
}
export class Matcher {
  private task?: Promise<void>;
  private queued = false;
  constructor(
    private db: Database.Database,
    private log: FastifyBaseLogger
  ) {
    db.function('phash_distance', { deterministic: true }, (a, b) =>
      a instanceof Uint8Array && b instanceof Uint8Array ? hamming(a, b) : null
    );
    db.exec("UPDATE match_runs SET status='superseded' WHERE status='building'");
  }
  afterScan() {
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
    this.log.info({ match_run: id }, 'Matching started');
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
    const imageStats = await matchImages(db, id, (groupId) => refreshGroup(db, groupId));
    this.log.info({ match_run: id, ...imageStats }, 'Image matching finished');
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
