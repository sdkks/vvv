import Database from 'better-sqlite3';
import { join } from 'node:path';

const migrations = ['CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'];
export function openDatabase(dataDir: string) {
  const path = join(dataDir, 'vvv.db');
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    const version = Number(db.pragma('user_version', { simple: true }));
    if (version > migrations.length) throw new Error('Database is newer than this server.');
    migrations.slice(version).forEach((sql, index) =>
      db.transaction(() => {
        db.exec(sql);
        db.pragma(`user_version = ${version + index + 1}`);
      })()
    );
  } catch (error) {
    db.close();
    throw error;
  }
  return { db, openReadOnly: () => new Database(path, { readonly: true, fileMustExist: true }) };
}
