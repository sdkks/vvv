import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, getThumbnail, ResultsChangedError, ThumbnailUnavailableError } from './api';
import {
  groupsKey,
  isVideo,
  previousCursor,
  recoverGroups,
  reviewShortcut,
  toggleMarked,
  visitCursor,
} from './group-review';

afterEach(() => vi.unstubAllGlobals());

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
