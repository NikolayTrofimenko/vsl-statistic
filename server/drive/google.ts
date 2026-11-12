import * as crypto from 'node:crypto';
import {
  googleClientId,
  googleClientSecret,
  googleRedirectUri,
} from '../config';
import { getSetting, setSetting } from '../db';
import { decryptSecret, deriveKey, encryptSecret } from '../secrets';
import { scopedLogger } from '../logger';

/**
 * Google OAuth for one shared Drive connection.
 *
 * A teammate clicks "Connect", consents with an account that can see the
 * library folder, and the refresh token is stored encrypted in SQLite. Every
 * Drive call after that mints short-lived access tokens from it — nobody has
 * to log in to Google again unless the token is revoked.
 *
 * Plain `fetch` against the REST endpoints: the two calls we need don't
 * justify the `googleapis` package.
 */

const log = scopedLogger('google');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/**
 * Full Drive access: reading the library and uploading creatives into its
 * existing folders (`drive.file` can't write into folders the app didn't
 * create). Tokens granted before uploads existed carry `drive.readonly` —
 * still fine for reading, see `driveWritable()`.
 */
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const SCOPES = [DRIVE_SCOPE, 'openid', 'email'];

const KEY_REFRESH = 'google.refreshToken';
const KEY_EMAIL = 'google.email';
const KEY_SCOPES = 'google.scopes';

/** OAuth `state` is only valid this long — the consent screen is quick. */
const STATE_TTL_MS = 10 * 60 * 1000;

let accessToken: { value: string; expiresAt: number } | null = null;

export function googleConfigured(): boolean {
  return googleClientId().length > 0 && googleClientSecret().length > 0;
}

export function googleConnected(): boolean {
  return refreshToken().length > 0;
}

export function googleEmail(): string | null {
  return getSetting(KEY_EMAIL);
}

/**
 * The connection may upload. Connections made before scopes were recorded
 * were all `drive.readonly`, so "unknown" means read-only.
 */
export function driveWritable(): boolean {
  return (getSetting(KEY_SCOPES) ?? '').split(' ').includes(DRIVE_SCOPE);
}

/** URL of Google's consent screen, carrying a signed anti-CSRF `state`. */
export function consentUrl(): string {
  if (!googleConfigured()) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET не заданы в .env.');
  }
  const params = new URLSearchParams({
    client_id: googleClientId(),
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    // offline + consent: guarantees a refresh token even on re-connect.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: signState(),
  });
  return `${AUTH_URL}?${params}`;
}

/** Exchange the code from the consent redirect and persist the refresh token. */
export async function completeConsent(code: string, state: string): Promise<void> {
  if (!verifyState(state)) throw new Error('Ссылка авторизации устарела — попробуй ещё раз.');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      redirect_uri: googleRedirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    throw new Error(`Google отказал в токене: ${body.error_description ?? body.error ?? res.status}`);
  }
  if (!body.refresh_token) {
    throw new Error('Google не выдал refresh token. Отзови доступ приложения в аккаунте и подключи заново.');
  }
  // Google shows each permission as its own checkbox, and the Drive one can be
  // left unticked. The token is then valid but useless — every Drive call
  // fails with "insufficient scopes" — so refuse it here, where the cause is
  // still obvious to the person on the consent screen.
  const granted = (body.scope ?? '').split(' ');
  if (!granted.includes(DRIVE_SCOPE) && !granted.includes(DRIVE_READONLY_SCOPE)) {
    await revoke(body.refresh_token);
    throw new Error('Не выдан доступ к Google Drive. Подключи заново и отметь галочку доступа к файлам Google Диска.');
  }

  setSetting(KEY_REFRESH, encryptSecret(body.refresh_token));
  setSetting(KEY_EMAIL, emailFromIdToken(body.id_token));
  setSetting(KEY_SCOPES, granted.join(' '));
  accessToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  log.info(`Google Drive подключён (${googleEmail() ?? 'email неизвестен'}).`);
}

export async function disconnect(): Promise<void> {
  const token = refreshToken();
  setSetting(KEY_REFRESH, null);
  setSetting(KEY_EMAIL, null);
  setSetting(KEY_SCOPES, null);
  accessToken = null;
  if (token) await revoke(token);
}

/** Best effort: a failed revoke still leaves us disconnected locally. */
async function revoke(token: string): Promise<void> {
  await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(
    () => undefined,
  );
}

/** A valid access token, refreshed when it is about to expire. */
export async function getAccessToken(): Promise<string> {
  if (accessToken && accessToken.expiresAt - 60_000 > Date.now()) return accessToken.value;

  const token = refreshToken();
  if (!token) throw new Error('Google Drive не подключён.');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: token,
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      grant_type: 'refresh_token',
    }),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    if (body.error === 'invalid_grant') {
      // Revoked or expired: forget it so the UI offers to reconnect.
      setSetting(KEY_REFRESH, null);
      throw new Error('Доступ к Google Drive отозван — подключи заново.');
    }
    throw new Error(`Не удалось обновить токен Google: ${body.error ?? res.status}`);
  }
  accessToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return accessToken.value;
}

/** `fetch` with the bearer token; retries once after a 401 with a fresh token. */
export async function googleFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const send = async () =>
    fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${await getAccessToken()}` },
    });
  let res = await send();
  if (res.status === 401) {
    accessToken = null;
    res = await send();
  }
  return res;
}

/* ------------------------- internals ------------------------- */

interface TokenResponse {
  access_token?: string;
  /** Space-separated scopes the user actually granted. */
  scope?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
}

function refreshToken(): string {
  return decryptSecret(getSetting(KEY_REFRESH));
}

function signState(): string {
  const payload = `${Date.now()}.${crypto.randomBytes(8).toString('hex')}`;
  return `${payload}.${stateMac(payload)}`;
}

function verifyState(state: string): boolean {
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = state.slice(0, dot);
  const mac = Buffer.from(state.slice(dot + 1));
  const expected = Buffer.from(stateMac(payload));
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return false;
  const issuedAt = Number(payload.split('.')[0]);
  return Number.isFinite(issuedAt) && Date.now() - issuedAt < STATE_TTL_MS;
}

function stateMac(payload: string): string {
  return crypto.createHmac('sha256', deriveKey('oauth-state-v1')).update(payload).digest('base64url');
}

/** The id_token comes straight from Google over TLS, so no signature check is needed to read it. */
function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof claims.email === 'string' ? claims.email : null;
  } catch {
    return null;
  }
}
