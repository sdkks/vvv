import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from './server.js';

let directory: string;
let root: string;
let app: Awaited<ReturnType<typeof createServer>>;
const index = '<!doctype html><html><body>VVV login shell</body></html>';
const config = () => ({
  dataDir: join(directory, 'data'),
  password: 'fixture-password',
  sessionSecret: 'fixture-session-secret',
  port: 8080,
});
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'vvv-web-'));
  root = join(directory, 'web');
  mkdirSync(join(directory, 'data'));
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), index);
  writeFileSync(join(root, 'assets', 'index-abCD_123.js'), 'console.log("fixture");');
  writeFileSync(join(root, 'favicon.svg'), '<svg/>');
  app = await createServer(config(), false, root);
});
afterEach(async () => {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
it('serves the login shell and HTML deep links without caching index.html', async () => {
  for (const url of ['/', '/index.html', '/groups/1?filter=exact', '/login', '/apiary']) {
    const response = await app.inject({
      url,
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(index);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-store');
  }
});
it('preserves the API authentication boundary including unknown paths', async () => {
  expect((await app.inject('/api/health')).statusCode).toBe(200);
  for (const url of ['/api/scan-dirs', '/api/auth/session', '/api/unknown', '/api', '/api/']) {
    const response = await app.inject({ url, headers: { accept: 'text/html' } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
    expect(response.headers['cache-control']).toBe('no-store');
  }
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: config().password },
  });
  expect(login.statusCode).toBe(204);
  const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  expect((await app.inject({ url: '/api/scan-dirs', headers: { cookie } })).statusCode).toBe(200);
  const missing = await app.inject({
    url: '/api/unknown',
    headers: { cookie, accept: 'text/html' },
  });
  expect(missing.statusCode).toBe(404);
  expect(missing.headers['content-type']).toContain('application/json');
  expect(missing.json()).toMatchObject({ statusCode: 404, error: 'Not Found' });
});
it('does not turn non-HTML or non-GET misses into successful HTML responses', async () => {
  for (const accept of ['application/json', 'text/html;q=0,application/json', '*/*', '']) {
    const response = await app.inject({ url: '/missing', headers: { accept } });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
  }
  for (const method of ['POST', 'HEAD'] as const) {
    expect(
      (await app.inject({ method, url: '/groups/1', headers: { accept: 'text/html' } })).statusCode
    ).toBe(404);
  }
});
it('caches hashed assets immutably but revalidates other files', async () => {
  const asset = await app.inject('/assets/index-abCD_123.js');
  expect(asset.statusCode).toBe(200);
  expect(asset.body).toContain('fixture');
  expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  expect((await app.inject('/favicon.svg')).headers['cache-control']).toBe('no-cache');
});
it('supports an environment-selected root and dev mode without a built SPA', async () => {
  await app.close();
  vi.stubEnv('SERVE_WEB_DIST', root);
  app = await createServer(config(), false);
  expect((await app.inject('/')).body).toBe(index);
  await app.close();
  vi.stubEnv('SERVE_WEB_DIST', join(directory, 'missing'));
  app = await createServer(config(), false);
  expect(
    (await app.inject({ url: '/groups/1', headers: { accept: 'text/html' } })).statusCode
  ).toBe(404);
  expect((await app.inject('/api/health')).statusCode).toBe(200);
  expect((await app.inject('/api/scan-dirs')).statusCode).toBe(401);
});
