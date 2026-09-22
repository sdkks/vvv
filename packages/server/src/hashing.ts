import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type Database from 'better-sqlite3';
import type { FileHashAlgorithm } from '@vvv/shared';
import sharp from 'sharp';

export async function processFile(
  path: string,
  algorithm: FileHashAlgorithm = 'sha256'
): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function dHash(pixels: Uint8Array): Buffer {
  if (pixels.length !== 72) throw new Error('Expected 9x8 single-channel pixels');
  const hash = Buffer.alloc(8);
  // Difference b=r*8+c is numeric bit b (top-left = LSB), stored as a big-endian BLOB.
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (pixels[r * 9 + c]! > pixels[r * 9 + c + 1]!) hash[7 - r]! |= 1 << c;
  return hash;
}
export const hashBands = (hash: Buffer): number[] =>
  [0, 2, 4, 6].map((offset) => hash.readUInt16BE(offset));
export const bandProbes = (value: number): number[] => [
  value,
  ...Array.from({ length: 16 }, (_, bit) => value ^ (1 << bit)),
];
export function hamming(a: Uint8Array, b: Uint8Array): number {
  let distance = 0;
  for (let i = 0; i < 8; i++) {
    let bits = a[i]! ^ b[i]!;
    while (bits) {
      bits &= bits - 1;
      distance++;
    }
  }
  return distance;
}
export async function imageMetadata(path: string) {
  const { width, height } = await sharp(path).metadata();
  return { width, height };
}
export async function imageHash(path: string) {
  const image = sharp(path);
  const { width, height } = await image.metadata();
  const pixels = await image
    .resize(9, 8, { fit: 'fill' })
    .greyscale()
    .removeAlpha()
    .raw()
    .toBuffer();
  return { hash: dHash(pixels), width, height };
}
export const storeImageHash = (db: Database.Database, fileId: number, hash: Buffer) =>
  storeHashes(db, fileId, [hash]);
export function storeHashes(db: Database.Database, fileId: number, hashes: Buffer[]) {
  db.prepare('DELETE FROM phash_bands WHERE file_id=?').run(fileId);
  db.prepare('DELETE FROM phashes WHERE file_id=?').run(fileId);
  const phash = db.prepare('INSERT INTO phashes(file_id,frame_idx,hash) VALUES (?,?,?)');
  const insert = db.prepare(
    'INSERT INTO phash_bands(band_idx,frame_idx,band_val,file_id) VALUES (?,?,?,?)'
  );
  hashes.forEach((hash, frame) => {
    phash.run(fileId, frame, hash);
    hashBands(hash).forEach((value, band) => insert.run(band, frame, value, fileId));
  });
}
