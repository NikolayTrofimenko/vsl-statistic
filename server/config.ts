import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Runtime configuration, resolved from the environment. The single place that
 * knows where things live on disk and which credentials are configured.
 */

let cachedDataRoot: string | null = null;

/** Root for everything persisted: SQLite database, thumbnail cache, logs. */
export function dataRoot(): string {
  if (cachedDataRoot) return cachedDataRoot;
  const fromEnv = process.env['VSL_STAT_DATA']?.trim();
  const dir = path.resolve(fromEnv || 'data');
  fs.mkdirSync(dir, { recursive: true });
  cachedDataRoot = dir;
  return dir;
}

/** Directory for a managed sub-tree (created on demand). */
export function dataDir(...segments: string[]): string {
  const dir = path.join(dataRoot(), ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ===================== HTTP server ===================== */

export function serverPort(): number {
  const parsed = Number(process.env['PORT']);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4310;
}

export function serverHost(): string {
  return process.env['VSL_STAT_HOST']?.trim() || '0.0.0.0';
}

/**
 * The first admin, created at startup while there is no admin at all.
 * Transitional: without VSL_STAT_ADMIN_PASSWORD the old shared full-access
 * password (VSL_STAT_PASSWORD) is used, so an upgrade doesn't lock the team
 * out before the .env is edited.
 */
export function adminBootstrap(): { login: string; password: string; legacy: boolean } {
  const read = (name: string) => process.env[name]?.trim() ?? '';
  const password = read('VSL_STAT_ADMIN_PASSWORD');
  return {
    login: read('VSL_STAT_ADMIN_LOGIN') || 'admin',
    password: password || read('VSL_STAT_PASSWORD'),
    legacy: !password,
  };
}

export function sessionTtlMs(): number {
  const days = Number(process.env['VSL_STAT_SESSION_DAYS']);
  return (Number.isFinite(days) && days > 0 ? days : 30) * 24 * 60 * 60 * 1000;
}

/** `1` when served over plain HTTP — drops the `Secure` flag on the session cookie. */
export function insecureCookies(): boolean {
  return process.env['VSL_STAT_INSECURE_COOKIES']?.trim() === '1';
}

/** Absolute path to the built Angular bundle. */
export function rendererDir(): string {
  const fromEnv = process.env['VSL_STAT_RENDERER']?.trim();
  return fromEnv
    ? path.resolve(fromEnv)
    : path.resolve(__dirname, '../../dist/vsl-statistic/browser');
}

/** Directory holding the landing-page tracker script (`tracker/t.js`). */
export function trackerDir(): string {
  return path.resolve(__dirname, '../../tracker');
}

/**
 * Public origin of the service, without a trailing slash. Landings load the
 * tracker from it, and Google redirects back to it after consent.
 */
export function publicUrl(): string {
  const raw = process.env['VSL_STAT_PUBLIC_URL']?.trim() || `http://127.0.0.1:${serverPort()}`;
  return raw.replace(/\/+$/, '');
}

/* ===================== Keitaro ===================== */

/** Tracker base URL, e.g. https://tracker.example.com — the same one craft-lander uses. */
export function keitaroUrl(): string {
  return (process.env['KEITARO_URL']?.trim() ?? '').replace(/\/+$/, '');
}

export function keitaroApiKey(): string {
  return process.env['KEITARO_API_KEY']?.trim() ?? '';
}

/* ===================== Kaiten ===================== */

/** Company space, e.g. https://euphoria.kaiten.ru — the dashboard's hiring data. */
export function kaitenUrl(): string {
  return (process.env['KAITEN_URL']?.trim() || 'https://euphoria.kaiten.ru').replace(/\/+$/, '');
}

/** API token of a (preferably read-only) Kaiten user that sees the counted boards. */
export function kaitenToken(): string {
  return process.env['KAITEN_TOKEN']?.trim() ?? '';
}

/* ===================== Namecheap ===================== */

/** Account login; the API user is the same account. */
export function namecheapUser(): string {
  return process.env['NAMECHEAP_USER']?.trim() ?? '';
}

export function namecheapKey(): string {
  return process.env['NAMECHEAP_API_KEY']?.trim() ?? '';
}

/** The server's public IP, whitelisted in Namecheap — every call must name it. */
export function namecheapClientIp(): string {
  return process.env['NAMECHEAP_CLIENT_IP']?.trim() ?? '';
}

/* ===================== Cloudflare ===================== */

export function cloudflareToken(): string {
  return process.env['CLOUDFLARE_API_TOKEN']?.trim() ?? '';
}

export function cloudflareAccountId(): string {
  return process.env['CLOUDFLARE_ACCOUNT_ID']?.trim() ?? '';
}

/** Where working subdomains point: KEITARO_DOMAIN_IP, else the tracker URL's host. */
export function keitaroDomainIp(): string {
  const explicit = process.env['KEITARO_DOMAIN_IP']?.trim();
  if (explicit) return explicit;
  try {
    return new URL(keitaroUrl()).hostname;
  } catch {
    return '';
  }
}

/* ===================== Google Drive ===================== */

export function googleClientId(): string {
  return process.env['GOOGLE_CLIENT_ID']?.trim() ?? '';
}

export function googleClientSecret(): string {
  return process.env['GOOGLE_CLIENT_SECRET']?.trim() ?? '';
}

export function driveFolderId(): string {
  return process.env['DRIVE_FOLDER_ID']?.trim() ?? '';
}

export function googleRedirectUri(): string {
  return `${publicUrl()}/api/drive/oauth/callback`;
}
