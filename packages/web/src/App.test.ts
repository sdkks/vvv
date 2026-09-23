import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';

const destinations = [
  ['Home', '/'],
  ['Directories', '/directories'],
  ['Scan', '/scan'],
  ['Logs', '/logs'],
  ['Groups', '/groups'],
  ['Trash', '/trash'],
  ['Settings', '/settings'],
];

afterEach(() => vi.unstubAllGlobals());

async function render(path = '/', narrow = false, session = 'ready') {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: narrow }) });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
  });
  if (session === 'ready') client.setQueryData(['session'], { authenticated: true });
  if (session === 'error') {
    await client
      .fetchQuery({
        queryKey: ['session'],
        queryFn: () => Promise.reject(new Error('Session unavailable')),
      })
      .catch(() => undefined);
  }
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, { initialEntries: [path] }, createElement(App))
    )
  );
  client.clear();
  return html;
}

function navigation(html: string) {
  return html.match(/<nav[^>]*aria-label="Main navigation"[^>]*>.*?<\/nav>/)?.[0] ?? '';
}

it('renders one named sidebar navigation before one main with unchanged destinations', async () => {
  const html = await render();
  const nav = navigation(html);
  expect(html).toContain('data-layout="desktop"');
  expect(html.match(/<main\b/g)).toHaveLength(1);
  expect(html.match(/aria-label="Main navigation"/g)).toHaveLength(1);
  expect(html.indexOf(nav)).toBeLessThan(html.indexOf('<main'));
  const links = [...nav.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)];
  expect(links.map((link) => [link[2], link[1]])).toEqual(destinations);
  expect(nav).not.toContain('hidden=');
  expect(html).toMatch(/<button[^>]*class="shell-menu"[^>]*hidden=""/);
});

it.each([
  ['/', 'Home'],
  ['/directories', 'Directories'],
  ['/scan', 'Scan'],
  ['/logs?view=history&level=warn', 'Logs'],
  ['/groups?kind=image', 'Groups'],
  ['/groups/9?kind=image', 'Groups'],
  ['/trash?cursor=next', 'Trash'],
  ['/settings', 'Settings'],
])('marks only %s current without depending on query parameters', async (path, label) => {
  const nav = navigation(await render(path));
  expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
  expect(nav).toMatch(new RegExp(`<a[^>]*aria-current="page"[^>]*>${label}</a>`));
});

it('preserves the unmatched-route Home fallback without a falsely active Home link', async () => {
  const html = await render('/unknown?unchanged=yes');
  expect(html).toContain('>Home</h1>');
  expect(html).toContain('Set up scan directories');
  expect(navigation(html)).not.toContain('aria-current');
});

it('starts narrow navigation hidden behind a related, collapsed Menu button', async () => {
  const html = await render('/', true);
  expect(html).toContain('data-layout="narrow"');
  expect(html).toMatch(
    /<button[^>]*type="button"[^>]*aria-expanded="false"[^>]*aria-controls="main-navigation"[^>]*>Menu<\/button>/
  );
  expect(navigation(html)).toMatch(/id="main-navigation"[^>]*hidden=""/);
  expect(html.match(/<main\b/g)).toHaveLength(1);
});

it.each([
  ['pending', 'role="status">Checking session…'],
  ['error', 'role="alert">Session unavailable'],
])('keeps the session %s branch nav-free in its own main', async (state, message) => {
  const html = await render('/', true, state);
  expect(html.match(/<main\b/g)).toHaveLength(1);
  expect(html).toContain('class="standalone-surface"');
  expect(html).toContain(message);
  expect(html).not.toContain('<nav');
  expect(html).not.toContain('home-duplicates.svg');
  if (state === 'error') expect(html).toContain('>Retry</button>');
});

it('keeps login, its return-location notice, and form semantics outside navigation', async () => {
  const html = await render('/login?returnTo=%2Fgroups%2F9');
  expect(html.match(/<main\b/g)).toHaveLength(1);
  expect(html).toContain('class="standalone-surface"');
  expect(html).toContain('Please sign in to continue where you left off.');
  expect(html).toContain('name="password"');
  expect(html).toContain('name="rememberMe"');
  expect(html).not.toContain('<nav');
  expect(html).not.toContain('home-duplicates.svg');
});

it('keeps the instructions before a modest decorative Home-only illustration', async () => {
  const html = await render();
  expect(html).toContain('Add directories, scan your media, then review duplicate groups.');
  expect(html).toMatch(
    /<img[^>]*src="\/home-duplicates.svg"[^>]*alt=""[^>]*width="352"[^>]*height="256"/
  );
  expect(html.indexOf('Set up scan directories')).toBeLessThan(html.indexOf('<img'));
  for (const [, path] of destinations.slice(1)) {
    expect(await render(path)).not.toContain('home-duplicates.svg');
  }
});

it('serves the illustration and favicon as self-contained local SVG sources', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
  for (const name of ['home-duplicates', 'favicon']) {
    const svg = readFileSync(new URL(`../public/${name}.svg`, import.meta.url), 'utf8');
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox=');
    expect(svg).not.toMatch(/<script|<foreignObject|<image|\bhref=|url\(|@import/i);
  }
});
