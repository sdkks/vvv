import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import type { DirectoryEntries, ScanDir } from '@vvv/shared';
import { DirectoryPreview, PreviewContents } from './DirectoryPreview';
import { breadcrumbs, decisionLabel, pageCursors } from './directory-preview';

const dir: ScanDir = {
  id: 1,
  path: '/media/photos',
  follow_symlinks: false,
  cross_filesystems: false,
  file_count: 0,
};
it('builds clickable breadcrumbs including root and preserves unusual names literally', () => {
  expect(breadcrumbs('')).toEqual([{ name: 'Root', path: '' }]);
  expect(breadcrumbs('summer/<&>/sub')).toEqual([
    { name: 'Root', path: '' },
    { name: 'summer', path: 'summer' },
    { name: '<&>', path: 'summer/<&>' },
    { name: 'sub', path: 'summer/<&>/sub' },
  ]);
});
it('keeps opaque cursor history and backs up without changing previous history', () => {
  const first = [''];
  const second = pageCursors(first, 'opaque?token');
  const third = pageCursors(second, 'next-token');
  expect(first).toEqual(['']);
  expect(third).toEqual(['', 'opaque?token', 'next-token']);
  expect(pageCursors(third)).toEqual(second);
  expect(pageCursors(second)).toEqual(first);
  expect(pageCursors(first)).toEqual(first);
});
it('labels every scan decision in ordinary language', () => {
  expect(decisionLabel).toEqual({
    folder: 'Folder — open to explore',
    would_process: 'Would be processed',
    excluded_by_size: 'Excluded by size',
    unsupported_type: 'Not a supported media type',
    symlink_not_followed: 'Symlink not followed',
    filesystem_boundary: 'Across a filesystem boundary',
    permission_denied: 'Permission denied',
    inside_trash: 'Inside trash',
    other: 'Unavailable',
  });
});
function render(data?: DirectoryEntries, error = false, closed = false) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity, retryOnMount: false },
    },
  });
  const key = ['directory-entries', dir, '', 'media', ''];
  if (data) client.setQueryData(key, data);
  if (error)
    client
      .getQueryCache()
      .build(client, { queryKey: key })
      .setState({ status: 'error', error: new Error('Permission denied.'), fetchStatus: 'idle' });
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      closed
        ? createElement(DirectoryPreview, { dir })
        : createElement(PreviewContents, { dir, focusHeading: false, close: () => undefined })
    )
  );
  client.clear();
  return html;
}
it('initially renders only a collapsed preview action', () => {
  const html = render(undefined, false, true);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('aria-controls="preview-1"');
  expect(html).not.toContain('Read-only preview');
});
it('renders the loading announcement and disables paging', () => {
  const html = render();
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('Loading contents');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain('<button disabled="">Next</button>');
});
it('renders safe metadata, keyboard folder controls, table semantics, and the active policy', () => {
  const html = render({
    path: '',
    has_more: true,
    next_cursor: 'opaque',
    items: [
      { name: 'folder<&>', kind: 'folder', type: 'folder', size: null, decision: 'folder' },
      { name: 'image.png', kind: 'image', type: 'file', size: 1024, decision: 'would_process' },
      {
        name: 'link.jpg',
        kind: 'image',
        type: 'symlink',
        size: null,
        decision: 'symlink_not_followed',
      },
    ],
  });
  expect(html).toContain('Preview of /media/photos');
  expect(html).toContain('reads directory metadata only');
  expect(html).toContain('not followed');
  expect(html).toContain('not crossed');
  expect(html).toContain('Saved size policy applies');
  expect(html).not.toContain('No size filter');
  expect(html).toContain('Trash is excluded');
  expect(html).toContain('aria-label="Preview breadcrumb"');
  expect(html).toContain('<button aria-current="location">Root</button>');
  expect(html).toContain('<button>folder&lt;&amp;&gt;</button>');
  expect(html).toContain('<caption>');
  expect(html).toContain('scope="col"');
  expect(html).toContain('data-label="Scan decision"');
  expect(html).toContain('1 KiB');
  expect(html).toContain('Would be processed');
  expect(html).toContain('Symlink not followed');
  expect(html).toContain('<button>Next</button>');
  expect(html).toContain('Close preview');
});
it('renders the size exclusion reason and configured range without offering folder navigation', () => {
  const detail = '512 KiB below minimum 1 MiB. Configured range: minimum 1 MiB, maximum disabled.';
  const html = render({
    path: '',
    has_more: false,
    next_cursor: null,
    items: [
      {
        name: 'small.jpg',
        type: 'file',
        kind: 'image',
        size: 524288,
        decision: 'excluded_by_size',
        decision_detail: detail,
      },
    ],
  });
  expect(html).toContain(`Excluded by size: ${detail}`);
  expect(html).not.toContain('<button>small.jpg</button>');
});
it('distinguishes an empty media filter from a whole-directory count', () => {
  const html = render({ path: '', has_more: false, next_cursor: null, items: [] });
  expect(html).toContain('No media candidates or folders');
  expect(html).toContain('Use Show all');
});
it('renders a recoverable error without a misleading stale listing', () => {
  const html = render(undefined, true);
  expect(html).toContain('role="alert"');
  expect(html).toContain('Permission denied');
  expect(html).toContain('<button>Retry</button>');
  expect(html).not.toContain('<table>');
});
