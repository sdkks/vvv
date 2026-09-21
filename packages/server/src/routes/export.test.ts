import { mkdtemp, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExportResponse } from '@vvv/shared';
import { createServer } from '../server.js';
import { openDatabase } from '../db.js';
import { Matcher } from '../matcher.js';
import { exportStream } from './export.js';

const config = {
  password: 'export-test-password',
  sessionSecret: 'export-test-session',
  port: 8080,
};
let root: string;
let app: Awaited<ReturnType<typeof createServer>>;
let db: Database.Database;
let openReadOnly: () => Database.Database;
let matcher: Matcher;
let cookie: string;
const streams: Readable[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vvv-export-'));
  app = await createServer({ ...config, dataDir: root }, false);
  ({ db, openReadOnly } = openDatabase(root));
  matcher = new Matcher(db, app.log);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: config.password },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  db.exec("INSERT INTO scan_dirs(path) VALUES ('/media')");
});
afterEach(async () => {
  vi.useRealTimers();
  for (const stream of streams.splice(0)) {
    stream.destroy();
    if (!stream.closed) await once(stream, 'close');
  }
  if (db.inTransaction) db.exec('ROLLBACK');
  await matcher.close();
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function put(path: string, hash = 'same') {
  db.prepare(
    `INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status,sha256)
    VALUES (1,?,'image',10,0,'done',?)`
  ).run(path, hash);
}
async function match() {
  const id = matcher.start();
  await matcher.close();
  return id;
}
async function text(stream: Readable) {
  let body = '';
  for await (const chunk of stream) body += String(chunk);
  return body;
}
function tracked(format: 'csv' | 'json') {
  const reader = openReadOnly();
  const stream = exportStream(() => reader, format);
  streams.push(stream);
  return { reader, stream };
}
async function large() {
  db.transaction(() => {
    for (let i = 0; i < 20000; i++) put(`file-${i}-${'x'.repeat(100)}.jpg`);
  })();
  await match();
}

it('streams well-formed empty exports and attachment content types', async () => {
  const csv = await app.inject({ url: '/api/export.csv', headers: { cookie } });
  expect(csv.statusCode).toBe(200);
  expect(csv.body).toBe('group_id,kind,path,size,width,height,duration_ms,similarity\r\n');
  expect(csv.headers['content-type']).toContain('text/csv');
  expect(csv.headers['content-disposition']).toBe('attachment; filename="duplicates.csv"');
  const json = await app.inject({ url: '/api/export.json', headers: { cookie } });
  expect(json.statusCode).toBe(200);
  expect(json.json()).toEqual({ groups: [] });
  expect(json.headers['content-type']).toContain('application/json');
  expect(json.headers['content-disposition']).toBe('attachment; filename="duplicates.json"');
});

it('quotes CSV commas, quotes, CR and LF, escapes JSON, preserves metadata and excludes non-done members', async () => {
  const paths = [
    'plain.jpg',
    'comma,name.jpg',
    'a"quote.jpg',
    'line\nfeed.jpg',
    'carriage\rreturn.jpg',
    'unicode-雪\\name.jpg',
  ];
  for (const path of paths) put(path);
  put('second-a.mp4', 'other');
  put('second-b.mp4', 'other');
  put('hidden.jpg', 'other');
  await match();
  db.exec("UPDATE files SET status='quarantined' WHERE rel_path='hidden.jpg'");
  db.exec("UPDATE files SET width=640,height=480,duration_ms=1234 WHERE rel_path='second-a.mp4'");
  const csv = await app.inject({ url: '/api/export.csv', headers: { cookie } });
  expect(csv.statusCode).toBe(200);
  expect(csv.body).toBe(
    'group_id,kind,path,size,width,height,duration_ms,similarity\r\n' +
      '1,exact,/media/second-a.mp4,10,640,480,1234,\r\n' +
      '1,exact,/media/second-b.mp4,10,,,,\r\n' +
      '2,exact,/media/plain.jpg,10,,,,\r\n' +
      '2,exact,"/media/comma,name.jpg",10,,,,\r\n' +
      '2,exact,"/media/a""quote.jpg",10,,,,\r\n' +
      '2,exact,"/media/line\nfeed.jpg",10,,,,\r\n' +
      '2,exact,"/media/carriage\rreturn.jpg",10,,,,\r\n' +
      '2,exact,/media/unicode-雪\\name.jpg,10,,,,\r\n'
  );
  const json = await app.inject({ url: '/api/export.json', headers: { cookie } });
  expect(json.statusCode).toBe(200);
  const result = json.json<ExportResponse>();
  expect(result.groups.map((group) => [group.id, group.kind, group.members.length])).toEqual([
    [1, 'exact', 2],
    [2, 'exact', 6],
  ]);
  expect(result.groups[1]!.members.map((member) => member.path)).toEqual(
    paths.map((path) => join('/media', path))
  );
  expect(result.groups[0]!.members[0]).toEqual({
    file_id: 7,
    path: '/media/second-a.mp4',
    size: 10,
    width: 640,
    height: 480,
    duration_ms: 1234,
    similarity: null,
  });
});

it('exports both formats on the read-only connection while a writer transaction remains open', async () => {
  put('a.jpg');
  put('b.jpg');
  await match();
  db.exec("BEGIN IMMEDIATE; UPDATE files SET rel_path='uncommitted.jpg' WHERE id=1");
  for (const format of ['csv', 'json']) {
    const response = await app.inject({ url: `/api/export.${format}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('/media/a.jpg');
    expect(response.body).toContain('/media/b.jpg');
    expect(response.body).not.toContain('uncommitted.jpg');
    expect(db.inTransaction).toBe(true);
  }
  db.exec('ROLLBACK');
});

it('honors backpressure, stays on one snapshot across activation/cleanup and releases its iterator after completion', async () => {
  await large();
  const { reader, stream } = tracked('json');
  stream.read(0);
  await vi.waitFor(() => expect(stream.readableLength).toBeGreaterThanOrEqual(16384));
  const buffered = stream.readableLength;
  expect(buffered).toBeLessThan(17000);
  await tick();
  expect(stream.readableLength).toBe(buffered);
  expect(reader.open).toBe(true);
  const run = await match();
  expect(run).toBe(2);
  db.exec("UPDATE files SET status='missing' WHERE id=1");
  const result = JSON.parse(await text(stream)) as ExportResponse;
  expect(result.groups).toHaveLength(1);
  expect(result.groups[0]!.id).toBe(1);
  expect(result.groups[0]!.members).toHaveLength(20000);
  expect(reader.open).toBe(false);
});

it('disposes a paused iterator on disconnect and closes an unconsumed export', async () => {
  await large();
  const { reader, stream } = tracked('csv');
  stream.read(0);
  await vi.waitFor(() => expect(stream.readableLength).toBeGreaterThanOrEqual(16384));
  const closed = once(stream, 'close');
  stream.destroy();
  await closed;
  expect(reader.open).toBe(false);
  const unconsumed = tracked('json');
  const unopenedClosed = once(unconsumed.stream, 'close');
  unconsumed.stream.destroy();
  await unopenedClosed;
  expect(unconsumed.reader.open).toBe(false);
});

it('cuts off a stalled export at ten minutes and releases the read snapshot', async () => {
  await large();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { reader, stream } = tracked('json');
  stream.read(0);
  for (let i = 0; i < 10 && stream.readableLength < 16384; i++) await tick();
  expect(stream.readableLength).toBeGreaterThanOrEqual(16384);
  const error = once(stream, 'error');
  const closed = new Promise<void>((resolve) => stream.once('close', resolve));
  await vi.advanceTimersByTimeAsync(599999);
  expect(stream.destroyed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect((await error)[0]).toMatchObject({ message: 'Export timed out' });
  await closed;
  expect(reader.open).toBe(false);
});

it('closes the reader when SQL iteration fails', async () => {
  db.exec('DROP TABLE dup_group_members');
  const { reader, stream } = tracked('json');
  await expect(text(stream)).rejects.toThrow('no such table');
  expect(reader.open).toBe(false);
});

it('disposes the export connection when an actual HTTP client disconnects', async () => {
  await large();
  const close = vi.spyOn(Database.prototype, 'close');
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    get(`${address}/api/export.json`, { headers: { cookie } }, (response) => {
      expect(response.statusCode).toBe(200);
      response.once('data', () => {
        response.destroy();
        resolve();
      });
      response.on('error', reject);
    }).on('error', reject);
  });
  await vi.waitFor(() =>
    expect(
      close.mock.contexts.some(
        (connection) => connection instanceof Database && connection.readonly && !connection.open
      )
    ).toBe(true)
  );
});
