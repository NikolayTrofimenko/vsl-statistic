import { db } from '../db';
import type { CreoReport, SessionUser } from '../../src/shared/api.types';

/**
 * "Ошибка": anyone may flag a mistake in a creative's card — wrong geo,
 * wrong vertical — with a short comment ("это не Испания, это венгерский").
 * One open report per person per creative; a person sees their own, the
 * admin sees all, fixes the card and closes them ("Исправлено"). Closed
 * reports stay for the record.
 */

const MAX_TEXT = 500;

/** file id → open reports the user may see. */
export function visibleReports(user: SessionUser): Map<string, CreoReport[]> {
  const all = user.role === 'admin';
  const rows = db()
    .prepare(
      `SELECT r.id, r.file_id, r.user_id, u.login, r.text, r.created_at
       FROM creo_reports r JOIN users u ON u.id = r.user_id
       WHERE r.resolved_at IS NULL ${all ? '' : 'AND r.user_id = ?'}
       ORDER BY r.created_at`,
    )
    .all(...(all ? [] : [user.id])) as {
    id: number;
    file_id: string;
    user_id: number;
    login: string;
    text: string;
    created_at: number;
  }[];
  const out = new Map<string, CreoReport[]>();
  for (const r of rows) {
    const report: CreoReport = {
      id: r.id,
      userId: r.user_id,
      login: r.login,
      text: r.text,
      createdAt: r.created_at,
      mine: r.user_id === user.id,
    };
    const list = out.get(r.file_id);
    if (list) list.push(report);
    else out.set(r.file_id, [report]);
  }
  return out;
}

/** Create or reword the user's open report on a creative. */
export function saveReport(user: SessionUser, fileId: string, raw: string): CreoReport {
  const text = String(raw ?? '').trim().slice(0, MAX_TEXT);
  if (!text) throw new Error('Напиши, что не так с крео.');
  const conn = db();
  if (!conn.prepare('SELECT 1 FROM drive_files WHERE id = ? AND deleted_at IS NULL').get(fileId)) {
    throw new Error('Видео не найдено.');
  }
  const now = Date.now();
  const open = conn
    .prepare('SELECT id FROM creo_reports WHERE file_id = ? AND user_id = ? AND resolved_at IS NULL')
    .get(fileId, user.id) as { id: number } | undefined;
  let id: number;
  if (open) {
    conn.prepare('UPDATE creo_reports SET text = ?, created_at = ? WHERE id = ?').run(text, now, open.id);
    id = open.id;
  } else {
    id = Number(
      conn
        .prepare('INSERT INTO creo_reports (file_id, user_id, text, created_at) VALUES (?, ?, ?, ?)')
        .run(fileId, user.id, text, now).lastInsertRowid,
    );
  }
  return { id, userId: user.id, login: user.login, text, createdAt: now, mine: true };
}

/** Withdraw the user's own open report. */
export function removeReport(user: SessionUser, fileId: string): void {
  db().prepare('DELETE FROM creo_reports WHERE file_id = ? AND user_id = ? AND resolved_at IS NULL').run(fileId, user.id);
}

/** Admin: the card is fixed — close every open report on it. */
export function resolveReports(user: SessionUser, fileId: string): void {
  db()
    .prepare('UPDATE creo_reports SET resolved_at = ?, resolved_by = ? WHERE file_id = ? AND resolved_at IS NULL')
    .run(Date.now(), user.id, fileId);
}
