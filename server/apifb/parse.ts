import type { ApifbEventPayload } from '../../src/shared/api.types';

/**
 * APIFB dump line (same as Keitaro `/apifb`):
 * event_name#ip#user_agent#name#phone#email#country#city#clickid#payout#url#pixel#access_token#time_unix
 *
 * Pixel and token from the line are ignored — the caller supplies new ones.
 */
export function parseApifbLines(text: string): ParsedApifbLine[] {
  const out: ParsedApifbLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !line.includes('#')) continue;
    // Skip obvious non-event noise from a Doc export.
    if (/^(http|https):\/\//i.test(line)) continue;
    const parsed = parseApifbLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

export interface ParsedApifbLine {
  raw: string;
  input: ApifbEventPayload;
}

export function parseApifbLine(line: string): ParsedApifbLine | null {
  const parts = line.split('#');
  if (parts.length < 10) return null;
  const eventName = (parts[0] ?? '').trim();
  if (!eventName || !/^[A-Za-z][A-Za-z0-9_]*$/.test(eventName)) return null;

  const ip = emptyToNull(parts[1]);
  const ua = emptyToNull(parts[2]);
  const fullName = emptyToNull(parts[3]);
  const phone = emptyToNull(parts[4]);
  const email = emptyToNull(parts[5]);
  const country = emptyToNull(parts[6]);
  const city = emptyToNull(parts[7]);
  const clickid = emptyToNull(parts[8]);
  const payoutRaw = emptyToNull(parts[9]);
  const sourceUrl = emptyToNull(parts[10]);
  // parts[11] pixel, parts[12] token — ignored
  const timeRaw = emptyToNull(parts[13]);

  const { firstName, lastName } = splitName(fullName);
  const value = payoutRaw != null && Number.isFinite(Number(payoutRaw)) ? Number(payoutRaw) : null;
  const eventTime = parseUnix(timeRaw);

  return {
    raw: line,
    input: {
      eventName,
      clientIp: ip,
      userAgent: ua,
      firstName,
      lastName,
      phone,
      email,
      country,
      city,
      externalId: clickid,
      eventSourceUrl: sourceUrl,
      value,
      currency: value != null ? 'USD' : null,
      eventTime,
      fbc: null,
    },
  };
}

function splitName(full: string | null): { firstName: string | null; lastName: string | null } {
  if (!full) return { firstName: null, lastName: null };
  const bits = full.trim().split(/\s+/);
  if (bits.length === 1) return { firstName: bits[0], lastName: null };
  return { firstName: bits[0], lastName: bits.slice(1).join(' ') };
}

function parseUnix(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1_000_000_000) return null;
  // ms timestamps by mistake
  if (n > 10_000_000_000) return Math.floor(n / 1000);
  return Math.floor(n);
}

function emptyToNull(value: string | undefined): string | null {
  const s = (value ?? '').trim();
  return s || null;
}
