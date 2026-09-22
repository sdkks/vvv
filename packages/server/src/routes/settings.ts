import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { Settings, UpdateSettingsRequest } from '@vvv/shared';
import { retention } from '../quarantine.js';

export function settingsRoutes(app: FastifyInstance, db: Database.Database) {
  const read = (): Settings => {
    const { days, enabled } = retention(db);
    return { retention_days: days, auto_purge_enabled: enabled };
  };
  app.get('/api/settings', async () => read());
  app.patch<{ Body: UpdateSettingsRequest }>(
    '/api/settings',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            retention_days: { type: 'integer', minimum: 1, maximum: 3650 },
            auto_purge_enabled: { type: 'boolean' },
          },
        },
      },
    },
    async (request) =>
      db.transaction(() => {
        const update = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)');
        if (request.body.retention_days !== undefined)
          update.run('retention_days', String(request.body.retention_days));
        if (request.body.auto_purge_enabled !== undefined)
          update.run('auto_purge_enabled', request.body.auto_purge_enabled ? '1' : '0');
        return read();
      })()
  );
}
