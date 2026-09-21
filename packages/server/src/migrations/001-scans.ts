export const scansMigration = `
CREATE TABLE scan_dirs (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  follow_symlinks INTEGER NOT NULL DEFAULT 0,
  cross_filesystems INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE scans (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  discovered INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  scan_dir_id INTEGER NOT NULL REFERENCES scan_dirs(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  sha256 TEXT,
  width INTEGER, height INTEGER,
  duration_ms INTEGER,
  error TEXT,
  last_seen_scan_id INTEGER REFERENCES scans(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (scan_dir_id, rel_path)
);
CREATE INDEX idx_files_status ON files(status);
CREATE INDEX idx_files_exact ON files(size, sha256);
CREATE INDEX idx_files_seen ON files(last_seen_scan_id);
`;
