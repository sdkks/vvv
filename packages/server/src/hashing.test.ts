import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import {
  bandProbes,
  dHash,
  hamming,
  hashBands,
  imageHash,
  processFile,
  storeImageHash,
} from './hashing.js';
import { openDatabase } from './db.js';

it('streams stable distinct content digests with known SHA-256 and BLAKE2B-512 vectors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vvv-content-hash-'));
  try {
    const path = join(root, 'content');
    await writeFile(path, 'abc');
    const sha = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const blake =
      'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923';
    expect(await processFile(path)).toBe(sha);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await processFile(path, 'sha256')).toBe(sha);
      expect(await processFile(path, 'blake2b512')).toBe(blake);
    }
    await expect(processFile(join(root, 'missing'), 'blake2b512')).rejects.toThrow('ENOENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
const blob = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
};
it('packs the canonical row-major numeric bits as an eight-byte big-endian blob', () => {
  expect(dHash(Buffer.alloc(72, 255))).toEqual(blob(0n));
  const pixels = Buffer.from(Array.from({ length: 72 }, (_, i) => (i % 9) * 30));
  expect(dHash(pixels)).toEqual(blob(0n)); // Increasing black-to-white: no left pixel is brighter.
  expect(dHash(Buffer.from(pixels.map((v) => 255 - v)))).toEqual(blob(0xffffffffffffffffn));
  pixels[0] = 255;
  expect(dHash(pixels).toString('hex')).toBe('0000000000000001');
  pixels[70] = 255;
  expect(dHash(pixels).toString('hex')).toBe('8000000000000001');
  expect(() => dHash(Buffer.alloc(144))).toThrow('single-channel');
  for (let bit = 0; bit < 64; bit++)
    expect(blob(1n << BigInt(bit)).readBigUInt64BE()).toBe(1n << BigInt(bit));
  expect(hashBands(blob(0x123456789abcdef0n))).toEqual([0x1234, 0x5678, 0x9abc, 0xdef0]);
  expect(hamming(blob(0n), blob(0xffffffffffffffffn))).toBe(64);
});

it('probes 68 keys and retrieves every tested pair through distance seven, with misses above it', () => {
  const retrieves = (a: bigint, b: bigint) =>
    hashBands(blob(a)).some((band, i) => bandProbes(band).includes(hashBands(blob(b))[i]!));
  expect(hashBands(blob(0n)).flatMap(bandProbes)).toHaveLength(68);
  expect(new Set(bandProbes(123))).toHaveLength(17);
  // Every distribution of up to seven differences among four 16-bit bands has a <=1 band.
  for (let a = 0; a <= 7; a++)
    for (let b = 0; b <= 7 - a; b++)
      for (let c = 0; c <= 7 - a - b; c++)
        for (let d = 0; d <= 7 - a - b - c; d++) {
          const diff = [a, b, c, d].reduce(
            (n, bits) => (n << 16n) | ((1n << BigInt(bits)) - 1n),
            0n
          );
          expect(retrieves(0x123456789abcdef0n, 0x123456789abcdef0n ^ diff)).toBe(true);
        }
  expect(retrieves(0n, 0x0003000300030003n)).toBe(false);
});

it('decodes opaque/alpha images to one channel, stores/replaces bands atomically and cascades deletes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vvv-hash-'));
  const { db } = openDatabase(root);
  try {
    const path = join(root, 'image.png');
    await sharp({
      create: {
        width: 18,
        height: 16,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 0.5 },
      },
    })
      .png()
      .toFile(path);
    const result = await imageHash(path);
    expect(result).toEqual({ width: 18, height: 16, hash: blob(0n) });
    db.exec(`INSERT INTO scan_dirs(path) VALUES ('/media');
      INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns) VALUES (1,'a.png','image',0,0)`);
    db.transaction(() => storeImageHash(db, 1, blob(0x123456789abcdef0n)))();
    expect(
      db
        .prepare('SELECT band_idx,frame_idx,band_val,file_id FROM phash_bands ORDER BY band_idx')
        .all()
    ).toEqual(
      [0x1234, 0x5678, 0x9abc, 0xdef0].map((band_val, band_idx) => ({
        band_idx,
        frame_idx: 0,
        band_val,
        file_id: 1,
      }))
    );
    db.transaction(() => storeImageHash(db, 1, blob(0n)))();
    expect(db.prepare('SELECT count(*) AS n FROM phash_bands').get()).toEqual({ n: 4 });
    expect(db.prepare('SELECT hash FROM phashes').get()).toEqual({ hash: blob(0n) });
    expect(db.pragma('index_info(idx_phash_bands_file)')).toMatchObject([{ name: 'file_id' }]);
    expect(() => db.prepare('INSERT INTO phashes VALUES (1,1,?)').run(Buffer.alloc(7))).toThrow(
      /CHECK/
    );
    db.exec('DELETE FROM files');
    expect(db.prepare('SELECT count(*) AS n FROM phash_bands').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM phashes').get()).toEqual({ n: 0 });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
