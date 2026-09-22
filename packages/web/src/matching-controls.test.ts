import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MatchingSettings, SettingsConsequence } from '@vvv/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { AdvancedMatching } from './AdvancedMatching';
import {
  consequenceMessages,
  isSizeField,
  sizePolicyLabel,
  matchingDraft,
  matchingErrors,
  matchingFields,
  matchingPayload,
  mergeConsequences,
  consequenceMessage,
  type MatchingDraft,
} from './matching-controls';
import { SettingsValidationError, updateSettings } from './api';

vi.mock('react', async (importOriginal) => {
  const original = await importOriginal<typeof React>();
  return { ...original, useState: vi.fn(original.useState) };
});

const draft: MatchingDraft = {
  match_images_enabled: true,
  match_videos_enabled: true,
  image_phash_threshold: '6',
  video_phash_threshold: '10',
  video_frame_count: '9',
  video_timeout_ms: '600',
  min_file_size_mb: '',
  max_file_size_mb: '',
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(React.useState).mockReset();
});
it.each(matchingFields.filter(({ key }) => key !== 'video_timeout_ms' && !isSizeField(key)))(
  'validates integer bounds and empty drafts for $key',
  ({ key, min, max }) => {
    for (const value of ['', ' ', 'bad', String(min - 1), String(max + 1), String(min + 0.5)])
      expect(matchingErrors({ ...draft, [key]: value })[key]).toBe(
        `Enter a whole number from ${min} to ${max}.`
      );
    for (const value of [min, max])
      expect(matchingErrors({ ...draft, [key]: String(value) })).toEqual({});
  }
);
it.each(['', ' ', 'bad', '0.5', '9.999', '3600.001', '10.0001', '10.1234', 'Infinity', '10..1'])(
  'rejects invalid or out-of-bounds timeout seconds %j',
  (seconds) => {
    expect(matchingErrors({ ...draft, video_timeout_ms: seconds })).toEqual({
      video_timeout_ms: 'Enter seconds from 10 to 3600 with at most 3 decimal places.',
    });
  }
);
it.each([
  ['10', 10000],
  ['10.001', 10001],
  ['10.1', 10100],
  ['10.01', 10010],
  ['32.001', 32001],
  ['3599.999', 3599999],
  ['3600', 3600000],
])('accepts timeout seconds %s and converts exactly to %i ms', (seconds, ms) => {
  const values = { ...draft, video_timeout_ms: seconds };
  expect(matchingErrors(values)).toEqual({});
  expect(matchingPayload(values).video_timeout_ms).toBe(ms);
});
it('round-trips a saved timeout that is not a whole number of seconds', () => {
  const values = matchingDraft({ ...matching, video_timeout_ms: 10001 });
  expect(values.video_timeout_ms).toBe('10.001');
  expect(matchingErrors(values)).toEqual({});
  expect(matchingPayload(values).video_timeout_ms).toBe(10001);
});
it('uses saved effective values and converts seconds to milliseconds only in the payload', () => {
  const result = matchingDraft({
    methods: [
      { id: 'image_dhash', label: '', scope: '', enabled: true, threshold: 0 },
      { id: 'video_dhash', label: '', scope: '', enabled: true, threshold: 64 },
    ],
    video_frame_count: 1,
    video_timeout_ms: 90000,
    min_file_size_mb: 0,
    max_file_size_mb: 0,
  });
  expect(result).toEqual({
    match_images_enabled: true,
    match_videos_enabled: true,
    image_phash_threshold: '0',
    video_phash_threshold: '64',
    video_frame_count: '1',
    video_timeout_ms: '90',
    min_file_size_mb: '',
    max_file_size_mb: '',
  });
  expect(matchingPayload(result)).toEqual({
    match_images_enabled: true,
    match_videos_enabled: true,
    image_phash_threshold: 0,
    video_phash_threshold: 64,
    video_frame_count: 1,
    video_timeout_ms: 90000,
    min_file_size_mb: 0,
    max_file_size_mb: 0,
  });
});
it.each(['min_file_size_mb', 'max_file_size_mb'] as const)(
  'validates optional integer size field %s',
  (key) => {
    for (const value of ['-1', '0.1', 'bad', 'Infinity', String(Number.MAX_SAFE_INTEGER + 1)])
      expect(matchingErrors({ ...draft, [key]: value })[key]).toBeTruthy();
    for (const value of ['', ' ', '0', '1', String(Number.MAX_SAFE_INTEGER)])
      expect(matchingErrors({ ...draft, [key]: value })).toEqual({});
  }
);
it('validates ranges and sends explicit zero when a saved size bound is cleared', () => {
  const saved = matchingDraft({ ...matching, min_file_size_mb: 1, max_file_size_mb: 100 });
  expect(saved).toMatchObject({ min_file_size_mb: '1', max_file_size_mb: '100' });
  expect(matchingErrors({ ...saved, max_file_size_mb: '0' })).toEqual({});
  expect(matchingErrors({ ...saved, min_file_size_mb: '101' })).toEqual({
    max_file_size_mb: 'Maximum must be at least minimum when both are enabled.',
  });
  expect(matchingPayload({ ...saved, min_file_size_mb: '', max_file_size_mb: '' })).toMatchObject({
    min_file_size_mb: 0,
    max_file_size_mb: 0,
  });
  expect(sizePolicyLabel({ min_file_size_mb: 1, max_file_size_mb: 0 })).toBe('at least 1 MiB');
  expect(sizePolicyLabel({ min_file_size_mb: 0, max_file_size_mb: 100 })).toBe('at most 100 MiB');
});
it('renders optional size inputs as Disabled with next-scan consequences and suppresses premature rematch', () => {
  const html = renderConsequences([
    { type: 'next_scan_required', reason: 'size_filter_change' },
    { type: 'rematch_required', reason: 'threshold_change' },
  ]);
  for (const key of ['min_file_size_mb', 'max_file_size_mb']) {
    expect(html).toContain(`for="${key}"`);
    const input = html.match(new RegExp(`<input id="${key}"[^>]*>`))?.[0];
    expect(input).toContain('placeholder="Disabled"');
    expect(input).toContain('value=""');
    expect(input).toContain('aria-describedby="size-policy-help"');
    expect(input).not.toContain('required');
  }
  expect(html).toContain(consequenceMessages.next_scan_required);
  expect(html).not.toContain('Re-match now');
});
it('preserves server field details for inline errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json(
        {
          error: 'invalid_settings',
          fields: {
            video_timeout_ms: 'must be >= 10000',
            image_phash_threshold: 99,
          },
        },
        { status: 400 }
      )
    )
  );
  await expect(updateSettings({ video_timeout_ms: 1 })).rejects.toEqual(
    new SettingsValidationError({ video_timeout_ms: 'must be >= 10000' })
  );
});
it('uses exact consequence messaging', () => {
  expect(consequenceMessages.rematch_required).toBe(
    'Results use the previous thresholds. Re-match to apply.'
  );
  expect(consequenceMessages.rescan_required).toBe(
    'Videos will be re-sampled on the next scan. Re-match becomes available after that scan completes.'
  );
  expect(consequenceMessages.future_sampling_only).toContain('future or retried sampling only');
});

const matching: MatchingSettings = {
  methods: [
    { id: 'image_dhash', label: '', scope: '', enabled: true, threshold: 6 },
    { id: 'video_dhash', label: '', scope: '', enabled: true, threshold: 10 },
  ],
  video_frame_count: 9,
  video_timeout_ms: 10001,
  min_file_size_mb: 0,
  max_file_size_mb: 0,
};
function renderConsequences(consequences: SettingsConsequence[], settings = matching) {
  vi.mocked(React.useState)
    .mockReturnValueOnce([undefined, vi.fn()])
    .mockReturnValueOnce([false, vi.fn()])
    .mockReturnValueOnce([consequences, vi.fn()]);
  const client = new QueryClient();
  const html = renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(AdvancedMatching, { matching: settings })
    )
  );
  client.clear();
  return html;
}
it('withholds Re-match now while combined threshold and frame changes require a rescan', () => {
  const html = renderConsequences([
    { type: 'rematch_required', reason: 'threshold_change' },
    { type: 'rescan_required', reason: 'frame_count_change' },
  ]);
  expect(html).toContain(consequenceMessages.rematch_required);
  expect(html).toContain(consequenceMessages.rescan_required);
  expect(html).not.toContain('Re-match now');
});
it('offers Re-match now for a threshold-only change', () => {
  const html = renderConsequences([{ type: 'rematch_required', reason: 'threshold_change' }]);
  expect(html).toContain(consequenceMessages.rematch_required);
  expect(html).toContain('<button>Re-match now</button>');
  expect(html).not.toContain(consequenceMessages.rescan_required);
});
it('renders off controls disabled with explanations and never provides an exact switch', () => {
  const off = {
    ...matching,
    methods: matching.methods.map((m) => (m.id === 'exact' ? m : { ...m, enabled: false })),
  };
  const html = renderConsequences([], off);
  expect(html.match(/type="checkbox"/g)).toHaveLength(2);
  expect(html).toContain('Image perceptual matching — Off');
  expect(html).toContain('Video perceptual matching — Off');
  for (const field of [
    'image_phash_threshold',
    'video_phash_threshold',
    'video_frame_count',
    'video_timeout_ms',
  ]) {
    const input = html.match(new RegExp(`<input id="${field}"[^>]*>`))?.[0];
    expect(input).toContain('disabled=""');
    expect(input).toContain(
      `title="Enable ${field.startsWith('image') ? 'image' : 'video'} matching to configure"`
    );
  }
  expect(matchingDraft(off)).toMatchObject({
    match_images_enabled: false,
    match_videos_enabled: false,
  });
  const invalidOff = {
    ...matchingDraft(off),
    video_frame_count: 'invalid',
    image_phash_threshold: '',
  };
  expect(matchingErrors(invalidOff)).toEqual({});
  expect(matchingPayload(invalidOff)).toEqual({
    match_images_enabled: false,
    match_videos_enabled: false,
    min_file_size_mb: 0,
    max_file_size_mb: 0,
  });
});
it('gates newly enabled matching until a scan and replaces obsolete same-kind consequences', () => {
  const enabled: SettingsConsequence[] = [
    {
      type: 'match_enabled',
      kind: 'video',
      message: 'Existing video files will be analyzed on the next scan (no content re-hashing).',
    },
    { type: 'rematch_required', reason: 'match_enabled', kind: 'video' },
  ];
  const off: SettingsConsequence = {
    type: 'match_disabled',
    kind: 'video',
    message: 'Video matching disabled; re-match removes groups.',
  };
  const image: SettingsConsequence = {
    type: 'match_disabled',
    kind: 'image',
    message: 'Image matching disabled.',
  };
  const html = renderConsequences(enabled);
  expect(html).toContain(consequenceMessage(enabled[0]!));
  expect(html).toContain('Re-match video files after the next scan completes.');
  expect(html).not.toContain('Re-match now');
  expect(renderConsequences([off])).toContain('Re-match now');
  expect(mergeConsequences([off, image], enabled)).toEqual([image, ...enabled]);
  expect(mergeConsequences(enabled, [off])).toEqual([off]);
});
it('renders millisecond-precision timeout seconds with a compatible input step', () => {
  const html = renderConsequences([]);
  expect(html).toContain('step="0.001"');
  expect(html).toContain('value="10.001"');
  expect(html).toContain('Matching controls match saved values.');
});
