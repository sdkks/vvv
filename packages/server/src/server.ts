import Fastify from 'fastify';
import type { HealthResponse } from '@vvv/shared';
import type { Config } from './config.js';
import { openDatabase } from './db.js';
import { auth } from './auth.js';
import { Scanner } from './scanner.js';
import { scanRoutes } from './routes/scans.js';

export async function createServer(config: Config, logger = true) {
  const app = Fastify({
    logger,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  const { db } = openDatabase(config.dataDir);
  const scanner = new Scanner(db, app.log);
  app.addHook('preClose', async () => {
    await scanner.close();
  });
  app.addHook('onClose', async () => {
    db.close();
  });
  await app.register(auth, { config });
  scanRoutes(app, db, scanner);
  app.get('/api/health', async (): Promise<HealthResponse> => {
    db.prepare('SELECT 1').get();
    return { status: 'ok', db: 'ok' };
  });
  return app;
}
