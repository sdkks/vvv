export const sizeFiltersMigration = `
  INSERT OR IGNORE INTO settings(key,value) VALUES
    ('min_file_size_mb','0'),('max_file_size_mb','0');
`;
