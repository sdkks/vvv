import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { Groups } from './Groups';

function render(kind: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
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

it.each(['', 'unknown'])('points the all-kinds filter (%s) to Settings', (kind) => {
  const html = render(kind);
  expect(html).toContain('value="" selected=""');
  expect(html).toContain(
    '<p id="kind-hint">Different match types find different kinds of duplicates. See Matching behavior in <a href="/settings" data-discover="true">Settings</a>.</p>'
  );
});
