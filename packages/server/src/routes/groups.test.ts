import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import Database from 'better-sqlite3';
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
function put(path: string, size = 10, hash = 'same') {
  return Number(
    db
      .prepare(
        `INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status,sha256,width,height,duration_ms)
    VALUES (1,?,'image',?,0,'done',?,320,240,NULL)`
      )
      .run(path, size, hash).lastInsertRowid
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

it('automatically matches a completed real scan without a manual match request', async () => {
  const media = join(root, 'media');
  await mkdir(media);
  await writeFile(join(media, 'one.jpg'), 'equal bytes');
  await writeFile(join(media, 'two.jpg'), 'equal bytes');
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
