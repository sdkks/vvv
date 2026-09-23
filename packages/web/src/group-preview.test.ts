import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGroupPreview, type PreviewState } from './group-preview';
import { GroupPreview, PreviewContent } from './GroupPreview';

const element = {} as Element;
const observe = vi.fn();
const disconnect = vi.fn();
const update = vi.fn<(state: PreviewState) => void>();
const fetch = vi.fn<typeof globalThis.fetch>();
let intersect: (entries: { isIntersecting: boolean }[]) => void;
let margin: string | undefined;
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: typeof intersect, options: IntersectionObserverInit) {
        intersect = callback;
        margin = options.rootMargin;
      }
      observe = observe;
      disconnect = disconnect;
    }
  );
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it('waits for the preload area, fetches once through auth, and revokes its URL on unmount', async () => {
  fetch.mockResolvedValue(new Response(new Blob(['thumbnail'])));
  dispose = loadGroupPreview(element, 42, update);
  expect(observe).toHaveBeenCalledWith(element);
  expect(margin).toBe('200px');
  expect(fetch).not.toHaveBeenCalled();
  intersect([{ isIntersecting: false }]);
  expect(fetch).not.toHaveBeenCalled();
  intersect([{ isIntersecting: true }]);
  intersect([{ isIntersecting: true }]);
  await vi.waitFor(() =>
    expect(update).toHaveBeenCalledWith({ status: 'ready', src: 'blob:preview' })
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith('/api/files/42/thumb', {
    credentials: 'same-origin',
    signal: expect.any(AbortSignal),
  });
  const signal = fetch.mock.calls[0]![1]!.signal!;
  expect(signal.aborted).toBe(false);
  dispose();
  dispose = undefined;
  expect(signal.aborted).toBe(true);
  expect(disconnect).toHaveBeenCalled();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
});

it('disconnects before visibility without ever fetching', () => {
  dispose = loadGroupPreview(element, 42, update);
  dispose();
  dispose = undefined;
  intersect([{ isIntersecting: true }]);
  expect(disconnect).toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('aborts an in-flight load and ignores a late successful response', async () => {
  let finish: (response: Response) => void = () => {};
  fetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  dispose = loadGroupPreview(element, 42, update);
  intersect([{ isIntersecting: true }]);
  const blob = vi.spyOn(Response.prototype, 'blob');
  dispose();
  dispose = undefined;
  expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  finish(new Response('late'));
  await vi.waitFor(() => expect(blob).toHaveBeenCalledTimes(1));
  await blob.mock.results[0]!.value;
  expect(update).not.toHaveBeenCalled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('ignores an abort rejection without displaying a failure', async () => {
  let fail: (error: Error) => void = () => {};
  fetch.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      })
  );
  dispose = loadGroupPreview(element, 42, update);
  intersect([{ isIntersecting: true }]);
  dispose();
  dispose = undefined;
  fail(new DOMException('Aborted', 'AbortError'));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(update).not.toHaveBeenCalled();
});

it.each([404, 500])(
  'keeps an unavailable fallback on HTTP %i without trying another member',
  async (status) => {
    fetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'thumbnail_not_found' }), { status })
    );
    dispose = loadGroupPreview(element, 42, update);
    intersect([{ isIntersecting: true }]);
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ status: 'unavailable' }));
    intersect([{ isIntersecting: true }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  }
);

it('shows unavailable on network failure and loads without an observer on older browsers', async () => {
  vi.stubGlobal('IntersectionObserver', undefined);
  fetch.mockRejectedValue(new Error('offline'));
  dispose = loadGroupPreview(element, 42, update);
  await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ status: 'unavailable' }));
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('redirects an expired preview session to login with the complete groups return location', async () => {
  const replace = vi.fn();
  vi.stubGlobal('window', {
    location: { pathname: '/groups', search: '?kind=image&cursor=page2', hash: '#groups', replace },
  });
  fetch.mockResolvedValue(new Response(null, { status: 401 }));
  dispose = loadGroupPreview(element, 42, update);
  intersect([{ isIntersecting: true }]);
  await vi.waitFor(() =>
    expect(replace).toHaveBeenCalledWith(
      '/login?returnTo=%2Fgroups%3Fkind%3Dimage%26cursor%3Dpage2%23groups'
    )
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('renders stable fallback boxes and decorative images, never raw API image sources', () => {
  const empty = renderToStaticMarkup(createElement(GroupPreview, { representative: null }));
  const loading = renderToStaticMarkup(
    createElement(GroupPreview, {
      representative: { file_id: 42, kind: 'image' },
    })
  );
  expect(empty).toBe('<span class="group-preview thumbnail fallback">No preview</span>');
  expect(loading).toBe('<span class="group-preview thumbnail fallback">Loading…</span>');
  expect(
    renderToStaticMarkup(
      createElement(PreviewContent, {
        state: { status: 'unavailable' },
        onError: () => {},
      })
    )
  ).toBe('Preview unavailable');
  const ready = renderToStaticMarkup(
    createElement(PreviewContent, {
      state: { status: 'ready', src: 'blob:preview' },
      onError: () => {},
    })
  );
  expect(ready).toContain('<img src="blob:preview" alt=""');
  expect(ready).not.toContain('/api/');
  expect(fetch).not.toHaveBeenCalled();
});
