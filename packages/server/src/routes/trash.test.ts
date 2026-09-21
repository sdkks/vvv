import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type {
  GroupResponse,
  GroupsResponse,
  Page,
  PurgeResponse,
  QuarantineResponse,
  RestoreResponse,
  TrashItem,
} from '@vvv/shared';
import { createServer } from '../server.js';
import { openDatabase } from '../db.js';
import { exists } from '../quarantine.js';
import { activeMatchRun } from '../matcher.js';
import { storeHashes } from '../hashing.js';

vi.mock('node:fs/promises', { spy: true });
const realFs = await vi.importActual<typeof fs>('node:fs/promises');
const config = { password: 'trash-test-password', sessionSecret: 'trash-test-session', port: 8080 };
let root: string;
let media: string;
let app: Awaited<ReturnType<typeof createServer>>;
let db: ReturnType<typeof openDatabase>['db'];
let cookie: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vvv-trash-api-'));
  media = join(root, 'media');
  await mkdir(media);
  app = await createServer({ ...config, dataDir: root }, false);
  db = openDatabase(root).db;
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: config.password },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  db.prepare('INSERT INTO scan_dirs(path) VALUES (?)').run(media);
});
afterEach(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const get = (url: string) => app.inject({ url, headers: { cookie } });
const post = (url: string, payload: object) =>
  app.inject({ method: 'POST', url, payload, headers: { cookie } });
const move = (file_ids: number[]) => post('/api/files/quarantine', { file_ids });
const restore = (trash_ids: number[]) => post('/api/trash/restore', { trash_ids });
const purge = (trash_ids: number[]) => post('/api/trash/purge', { trash_ids });
async function seed(name: string, size = 10) {
  await writeFile(join(media, name), 'contents');
  return Number(
    db
      .prepare(
        `INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status,sha256)
    VALUES (1,?,'image',?,0,'done','same')`
      )
      .run(name, size).lastInsertRowid
  );
}
function stored(id: number) {
  return join(
    media,
    (
      db.prepare('SELECT trash_rel_path FROM trash WHERE id=?').get(id) as {
        trash_rel_path: string;
      }
    ).trash_rel_path
  );
}

function catalog() {
  return ['scan_dirs', 'files', 'trash', 'file_operations', 'dup_groups', 'dup_group_members'].map(
    (table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
  );
}
function holdFilesystem(kind: 'quarantine' | 'restore' | 'purge') {
  let release!: () => void;
  let entered = false;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (kind === 'purge')
    vi.mocked(fs.unlink).mockImplementationOnce(async (path) => {
      entered = true;
      await blocked;
      await realFs.unlink(path);
    });
  else
    vi.mocked(fs.rename).mockImplementationOnce(async (src, dst) => {
      entered = true;
      await blocked;
      await realFs.rename(src, dst);
    });
  return { release, wait: () => vi.waitFor(() => expect(entered).toBe(true)) };
}

it('requires authentication on every method before validation or side effects', async () => {
  for (const [method, url] of [
    ['POST', '/api/files/quarantine'],
    ['GET', '/api/trash'],
    ['POST', '/api/trash/restore'],
    ['POST', '/api/trash/purge'],
  ] as const) {
    const denied = await app.inject({ method, url });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toEqual({ error: 'unauthorized' });
  }
  expect(db.prepare('SELECT * FROM file_operations').all()).toEqual([]);
});

it('validates all bulk schemas strictly without journal or filesystem effects', async () => {
  await seed('keep.jpg');
  for (const [url, field] of [
    ['/api/files/quarantine', 'file_ids'],
    ['/api/trash/restore', 'trash_ids'],
    ['/api/trash/purge', 'trash_ids'],
  ]) {
    for (const payload of [
      {},
      { [field!]: [] },
      { [field!]: [0] },
      { [field!]: [-1] },
      { [field!]: [1.5] },
      { [field!]: ['1'] },
      { [field!]: [null] },
      { [field!]: [Number.MAX_SAFE_INTEGER + 1] },
      { [field!]: '1' },
      { [field!]: [1], extra: true },
      { [field!]: Array.from({ length: 10001 }, () => 1) },
    ]) {
      expect((await post(url!, payload)).statusCode, JSON.stringify(payload).slice(0, 100)).toBe(
        400
      );
    }
  }
  for (const payload of [
    { expired: false },
    { expired: 'true' },
    { expired: true, trash_ids: [1] },
  ])
    expect((await post('/api/trash/purge', payload)).statusCode).toBe(400);
  expect((await post('/api/trash/restore', { expired: true })).statusCode).toBe(400);
  expect(db.prepare('SELECT * FROM file_operations').all()).toEqual([]);
  expect(await readFile(join(media, 'keep.jpg'), 'utf8')).toBe('contents');
});

it('returns mixed per-item move/restore/purge outcomes and leaves conflict contents untouched', async () => {
  const one = await seed('one.jpg');
  const two = await seed('two.jpg');
  const response = await move([one, 999, one, two]);
  expect(response.statusCode).toBe(200);
  expect(response.json<QuarantineResponse>()).toEqual({
    moved: [
      { file_id: one, trash_id: 1 },
      { file_id: two, trash_id: 2 },
    ],
    failed: [
      { file_id: 999, error: 'file_not_found' },
      { file_id: one, error: 'file_not_eligible' },
    ],
  });
  const firstPath = stored(1),
    secondPath = stored(2);
  expect(firstPath).not.toBe(secondPath);
  expect(firstPath.startsWith(join(media, '.vvv-trash') + '/')).toBe(true);
  await writeFile(join(media, 'one.jpg'), 'replacement');
  expect((await restore([1, 999, 2])).json<RestoreResponse>()).toEqual({
    restored: [{ trash_id: 2, file_id: two }],
    failed: [
      { trash_id: 1, error: 'destination_exists' },
      { trash_id: 999, error: 'trash_not_found' },
    ],
  });
  expect(await readFile(join(media, 'one.jpg'), 'utf8')).toBe('replacement');
  expect(await readFile(join(media, 'two.jpg'), 'utf8')).toBe('contents');
  expect((await purge([1, 2, 999])).json<PurgeResponse>()).toEqual({
    purged: 1,
    failed: [
      { trash_id: 2, error: 'trash_not_found' },
      { trash_id: 999, error: 'trash_not_found' },
    ],
  });
  expect(await exists(firstPath)).toBe(false);
  expect(await exists(secondPath)).toBe(false);
  expect(await readFile(join(media, 'one.jpg'), 'utf8')).toBe('replacement');
  expect(db.prepare('SELECT id,status FROM files').all()).toEqual([{ id: two, status: 'done' }]);
});

it.each(['exact', 'image', 'video'] as const)(
  'updates %s aggregates, reference distances, detail and exports in the status transaction',
  async (kind) => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const id = await seed(`${i}.jpg`, kind === 'exact' ? 10 : 30 - i * 10);
      ids.push(id);
      const hash = Buffer.alloc(8);
      hash[7] = [0, 1, 3][i]!;
      storeHashes(db, id, kind === 'video' ? [hash, hash] : [hash]);
    }
    if (kind === 'video') db.exec("UPDATE files SET kind='video'");
    db.exec(
      "INSERT INTO match_runs(status) VALUES ('active'); INSERT INTO settings VALUES ('active_match_run','1')"
    );
    db.prepare(
      'INSERT INTO dup_groups(kind,member_count,total_bytes,reclaimable_bytes,match_run) VALUES (?,3,?,?,1)'
    ).run(kind, kind === 'exact' ? 30 : 60, kind === 'exact' ? 20 : 30);
    ids.forEach((id, i) =>
      db
        .prepare('INSERT INTO dup_group_members VALUES (1,?,?)')
        .run(id, kind === 'exact' ? null : i)
    );
    const first = (await move([ids[0]!])).json<QuarantineResponse>().moved[0]!;
    const detail = (await get('/api/groups/1')).json<GroupResponse>();
    expect(detail).toMatchObject({
      member_count: 2,
      total_bytes: kind === 'exact' ? 20 : 30,
      reclaimable_bytes: 10,
    });
    expect(
      detail.members.items.map(({ file_id, similarity }) => ({ file_id, similarity }))
    ).toEqual([
      { file_id: ids[1], similarity: kind === 'exact' ? null : 0 },
      { file_id: ids[2], similarity: kind === 'exact' ? null : 1 },
    ]);
    expect((await get('/api/groups')).json<GroupsResponse>().items).toMatchObject([
      { id: 1, member_count: 2, reclaimable_bytes: 10 },
    ]);
    for (const path of ['/api/export.json', '/api/export.csv']) {
      const exported = await get(path);
      expect(exported.statusCode).toBe(200);
      expect(exported.body).not.toContain(join(media, '0.jpg'));
      expect(exported.body).toContain(join(media, '1.jpg'));
    }
    expect((await restore([first.trash_id])).json<RestoreResponse>().failed).toEqual([]);
    const restored = (await get('/api/groups/1')).json<GroupResponse>();
    expect(restored).toMatchObject({
      member_count: 3,
      total_bytes: kind === 'exact' ? 30 : 60,
      reclaimable_bytes: kind === 'exact' ? 20 : 30,
    });
    expect(restored.members.items.map(({ similarity }) => similarity)).toEqual(
      kind === 'exact' ? [null, null, null] : [0, 1, 2]
    );
    await move(ids.slice(0, 2));
    expect((await get('/api/groups/1')).statusCode).toBe(404);
    expect((await get('/api/groups')).json()).toEqual({ items: [], next_cursor: null });
    expect((await get('/api/export.json')).json()).toEqual({ groups: [] });
    expect((await post('/api/matches/run', {})).statusCode).toBe(202);
    await vi.waitFor(() => expect(activeMatchRun(db)).toBe(2));
    expect((await get('/api/groups')).json()).toEqual({ items: [], next_cursor: null });
  }
);

it('handles 1,001 files in a bounded bulk request while serving health, then keyset-pages trash', async () => {
  const ids = [];
  for (let i = 0; i < 1001; i++) ids.push(await seed(`${i}.jpg`));
  let completed = false;
  const moving = move(ids).then((response) => {
    completed = true;
    return response;
  });
  expect((await get('/api/health')).statusCode).toBe(200);
  expect(completed).toBe(false);
  const response = await moving;
  expect(response.statusCode).toBe(200);
  expect(response.json<QuarantineResponse>().moved).toHaveLength(1001);
  expect(response.json<QuarantineResponse>().failed).toEqual([]);
  expect(
    db.prepare("SELECT count(*) AS n FROM file_operations WHERE status='committed'").get()
  ).toEqual({ n: 1001 });
  const first = (await get('/api/trash?limit=999')).json<Page<TrashItem>>();
  expect(first.items).toHaveLength(500);
  expect(first.next_cursor).toBe('500');
  expect(first.items[0]).toMatchObject({
    id: 1,
    file_id: 1,
    path: join(media, '0.jpg'),
    size: 10,
    purge_after: null,
  });
  const second = (await get(`/api/trash?limit=500&cursor=${first.next_cursor}`)).json<
    Page<TrashItem>
  >();
  expect(second.items).toHaveLength(500);
  expect(second.next_cursor).toBe('1000');
  const last = (await get(`/api/trash?cursor=${second.next_cursor}`)).json<Page<TrashItem>>();
  expect(last.items.map(({ id }) => id)).toEqual([1001]);
  expect(last.next_cursor).toBeNull();
  expect((await get('/api/trash')).json<Page<TrashItem>>().items).toHaveLength(50);
  expect((await get('/api/trash?cursor=1001')).json()).toEqual({ items: [], next_cursor: null });
  db.exec("UPDATE settings SET value='1' WHERE key='auto_purge_enabled'");
  const scheduled = (await get('/api/trash?limit=1')).json<Page<TrashItem>>().items[0]!;
  expect(scheduled.purge_after).toBe(
    (
      db
        .prepare("SELECT datetime(quarantined_at,'+30 days') AS deadline FROM trash WHERE id=1")
        .get() as { deadline: string }
    ).deadline
  );
  db.exec("UPDATE trash SET quarantined_at=datetime('now','-31 days')");
  expect((await post('/api/trash/purge', { expired: true })).json()).toEqual({
    purged: 100,
    failed: [],
  });
  expect(db.prepare('SELECT count(*) AS n FROM trash').get()).toEqual({ n: 901 });
}, 30000);

it('rejects malformed pagination without treating an invalid cursor as the first page', async () => {
  for (const query of [
    'cursor=-1',
    'cursor=1.5',
    'cursor=abc',
    'cursor=9999999999999999',
    'limit=0',
    'limit=',
    'limit=1.5',
    'limit=1&limit=2',
    'extra=1',
  ])
    expect((await get(`/api/trash?${query}`)).statusCode).toBe(400);
  expect((await get('/api/trash?cursor=')).json()).toEqual({ items: [], next_cursor: null });
});

it('unregister cascades live and restored trash metadata but leaves every filesystem object untouched', async () => {
  const ids = [await seed('one.jpg'), await seed('two.jpg'), await seed('three.jpg')];
  const moved = (await move(ids)).json<QuarantineResponse>().moved;
  const paths = moved.map(({ trash_id }) => stored(trash_id));
  await restore([moved[0]!.trash_id]);
  paths[0] = join(media, 'one.jpg');
  const before = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
  const history = db.prepare('SELECT * FROM file_operations ORDER BY id').all();
  expect(
    (await app.inject({ method: 'DELETE', url: '/api/scan-dirs/1', headers: { cookie } }))
      .statusCode
  ).toBe(204);
  expect(db.prepare('SELECT * FROM trash').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM files').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM file_operations ORDER BY id').all()).toEqual(history);
  expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual(before);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

it.each(['quarantine', 'restore', 'purge'] as const)(
  'rejects unregister while %s is awaiting the filesystem, then permits it after settlement',
  async (kind) => {
    const id = await seed('one.jpg');
    await seed('two.jpg');
    await seed('three.jpg');
    db.exec(`INSERT INTO match_runs(status) VALUES ('active');
      INSERT INTO settings VALUES ('active_match_run','1');
      INSERT INTO dup_groups(kind,member_count,total_bytes,reclaimable_bytes,match_run)
        VALUES ('exact',3,30,20,1);
      INSERT INTO dup_group_members VALUES (1,1,NULL),(1,2,NULL),(1,3,NULL)`);
    if (kind !== 'quarantine') await move([id]);
    const source = kind === 'quarantine' ? join(media, 'one.jpg') : stored(1);
    const held = holdFilesystem(kind);
    const changing = (
      kind === 'quarantine' ? move([id]) : kind === 'restore' ? restore([1]) : purge([1])
    ).then((response) => response);
    try {
      await held.wait();
      const before = catalog();
      const denied = await app.inject({
        method: 'DELETE',
        url: '/api/scan-dirs/1',
        headers: { cookie },
      });
      expect(denied.statusCode).toBe(409);
      expect(denied.json()).toEqual({ error: 'operations_in_progress' });
      expect(catalog()).toEqual(before);
      expect(await readFile(source, 'utf8')).toBe('contents');
    } finally {
      held.release();
      await changing;
    }
    expect((await changing).json().failed).toEqual([]);
    expect(
      db.prepare("SELECT * FROM file_operations WHERE status IN ('pending','fs_done')").all()
    ).toEqual([]);
    const remaining =
      kind === 'quarantine' ? stored(1) : kind === 'restore' ? join(media, 'one.jpg') : null;
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/scan-dirs/1', headers: { cookie } }))
        .statusCode
    ).toBe(204);
    expect(db.prepare('SELECT * FROM files').all()).toEqual([]);
    if (remaining) expect(await readFile(remaining, 'utf8')).toBe('contents');
    else expect(await exists(source)).toBe(false);
  }
);

it.each(
  (['quarantine', 'restore', 'purge'] as const).flatMap((kind) =>
    (['pending', 'fs_done'] as const).map((status) => ({ kind, status }))
  )
)(
  'rejects unregister for a durable $status $kind row with no running request',
  async ({ kind, status }) => {
    const file = await seed('one.jpg');
    if (kind !== 'quarantine') await move([file]);
    const original = join(media, 'one.jpg');
    const token = (db.prepare('SELECT token FROM scan_dirs WHERE id=1').get() as { token: string })
      .token;
    const src = kind === 'quarantine' ? original : stored(1);
    const dst =
      kind === 'purge'
        ? null
        : kind === 'restore'
          ? original
          : join(media, '.vvv-trash', token, 'injected');
    db.prepare(
      `INSERT INTO file_operations(kind,file_id,src_path,dst_path,status) VALUES (?,?,?,?,?)`
    ).run(kind, file, src, dst, status);
    if (status === 'fs_done') {
      if (dst) {
        await mkdir(dirname(dst), { recursive: true });
        await rename(src, dst);
      } else await fs.unlink(src);
    }
    const before = catalog();
    const denied = await app.inject({
      method: 'DELETE',
      url: '/api/scan-dirs/1',
      headers: { cookie },
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toEqual({ error: 'operations_in_progress' });
    expect(catalog()).toEqual(before);
    expect(await exists(src)).toBe(status === 'pending');
    if (dst) expect(await exists(dst)).toBe(status === 'fs_done');
    await app.close();
    app = await createServer({ ...config, dataDir: root }, false);
    expect(
      db.prepare("SELECT * FROM file_operations WHERE status IN ('pending','fs_done')").all()
    ).toEqual([]);
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/scan-dirs/1', headers: { cookie } }))
        .statusCode
    ).toBe(204);
  }
);

it('allows unregister before an operation starts and refuses a later intent without touching media', async () => {
  const id = await seed('one.jpg');
  expect(
    (await app.inject({ method: 'DELETE', url: '/api/scan-dirs/1', headers: { cookie } }))
      .statusCode
  ).toBe(204);
  expect((await move([id])).json()).toEqual({
    moved: [],
    failed: [{ file_id: id, error: 'file_not_found' }],
  });
  expect(db.prepare('SELECT * FROM file_operations').all()).toEqual([]);
  expect(await readFile(join(media, 'one.jpg'), 'utf8')).toBe('contents');
});

it('smokes real duplicates through live curl: bulk move, restore, purge, restart reconciliation and 401s', async () => {
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  for (let i = 0; i < 4; i++) await writeFile(join(media, `${i}.png`), bytes);
  let address = await app.listen({ host: '127.0.0.1', port: 0 });
  const exec = promisify(execFile);
  async function curl(
    path: string,
    body?: object,
    authenticated = true,
    method = body ? 'POST' : 'GET'
  ) {
    const { stdout } = await exec('curl', [
      '--silent',
      '--show-error',
      '--max-time',
      '10',
      '-X',
      method,
      ...(authenticated ? ['-H', `Cookie: ${cookie}`] : []),
      ...(body ? ['-H', 'Content-Type: application/json', '--data', JSON.stringify(body)] : []),
      '-w',
      '\n%{http_code}',
      `${address}${path}`,
    ]);
    const split = stdout.lastIndexOf('\n');
    return {
      status: Number(stdout.slice(split + 1)),
      body: (split ? JSON.parse(stdout.slice(0, split)) : null) as unknown,
    };
  }
  expect((await curl('/api/scans', {})).status).toBe(202);
  await vi.waitFor(() => expect(activeMatchRun(db)).not.toBeNull());
  const groups = (await curl('/api/groups')).body as GroupsResponse;
  expect(groups.items).toMatchObject([{ kind: 'exact', member_count: 4 }]);
  const detail = (await curl(`/api/groups/${groups.items[0]!.id}`)).body as GroupResponse;
  const members = detail.members.items;
  const moved = (
    await curl('/api/files/quarantine', {
      file_ids: members.slice(0, 2).map(({ file_id }) => file_id),
    })
  ).body as QuarantineResponse;
  expect(moved.failed).toEqual([]);
  expect(moved.moved).toHaveLength(2);
  for (const { trash_id } of moved.moved) expect(await readFile(stored(trash_id))).toEqual(bytes);
  for (const member of members.slice(0, 2)) expect(await exists(member.path)).toBe(false);
  expect(((await curl('/api/groups')).body as GroupsResponse).items).toMatchObject([
    { member_count: 2 },
  ]);
  expect(JSON.stringify((await curl('/api/export.json')).body)).not.toContain(members[0]!.path);
  expect((await curl('/api/trash/restore', { trash_ids: [moved.moved[0]!.trash_id] })).status).toBe(
    200
  );
  expect(await readFile(members[0]!.path)).toEqual(bytes);
  const purgedPath = stored(moved.moved[1]!.trash_id);
  const held = holdFilesystem('purge');
  const purging = curl('/api/trash/purge', { trash_ids: [moved.moved[1]!.trash_id] });
  try {
    await held.wait();
    const before = catalog();
    expect(await curl('/api/scan-dirs/1', undefined, true, 'DELETE')).toEqual({
      status: 409,
      body: { error: 'operations_in_progress' },
    });
    expect(catalog()).toEqual(before);
    expect(await readFile(purgedPath)).toEqual(bytes);
  } finally {
    held.release();
    await purging;
  }
  expect((await purging).body).toEqual({ purged: 1, failed: [] });
  expect(await exists(purgedPath)).toBe(false);
  // Inject the exact durable state of a process killed after rename, before fs_done.
  const token = (db.prepare('SELECT token FROM scan_dirs').get() as { token: string }).token;
  const target = join(media, '.vvv-trash', token, 'crash-injected');
  const member = members[2]!;
  const op = Number(
    db
      .prepare(
        `INSERT INTO file_operations(kind,file_id,src_path,dst_path,status)
    VALUES ('quarantine',?,?,?,'pending')`
      )
      .run(member.file_id, member.path, target).lastInsertRowid
  );
  await mkdir(dirname(target), { recursive: true });
  await rename(member.path, target);
  await app.close();
  app = await createServer({ ...config, dataDir: root }, false);
  address = await app.listen({ host: '127.0.0.1', port: 0 });
  expect(db.prepare('SELECT status FROM file_operations WHERE id=?').get(op)).toEqual({
    status: 'committed',
  });
  const trash = (await curl('/api/trash')).body as Page<TrashItem>;
  expect(trash.items.map(({ file_id }) => file_id)).toEqual([member.file_id]);
  expect(await readFile(target)).toEqual(bytes);
  expect(((await curl('/api/groups')).body as GroupsResponse).items).toMatchObject([
    { member_count: 2 },
  ]);
  const remaining = members[3]!;
  expect((await curl('/api/files/quarantine', { file_ids: [remaining.file_id] })).status).toBe(200);
  expect((await curl('/api/groups')).body).toEqual({ items: [], next_cursor: null });
  expect((await curl('/api/export.json')).body).toEqual({ groups: [] });
  for (const [path, body] of [
    ['/api/trash', undefined],
    ['/api/files/quarantine', {}],
    ['/api/trash/restore', {}],
    ['/api/trash/purge', {}],
  ] as const)
    expect((await curl(path, body, false)).status).toBe(401);
  expect((await curl('/api/scan-dirs/1', undefined, true, 'DELETE')).status).toBe(204);
  expect(await readFile(target)).toEqual(bytes);
});
