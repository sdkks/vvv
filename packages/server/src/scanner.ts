import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import type { FileHashAlgorithm, FileSizePolicy, ScanLogLevel, ScanLogStep, ScanProgress } from '@vvv/shared';
import { imageHash, imageMetadata, processFile, storeHashes } from './hashing.js';
import { MediaWork, videoHash, videoMetadata } from './video.js';
import type { ScanLog } from './scan-log.js';
import {
  fileHashAlgorithm,
  fileSizeSettings,
  matchingEnabled,
  matchingSetting,
} from './matching-settings.js';
import { refreshFileGroups } from './matcher.js';
import {
  crossesBoundary,
  insideTrash,
  mediaKind,
  outsideRoot,
  skipsSymlink,
  sizeExclusion,
} from './traversal-policy.js';

type Directory = {
  id: number;
  path: string;
  token: string;
  follow_symlinks: number;
  cross_filesystems: number;
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isVanishedOrLoop = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ELOOP');

export class Scanner {
  private cancelled = false;
  private abort = new AbortController();
  private task?: Promise<void>;
  private currentFile?: string;
  private scanId = 0;
  private sizes: FileSizePolicy = { min_file_size_mb: 0, max_file_size_mb: 0 };
  private perceptual = { image: true, video: true };
  private algorithm: FileHashAlgorithm = 'sha256';
  constructor(
    private db: Database.Database,
    private log: FastifyBaseLogger,
    private onProgress?: (snapshot: ScanProgress) => void,
    private onDone?: (scanId: number) => void,
    private media = new MediaWork(),
    private logs?: ScanLog
  ) {
    db.transaction(() => {
      db.exec(
        "UPDATE scans SET status='interrupted', finished_at=datetime('now') WHERE status='running'"
      );
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
  /** Mirror a scan lifecycle event to the bounded log ring and structured logs. */
  private logStep(level: ScanLogLevel, step: ScanLogStep, detail: string, durationMs?: number) {
    this.logs?.add(this.scanId, level, step, detail, durationMs);
    this.log[level](
      durationMs === undefined
        ? { scan_id: this.scanId, step }
        : { scan_id: this.scanId, step, duration_ms: Math.max(0, Math.round(durationMs)) },
      detail
    );
  }
  start(): number | null {
    if (this.task) return null;
    // Algorithm changes clear all legacy sha256 checkpoints and are refused during scans.
    // Snapshot the algorithm so every surviving content hash uses the same algorithm.
    this.algorithm = fileHashAlgorithm(this.db);
    // Size limits and method switches apply to the next scan, never partway through this one.
    this.sizes = fileSizeSettings(this.db);
    this.perceptual = {
      image: matchingEnabled(this.db, 'image'),
      video: matchingEnabled(this.db, 'video'),
    };
    const id = Number(
      this.db.prepare("INSERT INTO scans(status) VALUES ('running')").run().lastInsertRowid
    );
    this.cancelled = false;
    this.abort = new AbortController();
    this.publish();
    this.task = this.run(id).finally(() => {
      this.task = undefined;
    });
    return id;
  }
  cancel(id: number) {
    if (this.current()?.id === id && this.task) {
      this.cancelled = true;
      this.abort.abort();
    }
  }
  async close() {
    this.cancelled = true;
    this.abort.abort();
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
    if (
      this.db
        .prepare(
          `SELECT f.id FROM files f WHERE f.scan_dir_id=? AND f.rel_path=?
      AND (EXISTS (SELECT 1 FROM trash t WHERE t.file_id=f.id AND t.restored=0)
      OR EXISTS (SELECT 1 FROM file_operations o WHERE o.file_id=f.id AND o.status != 'committed'
        AND o.status IN ('pending','fs_done')))`
        )
        .get(dir.id, path)
    ) {
      this.log.info({ scan_dir_id: dir.id, path }, 'Skipped quarantined path');
      return;
    }
    this.db.transaction(() => {
      const previous = this.db
        .prepare(
          `SELECT size,mtime_ns,CASE WHEN status IN ('done','hashed') AND sha256 IS NULL
          THEN 'pending' WHEN status='done' AND ?
          AND NOT EXISTS (SELECT 1 FROM phashes WHERE file_id=files.id AND frame_idx=0)
          THEN 'hashed' ELSE status END AS status FROM files WHERE scan_dir_id=? AND rel_path=?`
        )
        .safeIntegers()
        .get(
          Number(kind === 'image' ? this.perceptual.image : this.perceptual.video),
          dir.id,
          path
        ) as { size: bigint; mtime_ns: bigint; status: string } | undefined;
      const unchanged = previous?.size === size && previous.mtime_ns === mtime;
      const exclusion = error ? null : sizeExclusion(size, this.sizes);
      const completed = !exclusion && unchanged && previous.status === 'done';
      const status = error
        ? 'error'
        : exclusion
          ? 'excluded'
          : completed
            ? 'done'
            : unchanged && previous.status === 'hashed'
              ? 'hashed'
              : 'pending';
      const recorded = this.db
        .prepare(
          `INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status,last_seen_scan_id,error)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scan_dir_id,rel_path) DO UPDATE SET
        size=excluded.size,mtime_ns=excluded.mtime_ns,status=excluded.status,error=excluded.error,
        sha256=CASE WHEN files.size=excluded.size AND files.mtime_ns=excluded.mtime_ns
          THEN files.sha256 ELSE NULL END,
        last_seen_scan_id=excluded.last_seen_scan_id,updated_at=datetime('now') RETURNING id`
        )
        .get(dir.id, path, kind, size, mtime, status, scan, error ?? exclusion) as { id: number };
      // Invalidate stale perceptual work with changed metadata, including while excluded.
      // Otherwise a resumed scan could mistake old frames for a hash-only checkpoint.
      if (previous && !unchanged) storeHashes(this.db, recorded.id, []);
      if (exclusion) refreshFileGroups(this.db, recorded.id);
      this.db
        .prepare(
          'UPDATE scans SET discovered=discovered+1,processed=processed+?,errors=errors+? WHERE id=?'
        )
        // Processed includes traversal exclusions; they never increment the error count.
        .run(Number(completed || !!error || !!exclusion), Number(!!error), scan);
    })();
    if (error) this.logs?.add(scan, 'error', 'error', `${join(dir.path, path)}: ${error}`);
    this.publish();
  }
  private async walk(
    dir: Directory,
    relative: string,
    root: bigint | undefined,
    ancestors: Set<string>,
    scan: number,
    canonicalRoot?: string
  ): Promise<void> {
    if (this.cancelled) return;
    const absolute = join(dir.path, relative);
    if (insideTrash(absolute)) return;
    const kind = mediaKind(relative);
    let info;
    let linked = false;
    try {
      info = await lstat(absolute, { bigint: true });
      linked = info.isSymbolicLink();
      if (skipsSymlink(linked, dir.follow_symlinks)) return;
      canonicalRoot ??= await realpath(dir.path);
      if (linked || root === undefined) {
        const target = relative ? await realpath(absolute) : canonicalRoot;
        if (insideTrash(target)) return;
        if (outsideRoot(canonicalRoot, target)) {
          this.record(
            dir,
            relative,
            kind ?? 'other',
            0n,
            0n,
            scan,
            'Symlink target is outside the registered directory.'
          );
          return;
        }
      }
      if (linked) info = await stat(absolute, { bigint: true });
    } catch (error) {
      if (!kind && linked && isVanishedOrLoop(error)) return;
      if (!kind) throw error;
      this.record(dir, relative, kind, 0n, 0n, scan, message(error));
      return;
    }
    root ??= info.dev;
    if (crossesBoundary(root, info.dev, dir.cross_filesystems)) return;
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
          await this.walk(dir, join(relative, entry.name), root, ancestors, scan, canonicalRoot);
        }
      } finally {
        ancestors.delete(key);
      }
    }
  }
  private async run(id: number) {
    await yieldLoop();
    this.scanId = id;
    const started = Date.now();
    const dirs = (
      this.db.prepare('SELECT count(*) AS count FROM scan_dirs').get() as { count: number }
    ).count;
    this.logStep(
      'info',
      'scan',
      `Scan started — ${dirs} registered ${dirs === 1 ? 'directory' : 'directories'}`
    );
    let status = 'done';
    let failure = '';
    // Per-kind wall-clock span (first file start to last file end) and count of hashed files.
    const hashed: Record<'image' | 'video', { count: number; first: number; last: number }> = {
      image: { count: 0, first: 0, last: 0 },
      video: { count: 0, first: 0, last: 0 },
    };
    try {
      const traversalStart = Date.now();
      this.logStep('info', 'traversal', 'Traversal started');
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
            AND status NOT IN ('missing','quarantined') AND NOT EXISTS (
              SELECT 1 FROM file_operations o WHERE o.file_id=files.id
              AND o.status != 'committed' AND o.status IN ('pending','fs_done')) ORDER BY id LIMIT 100`
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
      const discovered = (
        this.db.prepare('SELECT discovered FROM scans WHERE id=?').get(id) as {
          discovered: number;
        }
      ).discovered;
      this.logStep(
        'info',
        'traversal',
        `Traversal finished — ${discovered} ${discovered === 1 ? 'file' : 'files'} discovered`,
        Date.now() - traversalStart
      );
      while (!this.cancelled) {
        const batch = this.db
          .prepare(
            `SELECT f.id,d.path,f.rel_path,f.kind,f.status,f.sha256,
          (f.sha256 IS NULL OR f.status='hashed') AND EXISTS (
            SELECT 1 FROM phashes WHERE file_id=f.id AND frame_idx=0) AS reuse_phashes
          FROM files f JOIN scan_dirs d ON d.id=f.scan_dir_id
          WHERE f.status IN ('pending','hashed') AND f.last_seen_scan_id=? LIMIT 4`
          )
          .all(id) as {
          id: number;
          path: string;
          rel_path: string;
          kind: string;
          status: string;
          sha256: string | null;
          reuse_phashes: number;
        }[];
        if (!batch.length) break;
        await Promise.all(
          batch.map((file) =>
            this.media
              .run(async () => {
                const path = join(file.path, file.rel_path);
                this.currentFile = path;
                this.publish();
                const fileStart = Date.now();
                let hashMs = 0;
                let sampleMs = 0;
                let error: string | null = null;
                let result:
                  | { hashes: Buffer[]; width?: number; height?: number; duration_ms?: number }
                  | undefined;
                try {
                  if (file.status === 'pending' || file.sha256 === null) {
                    const hashStart = Date.now();
                    const sha = file.sha256 ?? (await processFile(path, this.algorithm));
                    hashMs = Date.now() - hashStart;
                    this.db
                      .prepare("UPDATE files SET sha256=?,status='hashed' WHERE id=?")
                      .run(sha, file.id);
                  }
                  // Only reuse a hash-only/resumable checkpoint; traversal already removed
                  // stale phashes on size/mtime changes. Backfill still runs when absent.
                  if (!file.reuse_phashes && file.kind === 'image') {
                    const sampleStart = Date.now();
                    if (this.perceptual.image) {
                      const image = await imageHash(path);
                      result = { ...image, hashes: [image.hash] };
                    } else result = { ...(await imageMetadata(path)), hashes: [] };
                    sampleMs = Date.now() - sampleStart;
                  } else if (!file.reuse_phashes) {
                    const sampleStart = Date.now();
                    const options = {
                      timeout: matchingSetting(this.db, 'video_timeout_ms'),
                      signal: this.abort.signal,
                    };
                    result = this.perceptual.video
                      ? await videoHash(
                          path,
                          matchingSetting(this.db, 'video_frame_count'),
                          options
                        )
                      : { ...(await videoMetadata(path, options)), hashes: [] };
                    sampleMs = Date.now() - sampleStart;
                  }
                } catch (cause) {
                  if (this.abort.signal.aborted) return;
                  error = message(cause);
                }
                this.db.transaction(() => {
                  if (result && this.db.prepare('SELECT id FROM files WHERE id=?').get(file.id)) {
                    storeHashes(this.db, file.id, result.hashes);
                    this.db
                      .prepare('UPDATE files SET width=?,height=?,duration_ms=? WHERE id=?')
                      .run(result.width, result.height, result.duration_ms ?? null, file.id);
                  }
                  this.db
                    .prepare(
                      "UPDATE files SET status=?,error=?,updated_at=datetime('now') WHERE id=?"
                    )
                    .run(error ? 'error' : 'done', error, file.id);
                  this.db
                    .prepare('UPDATE scans SET processed=processed+1,errors=errors+? WHERE id=?')
                    .run(Number(!!error), id);
                })();
                this.publish();
                const stat = file.kind === 'image' || file.kind === 'video' ? hashed[file.kind] : undefined;
                if (stat) {
                  stat.count++;
                  if (!stat.first) stat.first = fileStart;
                  stat.last = Date.now();
                }
                const elapsed = Date.now() - fileStart;
                const slow = [
                  hashMs > 10_000 ? `hashing ${Math.round(hashMs / 100) / 10}s` : '',
                  sampleMs > 10_000 ? `sampling ${Math.round(sampleMs / 100) / 10}s` : '',
                ]
                  .filter(Boolean)
                  .join(', ');
                if (slow)
                  this.logStep(
                    'warn',
                    sampleMs > 10_000 ? 'sample' : 'hash',
                    `Slow file: ${path} — ${slow}`,
                    elapsed
                  );
                if (error) {
                  this.log.warn({ scan_id: id, file_id: file.id, error }, 'File processing failed');
                  this.logs?.add(id, 'error', 'error', `${path}: ${error}`);
                }
              }, this.abort.signal)
              .catch((error: unknown) => {
                if (!this.cancelled) throw error;
              })
          )
        );
        this.currentFile = undefined;
      }
      for (const kind of ['image', 'video'] as const) {
        const stat = hashed[kind];
        if (stat.count)
          this.logStep(
            'info',
            'hash',
            `Hashed ${stat.count} ${kind} ${stat.count === 1 ? 'file' : 'files'}`,
            stat.last - stat.first
          );
      }
      if (this.cancelled) status = 'cancelled';
    } catch (error) {
      status = 'interrupted';
      failure = message(error);
    }
    this.currentFile = undefined;
    this.db
      .prepare("UPDATE scans SET status=?,finished_at=datetime('now') WHERE id=?")
      .run(status, id);
    this.publish();
    const totals = this.db
      .prepare('SELECT processed,errors FROM scans WHERE id=?')
      .get(id) as { processed: number; errors: number };
    const detail =
      status === 'done'
        ? `Scan complete — ${totals.processed} processed, ${totals.errors} errors`
        : status === 'cancelled'
          ? `Scan cancelled — ${totals.processed} processed, ${totals.errors} errors`
          : `Scan interrupted: ${failure} — ${totals.processed} processed, ${totals.errors} errors`;
    this.logStep(
      status === 'done' ? 'info' : status === 'cancelled' ? 'warn' : 'error',
      'complete',
      detail,
      Date.now() - started
    );
    if (status === 'done') this.onDone?.(id);
  }
}
