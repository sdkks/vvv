import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { CurrentScanResponse, StartScanResponse } from '@vvv/shared';
import type { Scanner } from '../scanner.js';

export function scanRoutes(app: FastifyInstance, db: Database.Database, scanner: Scanner) {
  app.post('/api/scans', async (_request, reply) => {
    const id = scanner.start();
    if (id === null) return reply.code(409).send({ error: 'scan_running' });
    return reply.code(202).send({ id } satisfies StartScanResponse);
  });
  app.get('/api/scans/current', async (): Promise<CurrentScanResponse> => scanner.current());
  app.post<{ Params: { id: string } }>(
    '/api/scans/:id/cancel',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', pattern: '^[1-9][0-9]{0,14}$' } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!db.prepare('SELECT id FROM scans WHERE id=?').get(request.params.id))
        return reply.code(404).send({ error: 'scan_not_found' });
      scanner.cancel(Number(request.params.id));
      return reply.code(202).send();
    }
  );
}
