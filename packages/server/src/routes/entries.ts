import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { DirectoryEntry, DirectoryEntries, EntryFilter, ScanDir } from '@vvv/shared';
import { insideTrash, mediaKind, scanDecision, skipsSymlink } from '../traversal-policy.js';
import { idParams } from './scans.js';

type Query = { path?: string; cursor?: string; limit?: string; filter?: EntryFilter };
const codeOf = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unavailable';
function fail(code: string, statusCode = 403): never {
  throw Object.assign(new Error(code), { code, statusCode });
}
const outside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};
type EntryKey = Pick<DirectoryEntry, 'kind' | 'name'>;
const entryClass = (entry: EntryKey) => Number(entry.kind !== 'folder');
const compare = (a: EntryKey, b: EntryKey) =>
  entryClass(a) - entryClass(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

async function entries(dir: ScanDir, query: Query): Promise<DirectoryEntries> {
  const input = query.path ?? '';
  const absolute = resolve(dir.path, input);
  if (
    input.includes('\0') ||
    isAbsolute(input) ||
    win32.isAbsolute(input) ||
    outside(dir.path, absolute)
  )
    fail('invalid_preview_path', 400);
  if (insideTrash(input) || insideTrash(absolute)) fail('inside_trash');
  let rootInfo = await lstat(dir.path, { bigint: true });
  if (skipsSymlink(rootInfo.isSymbolicLink(), dir.follow_symlinks)) fail('symlink_not_followed');
  const root = await realpath(dir.path);
  if (insideTrash(root)) fail('inside_trash');
  if (rootInfo.isSymbolicLink()) rootInfo = await stat(root, { bigint: true });
  async function inspect(path: string, name: string, folder = false): Promise<DirectoryEntry> {
    const item: DirectoryEntry = {
      name,
      type: folder ? 'folder' : 'file',
      kind: folder ? 'folder' : (mediaKind(name) ?? 'other'),
      size: null,
      decision: 'other',
    };
    try {
      let info = await lstat(path, { bigint: true });
      const linked = info.isSymbolicLink();
      item.type = linked ? 'symlink' : info.isDirectory() ? 'folder' : 'file';
      if (linked && dir.follow_symlinks) {
        const target = await realpath(path);
        if (insideTrash(target)) return { ...item, decision: 'inside_trash' };
        if (outside(root, target))
          return {
            ...item,
            decision_detail: 'Symlink target is outside the registered directory.',
          };
        info = await stat(target, { bigint: true });
      }
      item.kind = info.isDirectory() ? 'folder' : (mediaKind(name) ?? 'other');
      item.size = info.isFile() ? Number(info.size) : null;
      item.decision = scanDecision(info, mediaKind(name), dir, rootInfo.dev);
    } catch (error) {
      const code = codeOf(error);
      item.decision = ['EACCES', 'EPERM'].includes(code) ? 'permission_denied' : 'other';
      item.decision_detail =
        item.decision === 'other' ? 'Entry unavailable; it may have changed.' : undefined;
    }
    return item;
  }
  // Check every ancestor: requesting a child must not bypass a blocked link or mount.
  const path = relative(dir.path, absolute);
  let current = root;
  for (const part of path ? path.split(sep) : []) {
    current = join(current, part);
    const item = await inspect(current, part);
    if (item.decision !== 'folder')
      fail(item.decision === 'other' ? 'directory_unavailable' : item.decision);
    current = await realpath(current);
  }
  const filter = query.filter ?? 'media';
  const scope = JSON.stringify([dir.id, path, filter, dir.follow_symlinks, dir.cross_filesystems]);
  let after: EntryKey | undefined;
  if (query.cursor) {
    try {
      const value: unknown = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
      if (
        !Array.isArray(value) ||
        value.length !== 3 ||
        value[0] !== scope ||
        (value[1] !== 0 && value[1] !== 1) ||
        typeof value[2] !== 'string' ||
        !value[2]
      )
        fail('invalid_cursor', 400);
      after = { name: value[2], kind: value[1] === 0 ? 'folder' : 'other' };
    } catch {
      fail('invalid_cursor', 400);
    }
  }
  const limit = Math.min(Number(query.limit ?? 50), 100);
  const items: DirectoryEntry[] = [];
  // Re-enumeration keeps only the smallest limit+1 keys, never the whole directory.
  for await (const entry of await opendir(current)) {
    if (insideTrash(entry.name)) continue;
    const item = await inspect(join(current, entry.name), entry.name, entry.isDirectory());
    if (item.decision === 'inside_trash') continue;
    if (filter === 'media' && item.kind === 'other' && item.type !== 'symlink') continue;
    if (after && compare(item, after) <= 0) continue;
    const index = items.findIndex((candidate) => compare(item, candidate) < 0);
    items.splice(index < 0 ? items.length : index, 0, item);
    if (items.length > limit + 1) items.pop();
  }
  const has_more = items.length > limit;
  if (has_more) items.pop();
  const last = items.at(-1);
  const next_cursor =
    has_more && last
      ? Buffer.from(JSON.stringify([scope, entryClass(last), last.name])).toString('base64url')
      : null;
  return { path, items, next_cursor, has_more };
}

export function entryRoutes(app: FastifyInstance, db: Database.Database) {
  app.get<{ Params: { id: string }; Querystring: Query }>(
    '/api/scan-dirs/:id/entries',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', maxLength: 4096 },
            cursor: { type: 'string', maxLength: 8192 },
            limit: { type: 'string', pattern: '^[1-9][0-9]{0,5}$' },
            filter: { type: 'string', enum: ['media', 'all'] },
          },
        },
      },
    },
    async (request, reply) => {
      const row = db
        .prepare('SELECT id,path,follow_symlinks,cross_filesystems FROM scan_dirs WHERE id=?')
        .get(request.params.id) as ScanDir | undefined;
      if (!row) return reply.code(404).send({ error: 'directory_not_found' });
      try {
        reply.header('Cache-Control', 'no-store');
        return await entries(
          {
            ...row,
            follow_symlinks: !!row.follow_symlinks,
            cross_filesystems: !!row.cross_filesystems,
          },
          request.query
        );
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'statusCode' in error &&
          typeof error.statusCode === 'number'
        )
          return reply.code(error.statusCode).send({ error: codeOf(error) });
        const denied = ['EACCES', 'EPERM'].includes(codeOf(error));
        return reply
          .code(denied ? 403 : 404)
          .send({ error: denied ? 'permission_denied' : 'directory_unavailable' });
      }
    }
  );
}
