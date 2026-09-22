import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from '../server.js';
import type { ScanLog } from '../scan-log.js';
import { openDatabase } from '../db.js';
import type { ScanLogEntry } from '@vvv/shared';

vi.mock('../hashing.js', { spy: true });

const config = {
  password: 'logs-test-password',
  sessionSecret: 'logs-test-session',
  port: 8080,
};

let root: string;
let app: Awaited<ReturnType<typeof createServer>>;
let scanLog: InstanceType<typeof ScanLog>;
let db: ReturnType<typeof openDatabase>['db'];
let cookie: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vvv-logs-'));
  app = (await createServer({ ...config, dataDir: root }, false)) as Awaited<
    ReturnType<typeof createServer>
  > & { scanLog: InstanceType<typeof ScanLog> };
  scanLog = (app as unknown as { scanLog: InstanceType<typeof ScanLog> }).scanLog;
  db = openDatabase(root).db;

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: config.password },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  db.prepare("INSERT INTO scan_dirs(path) VALUES ('/media')").run();
  db.prepare("INSERT INTO scans(status) VALUES ('done')").run();
});

afterEach(async () => {
  scanLog.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
});

const history = async (query = '') => {
  const response = await app.inject({ url: `/api/scans/logs${query}`, headers: { cookie } });
  return { status: response.statusCode, body: response.json() };
};

it('rejects unauthenticated history requests', async () => {
  const response = await app.inject({ url: '/api/scans/logs' });
  expect(response.statusCode).toBe(401);
});

it('returns an empty page when no entries exist', async () => {
  const { status, body } = await history('?scan_id=1');
  expect(status).toBe(200);
  expect(body).toEqual({ items: [], next_cursor: null });
});

it('returns retained entries newest-first with pagination and filters', async () => {
  scanLog.add(1, 'info', 'scan', 'Scan started');
  scanLog.add(1, 'info', 'traversal', 'Traversal finished', 40);
  scanLog.add(1, 'warn', 'sample', 'Slow file: /media/a.mp4 — 12.5s', 12500);
  scanLog.add(1, 'error', 'error', '/media/b.mp4: timeout');
  scanLog.add(2, 'info', 'complete', 'Other scan complete', 900);

  const all = await history('');
  expect(all.status).toBe(200);
  expect(all.body.items).toHaveLength(5);
  expect(all.body.items[0].detail).toBe('Other scan complete');

  const scanOnly = await history('?scan_id=1');
  expect(scanOnly.body.items).toHaveLength(4);
  expect(scanOnly.body.next_cursor).toBeNull();

  const errors = await history('?level=error');
  expect(errors.body.items).toHaveLength(1);
  expect(errors.body.items[0].level).toBe('error');

  const page1 = await history('?limit=2');
  expect(page1.body.items).toHaveLength(2);
  const cursor = page1.body.next_cursor;
  const page2 = await history(`?cursor=${cursor}&limit=2`);
  expect(page2.body.items).toHaveLength(2);
  expect(page2.body.items.some((item: ScanLogEntry) => page1.body.items.includes(item))).toBe(
    false
  );
});

it('rejects invalid query parameters', async () => {
  expect(
    (await app.inject({ url: '/api/scans/logs?scan_id=0', headers: { cookie } })).statusCode
  ).toBe(400);
  expect(
    (await app.inject({ url: '/api/scans/logs?level=debug', headers: { cookie } })).statusCode
  ).toBe(400);
  expect(
    (await app.inject({ url: '/api/scans/logs?limit=1000', headers: { cookie } })).statusCode
  ).toBe(400);
});

it('rejects the log stream for an unknown scan', async () => {
  const response = await app.inject({ url: '/api/scans/999/logs-stream', headers: { cookie } });
  expect(response.statusCode).toBe(404);
});

it('requires authentication for the log stream', async () => {
  const response = await app.inject({ url: '/api/scans/1/logs-stream' });
  expect([401, 404]).toContain(response.statusCode);
});
