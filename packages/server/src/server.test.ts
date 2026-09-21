import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from './server.js';
import type { Config } from './config.js';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn().mockResolvedValue(undefined) }));
let directory: string;
let app: Awaited<ReturnType<typeof createServer>>;
let config: Config;
const password = 'test-only shared password λ';
const login = (value = password, remoteAddress = '127.0.0.1') =>
  app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: value },
    remoteAddress,
  });

beforeEach(async () => {
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), 'vvv-auth-'));
  config = {
    password,
    sessionSecret: 'test-only session signing secret',
    dataDir: directory,
    port: 8080,
  };
  app = await createServer(config, false);
  app.get('/api/private', async () => ({ protected: true }));
});
afterEach(async () => {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('authentication boundary', () => {
  it('keeps health public and guards session, logout, new API routes and misses', async () => {
    expect((await app.inject('/api/health?probe=1')).json()).toEqual({ status: 'ok', db: 'ok' });
    for (const url of ['/api/auth/session', '/api/private?x=1', '/api/missing']) {
      const denied = await app.inject(url);
      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toEqual({ error: 'unauthorized' });
    }
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout' })).statusCode).toBe(401);
  });
  it('signs a password-free cookie, rejects tampering and clears it on logout', async () => {
    const response = await login();
    expect(response.statusCode).toBe(204);
    const header = String(response.headers['set-cookie']);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).not.toContain(password);
    const cookie = header.split(';')[0] ?? '';
    expect((await app.inject({ url: '/api/private', headers: { cookie } })).json()).toEqual({
      protected: true,
    });
    expect((await app.inject({ url: '/api/auth/session', headers: { cookie } })).json()).toEqual({
      authenticated: true,
    });
    expect(
      (await app.inject({ url: '/api/auth/session', headers: { cookie: cookie + 'x' } })).statusCode
    ).toBe(401);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers['set-cookie']).toContain('Expires=Thu, 01 Jan 1970');
  });
  it('rejects a signed but non-session payload and a previous boot secret', async () => {
    const cookie = `vvv_session=${encodeURIComponent(app.signCookie('not a session'))}`;
    expect((await app.inject({ url: '/api/private', headers: { cookie } })).statusCode).toBe(401);
    const previous = String((await login()).headers['set-cookie']).split(';')[0] ?? '';
    await app.close();
    app = await createServer(
      { ...config, sessionSecret: 'a different test-only session secret' },
      false
    );
    expect(
      (await app.inject({ url: '/api/auth/session', headers: { cookie: previous } })).statusCode
    ).toBe(401);
  });
  it('delays unequal-length passwords exponentially, caps delay, isolates IPs and resets on success', async () => {
    for (let i = 0; i < 8; i++) expect((await login('x')).statusCode).toBe(401);
    expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([
      500, 1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
    await login('other', '127.0.0.2');
    expect(delay).toHaveBeenLastCalledWith(500);
    await login();
    await login('wrong');
    expect(delay).toHaveBeenLastCalledWith(500);
  });
  it.each([{}, { password: 123 }, { password: null }, { password, extra: true }])(
    'rejects malformed login bodies without coercion: %j',
    async (payload) => {
      const result = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
      expect(result.statusCode).toBe(400);
      expect(result.body).not.toContain(password);
    }
  );
});
