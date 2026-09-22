import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GroupResponse } from '@vvv/shared';
import { expect, it } from 'vitest';
import { GroupDetail } from './GroupDetail';
import { PageHeading } from './PageHeading';

function renderMembers(
  similarities: (number | null)[],
  attrs: {
    size?: number;
    width?: number | null;
    height?: number | null;
    duration_ms?: number | null;
  }[] = []
) {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const group: GroupResponse = {
    id: 1,
    kind: similarities[0] === null ? 'exact' : 'image',
    member_count: similarities.length,
    total_bytes: 300,
    reclaimable_bytes: 200,
    members: {
      items: similarities.map((similarity, index) => ({
        file_id: index + 1,
        path: `/media/image-${index}.jpg`,
        size: 100,
        width: 100,
        height: 100,
        duration_ms: null,
        quarantined: false,
        similarity,
        ...attrs[index],
      })),
      next_cursor: null,
    },
  };
  client.setQueryData(['groups', 'detail', '1'], { pages: [group], pageParams: [''] });
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        null,
        createElement(GroupDetail, {
          id: '1',
          back: '/groups',
          onStale: () => {},
          onApplied: async () => {},
        })
      )
    )
  );
  client.clear();
  return html;
}

it('labels the reference and non-reference perceptual distances, including zero', () => {
  const html = renderMembers([0, 5, 0]);
  expect(html.match(/>Reference</g)).toHaveLength(1);
  expect(html).toContain('it is not necessarily the best copy.');
  expect(html).toContain('Distance from reference: 5');
  expect(html.match(/Distance from reference: 0/g)).toHaveLength(1);
  expect(html).not.toContain('Exact copy');
  expect(html).toContain('aria-live="polite"');
});
it('labels exact members without fabricating perceptual distances', () => {
  const html = renderMembers([null, null]);
  expect(html).toContain('>Reference<');
  expect(html.match(/Exact copy/g)).toHaveLength(2);
  expect(html).not.toContain('Distance from reference:');
});
it('renders a semantic page heading that is programmatically focusable, not a tab stop', () => {
  const html = renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(PageHeading, null, 'Page title'))
  );
  expect(html).toBe('<h1 tabindex="-1">Page title</h1>');
});
it('renders a closed auto-mark menu, disabling criteria the whole group lacks', () => {
  const html = renderMembers([null, null]);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('aria-controls="auto-mark-menu"');
  expect(html).toContain('aria-label="Auto-mark criteria"');
  expect(html).toContain('hidden=""');
  for (const label of [
    'Keep largest size',
    'Keep smallest size',
    'Keep highest resolution',
    'Keep lowest resolution',
  ]) {
    expect(html).toContain(`>${label}</button>`);
    expect(html).not.toContain(`<button disabled="">${label}</button>`);
  }
  // Image members carry no duration, so both duration criteria are disabled.
  for (const label of ['Keep longest duration', 'Keep shortest duration']) {
    expect(html).toContain(`<button disabled="">${label}</button>`);
  }
});
it('enables duration criteria and disables resolution criteria when only durations exist', () => {
  const html = renderMembers(
    [null, null],
    [
      { width: null, height: null, duration_ms: 5000 },
      { width: null, height: null, duration_ms: 3000 },
    ]
  );
  expect(html).toContain('>Keep longest duration</button>');
  expect(html).not.toContain('<button disabled="">Keep longest duration</button>');
  expect(html).toContain('<button disabled="">Keep highest resolution</button>');
  expect(html).toContain('<button disabled="">Keep lowest resolution</button>');
});
