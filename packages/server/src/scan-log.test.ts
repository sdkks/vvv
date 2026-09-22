import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { ScanLogEntry } from '@vvv/shared';
import { ScanLog } from './scan-log.js';

type FakeResponse = ServerResponse & { frames: string[] };

/** Minimal response double: enough surface for the SSE connect contract, no sockets. */
const response = (): FakeResponse => {
  const listeners = new Map<string, (() => void)[]>();
  const frames: string[] = [];
  return {
    frames,
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((data: string) => {
      frames.push(data);
      return true;
    }),
    destroy: vi.fn(),
    once: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    off: vi.fn((event: string, listener: () => void) => {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((kept) => kept !== listener)
      );
    }),
  } as unknown as FakeResponse;
};

const payload = (frame: string) => JSON.parse(frame.split('\ndata: ')[1]!) as ScanLogEntry;

describe('ScanLog ring bounds', () => {
  it('shifts the oldest entry out beyond 500 entries per scan', () => {
    const logs = new ScanLog();
    for (let i = 0; i < 501; i++) logs.add(1, 'info', 'scan', `entry ${i}`);
    const page = logs.history({ scanId: 1, limit: 500 });
    expect(page.items).toHaveLength(500);
    expect(page.items[0]?.detail).toBe('entry 500');
    expect(page.items.at(-1)?.detail).toBe('entry 1');
    expect(page.next_cursor).toBeNull();
    logs.close();
  });

  it('retains only the newest 20 scans, evicting the oldest first', () => {
    const logs = new ScanLog();
    for (let scan = 1; scan <= 21; scan++) logs.add(scan, 'info', 'scan', `scan ${scan}`);
    expect(logs.history({ scanId: 1, limit: 10 }).items).toEqual([]);
    expect(logs.history({ scanId: 2, limit: 10 }).items[0]?.detail).toBe('scan 2');
    expect(logs.history({ scanId: 21, limit: 10 }).items[0]?.detail).toBe('scan 21');
    expect(logs.history({ limit: 1000 }).items).toHaveLength(20);
    logs.close();
  });

  it('never evicts the ring currently being written, however old it is', () => {
    const logs = new ScanLog();
    for (let scan = 1; scan <= 20; scan++) logs.add(scan, 'info', 'scan', `scan ${scan}`);
    logs.add(1, 'info', 'traversal', 'revisit oldest');
    logs.add(1, 'info', 'traversal', 'revisit oldest again');
    expect(logs.history({ scanId: 1, limit: 10 }).items).toHaveLength(3);
    expect(logs.history({ limit: 1000 }).items).toHaveLength(22);
    logs.close();
  });

  it('assigns monotonic ids across interleaved scans', () => {
    const logs = new ScanLog();
    const first = logs.add(1, 'info', 'scan', 'a1');
    const second = logs.add(2, 'info', 'scan', 'b1');
    const third = logs.add(1, 'info', 'traversal', 'a2');
    expect([first.id, second.id, third.id]).toEqual([1, 2, 3]);
    logs.close();
  });
});

describe('ScanLog live stream', () => {
  it('replays retained entries after headers, filtered by Last-Event-ID, then streams new ones', () => {
    const logs = new ScanLog();
    const first = logs.add(1, 'info', 'scan', 'first');
    logs.add(1, 'info', 'traversal', 'second');
    logs.add(2, 'info', 'scan', 'other scan');

    const fresh = response();
    logs.connect(fresh, 1);
    expect(fresh.frames).toHaveLength(2);
    expect(payload(fresh.frames[0]!).detail).toBe('first');

    const resumed = response();
    logs.connect(resumed, 1, first.id);
    expect(resumed.frames).toHaveLength(1);
    expect(payload(resumed.frames[0]!).detail).toBe('second');

    logs.add(1, 'info', 'complete', 'done', 40);
    expect(fresh.frames).toHaveLength(3);
    expect(payload(fresh.frames[2]!).detail).toBe('done');
    expect(resumed.frames).toHaveLength(2);
    expect(payload(resumed.frames[1]!).scan_id).toBe(1);
    logs.close();
  });
});
