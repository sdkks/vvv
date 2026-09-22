import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifySchemaValidationError } from 'fastify';
import type {
  MatchingControls,
  Settings,
  SettingsConsequence,
  UpdateSettingsRequest,
  UpdateSettingsResponse,
} from '@vvv/shared';
import { retention } from '../quarantine.js';
import { matchingSetting, matchingSettings } from '../matching-settings.js';

export function settingsRoutes(app: FastifyInstance, db: Database.Database) {
  const read = (): Settings => {
    const { days, enabled } = retention(db);
    return { retention_days: days, auto_purge_enabled: enabled, matching: matchingSettings(db) };
  };
  app.get('/api/settings', async () => read());
  app.patch<{ Body: UpdateSettingsRequest }>(
    '/api/settings',
    {
      attachValidation: true,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            retention_days: { type: 'integer', minimum: 1, maximum: 3650 },
            auto_purge_enabled: { type: 'boolean' },
            image_phash_threshold: { type: 'integer', minimum: 0, maximum: 64 },
            video_phash_threshold: { type: 'integer', minimum: 0, maximum: 64 },
            video_frame_count: { type: 'integer', minimum: 1, maximum: 64 },
            video_timeout_ms: { type: 'integer', minimum: 10000, maximum: 3600000 },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.validationError) {
        const fields = Object.fromEntries(
          (request.validationError.validation ?? []).map((error: FastifySchemaValidationError) => [
            error.instancePath?.slice(1) || 'settings',
            error.message ?? 'Invalid value',
          ])
        );
        return reply.code(400).send({ error: 'invalid_settings', fields });
      }
      return db.transaction(() => {
        const changed = (key: keyof MatchingControls) =>
          request.body[key] !== undefined && request.body[key] !== matchingSetting(db, key);
        const thresholds = changed('image_phash_threshold') || changed('video_phash_threshold');
        const frames = changed('video_frame_count');
        const timeout = changed('video_timeout_ms');
        // Do not let an in-flight sampler restore old frames or a matcher mix settings.
        if (frames && db.prepare("SELECT 1 FROM scans WHERE status='running' LIMIT 1").get())
          return reply.code(409).send({ error: 'settings_scan_running' });
        if (
          (frames || thresholds) &&
          db.prepare("SELECT 1 FROM match_runs WHERE status='building' LIMIT 1").get()
        )
          return reply.code(409).send({ error: 'settings_match_running' });
        const update = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)');
        for (const [key, value] of Object.entries(request.body))
          update.run(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
        if (frames) {
          // Frame-count change invalidates video perceptual hashes; next scan re-samples.
          db.exec(`DELETE FROM phash_bands WHERE file_id IN (SELECT id FROM files WHERE kind='video');
            DELETE FROM phashes WHERE file_id IN (SELECT id FROM files WHERE kind='video');
            UPDATE files SET status='pending',updated_at=datetime('now')
              WHERE kind='video' AND status IN ('done','hashed')`);
        }
        const consequences: SettingsConsequence[] = [];
        if (thresholds) consequences.push({ type: 'rematch_required', reason: 'threshold_change' });
        if (frames) consequences.push({ type: 'rescan_required', reason: 'frame_count_change' });
        if (timeout) consequences.push({ type: 'future_sampling_only', reason: 'timeout_change' });
        return { ...read(), consequences } satisfies UpdateSettingsResponse;
      })();
    }
  );
}
