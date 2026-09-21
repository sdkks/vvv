import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { join } from 'node:path';
import type {
  CurrentScanResponse,
  ScanError,
  ScanErrorsResponse,
  ScanProgress,
  StartScanResponse,
} from '@vvv/shared';
import type { Scanner } from '../scanner.js';
import type { Progress } from '../progress.js';

export const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^[1-9][0-9]{0,14}$' } },
  additionalProperties: false,
};

export function scanRoutes(
  app: FastifyInstance,
  db: Database.Database,
  scanner: Scanner,
  progress: Progress
) {
  app.post('/api/scans', async (_request, reply) => {
    const id = scanner.start();
    if (id === null) return reply.code(409).send({ error: 'scan_running' });
    return reply.code(202).send({ id } satisfies StartScanResponse);
  });
  app.get('/api/scans/current', async (): Promise<CurrentScanResponse> => scanner.current());
  app.post<{ Params: { id: string } }>(
    '/api/scans/:id/cancel',
    {
      schema: { params: idParams },
    },
    async (request, reply) => {
      if (!db.prepare('SELECT id FROM scans WHERE id=?').get(request.params.id))
        return reply.code(404).send({ error: 'scan_not_found' });
      scanner.cancel(Number(request.params.id));
      return reply.code(202).send();
    }
  );
  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/api/scans/:id/errors',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cursor: { type: 'string', pattern: '^([1-9][0-9]{0,14})?$' },
            limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!db.prepare('SELECT id FROM scans WHERE id=?').get(request.params.id))
        return reply.code(404).send({ error: 'scan_not_found' });
      const limit = Math.min(Number(request.query.limit ?? 100), 500);
      const rows = db
        .prepare(
          `SELECT f.id AS file_id,d.path,f.rel_path,f.error FROM files f
        JOIN scan_dirs d ON d.id=f.scan_dir_id WHERE f.last_seen_scan_id=? AND f.status='error'
        AND f.id>? ORDER BY f.id LIMIT ?`
        )
        .all(request.params.id, Number(request.query.cursor || 0), limit + 1) as (ScanError & {
        rel_path: string;
      })[];
      const items = rows.slice(0, limit).map(({ file_id, path, rel_path, error }) => ({
        file_id,
        path: join(path, rel_path),
        error,
      }));
      return {
        items,
        next_cursor: rows.length > limit ? String(items.at(-1)?.file_id) : null,
      } satisfies ScanErrorsResponse;
    }
  );
  app.get<{ Params: { id: string } }>(
    '/api/scans/:id/events',
    { schema: { params: idParams } },
    async (request, reply) => {
      const id = Number(request.params.id);
      const current = scanner.current();
      const snapshot =
        current?.id === id
          ? current
          : (db
              .prepare('SELECT id,status,discovered,processed,errors FROM scans WHERE id=?')
              .get(id) as ScanProgress | undefined);
      if (!snapshot) return reply.code(404).send({ error: 'scan_not_found' });
      reply.hijack();
      progress.connect(reply.raw, snapshot);
    }
  );
}
