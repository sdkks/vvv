import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import type { BrowseResponse } from '@vvv/shared';
import { DirectoryPicker } from './DirectoryPicker';
import { Directories } from './Directories';
import { finishPicking, folderBreadcrumbs, pickerStartPath } from './directory-picker';

it('uses an existing absolute input or delegates the default path to the server', () => {
  expect(pickerStartPath(' /media/photos ')).toBe('/media/photos');
  expect(pickerStartPath('/')).toBe('/');
  expect(pickerStartPath('')).toBeUndefined();
  expect(pickerStartPath('relative')).toBeUndefined();
  expect(pickerStartPath('/bad\0')).toBeUndefined();
});
it('builds absolute root and nested breadcrumbs, preserving folder names literally', () => {
  expect(folderBreadcrumbs('/')).toEqual([{ name: '/', path: '/' }]);
  expect(folderBreadcrumbs('/media/<&>/summer photos')).toEqual([
    { name: '/', path: '/' },
    { name: 'media', path: '/media' },
    { name: '<&>', path: '/media/<&>' },
    { name: 'summer photos', path: '/media/<&>/summer photos' },
  ]);
});
it('Select fills the add input, closes the modal and returns focus to the input', () => {
  let open = true;
  const input = { value: '/old', focus: vi.fn() };
  const browse = { focus: vi.fn() };
  finishPicking(
    () => {
      open = false;
    },
    input,
    browse,
    '/media/selected'
  );
  expect(input.value).toBe('/media/selected');
  expect(open).toBe(false);
  expect(input.focus).toHaveBeenCalledOnce();
  expect(browse.focus).not.toHaveBeenCalled();
});
it('Cancel closes without changing the add path and restores focus to Browse', () => {
  let open = true;
  const input = { value: '/keep', focus: vi.fn() };
  const browse = { focus: vi.fn() };
  finishPicking(
    () => {
      open = false;
    },
    input,
    browse
  );
  expect(open).toBe(false);
  expect(input.value).toBe('/keep');
  expect(browse.focus).toHaveBeenCalledOnce();
  expect(input.focus).not.toHaveBeenCalled();
});
function render(data?: BrowseResponse, error = false, closed = false) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
        staleTime: Infinity,
        retryOnMount: false,
      },
    },
  });
  const queryKey = ['browse', undefined, ''];
  if (data) client.setQueryData(queryKey, data);
  if (error)
    client
      .getQueryCache()
      .build(client, { queryKey })
      .setState({
        status: 'error',
        error: new Error('Directory unavailable.'),
        fetchStatus: 'idle',
      });
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        null,
        closed
          ? createElement(Directories)
          : createElement(DirectoryPicker, { close: () => undefined })
      )
    )
  );
  client.clear();
  return html;
}
it('starts closed with Browse beside the labelled path input, not a submit button', () => {
  const html = render(undefined, false, true);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain(
    'type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="directory-picker"'
  );
  expect(html).toContain('Browse…');
  expect(html).not.toContain('Choose directory');
});
it('renders the modal immediately even while loading and disables Select until success', () => {
  const html = render();
  expect(html).toContain('<dialog id="directory-picker"');
  expect(html).toContain('aria-labelledby="picker-heading"');
  expect(html).toContain('aria-describedby="picker-description"');
  expect(html).toContain('id="picker-heading" tabindex="-1"');
  expect(html).not.toContain('<details');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('Loading folders…');
  expect(html).toContain('<button disabled="">Select</button>');
  expect(html).toContain('<button>Cancel</button>');
});
it('renders clickable breadcrumbs, folder buttons, manual path form and paging', () => {
  const html = render({
    path: '/media/photos',
    items: [{ name: '<&>', path: '/media/photos/<&>' }],
    next_cursor: 'opaque',
  });
  expect(html).toContain('Choose directory: /media/photos');
  expect(html).toContain('aria-label="Directory breadcrumb"');
  expect(html).toContain('aria-current="location">photos</button>');
  expect(html).toContain('<button>&lt;&amp;&gt;</button>');
  expect(html).toContain('for="browse-path">Go to path</label>');
  expect(html).toContain('value="/media/photos"');
  expect(html).toContain('<button>Go</button>');
  expect(html).toContain('<footer class="directory-picker-footer">');
  expect(html).toContain('aria-label="Folder pages"');
  expect(html).toContain('<button disabled="">Previous</button>');
  expect(html).toContain('<button>Next</button>');
  expect(html).toContain('<button>Select</button>');
});
it('permits selecting an empty directory and suppresses stale folders on errors', () => {
  const empty = render({ path: '/media', items: [], next_cursor: null });
  expect(empty).toContain('No subfolders — Select to use this path');
  expect(empty).toContain('<button>Select</button>');
  expect(empty).toContain('<button disabled="">Next</button>');
  const html = render(
    { path: '/media', items: [{ name: 'stale', path: '/media/stale' }], next_cursor: 'old' },
    true
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain('Directory unavailable.');
  expect(html).toContain('<button>Retry</button>');
  expect(html).toContain('<button disabled="">Next</button>');
  expect(html).not.toContain('<ul class="folder-list"');
  expect(html).not.toContain('<button>stale</button>');
  expect(html).toContain('<button disabled="">Select</button>');
});
