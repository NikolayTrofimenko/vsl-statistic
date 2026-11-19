import { createHash } from 'node:crypto';
import type { ApifbEventPayload, ApifbSendInput, ApifbSendResult } from '../../src/shared/api.types';

const GRAPH_VERSION = 'v21.0';
/** Meta allows large batches; keep modest to stay under proxy timeouts. */
export const META_EVENT_CHUNK = 50;
const FETCH_TIMEOUT_MS = 45_000;

/**
 * One-off Facebook Conversions API send — the same job as Keitaro's `/apifb`.
 * Token is used only for the Graph call and never logged or returned.
 */
export async function sendApifbEvent(input: ApifbSendInput): Promise<ApifbSendResult> {
  const { pixelId, accessToken, testEventCode, ...event } = input;
  return sendApifbEventChunk(pixelId, accessToken, [event], testEventCode);
}

/** Up to ~50 events in one Graph POST (CAPI `data` array). */
export async function sendApifbEventChunk(
  pixelIdRaw: string,
  accessTokenRaw: string,
  events: ApifbEventPayload[],
  testEventCode?: string | null,
): Promise<ApifbSendResult> {
  const pixelId = String(pixelIdRaw ?? '').trim();
  const accessToken = String(accessTokenRaw ?? '').trim();
  if (!pixelId) throw new Error('Укажи Pixel ID.');
  if (!/^\d+$/.test(pixelId)) throw new Error('Pixel ID — только цифры.');
  if (!accessToken) throw new Error('Укажи access token.');
  if (!events.length) throw new Error('Нет событий.');

  const data: Record<string, unknown>[] = [];
  const buildErrors: string[] = [];
  for (let i = 0; i < events.length; i++) {
    try {
      data.push(buildGraphEvent(events[i]));
    } catch (err) {
      buildErrors.push(`#${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!data.length) {
    return {
      ok: false,
      eventsReceived: null,
      fbtraceId: null,
      messages: [],
      error: buildErrors.join('; ') || 'Нечего отправлять.',
      request: null,
    };
  }

  const body: Record<string, unknown> = {
    data,
    access_token: accessToken,
  };
  const testCode = trim(testEventCode);
  if (testCode) body.test_event_code = testCode;

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pixelId)}/events`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const msg =
      err instanceof Error && err.name === 'AbortError'
        ? `Meta не ответила за ${FETCH_TIMEOUT_MS / 1000}с`
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      ok: false,
      eventsReceived: null,
      fbtraceId: null,
      messages: [],
      error: msg,
      request: { dataCount: data.length, access_token: '[redacted]' },
    };
  } finally {
    clearTimeout(timer);
  }

  const raw = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const safeRequest = { dataCount: data.length, access_token: '[redacted]', ...(testCode ? { test_event_code: testCode } : {}) };

  if (!response.ok || raw?.error) {
    const err = (raw?.error ?? {}) as {
      message?: string;
      error_user_msg?: string;
      error_user_title?: string;
      fbtrace_id?: string;
    };
    const detail = [err.error_user_title, err.error_user_msg, err.message]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(' — ');
    const suffix = buildErrors.length ? ` · пропущено при сборке: ${buildErrors.length}` : '';
    return {
      ok: false,
      eventsReceived: null,
      fbtraceId:
        (typeof err.fbtrace_id === 'string' && err.fbtrace_id) ||
        (typeof raw?.fbtrace_id === 'string' ? raw.fbtrace_id : null),
      messages: [],
      error: (detail || `Meta ответила HTTP ${response.status}`) + suffix,
      request: safeRequest,
    };
  }

  return {
    ok: true,
    eventsReceived: typeof raw?.events_received === 'number' ? raw.events_received : data.length,
    fbtraceId: typeof raw?.fbtrace_id === 'string' ? raw.fbtrace_id : null,
    messages: Array.isArray(raw?.messages) ? raw.messages : [],
    error: buildErrors.length ? `Часть строк не собрана: ${buildErrors.join('; ')}` : null,
    request: safeRequest,
  };
}

function buildGraphEvent(input: ApifbEventPayload): Record<string, unknown> {
  const eventName = String(input?.eventName ?? '').trim();
  if (!eventName) throw new Error('Нет названия события.');

  const eventTime =
    input.eventTime != null && Number.isFinite(Number(input.eventTime)) && Number(input.eventTime) > 1_000_000_000
      ? Math.floor(Number(input.eventTime))
      : Math.floor(Date.now() / 1000);

  const userData: Record<string, string> = {};
  putHash(userData, 'em', normalizeEmail(input.email));
  putHash(userData, 'ph', normalizePhone(input.phone));
  putHash(userData, 'fn', normalizeName(input.firstName));
  putHash(userData, 'ln', normalizeName(input.lastName));
  putHash(userData, 'ct', normalizeName(input.city));
  putHash(userData, 'country', normalizeCountry(input.country));

  const clientIp = trim(input.clientIp);
  const userAgent = trim(input.userAgent);
  const externalId = trim(input.externalId);
  if (clientIp) userData.client_ip_address = clientIp;
  if (userAgent) userData.client_user_agent = userAgent;
  if (externalId) userData.external_id = externalId;

  const fbc = buildFbc(trim(input.fbc), eventTime);
  if (fbc) userData.fbc = fbc;

  if (!hasCustomerInfo(userData)) {
    throw new Error('нет идентификатора (phone/email/IP+UA/…)');
  }

  const event: Record<string, unknown> = {
    event_name: eventName,
    event_time: eventTime,
    action_source: 'website',
    user_data: userData,
    event_id: `${eventName.toLowerCase()}_${externalId || eventTime}_${Math.random().toString(36).slice(2, 8)}`,
  };
  const sourceUrl = trim(input.eventSourceUrl);
  if (sourceUrl) event.event_source_url = sourceUrl;

  const value = input.value;
  if (value != null && Number.isFinite(Number(value))) {
    event.custom_data = {
      value: Number(value),
      currency: (trim(input.currency) || 'USD').toUpperCase(),
    };
  }
  return event;
}

function hasCustomerInfo(userData: Record<string, string>): boolean {
  if (userData.em || userData.ph || userData.fbc || userData.external_id) return true;
  if (userData.client_ip_address && userData.client_user_agent) return true;
  if (userData.fn && userData.ln) return true;
  return false;
}

function putHash(out: Record<string, string>, key: string, value: string | null): void {
  if (!value) return;
  out[key] = sha256(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function trim(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}

function normalizeEmail(value: unknown): string | null {
  const s = trim(value);
  return s ? s.toLowerCase() : null;
}

function normalizePhone(value: unknown): string | null {
  const s = trim(value);
  if (!s) return null;
  const digits = s.replace(/\D+/g, '');
  return digits || null;
}

function normalizeName(value: unknown): string | null {
  const s = trim(value);
  return s ? s.toLowerCase() : null;
}

function normalizeCountry(value: unknown): string | null {
  const s = trim(value);
  return s ? s.toLowerCase() : null;
}

function buildFbc(raw: string | null, eventTime: number): string | null {
  if (!raw) return null;
  if (raw.startsWith('fb.')) return raw;
  return `fb.1.${eventTime}000.${raw}`;
}
