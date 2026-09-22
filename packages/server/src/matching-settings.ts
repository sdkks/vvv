import type Database from 'better-sqlite3';
import type { MatchingSettings } from '@vvv/shared';

const defaults = {
  image_phash_threshold: { value: 6, min: 0, max: 64 },
  video_phash_threshold: { value: 10, min: 0, max: 64 },
  video_frame_count: { value: 9, min: 1, max: 64 },
  video_timeout_ms: { value: 600000, min: 1, max: 2147483647 },
};

export function numericSetting(
  db: Database.Database,
  key: string,
  fallback: number,
  max: number,
  min = 0
) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
    { value: string } | undefined;
  const value = Number(row?.value ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
  return value;
}

export function matchingSetting(db: Database.Database, key: keyof typeof defaults) {
  const { value, min, max } = defaults[key];
  return numericSetting(db, key, value, max, min);
}

export function matchingSettings(db: Database.Database): MatchingSettings {
  return {
    methods: [
      {
        id: 'exact',
        label: 'Exact duplicates (SHA-256)',
        scope: 'all files',
        enabled: true,
        threshold: null,
      },
      {
        id: 'image_dhash',
        label: 'Near-duplicate images (perceptual dHash)',
        scope: 'image files',
        enabled: true,
        threshold: matchingSetting(db, 'image_phash_threshold'),
      },
      {
        id: 'video_dhash',
        label: 'Near-duplicate videos (frame perceptual dHash)',
        scope: 'video files',
        enabled: true,
        threshold: matchingSetting(db, 'video_phash_threshold'),
      },
    ],
    video_frame_count: matchingSetting(db, 'video_frame_count'),
    video_timeout_ms: matchingSetting(db, 'video_timeout_ms'),
  };
}
