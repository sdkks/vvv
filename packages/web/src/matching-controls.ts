import type {
  FileSizePolicy,
  MatchingControls,
  MatchingSettings,
  SettingsConsequence,
} from '@vvv/shared';

export const matchingFields = [
  { key: 'image_phash_threshold', label: 'Image threshold', min: 0, max: 64 },
  { key: 'video_phash_threshold', label: 'Video threshold', min: 0, max: 64 },
  { key: 'video_frame_count', label: 'Frames per video', min: 1, max: 64 },
  { key: 'video_timeout_ms', label: 'Sampling timeout (seconds)', min: 10, max: 3600 },
  { key: 'min_file_size_mb', label: 'Min file size (MiB)', min: 0, max: Number.MAX_SAFE_INTEGER },
  { key: 'max_file_size_mb', label: 'Max file size (MiB)', min: 0, max: Number.MAX_SAFE_INTEGER },
] as const;
export type MatchingDraft = Record<keyof MatchingControls, string>;
export const isSizeField = (key: keyof MatchingControls) =>
  key === 'min_file_size_mb' || key === 'max_file_size_mb';
export function sizePolicyLabel({ min_file_size_mb: min, max_file_size_mb: max }: FileSizePolicy) {
  return min && max
    ? `${min}–${max} MiB`
    : min
      ? `at least ${min} MiB`
      : max
        ? `at most ${max} MiB`
        : 'disabled';
}
export function matchingDraft(settings: MatchingSettings): MatchingDraft {
  return {
    image_phash_threshold: String(settings.methods.find((m) => m.id === 'image_dhash')?.threshold),
    video_phash_threshold: String(settings.methods.find((m) => m.id === 'video_dhash')?.threshold),
    video_frame_count: String(settings.video_frame_count),
    video_timeout_ms: String(settings.video_timeout_ms / 1000),
    min_file_size_mb: settings.min_file_size_mb ? String(settings.min_file_size_mb) : '',
    max_file_size_mb: settings.max_file_size_mb ? String(settings.max_file_size_mb) : '',
  };
}
function timeoutMilliseconds(seconds: string): number {
  if (!/^\d+(?:\.\d{1,3})?$/.test(seconds.trim())) return NaN;
  const [whole, fraction = ''] = seconds.trim().split('.');
  // Scale the decimal parts separately to avoid fractional milliseconds from floating-point error.
  return Number(whole) * 1000 + Number(fraction.padEnd(3, '0'));
}
export function matchingErrors(draft: MatchingDraft): Partial<MatchingDraft> {
  const errors: Partial<MatchingDraft> = Object.fromEntries(
    matchingFields.flatMap<[keyof MatchingDraft, string]>(({ key, min, max }) => {
      if (key === 'video_timeout_ms') {
        const ms = timeoutMilliseconds(draft[key]);
        return Number.isInteger(ms) && ms >= min * 1000 && ms <= max * 1000
          ? []
          : [[key, `Enter seconds from ${min} to ${max} with at most 3 decimal places.`]];
      }
      if (isSizeField(key) && !draft[key].trim()) return [];
      const value = Number(draft[key]);
      return draft[key].trim() && Number.isSafeInteger(value) && value >= min && value <= max
        ? []
        : [[key, `Enter a whole number from ${min} to ${max}.`]];
    })
  );
  const min = Number(draft.min_file_size_mb),
    max = Number(draft.max_file_size_mb);
  if (!errors.min_file_size_mb && !errors.max_file_size_mb && min > 0 && max > 0 && min > max)
    errors.max_file_size_mb = 'Maximum must be at least minimum when both are enabled.';
  return errors;
}
export function matchingPayload(draft: MatchingDraft): MatchingControls {
  return {
    image_phash_threshold: Number(draft.image_phash_threshold),
    video_phash_threshold: Number(draft.video_phash_threshold),
    video_frame_count: Number(draft.video_frame_count),
    video_timeout_ms: timeoutMilliseconds(draft.video_timeout_ms),
    // Empty inputs explicitly disable persisted limits rather than leaving old bounds in place.
    min_file_size_mb: Number(draft.min_file_size_mb),
    max_file_size_mb: Number(draft.max_file_size_mb),
  };
}
export const consequenceMessages: Record<SettingsConsequence['type'], string> = {
  rematch_required: 'Results use the previous thresholds. Re-match to apply.',
  rescan_required:
    'Videos will be re-sampled on the next scan. Re-match becomes available after that scan completes.',
  future_sampling_only: 'Sampling timeout applies to future or retried sampling only.',
  next_scan_required:
    'Size policy applies to the next scan; files outside the range are excluded from processing and results.',
};
