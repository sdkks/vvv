import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CurrentScanResponse, ScanDir } from '@vvv/shared';
import { expect, it } from 'vitest';
import { Scan } from './Scan';
import { Directories } from './Directories';

const directory: ScanDir = {
  id: 1,
  path: '/media/photos',
  file_count: 12,
  follow_symlinks: false,
  cross_filesystems: false,
};
function render(component: typeof Scan, scan: CurrentScanResponse, items: ScanDir[] = [directory]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  client.setQueryData(['scan-current'], scan);
  client.setQueryData(['scan-dirs'], { items });
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
it('renders idle onboarding and does not offer an enabled start until directories exist', () => {
  const empty = render(Scan, null, []);
  expect(empty).toContain('Ready to scan');
  expect(empty).toContain('No scan directories registered');
  expect(empty).toContain('href="/directories"');
  expect(empty).toMatch(/<button disabled="">Start scan<\/button>/);
  const idle = render(Scan, null);
  expect(idle).toContain('<button>Start scan</button>');
  expect(idle).toContain('<legend>Include in this scan</legend>');
  expect(idle.match(/type="checkbox"/g)).toHaveLength(3);
  expect(idle).toContain('Standalone audio controls audio files, not tracks in selected videos');
});
it.each([
  ['running', 'Scan running', 'Cancel scan'],
  ['interrupted', 'Previous scan was interrupted', 'already-processed, unchanged files'],
  ['cancelled', 'Scan cancelled', 'Work already completed is saved'],
  ['done', 'Scan complete', 'Duplicate matching may still be finishing'],
] as const)(
  'renders %s distinctly with persistent summary and errors disclosure',
  (status, title, detail) => {
    const html = render(Scan, {
      id: 1,
      status,
      started_at: '2026-09-21 12:00:00',
      finished_at: '2026-09-21 12:00:45',
      discovered: 12,
      processed: 8,
      errors: 2,
      current_file: '/media/<movie>.mp4',
    });
    expect(html).toContain(title);
    expect(html).toContain(detail);
    expect(html).toContain('8 processed · 12 discovered · 2 errors');
    expect(html).toContain('Per-file errors (2)');
    expect(html).toContain('aria-live="polite"');
    if (status === 'running') expect(html).toContain('<fieldset class="toolbar" disabled="">');
    if (status === 'running') {
      expect(html).toContain('No percentage estimate');
      expect(html).toContain('/media/&lt;movie&gt;.mp4');
    } else expect(html).toContain('Elapsed: 0:00:45');
  }
);
it('uses indeterminate discovery and determinate processing/completion without inventing a zero total', () => {
  const scan: Exclude<CurrentScanResponse, null> = {
    id: 1,
    status: 'running',
    started_at: '2026-09-21 12:00:00',
    discovered: 12,
    processed: 8,
    errors: 0,
  };
  const discovering = render(Scan, scan);
  expect(discovering).toMatch(/<progress[^>]*max="12"><\/progress>/);
  expect(discovering).toContain(
    'Discovering and processing files — total may grow. No percentage estimate.'
  );
  expect(render(Scan, { ...scan, current_file: '/media/a.jpg' })).toMatch(
    /<progress[^>]*max="12" value="8">/
  );
  expect(render(Scan, { ...scan, status: 'done', processed: 12 })).toMatch(
    /<progress[^>]*max="12" value="12">/
  );
  expect(render(Scan, { ...scan, discovered: 0, processed: 0 })).not.toContain('value="0"');
  expect(render(Scan, { ...scan, status: 'done', discovered: 0, processed: 0 })).not.toContain(
    '<progress'
  );
  expect(render(Scan, null)).not.toContain('<progress');
});

it('renders directory guidance, independent toggles, catalog count and removal', () => {
  const empty = render(Directories, null, []);
  expect(empty).toContain('inside the container');
  expect(empty).toContain('not host paths');
  expect(empty).toContain('No scan directories yet');
  expect(empty).toContain('for="directory-path"');
  const populated = render(Directories, null);
  expect(populated).toContain('<legend>/media/photos</legend>');
  expect(populated).toContain('12 catalogued files');
  expect(populated).toContain('Follow symbolic links');
  expect(populated).toContain('Cross filesystem boundaries');
  expect(populated).toContain('Remove directory');
});
