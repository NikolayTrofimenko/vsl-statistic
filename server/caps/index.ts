import { db, transaction } from '../db';
import type { DatabaseSync } from 'node:sqlite';
import { hourlyLeads, keitaroConfigured, listOffers, totalsByGroup } from './keitaro';
import { telegramConfigured } from '../notify/telegram';
import { matchesRule } from '../../src/shared/caps-rule';
import type {
  CapBuyerRow,
  CapBuyers,
  CapDay,
  CapInput,
  CapRule,
  CapsReport,
  CapStatus,
  KeitaroOffer,
} from '../../src/shared/api.types';

/**
 * Caps: a partner allows N leads a day on an offer; every landing's leads
 * for it add up. A cap is a set of Keitaro offers (they sit in Keitaro groups
 * that don't line up with caps). Usually it is a rule — the partner, maybe a
 * geo and words in the name — so offers added later count by themselves;
 * offers can be excluded from it, or a cap can list offers by hand. Counted
 * per day in Moscow time, every conversion status included.
 */

export const CAPS_TIMEZONE = 'Europe/Moscow';
/** The pace behind the forecast: leads per hour over this many recent hours. */
const PACE_HOURS = 3;
/** "Недолив" below this share of the limit by the end of the day. */
const UNDER_SHARE = 0.9;
const REPORT_TTL_MS = 60_000;

let cache: { key: string; at: number; data: Map<number, number[]> } | null = null;

interface CapRow {
  id: number;
  name: string;
  daily_limit: number;
  note: string;
  active: number;
  rule_network_id: number | null;
  rule_country: string | null;
  rule_name: string;
}

export async function capsReport(dateArg?: string | null): Promise<CapsReport> {
  const today = dayIn(CAPS_TIMEZONE, new Date());
  const date = dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? dateArg : today;
  const isToday = date === today;
  const elapsedHours = isToday ? hoursIntoDay(CAPS_TIMEZONE, new Date()) : 24;
  const conn = db();

  const caps = conn.prepare('SELECT * FROM caps ORDER BY active DESC, name COLLATE NOCASE').all() as unknown as CapRow[];
  let error: string | null = null;

  // Rule caps: resolve against Keitaro's current offers, so new ones join.
  // Without Keitaro the last resolved set stands.
  let offers: KeitaroOffer[] | null = null;
  if (keitaroConfigured() && caps.length) {
    try {
      offers = await listOffers();
      const resolved = offers;
      transaction(conn, () => {
        for (const cap of caps) if (cap.rule_network_id != null) storeResolved(conn, cap.id, resolveRule(conn, cap, resolved));
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  const networkName = new Map((offers ?? []).map((o) => [o.networkId, o.network]));
  const offerById = new Map((offers ?? []).map((o) => [o.id, o]));
  const distinct = (values: (string | null | undefined)[]) =>
    [...new Set(values.filter((v): v is string => Boolean(v)))].sort();

  const links = conn.prepare('SELECT cap_id, offer_id, offer_name FROM cap_offers').all() as {
    cap_id: number;
    offer_id: number;
    offer_name: string;
  }[];
  const excluded = conn.prepare('SELECT cap_id, offer_id FROM cap_excluded').all() as { cap_id: number; offer_id: number }[];
  const offerIds = [...new Set(links.map((l) => l.offer_id))].sort((x, y) => x - y);

  let hourly = new Map<number, number[]>();
  let fetchedAt: number | null = null;
  if (keitaroConfigured() && offerIds.length) {
    const key = `${date}|${offerIds.join(',')}`;
    if (cache && cache.key === key && Date.now() - cache.at < REPORT_TTL_MS) {
      hourly = cache.data;
      fetchedAt = cache.at;
    } else {
      try {
        hourly = await hourlyLeads(date, CAPS_TIMEZONE, offerIds);
        cache = { key, at: Date.now(), data: hourly };
        fetchedAt = cache.at;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const out: CapDay[] = caps.map((cap) => {
    const own = links.filter((l) => l.cap_id === cap.id);
    const hours = new Array<number>(24).fill(0);
    const capOffers = own.map((l) => {
      const perHour = hourly.get(l.offer_id) ?? [];
      perHour.forEach((n, h) => (hours[h]! += n));
      return { id: l.offer_id, name: l.offer_name, leads: perHour.reduce((sum, n) => sum + n, 0) };
    });
    capOffers.sort((x, y) => y.leads - x.leads);
    const leads = hours.reduce((sum, n) => sum + n, 0);
    const projected = isToday ? project(hours, elapsedHours) : null;
    const rule = ruleOf(cap);
    return {
      id: cap.id,
      name: cap.name,
      dailyLimit: cap.daily_limit,
      note: cap.note,
      active: cap.active === 1,
      rule: rule ? { ...rule, networkName: networkName.get(rule.networkId) ?? null } : null,
      networks: rule
        ? distinct([networkName.get(rule.networkId)])
        : distinct(own.map((l) => offerById.get(l.offer_id)?.network)),
      countries: rule?.country
        ? [rule.country]
        : distinct(own.map((l) => offerById.get(l.offer_id)?.country)),
      excludedIds: excluded.filter((e) => e.cap_id === cap.id).map((e) => e.offer_id),
      offers: capOffers,
      leads,
      projected,
      status: statusOf(leads, projected ?? leads, cap.daily_limit),
      hourly: hours,
    };
  });

  return {
    configured: keitaroConfigured(),
    date,
    isToday,
    timezone: CAPS_TIMEZONE,
    elapsedHours,
    fetchedAt,
    error,
    telegram: telegramConfigured(),
    caps: out,
  };
}

export async function saveCap(input: CapInput): Promise<void> {
  const name = String(input.name ?? '').trim().slice(0, 80);
  if (!name) throw new Error('Название капы пустое.');
  const limit = Math.round(Number(input.dailyLimit));
  if (!(limit > 0)) throw new Error('Лимит — целое число больше нуля.');
  const ids = (list: unknown[] | undefined) =>
    [...new Set((list ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const rule: CapRule | null = input.rule
    ? {
        networkId: Number(input.rule.networkId),
        country: input.rule.country ? String(input.rule.country).slice(0, 80) : null,
        nameContains: String(input.rule.nameContains ?? '').trim().slice(0, 120),
      }
    : null;
  if (rule && !(rule.networkId > 0)) throw new Error('Выбери партнёрку.');
  const offerIds = rule ? [] : ids(input.offerIds);
  if (!rule && !offerIds.length) throw new Error('Выбери хотя бы один оффер Keitaro.');
  const excludedIds = rule ? ids(input.excludedIds) : [];

  const offers = await listOffers().catch(() => null);
  if (rule && !offers) throw new Error('Keitaro недоступен — не могу проверить, какие офферы попадут под правило.');
  // Name snapshots, so a cap still reads well if an offer is gone from Keitaro.
  const names = new Map((offers ?? []).map((o) => [o.id, o.name]));

  const conn = db();
  transaction(conn, () => {
    let id = input.id;
    const note = String(input.note ?? '').slice(0, 500);
    const active = input.active === false ? 0 : 1;
    const params = [name, limit, note, active, rule?.networkId ?? null, rule?.country ?? null, rule?.nameContains ?? ''];
    if (id) {
      const res = conn
        .prepare(
          'UPDATE caps SET name = ?, daily_limit = ?, note = ?, active = ?, rule_network_id = ?, rule_country = ?, rule_name = ? WHERE id = ?',
        )
        .run(...params, id);
      if (!res.changes) throw new Error('Капа не найдена.');
    } else {
      id = Number(
        conn
          .prepare(
            'INSERT INTO caps (name, daily_limit, note, active, rule_network_id, rule_country, rule_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(...params, Date.now()).lastInsertRowid,
      );
    }
    conn.prepare('DELETE FROM cap_excluded WHERE cap_id = ?').run(id);
    const exclude = conn.prepare('INSERT INTO cap_excluded (cap_id, offer_id) VALUES (?, ?)');
    for (const offerId of excludedIds) exclude.run(id, offerId);

    if (rule) {
      const row = conn.prepare('SELECT * FROM caps WHERE id = ?').get(id) as unknown as CapRow;
      storeResolved(conn, id, resolveRule(conn, row, offers!));
    } else {
      const old = new Map(
        (conn.prepare('SELECT offer_id, offer_name FROM cap_offers WHERE cap_id = ?').all(id) as {
          offer_id: number;
          offer_name: string;
        }[]).map((r) => [r.offer_id, r.offer_name]),
      );
      storeResolved(conn, id, offerIds.map((offerId) => ({ id: offerId, name: names.get(offerId) ?? old.get(offerId) ?? `#${offerId}` })));
    }
  });
  cache = null;
}

function ruleOf(cap: CapRow): CapRule | null {
  return cap.rule_network_id == null
    ? null
    : { networkId: cap.rule_network_id, country: cap.rule_country, nameContains: cap.rule_name };
}

/** Offers a rule cap takes right now: the rule's matches minus its exclusions. */
function resolveRule(conn: DatabaseSync, cap: CapRow, offers: KeitaroOffer[]): { id: number; name: string }[] {
  const rule = ruleOf(cap)!;
  const excluded = new Set(
    (conn.prepare('SELECT offer_id FROM cap_excluded WHERE cap_id = ?').all(cap.id) as { offer_id: number }[]).map(
      (r) => r.offer_id,
    ),
  );
  return offers.filter((o) => matchesRule(o, rule) && !excluded.has(o.id)).map((o) => ({ id: o.id, name: o.name }));
}

function storeResolved(conn: DatabaseSync, capId: number, offers: { id: number; name: string }[]): void {
  conn.prepare('DELETE FROM cap_offers WHERE cap_id = ?').run(capId);
  const link = conn.prepare('INSERT INTO cap_offers (cap_id, offer_id, offer_name) VALUES (?, ?, ?)');
  for (const o of offers) link.run(capId, o.id, o.name);
}

/**
 * Who fills a cap: each buyer's (campaign group's) leads on the day, and
 * payback over the `days` up to it — the head of buying hands a cut cap to
 * whoever earns most on it. ROI needs a window: sales are approved days
 * after the lead, so a single day's revenue says nothing.
 */
export async function capBuyers(capId: number, dateArg: string, daysArg: number): Promise<CapBuyers> {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? dateArg : dayIn(CAPS_TIMEZONE, new Date());
  const days = [1, 7, 14, 30].includes(daysArg) ? daysArg : 1;
  const offerIds = (db().prepare('SELECT offer_id FROM cap_offers WHERE cap_id = ?').all(capId) as { offer_id: number }[]).map(
    (r) => r.offer_id,
  );
  const from = shiftDay(date, -(days - 1));
  const [day, window] = await Promise.all([
    totalsByGroup(date, date, CAPS_TIMEZONE, offerIds),
    totalsByGroup(from, date, CAPS_TIMEZONE, offerIds),
  ]);
  const groups = new Set([...day.keys(), ...window.keys()]);
  const rows: CapBuyerRow[] = [...groups].map((buyer) => {
    const w = window.get(buyer) ?? { leads: 0, sales: 0, waiting: 0, rejected: 0, revenue: 0, pending: 0, cost: 0 };
    const costMissing = w.cost <= 0;
    return {
      buyer,
      dayLeads: day.get(buyer)?.leads ?? 0,
      leads: w.leads,
      sales: w.sales,
      waiting: w.waiting,
      rejected: w.rejected,
      revenue: round2(w.revenue),
      pending: round2(w.pending),
      cost: round2(w.cost),
      costMissing,
      profit: costMissing ? null : round2(w.revenue - w.cost),
      roi: costMissing ? null : Math.round(((w.revenue - w.cost) / w.cost) * 1000) / 10,
      roiIfApproved: costMissing ? null : Math.round(((w.revenue + w.pending - w.cost) / w.cost) * 1000) / 10,
    };
  });
  rows.sort((a, b) => b.dayLeads - a.dayLeads || b.leads - a.leads);
  return { date, days, rows: rows.filter((r) => r.dayLeads || r.leads || r.cost) };
}

function shiftDay(date: string, delta: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function deleteCap(id: number): void {
  db().prepare('DELETE FROM caps WHERE id = ?').run(id);
}

/* ------------------------- internals ------------------------- */

/** Leads so far plus the recent pace over the rest of the day. */
function project(hours: number[], elapsed: number): number {
  const done = hours.reduce((s, n) => s + n, 0);
  if (elapsed <= 0) return done;
  // Whole hourly buckets from PACE_HOURS ago up to the current (partial) one.
  const first = Math.floor(Math.max(0, elapsed - PACE_HOURS));
  let recent = 0;
  for (let h = first; h <= Math.min(23, Math.floor(elapsed)); h++) recent += hours[h] ?? 0;
  const pace = recent / (elapsed - first);
  return Math.round(done + pace * Math.max(0, 24 - elapsed));
}

function statusOf(leads: number, projected: number, limit: number): CapStatus {
  if (leads > limit) return 'over';
  if (projected > limit) return 'risk';
  if (projected < limit * UNDER_SHARE) return 'under';
  return 'ok';
}

function dayIn(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

function hoursIntoDay(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get('hour') + get('minute') / 60;
}
