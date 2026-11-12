import Anthropic from '@anthropic-ai/sdk';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Agent, fetch as undiciFetch } from 'undici';
import { db } from '../db';
import { googleConnected, googleFetch } from '../drive/google';
import { scopedLogger } from '../logger';
import { translateToRussian, translationConfigured } from './translate';
import type { CreoQueueState } from '../../src/shared/api.types';

/**
 * Background queue: transcribe each library video, then translate it.
 *
 * One video at a time — the whisper sidecar shares the server's CPU with
 * other apps. The file is streamed from Drive straight into the sidecar, so
 * nothing is stored here. Newest uploads go first, so a creative someone just
 * added is readable within minutes even while the backlog is still running.
 *
 * Statuses: `pending` → `done` | `failed`. A translation that could not run
 * (no API key yet, a transient error) is retried on its own later; it never
 * sends the video through whisper again.
 */

const log = scopedLogger('creo-queue');

const IDLE_POLL_MS = 60_000;
/** After the sidecar or Drive is unreachable, wait before trying again. */
const BACKOFF_MS = 2 * 60_000;
/**
 * A detection weaker than this is not trusted as the creative's language. Low on
 * purpose: whisper reports ~0.3 even for clear, single-language speech.
 */
const MIN_LANGUAGE_PROBABILITY = 0.15;

// Transcribing a long video takes far longer than fetch's default 5-minute
// wait for response headers.
const whisperAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

let running = false;
let wakeTimer: NodeJS.Timeout | null = null;
let current: { id: string; name: string; step: 'transcribe' | 'translate'; startedAt: number } | null = null;
let lastError: string | null = null;
/** Translation stopped by an account-level API error (credit, key, limits). */
let translationPause: { until: number; reason: string } | null = null;
const TRANSLATION_PAUSE_MS = 10 * 60_000;

export function whisperUrl(): string {
  return process.env['WHISPER_URL']?.trim().replace(/\/+$/, '') ?? '';
}

export function startCreoQueue(): void {
  if (!whisperUrl()) {
    log.warn('WHISPER_URL не задан — расшифровка крео выключена.');
    return;
  }
  wake(10_000);
}

/** Look for work now (after a sync, an upload, a manual retry). */
export function wake(delayMs = 0): void {
  if (!whisperUrl()) return;
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => void drain(), delayMs);
  wakeTimer.unref();
}

export function queueState(): CreoQueueState {
  const counts = db()
    .prepare(
      `SELECT transcribe_status AS s, COUNT(*) AS n FROM drive_files WHERE removed = 0 GROUP BY transcribe_status`,
    )
    .all() as { s: string; n: number }[];
  const by = Object.fromEntries(counts.map((c) => [c.s, c.n]));
  const untranslated = (db().prepare(untranslatedSql('COUNT(*) AS n')).get() as { n: number }).n;
  return {
    enabled: Boolean(whisperUrl()),
    translationEnabled: translationConfigured(),
    pending: by['pending'] ?? 0,
    done: by['done'] ?? 0,
    failed: by['failed'] ?? 0,
    untranslated,
    current: current ? { id: current.id, name: current.name, step: current.step } : null,
    lastError,
    translationPaused: translationPause && translationPause.until > Date.now() ? translationPause.reason : null,
  };
}

/** Put a video back in the queue (manual "retry"). */
export function requeue(id: string): void {
  db()
    .prepare(
      `UPDATE drive_files SET transcribe_status = 'pending', transcribe_error = NULL,
         translate_error = NULL, transcript_ru = NULL WHERE id = ?`,
    )
    .run(id);
  wake();
}

/* ------------------------- internals ------------------------- */

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  let next = IDLE_POLL_MS;
  try {
    while (true) {
      const progressed = await step();
      if (!progressed) break;
    }
    lastError = null;
  } catch (err) {
    // Infrastructure trouble (sidecar down, Drive unreachable): not the
    // video's fault, so it stays pending and the whole queue backs off.
    lastError = err instanceof Error ? err.message : String(err);
    log.warn(`Очередь расшифровки на паузе: ${lastError}`);
    next = BACKOFF_MS;
  } finally {
    running = false;
    current = null;
    wake(next);
  }
}

/** Do one unit of work. False when there is nothing to do. */
async function step(): Promise<boolean> {
  if (!googleConnected()) return false;

  const pending = db()
    .prepare(
      `SELECT id, name FROM drive_files WHERE removed = 0 AND transcribe_status = 'pending'
       ORDER BY COALESCE(created_at, modified_at) DESC LIMIT 1`,
    )
    .get() as { id: string; name: string } | undefined;
  if (pending) {
    await transcribeOne(pending.id, pending.name);
    return true;
  }

  if (translationConfigured() && !(translationPause && translationPause.until > Date.now())) {
    const untranslated = db()
      .prepare(untranslatedSql('id, name, transcript, lang') + ' LIMIT 1')
      .get() as { id: string; name: string; transcript: string; lang: string | null } | undefined;
    if (untranslated) {
      await translateOne(untranslated.id, untranslated.name, untranslated.transcript, untranslated.lang);
      return true;
    }
  }
  return false;
}

function untranslatedSql(select: string): string {
  return `SELECT ${select} FROM drive_files
    WHERE removed = 0 AND transcribe_status = 'done' AND transcript <> ''
      AND COALESCE(lang, '') <> 'ru' AND transcript_ru IS NULL AND translate_error IS NULL
    ORDER BY COALESCE(created_at, modified_at) DESC`;
}

async function transcribeOne(id: string, name: string): Promise<void> {
  current = { id, name, step: 'transcribe', startedAt: Date.now() };
  const started = Date.now();

  const source = await googleFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
  );
  if (source.status === 404 || source.status === 403) {
    markFailed(id, `Drive не отдаёт файл (${source.status}).`);
    return;
  }
  if (!source.ok || !source.body) throw new Error(`Drive ответил ${source.status} на скачивание.`);

  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
  const length = source.headers.get('content-length');
  if (length) headers['Content-Length'] = length;

  const res = await undiciFetch(`${whisperUrl()}/transcribe`, {
    method: 'POST',
    headers,
    // Node stream: undici takes it as-is, and the file is never held in memory.
    body: Readable.fromWeb(source.body as unknown as WebReadableStream),
    duplex: 'half',
    dispatcher: whisperAgent,
  });
  const payload = (await res.json().catch(() => null)) as {
    text?: string;
    language?: string;
    language_probability?: number;
    error?: string;
  } | null;

  if (!res.ok || !payload || typeof payload.text !== 'string') {
    // 4xx = this file can't be decoded; 5xx = the sidecar itself is in trouble.
    if (res.status >= 400 && res.status < 500) {
      markFailed(id, payload?.error ?? `whisper ответил ${res.status}`);
      return;
    }
    throw new Error(payload?.error ?? `whisper ответил ${res.status}`);
  }

  const lang =
    payload.text && (payload.language_probability ?? 0) >= MIN_LANGUAGE_PROBABILITY
      ? (payload.language ?? null)
      : null;
  db()
    .prepare(
      `UPDATE drive_files SET transcript = ?, lang = ?, transcribe_status = 'done',
         transcribe_error = NULL, transcribed_at = ?, transcript_ru = NULL, translate_error = NULL
       WHERE id = ?`,
    )
    .run(payload.text, lang, Date.now(), id);
  log.info(`Расшифровано «${name}» (${lang ?? '—'}) за ${Math.round((Date.now() - started) / 1000)} с.`);
}

async function translateOne(id: string, name: string, transcript: string, lang: string | null): Promise<void> {
  current = { id, name, step: 'translate', startedAt: Date.now() };
  try {
    const ru = await translateToRussian(transcript, lang);
    db().prepare('UPDATE drive_files SET transcript_ru = ?, translate_error = NULL WHERE id = ?').run(ru, id);
    translationPause = null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Anthropic.APIError) {
      // The account, not the video: no credit, bad key, rate limit, outage.
      // Pause translation only — transcription keeps going — and resume on
      // its own once the API answers again, with nothing to re-queue.
      translationPause = { until: Date.now() + TRANSLATION_PAUSE_MS, reason: message.slice(0, 300) };
      log.warn(`Перевод на паузе: ${message}`);
      return;
    }
    // Something about this text (a refusal, an empty answer): kept on the
    // video so it doesn't stall the rest; "Заново" retries it.
    db().prepare('UPDATE drive_files SET translate_error = ? WHERE id = ?').run(message.slice(0, 500), id);
    log.warn(`Перевод «${name}» не удался: ${message}`);
  }
}

function markFailed(id: string, error: string): void {
  db()
    .prepare(`UPDATE drive_files SET transcribe_status = 'failed', transcribe_error = ? WHERE id = ?`)
    .run(error.slice(0, 500), id);
  log.warn(`Расшифровка ${id} не удалась: ${error}`);
}
