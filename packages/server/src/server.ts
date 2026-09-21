import Fastify from 'fastify';
import type { HealthResponse } from '@vvv/shared';
import type { Config } from './config.js';
import { openDatabase } from './db.js';
import { auth } from './auth.js';
import { Scanner } from './scanner.js';
import { scanRoutes } from './routes/scans.js';
import { scanDirRoutes } from './routes/scan-dirs.js';
import { Progress } from './progress.js';
import { serveWeb } from './web.js';

export async function createServer(config: Config, logger = true, webDist?: string) {
  const app = Fastify({
    logger,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  const { db } = openDatabase(config.dataDir);
  const progress = new Progress();
  const scanner = new Scanner(db, app.log, (snapshot) => progress.publish(snapshot));
  app.addHook('preClose', async () => {
    progress.close();
    await scanner.close();
  });
  app.addHook('onClose', async () => {
    db.close();
  });
  await app.register(auth, { config });
  scanRoutes(app, db, scanner, progress);
  scanDirRoutes(app, db);
  app.get('/api/health', async (): Promise<HealthResponse> => {
    db.prepare('SELECT 1').get();
    return { status: 'ok', db: 'ok' };
  });
  await serveWeb(app, webDist);
  return app;
}
