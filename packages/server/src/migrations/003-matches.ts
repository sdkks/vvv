export const matchesMigration = `
CREATE TABLE match_runs (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  candidate_pairs INTEGER NOT NULL DEFAULT 0,
  skipped_buckets TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE dup_groups (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  member_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  reclaimable_bytes INTEGER NOT NULL,
  match_run INTEGER NOT NULL REFERENCES match_runs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_groups_page_kind ON dup_groups(match_run,kind,reclaimable_bytes DESC,id);
CREATE INDEX idx_groups_page_all ON dup_groups(match_run,reclaimable_bytes DESC,id);
CREATE TABLE dup_group_members (
  group_id INTEGER NOT NULL REFERENCES dup_groups(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  similarity REAL,
  PRIMARY KEY (group_id,file_id)
);
CREATE INDEX idx_members_file ON dup_group_members(file_id);
`;
