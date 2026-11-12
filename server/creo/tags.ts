import { db } from '../db';
import { visibleOwnerIds } from '../users';
import type { SessionUser, Tag } from '../../src/shared/api.types';

/**
 * Free-form tags. A tag belongs to whoever created it; only the owner puts it
 * on creatives, renames or deletes it. Who sees it follows the role: a buyer
 * — own tags; a team lead — own and their buyers'; an admin — everyone's.
 * Every read here is filtered by that rule, so the UI can't leak more.
 */

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const DEFAULT_COLOR = '#8c3040';

export function listTags(user: SessionUser): Tag[] {
  const { clause, params } = ownerFilter(user, 't.owner_id');
  const rows = db()
    .prepare(
      `SELECT t.id, t.name, t.color, t.owner_id, u.login AS owner_login,
              (SELECT COUNT(*) FROM file_tags ft JOIN drive_files df ON df.id = ft.file_id
               WHERE ft.tag_id = t.id AND df.removed = 0) AS count
       FROM tags t JOIN users u ON u.id = t.owner_id
       WHERE ${clause}
       ORDER BY (t.owner_id = ?) DESC, u.login COLLATE NOCASE, t.name COLLATE NOCASE`,
    )
    .all(...params, user.id) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r['id']),
    name: String(r['name']),
    color: String(r['color']),
    ownerId: Number(r['owner_id']),
    ownerLogin: String(r['owner_login']),
    mine: Number(r['owner_id']) === user.id,
    count: Number(r['count']),
  }));
}

/** file id → ids of the tags on it the user may see. */
export function visibleTagLinks(user: SessionUser): Map<string, number[]> {
  const { clause, params } = ownerFilter(user, 't.owner_id');
  const rows = db()
    .prepare(`SELECT ft.file_id, ft.tag_id FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ${clause}`)
    .all(...params) as { file_id: string; tag_id: number }[];
  const out = new Map<string, number[]>();
  for (const r of rows) {
    const list = out.get(r.file_id);
    if (list) list.push(r.tag_id);
    else out.set(r.file_id, [r.tag_id]);
  }
  return out;
}

export function saveTag(user: SessionUser, input: { id?: number; name: string; color: string }): Tag {
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) throw new Error('Название тега пустое.');
  const color = COLOR_RE.test(String(input.color)) ? input.color : DEFAULT_COLOR;
  const conn = db();
  const clash = conn
    .prepare('SELECT id FROM tags WHERE owner_id = ? AND name = ? AND id IS NOT ?')
    .get(user.id, name, input.id ?? null);
  if (clash) throw new Error(`У тебя уже есть тег «${name}».`);

  let id = input.id;
  if (id) {
    ownTag(user, id);
    conn.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(name, color, id);
  } else {
    id = Number(
      conn
        .prepare('INSERT INTO tags (owner_id, name, color, created_at) VALUES (?, ?, ?, ?)')
        .run(user.id, name, color, Date.now()).lastInsertRowid,
    );
  }
  return listTags(user).find((t) => t.id === id)!;
}

export function deleteTag(user: SessionUser, id: number): void {
  ownTag(user, id);
  db().prepare('DELETE FROM tags WHERE id = ?').run(id);
}

export function toggleTag(user: SessionUser, fileId: string, tagId: number, on: boolean): void {
  ownTag(user, tagId);
  const conn = db();
  if (!conn.prepare('SELECT 1 FROM drive_files WHERE id = ?').get(fileId)) throw new Error('Видео не найдено.');
  if (on) {
    conn
      .prepare('INSERT OR IGNORE INTO file_tags (file_id, tag_id, created_at) VALUES (?, ?, ?)')
      .run(fileId, tagId, Date.now());
  } else {
    conn.prepare('DELETE FROM file_tags WHERE file_id = ? AND tag_id = ?').run(fileId, tagId);
  }
}

/* ------------------------- internals ------------------------- */

function ownTag(user: SessionUser, id: number): void {
  const row = db().prepare('SELECT owner_id FROM tags WHERE id = ?').get(id) as { owner_id: number } | undefined;
  if (!row) throw new Error('Тег не найден.');
  if (row.owner_id !== user.id) throw new Error('Это чужой тег — менять его может только владелец.');
}

function ownerFilter(user: SessionUser, column: string): { clause: string; params: number[] } {
  const owners = visibleOwnerIds(user);
  if (!owners) return { clause: '1 = 1', params: [] };
  return { clause: `${column} IN (${owners.map(() => '?').join(', ')})`, params: owners };
}
