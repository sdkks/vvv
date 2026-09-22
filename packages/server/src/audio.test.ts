import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import {
  audioFingerprint,
  fingerprintArgs,
  parseFingerprint,
  storeSubfingerprints,
} from './audio.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const children: (EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn<(signal: string) => boolean>>;
})[] = [];
function fake() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((signal: string) => {
      if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null));
      return true;
    }),
  });
  children.push(child);
  return child;
}
function respond(chunks: Buffer[], code = 0, stderr = '') {
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = fake();
    queueMicrotask(() => {
      chunks.forEach((chunk) => child.stdout.write(chunk));
      if (stderr) child.stderr.write(stderr);
      child.emit('close', code);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
}
afterEach(() => {
  vi.resetAllMocks();
  children.length = 0;
});

it('builds the raw JSON fpcalc invocation', () => {
  expect(fingerprintArgs('/media/a song ; name.mp3')).toEqual([
    '-raw',
    '-json',
    '/media/a song ; name.mp3',
  ]);
});
it('parses durations and unsigned 32-bit subfingerprints', () => {
  const values = [2379616020, 2230715924, 4294967295, 0];
  expect(
    parseFingerprint(Buffer.from(JSON.stringify({ duration: 60.0, fingerprint: values })))
  ).toEqual({ duration: 60, values });
  expect(() => parseFingerprint(Buffer.from('broken'))).toThrow();
  for (const duration of [undefined, 0, -1, '60', null, NaN]) {
    expect(() =>
      parseFingerprint(Buffer.from(JSON.stringify({ duration, fingerprint: [1] })))
    ).toThrow('no_duration');
  }
  for (const fingerprint of [undefined, [], [1.5], [-1], [4294967296], ['7'], null, {}]) {
    expect(() =>
      parseFingerprint(Buffer.from(JSON.stringify({ duration: 3, fingerprint })))
    ).toThrow('incomplete_frames');
  }
});
it('spawns fpcalc once with raw JSON arguments and collects the fingerprint', async () => {
  const values = [10, 20, 30];
  respond([Buffer.from('{"duration": '), Buffer.from('3.00, "fingerprint": [10,20,30]}')]);
  expect(await audioFingerprint('/media/song.mp3', { timeout: 1000 })).toEqual({
    duration: 3,
    values,
  });
  expect(spawn).toHaveBeenCalledExactlyOnceWith('fpcalc', fingerprintArgs('/media/song.mp3'), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
});
it('treats a missing audio stream as a clean skip without throwing', async () => {
  const stderr = 'ERROR: Could not find any audio stream in the file (Stream not found)';
  respond([], 2, stderr);
  respond([], 2, stderr);
  expect(await audioFingerprint('silent.mp4', { timeout: 1000 })).toBeNull();
  expect(await audioFingerprint('song.mp3', { timeout: 1000 })).toBeNull();
});
it.each([
  ['decode_failed', 1, 'ERROR: Empty fingerprint'],
  ['decode_failed', 2, 'ERROR: Could not open the input file (No such file or directory)'],
])('propagates other fpcalc failures as %s', async (code, exit, stderr) => {
  respond([], exit, stderr);
  await expect(audioFingerprint('bad.mp3', { timeout: 1000 })).rejects.toThrow(code);
});
it('rejects truncated JSON output as incomplete', async () => {
  respond([Buffer.from('{"duration": 3.00, "fingerpr')]);
  await expect(audioFingerprint('song.mp3', { timeout: 1000 })).rejects.toThrow();
});
it.each(['timeout', 'cancelled'])('kills a hanging fpcalc on %s', async (reason) => {
  const controller = new AbortController();
  vi.mocked(spawn).mockImplementationOnce(() => fake() as unknown as ReturnType<typeof spawn>);
  const result = audioFingerprint('song.mp3', {
    timeout: reason === 'timeout' ? 10 : 5000,
    signal: controller.signal,
  });
  if (reason === 'cancelled') controller.abort();
  await expect(result).rejects.toThrow(reason);
  expect(children[0]!.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
});
it('propagates a missing fpcalc binary', async () => {
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = fake();
    queueMicrotask(() => {
      child.emit('error', new Error('spawn fpcalc ENOENT'));
      child.emit('close', -2);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
  await expect(audioFingerprint('song.mp3', { timeout: 1000 })).rejects.toThrow('ENOENT');
});
it('stores replace-per-file subfingerprints with positions and cascading deletes', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE files (id INTEGER PRIMARY KEY);
    CREATE TABLE audio_subfingerprints (
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL CHECK (idx>=0),
      value INTEGER NOT NULL CHECK (value BETWEEN 0 AND 4294967295),
      PRIMARY KEY (file_id,idx)
    );`);
  db.exec('INSERT INTO files VALUES (1),(2)');
  storeSubfingerprints(db, 1, [4294967295, 0, 7]);
  expect(
    db.prepare('SELECT idx,value FROM audio_subfingerprints WHERE file_id=1 ORDER BY idx').all()
  ).toEqual([
    { idx: 0, value: 4294967295 },
    { idx: 1, value: 0 },
    { idx: 2, value: 7 },
  ]);
  storeSubfingerprints(db, 1, [9]);
  expect(db.prepare('SELECT count(*) AS n FROM audio_subfingerprints').get()).toEqual({ n: 1 });
  storeSubfingerprints(db, 1, []);
  expect(db.prepare('SELECT count(*) AS n FROM audio_subfingerprints').get()).toEqual({ n: 0 });
  storeSubfingerprints(db, 1, [5]);
  expect(() => storeSubfingerprints(db, 1, [-1])).toThrow(/CHECK/);
  expect(() => storeSubfingerprints(db, 99, [5])).toThrow(/FOREIGN KEY/);
  db.exec('DELETE FROM files WHERE id=1');
  expect(db.prepare('SELECT count(*) AS n FROM audio_subfingerprints').get()).toEqual({ n: 0 });
  db.close();
});
