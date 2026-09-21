export const phashesMigration = `
CREATE TABLE phashes (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  frame_idx INTEGER NOT NULL CHECK (frame_idx>=0),
  hash BLOB NOT NULL CHECK (typeof(hash)='blob' AND length(hash)=8),
  PRIMARY KEY (file_id,frame_idx)
);
CREATE TABLE phash_bands (
  band_idx INTEGER NOT NULL CHECK (band_idx BETWEEN 0 AND 3),
  frame_idx INTEGER NOT NULL CHECK (frame_idx>=0),
  band_val INTEGER NOT NULL CHECK (band_val BETWEEN 0 AND 65535),
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (band_idx,frame_idx,band_val,file_id)
);
CREATE INDEX idx_phash_bands_file ON phash_bands(file_id);
`;
