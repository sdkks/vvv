import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type {
  GroupResponse,
  GroupsResponse,
  QuarantineResponse,
  RestoreResponse,
} from '@vvv/shared';
import { createServer } from './server.js';
import { openDatabase } from './db.js';
import { activeMatchRun } from './matcher.js';

const exec = promisify(execFile);
const hasFpcalc = (() => {
  try {
    execFileSync('fpcalc', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const ffmpeg = (...args: string[]) =>
  exec('ffmpeg', ['-v', 'error', '-y', ...args], { timeout: 60000 });
let fixtures: string;
let videoFixtures: string;
let app: Awaited<ReturnType<typeof createServer>>;
let db: ReturnType<typeof openDatabase>['db'];
let cookie: string;
let root: string;
const password = 'partial-integration-password';
const waitScan = async () =>
  vi.waitFor(
    () =>
      expect(db.prepare('SELECT status FROM scans ORDER BY id DESC LIMIT 1').get()).toEqual({
        status: 'done',
      }),
    { timeout: 60000, interval: 20 }
  );
const waitMatch = async () =>
  vi.waitFor(
    () => {
      expect(activeMatchRun(db)).not.toBeNull();
      expect(
        db.prepare("SELECT count(*) AS n FROM match_runs WHERE status='building'").get()
      ).toEqual({
        n: 0,
      });
    },
    { timeout: 60000, interval: 20 }
  );
beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), 'vvv-partial-fixtures-'));
  // Pink noise: every subfingerprint carries timing information, unlike constant tones.
  const source = join(fixtures, 'source.m4a');
  const mid = join(fixtures, 'mid.mp3');
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'anoisesrc=d=30:seed=1:color=pink',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    source
  );
  // A 20s re-encoded slice of the source starting at 5s, then a 10s re-encoded slice
  // of that slice starting at its 5s (= 10s into the source), plus unrelated noise.
  await ffmpeg('-ss', '5', '-i', source, '-t', '20', '-c:a', 'libmp3lame', '-b:a', '128k', mid);
  await ffmpeg(
    '-ss',
    '5',
    '-i',
    mid,
    '-t',
    '10',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    join(fixtures, 'clip.m4a')
  );
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'anoisesrc=d=10:seed=2:color=pink',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '96k',
    join(fixtures, 'other.mp3')
  );
  // A real video pair for the video-member path: testsrc video with pink-noise audio
  // (constant tones are degenerate for chromaprint — one distinct subfingerprint per
  // stretch — so the known segment must carry timing information), plus its re-encoded
  // ten-second trim from the start. Separate directory keeps the audio-fixture groups
  // at three.
  videoFixtures = await mkdtemp(join(tmpdir(), 'vvv-partial-video-'));
  const show = join(videoFixtures, 'show.mp4');
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'anoisesrc=d=20:seed=3:color=pink',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=20:size=320x240:rate=15',
    '-shortest',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    show
  );
  await ffmpeg(
    '-i',
    show,
    '-t',
    '10',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    join(videoFixtures, 'cut.mp4')
  );
}, 60000);
afterAll(async () => {
  await rm(fixtures, { recursive: true, force: true });
  await rm(videoFixtures, { recursive: true, force: true });
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vvv-partial-integration-'));
  app = await createServer(
    { password, sessionSecret: 'partial-integration-session', port: 8080, dataDir: root },
    false
  );
  db = openDatabase(root).db;
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});
const request = (url: string, method: 'GET' | 'POST' = 'GET', payload?: object) =>
  app.inject({ method, url, headers: { cookie }, payload });
const fileId = (relPath: string) =>
  (db.prepare('SELECT id FROM files WHERE rel_path=?').get(relPath) as { id: number }).id;

it.skipIf(!hasFpcalc)(
  'builds directional groups for trims of a source, survives quarantine, and regenerates',
  async () => {
    await request('/api/scan-dirs', 'POST', { path: fixtures });
    expect((await request('/api/scans', 'POST')).statusCode).toBe(202);
    await waitScan();
    await waitMatch();
    const groupsResponse = await request('/api/groups?kind=audio_partial');
    expect(groupsResponse.statusCode).toBe(200);
    const groups = groupsResponse.json<GroupsResponse>().items;
    expect(groups).toHaveLength(3);
    for (const group of groups) {
      expect(group.kind).toBe('audio_partial');
      expect(group.member_count).toBe(2);
    }
    // Every directional pair: clip (10s) inside mid (20s) inside source (30s).
    const clipId = fileId('clip.m4a');
    const midId = fileId('mid.mp3');
    const sourceId = fileId('source.m4a');
    const otherId = fileId('other.mp3');
    const verdicts = [] as {
      id: number;
      subset: number;
      superset: number;
      offset: number;
      confidence: number;
    }[];
    for (const group of groups) {
      const detail = (await request(`/api/groups/${group.id}`)).json<GroupResponse>();
      const roles = detail.members.items.map((member) => {
        expect(member.role).toBeDefined();
        expect(member.offset_seconds).not.toBeNull();
        return [member.role, member.file_id, member.similarity, member.offset_seconds] as const;
      });
      const subset = roles.find(([role]) => role === 'subset')!;
      const superset = roles.find(([role]) => role === 'superset')!;
      expect(superset[3]).toBe(subset[3]);
      verdicts.push({
        id: group.id,
        subset: subset[1],
        superset: superset[1],
        offset: subset[3]!,
        confidence: subset[2]!,
      });
    }
    expect(verdicts).toHaveLength(3);
    const clipInMid = verdicts.find((v) => v.subset === clipId && v.superset === midId)!;
    const clipInSource = verdicts.find((v) => v.superset === sourceId && v.subset === clipId)!;
    const midInSource = verdicts.find((v) => v.superset === sourceId && v.subset === midId)!;
    expect(clipInMid).toBeDefined();
    expect(clipInSource).toBeDefined();
    expect(midInSource).toBeDefined();
    expect(Math.abs(clipInMid.offset - 5)).toBeLessThanOrEqual(1);
    expect(Math.abs(clipInSource.offset - 10)).toBeLessThanOrEqual(1);
    expect(Math.abs(midInSource.offset - 5)).toBeLessThanOrEqual(1);
    // The unrelated file appears in no directional group.
    for (const verdict of verdicts) {
      expect(verdict.subset).not.toBe(otherId);
      expect(verdict.superset).not.toBe(otherId);
    }
    // Quarantining the clip dissolves exactly the two groups it belongs to; the
    // mid⊂source group survives with correct members and the superset stays visible.
    expect(
      (
        await request('/api/files/quarantine', 'POST', { file_ids: [clipId] })
      ).json<QuarantineResponse>().moved
    ).toHaveLength(1);
    await vi.waitFor(() =>
      expect(
        db.prepare("SELECT count(*) AS n FROM dup_groups WHERE kind='audio_partial'").get()
      ).toEqual({
        n: 1,
      })
    );
    const survivors = (await request('/api/groups?kind=audio_partial')).json<GroupsResponse>()
      .items;
    expect(survivors).toHaveLength(1);
    const survivorDetail = (await request(`/api/groups/${survivors[0]!.id}`)).json<GroupResponse>();
    expect(
      survivorDetail.members.items.map((member) => member.file_id).sort((x, y) => x - y)
    ).toEqual([midId, sourceId].sort((x, y) => x - y));
    expect((await request(`/api/groups/${clipInMid.id}`)).statusCode).toBe(404);
    expect((await request(`/api/groups/${clipInSource.id}`)).statusCode).toBe(404);
    expect((await request('/api/trash')).statusCode).toBe(200);
    // Restoring and re-matching regenerates all three directional groups.
    const trashId = (
      db.prepare('SELECT id FROM trash WHERE file_id=? AND restored=0').get(clipId) as {
        id: number;
      }
    ).id;
    expect(
      (
        await request('/api/trash/restore', 'POST', { trash_ids: [trashId] })
      ).json<RestoreResponse>().restored
    ).toHaveLength(1);
    expect((await request('/api/matches/run', 'POST')).statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(
        db.prepare("SELECT count(*) AS n FROM match_runs WHERE status='active'").get()
      ).toEqual({ n: 1 });
      expect(
        db.prepare("SELECT count(*) AS n FROM dup_groups WHERE kind='audio_partial'").get()
      ).toEqual({ n: 3 });
    });
    // Unauthenticated requests stay rejected.
    expect((await app.inject({ url: '/api/groups?kind=audio_partial' })).statusCode).toBe(401);
  },
  180000
);

it.skipIf(!hasFpcalc)(
  'matches a trim of a fixture video against its source as a directional audio group',
  async () => {
    await request('/api/scan-dirs', 'POST', { path: videoFixtures });
    expect((await request('/api/scans', 'POST')).statusCode).toBe(202);
    await waitScan();
    await waitMatch();
    const groups = (await request('/api/groups?kind=audio_partial')).json<GroupsResponse>().items;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('audio_partial');
    expect(groups[0]!.member_count).toBe(2);
    // Both members traversed as real videos and were fingerprinted as such: the
    // matcher is kind-agnostic, but nothing here works unless the video pipeline
    // feeds it subfingerprints.
    const kinds = (
      db
        .prepare("SELECT rel_path,kind FROM files WHERE rel_path IN ('cut.mp4','show.mp4')")
        .all() as {
        rel_path: string;
        kind: string;
      }[]
    ).sort((a, b) => a.rel_path.localeCompare(b.rel_path));
    expect(kinds).toEqual([
      { rel_path: 'cut.mp4', kind: 'video' },
      { rel_path: 'show.mp4', kind: 'video' },
    ]);
    const detail = (await request(`/api/groups/${groups[0]!.id}`)).json<GroupResponse>();
    const subset = detail.members.items.find((member) => member.role === 'subset')!;
    const superset = detail.members.items.find((member) => member.role === 'superset')!;
    // The ten-second cut is the subset of the twenty-second source.
    expect(subset.file_id).toBe(fileId('cut.mp4'));
    expect(superset.file_id).toBe(fileId('show.mp4'));
    // The trim starts at the source's beginning, so the offset lands at ≈0s on the
    // source's own timeline, with both members carrying the same alignment figures.
    expect(subset.offset_seconds).not.toBeNull();
    expect(superset.offset_seconds).toBe(subset.offset_seconds);
    expect(Math.abs(subset.offset_seconds!)).toBeLessThanOrEqual(1);
    expect(subset.similarity).toBeGreaterThanOrEqual(50);
    expect(superset.similarity).toBe(subset.similarity);
  },
  180000
);
