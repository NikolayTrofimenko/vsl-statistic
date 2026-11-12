import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataRoot } from './config';
import { scopedLogger } from './logger';

/**
 * Symmetric encryption for stored credentials (the Google refresh token).
 *
 * The key comes from `VSL_STAT_SECRET`; when unset, a random key is generated
 * once and kept in the data directory, so a plain `docker run` with a mounted
 * volume works without extra setup.
 *
 * Stored form: `v1.<base64(iv | authTag | ciphertext)>`.
 */

const log = scopedLogger('secrets');

const PREFIX = 'v1.';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_FILE = '.secret-key';

let cachedKey: Buffer | null = null;

export function encryptSecret(plain: string): string {
  const trimmed = plain.trim();
  if (!trimmed) return '';
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(trimmed, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/** Decrypt a stored secret; '' for anything unreadable (missing, other key). */
export function decryptSecret(stored: string | null | undefined): string {
  if (!stored || !stored.startsWith(PREFIX)) return '';
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    log.warn('Не удалось расшифровать секрет — вероятно, сменился VSL_STAT_SECRET.');
    return '';
  }
}

/** Purpose-scoped 32-byte key, so subsystems never share key material. */
export function deriveKey(purpose: string): Buffer {
  return crypto.createHmac('sha256', key()).update(purpose).digest();
}

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env['VSL_STAT_SECRET']?.trim();
  cachedKey = fromEnv
    ? crypto.createHash('sha256').update(fromEnv, 'utf8').digest()
    : loadOrCreateKeyFile();
  return cachedKey;
}

function loadOrCreateKeyFile(): Buffer {
  const file = path.join(dataRoot(), KEY_FILE);
  try {
    const buf = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (buf.length === 32) return buf;
    log.warn(`${KEY_FILE} повреждён — генерирую новый ключ.`);
  } catch {
    /* first run — fall through and generate */
  }
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(file, generated.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  log.info(`VSL_STAT_SECRET не задан — сгенерировал ключ в ${file}. Не удаляй его.`);
  return generated;
}
