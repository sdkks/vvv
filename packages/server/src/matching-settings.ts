import type Database from 'better-sqlite3';
import type { FileHashAlgorithm, FileSizePolicy, MatchingSettings } from '@vvv/shared';

const defaults = {
  match_images_enabled: { value: 1, min: 0, max: 1 },
  match_videos_enabled: { value: 1, min: 0, max: 1 },
  match_audio_enabled: { value: 1, min: 0, max: 1 },
  image_phash_threshold: { value: 6, min: 0, max: 64 },
  video_phash_threshold: { value: 10, min: 0, max: 64 },
  video_frame_count: { value: 9, min: 1, max: 64 },
  video_timeout_ms: { value: 600000, min: 1, max: 2147483647 },
  audio_timeout_ms: { value: 600000, min: 1, max: 2147483647 },
  min_file_size_mb: { value: 0, min: 0, max: Number.MAX_SAFE_INTEGER },
  max_file_size_mb: { value: 0, min: 0, max: Number.MAX_SAFE_INTEGER },
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

export function fileHashAlgorithm(db: Database.Database): FileHashAlgorithm {
  const row = db.prepare("SELECT value FROM settings WHERE key='file_hash_algorithm'").get() as
    { value: string } | undefined;
  const value = row?.value ?? 'sha256';
  if (value !== 'sha256' && value !== 'blake2b512') throw new Error('Invalid file_hash_algorithm');
  return value;
}

export function matchingEnabled(db: Database.Database, kind: 'image' | 'video' | 'audio') {
  // The audio switch is singular: match_audio_enabled, unlike match_images/match_videos.
  return (
    matchingSetting(db, kind === 'audio' ? 'match_audio_enabled' : `match_${kind}s_enabled`) === 1
  );
}

export function validSizeRange({ min_file_size_mb: min, max_file_size_mb: max }: FileSizePolicy) {
  return min === 0 || max === 0 || max >= min;
}

export function fileSizeSettings(db: Database.Database): FileSizePolicy {
  const policy = {
    min_file_size_mb: matchingSetting(db, 'min_file_size_mb'),
    max_file_size_mb: matchingSetting(db, 'max_file_size_mb'),
  };
  if (!validSizeRange(policy)) throw new Error('Invalid file size range');
  return policy;
}

export function matchingSettings(db: Database.Database): MatchingSettings {
  const algorithm = fileHashAlgorithm(db);
  return {
    ...fileSizeSettings(db),
    file_hash_algorithm: algorithm,
    methods: [
      {
        id: 'exact',
        label: `Exact duplicates — ${algorithm === 'sha256' ? 'SHA-256' : 'BLAKE2B-512'}`,
        algorithm,
        scope: 'all files',
        enabled: true,
        threshold: null,
      },
      {
        id: 'image_dhash',
        label: 'Near-duplicate images (perceptual dHash)',
        scope: 'image files',
        enabled: matchingEnabled(db, 'image'),
        threshold: matchingSetting(db, 'image_phash_threshold'),
      },
      {
        id: 'video_dhash',
        label: 'Near-duplicate videos (frame perceptual dHash)',
        scope: 'video files',
        enabled: matchingEnabled(db, 'video'),
        threshold: matchingSetting(db, 'video_phash_threshold'),
      },
      {
        id: 'audio_chromaprint',
        label: 'Audio matching (Chromaprint)',
        scope: 'audio files and videos with sound',
        enabled: matchingEnabled(db, 'audio'),
        threshold: null,
      },
    ],
    video_frame_count: matchingSetting(db, 'video_frame_count'),
    video_timeout_ms: matchingSetting(db, 'video_timeout_ms'),
    audio_timeout_ms: matchingSetting(db, 'audio_timeout_ms'),
  };
}
