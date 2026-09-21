import { loadConfig } from './config.js';
import { createServer } from './server.js';

try {
  const config = loadConfig();
  const app = await createServer(config);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().catch(() => {
        process.exitCode = 1;
      });
    });
  }
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (error) {
    await app.close();
    throw error;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      level: 'fatal',
      msg: error instanceof Error ? error.message : 'Startup failed',
    })
  );
  process.exitCode = 1;
}
