import { execFile, execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from './server.js';
import { openDatabase } from './db.js';
import { audioFingerprint } from './audio.js';

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
let app: Awaited<ReturnType<typeof createServer>>;
let db: ReturnType<typeof openDatabase>['db'];
let cookie: string;
let root: string;
const password = 'audio-integration-password';
const waitScan = async () =>
  vi.waitFor(
    () =>
      expect(db.prepare('SELECT status FROM scans ORDER BY id DESC LIMIT 1').get()).toEqual({
        status: 'done',
      }),
    { timeout: 60000, interval: 20 }
  );
beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), 'vvv-audio-fixtures-'));
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=3',
    '-c:a',
    'libmp3lame',
    join(fixtures, 'tone.mp3')
  );
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=3',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=12:duration=3',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-shortest',
    join(fixtures, 'sound.mp4')
  );
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=12:duration=1',
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    join(fixtures, 'silent.mp4')
  );
}, 60000);
afterAll(async () => {
  await rm(fixtures, { recursive: true, force: true });
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vvv-audio-integration-'));
  app = await createServer(
    { password, sessionSecret: 'audio-integration-session', port: 8080, dataDir: root },
    false
  );
  db = openDatabase(root).db;
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});
const request = (url: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', payload?: object) =>
  app.inject({ method, url, headers: { cookie }, payload });

it.skipIf(!hasFpcalc)(
  'matches direct fpcalc output for real audio and classifies silent input',
  async () => {
    const fingerprint = await audioFingerprint(join(fixtures, 'tone.mp3'), { timeout: 30000 });
    const direct = JSON.parse(
      (await exec('fpcalc', ['-raw', '-json', join(fixtures, 'tone.mp3')])).stdout
    ) as { duration: number; fingerprint: number[] };
    expect(fingerprint).toEqual({ duration: direct.duration, values: direct.fingerprint });
    expect(fingerprint!.values.length).toBeGreaterThanOrEqual(1);
    await expect(
      audioFingerprint(join(fixtures, 'silent.mp4'), { timeout: 30000 })
    ).resolves.toBeNull();
    // A directory path is not decodable media: a per-file error, not a skip.
    await expect(audioFingerprint(fixtures, { timeout: 30000 })).rejects.toThrow(/decode_failed/);
  },
  60000
);
it.skipIf(!hasFpcalc)(
  'scans a mixed directory: audio and soundtracks stored, silent video skipped, toggle gates fpcalc',
  async () => {
    const media = join(root, 'media');
    await mkdir(media);
    for (const name of ['tone.mp3', 'sound.mp4', 'silent.mp4'])
      await copyFile(join(fixtures, name), join(media, name));
    db.prepare('INSERT INTO scan_dirs(path) VALUES (?)').run(media);
    expect((await request('/api/scans', 'POST')).statusCode).toBe(202);
    await waitScan();
    expect((await app.inject({ method: 'POST', url: '/api/scans' })).statusCode).toBe(401);
    const rows = db
      .prepare(
        `SELECT f.rel_path,f.kind,f.status,f.error,f.duration_ms,
      (SELECT count(*) FROM audio_subfingerprints s WHERE s.file_id=f.id) AS subfingerprints
      FROM files f ORDER BY f.rel_path`
      )
      .all() as {
      rel_path: string;
      kind: string;
      status: string;
      error: string | null;
      duration_ms: number | null;
      subfingerprints: number;
    }[];
    expect(rows).toEqual([
      expect.objectContaining({
        rel_path: 'silent.mp4',
        kind: 'video',
        status: 'done',
        error: null,
        subfingerprints: 0,
      }),
      expect.objectContaining({
        rel_path: 'sound.mp4',
        kind: 'video',
        status: 'done',
        error: null,
        duration_ms: expect.any(Number),
        subfingerprints: expect.any(Number),
      }),
      expect.objectContaining({
        rel_path: 'tone.mp3',
        kind: 'audio',
        status: 'done',
        error: null,
        duration_ms: 3000,
        subfingerprints: expect.any(Number),
      }),
    ]);
    expect(rows[1]!.subfingerprints).toBeGreaterThan(0);
    expect(rows[2]!.subfingerprints).toBeGreaterThan(0);
    // Stored subfingerprints equal a direct fpcalc run for the same file.
    const direct = JSON.parse(
      (await exec('fpcalc', ['-raw', '-json', join(media, 'sound.mp4')])).stdout
    ) as { fingerprint: number[] };
    const id = (
      db.prepare('SELECT id FROM files WHERE rel_path=?').get('sound.mp4') as { id: number }
    ).id;
    expect(
      db.prepare('SELECT idx,value FROM audio_subfingerprints WHERE file_id=? ORDER BY idx').all(id)
    ).toEqual(direct.fingerprint.map((value, idx) => ({ idx, value })));
    // Disabling audio matching lets newly discovered audio finish without subfingerprints.
    expect(
      (await request('/api/settings', 'PATCH', { match_audio_enabled: false })).statusCode
    ).toBe(200);
    await copyFile(join(fixtures, 'tone.mp3'), join(media, 'muted.mp3'));
    await request('/api/scans', 'POST');
    await waitScan();
    expect(
      db.prepare('SELECT status,audio_fingerprinted FROM files WHERE rel_path=?').get('muted.mp3')
    ).toEqual({ status: 'done', audio_fingerprinted: 0 });
    expect(subfingerprintsOf('muted.mp3')).toEqual({ n: 0 });
    // Re-enabling backfills the skipped file without touching its stored SHA-256.
    const sha = (
      db.prepare('SELECT sha256 FROM files WHERE rel_path=?').get('muted.mp3') as {
        sha256: string;
      }
    ).sha256;
    expect(
      (await request('/api/settings', 'PATCH', { match_audio_enabled: true })).statusCode
    ).toBe(200);
    await request('/api/scans', 'POST');
    await waitScan();
    expect(
      db.prepare('SELECT sha256,audio_fingerprinted FROM files WHERE rel_path=?').get('muted.mp3')
    ).toEqual({ sha256: sha, audio_fingerprinted: 1 });
    expect(subfingerprintsOf('muted.mp3')!.n).toBeGreaterThan(0);
    // A settled rescan changes nothing: no rows appear or disappear.
    const stored = db.prepare('SELECT * FROM audio_subfingerprints ORDER BY file_id,idx').all();
    await request('/api/scans', 'POST');
    await waitScan();
    expect(db.prepare('SELECT * FROM audio_subfingerprints ORDER BY file_id,idx').all()).toEqual(
      stored
    );
  },
  120000
);

function subfingerprintsOf(relPath: string) {
  return db
    .prepare(
      'SELECT count(*) AS n FROM audio_subfingerprints s JOIN files f ON f.id=s.file_id WHERE f.rel_path=?'
    )
    .get(relPath) as { n: number };
}
