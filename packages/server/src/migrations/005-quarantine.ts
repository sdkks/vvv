export const quarantineMigration = `
CREATE TABLE trash (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  scan_dir_id INTEGER NOT NULL REFERENCES scan_dirs(id) ON DELETE CASCADE,
  original_rel_path TEXT NOT NULL,
  trash_rel_path TEXT NOT NULL,
  quarantined_at TEXT NOT NULL DEFAULT (datetime('now')),
  restored INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_trash_pending ON trash(restored, quarantined_at);
CREATE TABLE file_operations (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  file_id INTEGER,
  src_path TEXT NOT NULL,
  dst_path TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_file_ops_open ON file_operations(status) WHERE status != 'committed';
INSERT INTO settings(key,value) VALUES ('retention_days','30'),('auto_purge_enabled','0');
`;
