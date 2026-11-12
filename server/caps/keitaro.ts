import { keitaroApiKey, keitaroUrl } from '../config';
import { scopedLogger } from '../logger';
import type { KeitaroOffer } from '../../src/shared/api.types';

/**
 * The bits of the Keitaro Admin API the caps need: the offer list and a
 * report of conversions per offer and hour. Auth is the `Api-Key` header,
 * same as craft-lander's client.
 */

const log = scopedLogger('keitaro');

const TIMEOUT_MS = 30_000;
const OFFERS_TTL_MS = 5 * 60_000;

export function keitaroConfigured(): boolean {
  return Boolean(keitaroUrl() && keitaroApiKey());
}

/** A Keitaro Admin API call: GET, or POST when `body` is given, or `method`. */
export async function keitaroCall<T>(pathname: string, body?: unknown, method?: string): Promise<T> {
  return call<T>(pathname, body, method);
}

async function call<T>(pathname: string, body?: unknown, method?: string): Promise<T> {
  if (!keitaroConfigured()) throw new Error('Keitaro не настроен: задай KEITARO_URL и KEITARO_API_KEY в .env.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${keitaroUrl()}${pathname}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        'Api-Key': keitaroApiKey(),
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`Keitaro недоступен: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.warn(`${pathname} → ${res.status}: ${text.slice(0, 500)}`);
    if (res.status === 401 || res.status === 403) throw new Error('Keitaro отклонил API-ключ.');
    throw new Error(`Keitaro ${res.status}: ${text.slice(0, 300)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/* ------------------------- offers ------------------------- */

interface RawOffer {
  id: number | string;
  name: string;
  group_id?: number | string | null;
  affiliate_network_id?: number | null;
  country?: string[] | string | null;
  state?: string | null;
}

let offersCache: { at: number; offers: KeitaroOffer[] } | null = null;

export async function listOffers(fresh = false): Promise<KeitaroOffer[]> {
  if (!fresh && offersCache && Date.now() - offersCache.at < OFFERS_TTL_MS) return offersCache.offers;
  const [offers, groups, networks] = await Promise.all([
    call<RawOffer[]>('/admin_api/v1/offers'),
    call<{ id: number | string; name: string }[]>('/admin_api/v1/groups?type=offers').catch(() => []),
    call<{ id: number | string; name: string }[]>('/admin_api/v1/affiliate_networks').catch(() => []),
  ]);
  const groupName = new Map(groups.map((g) => [Number(g.id), g.name]));
  const networkName = new Map(networks.map((n) => [Number(n.id), n.name]));
  const out = offers
    .filter((o) => o.state !== 'deleted')
    .map((o) => ({
      id: Number(o.id),
      name: String(o.name),
      group: o.group_id != null ? (groupName.get(Number(o.group_id)) ?? null) : null,
      networkId: o.affiliate_network_id ?? null,
      network: o.affiliate_network_id != null ? (networkName.get(Number(o.affiliate_network_id)) ?? null) : null,
      country: Array.isArray(o.country) ? o.country.join(', ') || null : (o.country ?? null),
      archived: o.state === 'archived',
    }))
    .sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.name.localeCompare(b.name));
  offersCache = { at: Date.now(), offers: out };
  return out;
}

/** Partner programs (affiliate networks) by name, for picking the ПП on an offer card. */
export async function listNetworkNames(): Promise<string[]> {
  const nets = await call<{ name: string; state?: string }[]>('/admin_api/v1/affiliate_networks');
  return [...new Set(nets.filter((n) => n.state !== 'deleted').map((n) => String(n.name).trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'ru'),
  );
}

/* ------------------------- report ------------------------- */

/** offer id → leads per hour (0–23) of `date` in `timezone`, every status counted. */
export async function hourlyLeads(
  date: string,
  timezone: string,
  offerIds: number[],
): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (!offerIds.length) return out;
  const body = {
    range: { from: `${date} 00:00:00`, to: `${date} 23:59:59`, timezone },
    dimensions: ['offer_id', 'hour'],
    measures: ['conversions'],
    filters: [{ name: 'offer_id', operator: 'IN_LIST', expression: offerIds }],
    limit: 10_000,
  };
  const res = await call<{ rows?: Record<string, unknown>[] }>('/admin_api/v1/report/build', body);
  for (const row of res.rows ?? []) {
    const offer = Number(row['offer_id']);
    const hour = parseHour(row['hour']);
    const leads = Number(row['conversions'] ?? 0);
    if (!Number.isFinite(offer) || !(hour >= 0 && hour < 24)) continue;
    let hours = out.get(offer);
    if (!hours) out.set(offer, (hours = new Array<number>(24).fill(0)));
    hours[hour]! += leads;
  }
  return out;
}

export interface GroupTotals {
  leads: number;
  sales: number;
  /** Leads still awaiting the network's decision (Keitaro's 'leads'). */
  waiting: number;
  rejected: number;
  /** Payouts of approved leads only (Keitaro's sale_revenue). */
  revenue: number;
  /** Payouts of leads still pending (lead_revenue) — not earned yet. */
  pending: number;
  cost: number;
}

/** Campaign group (= buyer) → totals over [from, to] (YYYY-MM-DD, inclusive) for the offers. */
export async function totalsByGroup(
  from: string,
  to: string,
  timezone: string,
  offerIds: number[],
): Promise<Map<string | null, GroupTotals>> {
  const out = new Map<string | null, GroupTotals>();
  if (!offerIds.length) return out;
  const res = await call<{ rows?: Record<string, unknown>[] }>('/admin_api/v1/report/build', {
    range: { from: `${from} 00:00:00`, to: `${to} 23:59:59`, timezone },
    dimensions: ['campaign_group'],
    // Not 'revenue': it adds the expected payout of still-pending leads.
    measures: ['conversions', 'sales', 'leads', 'rejected', 'sale_revenue', 'lead_revenue', 'cost'],
    filters: [{ name: 'offer_id', operator: 'IN_LIST', expression: offerIds }],
    limit: 1000,
  });
  for (const row of res.rows ?? []) {
    const group = row['campaign_group'] ? String(row['campaign_group']) : null;
    out.set(group, {
      leads: Number(row['conversions'] ?? 0),
      sales: Number(row['sales'] ?? 0),
      waiting: Number(row['leads'] ?? 0),
      rejected: Number(row['rejected'] ?? 0),
      revenue: Number(row['sale_revenue'] ?? 0),
      pending: Number(row['lead_revenue'] ?? 0),
      cost: Number(row['cost'] ?? 0),
    });
  }
  return out;
}

/** `14`, `"14"`, `"14:00"` or `"2026-10-19 14:00:00"` → 14. */
function parseHour(value: unknown): number {
  if (typeof value === 'number') return value;
  const text = String(value ?? '');
  const clock = /(?:^|\s)(\d{1,2}):\d{2}/.exec(text);
  return clock ? Number(clock[1]) : Number(text);
}
