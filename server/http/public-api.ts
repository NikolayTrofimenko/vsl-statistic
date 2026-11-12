import * as crypto from 'node:crypto';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { db } from '../db';
import { scopedLogger } from '../logger';
import { detail, facets, overview } from '../stats/report';
import type { ApiKeyInfo, SessionUser, StatsFilter } from '../../src/shared/api.types';

/**
 * Read-only stats API for other tools: the landing-video numbers of
 * «Качество на лендах», by key. Keys are issued and revoked by the admin;
 * only a SHA-256 of each is stored, the key itself is shown once.
 *
 *   GET /api/v1/stats?from=YYYY-MM-DD&to=YYYY-MM-DD[&land&device&country&buyer]
 *   GET /api/v1/stats/:id?from&to…     one landing-video: retention, breakdowns
 *   GET /api/v1/facets                 values the filters accept
 *
 *   Authorization: Bearer vsl_…   (or X-Api-Key: vsl_…)
 */

const log = scopedLogger('public-api');

const KEY_PREFIX = 'vsl_';
const DEFAULT_DAYS = 7;
const MAX_DAYS = 93;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function publicApiRouter(): express.Router {
  const router = express.Router();
  router.use(requireKey);
  router.get('/stats', (req, res) => send(res, () => overview(filterOf(req))));
  router.get('/stats/:id', (req, res) =>
    send(res, () => {
      const id = Number(req.params['id']);
      if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, 'id — число из /api/v1/stats.');
      return detail(id, filterOf(req));
    }),
  );
  router.get('/facets', (_req, res) => send(res, () => facets()));
  router.use((_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: 'Неизвестный эндпоинт. Есть: /api/v1/stats, /api/v1/stats/:id, /api/v1/facets.' });
  });
  return router;
}

/* ------------------------- keys (admin) ------------------------- */

export function listKeys(): ApiKeyInfo[] {
  return (
    db()
      .prepare(
        `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, u.login AS created_by
         FROM api_keys k LEFT JOIN users u ON u.id = k.created_by
         WHERE k.revoked_at IS NULL ORDER BY k.created_at DESC`,
      )
      .all() as Record<string, unknown>[]
  ).map((r) => ({
    id: Number(r['id']),
    name: String(r['name']),
    prefix: String(r['prefix']),
    createdAt: Number(r['created_at']),
    createdBy: (r['created_by'] as string | null) ?? null,
    lastUsedAt: (r['last_used_at'] as number | null) ?? null,
  }));
}

/** A new key; the plain value is returned this once and never stored. */
export function createKey(user: SessionUser, rawName: string): { key: string; info: ApiKeyInfo } {
  const name = String(rawName ?? '').trim().slice(0, 80);
  if (!name) throw new Error('Назови ключ — для кого он (например, «софт Сергея»).');
  const key = KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
  const prefix = key.slice(0, KEY_PREFIX.length + 6);
  const id = Number(
    db()
      .prepare('INSERT INTO api_keys (name, key_hash, prefix, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, hash(key), prefix, user.id, Date.now()).lastInsertRowid,
  );
  log.info(`${user.login} выдал API-ключ «${name}» (${prefix}…).`);
  return { key, info: listKeys().find((k) => k.id === id)! };
}

export function revokeKey(user: SessionUser, id: number): void {
  db().prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id);
  log.info(`${user.login} отозвал API-ключ #${id}.`);
}

/* ------------------------- internals ------------------------- */

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function requireKey(req: Request, res: Response, next: NextFunction): void {
  const header = req.get('authorization') ?? '';
  const key = (/^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? req.get('x-api-key') ?? '').trim();
  if (!key) {
    res.status(401).json({ ok: false, error: 'Нужен API-ключ: заголовок Authorization: Bearer vsl_…' });
    return;
  }
  const row = db().prepare('SELECT id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').get(hash(key)) as
    | { id: number }
    | undefined;
  if (!row) {
    res.status(401).json({ ok: false, error: 'Ключ не подходит или отозван.' });
    return;
  }
  db().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
  next();
}

/** Same filter as the page: an inclusive day range (UTC) plus optional facets. */
function filterOf(req: Request): StatsFilter {
  const q = (name: string) => {
    const v = req.query[name];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const today = new Date().toISOString().slice(0, 10);
  const to = q('to') ?? today;
  const from = q('from') ?? shiftDay(to, -(DEFAULT_DAYS - 1));
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw new ApiError(400, 'from и to — даты вида YYYY-MM-DD.');
  if (from > to) throw new ApiError(400, 'from позже to.');
  if (shiftDay(from, MAX_DAYS - 1) < to) throw new ApiError(400, `Период не длиннее ${MAX_DAYS} дней.`);
  return { from, to, land: q('land'), device: q('device'), country: q('country'), buyer: q('buyer') };
}

function send(res: Response, fn: () => unknown): void {
  try {
    res.json({ ok: true, data: fn() });
  } catch (err) {
    const status = err instanceof ApiError ? err.status : /не найден/i.test(String(err)) ? 404 : 500;
    if (status === 500) log.warn('Ошибка публичного API', err);
    res.status(status).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function hash(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
