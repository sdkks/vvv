import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { dHash } from './hashing.js';
import {
  MediaWork,
  parseMetadata,
  probeArgs,
  samplingArgs,
  videoHash,
  videoMetadata,
  videoThumbnail,
} from './video.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const metadata = Buffer.from(
  JSON.stringify({
    streams: [{ width: 320, height: 240, duration: '3' }],
    format: { duration: '2' },
  })
);
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
      child.stderr.write(stderr);
      child.emit('close', code);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
}
afterEach(() => {
  vi.resetAllMocks();
  children.length = 0;
});

it('constructs commands with matching first-stream selection and one full-timeline sampling spawn', async () => {
  const path = '/media/a strange ; name.mp4';
  expect(probeArgs(path)).toEqual([
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,codec_name,duration',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    path,
  ]);
  expect(samplingArgs(path, 9, 2)).toEqual([
    '-v',
    'error',
    '-i',
    path,
    '-map',
    '0:v:0',
    '-vf',
    'fps=9/2,scale=9:8',
    '-frames:v',
    '9',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    '-',
  ]);
  respond([metadata]);
  const pixels = Buffer.from(Array.from({ length: 72 * 9 }, (_, i) => i % 256));
  respond([
    pixels.subarray(0, 17),
    pixels.subarray(17, 115),
    pixels.subarray(115, 145),
    pixels.subarray(145),
  ]);
  const result = await videoHash(path, 9, { timeout: 1000 });
  expect(result).toMatchObject({ width: 320, height: 240, duration_ms: 2000 });
  expect(result.hashes).toEqual(
    Array.from({ length: 9 }, (_, i) => dHash(pixels.subarray(i * 72, (i + 1) * 72)))
  );
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(spawn).toHaveBeenNthCalledWith(2, 'ffmpeg', samplingArgs(path, 9, 2), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
});
it('collects metadata without ever spawning the frame sampler', async () => {
  respond([metadata]);
  expect(await videoMetadata('/media/clip.mp4', { timeout: 1000 })).toEqual({
    width: 320,
    height: 240,
    duration: 2,
    duration_ms: 2000,
  });
  expect(spawn).toHaveBeenCalledExactlyOnceWith('ffprobe', probeArgs('/media/clip.mp4'), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
});
it.each([undefined, 'N/A', 'Infinity', '-2', 0, null, {}, true])(
  'falls back from invalid format duration %j to stream duration',
  (duration) => {
    expect(
      parseMetadata(
        Buffer.from(
          JSON.stringify({
            format: { duration },
            streams: [{ width: 1, height: 1, duration: '3.5' }],
          })
        )
      )
    ).toMatchObject({ duration_ms: 3500 });
  }
);
it('rejects no duration, no stream, malformed metadata, and never starts sampling', async () => {
  respond([Buffer.from('{"streams":[{"width":10,"height":10,"duration":"N/A"}]}')]);
  await expect(videoHash('file', 9, { timeout: 1000 })).rejects.toThrow('no_duration');
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(() => parseMetadata(Buffer.from('{"streams":[]}'))).toThrow('no_video_stream');
  expect(() => parseMetadata(Buffer.from('broken'))).toThrow();
});
it.each([0, 72 * 8, 72 * 9 - 1, 72 * 9 + 1, 72 * 10])(
  'rejects incomplete/excess raw output of %i bytes',
  async (size) => {
    respond([metadata]);
    respond([Buffer.alloc(size)]);
    await expect(videoHash('file', 9, { timeout: 1000 })).rejects.toThrow('incomplete_frames');
  }
);
it('rejects a failed decoder even if it emitted all nine frames', async () => {
  respond([metadata]);
  respond([Buffer.alloc(72 * 9)], 1, 'corrupt input');
  await expect(videoHash('file', 9, { timeout: 1000 })).rejects.toThrow('incomplete_frames');
});
it.each(['timeout', 'cancelled'])(
  'kills a hanging child, waits for close, and clears listeners on %s',
  async (reason) => {
    const controller = new AbortController();
    vi.mocked(spawn).mockImplementationOnce(() => fake() as unknown as ReturnType<typeof spawn>);
    const result = videoHash('file', 9, {
      timeout: reason === 'timeout' ? 10 : 5000,
      signal: controller.signal,
    });
    if (reason === 'cancelled') controller.abort();
    await expect(result).rejects.toThrow(reason);
    expect(children[0]!.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(spawn).toHaveBeenCalledTimes(1);
  }
);
it('kills a sampling child on cancellation after a successful probe', async () => {
  const controller = new AbortController();
  respond([metadata]);
  vi.mocked(spawn).mockImplementationOnce(() => fake() as unknown as ReturnType<typeof spawn>);
  const result = videoHash('file', 9, { timeout: 5000, signal: controller.signal });
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
  controller.abort();
  await expect(result).rejects.toThrow('cancelled');
  expect(children[0]!.kill).not.toHaveBeenCalled();
  expect(children[1]!.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
});

it('propagates spawn and pipe I/O failures', async () => {
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = fake();
    queueMicrotask(() => {
      child.emit('error', new Error('ENOENT ffprobe'));
      child.emit('close', -2);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
  await expect(videoHash('file', 9, { timeout: 1000 })).rejects.toThrow('ENOENT');
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = fake();
    queueMicrotask(() => child.stdout.emit('error', new Error('EIO')));
    return child as unknown as ReturnType<typeof spawn>;
  });
  await expect(videoHash('file', 9, { timeout: 1000 })).rejects.toThrow('EIO');
});
it('seeks to the middle for JPEG thumbnails and separates content rejection from operational failures', async () => {
  respond([Buffer.from('jpeg')]);
  expect(await videoThumbnail('file', 6000, { timeout: 1000 })).toEqual(Buffer.from('jpeg'));
  expect(vi.mocked(spawn).mock.calls[0]![1]).toEqual([
    '-v',
    'error',
    '-ss',
    '3',
    '-i',
    'file',
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-vf',
    'scale=256:256:force_original_aspect_ratio=decrease',
    '-f',
    'image2pipe',
    '-c:v',
    'mjpeg',
    '-',
  ]);
  respond([], 1, 'Invalid data found when processing input');
  await expect(videoThumbnail('file', 6000, { timeout: 1000 })).rejects.toThrow(
    'content_unavailable'
  );
  respond([], 1, 'Input/output error');
  await expect(videoThumbnail('file', 6000, { timeout: 1000 })).rejects.toThrow('decode_failed');
  respond([]);
  await expect(videoThumbnail('file', 6000, { timeout: 1000 })).rejects.toThrow(
    'content_unavailable'
  );
});
it.each(['EIO', 'Cannot allocate memory', 'Resource temporarily unavailable'])(
  'does not disguise decoder I/O/resource failure as missing content: %s',
  async (message) => {
    respond([], 1, message);
    await expect(videoThumbnail('file', 6000, { timeout: 1000 })).rejects.toThrow('decode_failed');
  }
);

it('shares four slots across hashing and thumbnails and rejects queued work after shutdown', async () => {
  const pool = new MediaWork();
  let active = 0,
    peak = 0,
    entered = 0;
  const releases: (() => void)[] = [];
  const work = () =>
    pool.run(async () => {
      entered++;
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
    });
  const tasks = Array.from({ length: 8 }, work);
  expect(entered).toBe(4);
  releases.splice(0).forEach((release) => release());
  await vi.waitFor(() => expect(entered).toBe(8));
  releases.splice(0).forEach((release) => release());
  await Promise.all(tasks);
  expect(peak).toBe(4);
  expect(active).toBe(0);

  peak = 0;
  const secondBatch = Array.from({ length: 8 }, work);
  expect(entered).toBe(12);
  releases.splice(0).forEach((release) => release());
  await vi.waitFor(() => expect(entered).toBe(16));
  releases.splice(0).forEach((release) => release());
  await Promise.all(secondBatch);
  expect(peak).toBe(4);
  expect(active).toBe(0);

  pool.shutdown.abort();
  await expect(work()).rejects.toThrow();
  expect(entered).toBe(16);
});

it.each(['caller', 'shutdown'] as const)(
  'promptly rejects queued work on %s abort without consuming or releasing a slot',
  async (source) => {
    const pool = new MediaWork();
    const caller = new AbortController();
    const reason = new Error(`${source} aborted`);
    const releases: (() => void)[] = [];
    let active = 0,
      peak = 0,
      entered = 0;
    const work = () =>
      pool.run(async () => {
        entered++;
        peak = Math.max(peak, ++active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
      });
    const holders = Array.from({ length: 4 }, work);
    const queuedWork = vi.fn(async () => {});
    let rejection: unknown;
    const queued = pool.run(queuedWork, caller.signal).catch((error: unknown) => {
      rejection = error;
    });

    try {
      (source === 'caller' ? caller : pool.shutdown).abort(reason);
      await vi.waitFor(() => expect(rejection).toBe(reason), { timeout: 200 });
      expect(queuedWork).not.toHaveBeenCalled();
      expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
      expect(getEventListeners(pool.shutdown.signal, 'abort')).toHaveLength(0);
      expect(active).toBe(4);
      if (source === 'caller') {
        // Removing a queued operation must not free one of the occupied slots.
        holders.push(work());
        expect(entered).toBe(4);
      } else {
        expect(caller.signal.aborted).toBe(false);
      }
    } finally {
      releases.splice(0).forEach((release) => release());
      await vi.waitFor(() => expect(active).toBeLessThanOrEqual(1));
      releases.splice(0).forEach((release) => release());
      await Promise.all([...holders, queued]);
    }
    expect(queuedWork).not.toHaveBeenCalled();

    if (source === 'shutdown') {
      await expect(pool.run(queuedWork, caller.signal)).rejects.toBe(reason);
      expect(queuedWork).not.toHaveBeenCalled();
      return;
    }
    const before = entered;
    peak = 0;
    const nextBatch = Array.from({ length: 8 }, work);
    expect(entered).toBe(before + 4);
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(entered).toBe(before + 8));
    releases.splice(0).forEach((release) => release());
    await Promise.all(nextBatch);
    expect(peak).toBe(4);
    expect(active).toBe(0);
  }
);

it('rejects pre-aborted callers before queueing without running work or touching capacity', async () => {
  const pool = new MediaWork();
  const caller = new AbortController();
  const reason = new Error('aborted before submission');
  const releases: (() => void)[] = [];
  const holders = Array.from({ length: 4 }, () =>
    pool.run(() => new Promise<void>((resolve) => releases.push(resolve)))
  );
  caller.abort(reason);
  const queuedWork = vi.fn(async () => {});
  await expect(pool.run(queuedWork, caller.signal)).rejects.toBe(reason);
  expect(queuedWork).not.toHaveBeenCalled();
  expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
  expect(getEventListeners(pool.shutdown.signal, 'abort')).toHaveLength(0);
  const nextWork = vi.fn(async () => {});
  const next = pool.run(nextWork);
  expect(nextWork).not.toHaveBeenCalled();
  releases.shift()!();
  await next;
  expect(nextWork).toHaveBeenCalledOnce();
  releases.splice(0).forEach((release) => release());
  await Promise.all(holders);
});

it('releases a granted slot if cancellation arrives before the waiter resumes', async () => {
  const pool = new MediaWork();
  const caller = new AbortController();
  const reason = new Error('cancelled during handoff');
  const releases: (() => void)[] = [];
  const holders = Array.from({ length: 4 }, () =>
    pool.run(() => new Promise<void>((resolve) => releases.push(resolve)))
  );
  const queuedWork = vi.fn(async () => {});
  const rejected = expect(pool.run(queuedWork, caller.signal)).rejects.toBe(reason);
  try {
    releases.shift()!();
    // The holder hands off its slot, then this abort runs before the waiter resumes.
    queueMicrotask(() => caller.abort(reason));
    await rejected;
    expect(queuedWork).not.toHaveBeenCalled();
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
    expect(getEventListeners(pool.shutdown.signal, 'abort')).toHaveLength(0);
    const nextWork = vi.fn(async () => {});
    const next = pool.run(nextWork);
    expect(nextWork).toHaveBeenCalledOnce();
    await next;
  } finally {
    releases.splice(0).forEach((release) => release());
    await Promise.all(holders);
  }
});
