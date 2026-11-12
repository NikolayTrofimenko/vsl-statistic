import { cloudflareAccountId, cloudflareToken } from '../config';
import { scopedLogger } from '../logger';

/**
 * Cloudflare DNS for the working domains: every root is a zone on one
 * account, every subdomain an A record to the Keitaro server, proxied — the
 * way the existing ones are set up.
 */

const log = scopedLogger('cloudflare');

const API = 'https://api.cloudflare.com/client/v4';

export function cloudflareConfigured(): boolean {
  return Boolean(cloudflareToken() && cloudflareAccountId());
}

const zoneIds = new Map<string, string>();

export async function zoneId(root: string): Promise<string | null> {
  const cached = zoneIds.get(root);
  if (cached) return cached;
  const zones = await call<{ id: string; name: string }[]>(`/zones?name=${encodeURIComponent(root)}&account.id=${cloudflareAccountId()}`);
  const id = zones[0]?.id ?? null;
  if (id) zoneIds.set(root, id);
  return id;
}

/** Add the domain as a zone; returns the name servers to set at the registrar. */
export async function createZone(root: string): Promise<{ id: string; nameServers: string[] }> {
  const existing = await zoneId(root);
  if (existing) {
    const zone = await call<{ id: string; name_servers: string[] }>(`/zones/${existing}`);
    return { id: zone.id, nameServers: zone.name_servers };
  }
  const zone = await call<{ id: string; name_servers: string[] }>('/zones', 'POST', {
    name: root,
    account: { id: cloudflareAccountId() },
    type: 'full',
  });
  zoneIds.set(root, zone.id);
  return { id: zone.id, nameServers: zone.name_servers };
}

/** Point `host` at `ip` (proxied A record); an existing record is updated in place. */
export async function upsertA(zone: string, host: string, ip: string): Promise<void> {
  const found = await call<{ id: string; content: string; proxied: boolean }[]>(
    `/zones/${zone}/dns_records?type=A&name=${encodeURIComponent(host)}`,
  );
  const body = { type: 'A', name: host, content: ip, proxied: true, ttl: 1 };
  if (found[0]) {
    if (found[0].content !== ip || !found[0].proxied) await call(`/zones/${zone}/dns_records/${found[0].id}`, 'PUT', body);
    return;
  }
  await call(`/zones/${zone}/dns_records`, 'POST', body);
}

async function call<T>(pathname: string, method = 'GET', body?: unknown): Promise<T> {
  if (!cloudflareConfigured()) throw new Error('Cloudflare не настроен: нужны CLOUDFLARE_API_TOKEN и CLOUDFLARE_ACCOUNT_ID в .env.');
  let res: Response;
  try {
    res = await fetch(`${API}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${cloudflareToken()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`Cloudflare недоступен: ${err instanceof Error ? err.message : String(err)}`);
  }
  const json = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { message: string }[] } | null;
  if (!res.ok || !json?.success) {
    const message = json?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    log.warn(`${method} ${pathname}: ${message}`);
    throw new Error(`Cloudflare: ${message}`);
  }
  return json.result as T;
}
