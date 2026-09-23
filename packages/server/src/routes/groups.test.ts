import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DuplicateGroup, GroupResponse, GroupsResponse } from '@vvv/shared';
import { createServer } from '../server.js';
import { openDatabase } from '../db.js';
import { activeMatchRun } from '../matcher.js';

const config = {
  password: 'groups-test-password',
  sessionSecret: 'groups-test-session',
  port: 8080,
};
let root: string;
let app: Awaited<ReturnType<typeof createServer>>;
let db: Database.Database;
let cookie: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vvv-groups-'));
  app = await createServer({ ...config, dataDir: root }, false);
  db = openDatabase(root).db;
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: config.password },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  db.prepare('INSERT INTO scan_dirs(path) VALUES (?)').run(join(root, 'media'));
});
afterEach(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const get = (url: string) => app.inject({ url, headers: { cookie } });
const start = () => app.inject({ method: 'POST', url: '/api/matches/run', headers: { cookie } });
const removeDir = (id = 1) =>
  app.inject({ method: 'DELETE', url: `/api/scan-dirs/${id}`, headers: { cookie } });
function put(path: string, size = 10, hash = 'same', scanDirId = 1) {
  return Number(
    db
      .prepare(
        `INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status,sha256,width,height,duration_ms)
    VALUES (?,?,'image',?,0,'done',?,320,240,NULL)`
      )
      .run(scanDirId, path, size, hash).lastInsertRowid
  );
}
async function match() {
  const response = await start();
  expect(response.statusCode).toBe(202);
  const id = response.json<{ match_run: number }>().match_run;
  await vi.waitFor(() => {
    expect(activeMatchRun(db)).toBe(id);
    expect(db.prepare('SELECT count(*) AS n FROM match_runs').get()).toEqual({ n: 1 });
  });
  await tick();
  await tick();
  return id;
}
async function pages(kind?: string) {
  const items: DuplicateGroup[] = [];
  let cursor: string | null = null;
  do {
    const response = await get(
      `/api/groups?limit=2${kind ? `&kind=${kind}` : ''}${cursor ? `&cursor=${cursor}` : ''}`
    );
    expect(response.statusCode).toBe(200);
    const page = response.json<GroupsResponse>();
    items.push(...page.items);
    cursor = page.next_cursor;
    expect(items.length).toBeLessThan(30);
  } while (cursor);
  return items;
}

it('rejects unauthenticated access to every new route before matching or exporting', async () => {
  for (const [method, url] of [
    ['POST', '/api/matches/run'],
    ['GET', '/api/groups'],
    ['GET', '/api/groups/1'],
    ['GET', '/api/export.csv'],
    ['GET', '/api/export.json'],
  ] as const) {
    const response = await app.inject({ method, url });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  }
  expect(db.prepare('SELECT count(*) AS n FROM match_runs').get()).toEqual({ n: 0 });
});

it('returns empty initial results, missing-group 404s, and validates ids, limits and cursors', async () => {
  expect((await get('/api/groups')).json()).toEqual({ items: [], next_cursor: null });
  expect((await get('/api/groups/1')).statusCode).toBe(404);
  for (const url of [
    '/api/groups?kind=unknown',
    '/api/groups?limit=0',
    '/api/groups?limit=-1',
    '/api/groups?limit=1.5',
    '/api/groups?limit=',
    '/api/groups?other=1',
    '/api/groups?limit=1&limit=2',
    '/api/groups?cursor=bad',
    '/api/groups?cursor=' + 'a'.repeat(301),
    '/api/groups/0',
    '/api/groups/no',
    '/api/groups/1?cursor=-1',
    '/api/groups/1?cursor=abc',
    '/api/groups/1?limit=0',
    '/api/groups/1?kind=exact',
  ])
    expect((await get(url)).statusCode, url).toBe(400);
  for (const value of [
    null,
    {},
    [1, '*', -1, 1],
    [1, '*', 0, 1.5],
    [1, 'other', 0, 1],
    [1, '*', 0, 1, 2],
  ]) {
    const cursor = Buffer.from(JSON.stringify(value)).toString('base64url');
    expect((await get(`/api/groups?cursor=${cursor}`)).statusCode).toBe(400);
  }
});

it('paginates ties and lower sizes deterministically and identically using both indexed query shapes', async () => {
  for (const [index, size] of [40, 40, 40, 20, 20, 10, 0].entries()) {
    put(`${index}-a.jpg`, size, `hash-${index}`);
    put(`${index}-b.jpg`, size, `hash-${index}`);
  }
  const run = await match();
  const prepare = vi.spyOn(Database.prototype, 'prepare');
  const all = await pages();
  const exact = await pages('exact');
  expect(all).toEqual(exact);
  expect(all.map((item) => item.reclaimable_bytes)).toEqual([40, 40, 40, 20, 20, 10, 0]);
  expect(new Set(all.map((item) => item.id)).size).toBe(7);
  const expected = db
    .prepare('SELECT id FROM dup_groups ORDER BY reclaimable_bytes DESC,id ASC')
    .all();
  expect(all.map(({ id }) => ({ id }))).toEqual(expected);
  const sqls = [
    ...new Set(
      prepare.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => sql.includes('INDEXED BY idx_groups_page'))
    ),
  ];
  expect(sqls).toHaveLength(4);
  prepare.mockRestore();
  for (const sql of sqls) {
    const kind = sql.includes('idx_groups_page_kind');
    const args = kind ? [run, 'exact'] : [run];
    const bindings = sql.includes('UNION ALL') ? [...args, 40, 1, ...args, 40, 3] : [...args, 3];
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as { detail: string }[];
    expect(
      plan.some(({ detail }) =>
        detail.includes(kind ? 'idx_groups_page_kind' : 'idx_groups_page_all')
      )
    ).toBe(true);
    expect(
      plan.some(
        ({ detail }) => detail.includes('TEMP B-TREE') || detail.startsWith('SCAN dup_groups')
      )
    ).toBe(false);
    if (sql.includes('UNION ALL'))
      expect(plan.filter(({ detail }) => detail.startsWith('SEARCH dup_groups'))).toHaveLength(2);
  }
  db.prepare("UPDATE dup_groups SET kind='image' WHERE id=?").run(all[1]!.id);
  expect(await pages('exact')).toEqual(all.filter((_, index) => index !== 1));
  expect(await pages('image')).toEqual([{ ...all[1], kind: 'image' }]);
  expect((await pages()).map(({ id }) => id)).toEqual(all.map(({ id }) => id));
});

it('selects the lowest done visual member, never audio, unavailable files, or a quality winner', async () => {
  const audio = put('sound.wav');
  const missing = put('missing.jpg');
  const pending = put('pending.jpg');
  const video = put('first.mp4');
  const image = put('larger.jpg');
  const audioOnly = [put('a.wav', 20, 'audio'), put('b.wav', 20, 'audio')];
  const imageFirst = put('first.jpg', 30, 'visual');
  const videoLater = put('later.mp4', 30, 'visual');
  await match();
  db.prepare("UPDATE files SET kind='audio' WHERE id IN (?,?,?)").run(audio, ...audioOnly);
  db.prepare("UPDATE files SET status='missing' WHERE id=?").run(missing);
  db.prepare("UPDATE files SET status='pending' WHERE id=?").run(pending);
  db.prepare("UPDATE files SET kind='video' WHERE id IN (?,?)").run(video, videoLater);
  db.prepare('UPDATE files SET width=4096,height=2160,size=9999 WHERE id=?').run(image);
  const response = await get('/api/groups');
  expect(response.statusCode).toBe(200);
  const groups = response.json<GroupsResponse>().items;
  const mixed = groups.find((group) => group.member_count === 5)!;
  expect(mixed.representative).toEqual({ file_id: video, kind: 'video' });
  expect(groups.find((group) => group.total_bytes === 40)?.representative).toBeNull();
  expect(groups.find((group) => group.total_bytes === 60)?.representative).toEqual({
    file_id: imageFirst,
    kind: 'image',
  });
  expect(Object.keys(mixed).sort()).toEqual([
    'id',
    'kind',
    'member_count',
    'reclaimable_bytes',
    'representative',
    'total_bytes',
  ]);
  db.prepare("UPDATE files SET status='quarantined' WHERE id=?").run(video);
  const updated = (await get('/api/groups')).json<GroupsResponse>().items;
  expect(updated.find((group) => group.id === mixed.id)?.representative).toEqual({
    file_id: image,
    kind: 'image',
  });
  expect((await get(`/api/groups/${mixed.id}`)).json()).not.toHaveProperty('representative');
});

it('uses one indexed representative query restricted to returned page ids, not detail loads', async () => {
  for (let i = 0; i < 55; i++) {
    put(`${i}-a.jpg`, 10, `${i}`);
    put(`${i}-b.jpg`, 10, `${i}`);
  }
  await match();
  const prepare = vi.spyOn(Database.prototype, 'prepare');
  const first = (await get('/api/groups')).json<GroupsResponse>();
  const second = (await get(`/api/groups?cursor=${first.next_cursor}`)).json<GroupsResponse>();
  const queries = prepare.mock.calls.map(([sql]) => sql);
  const lookups = queries.filter((sql) => sql.startsWith('SELECT g.id AS group_id'));
  expect(lookups).toHaveLength(2);
  expect(queries.some((sql) => sql.includes('JOIN scan_dirs'))).toBe(false);
  expect(first.items).toHaveLength(50);
  expect(second.items).toHaveLength(5);
  prepare.mockRestore();
  for (const [index, page] of [first, second].entries()) {
    const sql = lookups[index]!;
    expect(sql.match(/\?/g)).toHaveLength(page.items.length);
    expect(page.items.every((group) => group.representative?.kind === 'image')).toBe(true);
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...page.items.map((g) => g.id)) as {
      detail: string;
    }[];
    expect(plan.some(({ detail }) => detail.startsWith('SEARCH g USING INTEGER PRIMARY KEY'))).toBe(
      true
    );
    expect(
      plan.some(
        ({ detail }) =>
          detail.startsWith('SEARCH m USING COVERING INDEX') && detail.includes('group_id=?')
      )
    ).toBe(true);
    expect(
      plan.some(({ detail }) => detail.includes('TEMP B-TREE') || detail.startsWith('SCAN '))
    ).toBe(false);
  }
});

it('rejects filter-mismatched cursors and reports a new generation on stale cursors', async () => {
  for (let i = 0; i < 3; i++) {
    put(`${i}-a.jpg`, 10, `${i}`);
    put(`${i}-b.jpg`, 10, `${i}`);
  }
  await match();
  const first = (await get('/api/groups?limit=1')).json<GroupsResponse>();
  const filtered = (await get('/api/groups?kind=exact&limit=1')).json<GroupsResponse>();
  expect(first.next_cursor).toBeTypeOf('string');
  expect((await get(`/api/groups?kind=exact&cursor=${first.next_cursor}`)).statusCode).toBe(400);
  expect((await get(`/api/groups?cursor=${filtered.next_cursor}`)).statusCode).toBe(400);
  const run = await match();
  const stale = await get(`/api/groups?cursor=${first.next_cursor}`);
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toEqual({ error: 'stale_cursor', match_run: run });
  const staleFiltered = await get(`/api/groups?kind=exact&cursor=${filtered.next_cursor}`);
  expect(staleFiltered.statusCode).toBe(409);
  expect(staleFiltered.json()).toEqual({ error: 'stale_cursor', match_run: run });
  expect((await get(`/api/groups/${first.items[0]!.id}`)).statusCode).toBe(404);
});

it('paginates giant groups with bounded member pages and excludes non-done files at read time', async () => {
  db.transaction(() => {
    for (let i = 0; i < 503; i++) put(`member-${i}.jpg`);
  })();
  await match();
  const group = (await get('/api/groups')).json<GroupsResponse>().items[0]!;
  expect(group).toMatchObject({ member_count: 503, total_bytes: 5030, reclaimable_bytes: 5020 });
  const first = (await get(`/api/groups/${group.id}`)).json<GroupResponse>();
  expect(first.members.items).toHaveLength(100);
  expect(first.members.next_cursor).toBe('100');
  expect(first.members.items[0]).toEqual({
    file_id: 1,
    path: join(root, 'media/member-0.jpg'),
    size: 10,
    width: 320,
    height: 240,
    duration_ms: null,
    similarity: null,
    quarantined: false,
  });
  const capped = (await get(`/api/groups/${group.id}?limit=999`)).json<GroupResponse>();
  expect(capped.members.items).toHaveLength(500);
  expect(capped.members.next_cursor).toBe('500');
  db.exec(
    "UPDATE files SET status='quarantined' WHERE id=501; UPDATE files SET status='missing' WHERE id=502"
  );
  const last = (
    await get(`/api/groups/${group.id}?cursor=${capped.members.next_cursor}`)
  ).json<GroupResponse>();
  expect(last.members.items.map((member) => member.file_id)).toEqual([503]);
  expect(last.members.next_cursor).toBeNull();
  expect((await get(`/api/groups/${group.id}?cursor=503`)).json<GroupResponse>().members).toEqual({
    items: [],
    next_cursor: null,
  });
});

it('caps group listings and returns 409 for an in-flight match without exposing the building generation', async () => {
  db.transaction(() => {
    for (let i = 0; i < 503; i++) {
      put(`${i}-a.jpg`, 10, `${i}`);
      put(`${i}-b.jpg`, 10, `${i}`);
    }
  })();
  await match();
  expect((await get('/api/groups')).json<GroupsResponse>().items).toHaveLength(50);
  expect((await get('/api/groups?limit=999')).json<GroupsResponse>().items).toHaveLength(500);
  const old = activeMatchRun(db);
  const [one, two, browsing] = await Promise.all([start(), start(), get('/api/groups?limit=1')]);
  expect(one.statusCode).toBe(202);
  expect(two.statusCode).toBe(409);
  expect(two.json()).toEqual({ error: 'match_running' });
  const cursor = browsing.json<GroupsResponse>().next_cursor!;
  expect(JSON.parse(Buffer.from(cursor, 'base64url').toString())[0]).toBe(old);
});

it('removes phantom groups and member rows when their only directory is deleted', async () => {
  put('one.jpg');
  put('two.jpg');
  await match();
  const group = (await pages())[0]!;
  expect((await removeDir()).statusCode).toBe(204);
  expect(await pages()).toEqual([]);
  expect((await get(`/api/groups/${group.id}`)).statusCode).toBe(404);
  expect((await get('/api/export.json')).json()).toEqual({ groups: [] });
  expect(db.prepare('SELECT count(*) AS n FROM dup_group_members').get()).toEqual({ n: 0 });
});

it.each([1, 2, 3])('recomputes a spanning group with %i surviving members', async (survivors) => {
  db.prepare('INSERT INTO scan_dirs(path) VALUES (?)').run(join(root, 'other'));
  put('removed.jpg');
  const ids = Array.from({ length: survivors }, (_, i) => put(`keep-${i}.jpg`, 10, 'same', 2));
  await match();
  const group = (await pages())[0]!;
  expect(group.member_count).toBe(survivors + 1);
  expect((await removeDir()).statusCode).toBe(204);
  const detail = await get(`/api/groups/${group.id}`);
  if (survivors < 2) {
    expect(await pages()).toEqual([]);
    expect(detail.statusCode).toBe(404);
  } else {
    expect(await pages()).toEqual([
      {
        ...group,
        representative: { file_id: ids[0], kind: 'image' },
        member_count: survivors,
        total_bytes: survivors * 10,
        reclaimable_bytes: (survivors - 1) * 10,
      },
    ]);
    expect(detail.json<GroupResponse>().members.items.map((member) => member.file_id)).toEqual(ids);
    const { representative, ...summary } = (await get('/api/groups')).json<GroupsResponse>()
      .items[0]!;
    expect(representative).toEqual({ file_id: ids[0], kind: 'image' });
    expect(detail.json<GroupResponse>()).toMatchObject(summary);
  }
});

it('prunes non-done survivors and subtracts the largest surviving size from totals', async () => {
  db.prepare('INSERT INTO scan_dirs(path) VALUES (?)').run(join(root, 'other'));
  put('removed.jpg');
  const small = put('small.jpg', 10, 'same', 2);
  const large = put('large.jpg', 10, 'same', 2);
  const missing = put('missing.jpg', 10, 'same', 2);
  const untouched = [
    put('unrelated-a.jpg', 30, 'other', 2),
    put('unrelated-b.jpg', 30, 'other', 2),
  ];
  await match();
  const before = await pages();
  const group = before.find((item) => item.member_count === 4)!;
  db.prepare("UPDATE files SET status='missing' WHERE id=?").run(missing);
  db.prepare('UPDATE files SET size=25 WHERE id=?').run(large);
  expect((await removeDir()).statusCode).toBe(204);
  expect((await get(`/api/groups/${group.id}`)).json<GroupResponse>()).toMatchObject({
    id: group.id,
    kind: group.kind,
    member_count: 2,
    total_bytes: 35,
    reclaimable_bytes: 10,
    members: { items: [{ file_id: small }, { file_id: large }], next_cursor: null },
  });
  expect(
    db
      .prepare('SELECT file_id FROM dup_group_members WHERE group_id=? ORDER BY file_id')
      .all(group.id)
  ).toEqual([{ file_id: small }, { file_id: large }]);
  expect((await pages()).find((item) => item.id !== group.id)).toEqual(
    before.find((item) => item.id !== group.id)
  );
  expect(
    db
      .prepare('SELECT file_id FROM dup_group_members WHERE group_id<>? ORDER BY file_id')
      .all(group.id)
  ).toEqual(untouched.map((file_id) => ({ file_id })));
});

it('repairs more than one affected-group batch and rolls back if directory deletion fails', async () => {
  db.transaction(() => {
    for (let i = 0; i < 1001; i++) {
      put(`${i}-a.jpg`, 10, `${i}`);
      put(`${i}-b.jpg`, 10, `${i}`);
    }
  })();
  await match();
  db.exec(`CREATE TRIGGER fail_delete BEFORE DELETE ON scan_dirs BEGIN
    SELECT RAISE(ABORT, 'delete fault'); END`);
  expect((await removeDir()).statusCode).toBe(500);
  expect(db.prepare('SELECT count(*) AS n FROM dup_groups WHERE member_count=2').get()).toEqual({
    n: 1001,
  });
  expect(db.prepare('SELECT count(*) AS n FROM dup_group_members').get()).toEqual({ n: 2002 });
  expect(db.prepare('SELECT count(*) AS n FROM files').get()).toEqual({ n: 2002 });
  db.exec('DROP TRIGGER fail_delete');
  expect((await removeDir()).statusCode).toBe(204);
  expect(await pages()).toEqual([]);
  expect(db.prepare('SELECT count(*) AS n FROM dup_group_members').get()).toEqual({ n: 0 });
});

it('corrects active results and building groups before, during and after a member chunk', async () => {
  db.prepare('INSERT INTO scan_dirs(path) VALUES (?)').run(join(root, 'other'));
  db.transaction(() => {
    // This group is completed before the first member-chunk yield.
    put('early-remove.jpg', 1, 'early');
    put('early-keep.jpg', 1, 'early', 2);
    // This group is only partially populated when the directory is removed.
    for (let i = 0; i < 10001; i++) put(`large-${i}.jpg`, 10, 'large');
    put('large-keep-a.jpg', 10, 'large', 2);
    put('large-keep-b.jpg', 10, 'large', 2);
    // These candidates are snapshotted but have not started publication at deletion time.
    put('later-a.jpg', 20, 'later');
    put('later-b.jpg', 20, 'later');
    put('spanning-remove.jpg', 30, 'spanning');
    put('spanning-keep-a.jpg', 30, 'spanning', 2);
    put('spanning-keep-b.jpg', 30, 'spanning', 2);
  })();
  const old = await match();
  const original = await pages();
  const response = await start();
  expect(response.statusCode).toBe(202);
  const building = response.json<{ match_run: number }>().match_run;
  await tick();
  expect(activeMatchRun(db)).toBe(old);
  expect(
    db.prepare('SELECT count(*) AS n FROM dup_groups WHERE match_run=?').get(building)
  ).toEqual({ n: 2 });
  expect(
    db
      .prepare(
        `SELECT count(*) AS n FROM dup_group_members m JOIN dup_groups g ON g.id=m.group_id
    WHERE g.match_run=?`
      )
      .get(building)
  ).toEqual({ n: 10000 });
  expect((await removeDir()).statusCode).toBe(204);
  expect(activeMatchRun(db)).toBe(old);
  const corrected = await pages();
  expect(
    corrected.map(({ member_count, total_bytes, reclaimable_bytes }) => ({
      member_count,
      total_bytes,
      reclaimable_bytes,
    }))
  ).toEqual([
    { member_count: 2, total_bytes: 60, reclaimable_bytes: 30 },
    { member_count: 2, total_bytes: 20, reclaimable_bytes: 10 },
  ]);
  for (const group of original.filter((item) => !corrected.some(({ id }) => id === item.id)))
    expect((await get(`/api/groups/${group.id}`)).statusCode).toBe(404);
  await vi.waitFor(() => {
    expect(activeMatchRun(db)).toBe(building);
    expect(db.prepare('SELECT count(*) AS n FROM match_runs').get()).toEqual({ n: 1 });
  });
  const clean = (items: DuplicateGroup[]) =>
    items.map(({ member_count, total_bytes, reclaimable_bytes }) => ({
      member_count,
      total_bytes,
      reclaimable_bytes,
    }));
  expect(clean(await pages())).toEqual(clean(corrected));
  expect(db.prepare('SELECT count(*) AS n FROM dup_group_members').get()).toEqual({ n: 4 });
  await tick();
  await match();
  expect(clean(await pages())).toEqual(clean(corrected));
});

it('scans fixture images and serves kind=image and reference distances over live curl with auth', async () => {
  const media = join(root, 'media');
  const exec = promisify(execFile);
  await exec(process.execPath, [
    fileURLToPath(new URL('../../../../tests/fixtures/generate-images.mjs', import.meta.url)),
    media,
  ]);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const curl = async (path: string, method = 'GET', authenticated = true) => {
    const { stdout } = await exec('curl', [
      '--silent',
      '--show-error',
      '-X',
      method,
      ...(authenticated ? ['-H', `Cookie: ${cookie}`] : []),
      '-w',
      '\n%{http_code}',
      `${address}${path}`,
    ]);
    const split = stdout.lastIndexOf('\n');
    return {
      status: Number(stdout.slice(split + 1)),
      body: JSON.parse(stdout.slice(0, split)) as unknown,
    };
  };
  expect((await curl('/api/scans', 'POST')).status).toBe(202);
  await vi.waitFor(() => expect(activeMatchRun(db)).not.toBeNull());
  const response = await curl('/api/groups?kind=image');
  expect(response.status).toBe(200);
  const images = (response.body as GroupsResponse).items;
  expect(images.map((g) => g.member_count).sort()).toEqual([2, 4]);
  for (const group of images) {
    const detail = await curl(`/api/groups/${group.id}`);
    expect(detail.status).toBe(200);
    const members = (detail.body as GroupResponse).members.items;
    const prefix = members[0]!.path.includes('scene-a') ? 'scene-a' : 'scene-b';
    expect(members.every((m) => m.path.includes(prefix))).toBe(true);
    expect(members[0]!.similarity).toBe(0);
    expect(members.every((m) => typeof m.similarity === 'number')).toBe(true);
  }
  expect(((await curl('/api/groups?kind=exact')).body as GroupsResponse).items).toMatchObject([
    { kind: 'exact', member_count: 2 },
  ]);
  const old = activeMatchRun(db);
  await vi.waitFor(async () => expect((await curl('/api/matches/run', 'POST')).status).toBe(202));
  await vi.waitFor(() => expect(activeMatchRun(db)).not.toBe(old));
  for (const [path, method] of [
    ['/api/groups?kind=image', 'GET'],
    [`/api/groups/${images[0]!.id}`, 'GET'],
    ['/api/matches/run', 'POST'],
  ])
    expect((await curl(path!, method!, false)).status).toBe(401);
});

it('automatically matches a completed real scan without a manual match request', async () => {
  const media = join(root, 'media');
  await mkdir(media);
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  await writeFile(join(media, 'one.png'), bytes);
  await writeFile(join(media, 'two.png'), bytes);
  const response = await app.inject({ method: 'POST', url: '/api/scans', headers: { cookie } });
  expect(response.statusCode).toBe(202);
  await vi.waitFor(async () => {
    expect((await get('/api/scans/current')).json()).toMatchObject({
      status: 'done',
      processed: 2,
    });
    expect((await get('/api/groups')).json<GroupsResponse>().items).toMatchObject([
      { kind: 'exact', member_count: 2 },
    ]);
  });
});
