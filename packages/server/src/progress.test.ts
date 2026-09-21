import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ScanProgress } from '@vvv/shared';
import { Progress } from './progress.js';

let progress: Progress;
const snapshot = (processed = 0, id = 1): ScanProgress => ({
  id,
  status: 'running',
  started_at: '2026-09-21 12:00:00',
  discovered: 1000,
  processed,
  errors: 0,
});
function response() {
  const raw = new ServerResponse(new IncomingMessage(new Socket()));
  vi.spyOn(raw, 'writeHead').mockReturnValue(raw);
  vi.spyOn(raw, 'flushHeaders').mockImplementation(() => undefined);
  vi.spyOn(raw, 'write').mockReturnValue(true);
  vi.spyOn(raw, 'destroy').mockImplementation(() => {
    raw.emit('close');
    return raw;
  });
  return raw;
}
beforeEach(() => {
  vi.useFakeTimers();
  progress = new Progress();
});
afterEach(() => {
  progress.close();
  vi.useRealTimers();
});

it('coalesces bursts into the latest snapshot, at most once per 250ms, including terminal state', () => {
  const raw = response();
  progress.connect(raw, snapshot());
  for (let i = 1; i <= 100; i++) progress.publish(snapshot(i));
  vi.advanceTimersByTime(249);
  expect(raw.write).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(raw.write).toHaveBeenCalledExactlyOnceWith(
    `event: progress\ndata: ${JSON.stringify(snapshot(100))}\n\n`
  );
  progress.publish(snapshot(101));
  vi.advanceTimersByTime(100);
  progress.publish({ ...snapshot(200), status: 'done' });
  vi.advanceTimersByTime(149);
  expect(raw.write).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(raw.write).toHaveBeenCalledTimes(2);
  expect(progress.history.at(-1)).toEqual({
    event: 'progress',
    data: { ...snapshot(200), status: 'done' },
  });
});

it('bounds history to the latest 500 events and sends only a fresh snapshot on a new connection', () => {
  for (let i = 0; i <= 500; i++) {
    progress.publish(snapshot(i));
    vi.advanceTimersByTime(250);
  }
  expect(progress.history).toHaveLength(500);
  expect(progress.history[0]?.data.processed).toBe(1);
  expect(progress.history.at(-1)?.data.processed).toBe(500);
  expect(vi.getTimerCount()).toBe(0);
  const raw = response();
  progress.connect(raw, { ...snapshot(501), status: 'done' });
  vi.advanceTimersByTime(250);
  expect(raw.write).toHaveBeenCalledTimes(1);
  expect(raw.write).toHaveBeenLastCalledWith(expect.stringContaining('"processed":501'));
});

it('filters events by scan, heartbeats every 15s, and removes listeners/timers on disconnect', () => {
  const one = response();
  const two = response();
  progress.connect(one, snapshot());
  progress.connect(two, snapshot(0, 2));
  vi.advanceTimersByTime(250);
  expect(one.write).toHaveBeenCalledTimes(1);
  expect(two.write).toHaveBeenCalledTimes(1);
  expect(two.write).toHaveBeenCalledWith(expect.stringContaining('"id":2'));
  vi.advanceTimersByTime(14749);
  expect(one.write).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(one.write).toHaveBeenLastCalledWith(': ping\n\n');
  vi.advanceTimersByTime(15000);
  expect(one.write).toHaveBeenCalledTimes(3);
  one.emit('close');
  expect(one.listenerCount('close')).toBe(0);
  expect(one.listenerCount('error')).toBe(0);
  expect(vi.getTimerCount()).toBe(1);
  progress.publish(snapshot(1));
  vi.advanceTimersByTime(15000);
  expect(one.write).toHaveBeenCalledTimes(3);
  expect(two.write).toHaveBeenCalledTimes(4);
  two.emit('error', new Error('disconnected'));
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['progress', 'heartbeat'])(
  'disconnects a backpressured %s stream rather than buffering',
  (kind) => {
    const raw = response();
    progress.connect(raw, snapshot());
    if (kind === 'heartbeat') vi.advanceTimersByTime(250);
    vi.mocked(raw.write).mockReturnValue(false);
    vi.advanceTimersByTime(kind === 'heartbeat' ? 14750 : 250);
    expect(raw.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const calls = vi.mocked(raw.write).mock.calls.length;
    progress.publish(snapshot(500));
    vi.advanceTimersByTime(30000);
    expect(raw.write).toHaveBeenCalledTimes(calls);
  }
);

it('shutdown destroys open responses, clears pending work and rejects further connections', () => {
  const one = response();
  const two = response();
  progress.connect(one, snapshot());
  progress.connect(two, snapshot(0, 2));
  progress.close();
  expect(one.destroy).toHaveBeenCalledOnce();
  expect(two.destroy).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(progress.history).toEqual([]);
  const late = response();
  progress.connect(late, snapshot());
  progress.publish(snapshot());
  expect(late.destroy).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
