import * as crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { adminBootstrap } from '../config';
import { db, transaction } from '../db';
import { scopedLogger } from '../logger';
import { DEFAULT_SECTIONS, isSection, SECTIONS } from '../../src/shared/access';
import type { AccessRole, AccessRoleInput, Section, SessionUser, TagScope, UserInfo, UserInput, UserPatch, UserRole } from '../../src/shared/api.types';

/**
 * Personal accounts. Only an admin creates and edits them; there is no
 * self-registration. Passwords are stored as scrypt hashes.
 *
 * A person is either the admin or has one role (`access_roles`): its sections,
 * whose tags it sees, whether it leads a team. `users.role` mirrors that —
 * 'admin', else 'teamlead' when the role leads, else 'buyer' — so checks
 * written against the old base roles keep working.
 */

const log = scopedLogger('users');

const TAG_SCOPES: readonly TagScope[] = ['own', 'team', 'all'];
const LOGIN_RE = /^[\p{L}\p{N}._-]{2,40}$/u;
const MIN_PASSWORD = 8;

/** A signed-in account as the session check sees it. */
export interface AuthUser extends SessionUser {
  sessionGen: number;
}

interface UserRow {
  id: number;
  login: string;
  password_hash: string;
  role: UserRole;
  teamlead_id: number | null;
  access_role_id: number | null;
  active: number;
  session_gen: number;
  created_at: number;
  /** Joined from access_roles. */
  role_name?: string | null;
  role_sections?: string | null;
  role_tag_scope?: string | null;
  role_leads?: number | null;
}

/** A user row with its access role joined in. */
const USER_SELECT = `SELECT u.*, r.name AS role_name, r.sections AS role_sections, r.tag_scope AS role_tag_scope, r.leads AS role_leads
  FROM users u LEFT JOIN access_roles r ON r.id = u.access_role_id`;

/* ------------------------- request context ------------------------- */

const context = new AsyncLocalStorage<SessionUser>();

/** Run an RPC handler on behalf of `user`; handlers read it with currentUser(). */
export function runAs<T>(user: SessionUser, fn: () => T): T {
  return context.run(user, fn);
}

export function currentUser(): SessionUser {
  const user = context.getStore();
  if (!user) throw new Error('Нет пользователя в контексте запроса.');
  return user;
}

/** May this account open the section? An admin may open everything. */
export function canAccess(user: SessionUser, section: Section): boolean {
  return user.role === 'admin' || user.sections.includes(section);
}

/**
 * Whose tags this user may see, by the role's tag scope: own; own and their
 * team's (people attached to them); everyone's (null = no limit).
 */
export function visibleOwnerIds(user: SessionUser): number[] | null {
  if (user.role === 'admin' || user.tagScope === 'all') return null;
  if (user.tagScope !== 'team') return [user.id];
  const buyers = db().prepare('SELECT id FROM users WHERE teamlead_id = ?').all(user.id) as { id: number }[];
  return [user.id, ...buyers.map((b) => b.id)];
}

/* ------------------------- authentication ------------------------- */

/** Active account by login + password, or null. */
export function verifyCredentials(login: string, password: string): AuthUser | null {
  const row = db().prepare(`${USER_SELECT} WHERE u.login = ?`).get(login.trim()) as UserRow | undefined;
  // Hash anyway on a miss, so timing doesn't reveal which logins exist.
  const ok = verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  return row && ok && row.active ? toAuthUser(row) : null;
}

/** Active account by id, for the session check on every request. */
export function findActiveUser(id: number): AuthUser | null {
  const row = db().prepare(`${USER_SELECT} WHERE u.id = ? AND u.active = 1`).get(id) as UserRow | undefined;
  return row ? toAuthUser(row) : null;
}

/** Create the first admin from the environment while there is none. */
export function ensureAdmin(): void {
  const conn = db();
  if (conn.prepare(`SELECT 1 FROM users WHERE role = 'admin' AND active = 1`).get()) return;
  const boot = adminBootstrap();
  if (!boot.password) {
    log.error('Нет ни одного админа и не задан VSL_STAT_ADMIN_PASSWORD — войти будет некому.');
    return;
  }
  const existing = conn.prepare('SELECT id FROM users WHERE login = ?').get(boot.login) as { id: number } | undefined;
  if (existing) {
    conn
      .prepare(`UPDATE users SET role = 'admin', active = 1, password_hash = ?, session_gen = session_gen + 1 WHERE id = ?`)
      .run(hashPassword(boot.password), existing.id);
  } else {
    conn
      .prepare(`INSERT INTO users (login, password_hash, role, active, created_at) VALUES (?, ?, 'admin', 1, ?)`)
      .run(boot.login, hashPassword(boot.password), Date.now());
  }
  log.warn(
    boot.legacy
      ? `Создан админ «${boot.login}» со старым паролем VSL_STAT_PASSWORD — смени его на странице «Пользователи».`
      : `Создан админ «${boot.login}» из VSL_STAT_ADMIN_LOGIN / VSL_STAT_ADMIN_PASSWORD.`,
  );
}

/* ------------------------- admin: manage accounts ------------------------- */

export function listUsers(): UserInfo[] {
  return (db().prepare('SELECT * FROM users ORDER BY active DESC, login COLLATE NOCASE').all() as unknown as UserRow[]).map(
    toInfo,
  );
}

export function createUser(input: UserInput): UserInfo {
  const login = String(input.login ?? '').trim();
  if (!LOGIN_RE.test(login)) throw new Error('Логин: 2–40 символов, буквы, цифры, точка, дефис, подчёркивание.');
  checkPassword(input.password);
  const conn = db();
  if (conn.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) throw new Error(`Логин «${login}» уже занят.`);
  const accessRoleId = input.role === 'admin' ? null : checkAccessRole(input.accessRoleId);
  const role: UserRole = input.role === 'admin' ? 'admin' : baseRoleOf(accessRoleId);
  const teamleadId = role === 'buyer' ? checkTeamlead(input.teamleadId) : null;
  const id = Number(
    conn
      .prepare(
        'INSERT INTO users (login, password_hash, role, teamlead_id, access_role_id, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      )
      .run(login, hashPassword(input.password), role, teamleadId, accessRoleId, Date.now()).lastInsertRowid,
  );
  log.info(`Создан пользователь «${login}» (${role}).`);
  return toInfo(conn.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow);
}

export function updateUser(actor: SessionUser, id: number, patch: UserPatch): void {
  const conn = db();
  const row = conn.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  if (!row) throw new Error('Пользователь не найден.');
  if (id === actor.id && ((patch.role && patch.role !== 'admin') || patch.active === false)) {
    throw new Error('Нельзя снять админа или отключить самого себя.');
  }

  // Admin is picked as such; any other pick is a role, and the base role follows from it.
  const toAdmin = patch.role !== undefined ? patch.role === 'admin' : row.role === 'admin';
  const accessRoleId = toAdmin
    ? null
    : patch.accessRoleId !== undefined
      ? checkAccessRole(patch.accessRoleId)
      : row.access_role_id;
  const role: UserRole = toAdmin ? 'admin' : baseRoleOf(accessRoleId);
  let teamleadId = patch.teamleadId !== undefined ? patch.teamleadId : row.teamlead_id;
  teamleadId = role === 'buyer' ? checkTeamlead(teamleadId, id) : null;
  const active = patch.active !== undefined ? (patch.active ? 1 : 0) : row.active;

  conn
    .prepare(
      'UPDATE users SET role = ?, teamlead_id = ?, access_role_id = ?, active = ?, session_gen = session_gen + ? WHERE id = ?',
    )
    .run(role, teamleadId, accessRoleId, active, active < row.active ? 1 : 0, id);
  // A former team lead no longer leads anyone.
  if (row.role === 'teamlead' && role !== 'teamlead') {
    conn.prepare('UPDATE users SET teamlead_id = NULL WHERE teamlead_id = ?').run(id);
  }
  log.info(`Пользователь «${row.login}»: ${role === 'admin' ? 'админ' : `роль ${accessRoleId ?? 'нет'}`}, ${active ? 'активен' : 'отключён'}.`);
}

/** Reset a password; every session of that account ends. */
export function setPassword(id: number, password: string): void {
  checkPassword(password);
  const result = db()
    .prepare('UPDATE users SET password_hash = ?, session_gen = session_gen + 1 WHERE id = ?')
    .run(hashPassword(password), id);
  if (!result.changes) throw new Error('Пользователь не найден.');
}

/* ------------------------- admin: access roles ------------------------- */

export function listAccessRoles(): AccessRole[] {
  return (
    db()
      .prepare(
        `SELECT r.id, r.name, r.sections, r.tag_scope, r.leads, (SELECT COUNT(*) FROM users u WHERE u.access_role_id = r.id) AS users
         FROM access_roles r ORDER BY r.name COLLATE NOCASE`,
      )
      .all() as { id: number; name: string; sections: string; tag_scope: string; leads: number; users: number }[]
  ).map((r) => ({
    id: r.id,
    name: r.name,
    sections: parseSections(r.sections),
    tagScope: tagScopeOf(r.tag_scope),
    leads: r.leads === 1,
    users: Number(r.users),
  }));
}

export function saveAccessRole(input: AccessRoleInput): AccessRole {
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) throw new Error('Название роли пустое.');
  // Kept in menu order, unknown ids dropped.
  const picked = new Set(input.sections ?? []);
  if (picked.has('offersEdit')) picked.add('offers'); // editing offers means seeing them
  if (picked.has('knowledgeEdit')) picked.add('knowledge');
  const sections = SECTIONS.map((s) => s.id).filter((id) => picked.has(id));
  const conn = db();
  // Compared here, not by SQL: NOCASE folds only ASCII, and role names are Russian.
  const clash = (conn.prepare('SELECT id, name FROM access_roles').all() as { id: number; name: string }[]).some(
    (r) => r.id !== input.id && r.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'),
  );
  if (clash) throw new Error(`Роль «${name}» уже есть.`);
  const before = input.id
    ? (conn.prepare('SELECT tag_scope, leads FROM access_roles WHERE id = ?').get(input.id) as
        | { tag_scope: string; leads: number }
        | undefined)
    : undefined;
  if (input.id && !before) throw new Error('Роль не найдена.');
  const leads = input.leads !== undefined ? Boolean(input.leads) : before?.leads === 1;
  const tagScope: TagScope =
    input.tagScope !== undefined ? tagScopeOf(input.tagScope) : before ? tagScopeOf(before.tag_scope) : leads ? 'team' : 'own';
  let id = input.id;
  transaction(conn, () => {
    if (id) {
      conn
        .prepare('UPDATE access_roles SET name = ?, sections = ?, tag_scope = ?, leads = ? WHERE id = ?')
        .run(name, JSON.stringify(sections), tagScope, leads ? 1 : 0, id);
    } else {
      id = Number(
        conn
          .prepare('INSERT INTO access_roles (name, sections, created_at, tag_scope, leads) VALUES (?, ?, ?, ?, ?)')
          .run(name, JSON.stringify(sections), Date.now(), tagScope, leads ? 1 : 0).lastInsertRowid,
      );
    }
    // Stopped leading: nobody is attached to its people any more. Started: its people are attached to no one.
    if (before?.leads === 1 && !leads) {
      conn
        .prepare(`UPDATE users SET teamlead_id = NULL WHERE teamlead_id IN (SELECT id FROM users WHERE access_role_id = ? AND role != 'admin')`)
        .run(id!);
    }
    if (leads) conn.prepare('UPDATE users SET teamlead_id = NULL WHERE access_role_id = ?').run(id!);
    conn.prepare(`UPDATE users SET role = ? WHERE access_role_id = ? AND role != 'admin'`).run(leads ? 'teamlead' : 'buyer', id!);
  });
  log.info(`Роль «${name}»: ${sections.join(', ') || 'ничего'}, теги ${tagScope}${leads ? ', руководит командой' : ''}.`);
  return listAccessRoles().find((r) => r.id === id)!;
}

export function deleteAccessRole(id: number): void {
  const conn = db();
  // Explicit, not only ON DELETE SET NULL: foreign keys may be off on an old connection.
  transaction(conn, () => {
    conn
      .prepare(`UPDATE users SET teamlead_id = NULL WHERE teamlead_id IN (SELECT id FROM users WHERE access_role_id = ? AND role != 'admin')`)
      .run(id);
    conn.prepare(`UPDATE users SET access_role_id = NULL, role = 'buyer' WHERE access_role_id = ? AND role != 'admin'`).run(id);
    conn.prepare('DELETE FROM access_roles WHERE id = ?').run(id);
  });
}

/* ------------------------- internals ------------------------- */

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    login: row.login,
    role: row.role,
    sections: sectionsOf(row),
    accessRole: row.role === 'admin' ? null : (row.role_name ?? null),
    tagScope: row.role === 'admin' ? 'all' : row.access_role_id != null ? tagScopeOf(row.role_tag_scope) : 'own',
    sessionGen: row.session_gen,
  };
}

/** Admin — everything; an access role — its sections; otherwise the defaults. */
function sectionsOf(row: UserRow): Section[] {
  if (row.role === 'admin') return SECTIONS.map((s) => s.id);
  if (row.access_role_id != null && row.role_sections != null) return parseSections(row.role_sections);
  return [...DEFAULT_SECTIONS];
}

function parseSections(json: string): Section[] {
  try {
    const list = JSON.parse(json) as unknown[];
    return Array.isArray(list) ? list.filter(isSection) : [];
  } catch {
    return [];
  }
}

function checkAccessRole(id: number | null | undefined): number | null {
  if (id == null) return null;
  if (!db().prepare('SELECT 1 FROM access_roles WHERE id = ?').get(id)) throw new Error('Роль доступа не найдена.');
  return Number(id);
}

function toInfo(row: UserRow): UserInfo {
  return {
    id: row.id,
    login: row.login,
    role: row.role,
    teamleadId: row.teamlead_id,
    accessRoleId: row.access_role_id ?? null,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

/** 'teamlead' when the role leads a team, else 'buyer' (no role — the library only). */
function baseRoleOf(accessRoleId: number | null): UserRole {
  if (accessRoleId == null) return 'buyer';
  const r = db().prepare('SELECT leads FROM access_roles WHERE id = ?').get(accessRoleId) as { leads: number } | undefined;
  return r?.leads === 1 ? 'teamlead' : 'buyer';
}

function tagScopeOf(value: unknown): TagScope {
  return TAG_SCOPES.includes(value as TagScope) ? (value as TagScope) : 'own';
}

function checkPassword(password: unknown): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new Error(`Пароль — не короче ${MIN_PASSWORD} символов.`);
  }
}

function checkTeamlead(id: number | null | undefined, self?: number): number | null {
  if (id == null) return null;
  if (id === self) throw new Error('Баер не может быть своим тимлидом.');
  const lead = db().prepare(`SELECT 1 FROM users WHERE id = ? AND role = 'teamlead'`).get(id);
  if (!lead) throw new Error('Руководитель не найден: у его роли должна стоять галочка «руководит командой».');
  return id;
}

/* ------------------------- password hashing ------------------------- */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return crypto.timingSafeEqual(actual, expected);
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));
