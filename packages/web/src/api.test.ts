import { afterEach, expect, it, vi } from 'vitest';
import { api, returnLocation } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});
it('preserves the complete internal return location and rejects external redirects', () => {
  expect(
    returnLocation('?returnTo=%2Fgroups%2F42%3Fkind%3Dimage%23member', 'http://localhost')
  ).toBe('/groups/42?kind=image#member');
  for (const target of [
    'https://example.com',
    '//example.com',
    '/\\example.com',
    '/login',
    'javascript:alert(1)',
  ]) {
    expect(returnLocation(`?returnTo=${encodeURIComponent(target)}`, 'http://localhost')).toBe('/');
  }
});
it('redirects any non-login API 401 to login with the original location', async () => {
  const replace = vi.fn();
  vi.stubGlobal('window', {
    location: { pathname: '/groups/42', search: '?kind=image', hash: '#member', replace },
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
  await expect(api('/groups')).rejects.toThrow('Please sign in');
  expect(replace).toHaveBeenCalledWith('/login?returnTo=%2Fgroups%2F42%3Fkind%3Dimage%23member');
});
it('keeps failed login on the form and accepts a 204 without parsing JSON', async () => {
  const replace = vi.fn();
  vi.stubGlobal('window', { location: { pathname: '/login', replace } });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  await expect(api('/auth/login')).rejects.toThrow('Incorrect password');
  expect(replace).not.toHaveBeenCalled();
  await expect(api('/auth/login')).resolves.toBeUndefined();
  expect(fetch).toHaveBeenLastCalledWith('/api/auth/login', { credentials: 'same-origin' });
});
it('surfaces server and network failures instead of treating them as authenticated', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
  await expect(api('/auth/session')).rejects.toThrow('Request failed');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network offline')));
  await expect(api('/auth/session')).rejects.toThrow('Network offline');
});
