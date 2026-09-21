import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import { setImmediate as yieldLoop } from 'node:timers/promises';

type Candidate = { size: number; sha256: string; count: number };
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
    const candidates =
      db.prepare(`SELECT size,sha256,count(*) AS count FROM files INDEXED BY idx_files_exact
      WHERE status='done' AND sha256 IS NOT NULL AND (size,sha256)>(?,?)
      GROUP BY size,sha256 HAVING count(*)>1 ORDER BY size,sha256 LIMIT 1000`);
    const group =
      db.prepare(`INSERT INTO dup_groups(kind,member_count,total_bytes,reclaimable_bytes,match_run)
      VALUES ('exact',?,?,?,?)`);
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
            if (!groupId)
              groupId = Number(
                group.run(item.count, item.size * item.count, item.size * (item.count - 1), id)
                  .lastInsertRowid
              );
            const { changes } = members.run(groupId, item.size, item.sha256, after, budget);
            if (changes < budget) {
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
