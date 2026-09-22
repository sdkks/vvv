import type { MatchingControls, MatchingSettings, SettingsConsequence } from '@vvv/shared';

export const matchingFields = [
  { key: 'image_phash_threshold', label: 'Image threshold', min: 0, max: 64 },
  { key: 'video_phash_threshold', label: 'Video threshold', min: 0, max: 64 },
  { key: 'video_frame_count', label: 'Frames per video', min: 1, max: 64 },
  { key: 'video_timeout_ms', label: 'Sampling timeout (seconds)', min: 10, max: 3600 },
] as const;
export type MatchingDraft = Record<keyof MatchingControls, string>;
export function matchingDraft(settings: MatchingSettings): MatchingDraft {
  return {
    image_phash_threshold: String(settings.methods.find((m) => m.id === 'image_dhash')?.threshold),
    video_phash_threshold: String(settings.methods.find((m) => m.id === 'video_dhash')?.threshold),
    video_frame_count: String(settings.video_frame_count),
    video_timeout_ms: String(settings.video_timeout_ms / 1000),
  };
}
function timeoutMilliseconds(seconds: string): number {
  if (!/^\d+(?:\.\d{1,3})?$/.test(seconds.trim())) return NaN;
  const [whole, fraction = ''] = seconds.trim().split('.');
  // Scale the decimal parts separately to avoid fractional milliseconds from floating-point error.
  return Number(whole) * 1000 + Number(fraction.padEnd(3, '0'));
}
export function matchingErrors(draft: MatchingDraft): Partial<MatchingDraft> {
  return Object.fromEntries(
    matchingFields.flatMap<[keyof MatchingDraft, string]>(({ key, min, max }) => {
      if (key === 'video_timeout_ms') {
        const ms = timeoutMilliseconds(draft[key]);
        return Number.isInteger(ms) && ms >= min * 1000 && ms <= max * 1000
          ? []
          : [[key, `Enter seconds from ${min} to ${max} with at most 3 decimal places.`]];
      }
      const value = Number(draft[key]);
      return draft[key].trim() && Number.isInteger(value) && value >= min && value <= max
        ? []
        : [[key, `Enter a whole number from ${min} to ${max}.`]];
    })
  );
}
export function matchingPayload(draft: MatchingDraft): MatchingControls {
  return {
    image_phash_threshold: Number(draft.image_phash_threshold),
    video_phash_threshold: Number(draft.video_phash_threshold),
    video_frame_count: Number(draft.video_frame_count),
    video_timeout_ms: timeoutMilliseconds(draft.video_timeout_ms),
  };
}
export const consequenceMessages: Record<SettingsConsequence['type'], string> = {
  rematch_required: 'Results use the previous thresholds. Re-match to apply.',
  rescan_required:
    'Videos will be re-sampled on the next scan. Re-match becomes available after that scan completes.',
  future_sampling_only: 'Sampling timeout applies to future or retried sampling only.',
};
