import { db } from '../db';
import { googleConnected, googleFetch } from '../drive/google';
import { scopedLogger } from '../logger';
import type { HistoryEntry, SessionUser } from '../../src/shared/api.types';

/**
 * The admin's view of how the library grows and shrinks: every creative that
 * ever entered it, where it came from, and deletions made through the
 * service.
 */

const log = scopedLogger('creo-history');

export function listHistory(): HistoryEntry[] {
  const rows = db()
    .prepare(
      `SELECT df.id, df.creo_id, df.vertical_id, df.name, df.geo, df.first_seen_at, df.removed,
              df.uploaded_by, up.login AS uploaded_login, df.deleted_at, del.login AS deleted_login
       FROM drive_files df
       LEFT JOIN users up ON up.id = df.uploaded_by
       LEFT JOIN users del ON del.id = df.deleted_by
       ORDER BY df.first_seen_at DESC, df.creo_id DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    fileId: String(r['id']),
    creoId: (r['creo_id'] as string | null) ?? null,
    verticalId: (r['vertical_id'] as number | null) ?? null,
    name: String(r['name']),
    geo: (r['geo'] as string | null) ?? null,
    firstSeenAt: Number(r['first_seen_at'] ?? 0),
    source: r['uploaded_by'] != null ? 'upload' : 'drive',
    uploadedBy: (r['uploaded_login'] as string | null) ?? null,
    removed: r['removed'] === 1 && r['deleted_at'] == null,
    deletedAt: (r['deleted_at'] as number | null) ?? null,
    deletedBy: (r['deleted_login'] as string | null) ?? null,
  }));
}

/**
 * Admin: move a creative's file to the Drive trash (restorable there for 30
 * days) and hide it from the library. The row stays, so its creative ID is
 * never issued again. If Drive refuses, nothing changes here.
 */
export async function deleteCreative(user: SessionUser, id: string): Promise<void> {
  const conn = db();
  const row = conn.prepare('SELECT creo_id, name, removed, deleted_at FROM drive_files WHERE id = ?').get(id) as
    | { creo_id: string | null; name: string; removed: number; deleted_at: number | null }
    | undefined;
  if (!row) throw new Error('Видео не найдено.');
  if (row.deleted_at) return;

  // Already gone from Drive: nothing to trash, just hide it.
  if (!row.removed) {
    if (!googleConnected()) throw new Error('Google Drive не подключён.');
    const res = await googleFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,trashed`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ trashed: true }),
      },
    );
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => '');
      let reason = text.slice(0, 300);
      try {
        reason = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? reason;
      } catch {
        /* not JSON */
      }
      if (res.status === 403) {
        throw new Error(`Drive не дал удалить файл: нет прав (${reason}). Удалить может владелец файла или редактор папки.`);
      }
      throw new Error(`Drive не удалил файл (${res.status}): ${reason}`);
    }
  }

  conn
    .prepare('UPDATE drive_files SET deleted_at = ?, deleted_by = ?, removed = 1 WHERE id = ?')
    .run(Date.now(), user.id, id);
  log.info(`${user.login} удалил ${row.creo_id ?? id} «${row.name}» (в корзину Drive).`);
}
