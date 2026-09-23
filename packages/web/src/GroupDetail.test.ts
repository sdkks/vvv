import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GroupMember, GroupResponse } from '@vvv/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupDetail, KeeperAnnouncement } from './GroupDetail';
import type { KeeperCriterion } from './group-review';

let selectedCriteria: KeeperCriterion[] = [];
vi.mock('react', async (importOriginal) => {
  const original = await importOriginal<typeof import('react')>();
  return {
    ...original,
    useState: (initial: unknown) =>
      original.useState(Array.isArray(initial) && !initial.length ? selectedCriteria : initial),
  };
});
afterEach(() => {
  selectedCriteria = [];
});
import { PageHeading } from './PageHeading';

function renderMembers(
  similarities: (number | null)[],
  attrs: {
    size?: number;
    width?: number | null;
    height?: number | null;
    duration_ms?: number | null;
  }[] = [],
  pagination: { next_cursor?: string | null; member_count?: number } = {}
) {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, staleTime: Infinity } },
  });
  const group: GroupResponse = {
    id: 1,
    kind: similarities[0] === null ? 'exact' : 'image',
    member_count: pagination.member_count ?? similarities.length,
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
      next_cursor: pagination.next_cursor ?? null,
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
it('renders the keeper fieldset before review and quarantine, with explained metadata disabling', () => {
  const html = renderMembers([0, 1], [{}, { width: null }]);
  expect(html).toContain('<legend>Choose one file to keep</legend>');
  expect(html.match(/type="checkbox"/g)).toHaveLength(3);
  expect(html).toContain('Highest resolution (quality proxy)');
  expect(html).toContain('Longest duration');
  expect(html).toContain('Largest file size');
  expect(html).toContain('aria-describedby="keeper-resolution-help"');
  expect(html).toContain(
    'Resolution unavailable for some files; choose another rule or review manually.'
  );
  expect(html).toContain(
    'Duration unavailable for some files; choose another rule or review manually.'
  );
  expect(html).toContain(
    'This replaces current markings but moves nothing yet. Clear markings resets.'
  );
  expect(html).toContain('<button disabled="">Mark other files for Trash</button>');
  expect(html.indexOf('auto-mark-menu')).toBeLessThan(html.indexOf('<legend>Choose'));
  expect(html.indexOf('<legend>Choose')).toBeLessThan(html.indexOf('<ul class="members"'));
  expect(html.indexOf('<ul class="members"')).toBeLessThan(
    html.indexOf('Quarantine 0 marked files')
  );
});
it.each([
  { next_cursor: 'page2', member_count: 3, enabled: false },
  { next_cursor: null, member_count: 3, enabled: false },
  { next_cursor: null, member_count: 2, enabled: true },
])('guards keeper selection until all members are loaded: %j', ({ enabled, ...pagination }) => {
  selectedCriteria = ['size'];
  const html = renderMembers([0, 1], [], pagination);
  expect(html.includes('<button disabled="">Mark other files for Trash</button>')).toBe(!enabled);
  expect(html.includes('Load all members to choose a keeper.')).toBe(!enabled);
  if (!enabled) expect(html).toContain('2 of 3 loaded.');
});
it('does not use an unavailable selected criterion after more members arrive', () => {
  selectedCriteria = ['duration'];
  const html = renderMembers([0, 1], [{ duration_ms: 1000 }, { duration_ms: null }]);
  expect(html).not.toContain('checked=""');
  expect(html).toContain('<button disabled="">Mark other files for Trash</button>');
});
it('renders the polite keeper review announcement and a focusable full path for colliding filenames', () => {
  const member: GroupMember = {
    file_id: 2,
    path: '/media/original/clip.mp4',
    size: 100,
    width: 100,
    height: 100,
    duration_ms: 1000,
    quarantined: false,
    similarity: 0,
  };
  const html = renderToStaticMarkup(
    createElement(KeeperAnnouncement, {
      review: {
        keeper: member,
        criteria: ['resolution', 'duration'],
        members: [member, { ...member, file_id: 1, path: '/media/copy/clip.mp4' }],
      },
    })
  );
  expect(html).toContain('role="status" aria-live="polite"');
  expect(html).toContain(
    'Keeping clip.mp4 (highest resolution, longest duration); marked 1 of 2 for Trash. Review below, then confirm quarantine.'
  );
  expect(html).toContain(
    '<p class="file-path" tabindex="0">Kept file: /media/original/clip.mp4</p>'
  );
  expect(renderToStaticMarkup(createElement(KeeperAnnouncement, { review: null }))).toBe(
    '<div role="status" aria-live="polite"></div>'
  );
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
