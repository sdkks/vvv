import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { App, loginPayload } from './App';
import { login } from './api';

afterEach(() => vi.unstubAllGlobals());

it('renders an unchecked, labelled remember-me checkbox inside the login form with its hint', () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, { initialEntries: ['/login'] }, createElement(App))
    )
  );
  client.clear();
  const form = html.match(/<form\b[^>]*>(.*?)<\/form>/)?.[1] ?? '';
  const checkbox = form.match(/<input\b[^>]*type="checkbox"[^>]*>/)?.[0] ?? '';
  expect(checkbox).toContain('id="remember-me"');
  expect(checkbox).toContain('name="rememberMe"');
  expect(checkbox).toContain('aria-describedby="remember-me-hint"');
  expect(checkbox).not.toMatch(/checked|disabled|required/);
  expect(form).toMatch(/<label[^>]*for="remember-me">.*Remember me for 30 days<\/label>/);
  expect(form).toContain(
    '<p id="remember-me-hint" class="metadata">Requires a stable session secret to survive server restarts.</p>'
  );
  expect(form.indexOf('type="password"')).toBeLessThan(form.indexOf('id="remember-me"'));
  expect(form.indexOf('id="remember-me"')).toBeLessThan(form.indexOf('<button>Sign in'));
});

it.each([false, true])('submits checkbox state as a boolean when checked=%s', async (checked) => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  const data = new FormData();
  data.set('password', 'test-only password λ');
  if (checked) data.set('rememberMe', 'on');
  const payload = loginPayload(data);
  expect(payload).toEqual({ password: 'test-only password λ', rememberMe: checked });
  await expect(login(payload)).resolves.toBeUndefined();
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ password: 'test-only password λ', rememberMe: checked }),
  });
});

it('submits false after the checkbox is unchecked again', () => {
  const data = new FormData();
  data.set('password', 'test-only password');
  data.set('rememberMe', 'on');
  expect(loginPayload(data).rememberMe).toBe(true);
  data.delete('rememberMe');
  expect(loginPayload(data).rememberMe).toBe(false);
});

it('keeps the login helper compatible with callers omitting rememberMe', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  await login({ password: 'test-only password' });
  expect(fetch).toHaveBeenCalledWith(
    '/api/auth/login',
    expect.objectContaining({ body: JSON.stringify({ password: 'test-only password' }) })
  );
});
