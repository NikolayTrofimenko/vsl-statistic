import { createHash } from 'node:crypto';
import type { ApifbSendInput, ApifbSendResult } from '../../src/shared/api.types';

const GRAPH_VERSION = 'v21.0';

/**
 * One-off Facebook Conversions API send — the same job as Keitaro's `/apifb`,
 * for checking that a pixel + token chain works. Token is used only for the
 * Graph call and never written to a log or returned to the client.
 */
export async function sendApifbEvent(input: ApifbSendInput): Promise<ApifbSendResult> {
  const pixelId = String(input?.pixelId ?? '').trim();
  const accessToken = String(input?.accessToken ?? '').trim();
  const eventName = String(input?.eventName ?? '').trim();
  if (!pixelId) throw new Error('Укажи Pixel ID.');
  if (!/^\d+$/.test(pixelId)) throw new Error('Pixel ID — только цифры.');
  if (!accessToken) throw new Error('Укажи access token.');
  if (!eventName) throw new Error('Укажи название события.');

  const eventTime = Math.floor(Date.now() / 1000);
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

  // Meta rejects events with no customer info; UA alone is not enough —
  // need em/ph/fbc/external_id or IP+UA together.
  if (!hasCustomerInfo(userData)) {
    throw new Error(
      'Meta требует хотя бы один идентификатор: email, телефон, IP (вместе с User-Agent), fbclid или external id.',
    );
  }

  const event: Record<string, unknown> = {
    event_name: eventName,
    event_time: eventTime,
    action_source: 'website',
    user_data: userData,
    event_id: `${eventName.toLowerCase()}_${externalId || eventTime}`,
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

  const body: Record<string, unknown> = {
    data: [event],
    access_token: accessToken,
  };
  const testCode = trim(input.testEventCode);
  if (testCode) body.test_event_code = testCode;

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pixelId)}/events`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = (await response.json().catch(() => null)) as Record<string, unknown> | null;

  const safeRequest = { ...body, access_token: '[redacted]' };
  if (!response.ok || raw?.error) {
    const err = (raw?.error ?? {}) as {
      message?: string;
      error_user_msg?: string;
      error_user_title?: string;
      code?: number;
      error_subcode?: number;
      fbtrace_id?: string;
    };
    const detail = [err.error_user_title, err.error_user_msg, err.message]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(' — ');
    return {
      ok: false,
      eventsReceived: null,
      fbtraceId:
        (typeof err.fbtrace_id === 'string' && err.fbtrace_id) ||
        (typeof raw?.fbtrace_id === 'string' ? raw.fbtrace_id : null),
      messages: [],
      error: detail || `Meta ответила HTTP ${response.status}`,
      request: safeRequest,
    };
  }

  return {
    ok: true,
    eventsReceived: typeof raw?.events_received === 'number' ? raw.events_received : null,
    fbtraceId: typeof raw?.fbtrace_id === 'string' ? raw.fbtrace_id : null,
    messages: Array.isArray(raw?.messages) ? raw.messages : [],
    error: null,
    request: safeRequest,
  };
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

/** Digits only; keep a leading country code if the caller pasted +79…. */
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

/** ISO-ish: two-letter country codes lowercased; longer strings hashed as-is after lower. */
function normalizeCountry(value: unknown): string | null {
  const s = trim(value);
  return s ? s.toLowerCase() : null;
}

/**
 * Meta wants `fb.1.<ts>.<fbclid>`. If the caller already pasted a cookie value,
 * leave it; if it's a bare fbclid, wrap it.
 */
function buildFbc(raw: string | null, eventTime: number): string | null {
  if (!raw) return null;
  if (raw.startsWith('fb.')) return raw;
  return `fb.1.${eventTime}000.${raw}`;
}
