export const audioFingerprintsMigration = `
ALTER TABLE files ADD COLUMN audio_fingerprinted
  INTEGER NOT NULL DEFAULT 0 CHECK (audio_fingerprinted IN (0,1));
CREATE TABLE audio_subfingerprints (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL CHECK (idx>=0),
  value INTEGER NOT NULL CHECK (value BETWEEN 0 AND 4294967295),
  PRIMARY KEY (file_id,idx)
);
CREATE INDEX idx_audio_subfingerprints_value ON audio_subfingerprints(value);
`;
