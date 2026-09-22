export const audioPartialMigration = `
ALTER TABLE dup_groups ADD COLUMN subset_file_id INTEGER REFERENCES files(id) ON DELETE CASCADE;
ALTER TABLE dup_groups ADD COLUMN offset_seconds INTEGER;
INSERT OR IGNORE INTO settings(key,value) VALUES
  ('audio_candidate_min_shared','4'),
  ('audio_confidence_threshold','50'),
  ('audio_min_subset_seconds','5');
`;
