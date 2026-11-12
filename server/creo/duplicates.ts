import { db } from '../db';
import type { DuplicateMark, SessionUser } from '../../src/shared/api.types';

/**
 * "Это повтор": anyone may flag a creative as a repeat of another, optionally
 * naming the original by its creative ID. One mark per person per creative.
 * A person sees only their own marks; the admin sees everyone's and either
 * deletes the creative or clears the marks ("не повтор").
 */

const CREO_ID_RE = /^[A-Z]{3}-\d{4,}$/;

/** file id → marks on it the user may see. */
export function visibleDuplicateMarks(user: SessionUser): Map<string, DuplicateMark[]> {
  const all = user.role === 'admin';
  const rows = db()
    .prepare(
      `SELECT dm.file_id, dm.user_id, u.login, dm.original_id, dm.created_at
       FROM duplicate_marks dm JOIN users u ON u.id = dm.user_id
       ${all ? '' : 'WHERE dm.user_id = ?'}
       ORDER BY dm.created_at`,
    )
    .all(...(all ? [] : [user.id])) as {
    file_id: string;
    user_id: number;
    login: string;
    original_id: string | null;
    created_at: number;
  }[];
  const out = new Map<string, DuplicateMark[]>();
  for (const r of rows) {
    const mark: DuplicateMark = {
      userId: r.user_id,
      login: r.login,
      originalId: r.original_id,
      createdAt: r.created_at,
      mine: r.user_id === user.id,
    };
    const list = out.get(r.file_id);
    if (list) list.push(mark);
    else out.set(r.file_id, [mark]);
  }
  return out;
}

export function markDuplicate(user: SessionUser, fileId: string, rawOriginal: string | null): DuplicateMark {
  const conn = db();
  const file = conn.prepare('SELECT creo_id FROM drive_files WHERE id = ? AND deleted_at IS NULL').get(fileId) as
    | { creo_id: string | null }
    | undefined;
  if (!file) throw new Error('Видео не найдено.');

  let originalId: string | null = String(rawOriginal ?? '').trim().toUpperCase() || null;
  if (originalId) {
    if (!CREO_ID_RE.test(originalId)) throw new Error(`«${originalId}» не похоже на ID крео (например, SUS-0087).`);
    if (originalId === file.creo_id) throw new Error('Крео не может быть повтором самого себя.');
    if (!conn.prepare('SELECT 1 FROM drive_files WHERE creo_id = ?').get(originalId)) {
      throw new Error(`Крео ${originalId} не найдено.`);
    }
  }

  const now = Date.now();
  conn
    .prepare(
      `INSERT INTO duplicate_marks (file_id, user_id, original_id, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(file_id, user_id) DO UPDATE SET original_id = excluded.original_id, created_at = excluded.created_at`,
    )
    .run(fileId, user.id, originalId, now);
  return { userId: user.id, login: user.login, originalId, createdAt: now, mine: true };
}

export function unmarkDuplicate(user: SessionUser, fileId: string): void {
  db().prepare('DELETE FROM duplicate_marks WHERE file_id = ? AND user_id = ?').run(fileId, user.id);
}

/** Admin: "не повтор" — every mark on the creative goes. */
export function clearDuplicates(fileId: string): void {
  db().prepare('DELETE FROM duplicate_marks WHERE file_id = ?').run(fileId);
}
