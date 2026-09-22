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
import { matchingSetting, matchingSettings, validSizeRange } from '../matching-settings.js';

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
            match_images_enabled: { type: 'boolean' },
            match_videos_enabled: { type: 'boolean' },
            image_phash_threshold: { type: 'integer', minimum: 0, maximum: 64 },
            video_phash_threshold: { type: 'integer', minimum: 0, maximum: 64 },
            video_frame_count: { type: 'integer', minimum: 1, maximum: 64 },
            video_timeout_ms: { type: 'integer', minimum: 10000, maximum: 3600000 },
            min_file_size_mb: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            max_file_size_mb: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
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
        const sizePolicy = {
          min_file_size_mb:
            request.body.min_file_size_mb ?? matchingSetting(db, 'min_file_size_mb'),
          max_file_size_mb:
            request.body.max_file_size_mb ?? matchingSetting(db, 'max_file_size_mb'),
        };
        if (!validSizeRange(sizePolicy))
          return reply.code(400).send({
            error: 'invalid_settings',
            fields: { max_file_size_mb: 'Maximum must be at least minimum when both are enabled.' },
          });
        const changed = (key: keyof MatchingControls) =>
          request.body[key] !== undefined && Number(request.body[key]) !== matchingSetting(db, key);
        const thresholds = changed('image_phash_threshold') || changed('video_phash_threshold');
        const frames = changed('video_frame_count');
        const timeout = changed('video_timeout_ms');
        const sizes = changed('min_file_size_mb') || changed('max_file_size_mb');
        const toggled = (['image', 'video'] as const).filter((kind) =>
          changed(`match_${kind}s_enabled`)
        );
        // Do not let an in-flight sampler restore old frames or a matcher mix settings.
        if (frames && db.prepare("SELECT 1 FROM scans WHERE status='running' LIMIT 1").get())
          return reply.code(409).send({ error: 'settings_scan_running' });
        if (
          (frames || thresholds || toggled.length > 0) &&
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
        if (sizes) consequences.push({ type: 'next_scan_required', reason: 'size_filter_change' });
        for (const kind of toggled) {
          const enabled = request.body[`match_${kind}s_enabled`];
          consequences.push({
            type: enabled ? 'match_enabled' : 'match_disabled',
            kind,
            message: enabled
              ? `Existing ${kind} files will be analyzed on the next scan (no content re-hashing).`
              : `Future scans skip ${kind} perceptual hashing; existing ${kind} groups remain until re-match; re-match removes them.`,
          });
          if (enabled)
            consequences.push({ type: 'rematch_required', reason: 'match_enabled', kind });
        }
        return { ...read(), consequences } satisfies UpdateSettingsResponse;
      })();
    }
  );
}
