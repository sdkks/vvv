import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type {
  DuplicateGroup,
  GroupKind,
  GroupMember,
  GroupResponse,
  GroupsResponse,
  StartMatchResponse,
  StaleCursorResponse,
} from '@vvv/shared';
import { join } from 'node:path';
import { activeMatchRun, type Matcher } from '../matcher.js';
import { idParams } from './scans.js';

const fields = 'id,kind,member_count,total_bytes,reclaimable_bytes';
const pageProperties = {
  limit: { type: 'string', pattern: '^[1-9][0-9]{0,8}$' },
  cursor: { type: 'string', maxLength: 300 },
};
type Query = { kind?: GroupKind; cursor?: string; limit?: string };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(value: string): [number, string, number, number] | null {
  try {
    const row: unknown = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (
      Array.isArray(row) &&
      row.length === 4 &&
      ['*', 'exact', 'image', 'video', 'audio_partial'].includes(row[1]) &&
      [0, 2, 3].every((i) => Number.isSafeInteger(row[i]) && row[i] >= 0)
    )
      return row as [number, string, number, number];
  } catch {
    /* Invalid cursors are rejected, never interpreted as a first page. */
  }
  return null;
}
export function groupRoutes(app: FastifyInstance, db: Database.Database, matcher: Matcher) {
  app.post('/api/matches/run', async (_request, reply) => {
    const match_run = matcher.start();
    return match_run === null
      ? reply.code(409).send({ error: 'match_running' })
      : reply.code(202).send({ match_run } satisfies StartMatchResponse);
  });
  app.get<{ Querystring: Query }>(
    '/api/groups',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...pageProperties,
            kind: { type: 'string', enum: ['exact', 'image', 'video', 'audio_partial'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { kind, cursor } = request.query;
      const limit = Math.min(Number(request.query.limit ?? 50), 500);
      const run = activeMatchRun(db);
      const position = cursor ? decode(cursor) : null;
      if (cursor && (!position || position[1] !== (kind ?? '*')))
        return reply.code(400).send({ error: 'invalid_cursor' });
      if (position && position[0] !== run)
        return reply
          .code(409)
          .send({ error: 'stale_cursor', match_run: run } satisfies StaleCursorResponse);
      const base = `SELECT ${fields} FROM dup_groups INDEXED BY ${kind ? 'idx_groups_page_kind' : 'idx_groups_page_all'} WHERE match_run=?${kind ? ' AND kind=?' : ''}`;
      const args = kind ? [run, kind] : [run];
      const sql = position
        ? `${base} AND reclaimable_bytes=? AND id>? UNION ALL ${base} AND reclaimable_bytes<?`
        : base;
      const values = position ? [...args, position[2], position[3], ...args, position[2]] : args;
      const rows = db
        .prepare(`${sql} ORDER BY reclaimable_bytes DESC,id LIMIT ?`)
        .all(...values, limit + 1) as DuplicateGroup[];
      const items = rows.slice(0, limit),
        last = items.at(-1);
      return {
        items,
        next_cursor:
          rows.length > limit && last
            ? encode([run, kind ?? '*', last.reclaimable_bytes, last.id])
            : null,
      } satisfies GroupsResponse;
    }
  );
  app.get<{ Params: { id: string }; Querystring: Query }>(
    '/api/groups/:id',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...pageProperties,
            cursor: { type: 'string', pattern: '^([1-9][0-9]{0,14})?$' },
          },
        },
      },
    },
    async (request, reply) => {
      const group = db
        .prepare(
          `SELECT ${fields},subset_file_id,offset_seconds FROM dup_groups WHERE id=? AND match_run=?`
        )
        .get(request.params.id, activeMatchRun(db)) as
        | (DuplicateGroup & {
            subset_file_id: number | null;
            offset_seconds: number | null;
          })
        | undefined;
      if (!group) return reply.code(404).send({ error: 'group_not_found' });
      const { subset_file_id: subsetId, offset_seconds: offset, ...summary } = group;
      const directional = summary.kind === 'audio_partial';
      const limit = Math.min(Number(request.query.limit ?? 100), 500);
      const rows = db
        .prepare(
          `SELECT f.id AS file_id,d.path,f.rel_path,f.size,f.width,f.height,f.duration_ms,m.similarity
      FROM dup_group_members m JOIN files f ON f.id=m.file_id JOIN scan_dirs d ON d.id=f.scan_dir_id
      WHERE m.group_id=? AND m.file_id>? AND f.status='done' ORDER BY m.file_id LIMIT ?`
        )
        .all(group.id, Number(request.query.cursor || 0), limit + 1) as (GroupMember & {
        rel_path: string;
      })[];
      const items = rows.slice(0, limit).map(({ rel_path, ...row }) => ({
        ...row,
        path: join(row.path, rel_path),
        quarantined: false as const,
        ...(directional
          ? {
              role: row.file_id === subsetId ? ('subset' as const) : ('superset' as const),
              offset_seconds: offset,
            }
          : {}),
      }));
      return {
        ...summary,
        members: { items, next_cursor: rows.length > limit ? String(items.at(-1)?.file_id) : null },
      } satisfies GroupResponse;
    }
  );
}
