import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { all, one, type Db } from './db.ts';
import { createSession, isAuthenticated, tokenHash, verifyPassword } from './auth.ts';
import { importLenex, MAX_UPLOAD_BYTES } from './importers/lenex.ts';
import * as query from './queries.ts';

export async function createApp(db: Db, { frontend = false, logger = false } = {}) {
  const app = Fastify({ logger, bodyLimit: MAX_UPLOAD_BYTES, trustProxy: false });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0 } });
  await app.register(rateLimit, { global: false });
  const clients = new Set<ServerResponse>();
  const changed = () => {
    for (const client of clients) client.write(`data: ${Date.now()}\n\n`);
  };
  let watch: ReturnType<typeof setInterval> | undefined;
  app.addHook('onListen', async () => {
    let version = await db.version();
    // Detect committed imports from CLI processes and other app instances.
    watch = setInterval(async () => {
      try {
        const next = await db.version();
        if (next !== version) {
          version = next;
          changed();
        }
      } catch (error) {
        app.log.error(error);
      }
    }, 2000);
  });
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'same-origin')
      .header('X-Frame-Options', 'DENY');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      // A custom header forces a preflight for cross-origin requests; no CORS is enabled.
      if (req.headers['x-tempo-request'] !== '1')
        return reply.code(403).send({ error: 'Ongeldig verzoek.' });
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host)
        return reply.code(403).send({ error: 'Ongeldige herkomst.' });
    }
    if (
      req.url.startsWith('/api/admin/') &&
      !(await isAuthenticated(db, req.cookies.tempo_session))
    )
      return reply.code(401).send({ error: 'Log in als beheerder.' });
  });
  app.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: error.issues.map((i) => i.message).join(' ') });
    if (error.code === 'FST_REQ_FILE_TOO_LARGE')
      return reply.code(413).send({ error: 'Bestand is groter dan 10 MB.' });
    if (error.statusCode && error.statusCode < 500)
      return reply.code(error.statusCode).send({ error: error.message });
    app.log.error(error);
    return reply.code(500).send({ error: 'De bewerking is mislukt. Raadpleeg het serverlog.' });
  });
  const params = (value: unknown) => z.record(z.string(), z.string().max(200)).parse(value || {});
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/meta', async () => await query.meta(db));
  app.get('/api/records', async (req) => await query.records(db, params(req.query)));
  app.get('/api/results', async (req) => await query.results(db, params(req.query)));
  app.get(
    '/api/history',
    async (req) => await query.history(db, undefined, params(req.query).course),
  );
  app.get<{ Params: { id: string } }>(
    '/api/records/:id/history',
    async (req) =>
      await query.history(
        db,
        z.coerce.number().int().positive().parse(req.params.id),
        params(req.query).course,
      ),
  );
  app.get('/api/swimmers', async (req) => await query.swimmers(db, params(req.query).q));
  app.get<{ Params: { id: string } }>(
    '/api/results/:id/splits',
    async (req) =>
      await all(
        db,
        'SELECT distance,time_cs FROM splits WHERE result_id=? ORDER BY distance',
        z.coerce.number().int().positive().parse(req.params.id),
      ),
  );
  app.get('/api/auth', async (req) => ({
    authenticated: await isAuthenticated(db, req.cookies.tempo_session),
    configured: !!(await one(db, 'SELECT 1 FROM admin_credentials')),
  }));
  app.post(
    '/api/login',
    { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { password } = z.object({ password: z.string().max(500) }).parse(req.body);
      if (!(await verifyPassword(db, password)))
        return reply.code(401).send({ error: 'Het wachtwoord is onjuist.' });
      reply.setCookie('tempo_session', await createSession(db), {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.COOKIE_SECURE === 'true',
        maxAge: 8 * 60 * 60,
      });
      return { ok: true };
    },
  );
  app.post('/api/logout', async (req, reply) => {
    if (req.cookies.tempo_session)
      await db
        .prepare('DELETE FROM sessions WHERE token_hash=?')
        .run(tokenHash(req.cookies.tempo_session));
    reply.clearCookie('tempo_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/admin/uploads', async () => await query.uploads(db));
  app.post('/api/admin/uploads', async (req, reply) => {
    const file = await req.file();
    if (!file || !/\.(lxf|lef|xml)$/i.test(file.filename))
      return reply.code(400).send({ error: 'Kies een .lxf-, .lef- of .xml-bestand.' });
    const bytes = await file.toBuffer();
    try {
      const summary = await importLenex(db, bytes, file.filename.replace(/[\\/]/g, '_'));
      if (!summary.duplicate) changed();
      return summary;
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
  app.get<{ Params: { id: string } }>('/api/admin/uploads/:id/download', async (req, reply) => {
    const row = await one(
      db,
      'SELECT filename,content FROM uploads WHERE id=?',
      z.coerce.number().int().positive().parse(req.params.id),
    );
    if (!row) return reply.code(404).send({ error: 'Bestand niet gevonden.' });
    reply
      .header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      )
      .type('application/octet-stream');
    return Buffer.from(row.content);
  });
  app.put('/api/admin/settings', async (req) => {
    const { teamCode } = z
      .object({ teamCode: z.string().regex(/^\d{2}-\d{3}$/, 'Gebruik clubcode-formaat 13-036.') })
      .parse(req.body);
    await db.transaction(async () => {
      await db.prepare("UPDATE settings SET value=? WHERE key='team_code'").run(teamCode);
    });
    changed();
    return { ok: true };
  });
  app.get('/api/events', async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    clients.add(reply.raw);
    const heartbeat = setInterval(() => reply.raw.write(': keepalive\n\n'), 25000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(reply.raw);
    });
  });
  app.addHook('preClose', async () => {
    if (watch) clearInterval(watch);
    for (const client of clients) client.end();
  });
  if (frontend) {
    if (process.env.NODE_ENV !== 'production') {
      const { createServer } = await import('vite');
      const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
      // Close HMR websockets before Fastify waits for open connections to drain.
      app.addHook('preClose', async () => vite.close());
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Niet gevonden.' });
        reply.hijack();
        vite.middlewares(req.raw, reply.raw, () => {
          reply.raw.statusCode = 404;
          reply.raw.end('Niet gevonden');
        });
      });
    } else {
      const root = resolve('dist');
      if (!existsSync(root)) throw new Error('Voer eerst npm run build uit.');
      await app.register(staticFiles, { root });
      app.setNotFoundHandler((req, reply) =>
        req.url.startsWith('/api/')
          ? reply.code(404).send({ error: 'Niet gevonden.' })
          : reply.sendFile('index.html'),
      );
    }
  }
  return app;
}
