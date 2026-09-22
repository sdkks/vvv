import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  fileHashAlgorithm,
  fileSizeSettings,
  matchingSetting,
  matchingSettings,
  numericSetting,
} from './matching-settings.js';
import { mediaSetting } from './video.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
});
afterEach(() => db.close());

it.each([
  ['match_images_enabled', 1, 0, 1],
  ['match_videos_enabled', 1, 0, 1],
  ['image_phash_threshold', 6, 0, 64],
  ['video_phash_threshold', 10, 0, 64],
  ['video_frame_count', 9, 1, 64],
  ['video_timeout_ms', 600000, 1, 2147483647],
  ['min_file_size_mb', 0, 0, Number.MAX_SAFE_INTEGER],
  ['max_file_size_mb', 0, 0, Number.MAX_SAFE_INTEGER],
] as const)('preserves defaults and validation for %s', (key, fallback, min, max) => {
  expect(matchingSetting(db, key)).toBe(fallback);
  const put = db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)');
  for (const value of [min, max]) {
    put.run(key, String(value));
    expect(matchingSetting(db, key)).toBe(value);
  }
  for (const value of [min - 1, max + 1, 1.5, 'NaN', 'Infinity', 'invalid']) {
    put.run(key, String(value));
    expect(() => matchingSetting(db, key)).toThrow(`Invalid ${key}`);
  }
});
it('defaults content hashing to SHA-256, reports either algorithm and rejects corrupt stored values', () => {
  expect(fileHashAlgorithm(db)).toBe('sha256');
  expect(db.prepare('SELECT * FROM settings').all()).toEqual([]);
  const put = db.prepare("INSERT OR REPLACE INTO settings VALUES ('file_hash_algorithm',?)");
  for (const [algorithm, label] of [
    ['sha256', 'SHA-256'],
    ['blake2b512', 'BLAKE2B-512'],
  ]) {
    put.run(algorithm);
    expect(matchingSettings(db)).toMatchObject({
      file_hash_algorithm: algorithm,
      methods: [
        expect.objectContaining({ id: 'exact', algorithm, label: `Exact duplicates — ${label}` }),
        expect.anything(),
        expect.anything(),
      ],
    });
  }
  for (const value of ['', 'md5', 'SHA256', 'blake2b', ' sha256 ']) {
    put.run(value);
    expect(() => fileHashAlgorithm(db)).toThrow('Invalid file_hash_algorithm');
  }
});
it('reads absent size limits as disabled and rejects invalid persisted ranges', () => {
  expect(fileSizeSettings(db)).toEqual({ min_file_size_mb: 0, max_file_size_mb: 0 });
  db.exec("INSERT INTO settings VALUES ('min_file_size_mb','2'),('max_file_size_mb','1')");
  expect(() => fileSizeSettings(db)).toThrow('Invalid file size range');
  db.exec("UPDATE settings SET value='0' WHERE key='max_file_size_mb'");
  expect(fileSizeSettings(db)).toEqual({ min_file_size_mb: 2, max_file_size_mb: 0 });
});
it('preserves the separate thumbnail fallback and nonnegative bucket cap', () => {
  expect(mediaSetting(db, 'video_timeout_ms', 120000, 2147483647)).toBe(120000);
  expect(numericSetting(db, 'phash_bucket_cap', 2000, Number.MAX_SAFE_INTEGER)).toBe(2000);
  db.exec("INSERT INTO settings VALUES ('phash_bucket_cap','0'),('video_timeout_ms','0')");
  expect(numericSetting(db, 'phash_bucket_cap', 2000, Number.MAX_SAFE_INTEGER)).toBe(0);
  expect(() => mediaSetting(db, 'video_timeout_ms', 120000, 2147483647)).toThrow(
    'Invalid video_timeout_ms'
  );
});
