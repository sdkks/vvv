import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Page, Settings as Policy, TrashItem } from '@vvv/shared';
import { expect, it } from 'vitest';
import { Settings } from './Settings';
import { Trash } from './Trash';
import { UndoToast } from './UndoToast';

const policy: Policy = {
  retention_days: 30,
  auto_purge_enabled: false,
  matching: {
    file_hash_algorithm: 'sha256',
    methods: [
      {
        id: 'exact',
        label: 'Exact duplicates — SHA-256',
        algorithm: 'sha256',
        scope: 'all files',
        enabled: true,
        threshold: null,
      },
      {
        id: 'image_dhash',
        label: 'Near-duplicate images (perceptual dHash)',
        scope: 'image files',
        enabled: true,
        threshold: 6,
      },
      {
        id: 'video_dhash',
        label: 'Near-duplicate videos (frame perceptual dHash)',
        scope: 'video files',
        enabled: true,
        threshold: 10,
      },
      {
        id: 'audio_chromaprint',
        label: 'Audio matching (Chromaprint)',
        scope: 'audio files and videos with sound',
        enabled: true,
        threshold: null,
      },
    ],
    video_frame_count: 9,
    video_timeout_ms: 600000,
    audio_timeout_ms: 600000,
    min_file_size_mb: 0,
    max_file_size_mb: 0,
  },
};
const item: TrashItem = {
  id: 1,
  file_id: 3,
  scan_dir_id: 1,
  path: '/media/<photo>.jpg',
  trash_rel_path: '.vvv-trash/1',
  size: 1024,
  quarantined_at: '2026-09-21 12:00:00',
  purge_after: null,
};
function render(component: ComponentType, items: TrashItem[] = [], settings = policy) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  client.setQueryData(['settings'], settings);
  client.setQueryData(['trash', ''], { items, next_cursor: null } satisfies Page<TrashItem>);
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, null, createElement(component))
    )
  );
  client.clear();
  return html;
}
it('renders empty Trash, policy, disabled purge and paging controls', () => {
  const html = render(Trash);
  expect(html).toContain('Trash is empty');
  expect(html).toContain('kept until manually purged');
  expect(html).toContain('<button disabled="">Purge selected (0)</button>');
  expect(html).toContain('aria-label="Trash pages"');
});
it('shows escaped original paths, size, dates, restore and server-provided purge deadline', () => {
  const html = render(Trash, [item]);
  expect(html).toContain('/media/&lt;photo&gt;.jpg');
  expect(html).toContain('1 KiB');
  expect(html).toContain('Quarantined:');
  expect(html).toContain('Purge after: Auto-purge off');
  expect(html).toContain('<button>Restore</button>');
  expect(
    render(Trash, [{ ...item, purge_after: '2026-10-21 12:00:00' }], {
      ...policy,
      auto_purge_enabled: true,
    })
  ).toContain('Purge after:');
});
it('renders settings labels, bounded retention and irreversible warning', () => {
  const html = render(Settings);
  expect(html).toContain('for="retention"');
  expect(html).toContain('min="1" max="3650" step="1"');
  expect(html).toContain('Automatically purge expired files');
  expect(html).toContain('including existing Trash. This cannot be undone.');
  expect(html).toContain('<button>Save settings</button>');
});
it('renders read-only matching methods above retention with defaults and honest explanations', () => {
  const html = render(Settings);
  const section = html.slice(html.indexOf('<section'), html.indexOf('</section>'));
  expect(html.indexOf('Matching behavior')).toBeLessThan(html.indexOf('Retention days'));
  for (const method of policy.matching.methods) {
    expect(section).toContain(method.label);
    expect(section).toContain(method.scope);
    if (method.id === 'exact') expect(section).toContain(`${method.scope} · Always on`);
  }
  expect(section).toContain('Identical content hashes; no similarity threshold');
  expect(section).toContain('Hamming distance ≤ 6');
  expect(section).toContain('Mean aligned-frame Hamming distance ≤ 10');
  expect(section).toContain('9 frames per video');
  expect(section).toContain('Sampling timeout: 10 minutes');
  expect(section.match(/class="matching-badge">Default/g)).toHaveLength(6);
  expect(section).not.toContain('>Current<');
  expect(section).toContain('Exact matching is always on');
  expect(section.match(/class="matching-badge">Enabled/g)).toHaveLength(4);
  expect(section).toContain('Size filter: disabled');
  expect(section).toContain(
    'No AI or neural methods are used. Matching runs entirely locally: content hashes, perceptual dHash comparisons, and Chromaprint audio fingerprints.'
  );
  expect(section).toContain('<details><summary>How matching works</summary>');
  expect(section).toContain('Lower thresholds are stricter');
  expect(section).toContain('aligned sample positions');
  expect(section).toContain('Thresholds apply at match time');
  expect(section).toContain('Existing groups reflect the last completed match run');
  expect(section).not.toMatch(/<(input|select|button|form)\b/);
});
it('keeps matching controls in a separate disclosure with labels, units, discard and save states', () => {
  const html = render(Settings);
  expect(html.indexOf('Matching behavior')).toBeLessThan(
    html.indexOf('Advanced matching controls')
  );
  expect(html.indexOf('Advanced matching controls')).toBeLessThan(html.indexOf('Retention days'));
  expect(html).toContain('<summary>Advanced matching controls</summary>');
  expect(html).toContain('Sampling timeout (seconds) (10–3600)');
  expect(html).toContain('value="600"');
  expect(html).toContain('<button disabled="">Save matching controls</button>');
  expect(html).toContain('Discard changes');
  expect(html).toContain('Matching controls match saved values');
  expect(html).toContain('role="status" aria-live="polite"');
  expect(html).toContain('not content-hash checkpoints');
});
it('shows Enabled and Off badges for saved switches while exact stays always on', () => {
  const html = render(Settings, [], {
    ...policy,
    matching: {
      ...policy.matching,
      methods: policy.matching.methods.map((m) =>
        m.id === 'exact' ? m : { ...m, enabled: false }
      ),
    },
  });
  const section = html.slice(html.indexOf('<section'), html.indexOf('</section>'));
  expect(section.match(/class="matching-badge">Off/g)).toHaveLength(3);
  expect(section.match(/class="matching-badge">Enabled/g)).toHaveLength(1);
  expect(section).toContain('all files · Always on');
});
it('shows Current badges independently for customized thresholds and sampling values', () => {
  const html = render(Settings, [], {
    ...policy,
    matching: {
      file_hash_algorithm: 'sha256',
      methods: policy.matching.methods.map((method) =>
        method.id === 'image_dhash'
          ? { ...method, threshold: 0 }
          : method.id === 'video_dhash'
            ? { ...method, threshold: 12 }
            : method
      ),
      video_frame_count: 1,
      video_timeout_ms: 90000,
      audio_timeout_ms: 600000,
      min_file_size_mb: 1,
      max_file_size_mb: 100,
    },
  });
  expect(html).toContain('Hamming distance ≤ 0');
  expect(html).toContain('Mean aligned-frame Hamming distance ≤ 12');
  expect(html).toContain('1 frame per video');
  expect(html).toContain('Sampling timeout: 90 seconds');
  expect(html).toContain('Size filter: 1–100 MiB');
  expect(html.match(/class="matching-badge">Current/g)).toHaveLength(4);
  expect(html.match(/class="matching-badge">Default/g)).toHaveLength(2);
});
it.each([
  [60000, '1 minute'],
  [1000, '1 second'],
  [1, '0.001 seconds'],
])('shows sampling timeout %d without rounding away its effective value', (ms, label) => {
  expect(
    render(Settings, [], {
      ...policy,
      matching: { ...policy.matching, video_timeout_ms: ms },
    })
  ).toContain(`Sampling timeout: ${label}`);
});
it('announces an undo opportunity in a polite live region', () => {
  const html = render(() => createElement(UndoToast, { ids: [2, 3] }));
  expect(html).toContain('role="status" aria-live="polite"');
  expect(html).toContain('Quarantined 2 files');
  expect(html).toContain('<button>Undo</button>');
});
