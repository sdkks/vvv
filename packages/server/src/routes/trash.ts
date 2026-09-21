import { join } from 'node:path';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type {
  QuarantineResponse,
  RestoreResponse,
  PurgeResponse,
  TrashItem,
  Page,
} from '@vvv/shared';
import { Quarantine, retention } from '../quarantine.js';

const ids = {
  type: 'array',
  minItems: 1,
  maxItems: 10000,
  items: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
};
function bulkSchema(field: string, allowExpired = false) {
  return {
    body: {
      type: 'object',
      additionalProperties: false,
      properties: {
        [field]: ids,
        ...(allowExpired ? { expired: { const: true, type: 'boolean' } } : {}),
      },
      oneOf: [{ required: [field] }, ...(allowExpired ? [{ required: ['expired'] }] : [])],
    },
  };
}
export function trashRoutes(app: FastifyInstance, db: Database.Database, quarantine: Quarantine) {
  app.post<{ Body: { file_ids: number[] } }>(
    '/api/files/quarantine',
    { schema: bulkSchema('file_ids') },
    async (request): Promise<QuarantineResponse> => {
      const result: QuarantineResponse = { moved: [], failed: [] };
      for (const file_id of request.body.file_ids) {
        try {
          result.moved.push(await quarantine.change('quarantine', file_id));
        } catch (error) {
          result.failed.push({ file_id, error: String((error as Error).message) });
        }
        await yieldLoop();
      }
      return result;
    }
  );
  for (const kind of ['restore', 'purge'] as const) {
    app.post<{ Body: { trash_ids?: number[]; expired?: boolean } }>(
      `/api/trash/${kind}`,
      { schema: bulkSchema('trash_ids', kind === 'purge') },
      async (request): Promise<RestoreResponse | PurgeResponse> => {
        if (request.body.expired) return quarantine.purgeExpired();
        const restored: { trash_id: number; file_id: number }[] = [];
        const failed: { trash_id: number; error: string }[] = [];
        let purged = 0;
        for (const trash_id of request.body.trash_ids ?? []) {
          try {
            const item = await quarantine.change(kind, trash_id);
            if (kind === 'restore') restored.push(item);
            else purged++;
          } catch (error) {
            failed.push({ trash_id, error: String((error as Error).message) });
          }
          await yieldLoop();
        }
        return kind === 'restore' ? { restored, failed } : { purged, failed };
      }
    );
  }
  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/api/trash',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cursor: { type: 'string', pattern: '^([1-9][0-9]{0,14})?$' },
            limit: { type: 'string', pattern: '^[1-9][0-9]{0,8}$' },
          },
        },
      },
    },
    async (request): Promise<Page<TrashItem>> => {
      const limit = Math.min(Number(request.query.limit ?? 50), 500);
      const policy = retention(db);
      const rows = db
        .prepare(
          `SELECT t.id,t.file_id,t.scan_dir_id,t.original_rel_path,t.trash_rel_path,
      t.quarantined_at,f.size,d.path,CASE WHEN ? THEN datetime(t.quarantined_at,?) ELSE NULL END AS purge_after
      FROM trash t JOIN files f ON f.id=t.file_id JOIN scan_dirs d ON d.id=t.scan_dir_id
      WHERE t.restored=0 AND t.id>? ORDER BY t.id LIMIT ?`
        )
        .all(
          Number(policy.enabled),
          `+${policy.days} days`,
          Number(request.query.cursor || 0),
          limit + 1
        ) as (TrashItem & { original_rel_path: string })[];
      const items = rows.slice(0, limit).map(({ original_rel_path, ...row }) => ({
        ...row,
        path: join(row.path, original_rel_path),
      }));
      return { items, next_cursor: rows.length > limit ? String(items.at(-1)?.id) : null };
    }
  );
}
