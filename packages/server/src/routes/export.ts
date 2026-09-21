import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { ExportGroup } from '@vvv/shared';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setImmediate as yieldLoop } from 'node:timers/promises';

const EXPORT_LIFETIME_MS = 10 * 60 * 1000;
type Row = ExportGroup['members'][number] & {
  group_id: number;
  kind: ExportGroup['kind'];
  rel_path: string;
};
const csv = (value: unknown) => {
  const text = value === null ? '' : String(value);
  return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
export function exportStream(openReadOnly: () => Database.Database, format: 'csv' | 'json') {
  const db = openReadOnly();
  let iterator: IterableIterator<Row> | undefined;
  let closed = false;
  const dispose = () => {
    if (closed) return;
    closed = true;
    iterator?.return?.();
    db.close();
  };
  async function* serialize() {
    try {
      iterator = db
        .prepare(
          `SELECT g.id AS group_id,g.kind,f.id AS file_id,d.path,f.rel_path,
        f.size,f.width,f.height,f.duration_ms,m.similarity FROM dup_groups g
        JOIN dup_group_members m ON m.group_id=g.id JOIN files f ON f.id=m.file_id
        JOIN scan_dirs d ON d.id=f.scan_dir_id
        WHERE g.match_run=(SELECT value FROM settings WHERE key='active_match_run') AND f.status='done'
        ORDER BY g.id,m.file_id`
        )
        .iterate() as IterableIterator<Row>;
      yield format === 'csv'
        ? 'group_id,kind,path,size,width,height,duration_ms,similarity\r\n'
        : '{"groups":[';
      let previous: number | undefined,
        count = 0;
      for (const { group_id, kind, rel_path, ...row } of iterator) {
        row.path = join(row.path, rel_path);
        if (format === 'csv')
          yield [
            group_id,
            kind,
            row.path,
            row.size,
            row.width,
            row.height,
            row.duration_ms,
            row.similarity,
          ]
            .map(csv)
            .join(',') + '\r\n';
        else {
          if (previous !== group_id)
            yield `${previous === undefined ? '' : ']},'}{"id":${group_id},"kind":${JSON.stringify(kind)},"members":[`;
          else yield ',';
          yield JSON.stringify(row);
        }
        previous = group_id;
        if (++count % 256 === 0) await yieldLoop();
        if (closed) return;
      }
      if (format === 'json') yield `${previous === undefined ? '' : ']}'}]}`;
    } finally {
      dispose();
    }
  }
  // Readable.from pulls only as downstream capacity allows; Fastify pipes with backpressure.
  const stream = Readable.from(serialize(), { objectMode: false, highWaterMark: 16384 });
  const timer = setTimeout(
    () => stream.destroy(new Error('Export timed out')),
    EXPORT_LIFETIME_MS
  ).unref();
  stream.once('close', () => {
    clearTimeout(timer);
    dispose();
  });
  return stream;
}
export function exportRoutes(app: FastifyInstance, openReadOnly: () => Database.Database) {
  for (const format of ['csv', 'json'] as const) {
    app.get(`/api/export.${format}`, async (_request, reply) => {
      const stream = exportStream(openReadOnly, format);
      reply.raw.once('close', () => stream.destroy());
      return reply
        .type(format === 'csv' ? 'text/csv' : 'application/json')
        .header('Content-Disposition', `attachment; filename="duplicates.${format}"`)
        .send(stream);
    });
  }
}
