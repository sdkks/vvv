import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GroupsResponse, QuarantineResponse } from '@vvv/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Groups } from './Groups';
import {
  api,
  getThumbnail,
  GroupMissingError,
  ResultsChangedError,
  ThumbnailUnavailableError,
} from './api';
import {
  applyRecovery,
  autoMark,
  autoMarkAvailable,
  autoMarkCriteria,
  groupsKey,
  isVideo,
  keeperByCriteria,
  keeperCriteria,
  keeperEligible,
  nextGroup,
  nextMember,
  previousCursor,
  recoverGroups,
  reviewShortcut,
  toggleMarked,
  visitCursor,
} from './group-review';

const navigate = vi.hoisted(() => vi.fn());
let applied: ((result: QuarantineResponse) => Promise<void>) | undefined;
vi.mock('react-router', async (original) => ({
  ...(await original<typeof import('react-router')>()),
  useNavigate: () => navigate,
}));
vi.mock('./GroupDetail', () => ({
  GroupDetail: (props: { onApplied: typeof applied }) => {
    applied = props.onApplied;
    return null;
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  applied = undefined;
});

const groups = (...ids: number[]) =>
  ids.map((id) => ({
    id,
    kind: 'exact' as const,
    member_count: 2,
    total_bytes: 10,
    reclaimable_bytes: 5,
    representative: null,
  }));

async function applyAtBoundary(
  listResponse: GroupsResponse,
  nextPage?: GroupsResponse,
  cursor = '',
  failures: { file_id: number; error: string }[] = [],
  detailError?: Response
) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const search = `?kind=exact${cursor ? `&cursor=${cursor}` : ''}`;
  vi.stubGlobal('window', { location: { pathname: '/groups/3', search } });
  const responses: GroupsResponse[] = [listResponse, ...(nextPage ? [nextPage] : [])];
  const fetch = vi.fn(async (url: string | URL) => {
    const path = String(url);
    if (path.includes('/api/files/quarantine'))
      return Response.json({
        moved: failures.length ? [] : [{ file_id: 6, trash_id: 9 }],
        failed: failures,
      });
    // The detail refetch after a partial apply returns the injected error, if any.
    if (detailError && /\/api\/groups\/\d+/.test(path)) return detailError;
    // Sequential list responses; the last repeats so recovery retries see a stable answer.
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    return Response.json(next);
  });
  vi.stubGlobal('fetch', fetch);
  cache.setQueryData(groupsKey('exact', cursor), {
    items: groups(1, 2, 3),
    next_cursor: 'old-next',
  });
  try {
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: cache },
        createElement(
          MemoryRouter,
          { initialEntries: [`/groups/3${search}`] },
          createElement(
            Routes,
            null,
            createElement(Route, { path: '/groups/:id', element: createElement(Groups) })
          )
        )
      )
    );
    if (!applied) throw new Error('Group detail did not receive its apply handler');
    await applied({ moved: [{ file_id: 6, trash_id: 9 }], failed: failures });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    return {
      target: navigate.mock.calls[0]?.[0],
      requests: fetch.mock.calls.map(([url]) => url),
    };
  } finally {
    cache.clear();
  }
}

describe('apply-and-advance', () => {
  it('recovers past failed items: dissolved groups advance and stale generations restart', () => {
    const missing = new GroupMissingError();
    const stale = new ResultsChangedError();
    const failures = 1;
    expect(applyRecovery(missing, { isPending: false, failedCount: failures })).toBe('advance');
    expect(applyRecovery(stale, { isPending: false, failedCount: failures })).toBe('stale');
    // Failed items alone never suppress recovery ordering: pending wins only while in flight.
    expect(applyRecovery(undefined, { isPending: true, failedCount: 0 })).toBe('none');
    expect(applyRecovery(undefined, { isPending: false, failedCount: failures })).toBe('none');
  });
  it('preserves pre-apply order and skips unactionable members without wrapping', () => {
    expect(nextGroup(groups(3, 1, 2), 1, groups(1, 2, 3), false)?.id).toBe(2);
    expect(nextGroup(groups(1, 2, 4), 3, groups(1, 2, 3), false)).toBeUndefined();
    expect(
      nextGroup([{ ...groups(2)[0]!, member_count: 1 }, ...groups(3)], 1, groups(1, 2, 3), false)
        ?.id
    ).toBe(3);
  });
  it('fetches the next page before wrapping at the old page boundary, despite a newly appended group', async () => {
    const result = await applyAtBoundary(
      { items: groups(1, 2, 4), next_cursor: 'later' },
      { items: [{ ...groups(5)[0]!, member_count: 1 }, ...groups(6, 7)], next_cursor: null }
    );
    expect(result).toEqual({
      target: '/groups/6?kind=exact&cursor=later',
      requests: ['/api/groups?kind=exact', '/api/groups?kind=exact&cursor=later'],
    });
  });
  it('wraps on the refreshed page when there is no next cursor', async () => {
    expect(await applyAtBoundary({ items: groups(1, 2, 4), next_cursor: null })).toEqual({
      target: '/groups/1?kind=exact',
      requests: ['/api/groups?kind=exact'],
    });
  });
  it('tries only one additional page before wrapping with the original page cursor', async () => {
    expect(
      await applyAtBoundary(
        { items: groups(1, 2, 4), next_cursor: 'later' },
        { items: [], next_cursor: 'beyond-bound' },
        'current'
      )
    ).toEqual({
      target: '/groups/1?kind=exact&cursor=current',
      requests: ['/api/groups?kind=exact&cursor=current', '/api/groups?kind=exact&cursor=later'],
    });
  });
  it.each([null, 'later'])(
    'returns to the group list when exhausted (next cursor: %s)',
    async (next_cursor) => {
      const result = await applyAtBoundary(
        { items: [], next_cursor },
        { items: groups(3), next_cursor: null }
      );
      expect(result.target).toBe('/groups?kind=exact');
      expect(result.requests).toHaveLength(next_cursor ? 2 : 1);
    }
  );
});

it('recognizes every scanner video extension without confusing image filenames or directories', () => {
  for (const extension of [
    'mp4',
    'mkv',
    'avi',
    'mov',
    'webm',
    'm4v',
    'mpg',
    'mpeg',
    'ts',
    'm2ts',
    'wmv',
    'flv',
  ]) {
    expect(isVideo(`/media/a.${extension}`)).toBe(true);
    expect(isVideo(`/media/a.${extension.toUpperCase()}`)).toBe(true);
  }
  for (const path of [
    '/media/clip.mp4/photo.jpg',
    '/media/still.png',
    '/media/mp4',
    '/media/a.mp4.jpg',
  ]) {
    expect(isVideo(path)).toBe(false);
  }
});

describe('cursor history', () => {
  it('pushes, pops, replaces a forward branch, and resets without mutating history', () => {
    const first = [''];
    const second = visitCursor(first, '', 'page2');
    const third = visitCursor(second, 'page2', 'page3');
    expect(first).toEqual(['']);
    expect(second).toEqual(['', 'page2']);
    expect(previousCursor(third, 'page3')).toBe('page2');
    expect(visitCursor(third, 'page3', 'page2')).toEqual(second);
    expect(visitCursor(third, 'page2', 'replacement')).toEqual(['', 'page2', 'replacement']);
    expect(visitCursor(third, 'page3', '')).toEqual(['']);
    expect(previousCursor(first, '')).toBeUndefined();
  });
  it('does not invent a previous page for a direct cursor URL', () => {
    expect(previousCursor(['deep'], 'deep')).toBeUndefined();
    expect(visitCursor([''], 'deep', 'later')).toEqual(['deep', 'later']);
    expect(visitCursor(['deep'], 'deep', '')).toEqual(['']);
  });
});

it('advances through loaded members and distinguishes a page boundary from the real end', () => {
  expect(nextMember(0, 50, true)).toBe(1);
  expect(nextMember(48, 50, true)).toBe(49);
  expect(nextMember(49, 50, true)).toBe('load');
  expect(nextMember(49, 60, false)).toBe(50);
  expect(nextMember(59, 60, false)).toBe('end');
  expect(nextMember(0, 0, false)).toBe('end');
});

describe('review shortcuts', () => {
  it.each([
    ['j', 'next'],
    ['ArrowDown', 'next'],
    ['k', 'previous'],
    ['ArrowUp', 'previous'],
    ['x', 'toggle'],
    [' ', 'toggle'],
    ['Enter', 'apply'],
    ['Escape', 'back'],
    ['q', null],
  ])('maps %s to %s', (key, action) => {
    expect(reviewShortcut(key, { tagName: 'LI' })).toBe(action);
  });
  it.each(['INPUT', 'TEXTAREA', 'SELECT'])('leaves %s controls alone', (tagName) => {
    for (const key of ['j', 'ArrowDown', 'x', ' ', 'Enter', 'Escape']) {
      expect(reviewShortcut(key, { tagName })).toBeNull();
    }
  });
  it('leaves editable content and modified keys alone', () => {
    expect(reviewShortcut('x', { tagName: 'SPAN', isContentEditable: true })).toBeNull();
    expect(reviewShortcut('x', { tagName: 'LI' }, true)).toBeNull();
  });
  it.each(['BUTTON', 'A'])('preserves native activation for %s', (tagName) => {
    expect(reviewShortcut(' ', { tagName })).toBeNull();
    expect(reviewShortcut('Enter', { tagName })).toBeNull();
    expect(reviewShortcut('j', { tagName })).toBe('next');
  });
});

it('toggles one marking while preserving the other markings and the original set', () => {
  const initial = new Set([1]);
  const marked = toggleMarked(initial, 2);
  expect(initial).toEqual(new Set([1]));
  expect(marked).toEqual(new Set([1, 2]));
  expect(toggleMarked(marked, 2)).toEqual(initial);
  expect(marked).toEqual(new Set([1, 2]));
});

describe('auto-mark', () => {
  const members = (
    ...specs: {
      file_id?: number;
      size?: number;
      width?: number | null;
      height?: number | null;
      duration_ms?: number | null;
    }[]
  ) =>
    specs.map((spec, index) => ({
      file_id: spec.file_id ?? index + 1,
      size: spec.size ?? 100,
      width: spec.width === undefined ? 100 : spec.width,
      height: spec.height === undefined ? 100 : spec.height,
      duration_ms: spec.duration_ms === undefined ? 1000 : spec.duration_ms,
    }));
  const sorted = (marked: Set<number>) => [...marked].sort((a, b) => a - b);
  const varied = members(
    { size: 300, width: 100, height: 100, duration_ms: 1000 },
    { size: 100, width: 400, height: 200, duration_ms: 5000 },
    { size: 200, width: 200, height: 150, duration_ms: 3000 }
  );
  it.each([
    ['largest_size', 1],
    ['smallest_size', 2],
    ['highest_resolution', 2],
    ['lowest_resolution', 1],
    ['longest_duration', 2],
    ['shortest_duration', 1],
  ] as const)('keeps the best member by %s and marks the rest for discard', (criterion, keep) => {
    const marked = autoMark(varied, criterion, new Set());
    expect(marked.has(keep)).toBe(false);
    expect(sorted(marked)).toEqual([1, 2, 3].filter((id) => id !== keep));
  });
  it('offers the six criteria with human labels', () => {
    expect(autoMarkCriteria.map(({ criterion }) => criterion)).toEqual([
      'largest_size',
      'smallest_size',
      'highest_resolution',
      'lowest_resolution',
      'longest_duration',
      'shortest_duration',
    ]);
    expect(autoMarkCriteria.map(({ label }) => label)).toEqual([
      'Keep largest size',
      'Keep smallest size',
      'Keep highest resolution',
      'Keep lowest resolution',
      'Keep longest duration',
      'Keep shortest duration',
    ]);
  });
  it('breaks ties by lowest file_id regardless of member order', () => {
    const tied = members({ file_id: 5, size: 100 }, { file_id: 2, size: 100 });
    expect(sorted(autoMark(tied, 'largest_size', new Set()))).toEqual([5]);
    expect(sorted(autoMark(tied, 'smallest_size', new Set()))).toEqual([5]);
  });
  it('never keeps a member missing the attribute but still marks it when another member wins', () => {
    const images = members({ duration_ms: null }, { duration_ms: 2000 });
    expect(sorted(autoMark(images, 'longest_duration', new Set()))).toEqual([1]);
    const dimensionless = members({ width: null, height: null }, { width: 10, height: 10 });
    expect(sorted(autoMark(dimensionless, 'highest_resolution', new Set()))).toEqual([1]);
  });
  it('returns prior markings unchanged and reports unavailable when every member lacks the attribute', () => {
    const images = members({ duration_ms: null }, { duration_ms: null });
    const prior = new Set([1]);
    expect(autoMark(images, 'longest_duration', prior)).toEqual(prior);
    expect(autoMarkAvailable(images, 'longest_duration')).toBe(false);
    expect(autoMarkAvailable(images, 'largest_size')).toBe(true);
    expect(autoMarkAvailable(varied, 'longest_duration')).toBe(true);
  });
  it('replaces prior markings, unmarking a previously marked winner', () => {
    expect(sorted(autoMark(varied, 'largest_size', new Set([1, 3])))).toEqual([2, 3]);
  });
  it('preserves marked ids outside the member list', () => {
    expect(
      sorted(autoMark(members({ file_id: 7 }, { file_id: 8 }), 'largest_size', new Set([99])))
    ).toEqual([8, 99]);
  });
  it('marks nothing in a single-member group', () => {
    expect(autoMark(members({ file_id: 4 }), 'largest_size', new Set()).size).toBe(0);
  });
});

describe('keeper selection', () => {
  const members = [
    { file_id: 9, size: 500, width: 200, height: 100, duration_ms: 8000 },
    { file_id: 4, size: 100, width: 100, height: 300, duration_ms: 2000 },
    { file_id: 7, size: 200, width: 300, height: 100, duration_ms: 3000 },
    { file_id: 6, size: 300, width: 150, height: 200, duration_ms: 3000 },
  ];
  it.each([
    [['resolution'], 4],
    [['duration'], 9],
    [['size'], 9],
    [['resolution', 'duration'], 6],
    [['resolution', 'size'], 6],
    [['duration', 'size'], 9],
    [['resolution', 'duration', 'size'], 6],
    [['size', 'resolution'], 9],
  ] as const)('selects lexicographically by %j, not a blended score', (criteria, id) => {
    expect(keeperByCriteria(members, criteria)?.file_id).toBe(id);
  });
  it('offers a fixed resolution, duration, size UI priority', () => {
    expect(keeperCriteria.map(({ criterion }) => criterion)).toEqual([
      'resolution',
      'duration',
      'size',
    ]);
  });
  it('breaks complete ties by lowest id, without mutating or depending on input order', () => {
    const tied = members.map((member) => ({ ...members[0]!, file_id: member.file_id }));
    const copy = structuredClone(tied);
    expect(keeperByCriteria(tied, ['resolution', 'duration', 'size'])?.file_id).toBe(4);
    expect(tied).toEqual(copy);
    expect(keeperByCriteria([...tied].reverse(), ['size'])?.file_id).toBe(4);
  });
  it.each([
    ['resolution', 'highest_resolution'],
    ['duration', 'longest_duration'],
    ['size', 'largest_size'],
  ] as const)('matches the existing %s menu rule for a single criterion', (criterion, old) => {
    const keeper = keeperByCriteria(members, [criterion]);
    expect(
      new Set(members.filter((member) => member !== keeper).map((member) => member.file_id))
    ).toEqual(autoMark(members, old, new Set(members.map((member) => member.file_id))));
  });
  it('requires every selected attribute but still includes missing-attribute members in discards', () => {
    const mixed = [
      { ...members[0]!, width: null },
      { ...members[1]!, duration_ms: null },
      members[2]!,
    ];
    const keeper = keeperByCriteria(mixed, ['resolution', 'duration']);
    expect(keeper?.file_id).toBe(7);
    expect(mixed.filter((member) => member !== keeper).map((member) => member.file_id)).toEqual([
      9, 4,
    ]);
    expect(keeperByCriteria(mixed, ['size'])?.file_id).toBe(9);
  });
  it('returns no keeper for no criteria, no members, or no member with all attributes', () => {
    expect(keeperByCriteria(members, [])).toBeUndefined();
    expect(keeperByCriteria([], ['size'])).toBeUndefined();
    expect(
      keeperByCriteria(
        [
          { ...members[0]!, width: null },
          { ...members[1]!, duration_ms: null },
        ],
        ['resolution', 'duration']
      )
    ).toBeUndefined();
  });
  it('disables a criterion if even one member lacks it, including either resolution dimension', () => {
    expect(keeperEligible(members, 'resolution')).toBe(true);
    expect(keeperEligible(members, 'duration')).toBe(true);
    for (const missing of [{ width: null }, { height: null }]) {
      expect(keeperEligible([members[0]!, { ...members[1]!, ...missing }], 'resolution')).toBe(
        false
      );
    }
    const mixed = [members[0]!, { ...members[1]!, duration_ms: null }];
    expect(keeperEligible(mixed, 'duration')).toBe(false);
    expect(keeperEligible(mixed, 'size')).toBe(true);
    expect(keeperEligible([], 'size')).toBe(false);
    expect(keeperEligible([{ ...members[0]!, duration_ms: 0 }], 'duration')).toBe(true);
  });
  it('keeps a lone eligible member', () => {
    expect(keeperByCriteria([members[0]!], ['size'])).toBe(members[0]);
  });
});

describe('stale recovery', () => {
  it('cancels in-flight work, clears every groups cache, restarts, and fetches page one with the same kind', async () => {
    const cache = new QueryClient();
    cache.setQueryData(groupsKey('image', 'old'), { old: true });
    cache.setQueryData(['groups', 'detail', '4'], { old: true });
    cache.setQueryData(['session'], { authenticated: true });
    let aborted = false;
    const oldRequest = cache
      .fetchQuery({
        queryKey: groupsKey('video', 'pending'),
        queryFn: ({ signal }) =>
          new Promise(() => {
            signal.addEventListener('abort', () => {
              aborted = true;
            });
          }),
      })
      .catch(() => undefined);
    const fresh = { items: [], next_cursor: null };
    const fetch = vi.fn().mockResolvedValue(Response.json(fresh));
    vi.stubGlobal('fetch', fetch);
    let history = ['', 'old'];
    const restart = vi.fn(() => {
      expect(aborted).toBe(true);
      expect(cache.getQueriesData({ queryKey: ['groups'] })).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
      history = visitCursor(history, 'old', '');
    });
    try {
      await recoverGroups(cache, 'image', restart);
      await oldRequest;
      expect(restart).toHaveBeenCalledOnce();
      expect(history).toEqual(['']);
      expect(fetch).toHaveBeenCalledWith(
        '/api/groups?kind=image',
        expect.objectContaining({ credentials: 'same-origin' })
      );
      expect(cache.getQueryData(groupsKey('image'))).toEqual(fresh);
      expect(cache.getQueryData(['session'])).toEqual({ authenticated: true });
    } finally {
      cache.clear();
    }
  });
  it('keeps the failed first-page request available for the list to render and retry', async () => {
    const cache = new QueryClient();
    const restart = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Offline')));
    try {
      await expect(recoverGroups(cache, 'exact', restart)).rejects.toThrow('Offline');
      expect(restart).toHaveBeenCalledOnce();
      expect(cache.getQueryState(groupsKey('exact'))?.status).toBe('error');
    } finally {
      cache.clear();
    }
  });
});

it.each([
  [409, 'stale_cursor'],
  [404, 'group_not_found'],
])('maps %s %s to results changed', async (status, error) => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ error }, { status: Number(status) }))
  );
  await expect(api('/groups/4')).rejects.toBeInstanceOf(ResultsChangedError);
});
it.each([
  [409, 'match_running'],
  [404, 'thumbnail_not_found'],
  [500, 'stale_cursor'],
])('does not recover groups for unrelated %s %s', async (status, error) => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ error }, { status: Number(status) }))
  );
  await expect(api('/groups')).rejects.not.toBeInstanceOf(ResultsChangedError);
});

it('loads thumbnail bytes with credentials and cancellation support', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response('image bytes', { headers: { 'Content-Type': 'image/jpeg' } }));
  vi.stubGlobal('fetch', fetch);
  const { signal } = new AbortController();
  const blob = await getThumbnail(42, signal);
  expect(await blob.text()).toBe('image bytes');
  expect(blob.type).toBe('image/jpeg');
  expect(fetch).toHaveBeenCalledWith('/api/files/42/thumb', { credentials: 'same-origin', signal });
});
it('redirects thumbnail 401s with the complete return location', async () => {
  const replace = vi.fn();
  vi.stubGlobal('window', {
    location: { pathname: '/groups/4', search: '?kind=exact', hash: '#member', replace },
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
  await expect(getThumbnail(42, new AbortController().signal)).rejects.toThrow('Please sign in');
  expect(replace).toHaveBeenCalledWith('/login?returnTo=%2Fgroups%2F4%3Fkind%3Dexact%23member');
});
it('keeps operational thumbnail failures distinct from content-unavailable responses', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ error: 'thumbnail_failed' }, { status: 500 }))
  );
  await expect(getThumbnail(42, new AbortController().signal)).rejects.not.toBeInstanceOf(
    ThumbnailUnavailableError
  );
});
it('rejects missing thumbnails rather than returning an image blob', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ error: 'thumbnail_not_found' }, { status: 404 }))
  );
  await expect(getThumbnail(42, new AbortController().signal)).rejects.toBeInstanceOf(
    ThumbnailUnavailableError
  );
});
