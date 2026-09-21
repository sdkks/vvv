import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase } from './db.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'vvv-db-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

it('migrates once, applies writer pragmas and persists settings across reopen', () => {
  const { db } = openDatabase(directory);
  expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  expect(db.pragma('synchronous', { simple: true })).toBe(1);
  expect(db.pragma('user_version', { simple: true })).toBe(1);
  db.prepare('INSERT INTO settings VALUES (?, ?)').run('example', 'durable');
  db.close();
  const reopened = openDatabase(directory).db;
  expect(reopened.prepare('SELECT * FROM settings').get()).toEqual({
    key: 'example',
    value: 'durable',
  });
  reopened.close();
});

it('provides a read-only connection that can iterate while the writer changes data', () => {
  const { db, openReadOnly } = openDatabase(directory);
  db.exec("INSERT INTO settings VALUES ('a', '1'), ('b', '2')");
  const reader = openReadOnly();
  try {
    expect(() => reader.exec("INSERT INTO settings VALUES ('c', '3')")).toThrow(/readonly/);
    const rows = reader.prepare('SELECT * FROM settings ORDER BY key').iterate();
    try {
      expect(rows.next().value).toEqual({ key: 'a', value: '1' });
      db.exec("UPDATE settings SET value = 'updated' WHERE key = 'b'");
      expect(rows.next().value).toEqual({ key: 'b', value: '2' });
    } finally {
      rows.return?.();
    }
    expect(reader.prepare("SELECT value FROM settings WHERE key = 'b'").get()).toEqual({
      value: 'updated',
    });
  } finally {
    reader.close();
    db.close();
  }
});

it('refuses newer schemas without downgrading them', () => {
  const { db } = openDatabase(directory);
  db.pragma('user_version = 100');
  db.close();
  expect(() => openDatabase(directory)).toThrow('Database is newer');
});
