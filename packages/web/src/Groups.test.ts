import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { Groups } from './Groups';
import type { GroupsResponse } from '@vvv/shared';
import { groupsKey, kindFilter } from './group-review';

function render(kind: string, data?: GroupsResponse) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  if (data) client.setQueryData(groupsKey(kindFilter(kind), ''), data);
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: [`/groups${kind ? `?kind=${kind}` : ''}`] },
        createElement(Groups)
      )
    )
  );
  client.clear();
  return html;
}

it.each([
  ['exact', "Same file bytes only; re-encoded or resized copies won't match."],
  [
    'image',
    'Finds similar images after resizing or re-encoding; it does not find different scenes.',
  ],
  [
    'video',
    'Finds re-encoded or resized videos with aligned frames. Trims, clips, or changed intros may not match.',
  ],
  [
    'audio_partial',
    'Finds a shorter recording inside a longer one, even with an offset. Both need audio; standalone audio files are included.',
  ],
])('describes only the selected %s kind below its native filter', (kind, hint) => {
  const html = render(kind);
  expect(html).toContain('aria-describedby="kind-hint"');
  expect(html).toContain(`value="${kind}" selected=""`);
  expect(html).toContain(renderToStaticMarkup(createElement('p', { id: 'kind-hint' }, hint)));
  expect(html.match(/id="kind-hint"/g)).toHaveLength(1);
  expect(html.indexOf('id="kind-hint"')).toBeGreaterThan(html.indexOf('</select>'));
  expect(html).not.toContain('Different match types find different kinds of duplicates.');
});

it('keeps preview first and existing kind, count, bytes, and row destinations intact', () => {
  const html = render('image', {
    items: [
      {
        id: 9,
        kind: 'image',
        member_count: 2,
        total_bytes: 2048,
        reclaimable_bytes: 1024,
        representative: { file_id: 42, kind: 'image' },
      },
      {
        id: 10,
        kind: 'audio_partial',
        member_count: 3,
        total_bytes: 1024,
        reclaimable_bytes: 512,
        representative: null,
      },
    ],
    next_cursor: null,
  });
  expect(html).toContain('href="/groups/9?kind=image"');
  expect(html).toContain(
    '<span class="group-preview thumbnail fallback">Loading…</span><span class="group-summary">'
  );
  expect(html).toContain(
    '<span class="group-preview thumbnail fallback">No preview</span><span class="group-summary">'
  );
  expect(html).toContain('<span class="group-kind">image</span> Group 9');
  expect(html).toContain('2 members · 2 KiB total');
  expect(html).toContain('1 KiB reclaimable');
  expect(html).toContain('3 members · 1 KiB total');
  expect(html).not.toContain('<img');
});

it.each(['', 'unknown'])('points the all-kinds filter (%s) to Settings', (kind) => {
  const html = render(kind);
  expect(html).toContain('value="" selected=""');
  expect(html).toContain(
    '<p id="kind-hint">Different match types find different kinds of duplicates. See Matching behavior in <a href="/settings" data-discover="true">Settings</a>.</p>'
  );
});
