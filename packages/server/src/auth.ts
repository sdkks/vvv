import { createHash, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import cookie from '@fastify/cookie';
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import type { ApiError, LoginRequest, SessionResponse } from '@vvv/shared';
import type { Config } from './config.js';

const digest = (value: string) => createHash('sha256').update(value).digest();
const cookieOptions = { path: '/', httpOnly: true, sameSite: 'lax', secure: 'auto' } as const;
const plugin: FastifyPluginAsync<{ config: Config }> = async (app, { config }) => {
  await app.register(cookie, { secret: config.sessionSecret });
  const failures = new Map<string, number>();
  const expected = digest(config.password);
  app.addHook('onRequest', async (request, reply) => {
    const path = request.routeOptions.url ?? request.url.split('?')[0] ?? '';
    if (!/^\/api(?:\/|$)/.test(path)) return;
    reply.header('Cache-Control', 'no-store');
    if (path === '/api/health' || path === '/api/auth/login') return;
    const signed = request.cookies.vvv_session;
    const session = signed ? request.unsignCookie(signed) : null;
    if (!session?.valid || !/^authenticated:\d+$/.test(session.value ?? '')) {
      return reply.code(401).send({ error: 'unauthorized' } satisfies ApiError);
    }
  });
  app.post<{ Body: LoginRequest }>(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['password'],
          additionalProperties: false,
          properties: { password: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      if (!timingSafeEqual(digest(request.body.password), expected)) {
        const attempt = Math.min((failures.get(request.ip) ?? 0) + 1, 7);
        failures.delete(request.ip);
        failures.set(request.ip, attempt);
        const oldest = failures.keys().next().value;
        if (failures.size > 10000 && oldest) failures.delete(oldest);
        await delay(Math.min(500 * 2 ** (attempt - 1), 30000));
        return reply.code(401).send({ error: 'unauthorized' } satisfies ApiError);
      }
      failures.delete(request.ip);
      return reply
        .setCookie('vvv_session', `authenticated:${Date.now()}`, { ...cookieOptions, signed: true })
        .code(204)
        .send();
    }
  );
  app.post('/api/auth/logout', async (_request, reply) =>
    reply.clearCookie('vvv_session', cookieOptions).code(204).send()
  );
  app.get('/api/auth/session', async (): Promise<SessionResponse> => ({ authenticated: true }));
};
export const auth = fp(plugin, { name: 'vvv-auth', fastify: '5.x' });
