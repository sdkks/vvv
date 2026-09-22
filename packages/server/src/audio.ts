import type Database from 'better-sqlite3';
import { child, VideoFailure, type Options } from './video.js';

export type AudioFingerprint = { duration: number; values: number[] };

export function fingerprintArgs(path: string) {
  return ['-raw', '-json', path];
}
export function parseFingerprint(bytes: Buffer): AudioFingerprint {
  const data: unknown = JSON.parse(bytes.toString());
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const duration = record(data).duration;
  const values = record(data).fingerprint;
  if (typeof duration !== 'number' || !(duration > 0)) throw new VideoFailure('no_duration');
  // -raw emits unsigned 32-bit subfingerprints; fpcalc itself refuses files too short to latch one.
  if (
    !Array.isArray(values) ||
    !values.length ||
    !values.every((value) => Number.isInteger(value) && value >= 0 && value <= 4294967295)
  )
    throw new VideoFailure('incomplete_frames', 'malformed subfingerprints');
  return { duration, values };
}
export async function audioFingerprint(
  path: string,
  options: Options
): Promise<AudioFingerprint | null> {
  const chunks: Buffer[] = [];
  try {
    // Rough ceiling: ~7.7 subfingerprints/second keeps even multi-day recordings far below it.
    await child('fpcalc', fingerprintArgs(path), options, 64 * 1024 * 1024, (chunk) =>
      chunks.push(chunk)
    );
  } catch (error) {
    // Videos without an audio track fail fast with a distinctive message: a clean skip,
    // not a per-file error. Every other failure (missing binary, corrupt audio) propagates.
    if (
      error instanceof VideoFailure &&
      error.code === 'decode_failed' &&
      /audio stream/i.test(error.message)
    )
      return null;
    throw error;
  }
  return parseFingerprint(Buffer.concat(chunks));
}
/** Replace-per-file semantics, mirroring storeHashes; call inside a transaction. */
export function storeSubfingerprints(db: Database.Database, fileId: number, values: number[]) {
  db.prepare('DELETE FROM audio_subfingerprints WHERE file_id=?').run(fileId);
  const insert = db.prepare('INSERT INTO audio_subfingerprints(file_id,idx,value) VALUES (?,?,?)');
  values.forEach((value, idx) => insert.run(fileId, idx, value));
}
