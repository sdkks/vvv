import { randomBytes } from 'node:crypto';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  if (!env.VVV_PASSWORD) throw new Error('VVV_PASSWORD is required; server will not start.');
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
  const dataDir = resolve(env.DATA_DIR ?? './data');
  try {
    mkdirSync(dataDir, { recursive: true });
    accessSync(dataDir, constants.W_OK | constants.R_OK | constants.X_OK);
  } catch {
    throw new Error('DATA_DIR must be a readable, writable directory.');
  }
  return {
    password: env.VVV_PASSWORD,
    sessionSecret: env.VVV_SESSION_SECRET || randomBytes(32).toString('hex'),
    port,
    dataDir,
  };
}
export type Config = ReturnType<typeof loadConfig>;
