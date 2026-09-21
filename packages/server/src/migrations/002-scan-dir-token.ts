export const scanDirTokenMigration = `
ALTER TABLE scan_dirs ADD COLUMN token TEXT;
UPDATE scan_dirs SET token=lower(hex(randomblob(16))) WHERE token IS NULL;
CREATE TRIGGER scan_dirs_set_token AFTER INSERT ON scan_dirs
FOR EACH ROW WHEN NEW.token IS NULL OR NEW.token = ''
BEGIN
  UPDATE scan_dirs SET token=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
`;
