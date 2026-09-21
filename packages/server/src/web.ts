import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import staticFiles from '@fastify/static';
import type { FastifyInstance } from 'fastify';

export async function serveWeb(
  app: FastifyInstance,
  directory = process.env.SERVE_WEB_DIST ??
    fileURLToPath(new URL('../../web/dist', import.meta.url))
) {
  const root = resolve(directory);
  if (!existsSync(join(root, 'index.html'))) return;
  await app.register(staticFiles, {
    root,
    // Concrete routes preserve the auth guard's classification of unknown API paths.
    wildcard: false,
    cacheControl: false,
    setHeaders(response, path) {
      const file = relative(root, path);
      const hashed = /^assets\/.*-[\w-]{8,}\.[^/]+$/.test(file);
      response.header(
        'Cache-Control',
        file === 'index.html'
          ? 'no-store'
          : hashed
            ? 'public, max-age=31536000, immutable'
            : 'no-cache'
      );
    },
  });
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    const html = request.headers.accept?.split(',').some((entry) => {
      const [type, ...params] = entry
        .toLowerCase()
        .split(';')
        .map((part) => part.trim());
      const quality = params.find((part) => part.startsWith('q='))?.slice(2) ?? '1';
      return type === 'text/html' && Number(quality) > 0;
    });
    if (request.method === 'GET' && !/^\/api(?:\/|$)/.test(path) && html) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: `Route ${request.method}:${request.url} not found`,
    });
  });
}
