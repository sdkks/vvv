import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { access, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { idParams } from './scans.js';
import { MediaWork, mediaSetting, VideoFailure, videoThumbnail } from '../video.js';

type File = {
  path: string;
  rel_path: string;
  token: string;
  sha256: string | null;
  kind: string;
  duration_ms: number | null;
};
const hasCode = (error: unknown, code: string) =>
  error instanceof Error && 'code' in error && error.code === code;

function isDecodeRejection(message: string) {
  // Sharp's corrupt-header wrapper can also contain operational file-open errors.
  const inner = message.replace(/^Input file has corrupt header:\s*/, '').trim();
  if (
    /\b(?:ENOENT|EACCES|EISDIR|EIO|EMFILE|ENOSPC|EFBIG|ENOMEM|ENFILE)\b|out[- ]of[- ]memory|\b(?:memory|allocat(?:e|ion)|resources?)\b|bad_alloc|too many open files|no space left|permission denied|no such file or directory|input\/output error/i.test(
      inner
    )
  )
    return false;
  if (inner === 'Input file contains unsupported image format') return true;
  // A loader name alone is not evidence of bad media; require a content-rejection signature.
  return /^(?:Vips(?:Jpeg|Png|Webp|Tiff|Gif|Heif|Jp2k)|(?:jpeg|png|webp|tiff|gif|heif|jp2k)load(?:_buffer)?):\s*(?:corrupt(?:ed|ion)?|truncated|premature (?:end|EOF)|unexpected (?:end|EOF)|invalid (?:header|bitstream|data|chunk|marker|signature)|CRC (?:error|mismatch)|JPEG datastream contains no image)\b/im.test(
    inner
  );
}

export function thumbnailRoutes(
  app: FastifyInstance,
  db: Database.Database,
  dataDir: string,
  media: MediaWork
) {
  const lookup = db.prepare(`SELECT d.path,d.token,f.rel_path,f.sha256,f.kind,f.duration_ms
    FROM files f JOIN scan_dirs d ON d.id=f.scan_dir_id
    WHERE f.id=? AND f.status='done'`);
  const pending = new Map<string, Promise<{ bytes: Buffer; file: File } | null>>();
  async function load(id: string) {
    const file = lookup.get(id) as File | undefined;
    if (!file) return null;
    // Audio and other non-visual kinds have no thumbnail: a genuine 404, never a decode attempt.
    if (file.kind !== 'image' && file.kind !== 'video') return null;
    const source = join(file.path, file.rel_path);
    let info;
    try {
      info = await stat(source, { bigint: true });
      if (!info.isFile()) return null;
      await access(source, constants.R_OK);
    } catch (error) {
      if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) return null;
      throw error;
    }
    const cache = join(dataDir, 'thumbs', `${id}.jpg`);
    // File ids can be reused after directory deletion; source changes also invalidate the cache.
    const key = JSON.stringify([
      file,
      String(info.size),
      String(info.mtimeNs),
      String(info.ctimeNs),
    ]);
    try {
      if ((await readFile(`${cache}.key`, 'utf8')) === key)
        return { bytes: await readFile(cache), file };
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    let bytes: Buffer;
    try {
      bytes = await media.run(() =>
        file.kind === 'video'
          ? videoThumbnail(source, file.duration_ms ?? 0, {
              timeout: mediaSetting(db, 'video_timeout_ms', 120000, 2147483647),
              signal: media.shutdown.signal,
            })
          : sharp(source)
              .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
              .jpeg()
              .toBuffer()
      );
    } catch (error) {
      if (
        (error instanceof VideoFailure &&
          ['content_unavailable', 'no_duration'].includes(error.code)) ||
        (file.kind === 'image' && error instanceof Error && isDecodeRejection(error.message))
      ) {
        app.log.warn({ file_id: id, err: error }, 'Thumbnail source is undecodable');
        return null;
      }
      throw error;
    }
    // Invalidate the marker before replacing the JPEG, so interrupted writes cannot validate it.
    await unlink(`${cache}.key`).catch((error: unknown) => {
      if (!hasCode(error, 'ENOENT')) throw error;
    });
    try {
      await writeFile(`${cache}.tmp`, bytes);
      await rename(`${cache}.tmp`, cache);
      await writeFile(`${cache}.key.tmp`, key);
      await rename(`${cache}.key.tmp`, `${cache}.key`);
    } finally {
      for (const path of [`${cache}.tmp`, `${cache}.key.tmp`])
        await unlink(path).catch((error: unknown) => {
          if (!hasCode(error, 'ENOENT')) throw error;
        });
    }
    return { bytes, file };
  }
  app.get<{ Params: { id: string } }>(
    '/api/files/:id/thumb',
    { schema: { params: idParams } },
    async (request, reply) => {
      const { id } = request.params;
      try {
        let task = pending.get(id);
        if (!task) {
          task = load(id).finally(() => pending.delete(id));
          pending.set(id, task);
        }
        const result = await task;
        // Recheck eligibility after I/O: unregistering a directory must not expose an orphan cache.
        if (!result || JSON.stringify(lookup.get(id)) !== JSON.stringify(result.file))
          return reply.code(404).send({ error: 'thumbnail_not_found' });
        return reply
          .type('image/jpeg')
          .header('Cache-Control', 'private, no-cache')
          .send(result.bytes);
      } catch (error) {
        request.log.error({ file_id: id, err: error }, 'Thumbnail generation failed');
        return reply.code(500).send({ error: 'thumbnail_failed' });
      }
    }
  );
}
