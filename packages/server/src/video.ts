import { spawn } from 'node:child_process';
import type Database from 'better-sqlite3';
import { dHash } from './hashing.js';
import { numericSetting } from './matching-settings.js';

export function mediaSetting(db: Database.Database, key: string, fallback: number, max: number) {
  return numericSetting(db, key, fallback, max, 1);
}

// One slot per file, shared by exact hashing, decoding and thumbnail children.
export class MediaWork {
  private active = 0;
  private waiting: (() => void)[] = [];
  readonly shutdown = new AbortController();
  async run<T>(work: () => Promise<T>, signal: AbortSignal = this.shutdown.signal): Promise<T> {
    signal.throwIfAborted();
    this.shutdown.signal.throwIfAborted();
    if (this.active >= 4) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          signal.removeEventListener('abort', abort);
          this.shutdown.signal.removeEventListener('abort', abort);
        };
        const acquire = () => {
          cleanup();
          // Reserve the slot before waking the waiter so new callers cannot take it.
          this.active++;
          resolve();
        };
        const abort = () => {
          this.waiting.splice(this.waiting.indexOf(acquire), 1);
          cleanup();
          reject(signal.aborted ? signal.reason : this.shutdown.signal.reason);
        };
        this.waiting.push(acquire);
        signal.addEventListener('abort', abort, { once: true });
        this.shutdown.signal.addEventListener('abort', abort, { once: true });
      });
    } else this.active++;
    try {
      signal.throwIfAborted();
      this.shutdown.signal.throwIfAborted();
      return await work();
    } finally {
      // Only acquired slots enter this block; each is released exactly once.
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export class VideoFailure extends Error {
  constructor(
    readonly code: string,
    detail = ''
  ) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
  }
}

export type Options = { timeout: number; signal?: AbortSignal };
export async function child(
  program: string,
  args: string[],
  options: Options,
  maxBytes: number,
  receive: (chunk: Buffer) => void
) {
  options.signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const process = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let failure: Error | undefined;
    let stderr = '';
    let bytes = 0;
    let kill: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      process.kill('SIGTERM');
      kill = setTimeout(() => process.kill('SIGKILL'), 100);
    };
    const abort = () => stop(new VideoFailure('cancelled'));
    const timeout = setTimeout(() => stop(new VideoFailure('timeout')), options.timeout);
    options.signal?.addEventListener('abort', abort, { once: true });
    process.on('error', (error) => {
      failure = error;
    });
    process.stdout.on('error', stop);
    process.stderr.on('error', stop);
    process.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    process.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop(new VideoFailure('incomplete_frames', 'excess output'));
      else if (!failure) receive(chunk);
    });
    process.once('close', (code) => {
      clearTimeout(timeout);
      clearTimeout(kill);
      options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new VideoFailure('decode_failed', stderr));
      else resolve();
    });
  });
}
async function output(program: string, args: string[], options: Options) {
  const chunks: Buffer[] = [];
  await child(program, args, options, 1024 * 1024, (chunk) => chunks.push(chunk));
  return Buffer.concat(chunks);
}

export function probeArgs(path: string) {
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,codec_name,duration',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    path,
  ];
}
export function samplingArgs(path: string, frames: number, duration: number) {
  return [
    '-v',
    'error',
    '-i',
    path,
    '-map',
    '0:v:0',
    '-vf',
    `fps=${frames}/${duration},scale=9:8`,
    '-frames:v',
    String(frames),
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    '-',
  ];
}
export function parseMetadata(bytes: Buffer) {
  const data: unknown = JSON.parse(bytes.toString());
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const streams = record(data).streams;
  const stream = record(Array.isArray(streams) ? streams[0] : undefined);
  if (!Object.keys(stream).length) throw new VideoFailure('no_video_stream');
  const positive = (value: unknown) => {
    const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const duration = positive(record(record(data).format).duration) ?? positive(stream.duration);
  if (duration === null) throw new VideoFailure('no_duration');
  const width = positive(stream.width),
    height = positive(stream.height);
  if (!Number.isInteger(width) || !Number.isInteger(height))
    throw new VideoFailure('no_video_stream');
  return { width: width!, height: height!, duration, duration_ms: Math.round(duration * 1000) };
}
export async function videoMetadata(path: string, options: Options) {
  return parseMetadata(await output('ffprobe', probeArgs(path), options));
}
export async function videoHash(path: string, frames: number, options: Options) {
  const metadata = await videoMetadata(path, options);
  const hashes: Buffer[] = [];
  let remainder = Buffer.alloc(0);
  try {
    await child(
      'ffmpeg',
      samplingArgs(path, frames, metadata.duration),
      options,
      frames * 72,
      (chunk) => {
        const bytes = Buffer.concat([remainder, chunk]);
        let offset = 0;
        while (offset + 72 <= bytes.length) {
          hashes.push(dHash(bytes.subarray(offset, offset + 72)));
          offset += 72;
        }
        remainder = bytes.subarray(offset);
      }
    );
  } catch (error) {
    if (error instanceof VideoFailure && error.code === 'decode_failed')
      throw new VideoFailure('incomplete_frames', error.message);
    throw error;
  }
  if (hashes.length !== frames || remainder.length) throw new VideoFailure('incomplete_frames');
  return { ...metadata, hashes };
}
export async function videoThumbnail(path: string, durationMs: number, options: Options) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new VideoFailure('no_duration');
  try {
    const bytes = await output(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        String(durationMs / 2000),
        '-i',
        path,
        '-map',
        '0:v:0',
        '-frames:v',
        '1',
        '-vf',
        'scale=256:256:force_original_aspect_ratio=decrease',
        '-f',
        'image2pipe',
        '-c:v',
        'mjpeg',
        '-',
      ],
      options
    );
    if (!bytes.length) throw new VideoFailure('content_unavailable');
    return bytes;
  } catch (error) {
    // Operational errors remain failures, not a misleading absent-preview response.
    if (
      error instanceof VideoFailure &&
      error.code === 'decode_failed' &&
      !/\b(?:ENOENT|EACCES|EISDIR|EIO|EMFILE|ENOSPC|EFBIG|ENOMEM|ENFILE)\b|permission denied|input\/output error|no such file|too many open files|allocat|memory|resource|no space left/i.test(
        error.message
      )
    )
      throw new VideoFailure('content_unavailable', error.message);
    throw error;
  }
}
