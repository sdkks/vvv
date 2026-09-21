import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from './db.js';
import { scansMigration } from './migrations/001-scans.js';
import { scanDirTokenMigration } from './migrations/002-scan-dir-token.js';

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
  expect(db.pragma('user_version', { simple: true })).toBe(6);
  db.prepare('INSERT INTO settings VALUES (?, ?)').run('example', 'durable');
  db.close();
  const reopened = openDatabase(directory).db;
  expect(reopened.prepare("SELECT * FROM settings WHERE key='example'").get()).toEqual({
    key: 'example',
    value: 'durable',
  });
  reopened.close();
});

it('upgrades the original schema and creates the scan indexes and foreign keys', () => {
  const original = new Database(join(directory, 'vvv.db'));
  original.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('retained', 'yes'); PRAGMA user_version=1`);
  original.close();
  const { db } = openDatabase(directory);
  expect(db.pragma('user_version', { simple: true })).toBe(6);
  expect(db.prepare("SELECT value FROM settings WHERE key='retained'").get()).toEqual({
    value: 'yes',
  });
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_files_%' ORDER BY name"
      )
      .all()
  ).toEqual([
    { name: 'idx_files_exact' },
    { name: 'idx_files_seen' },
    { name: 'idx_files_status' },
  ]);
  expect(db.pragma('index_info(idx_files_exact)')).toMatchObject([
    { name: 'size' },
    { name: 'sha256' },
  ]);
  expect(db.pragma('index_info(idx_files_status)')).toMatchObject([{ name: 'status' }]);
  expect(db.pragma('index_info(idx_files_seen)')).toMatchObject([{ name: 'last_seen_scan_id' }]);
  db.exec(
    "INSERT INTO scan_dirs(path) VALUES ('/fixture'); INSERT INTO scans(status) VALUES ('running')"
  );
  db.prepare(
    'INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,last_seen_scan_id) VALUES (1,?,?,?,?,1)'
  ).run('x.jpg', 'image', 1n, 1750000000000000001n);
  expect(db.prepare('SELECT mtime_ns FROM files').safeIntegers().get()).toEqual({
    mtime_ns: 1750000000000000001n,
  });
  expect(() =>
    db.exec(
      "INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns) VALUES (999,'x.jpg','image',1,1)"
    )
  ).toThrow(/FOREIGN KEY/);
  db.close();
  const reopened = openDatabase(directory).db;
  expect(reopened.pragma('user_version', { simple: true })).toBe(6);
  expect(reopened.prepare('SELECT count(*) AS n FROM files').get()).toEqual({ n: 1 });
  reopened.exec('DELETE FROM scan_dirs WHERE id=1');
  expect(reopened.prepare('SELECT count(*) AS n FROM files').get()).toEqual({ n: 0 });
  reopened.close();
});

it('upgrades an existing scanned catalog and creates match indexes and cascading member keys', () => {
  const original = new Database(join(directory, 'vvv.db'));
  original.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  original.exec(scansMigration);
  original.exec(scanDirTokenMigration);
  original.exec(`INSERT INTO scan_dirs(path) VALUES ('/media');
    INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status,sha256)
    VALUES (1,'retained.jpg','image',10,0,'done','hash'); PRAGMA user_version=3`);
  original.close();
  const { db } = openDatabase(directory);
  expect(db.pragma('user_version', { simple: true })).toBe(6);
  expect(db.prepare('SELECT rel_path,status,sha256 FROM files').get()).toEqual({
    rel_path: 'retained.jpg',
    status: 'done',
    sha256: 'hash',
  });
  for (const [name, columns] of [
    ['idx_groups_page_kind', ['match_run', 'kind', 'reclaimable_bytes', 'id']],
    ['idx_groups_page_all', ['match_run', 'reclaimable_bytes', 'id']],
    ['idx_members_file', ['file_id']],
  ] as const) {
    const index = db.pragma(`index_xinfo(${name})`) as {
      name: string;
      desc: number;
      key: number;
    }[];
    expect(index.filter((row) => row.key).map(({ name, desc }) => [name, desc])).toEqual(
      columns.map((column) => [column, column === 'reclaimable_bytes' ? 1 : 0])
    );
  }
  db.exec(`INSERT INTO match_runs(status) VALUES ('active');
    INSERT INTO dup_groups(kind,member_count,total_bytes,reclaimable_bytes,match_run) VALUES ('exact',2,20,10,1);
    INSERT INTO dup_group_members(group_id,file_id) VALUES (1,1)`);
  expect(() => db.exec('INSERT INTO dup_group_members VALUES (1,99,NULL)')).toThrow(/FOREIGN KEY/);
  db.exec('DELETE FROM scan_dirs WHERE id=1');
  expect(db.prepare('SELECT count(*) AS n FROM dup_group_members').get()).toEqual({ n: 0 });
  expect(db.pragma('foreign_key_check')).toEqual([]);
  db.close();
});

it('provides a read-only connection that can iterate while the writer changes data', () => {
  const { db, openReadOnly } = openDatabase(directory);
  db.exec("INSERT INTO settings VALUES ('a', '1'), ('b', '2')");
  const reader = openReadOnly();
  try {
    expect(() => reader.exec("INSERT INTO settings VALUES ('c', '3')")).toThrow(/readonly/);
    const rows = reader
      .prepare("SELECT * FROM settings WHERE key IN ('a','b') ORDER BY key")
      .iterate();
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
