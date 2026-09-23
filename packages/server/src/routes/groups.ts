import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type {
  DuplicateGroup,
  GroupKind,
  GroupSort,
  SortDirection,
  GroupListItem,
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
type Query = {
  kind?: GroupKind;
  sort?: GroupSort;
  direction?: SortDirection;
  cursor?: string;
  limit?: string;
};
type Cursor = [number, string, GroupSort, SortDirection, number, number];
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(value: string): Cursor | null {
  try {
    const row: unknown = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (
      Array.isArray(row) &&
      row.length === 6 &&
      ['*', 'exact', 'image', 'video', 'audio_partial'].includes(row[1]) &&
      ['reclaimable_bytes', 'member_count'].includes(row[2]) &&
      ['desc', 'asc'].includes(row[3]) &&
      [0, 4, 5].every((i) => Number.isSafeInteger(row[i]) && row[i] >= 0)
    )
      return row as Cursor;
  } catch {
    /* Invalid cursors are rejected, never interpreted as a first page. */
  }
  return null;
}
export function groupRoutes(app: FastifyInstance, db: Database.Database, matcher: Matcher) {
  app.post('/api/matches/clear', async (_request, reply) => {
    return matcher.clear()
      ? reply.code(204).send()
      : reply.code(409).send({ error: 'match_running' });
  });
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
            sort: { type: 'string', enum: ['reclaimable_bytes', 'member_count'] },
            direction: { type: 'string', enum: ['desc', 'asc'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { kind, cursor, sort = 'reclaimable_bytes', direction = 'desc' } = request.query;
      const limit = Math.min(Number(request.query.limit ?? 50), 500);
      const run = activeMatchRun(db);
      const position = cursor ? decode(cursor) : null;
      if (
        cursor &&
        (!position ||
          position[1] !== (kind ?? '*') ||
          position[2] !== sort ||
          position[3] !== direction)
      )
        return reply.code(400).send({ error: 'invalid_cursor' });
      if (position && position[0] !== run)
        return reply
          .code(409)
          .send({ error: 'stale_cursor', match_run: run } satisfies StaleCursorResponse);
      const column = sort === 'member_count' ? 'member_count' : 'reclaimable_bytes';
      const index = sort === 'member_count' ? 'idx_groups_members' : 'idx_groups_page';
      const descending = direction === 'desc';
      const base = `SELECT ${fields} FROM dup_groups INDEXED BY ${index}_${kind ? 'kind' : 'all'} WHERE match_run=?${kind ? ' AND kind=?' : ''}`;
      const args = kind ? [run, kind] : [run];
      // Separate tied-value and next-value seeks keep both branches index-bounded.
      // Reversing both order terms lets ascending pages use the same index.
      const sql = position
        ? `${base} AND ${column}=? AND id${descending ? '>' : '<'}? UNION ALL ${base} AND ${column}${descending ? '<' : '>'}?`
        : base;
      const values = position ? [...args, position[4], position[5], ...args, position[4]] : args;
      const rows = db
        .prepare(`${sql} ORDER BY ${column} ${descending ? 'DESC,id ASC' : 'ASC,id DESC'} LIMIT ?`)
        .all(...values, limit + 1) as DuplicateGroup[];
      const page = rows.slice(0, limit);
      // Look up only this page, stopping at the first eligible member in file-id order.
      const representatives = page.length
        ? (db
            .prepare(
              `SELECT g.id AS group_id,f.id AS file_id,f.kind FROM dup_groups g
              JOIN files f ON f.id=(
                SELECT m.file_id FROM dup_group_members m JOIN files v ON v.id=m.file_id
                WHERE m.group_id=g.id AND v.status='done' AND v.kind IN ('image','video')
                ORDER BY m.file_id LIMIT 1
              ) WHERE g.id IN (${page.map(() => '?').join(',')})`
            )
            .all(...page.map((group) => group.id)) as {
            group_id: number;
            file_id: number;
            kind: 'image' | 'video';
          }[])
        : [];
      const byGroup = new Map(
        representatives.map(({ group_id, ...representative }) => [group_id, representative])
      );
      const items: GroupListItem[] = page.map((group) => ({
        ...group,
        representative: byGroup.get(group.id) ?? null,
      }));
      const last = items.at(-1);
      return {
        items,
        next_cursor:
          rows.length > limit && last
            ? encode([run, kind ?? '*', sort, direction, last[sort], last.id])
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
