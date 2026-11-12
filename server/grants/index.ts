import { db } from '../db';
import { keitaroCall } from '../caps/keitaro';
import { scopedLogger } from '../logger';
import { canAccess } from '../users';
import type {
  GrantChange,
  GrantGroup,
  GrantKind,
  GrantLogEntry,
  GrantResult,
  GrantsOverview,
  GrantTeam,
  GrantTeamInput,
  SessionUser,
} from '../../src/shared/api.types';

/**
 * Offer and landing access of Keitaro users ("Доступы"). Keitaro keeps it per
 * user in `access_data`: selected groups and selected single entities. We
 * read it, show who holds what, and add or remove one target for many users
 * at once — the head of buying no longer edits every buyer by hand.
 *
 * Teams (a name, a lead account of ours, Keitaro logins) live here only. The
 * head of buying (the `grants` section, or admin) manages every team and
 * shares to anyone; a team lead manages only teams they lead and shares only
 * to those members.
 */

const log = scopedLogger('grants');

const API = '/admin_api/v1';

/** Which `access_data` lists a target lives in. */
const FIELDS: Record<GrantKind, { list: string; type: string }> = {
  offer_group: { list: 'offers_selected_groups', type: 'offers_access_type' },
  offer: { list: 'offers_selected_entities', type: 'offers_access_type' },
  landing_group: { list: 'landings_selected_groups', type: 'landings_access_type' },
  landing: { list: 'landings_selected_entities', type: 'landings_access_type' },
};

/** What most buyers already have; set only when a user had no offer/landing access at all. */
const DEFAULT_ACCESS_TYPE = 'read_only';

interface RawUser {
  id: number | string;
  login: string;
  type?: string;
  state?: string;
  access_data?: Record<string, unknown> | unknown[] | null;
}

interface RawItem {
  id: number | string;
  name: string;
  group_id?: number | string | null;
  state?: string | null;
}

/* ------------------------- scope ------------------------- */

/** Head of buying (or admin): every team, every buyer. */
function isHead(user: SessionUser): boolean {
  if (user.role === 'admin') return true;
  const row = db()
    .prepare('SELECT r.sections FROM users u JOIN access_roles r ON r.id = u.access_role_id WHERE u.id = ?')
    .get(user.id) as { sections: string } | undefined;
  try {
    return Boolean(row && (JSON.parse(row.sections) as unknown[]).includes('grants'));
  } catch {
    return false;
  }
}

/** Keitaro logins the user may share to; null — anyone. */
function allowedLogins(user: SessionUser): Set<string> | null {
  if (isHead(user)) return null;
  const rows = db()
    .prepare(
      `SELECT m.login FROM grant_team_members m JOIN grant_teams t ON t.id = m.team_id WHERE t.lead_user_id = ?`,
    )
    .all(user.id) as { login: string }[];
  return new Set(rows.map((r) => r.login));
}

export function mayOpenGrants(user: SessionUser): boolean {
  return user.role === 'teamlead' || canAccess(user, 'grants');
}

/* ------------------------- snapshots ------------------------- */

const SNAPSHOT_EVERY_MS = 3 * 60 * 60_000;

/**
 * Keep a copy of every user's access whenever it changed since the last copy —
 * Keitaro has no history of it, and a wrong write (02.11.2026) lost what
 * buyers had. Restore by hand from `keitaro_access_snapshots`.
 */
function snapshotAccess(users: RawUser[]): void {
  const conn = db();
  const last = conn.prepare('SELECT access FROM keitaro_access_snapshots WHERE user_id = ? ORDER BY id DESC LIMIT 1');
  const insert = conn.prepare('INSERT INTO keitaro_access_snapshots (user_id, login, access, taken_at) VALUES (?, ?, ?, ?)');
  const at = Date.now();
  for (const u of users) {
    const access = JSON.stringify(accessOf(u));
    const prev = last.get(Number(u.id)) as { access: string } | undefined;
    if (prev?.access !== access) insert.run(Number(u.id), String(u.login), access, at);
  }
}

export function startAccessSnapshots(): void {
  const run = () =>
    void keitaroCall<RawUser[]>(`${API}/users`)
      .then(snapshotAccess)
      .catch((err) => log.warn(`снимок доступов: ${err instanceof Error ? err.message : err}`));
  setTimeout(run, 30_000);
  setInterval(run, SNAPSHOT_EVERY_MS);
}

/* ------------------------- overview ------------------------- */

export async function grantsOverview(user: SessionUser): Promise<GrantsOverview> {
  const [users, offerGroups, offers, landingGroups, landings] = await Promise.all([
    keitaroCall<RawUser[]>(`${API}/users`),
    keitaroCall<RawItem[]>(`${API}/groups?type=offers`),
    keitaroCall<RawItem[]>(`${API}/offers`),
    keitaroCall<RawItem[]>(`${API}/groups?type=landings`),
    keitaroCall<RawItem[]>(`${API}/landing_pages`),
  ]);
  snapshotAccess(users);
  const buyers = users
    .filter((u) => u.type !== 'ADMIN' && u.state !== 'disabled')
    .map((u) => ({ login: String(u.login), access: accessOf(u) }))
    .sort((a, b) => a.login.localeCompare(b.login));

  const holders = (kind: GrantKind, id: number): string[] =>
    buyers.filter((b) => listOf(b.access, FIELDS[kind].list).includes(String(id))).map((b) => b.login);
  const fullAccess = (field: string): string[] =>
    buyers.filter((b) => b.access[field] === 'full_access').map((b) => b.login);

  const allowed = allowedLogins(user);
  return {
    buyers: buyers.map((b) => b.login),
    offerGroups: grouped(offerGroups, offers, 'offer_group', 'offer', holders),
    landingGroups: grouped(landingGroups, landings, 'landing_group', 'landing', holders),
    fullOffers: fullAccess('offers_access_type'),
    fullLandings: fullAccess('landings_access_type'),
    teams: listTeams(user),
    head: allowed === null,
    shareable: allowed === null ? null : [...allowed].sort(),
    leads: isHead(user) ? teamLeadAccounts() : [],
  };
}

function grouped(
  groups: RawItem[],
  items: RawItem[],
  groupKind: GrantKind,
  itemKind: GrantKind,
  holders: (kind: GrantKind, id: number) => string[],
): GrantGroup[] {
  const live = items.filter((i) => i.state !== 'deleted');
  const byGroup = new Map<number, RawItem[]>();
  for (const i of live) {
    const g = i.group_id == null || i.group_id === '' ? 0 : Number(i.group_id);
    byGroup.set(g, [...(byGroup.get(g) ?? []), i]);
  }
  const out: GrantGroup[] = groups.map((g) => ({
    id: Number(g.id),
    name: String(g.name),
    holders: holders(groupKind, Number(g.id)),
    items: [],
  }));
  // Offers outside any group can only be shared one by one.
  if (byGroup.has(0)) out.push({ id: 0, name: 'Без группы', holders: [], items: [] });
  for (const g of out) {
    g.items = (byGroup.get(g.id) ?? [])
      .map((i) => ({
        id: Number(i.id),
        name: String(i.name),
        archived: i.state === 'archived',
        holders: holders(itemKind, Number(i.id)),
      }))
      .sort((a, b) => b.id - a.id);
  }
  // Newest first: a new offer group is what gets shared most often; loose items last.
  const newest = (g: GrantGroup) => (g.id === 0 ? -1 : Math.max(0, ...g.items.map((i) => i.id)));
  return out.sort((a, b) => newest(b) - newest(a));
}

/* ------------------------- sharing ------------------------- */

/** One write at a time: each one reads and rewrites a user's whole access. */
let queue: Promise<unknown> = Promise.resolve();

/** Most targets one share may carry — a whole page of groups, not the whole tracker. */
const MAX_TARGETS = 200;

/**
 * Apply several changes (targets × logins) as one share: each user's access
 * is read once, changed for every target, written once and re-read to check.
 */
export function applyGrants(user: SessionUser, changes: GrantChange[]): Promise<GrantResult[]> {
  const run = queue.then(() => doApply(user, changes));
  queue = run.catch(() => undefined);
  return run;
}

interface Planned {
  kind: GrantKind;
  id: string;
  name: string;
  add: string[];
  remove: string[];
  /** Logins whose access actually changed for this target. */
  added: string[];
  removed: string[];
  failed: string[];
}

async function doApply(user: SessionUser, changes: GrantChange[]): Promise<GrantResult[]> {
  const planned = mergeChanges(changes);
  if (!planned.length) return [];
  if (planned.length > MAX_TARGETS) throw new Error(`За раз можно пошарить не больше ${MAX_TARGETS} позиций.`);

  const logins = [...new Set(planned.flatMap((p) => [...p.add, ...p.remove]))];
  const allowed = allowedLogins(user);
  const outside = logins.filter((l) => allowed && !allowed.has(l));
  if (outside.length) throw new Error(`Можно выдавать доступ только своей команде. Не в команде: ${outside.join(', ')}`);

  const users = await keitaroCall<RawUser[]>(`${API}/users`);
  snapshotAccess(users);
  const byLogin = new Map(users.map((u) => [String(u.login), u]));
  const results: GrantResult[] = [];

  for (const login of logins) {
    const mine = planned.filter((p) => p.add.includes(login) || p.remove.includes(login));
    const u = byLogin.get(login);
    if (!u) {
      for (const p of mine) p.failed.push(login);
      results.push({ login, ok: false, error: 'нет такого пользователя в Keitaro' });
      continue;
    }
    if (u.type === 'ADMIN') {
      results.push({ login, ok: true, note: 'админ — видит всё' });
      continue;
    }
    const next = accessOf(u);
    const touched: { p: Planned; granting: boolean }[] = [];
    for (const p of mine) {
      const granting = p.add.includes(login);
      const field = FIELDS[p.kind];
      const list = listOf(next, field.list);
      if (granting && next[field.type] === 'full_access') continue;
      if (granting === list.includes(p.id)) continue;
      next[field.list] = granting ? [...list, p.id] : list.filter((x) => x !== p.id);
      if (granting && (!next[field.type] || next[field.type] === 'no_access')) next[field.type] = DEFAULT_ACCESS_TYPE;
      touched.push({ p, granting });
    }
    if (!touched.length) {
      results.push({ login, ok: true, note: 'всё уже было как надо' });
      continue;
    }
    try {
      const before = accessOf(u);
      await writeAccess(Number(u.id), next);
      const after = accessOf(await readUser(Number(u.id)));
      // Anything we did not mean to change moved: put the old access back and stop.
      const lost = untouchedDiff(before, after, new Set(touched.map(({ p }) => FIELDS[p.kind].list)));
      if (lost.length) {
        await writeAccess(Number(u.id), before).catch((err) => log.warn(`откат ${login}: ${err instanceof Error ? err.message : err}`));
        throw new Error(`Keitaro изменил лишнее (${lost.join(', ')}) — вернул как было`);
      }
      const missed = touched.filter(({ p, granting }) => listOf(after, FIELDS[p.kind].list).includes(p.id) !== granting);
      for (const t of touched) {
        if (missed.includes(t)) t.p.failed.push(login);
        else (t.granting ? t.p.added : t.p.removed).push(login);
      }
      const gave = touched.filter((t) => t.granting && !missed.includes(t)).length;
      const took = touched.filter((t) => !t.granting && !missed.includes(t)).length;
      const done = [gave ? `выдано ${gave}` : '', took ? `забрано ${took}` : ''].filter(Boolean).join(', ');
      results.push(
        missed.length
          ? { login, ok: false, note: done || undefined, error: `Keitaro не применил ${missed.length} из ${touched.length}` }
          : { login, ok: true, note: done },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`share → ${login}: ${message}`);
      for (const t of touched) t.p.failed.push(login);
      results.push({ login, ok: false, error: message });
    }
  }

  // One share = one batch in the log, a row per target.
  const conn = db();
  const batch = Number((conn.prepare('SELECT COALESCE(MAX(batch_id), 0) + 1 AS n FROM grant_log').get() as { n: number }).n);
  const insert = conn.prepare(
    `INSERT INTO grant_log (user_id, kind, target_id, target_name, added, removed, failed, created_at, batch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const at = Date.now();
  for (const p of planned) {
    if (!p.added.length && !p.removed.length && !p.failed.length) continue;
    insert.run(user.id, p.kind, Number(p.id), p.name, JSON.stringify(p.added), JSON.stringify(p.removed), JSON.stringify(p.failed), at, batch);
  }
  return results;
}

/** Validate and fold duplicates (the same landing group from two offer groups) into one target each. */
function mergeChanges(changes: GrantChange[]): Planned[] {
  if (!Array.isArray(changes)) throw new Error('Нечего шарить.');
  const out = new Map<string, Planned>();
  for (const c of changes) {
    const kind = c?.target?.kind;
    if (!kind || !(kind in FIELDS)) throw new Error('Неизвестный тип доступа.');
    const id = Number(c.target.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Не выбран оффер или группа.');
    const key = `${kind}:${id}`;
    const p = out.get(key) ?? {
      kind,
      id: String(id),
      name: String(c.target.name ?? '').slice(0, 300),
      add: [],
      remove: [],
      added: [],
      removed: [],
      failed: [],
    };
    p.add = unique([...p.add, ...unique(c.add)]);
    p.remove = unique([...p.remove, ...unique(c.remove)]);
    out.set(key, p);
  }
  for (const p of out.values()) p.remove = p.remove.filter((l) => !p.add.includes(l));
  return [...out.values()].filter((p) => p.add.length || p.remove.length);
}

/**
 * Keitaro takes the whole access object, wrapped as `{ access_data }` — a bare
 * object reads as "no access" and wipes everything the user had (02.11.2026).
 * We send back everything we read with lists changed; never a near-empty one.
 */
async function writeAccess(userId: number, access: Record<string, unknown>): Promise<void> {
  const resources = access['resources'];
  if (!Array.isArray(resources) || !resources.length) {
    throw new Error('у пользователя в Keitaro нет списка разделов — не трогаю, проверь вручную');
  }
  const { allowed_resources: _derived, ...body } = access;
  await keitaroCall(`${API}/users/${userId}/access`, { access_data: body }, 'PUT');
}

async function readUser(userId: number): Promise<RawUser> {
  const users = await keitaroCall<RawUser[]>(`${API}/users`);
  const u = users.find((x) => Number(x.id) === userId);
  if (!u) throw new Error('пользователь пропал из Keitaro');
  return u;
}

function accessOf(u: RawUser): Record<string, unknown> {
  const a = u.access_data;
  return a && !Array.isArray(a) && typeof a === 'object' ? { ...a } : {};
}

/** Fields (other than the ones we changed) whose value differs after a write. */
function untouchedDiff(before: Record<string, unknown>, after: Record<string, unknown>, changed: Set<string>): string[] {
  const norm = (v: unknown) => JSON.stringify(Array.isArray(v) ? v.map(String).sort() : (v ?? null));
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => k !== 'allowed_resources' && !changed.has(k) && !k.endsWith('_access_type') && norm(before[k]) !== norm(after[k]));
}

function listOf(access: Record<string, unknown>, field: string): string[] {
  const v = access[field];
  return Array.isArray(v) ? v.map(String) : [];
}

function unique(list: unknown): string[] {
  return Array.isArray(list) ? [...new Set(list.map((x) => String(x).trim()).filter(Boolean))] : [];
}

/* ------------------------- teams ------------------------- */

interface TeamRow {
  id: number;
  name: string;
  lead_user_id: number | null;
  lead_login: string | null;
}

export function listTeams(user: SessionUser): GrantTeam[] {
  const head = isHead(user);
  const teams = db()
    .prepare(
      `SELECT t.id, t.name, t.lead_user_id, u.login AS lead_login
       FROM grant_teams t LEFT JOIN users u ON u.id = t.lead_user_id
       ORDER BY t.name COLLATE NOCASE`,
    )
    .all() as unknown as TeamRow[];
  const members = db().prepare('SELECT login FROM grant_team_members WHERE team_id = ? ORDER BY login');
  return teams
    .filter((t) => head || t.lead_user_id === user.id)
    .map((t) => ({
      id: t.id,
      name: t.name,
      leadUserId: t.lead_user_id,
      leadLogin: t.lead_login,
      members: (members.all(t.id) as { login: string }[]).map((m) => m.login),
    }));
}

export function saveTeam(user: SessionUser, input: GrantTeamInput): GrantTeam {
  const head = isHead(user);
  const name = String(input?.name ?? '').trim();
  if (!name) throw new Error('Назови команду.');
  if (name.length > 60) throw new Error('Название длиннее 60 символов.');
  const members = unique(input.members);
  const conn = db();
  // A team lead's team is always theirs; the head picks the lead.
  const leadUserId = head ? (input.leadUserId == null ? null : Number(input.leadUserId)) : user.id;
  if (leadUserId != null && !conn.prepare(`SELECT 1 FROM users WHERE id = ? AND active = 1`).get(leadUserId)) {
    throw new Error('Тимлид не найден.');
  }
  const clash = (conn.prepare('SELECT id, name FROM grant_teams').all() as { id: number; name: string }[]).find(
    (t) => t.id !== input.id && t.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'),
  );
  if (clash) throw new Error(`Команда «${clash.name}» уже есть.`);

  let id = input.id ? Number(input.id) : 0;
  conn.exec('BEGIN');
  try {
    if (id) {
      const row = conn.prepare('SELECT lead_user_id FROM grant_teams WHERE id = ?').get(id) as
        | { lead_user_id: number | null }
        | undefined;
      if (!row) throw new Error('Команда не найдена.');
      if (!head && row.lead_user_id !== user.id) throw new Error('Это не твоя команда.');
      conn.prepare('UPDATE grant_teams SET name = ?, lead_user_id = ? WHERE id = ?').run(name, leadUserId, id);
      conn.prepare('DELETE FROM grant_team_members WHERE team_id = ?').run(id);
    } else {
      id = Number(
        conn
          .prepare('INSERT INTO grant_teams (name, lead_user_id, created_at) VALUES (?, ?, ?)')
          .run(name, leadUserId, Date.now()).lastInsertRowid,
      );
    }
    const add = conn.prepare('INSERT INTO grant_team_members (team_id, login) VALUES (?, ?)');
    for (const m of members) add.run(id, m);
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
  return listTeams(user).find((t) => t.id === id)!;
}

export function deleteTeam(user: SessionUser, id: number): void {
  const row = db().prepare('SELECT lead_user_id FROM grant_teams WHERE id = ?').get(id) as
    | { lead_user_id: number | null }
    | undefined;
  if (!row) return;
  if (!isHead(user) && row.lead_user_id !== user.id) throw new Error('Это не твоя команда.');
  db().prepare('DELETE FROM grant_teams WHERE id = ?').run(id);
}

/** Accounts a team can be led by: team leads first, then admins. */
function teamLeadAccounts(): { id: number; login: string }[] {
  return db()
    .prepare(
      `SELECT id, login FROM users WHERE active = 1 AND role IN ('teamlead', 'admin')
       ORDER BY role = 'admin', login COLLATE NOCASE`,
    )
    .all() as { id: number; login: string }[];
}

/* ------------------------- log ------------------------- */

export function grantLog(user: SessionUser, limit = 100): GrantLogEntry[] {
  const head = isHead(user);
  const rows = db()
    .prepare(
      `SELECT g.*, u.login AS by_login FROM grant_log g LEFT JOIN users u ON u.id = g.user_id
       ${head ? '' : 'WHERE g.user_id = ?'} ORDER BY g.id DESC LIMIT ?`,
    )
    .all(...(head ? [limit] : [user.id, limit])) as {
    id: number;
    by_login: string | null;
    kind: GrantKind;
    target_id: number;
    target_name: string;
    added: string;
    removed: string;
    failed: string;
    created_at: number;
    batch_id: number | null;
  }[];
  const parse = (s: string): string[] => {
    try {
      return JSON.parse(s) as string[];
    } catch {
      return [];
    }
  };
  return rows.map((r) => ({
    id: r.id,
    batchId: r.batch_id ?? -r.id,
    at: r.created_at,
    by: r.by_login,
    kind: r.kind,
    targetId: r.target_id,
    targetName: r.target_name,
    added: parse(r.added),
    removed: parse(r.removed),
    failed: parse(r.failed),
  }));
}
