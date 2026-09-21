import Fastify from 'fastify';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HealthResponse } from '@vvv/shared';
import type { Config } from './config.js';
import { openDatabase } from './db.js';
import { auth } from './auth.js';
import { Scanner } from './scanner.js';
import { scanRoutes } from './routes/scans.js';
import { scanDirRoutes } from './routes/scan-dirs.js';
import { Progress } from './progress.js';
import { serveWeb } from './web.js';
import { Matcher } from './matcher.js';
import { groupRoutes } from './routes/groups.js';
import { exportRoutes } from './routes/export.js';
import { thumbnailRoutes } from './routes/thumbnails.js';

export async function createServer(config: Config, logger = true, webDist?: string) {
  const app = Fastify({
    logger,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  await mkdir(join(config.dataDir, 'thumbs'), { recursive: true });
  const { db, openReadOnly } = openDatabase(config.dataDir);
  const progress = new Progress();
  const matcher = new Matcher(db, app.log);
  const scanner = new Scanner(
    db,
    app.log,
    (snapshot) => progress.publish(snapshot),
    () => matcher.afterScan()
  );
  app.addHook('preClose', async () => {
    progress.close();
    await scanner.close();
    await matcher.close();
  });
  app.addHook('onClose', async () => {
    db.close();
  });
  await app.register(auth, { config });
  scanRoutes(app, db, scanner, progress);
  scanDirRoutes(app, db);
  groupRoutes(app, db, matcher);
  exportRoutes(app, openReadOnly);
  thumbnailRoutes(app, db, config.dataDir);
  app.get('/api/health', async (): Promise<HealthResponse> => {
    db.prepare('SELECT 1').get();
    return { status: 'ok', db: 'ok' };
  });
  await serveWeb(app, webDist);
  return app;
}
