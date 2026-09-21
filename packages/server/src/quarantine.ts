import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import { refreshFileGroups } from './matcher.js';

export type OperationKind = 'quarantine' | 'restore' | 'purge';
export type Operation = {
  id: number;
  kind: OperationKind;
  file_id: number;
  src_path: string;
  dst_path: string | null;
  status: string;
};
type FileRow = {
  file_id: number;
  scan_dir_id: number;
  path: string;
  token: string;
  rel_path: string;
  status: string;
  trash_id: number | null;
  trash_rel_path: string | null;
};
const errorName = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error
    ? String(error.code).toLowerCase()
    : error instanceof Error
      ? error.message
      : String(error);
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorName(error) === 'enoent') return false;
    throw error;
  }
}
export function retention(db: Database.Database) {
  const days = Number(
    (
      db.prepare("SELECT value FROM settings WHERE key='retention_days'").get() as
        { value: string } | undefined
    )?.value ?? 30
  );
  if (!Number.isSafeInteger(days) || days < 0 || days > 365000)
    throw new Error('invalid_retention_days');
  const enabled =
    (
      db.prepare("SELECT value FROM settings WHERE key='auto_purge_enabled'").get() as
        { value: string } | undefined
    )?.value === '1';
  return { days, enabled };
}
export class Quarantine {
  private timer?: ReturnType<typeof setInterval>;
  private tick?: Promise<unknown>;
  constructor(
    private db: Database.Database,
    private log: FastifyBaseLogger
  ) {}
  private file(id: number) {
    return this.db
      .prepare(
        `SELECT f.id AS file_id,f.scan_dir_id,f.rel_path,f.status,d.path,d.token,
      t.id AS trash_id,t.trash_rel_path FROM files f JOIN scan_dirs d ON d.id=f.scan_dir_id
      LEFT JOIN trash t ON t.file_id=f.id AND t.restored=0 WHERE f.id=?`
      )
      .get(id) as FileRow | undefined;
  }
  private context(op: Operation) {
    const row = this.file(op.file_id);
    if (!row) throw new Error('file_unregistered');
    const original = join(row.path, row.rel_path);
    // The unique trash path snapshots directory identity without extending the journal schema.
    if (op.kind === 'quarantine') {
      if (
        op.src_path !== original ||
        !op.dst_path?.startsWith(join(row.path, '.vvv-trash', row.token) + '/')
      )
        throw new Error('file_unregistered');
    } else if (
      !row.trash_rel_path ||
      op.src_path !== join(row.path, row.trash_rel_path) ||
      (op.kind === 'restore' && op.dst_path !== original)
    )
      throw new Error('trash_not_found');
    return row;
  }
  fail(op: Operation, error: unknown) {
    const name = errorName(error);
    this.db
      .prepare(
        "UPDATE file_operations SET status='failed',error=?,updated_at=datetime('now') WHERE id=?"
      )
      .run(name, op.id);
    this.log.warn(
      { operation_id: op.id, kind: op.kind, file_id: op.file_id, error: name },
      'File operation failed'
    );
    return new Error(name);
  }
  finish(op: Operation) {
    this.db
      .prepare("UPDATE file_operations SET status='fs_done',updated_at=datetime('now') WHERE id=?")
      .run(op.id);
    return this.db.transaction(() => {
      const row = this.context(op);
      let trashId = row.trash_id;
      if (op.kind === 'quarantine') {
        trashId = Number(
          this.db
            .prepare(
              `INSERT INTO trash(file_id,scan_dir_id,original_rel_path,trash_rel_path)
          VALUES (?,?,?,?)`
            )
            .run(row.file_id, row.scan_dir_id, row.rel_path, relative(row.path, op.dst_path!))
            .lastInsertRowid
        );
      } else if (op.kind === 'restore')
        this.db.prepare('UPDATE trash SET restored=1 WHERE id=?').run(trashId);
      else this.db.prepare('DELETE FROM files WHERE id=?').run(row.file_id);
      if (op.kind !== 'purge') {
        this.db
          .prepare("UPDATE files SET status=?,updated_at=datetime('now') WHERE id=?")
          .run(op.kind === 'quarantine' ? 'quarantined' : 'done', row.file_id);
        refreshFileGroups(this.db, row.file_id);
      }
      this.db
        .prepare(
          "UPDATE file_operations SET status='committed',error=NULL,updated_at=datetime('now') WHERE id=?"
        )
        .run(op.id);
      this.log.info(
        { operation_id: op.id, kind: op.kind, file_id: row.file_id },
        'File operation committed'
      );
      return { file_id: row.file_id, trash_id: trashId! };
    })();
  }
  async change(kind: OperationKind, id: number) {
    const trash =
      kind === 'quarantine'
        ? undefined
        : (this.db.prepare('SELECT file_id FROM trash WHERE id=? AND restored=0').get(id) as
            { file_id: number } | undefined);
    const row = this.file(kind === 'quarantine' ? id : (trash?.file_id ?? 0));
    if (!row) throw new Error(kind === 'quarantine' ? 'file_not_found' : 'trash_not_found');
    if (
      kind === 'quarantine'
        ? row.status !== 'done' || row.trash_id !== null
        : row.status !== 'quarantined'
    )
      throw new Error('file_not_eligible');
    if (
      this.db
        .prepare(
          "SELECT id FROM file_operations WHERE status != 'committed' AND status IN ('pending','fs_done') AND file_id=?"
        )
        .get(row.file_id)
    )
      throw new Error('operation_pending');
    const original = join(row.path, row.rel_path);
    const target =
      kind === 'quarantine' ? join(row.path, '.vvv-trash', row.token, randomUUID()) : original;
    const src = kind === 'quarantine' ? original : join(row.path, row.trash_rel_path!);
    const dst = kind === 'purge' ? null : target;
    // Commit intent before the first await so unregister cannot pass its journal check.
    const op = this.db
      .prepare(
        `INSERT INTO file_operations(kind,file_id,src_path,dst_path,status)
      VALUES (?,?,?,?,'pending') RETURNING *`
      )
      .get(kind, row.file_id, src, dst) as Operation;
    try {
      if (dst) {
        await mkdir(dirname(dst), { recursive: true });
        if (await exists(dst)) throw new Error('destination_exists');
      }
      this.context(op);
      // The single-user contract accepts the lstat/rename race; never copy across devices.
      if (dst) await rename(src, dst);
      else await unlink(src);
    } catch (error) {
      throw this.fail(op, error);
    }
    return this.finish(op);
  }
  async purgeExpired(automatic = false) {
    const { days, enabled } = retention(this.db);
    if (automatic && !enabled) return { purged: 0, failed: [] };
    const rows = this.db
      .prepare(
        `SELECT id FROM trash WHERE restored=0
      AND quarantined_at<=datetime('now',?) ORDER BY quarantined_at,id LIMIT 100`
      )
      .all(`-${days} days`) as { id: number }[];
    let purged = 0;
    const failed: { trash_id: number; error: string }[] = [];
    for (const row of rows) {
      try {
        await this.change('purge', row.id);
        purged++;
      } catch (error) {
        failed.push({ trash_id: row.id, error: errorName(error) });
      }
      await yieldLoop();
    }
    return { purged, failed };
  }
  start() {
    this.timer = setInterval(() => {
      if (this.tick) return;
      this.tick = this.purgeExpired(true)
        .catch((err: unknown) => this.log.error({ err }, 'Purge tick failed'))
        .finally(() => {
          this.tick = undefined;
        });
    }, 3600000);
    this.timer.unref();
  }
  async close() {
    clearInterval(this.timer);
    await this.tick;
  }
}
