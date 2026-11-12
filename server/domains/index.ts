import { db, getSetting, setSetting } from '../db';
import { keitaroDomainIp } from '../config';
import { scopedLogger } from '../logger';
import { keitaroCall, keitaroConfigured } from '../caps/keitaro';
import * as nc from './namecheap';
import * as cf from './cloudflare';
import { rootOf, SUB_NAMES } from '../../src/shared/domains';
import type {
  BuyInput,
  BuyResult,
  DomainCheck,
  DomainsOverview,
  IssueInput,
  IssueResult,
  RenewDecision,
  RenewResult,
  RootDomain,
  RootPatch,
  SessionUser,
  SubdomainSlot,
} from '../../src/shared/api.types';

/**
 * The domain registry. Each root is joined from three places: Namecheap
 * (expiry, DNS), Keitaro (which subdomains exist and whose they are — the
 * source of truth for "issued") and our own table (owner, pixel, ban,
 * renewal call — what used to live only in Илья's sheet). A root has 30
 * standard slots; free = not in Keitaro and not banned.
 *
 * Changes go out in the same order a person would make them: DNS record in
 * Cloudflare first, then the domain in Keitaro (it validates DNS and issues
 * the certificate).
 */

const log = scopedLogger('domains');

const CACHE_MS = 10 * 60_000;
const PRICE_CACHE_MS = 24 * 3600_000;
/** Balance is slow to ask for (~5 s) and changes only when someone pays. */
const BALANCE_MS = 30 * 60_000;
const STANDARD = new Set<string>(SUB_NAMES);

interface KeitaroDomain {
  id: number;
  name: string;
  group: string | null;
  group_id: number | null;
  default_campaign: string | null;
  default_campaign_id: number | null;
  network_status: string | null;
  error_description: string | null;
  state: string;
  created_at: string;
}

interface RootRow {
  name: string;
  owner: string | null;
  team: string | null;
  shared_pixel: number;
  service: number;
  banned_at: number | null;
  renew: RenewDecision | null;
  renew_note: string;
}

let ncCache: { at: number; domains: nc.NcDomain[] } | null = null;
let keitaroCache: { at: number; domains: KeitaroDomain[] } | null = null;
/**
 * Prices (~6 s per list) and the balance (~5 s) never hold up a page: the
 * last known values are served (kept in settings, so a restart keeps them)
 * and refreshed in the background.
 */
const priceCache = new Map<string, { at: number; value: Map<string, number> }>();
let balanceCache: { at: number; value: number | null } | null = null;
const inFlight = new Map<string, Promise<unknown>>();

/** Warm everything at start-up and keep it warm, so the page never waits on a cold cache. */
export function startDomainsWarmup(): void {
  const tick = () => {
    if (!nc.namecheapConfigured() && !keitaroConfigured()) return;
    void Promise.allSettled([
      namecheapData(true),
      keitaroDomains(true),
      refreshBalance(),
      cachedPrices('RENEW', true),
      cachedPrices('REGISTER', true),
    ]);
  };
  setTimeout(tick, 10_000).unref();
  setInterval(tick, CACHE_MS - 60_000).unref();
}

/* ------------------------- reading ------------------------- */

export async function domainsOverview(fresh = false): Promise<DomainsOverview> {
  const errors: string[] = [];
  const [ncData, keitaro] = await Promise.all([
    namecheapData(fresh).catch((err) => (errors.push(message(err)), null)),
    keitaroDomains(fresh).catch((err) => (errors.push(message(err)), null)),
  ]);

  const byRoot = new Map<string, KeitaroDomain[]>();
  for (const d of keitaro ?? []) push(byRoot, rootOf(d.name), d);
  const ncByName = new Map((ncData?.domains ?? []).map((d) => [d.name, d]));
  const rows = new Map(registryRows().map((r) => [r.name, r]));
  const bans = new Map<string, Set<string>>();
  for (const b of db().prepare('SELECT host, root FROM domain_sub_bans').all() as { host: string; root: string }[]) {
    const set = bans.get(b.root) ?? new Set<string>();
    set.add(b.host);
    bans.set(b.root, set);
  }
  const names = new Set([...ncByName.keys(), ...byRoot.keys(), ...rows.keys()]);

  let renewPrices = new Map<string, number>();
  const registerPrices: Record<string, number> = {};
  let pending = false;
  if (ncData && nc.namecheapConfigured()) {
    const renew = knownPrices('RENEW');
    const register = knownPrices('REGISTER');
    pending = !renew || !register || !balanceCache;
    renewPrices = renew ?? new Map();
    for (const tld of new Set([...names].map(tldOf))) {
      const p = register?.get(tld);
      if (p !== undefined) registerPrices[tld] = p;
    }
  }

  const roots: RootDomain[] = [...names].map((name) => {
    const n = ncByName.get(name);
    const subs = byRoot.get(name) ?? [];
    const row = rows.get(name);
    const banned = bans.get(name) ?? new Set<string>();
    const taken = new Set(subs.map((s) => s.name.toLowerCase()));
    const freeSlots = SUB_NAMES.filter((label) => !taken.has(`${label}.${name}`) && !banned.has(`${label}.${name}`)).length;
    return {
      name,
      namecheap: Boolean(n),
      createdAt: n?.createdAt ?? null,
      expiresAt: n?.expiresAt ?? null,
      expired: n?.expired ?? false,
      autoRenew: n?.autoRenew ?? false,
      dns: n ? (n.ourDns ? 'namecheap' : 'other') : null,
      owner: row?.owner ?? null,
      team: row?.team ?? null,
      sharedPixel: row?.shared_pixel === 1,
      service: row?.service === 1,
      banned: row?.banned_at != null,
      renew: row?.renew ?? null,
      renewNote: row?.renew_note ?? '',
      subdomains: subs.length,
      freeSlots: row?.banned_at != null ? 0 : freeSlots,
      bannedSubs: banned.size,
      keitaroErrors: subs.filter((s) => s.network_status === 'error').length,
      buyers: [...new Set(subs.map((s) => s.group).filter((g): g is string => Boolean(g)))].sort(),
      lastAddedAt: subs.reduce<string | null>((max, s) => (!max || s.created_at > max ? s.created_at : max), null),
      renewPrice: n ? (renewPrices.get(tldOf(name)) ?? null) : null,
    };
  });
  roots.sort((a, b) => (a.expiresAt ?? '9999').localeCompare(b.expiresAt ?? '9999') || a.name.localeCompare(b.name));

  return {
    namecheap: nc.namecheapConfigured(),
    keitaro: keitaroConfigured(),
    balance: knownBalance(),
    pending,
    error: errors.length ? errors.join(' · ') : null,
    fetchedAt: Math.min(ncCache?.at ?? Date.now(), keitaroCache?.at ?? Date.now()),
    registerPrices,
    roots,
  };
}

export async function slotsOf(rootArg: string): Promise<SubdomainSlot[]> {
  const root = rootArg.toLowerCase();
  const hosts = new Map((await keitaroDomains(false)).filter((d) => rootOf(d.name) === root).map((d) => [d.name.toLowerCase(), d]));
  const banned = bannedHosts(root);
  const slot = (name: string, host: string, extra: boolean): SubdomainSlot => {
    const d = hosts.get(host);
    return {
      name,
      host,
      state: banned.has(host) ? 'banned' : d ? 'issued' : 'free',
      buyer: d?.group || null,
      campaign: d?.default_campaign_id ? (d.default_campaign || `#${d.default_campaign_id}`) : null,
      ok: !d || d.network_status !== 'error',
      error: d?.error_description || null,
      createdAt: d?.created_at ?? null,
      extra,
    };
  };
  const out = SUB_NAMES.map((label) => slot(label, `${label}.${root}`, false));
  for (const host of hosts.keys()) {
    const label = host.slice(0, -(root.length + 1));
    if (!STANDARD.has(label)) out.push(slot(label || '@', host, true));
  }
  return out;
}

export async function buyerGroups(): Promise<string[]> {
  return [...(await domainGroups()).keys()].sort((a, b) => a.localeCompare(b));
}

/* ------------------------- registry edits ------------------------- */

export function updateRoot(rootArg: string, patch: RootPatch): void {
  const root = rootArg.toLowerCase();
  const row = registryRows().find((r) => r.name === root);
  const next: RootRow = row ?? {
    name: root,
    owner: null,
    team: null,
    shared_pixel: 0,
    service: 0,
    banned_at: null,
    renew: null,
    renew_note: '',
  };
  if (patch.owner !== undefined) next.owner = code(patch.owner);
  if (patch.team !== undefined) next.team = code(patch.team);
  if (patch.sharedPixel !== undefined) next.shared_pixel = patch.sharedPixel ? 1 : 0;
  if (patch.service !== undefined) next.service = patch.service ? 1 : 0;
  if (patch.banned !== undefined) next.banned_at = patch.banned ? (next.banned_at ?? Date.now()) : null;
  if (patch.renew !== undefined) {
    if (patch.renew !== null && !['yes', 'no', 'ask'].includes(patch.renew)) throw new Error('Неизвестное решение по продлению.');
    next.renew = patch.renew;
  }
  if (patch.renewNote !== undefined) next.renew_note = String(patch.renewNote).slice(0, 500);
  saveRow(next);
}

export async function banSub(hostArg: string, banned: boolean, removeFromKeitaro: boolean): Promise<void> {
  const host = hostArg.toLowerCase();
  const conn = db();
  if (banned) {
    conn.prepare('INSERT OR IGNORE INTO domain_sub_bans (host, root, banned_at) VALUES (?, ?, ?)').run(host, rootOf(host), Date.now());
    if (removeFromKeitaro) {
      const d = (await keitaroDomains(true)).find((x) => x.name.toLowerCase() === host);
      if (d) await keitaroCall(`/admin_api/v1/domains/${d.id}`, undefined, 'DELETE');
      keitaroCache = null;
    }
  } else {
    conn.prepare('DELETE FROM domain_sub_bans WHERE host = ?').run(host);
  }
}

/* ------------------------- actions ------------------------- */

export async function issueSubdomains(user: SessionUser, input: IssueInput): Promise<IssueResult[]> {
  const root = String(input.root ?? '').toLowerCase();
  const buyer = code(input.buyer);
  if (!root || !buyer) throw new Error('Нужны домен и баер.');
  const row = registryRows().find((r) => r.name === root);
  if (row?.banned_at) throw new Error(`${root} забанен — на нём ничего не создаём.`);
  if (row?.service) throw new Error(`${root} — служебный домен.`);
  const ip = keitaroDomainIp();
  if (!ip) throw new Error('Не знаю IP Keitaro: задай KEITARO_DOMAIN_IP или KEITARO_URL.');

  const zone = await cf.zoneId(root);
  if (!zone) throw new Error(`${root} нет в Cloudflare — сначала перенеси DNS туда.`);
  const groupId = await ensureGroup(buyer);

  const slots = new Map((await slotsOf(root)).map((s) => [s.name, s]));
  const results: IssueResult[] = [];
  for (const label of [...new Set((input.names ?? []).map((n) => String(n).toLowerCase()))]) {
    const host = `${label}.${root}`;
    const slot = slots.get(label);
    if (!STANDARD.has(label) || !slot) {
      results.push({ host, ok: false, error: 'Не из списка 30 имён.' });
      continue;
    }
    if (slot.state !== 'free') {
      results.push({ host, ok: false, error: slot.state === 'banned' ? 'Слот забанен.' : `Уже выдан (${slot.buyer ?? '—'}).` });
      continue;
    }
    try {
      await cf.upsertA(zone, host, ip);
      await keitaroCall('/admin_api/v1/domains', {
        name: host,
        group_id: groupId,
        is_ssl: true,
        ssl_redirect: true,
        catch_not_found: false,
        allow_indexing: true,
      });
      results.push({ host, ok: true, error: null });
    } catch (err) {
      results.push({ host, ok: false, error: message(err) });
    }
  }
  keitaroCache = null;
  const ok = results.filter((r) => r.ok).length;
  logAction(root, 'issue', user, ok > 0, null, `${buyer}: ${ok}/${results.length}`);
  log.info(`${user.login}: выдал ${buyer} ${ok}/${results.length} поддоменов на ${root}`);
  return results;
}

/** Take every host of the root out of Keitaro — for expired, not renewed or banned roots. */
export async function cleanupRoot(user: SessionUser, rootArg: string): Promise<{ removed: number }> {
  const root = rootArg.toLowerCase();
  if (registryRows().find((r) => r.name === root)?.service) throw new Error(`${root} — служебный домен, его не трогаем.`);
  const hosts = (await keitaroDomains(true)).filter((d) => rootOf(d.name) === root);
  let removed = 0;
  for (const d of hosts) {
    await keitaroCall(`/admin_api/v1/domains/${d.id}`, undefined, 'DELETE');
    removed++;
  }
  keitaroCache = null;
  logAction(root, 'cleanup', user, true, null, `${removed} из Keitaro`);
  log.info(`${user.login}: убрал ${root} из Keitaro (${removed}).`);
  return { removed };
}

/** Renew (or reactivate, if expired) each domain for a year, one by one. */
export async function renewDomains(user: SessionUser, names: string[]): Promise<RenewResult[]> {
  const domains = (await namecheapData(true)).domains;
  const byName = new Map(domains.map((d) => [d.name, d]));
  const results: RenewResult[] = [];
  for (const raw of [...new Set(names.map((n) => String(n).toLowerCase()))]) {
    const d = byName.get(raw);
    let result: RenewResult;
    if (!d) {
      result = { domain: raw, ok: false, charged: null, expiresAt: null, error: 'Домена нет в аккаунте Namecheap.' };
    } else {
      try {
        const outcome = await nc.renew(d.name, d.expired);
        result = { domain: d.name, ok: true, charged: outcome.charged, expiresAt: outcome.expiresAt, error: null };
      } catch (err) {
        result = { domain: d.name, ok: false, charged: null, expiresAt: null, error: message(err) };
      }
    }
    logAction(result.domain, d?.expired ? 'reactivate' : 'renew', user, result.ok, result.charged, result.error);
    log.info(`${user.login}: продление ${result.domain} — ${result.ok ? `ок, $${result.charged}` : result.error}`);
    results.push(result);
  }
  ncCache = null;
  void refreshBalance().catch(() => undefined);
  return results;
}

export async function checkDomains(raw: string[]): Promise<DomainCheck[]> {
  const domains = [...new Set(raw.map((d) => String(d).trim().toLowerCase()).filter((d) => /^[a-z0-9-]+\.[a-z]{2,}$/.test(d)))];
  if (!domains.length) return [];
  const [available, prices] = await Promise.all([nc.check(domains), cachedPrices('REGISTER')]);
  return domains.map((domain) => ({
    domain,
    available: available.get(domain) ?? false,
    price: prices.get(tldOf(domain)) ?? null,
  }));
}

/**
 * Register a new root: Namecheap (same contacts as the existing roots),
 * Cloudflare zone, NS at Namecheap pointed there, the root's own A record,
 * and its owner in the registry. Stops at the first failed step.
 */
export async function buyDomain(user: SessionUser, input: BuyInput): Promise<BuyResult> {
  const domain = String(input.domain ?? '').trim().toLowerCase();
  const result: BuyResult = { domain, ok: false, charged: null, steps: [] };
  const step = async (name: string, fn: () => Promise<string | null>): Promise<boolean> => {
    try {
      result.steps.push({ step: name, ok: true, detail: await fn() });
      return true;
    } catch (err) {
      result.steps.push({ step: name, ok: false, detail: message(err) });
      return false;
    }
  };

  let contacts: Record<string, string> = {};
  let nameServers: string[] = [];
  const ok =
    (await step('Проверка имени', async () => {
      const [check] = await checkDomains([domain]);
      if (!check?.available) throw new Error('Имя занято или недопустимо.');
      return check.price !== null ? `свободно, $${check.price}` : 'свободно';
    })) &&
    (await step('Контакты владельца', async () => {
      const reference = (await namecheapData(false)).domains.find((d) => !d.expired);
      if (!reference) throw new Error('Нет действующего домена, с которого взять контакты.');
      contacts = await nc.contactsOf(reference.name);
      return `как у ${reference.name}`;
    })) &&
    (await step('Регистрация в Namecheap', async () => {
      result.charged = await nc.register(domain, contacts);
      return result.charged !== null ? `списано $${result.charged}` : null;
    })) &&
    (await step('Зона в Cloudflare', async () => {
      nameServers = (await cf.createZone(domain)).nameServers;
      return nameServers.join(', ');
    })) &&
    (await step('NS в Namecheap → Cloudflare', async () => {
      await nc.setNameServers(domain, nameServers);
      return null;
    })) &&
    (await step('A-запись корня', async () => {
      const zone = await cf.zoneId(domain);
      if (!zone) throw new Error('Зона не найдена.');
      await cf.upsertA(zone, domain, keitaroDomainIp());
      return keitaroDomainIp();
    }));

  // Whatever got paid for is recorded with its owner, even if a later step failed.
  if (result.steps.some((s) => s.step === 'Регистрация в Namecheap' && s.ok)) {
    updateRoot(domain, { owner: input.owner, team: input.team, sharedPixel: Boolean(input.sharedPixel) });
  }
  result.ok = ok;
  ncCache = null;
  void refreshBalance().catch(() => undefined);
  logAction(domain, 'buy', user, ok, result.charged, ok ? null : result.steps.find((s) => !s.ok)?.detail ?? null);
  log.info(`${user.login}: покупка ${domain} — ${ok ? 'ок' : 'не до конца'}`);
  return result;
}

/* ------------------------- internals ------------------------- */

function registryRows(): RootRow[] {
  return db().prepare('SELECT * FROM domain_roots').all() as unknown as RootRow[];
}

function saveRow(row: RootRow): void {
  db()
    .prepare(
      `INSERT INTO domain_roots (name, owner, team, shared_pixel, service, banned_at, renew, renew_note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, team = excluded.team,
         shared_pixel = excluded.shared_pixel, service = excluded.service, banned_at = excluded.banned_at,
         renew = excluded.renew, renew_note = excluded.renew_note, updated_at = excluded.updated_at`,
    )
    .run(row.name, row.owner, row.team, row.shared_pixel, row.service, row.banned_at, row.renew, row.renew_note, Date.now());
}

function bannedHosts(root: string): Set<string> {
  return new Set(
    (db().prepare('SELECT host FROM domain_sub_bans WHERE root = ?').all(root) as { host: string }[]).map((r) => r.host),
  );
}

async function namecheapData(fresh: boolean): Promise<{ domains: nc.NcDomain[] }> {
  if (!nc.namecheapConfigured()) return { domains: [] };
  if (!fresh && ncCache && Date.now() - ncCache.at < CACHE_MS) return ncCache;
  return once('nc-list', async () => {
    ncCache = { at: Date.now(), domains: await nc.listDomains() };
    return ncCache;
  });
}

async function keitaroDomains(fresh: boolean): Promise<KeitaroDomain[]> {
  if (!keitaroConfigured()) return [];
  if (!fresh && keitaroCache && Date.now() - keitaroCache.at < CACHE_MS) return keitaroCache.domains;
  return once('keitaro-domains', async () => {
    const domains = (await keitaroCall<KeitaroDomain[]>('/admin_api/v1/domains')).filter((d) => d.state !== 'deleted');
    keitaroCache = { at: Date.now(), domains };
    return domains;
  });
}

/** Last known balance; a stale or missing one is refreshed in the background. */
function knownBalance(): number | null {
  if (!balanceCache) {
    const stored = getSetting('domains.balance');
    if (stored) balanceCache = JSON.parse(stored) as { at: number; value: number | null };
  }
  if (!balanceCache || Date.now() - balanceCache.at > BALANCE_MS) void refreshBalance().catch(() => undefined);
  return balanceCache?.value ?? null;
}

async function refreshBalance(): Promise<void> {
  if (!nc.namecheapConfigured()) return;
  await once('nc-balance', async () => {
    balanceCache = { at: Date.now(), value: await nc.balance() };
    setSetting('domains.balance', JSON.stringify(balanceCache));
  });
}

/** Last known prices without waiting; null until the first fetch lands. */
function knownPrices(action: 'RENEW' | 'REGISTER'): Map<string, number> | null {
  let hit = priceCache.get(action);
  if (!hit) {
    const stored = getSetting(`domains.prices.${action}`);
    if (stored) {
      const parsed = JSON.parse(stored) as { at: number; value: [string, number][] };
      hit = { at: parsed.at, value: new Map(parsed.value) };
      priceCache.set(action, hit);
    }
  }
  if (!hit || Date.now() - hit.at > PRICE_CACHE_MS) void cachedPrices(action, true);
  return hit?.value ?? null;
}

/** Share one request between concurrent callers. */
function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/** Keitaro domain group name → id. */
async function domainGroups(): Promise<Map<string, number>> {
  const groups = await keitaroCall<{ id: number; name: string }[]>('/admin_api/v1/groups?type=domains');
  return new Map(groups.map((g) => [g.name, Number(g.id)]));
}

async function ensureGroup(name: string): Promise<number> {
  const groups = await domainGroups();
  const found = [...groups].find(([g]) => g.toUpperCase() === name.toUpperCase());
  if (found) return found[1];
  // Keitaro answers creates with the entity, sometimes wrapped in an array.
  const created = await keitaroCall<{ id: number } | { id: number }[]>('/admin_api/v1/groups', { name, type: 'domains' });
  log.info(`Создал группу доменов ${name} в Keitaro.`);
  return Number((Array.isArray(created) ? created[0] : created)?.id);
}

/** A day's cache, kept in settings; a failed fetch isn't cached, so the next one retries. */
async function cachedPrices(action: 'RENEW' | 'REGISTER', fresh = false): Promise<Map<string, number>> {
  const hit = priceCache.get(action);
  if (!fresh && hit && Date.now() - hit.at < PRICE_CACHE_MS) return hit.value;
  return once(`nc-prices-${action}`, async () => {
    try {
      const value = await nc.prices(action);
      const entry = { at: Date.now(), value };
      priceCache.set(action, entry);
      setSetting(`domains.prices.${action}`, JSON.stringify({ at: entry.at, value: [...value] }));
      return value;
    } catch (err) {
      log.warn(`Цены ${action} не получены: ${message(err)}`);
      return hit?.value ?? new Map();
    }
  });
}

function logAction(domain: string, action: string, user: SessionUser, ok: boolean, charged: number | null, error: string | null): void {
  db()
    .prepare('INSERT INTO domain_actions (domain, action, user_id, ok, charged, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(domain, action, user.id, ok ? 1 : 0, charged, error, Date.now());
}

/** Buyer / team codes: trimmed, upper-case; '' → null. */
function code(value: string | null | undefined): string | null {
  const text = String(value ?? '').trim().toUpperCase().slice(0, 40);
  return text || null;
}

function tldOf(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
