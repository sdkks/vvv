import { describe, expect, it } from 'vitest';
import type { ScanProgress } from '@vvv/shared';
import { elapsedScan, mergeScan, parseProgress, scanLabels, scanState } from './scan-state';
import { previousCursor, visitCursor } from './group-review';

const running: ScanProgress = {
  id: 1,
  status: 'running',
  started_at: '2026-09-21 12:00:00',
  finished_at: null,
  discovered: 20,
  processed: 5,
  errors: 1,
  current_file: '/media/movie.mp4',
};
describe('scan states and persisted elapsed time', () => {
  it('maps all five states without treating cancellation or interruption as success', () => {
    expect(scanState(null)).toBe('idle');
    expect(scanState(undefined)).toBe('idle');
    expect(scanLabels.idle).toBe('Ready to scan');
    for (const status of ['running', 'interrupted', 'cancelled', 'done'] as const) {
      expect(scanState({ ...running, status })).toBe(status);
      expect(scanLabels[status]).toBeTruthy();
    }
  });
  it('uses persisted UTC time across reloads instead of the time the page opened', () => {
    const opened = Date.parse('2026-09-21T13:02:03Z');
    expect(elapsedScan(running, opened)).toBe('1:02:03');
    const reloaded: ScanProgress = JSON.parse(JSON.stringify(running));
    expect(elapsedScan(reloaded, opened + 65_000)).toBe('1:03:08');
    expect(elapsedScan({ ...running, started_at: '2026-09-21T14:00:00+02:00' }, opened)).toBe(
      '1:02:03'
    );
    expect(elapsedScan(running, opened + 25 * 3600_000)).toBe('26:02:03');
  });
  it.each(['done', 'cancelled', 'interrupted'] as const)(
    'freezes %s at persisted finish time',
    (status) => {
      const stopped = { ...running, status, finished_at: '2026-09-21 12:00:45' };
      expect(elapsedScan(stopped, Date.parse('2027-01-01T00:00:00Z'))).toBe('0:00:45');
      expect(elapsedScan({ ...stopped, finished_at: null }, Date.now())).toBe('Unavailable');
    }
  );
  it('does not display negative or invalid durations', () => {
    expect(elapsedScan(running, 0)).toBe('0:00:00');
    expect(elapsedScan({ ...running, started_at: 'bad' }, Date.now())).toBe('Unavailable');
  });
});
describe('snapshot resync and SSE merge', () => {
  it('accepts initial snapshots and a new scan, but ignores old streams and stale GETs', () => {
    expect(mergeScan(undefined, null)).toBeNull();
    expect(mergeScan(null, running)).toBe(running);
    const newer = { ...running, id: 2, discovered: 0, processed: 0, errors: 0 };
    expect(mergeScan(running, newer)).toBe(newer);
    expect(mergeScan(newer, running)).toBe(newer);
    expect(mergeScan(newer, null)).toBe(newer);
    for (const field of ['discovered', 'processed', 'errors'] as const) {
      expect(mergeScan(running, { ...running, [field]: running[field] - 1 })).toBe(running);
    }
  });
  it('accepts terminal resync after restart, prevents reopening it, and clears old current_file', () => {
    const saved = { ...running };
    delete saved.current_file;
    const interrupted: ScanProgress = {
      ...saved,
      status: 'interrupted',
      finished_at: '2026-09-21 12:00:45',
    };
    expect(mergeScan(running, interrupted)).toBe(interrupted);
    expect(mergeScan(interrupted, running)).toBe(interrupted);
    expect(mergeScan(running, { ...saved, processed: 6 })).not.toHaveProperty('current_file');
  });
  it('validates SSE JSON before it enters the typed cache', () => {
    expect(parseProgress(JSON.stringify(running))).toEqual(running);
    for (const payload of [
      null,
      [],
      {},
      { ...running, status: 'unknown' },
      { ...running, status: ['running'] },
      { ...running, id: 0 },
      { ...running, errors: -1 },
      { ...running, processed: '7' },
      { ...running, discovered: 1.5 },
      { ...running, started_at: undefined },
      { ...running, finished_at: 17 },
      { ...running, current_file: {} },
    ]) {
      expect(parseProgress(JSON.stringify(payload))).toBeUndefined();
    }
    expect(parseProgress('not JSON')).toBeUndefined();
  });
});
it('keeps opaque error cursors in a previous-page stack, with fresh history for a new scan', () => {
  let history = [''];
  expect(previousCursor(history, '')).toBeUndefined();
  history = visitCursor(history, '', 'opaque/a+');
  history = visitCursor(history, 'opaque/a+', 'opaque/b=');
  expect(previousCursor(history, 'opaque/b=')).toBe('opaque/a+');
  history = visitCursor(history, 'opaque/b=', 'opaque/a+');
  expect(history).toEqual(['', 'opaque/a+']);
  expect(visitCursor(history, 'opaque/a+', '')).toEqual(['']);
});
