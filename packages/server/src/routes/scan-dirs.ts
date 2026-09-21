import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type {
  CreateScanDirRequest,
  ScanDir,
  ScanDirsResponse,
  UpdateScanDirRequest,
} from '@vvv/shared';
import { idParams } from './scans.js';
import { deleteScanDir } from '../matcher.js';

const options = { follow_symlinks: { type: 'boolean' }, cross_filesystems: { type: 'boolean' } };
type DirectoryRow = Omit<ScanDir, 'follow_symlinks' | 'cross_filesystems'> & {
  follow_symlinks: number;
  cross_filesystems: number;
};
const directory = (row: DirectoryRow): ScanDir => ({
  ...row,
  follow_symlinks: Boolean(row.follow_symlinks),
  cross_filesystems: Boolean(row.cross_filesystems),
});

export function scanDirRoutes(app: FastifyInstance, db: Database.Database) {
  const select = `SELECT id,path,follow_symlinks,cross_filesystems,
    (SELECT count(*) FROM files f WHERE f.scan_dir_id=d.id) AS file_count FROM scan_dirs d`;
  const get = (id: number | string) =>
    db.prepare(`${select} WHERE id=?`).get(id) as DirectoryRow | undefined;
  app.get('/api/scan-dirs', async (): Promise<ScanDirsResponse> => ({
    items: (db.prepare(`${select} ORDER BY id`).all() as DirectoryRow[]).map(directory),
  }));
  app.post<{ Body: CreateScanDirRequest }>(
    '/api/scan-dirs',
    {
      schema: {
        body: {
          type: 'object',
          required: ['path'],
          additionalProperties: false,
          properties: { path: { type: 'string', minLength: 1, pattern: '\\S' }, ...options },
        },
      },
    },
    async (request, reply) => {
      const path = resolve(request.body.path);
      try {
        if (!(await stat(path)).isDirectory())
          return reply.code(400).send({ error: 'not_a_directory' });
      } catch {
        return reply.code(400).send({ error: 'invalid_directory' });
      }
      if (db.prepare('SELECT id FROM scan_dirs WHERE path=?').get(path))
        return reply.code(409).send({ error: 'directory_registered' });
      const id = Number(
        db
          .prepare('INSERT INTO scan_dirs(path,follow_symlinks,cross_filesystems) VALUES (?,?,?)')
          .run(
            path,
            Number(request.body.follow_symlinks ?? false),
            Number(request.body.cross_filesystems ?? false)
          ).lastInsertRowid
      );
      return reply.code(201).send({
        id,
        path,
        follow_symlinks: request.body.follow_symlinks ?? false,
        cross_filesystems: request.body.cross_filesystems ?? false,
        file_count: 0,
      } satisfies ScanDir);
    }
  );
  app.patch<{ Params: { id: string }; Body: UpdateScanDirRequest }>(
    '/api/scan-dirs/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: options,
        },
      },
    },
    async (request, reply) => {
      const row = get(request.params.id);
      if (!row) return reply.code(404).send({ error: 'directory_not_found' });
      db.prepare('UPDATE scan_dirs SET follow_symlinks=?,cross_filesystems=? WHERE id=?').run(
        Number(request.body.follow_symlinks ?? row.follow_symlinks),
        Number(request.body.cross_filesystems ?? row.cross_filesystems),
        row.id
      );
      return { ...directory(row), ...request.body } satisfies ScanDir;
    }
  );
  app.delete<{ Params: { id: string } }>(
    '/api/scan-dirs/:id',
    { schema: { params: idParams } },
    async (request, reply) => {
      const deleted = deleteScanDir(db, Number(request.params.id));
      if (deleted === null) return reply.code(409).send({ error: 'operations_in_progress' });
      if (!deleted) return reply.code(404).send({ error: 'directory_not_found' });
      return reply.code(204).send();
    }
  );
}
