import * as crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { insecureCookies, sessionTtlMs } from '../config';
import { deriveKey } from '../secrets';
import { scopedLogger } from '../logger';
import { canAccess, findActiveUser, verifyCredentials, type AuthUser } from '../users';
import type { Section, SessionUser } from '../../src/shared/api.types';

/**
 * Authentication by personal accounts (see `server/users`).
 *
 * The session is a signed cookie (`expiresAt.userId.gen.mac`). The account
 * is re-read on every request, so a role change applies at once, and a
 * disabled account or a reset password (which bumps `gen`) ends every
 * session it had. Access is enforced here on the server; the UI hiding
 * admin pages is only a convenience.
 */

const log = scopedLogger('auth');

const COOKIE_NAME = 'vs_session';
const SESSION_PURPOSE = 'session-v3';

/** Failed logins per IP, to blunt password guessing. */
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; firstAt: number }>();

/** The signed-in account, or null. */
export function sessionUser(req: Request): SessionUser | null {
  const token = readCookie(req, COOKIE_NAME);
  const user = token ? verifySession(token) : null;
  return user ? toSession(user) : null;
}

function toSession(user: AuthUser): SessionUser {
  return { id: user.id, login: user.login, role: user.role, sections: user.sections, accessRole: user.accessRole, tagScope: user.tagScope };
}

export function isAdmin(user: SessionUser | null): boolean {
  return user?.role === 'admin';
}

/** Middleware: signed in at all. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (sessionUser(req)) {
    next();
    return;
  }
  unauthorized(res);
}

/** Middleware: signed in as an admin. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = sessionUser(req);
  if (!user) {
    unauthorized(res);
    return;
  }
  if (!isAdmin(user)) {
    forbidden(res);
    return;
  }
  next();
}

/** Middleware: signed in with access to the section. */
export function requireSection(section: Section) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = sessionUser(req);
    if (!user) {
      unauthorized(res);
      return;
    }
    if (!canAccess(user, section)) {
      forbidden(res, 'Нет доступа к этому разделу.');
      return;
    }
    next();
  };
}

export function forbidden(res: Response, error = 'Это может только админ.'): void {
  res.status(403).json({ ok: false, error, code: 'forbidden' });
}

function unauthorized(res: Response): void {
  res.status(401).json({ ok: false, error: 'Требуется вход.', code: 'unauthorized' });
}

export function login(req: Request, res: Response): void {
  const ip = clientIp(req);
  if (isLockedOut(ip)) {
    res.status(429).json({ ok: false, error: 'Слишком много попыток. Подожди 15 минут.' });
    return;
  }

  const loginName = typeof req.body?.login === 'string' ? req.body.login : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = loginName && password ? verifyCredentials(loginName, password) : null;

  if (!user) {
    recordFailure(ip);
    log.warn(`Неудачный вход «${loginName.slice(0, 40)}» с ${ip}`);
    res.status(401).json({ ok: false, error: 'Неверный логин или пароль.' });
    return;
  }

  attempts.delete(ip);
  const expiresAt = Date.now() + sessionTtlMs();
  res.setHeader('Set-Cookie', buildCookie(signSession(expiresAt, user), sessionTtlMs()));
  log.info(`Вход «${user.login}» (${user.role}) с ${ip}`);
  res.json({ ok: true, user: toSession(user) });
}

export function logout(_req: Request, res: Response): void {
  res.setHeader('Set-Cookie', buildCookie('', 0));
  res.json({ ok: true });
}

export function session(req: Request, res: Response): void {
  const user = sessionUser(req);
  res.json({ authenticated: user !== null, user });
}

/* ------------------------- session token ------------------------- */

function signSession(expiresAt: number, user: AuthUser): string {
  const payload = `${expiresAt}.${user.id}.${user.sessionGen}`;
  return `${payload}.${hmac(payload)}`;
}

function verifySession(token: string): AuthUser | null {
  const [expires, id, gen, mac] = token.split('.');
  if (!expires || !id || !gen || !mac) return null;
  if (!constantTimeEquals(mac, hmac(`${expires}.${id}.${gen}`))) return null;
  const expiresAt = Number(expires);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  const user = findActiveUser(Number(id));
  return user && user.sessionGen === Number(gen) ? user : null;
}

function hmac(payload: string): string {
  return crypto.createHmac('sha256', deriveKey(SESSION_PURPOSE)).update(payload).digest('base64url');
}

function buildCookie(value: string, maxAgeMs: number): string {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  // Behind a TLS terminator the cookie must be Secure; over plain HTTP a
  // Secure cookie would simply never be stored, locking everyone out.
  if (!insecureCookies()) parts.push('Secure');
  return parts.join('; ');
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/* ------------------------- rate limiting ------------------------- */

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function isLockedOut(ip: string): boolean {
  const entry = attempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > LOCKOUT_MS) {
    attempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(ip: string): void {
  const entry = attempts.get(ip);
  if (!entry || Date.now() - entry.firstAt > LOCKOUT_MS) {
    attempts.set(ip, { count: 1, firstAt: Date.now() });
    return;
  }
  entry.count += 1;
}

/** Compare without leaking length or content through timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}
