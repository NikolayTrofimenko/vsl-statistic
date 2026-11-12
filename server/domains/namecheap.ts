import { namecheapClientIp, namecheapKey, namecheapUser } from '../config';
import { scopedLogger } from '../logger';

/**
 * Namecheap XML API: the account's domains, balance, prices, renewal.
 * Calls only work from a whitelisted IP (the server's), and every one
 * repeats the credentials as query parameters. Responses are flat enough
 * for a few regexes instead of an XML parser.
 */

const log = scopedLogger('namecheap');

const API = 'https://api.namecheap.com/xml.response';

export function namecheapConfigured(): boolean {
  return Boolean(namecheapUser() && namecheapKey() && namecheapClientIp());
}

export interface NcDomain {
  name: string;
  createdAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  autoRenew: boolean;
  ourDns: boolean;
}

export async function listDomains(): Promise<NcDomain[]> {
  const out: NcDomain[] = [];
  for (let page = 1; page < 50; page++) {
    const xml = await call('namecheap.domains.getList', { PageSize: '100', Page: String(page) });
    const domains = tags(xml, 'Domain');
    for (const d of domains) {
      out.push({
        name: d['Name']!.toLowerCase(),
        createdAt: isoDate(d['Created']),
        expiresAt: isoDate(d['Expires']),
        expired: d['IsExpired'] === 'true',
        autoRenew: d['AutoRenew'] === 'true',
        ourDns: d['IsOurDNS'] === 'true',
      });
    }
    const total = Number(/<TotalItems>(\d+)<\/TotalItems>/.exec(xml)?.[1] ?? 0);
    if (!domains.length || out.length >= total) break;
  }
  return out;
}

export async function balance(): Promise<number> {
  const xml = await call('namecheap.users.getBalances');
  return Number(tags(xml, 'UserGetBalancesResult')[0]?.['AvailableBalance'] ?? NaN);
}

/**
 * TLD → USD for one year of `action`, ICANN fee included. One call for every
 * TLD: asking per TLD trips Namecheap's rate limit at once.
 */
export async function prices(action: 'RENEW' | 'REGISTER'): Promise<Map<string, number>> {
  const xml = await call('namecheap.users.getPricing', { ProductType: 'DOMAIN', ActionName: action });
  const out = new Map<string, number>();
  for (const block of xml.matchAll(/<Product Name="([^"]+)">([\s\S]*?)<\/Product>/g)) {
    const year = tags(block[2]!, 'Price').find((p) => p['Duration'] === '1' && p['DurationType'] === 'YEAR');
    if (!year) continue;
    const base = Number(year['YourPrice'] ?? year['Price']);
    const fee = Number(year['YourAdditonalCost'] ?? year['AdditionalCost'] ?? 0);
    if (Number.isFinite(base)) out.set(block[1]!.toLowerCase(), Math.round((base + fee) * 100) / 100);
  }
  return out;
}

export interface RenewOutcome {
  charged: number | null;
  expiresAt: string | null;
}

/** Extend by a year; an already expired domain has to be reactivated instead. */
export async function renew(domain: string, expired: boolean): Promise<RenewOutcome> {
  if (expired) {
    const xml = await call('namecheap.domains.reactivate', { DomainName: domain, YearsToAdd: '1' });
    const r = tags(xml, 'DomainReactivateResult')[0] ?? {};
    if (r['IsSuccess'] !== 'true') throw new Error('Namecheap не подтвердил восстановление.');
    return { charged: num(r['ChargedAmount']), expiresAt: null };
  }
  const xml = await call('namecheap.domains.renew', { DomainName: domain, Years: '1' });
  const r = tags(xml, 'DomainRenewResult')[0] ?? {};
  if (r['Renew'] !== 'true') throw new Error('Namecheap не подтвердил продление.');
  return {
    charged: num(r['ChargedAmount']),
    expiresAt: isoDate(/<ExpiredDate>([^<]+)<\/ExpiredDate>/.exec(xml)?.[1]),
  };
}

/** Whether each name can be registered (premium names count as taken). */
export async function check(domains: string[]): Promise<Map<string, boolean>> {
  const xml = await call('namecheap.domains.check', { DomainList: domains.join(',') });
  const out = new Map<string, boolean>();
  for (const r of tags(xml, 'DomainCheckResult')) {
    out.set(r['Domain']!.toLowerCase(), r['Available'] === 'true' && r['IsPremiumName'] !== 'true');
  }
  return out;
}

const CONTACT_FIELDS = [
  'OrganizationName', 'JobTitle', 'FirstName', 'LastName', 'Address1', 'Address2', 'City',
  'StateProvince', 'StateProvinceChoice', 'PostalCode', 'Country', 'Phone', 'Fax', 'EmailAddress',
] as const;

/**
 * The registrant of an existing domain — a new one is registered with the
 * same contacts. The first <Registrant> block is the real one; the second is
 * the WhoisGuard mask.
 */
export async function contactsOf(domain: string): Promise<Record<string, string>> {
  const xml = await call('namecheap.domains.getContacts', { DomainName: domain });
  const block = /<Registrant ReadOnly="false">([\s\S]*?)<\/Registrant>/.exec(xml)?.[1];
  if (!block) throw new Error(`Не нашёл контакты владельца у ${domain}.`);
  const out: Record<string, string> = {};
  for (const field of CONTACT_FIELDS) {
    const value = new RegExp(`<${field}>([^<]*)</${field}>`).exec(block)?.[1];
    if (value) out[field] = decode(value);
  }
  return out;
}

/** Register for a year with privacy on; returns what was charged. */
export async function register(domain: string, contacts: Record<string, string>): Promise<number | null> {
  const params: Record<string, string> = {
    DomainName: domain,
    Years: '1',
    AddFreeWhoisguard: 'yes',
    WGEnabled: 'yes',
  };
  for (const role of ['Registrant', 'Tech', 'Admin', 'AuxBilling']) {
    for (const [field, value] of Object.entries(contacts)) params[`${role}${field}`] = value;
  }
  const xml = await call('namecheap.domains.create', params);
  const r = tags(xml, 'DomainCreateResult')[0] ?? {};
  if (r['Registered'] !== 'true') throw new Error('Namecheap не подтвердил регистрацию.');
  return num(r['ChargedAmount']);
}

/** Hand the domain's DNS to custom name servers (Cloudflare's). */
export async function setNameServers(domain: string, nameServers: string[]): Promise<void> {
  const dot = domain.indexOf('.');
  const xml = await call('namecheap.domains.dns.setCustom', {
    SLD: domain.slice(0, dot),
    TLD: domain.slice(dot + 1),
    Nameservers: nameServers.join(','),
  });
  if (tags(xml, 'DomainDNSSetCustomResult')[0]?.['Updated'] !== 'true') {
    throw new Error('Namecheap не подтвердил смену NS.');
  }
}

/* ------------------------- internals ------------------------- */

async function call(command: string, params: Record<string, string> = {}): Promise<string> {
  if (!namecheapConfigured()) {
    throw new Error('Namecheap не настроен: нужны NAMECHEAP_USER, NAMECHEAP_API_KEY и NAMECHEAP_CLIENT_IP в .env.');
  }
  const query = new URLSearchParams({
    ApiUser: namecheapUser(),
    ApiKey: namecheapKey(),
    UserName: namecheapUser(),
    ClientIp: namecheapClientIp(),
    Command: command,
    ...params,
  });
  let res: Response;
  try {
    // POST: a registration carries four sets of contacts — too long for a URL.
    res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: query.toString(),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new Error(`Namecheap недоступен: ${err instanceof Error ? err.message : String(err)}`);
  }
  const xml = await res.text();
  if (!res.ok || !/<ApiResponse Status="OK"/.test(xml)) {
    const errors = [...xml.matchAll(/<Error Number="(\d+)">([^<]*)<\/Error>/g)].map((m) => `${m[2]} (${m[1]})`);
    const message = errors.join('; ') || `HTTP ${res.status}`;
    log.warn(`${command}: ${message}`);
    throw new Error(`Namecheap: ${message}`);
  }
  return xml;
}

/** Attributes of every `<name …>` element. */
function tags(xml: string, name: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const m of xml.matchAll(new RegExp(`<${name}\\s([^>]*?)/?>`, 'g'))) {
    const attrs: Record<string, string> = {};
    for (const a of m[1]!.matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]!] = decode(a[2]!);
    out.push(attrs);
  }
  return out;
}

function decode(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** "09/24/2026" → "2026-09-24". */
function isoDate(value: string | undefined): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(value ?? '');
  return m ? `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}` : null;
}

function num(value: string | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
