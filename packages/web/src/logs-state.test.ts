import { describe, expect, it } from 'vitest';
import type { ScanLogEntry } from '@vvv/shared';
import {
  appendLogEntry,
  atTail,
  durationLabel,
  formatDuration,
  logTime,
  logTimeFull,
  logsLevel,
  logsScope,
  logsView,
  parseLogEntry,
} from './logs-state';

const entry = (overrides: Partial<ScanLogEntry> = {}): ScanLogEntry => ({
  id: 1,
  ts: '2026-09-22T12:04:31.000Z',
  scan_id: 1,
  step: 'hash',
  detail: 'Scanned /media/clip.mp4',
  level: 'info',
  ...overrides,
});

describe('parseLogEntry', () => {
  it('accepts a valid entry with and without a duration', () => {
    expect(parseLogEntry(JSON.stringify(entry()))).toEqual(entry());
    expect(parseLogEntry(JSON.stringify(entry({ duration_ms: 142 })))).toEqual(
      entry({ duration_ms: 142 })
    );
  });
  it.each([
    'not json at all',
    '42',
    'null',
    '[]',
    '{"id":1}',
    JSON.stringify({ ...entry(), id: 0 }),
    JSON.stringify({ ...entry(), id: 1.5 }),
    JSON.stringify({ ...entry(), ts: 'not-a-date' }),
    JSON.stringify({ ...entry(), scan_id: -1 }),
    JSON.stringify({ ...entry(), scan_id: 2.5 }),
    JSON.stringify({ ...entry(), step: 'walk' }),
    JSON.stringify({ ...entry(), level: 'verbose' }),
    JSON.stringify({ ...entry(), detail: 42 }),
    JSON.stringify({ ...entry(), duration_ms: -5 }),
    JSON.stringify({ ...entry(), duration_ms: '142' }),
  ])('rejects %j', (text) => expect(parseLogEntry(text)).toBeUndefined());
});

describe('appendLogEntry', () => {
  it('appends in id order and returns the same array for replays at or below the last id', () => {
    const first = entry({ id: 3 });
    const second = entry({ id: 4 });
    const entries = appendLogEntry([first], second);
    expect(appendLogEntry(entries, second)).toBe(entries);
    expect(appendLogEntry(entries, entry({ id: 2 }))).toBe(entries);
  });
  it('trims from the front when the cap is exceeded', () => {
    const capped = [1, 2, 3].map((id) => entry({ id }));
    expect(appendLogEntry(capped, entry({ id: 4 }), 3).map(({ id }) => id)).toEqual([2, 3, 4]);
  });
});

it('treats the viewport as at-tail only within the 24px threshold', () => {
  expect(atTail({ scrollTop: 990, clientHeight: 100, scrollHeight: 1100 })).toBe(true);
  expect(atTail({ scrollTop: 900, clientHeight: 100, scrollHeight: 1100 })).toBe(false);
});

describe('durations', () => {
  it.each([
    [0, '0 ms'],
    [999, '999 ms'],
    [1000, '1.0 s'],
    [59_999, '60.0 s'],
    [60_000, '1 min 0 s'],
    [142_500, '2 min 23 s'],
  ])('formats %i ms as %s', (ms, text) => expect(formatDuration(ms)).toBe(text));
  it.each([
    [142, 'Duration: 142 milliseconds'],
    [1000, 'Duration: 1.0 seconds'],
    [61_000, 'Duration: 1 minutes 1 seconds'],
  ])('labels %i ms accessibly as %s', (ms, text) => expect(durationLabel(ms)).toBe(text));
});

it('falls back to the raw timestamp when it cannot be parsed', () => {
  expect(logTime('not-a-time')).toBe('not-a-time');
  expect(logTimeFull('not-a-time')).toBe('not-a-time');
  const ts = '2026-09-22T12:04:31Z';
  expect(logTime(ts)).not.toContain('2026-09-22');
  expect(logTimeFull(ts)).toContain('2026');
});

describe('logsScope', () => {
  it.each([
    ['7', 7],
    ['0', undefined],
    ['-3', undefined],
    ['2.5', undefined],
    ['abc', undefined],
    ['', undefined],
  ])('parses scan_id %s as %s', (value, expected) =>
    expect(logsScope(new URLSearchParams({ scan_id: value }))).toBe(expected)
  );
  it('is undefined without the parameter', () => {
    expect(logsScope(new URLSearchParams())).toBeUndefined();
  });
});

describe('logsLevel', () => {
  it.each([
    ['warn', 'warn'],
    ['debug', ''],
    [null, ''],
  ])('parses level %s as %s', (value, expected) => {
    const search = value === null ? new URLSearchParams() : new URLSearchParams({ level: value });
    expect(logsLevel(search)).toBe(expected);
  });
});

describe('logsView', () => {
  it('honors an explicit view parameter', () => {
    expect(logsView(new URLSearchParams('view=live'), false)).toBe('live');
    expect(logsView(new URLSearchParams('view=live'), true)).toBe('live');
    expect(logsView(new URLSearchParams('view=history'), false)).toBe('history');
  });
  it('defaults unscoped pages to history and a scoped running scan to live', () => {
    expect(logsView(new URLSearchParams(), true)).toBe('live');
    expect(logsView(new URLSearchParams(), false)).toBe('history');
  });
  it('keeps history selectable while scoped to a running scan', () => {
    expect(logsView(new URLSearchParams('view=history'), true)).toBe('history');
  });
});
