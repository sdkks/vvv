import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import type { ScanProgress } from '@vvv/shared';
import { processFile } from './hashing.js';

type Directory = {
  id: number;
  path: string;
  token: string;
  follow_symlinks: number;
  cross_filesystems: number;
};
const images = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'tiff', 'avif']);
const videos = new Set([
  'mp4',
  'mkv',
  'avi',
  'mov',
  'webm',
  'm4v',
  'mpg',
  'mpeg',
  'ts',
  'm2ts',
  'wmv',
  'flv',
]);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isVanishedOrLoop = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ELOOP');

export class Scanner {
  private cancelled = false;
  private task?: Promise<void>;
  private currentFile?: string;
  constructor(
    private db: Database.Database,
    private log: FastifyBaseLogger,
    private onProgress?: (snapshot: ScanProgress) => void,
    private onDone?: () => void
  ) {
    db.transaction(() => {
      db.exec(
        "UPDATE scans SET status='interrupted', finished_at=datetime('now') WHERE status='running'"
      );
      db.exec("UPDATE files SET status='pending' WHERE status='hashed'");
    })();
  }
  current(): ScanProgress | null {
    const row = this.db
      .prepare(
        'SELECT id,status,discovered,processed,errors,started_at,finished_at FROM scans ORDER BY id DESC LIMIT 1'
      )
      .get() as ScanProgress | undefined;
    return row ? { ...row, ...(this.currentFile ? { current_file: this.currentFile } : {}) } : null;
  }
  private publish() {
    if (!this.onProgress) return;
    const snapshot = this.current();
    if (snapshot) this.onProgress(snapshot);
  }
  start(): number | null {
    if (this.task) return null;
    const id = Number(
      this.db.prepare("INSERT INTO scans(status) VALUES ('running')").run().lastInsertRowid
    );
    this.cancelled = false;
    this.publish();
    this.task = this.run(id).finally(() => {
      this.task = undefined;
    });
    return id;
  }
  cancel(id: number) {
    if (this.current()?.id === id && this.task) this.cancelled = true;
  }
  async close() {
    this.cancelled = true;
    await this.task;
  }
  private record(
    dir: Directory,
    path: string,
    kind: string,
    size: bigint,
    mtime: bigint,
    scan: number,
    error: string | null
  ) {
    // A directory may be unregistered while traversal awaits filesystem I/O.
    if (
      !this.db
        .prepare('SELECT id FROM scan_dirs WHERE id=? AND path=? AND token=?')
        .get(dir.id, dir.path, dir.token)
    )
      return;
    this.db.transaction(() => {
      const previous = this.db
        .prepare('SELECT size,mtime_ns,status FROM files WHERE scan_dir_id=? AND rel_path=?')
        .safeIntegers()
        .get(dir.id, path) as { size: bigint; mtime_ns: bigint; status: string } | undefined;
      const unchanged =
        previous?.size === size && previous.mtime_ns === mtime && previous.status === 'done';
      this.db
        .prepare(
          `INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status,last_seen_scan_id,error)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scan_dir_id,rel_path) DO UPDATE SET
        size=excluded.size,mtime_ns=excluded.mtime_ns,status=excluded.status,error=excluded.error,
        sha256=CASE WHEN excluded.status='done' THEN files.sha256 ELSE NULL END,
        last_seen_scan_id=excluded.last_seen_scan_id,updated_at=datetime('now')`
        )
        .run(
          dir.id,
          path,
          kind,
          size,
          mtime,
          error ? 'error' : unchanged ? 'done' : 'pending',
          scan,
          error
        );
      this.db
        .prepare(
          'UPDATE scans SET discovered=discovered+1,processed=processed+?,errors=errors+? WHERE id=?'
        )
        .run(Number(unchanged || !!error), Number(!!error), scan);
    })();
    this.publish();
  }
  private async walk(
    dir: Directory,
    relative: string,
    root: bigint | undefined,
    ancestors: Set<string>,
    scan: number
  ): Promise<void> {
    if (this.cancelled) return;
    const absolute = join(dir.path, relative);
    if (absolute.split(sep).includes('.vvv-trash')) return;
    const extension = extname(relative).slice(1).toLowerCase();
    const kind = images.has(extension) ? 'image' : videos.has(extension) ? 'video' : null;
    let info;
    let linked = false;
    try {
      info = await lstat(absolute, { bigint: true });
      linked = info.isSymbolicLink();
      if (linked && !dir.follow_symlinks) return;
      if (linked || root === undefined) {
        if ((await realpath(absolute)).split(sep).includes('.vvv-trash')) return;
      }
      if (linked) info = await stat(absolute, { bigint: true });
    } catch (error) {
      if (!kind && linked && isVanishedOrLoop(error)) return;
      if (!kind) throw error;
      this.record(dir, relative, kind, 0n, 0n, scan, message(error));
      return;
    }
    root ??= info.dev;
    if (!dir.cross_filesystems && root !== info.dev) return;
    if (info.isFile() && kind) {
      this.record(dir, relative, kind, info.size, info.mtimeNs, scan, null);
    } else if (info.isDirectory()) {
      const key = `${info.dev}:${info.ino}`;
      if (ancestors.has(key)) return;
      // Track only the active ancestry: loop protection stays bounded by tree depth.
      ancestors.add(key);
      try {
        for await (const entry of await opendir(absolute)) {
          if (this.cancelled) break;
          await this.walk(dir, join(relative, entry.name), root, ancestors, scan);
        }
      } finally {
        ancestors.delete(key);
      }
    }
  }
  private async run(id: number) {
    await yieldLoop();
    this.log.info({ scan_id: id }, 'Scan started');
    let status = 'done';
    try {
      let after = 0;
      while (!this.cancelled) {
        const dir = this.db
          .prepare('SELECT * FROM scan_dirs WHERE id>? ORDER BY id LIMIT 1')
          .get(after) as Directory | undefined;
        if (!dir) break;
        after = dir.id;
        await this.walk(dir, '', undefined, new Set(), id);
      }
      after = 0;
      while (!this.cancelled) {
        const unseen = this.db
          .prepare(
            `SELECT id FROM files WHERE id>? AND last_seen_scan_id IS NOT ?
            AND status NOT IN ('missing','quarantined') ORDER BY id LIMIT 100`
          )
          .all(after, id) as { id: number }[];
        if (!unseen.length) break;
        for (const file of unseen) {
          this.db
            .prepare("UPDATE files SET status='missing',updated_at=datetime('now') WHERE id=?")
            .run(file.id);
          after = file.id;
        }
        await yieldLoop();
      }
      while (!this.cancelled) {
        const batch = this.db
          .prepare(
            `SELECT f.id,d.path,f.rel_path FROM files f JOIN scan_dirs d ON d.id=f.scan_dir_id
          WHERE f.status='pending' AND f.last_seen_scan_id=? LIMIT 4`
          )
          .all(id) as { id: number; path: string; rel_path: string }[];
        if (!batch.length) break;
        await Promise.all(
          batch.map(async (file) => {
            const path = join(file.path, file.rel_path);
            this.currentFile = path;
            this.publish();
            let error: string | null = null;
            try {
              const sha = await processFile(path);
              this.db
                .prepare("UPDATE files SET sha256=?,status='hashed' WHERE id=?")
                .run(sha, file.id);
            } catch (cause) {
              error = message(cause);
            }
            this.db.transaction(() => {
              this.db
                .prepare("UPDATE files SET status=?,error=?,updated_at=datetime('now') WHERE id=?")
                .run(error ? 'error' : 'done', error, file.id);
              this.db
                .prepare('UPDATE scans SET processed=processed+1,errors=errors+? WHERE id=?')
                .run(Number(!!error), id);
            })();
            this.publish();
            if (error) {
              this.log.warn({ scan_id: id, file_id: file.id, error }, 'File processing failed');
            }
          })
        );
        this.currentFile = undefined;
      }
      if (this.cancelled) status = 'cancelled';
    } catch (error) {
      status = 'interrupted';
      this.log.error({ scan_id: id, error: message(error) }, 'Scan interrupted');
    }
    this.currentFile = undefined;
    this.db
      .prepare("UPDATE scans SET status=?,finished_at=datetime('now') WHERE id=?")
      .run(status, id);
    this.publish();
    this.log.info({ scan_id: id, status }, 'Scan finished');
    if (status === 'done') this.onDone?.();
  }
}
