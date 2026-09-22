import { opendir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { BrowseResponse } from '@vvv/shared';

type Query = { path?: string; cursor?: string; limit?: string };
const isDirectory = (path: string) =>
  stat(path).then(
    (info) => info.isDirectory(),
    () => false
  );

export function browseRoutes(app: FastifyInstance, db: Database.Database) {
  app.get<{ Querystring: Query }>(
    '/api/browse',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', maxLength: 4096 },
            cursor: { type: 'string', maxLength: 8192 },
            limit: { type: 'string', pattern: '^[1-9][0-9]{0,5}$' },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const query = request.query;
      const first = db.prepare('SELECT path FROM scan_dirs ORDER BY id LIMIT 1').get() as
        { path: string } | undefined;
      const input = query.path ?? first?.path ?? ((await isDirectory('/media')) ? '/media' : '/');
      if (!isAbsolute(input) || input.includes('\0'))
        return reply.code(400).send({ error: 'invalid_browse_path' });
      const path = resolve(input);
      let after = '';
      if (query.cursor) {
        try {
          const value: unknown = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
          if (
            !Array.isArray(value) ||
            value.length !== 2 ||
            value[0] !== path ||
            typeof value[1] !== 'string' ||
            !value[1] ||
            /[/\0]/.test(value[1])
          )
            throw new Error('Invalid cursor');
          after = value[1];
        } catch {
          return reply.code(400).send({ error: 'invalid_browse_cursor' });
        }
      }
      const limit = Math.min(Number(query.limit ?? 100), 100);
      const items: BrowseResponse['items'] = [];
      try {
        // Keep the smallest limit+1 names, not a whole directory or a recursive listing.
        for await (const entry of await opendir(path)) {
          if (entry.name <= after) continue;
          const child = join(path, entry.name);
          if (!entry.isDirectory() && !(entry.isSymbolicLink() && (await isDirectory(child))))
            continue;
          const index = items.findIndex((item) => entry.name < item.name);
          items.splice(index < 0 ? items.length : index, 0, { name: entry.name, path: child });
          if (items.length > limit + 1) items.pop();
        }
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
        const denied = code === 'EACCES' || code === 'EPERM';
        return reply.code(denied ? 403 : 404).send({
          error: denied ? 'permission_denied' : 'directory_unavailable',
        });
      }
      const more = items.length > limit;
      if (more) items.pop();
      const next_cursor = more
        ? Buffer.from(JSON.stringify([path, items.at(-1)?.name])).toString('base64url')
        : null;
      return { path, items, next_cursor } satisfies BrowseResponse;
    }
  );
}
