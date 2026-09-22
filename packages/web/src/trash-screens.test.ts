import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Page, Settings as Policy, TrashItem } from '@vvv/shared';
import { expect, it } from 'vitest';
import { Settings } from './Settings';
import { Trash } from './Trash';
import { UndoToast } from './UndoToast';

const policy: Policy = { retention_days: 30, auto_purge_enabled: false };
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
it('announces an undo opportunity in a polite live region', () => {
  const html = render(() => createElement(UndoToast, { ids: [2, 3] }));
  expect(html).toContain('role="status" aria-live="polite"');
  expect(html).toContain('Quarantined 2 files');
  expect(html).toContain('<button>Undo</button>');
});
