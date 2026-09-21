import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from '../server.js';
import { openDatabase } from '../db.js';
import * as hashing from '../hashing.js';

vi.mock('../hashing.js', { spy: true });
const realHashing = await vi.importActual<typeof hashing>('../hashing.js');
let directory: string;
let app: Awaited<ReturnType<typeof createServer>>;
let cookie: string;
const config = { password: 'scan-test-password', sessionSecret: 'scan-test-session', port: 8080 };
beforeEach(async () => {
  vi.mocked(hashing.processFile).mockImplementation(realHashing.processFile).mockClear();
  directory = await mkdtemp(join(tmpdir(), 'vvv-scan-routes-'));
  app = await createServer({ ...config, dataDir: directory }, false);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: config.password },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
});
afterEach(async () => {
  await app.close();
  await rm(directory, { recursive: true, force: true });
});
const current = () => app.inject({ url: '/api/scans/current', headers: { cookie } });
const start = () => app.inject({ method: 'POST', url: '/api/scans', headers: { cookie } });
const cancel = (id: string | number) =>
  app.inject({ method: 'POST', url: `/api/scans/${id}/cancel`, headers: { cookie } });

it('protects all three scan endpoints with the existing auth guard', async () => {
  for (const [method, url] of [
    ['POST', '/api/scans'],
    ['GET', '/api/scans/current'],
    ['POST', '/api/scans/1/cancel'],
  ] as const) {
    const denied = await app.inject({ method, url });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toEqual({ error: 'unauthorized' });
  }
  expect((await current()).json()).toBeNull();
});

it('returns 202/409, reports durable progress, cancels cooperatively and resumes remaining work', async () => {
  const media = join(directory, 'media');
  await mkdir(media);
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => writeFile(join(media, `${i}.mp4`), `${i}`))
  );
  const { db } = openDatabase(directory);
  db.prepare('INSERT INTO scan_dirs(path) VALUES (?)').run(media);
  db.close();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(hashing.processFile).mockImplementation(async (path) => {
    await blocked;
    return realHashing.processFile(path);
  });
  const response = await start();
  expect(response.statusCode).toBe(202);
  expect(response.json()).toEqual({ id: 1 });
  try {
    const conflict = await start();
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'scan_running' });
    await vi.waitFor(() => expect(hashing.processFile).toHaveBeenCalledTimes(4));
    expect((await current()).json()).toMatchObject({
      id: 1,
      status: 'running',
      started_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      finished_at: null,
      discovered: 8,
      processed: 0,
      errors: 0,
      current_file: expect.any(String),
    });
    expect((await cancel(1)).statusCode).toBe(202);
    expect((await start()).statusCode).toBe(409);
  } finally {
    release();
  }
  await vi.waitFor(async () =>
    expect((await current()).json()).toMatchObject({ id: 1, status: 'cancelled', processed: 4 })
  );
  const second = await start();
  expect(second.statusCode).toBe(202);
  await vi.waitFor(async () =>
    expect((await current()).json()).toEqual({
      id: 2,
      status: 'done',
      started_at: expect.any(String),
      finished_at: expect.any(String),
      discovered: 8,
      processed: 8,
      errors: 0,
    })
  );
  expect(hashing.processFile).toHaveBeenCalledTimes(8);
});

it('validates cancel ids, rejects missing scans, and keeps terminal cancellation idempotent', async () => {
  for (const id of ['0', '-1', '1.5', 'abc', '9999999999999999'])
    expect((await cancel(id)).statusCode).toBe(400);
  expect((await cancel(99)).statusCode).toBe(404);
  expect((await start()).statusCode).toBe(202);
  await vi.waitFor(async () => expect((await current()).json().status).toBe('done'));
  expect((await cancel(1)).statusCode).toBe(202);
  expect((await current()).json().status).toBe('done');
});

it('recovers running scans before accepting requests', async () => {
  await app.close();
  const { db } = openDatabase(directory);
  db.exec("INSERT INTO scans(status) VALUES ('running')");
  db.close();
  app = await createServer({ ...config, dataDir: directory }, false);
  expect((await current()).json()).toEqual({
    id: 1,
    status: 'interrupted',
    started_at: expect.any(String),
    finished_at: expect.any(String),
    discovered: 0,
    processed: 0,
    errors: 0,
  });
});
