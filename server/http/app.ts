import * as fs from 'node:fs';
import * as path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { rendererDir, trackerDir } from '../config';
import { hasChannel, invoke, listChannels } from '../api/rpc';
import { forbidden, isAdmin, login, logout, requireAdmin, requireAuth, requireSection, session, sessionUser } from './auth';
import { canAccess, runAs } from '../users';
import type { Section } from '../../src/shared/api.types';
import { oauthCallback, oauthStart, serveKnowledgeFile, serveThumb, streamVideo } from './drive-routes';
import { uploadKnowledge } from '../knowledge';
import { MAX_PHOTO, serveOfferPhoto, uploadOfferPhoto } from '../offers';
import { collect, collectCors } from '../stats/collect';
import { uploadCreative } from './upload';
import { publicApiRouter } from './public-api';
import { scopedLogger } from '../logger';

const log = scopedLogger('http');

const JSON_LIMIT = '1mb';
/** Largest tracker beacon: a 4-hour bitmap is ~2.4 KB of base64, ×5 videos. */
const BEACON_LIMIT = '32kb';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Deployed behind nginx/Caddy, so honour X-Forwarded-* for client IPs.
  app.set('trust proxy', true);
  app.use(securityHeaders);

  /* ---------- public: health, auth ---------- */

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, channels: listChannels().length });
  });
  app.get('/api/auth/session', session);
  app.post('/api/auth/login', express.json({ limit: '4kb' }), login);
  app.post('/api/auth/logout', logout);

  /* ---------- public: landing tracker ---------- */

  app.get('/t.js', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Short cache: tracker fixes reach every landing within minutes.
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('application/javascript').sendFile(path.join(trackerDir(), 't.js'));
  });
  app.options('/api/collect', collectCors);
  app.post(
    '/api/collect',
    collectCors,
    express.text({ type: () => true, limit: BEACON_LIMIT }),
    collect,
  );

  /* ---------- read-only stats API for other tools (API key, not session) ---------- */

  app.use('/api/v1', publicApiRouter());

  /* ---------- authenticated ---------- */

  app.post('/api/rpc/:channel', requireAuth, express.json({ limit: JSON_LIMIT }), rpcRoute);
  // Re-pointing the Drive connection is for admins only.
  app.get('/api/drive/oauth/start', requireAdmin, oauthStart);
  app.get('/api/drive/oauth/callback', requireAdmin, oauthCallback);
  app.get('/api/drive/thumb/:id', requireSection('library'), serveThumb);
  app.get('/api/drive/stream/:id', requireSection('library'), streamVideo);
  // Raw file body, streamed to Drive — no body parser in front of it.
  app.post('/api/library/upload', requireSection('library'), uploadCreative);
  // База знаний: section 'knowledge' reads, 'knowledgeEdit' uploads images and videos for documents.
  app.get('/api/knowledge/file/:id', requireSection('knowledge'), serveKnowledgeFile);
  app.post('/api/knowledge/upload', requireSection('knowledgeEdit'), uploadKnowledge);
  app.get('/api/offers/photo/:id', requireSection('offers'), serveOfferPhoto);
  app.post(
    '/api/offers/photo/:id',
    requireSection('offersEdit'),
    express.raw({ type: () => true, limit: MAX_PHOTO }),
    uploadOfferPhoto,
  );

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: 'Неизвестный эндпоинт.' });
  });

  /* ---------- renderer ---------- */

  mountRenderer(app);

  app.use(errorHandler);
  return app;
}

/** Bridge one channel call: a channel name plus a positional argument list. */
async function rpcRoute(req: Request, res: Response): Promise<void> {
  const channel = String(req.params['channel'] ?? '');
  if (!hasChannel(channel)) {
    res.status(404).json({ ok: false, error: `Неизвестный канал: ${channel}` });
    return;
  }

  // requireAuth ran first, so there is a user.
  const user = sessionUser(req)!;
  const need = channelAccess(channel);
  if (need === 'admin' ? !isAdmin(user) : need !== null && !canAccess(user, need)) {
    forbidden(res, need === 'admin' ? undefined : 'Нет доступа к этому разделу.');
    return;
  }

  const body = req.body as { args?: unknown } | undefined;
  const args = Array.isArray(body?.args) ? body.args : [];

  try {
    const data = await runAs(user, () => invoke(channel, args));
    res.json({ ok: true, data: data === undefined ? null : data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`${channel} failed: ${message}`);
    res.status(500).json({ ok: false, error: message });
  }
}

/**
 * What a channel needs: 'admin' — only an admin (accounts and access roles,
 * the Drive connection, vertical codes, API keys, deleting creatives,
 * clearing marks); a section — any account whose role opens it (an admin
 * opens all); null — any signed-in account. Per-user rules (whose tags and
 * marks are visible) live in the handlers.
 */
function channelAccess(channel: string): Section | 'admin' | null {
  // The dashboard is the owner's for now; its blocks become sections once roles are split.
  if (
    ADMIN_CHANNELS.has(channel) ||
    channel.startsWith('users:') ||
    channel.startsWith('dashboard:') ||
    channel.startsWith('apifb:')
  ) {
    return 'admin';
  }
  if (OPEN_CHANNELS.has(channel)) return null;
  if (EDIT_CHANNELS[channel]) return EDIT_CHANNELS[channel];
  const prefix = channel.slice(0, channel.indexOf(':'));
  if (HANDLER_CHECKED_PREFIXES.has(prefix)) return null;
  return SECTION_OF_PREFIX[prefix] ?? null;
}

const ADMIN_CHANNELS = new Set([
  'drive:disconnect',
  'library:saveVertical',
  'library:delete',
  'duplicates:clear',
  'reports:resolve',
  'stats:apiKeys',
  'stats:createApiKey',
  'stats:revokeApiKey',
]);

/** Writes inside a section that only some of its readers may make. */
const EDIT_CHANNELS: Record<string, Section> = {
  'offers:save': 'offersEdit',
  'offers:delete': 'offersEdit',
  'offers:partners': 'offersEdit',
  'knowledge:save': 'knowledgeEdit',
  'knowledge:delete': 'knowledgeEdit',
  'knowledge:import': 'knowledgeEdit',
};

/** Reference data several sections show (vertical names and codes). */
const OPEN_CHANNELS = new Set(['library:verticals']);

/** Open to team leads without the section too — `server/api/grants.handlers.ts` checks and scopes. */
const HANDLER_CHECKED_PREFIXES = new Set(['grants']);

const SECTION_OF_PREFIX: Record<string, Section> = {
  library: 'library',
  tags: 'library',
  duplicates: 'library',
  reports: 'library',
  drive: 'library',
  stats: 'quality',
  caps: 'caps',
  domains: 'domains',
  history: 'history',
  offers: 'offers',
  knowledge: 'knowledge',
};

/** Serve the built Angular bundle, falling back to index.html for deep links. */
function mountRenderer(app: express.Express): void {
  const dir = rendererDir();
  const indexFile = path.join(dir, 'index.html');

  if (!fs.existsSync(indexFile)) {
    log.warn(
      `Сборка фронтенда не найдена в ${dir}. ` +
        'Запусти «npm run build:renderer», либо открывай дев-сервер Angular на :4200.',
    );
    return;
  }

  // `extensions` lets the public legal pages answer at /about and /privacy.
  app.use(express.static(dir, { index: false, maxAge: '1h', extensions: ['html'] }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(indexFile);
  });
}

/**
 * HTTPS only from now on (HSTS); never inside someone else's frame
 * (clickjacking on buy/share buttons); no full URLs leaked to other sites.
 * The landing tracker (/t.js, /api/collect) is loaded as a script and beaconed
 * to, never framed, so it is unaffected.
 */
function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}

/** Something nobody planned for: details go to the log, not to the browser. */
function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  log.error('Необработанная ошибка запроса', err);
  const status = (err as { status?: number } | null)?.status;
  // Body-parser errors (too large, bad JSON) carry a 4xx status and a harmless message.
  if (status && status >= 400 && status < 500) {
    res.status(status).json({ ok: false, error: status === 413 ? 'Слишком большой запрос.' : 'Некорректный запрос.' });
    return;
  }
  res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера. Подробности в логе.' });
}
