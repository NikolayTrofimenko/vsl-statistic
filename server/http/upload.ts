import type { Request, Response } from 'express';
import { db } from '../db';
import { driveFolderId } from '../config';
import { driveWritable, googleConnected, googleFetch } from '../drive/google';
import { FILE_FIELDS, refreshThumbnails, upsertDriveFile, type DriveFile } from '../drive/sync';
import { sanitizeFileName, uploadToDrive } from '../drive/resumable';
import { wake } from '../creo/transcribe';
import { syncCreoIds } from '../creo/ids';
import { scopedLogger } from '../logger';
import { sessionUser } from './auth';
import { COUNTRIES } from '../../src/shared/geo';

/**
 * Upload a creative into a library folder on Google Drive.
 *
 * The browser sends the raw file; it is piped straight into a Drive resumable
 * upload session, so nothing is buffered on this server. The new file is
 * recorded right away (no waiting for the next sync) and queued for
 * transcription.
 *
 *   POST /api/library/upload?folderId=…&name=…&geo=XX   body: the file
 */

const log = scopedLogger('upload');

const MAX_BYTES = 5 * 1024 * 1024 * 1024;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const THUMB_DELAY_MS = 3 * 60_000;

export async function uploadCreative(req: Request, res: Response): Promise<void> {
  const fail = (status: number, error: string) => {
    if (!res.headersSent) res.status(status).json({ ok: false, error });
  };

  if (!googleConnected()) return fail(409, 'Google Drive не подключён.');
  if (!driveWritable()) {
    return fail(409, 'Подключение Drive только на чтение. Переподключи Drive (полный доступ → ⋮ → «Подключить другой аккаунт»), чтобы разрешить загрузку.');
  }

  const folderId = String(req.query['folderId'] ?? '');
  const folder = db().prepare('SELECT id, path FROM drive_folders WHERE id = ?').get(folderId) as
    | { id: string; path: string }
    | undefined;
  if (!folder && folderId !== driveFolderId()) return fail(400, 'Папка не найдена — синхронизируй библиотеку.');
  const folderPath = folder?.path ?? '';

  const name = sanitizeFileName(String(req.query['name'] ?? ''));
  if (!name) return fail(400, 'Пустое имя файла.');
  if (!VIDEO_EXT.test(name)) return fail(400, 'Загружать можно только видео (mp4, mov, webm, mkv…).');

  const geoParam = String(req.query['geo'] ?? '').toUpperCase();
  const geo = geoParam && geoParam in COUNTRIES ? geoParam : null;

  const length = Number(req.headers['content-length']);
  if (!Number.isFinite(length) || length <= 0) return fail(411, 'Нужен размер файла (Content-Length).');
  if (length > MAX_BYTES) return fail(413, 'Файл больше 5 ГБ.');
  const contentType = String(req.headers['content-type'] || 'video/mp4');

  try {
    const file = await uploadToDrive(req, { name, parentId: folder?.id ?? folderId, contentType, length });

    // 3. Record it now and queue the transcript.
    const conn = db();
    upsertDriveFile(conn, file, folderPath, Date.now());
    conn.prepare('UPDATE drive_files SET uploaded_by = ? WHERE id = ?').run(sessionUser(req)?.id ?? null, file.id);
    if (geo) {
      conn.prepare(`UPDATE drive_files SET geo = ?, geo_source = 'manual' WHERE id = ?`).run(geo, file.id);
    }
    syncCreoIds(conn);
    wake();
    // Drive renders the preview frame (and reads the duration) a little after
    // the upload; pick both up then instead of waiting for the next sync.
    setTimeout(() => void refreshUploaded(file.id, folderPath), THUMB_DELAY_MS).unref();

    log.info(`Загружено «${name}» в «${folderPath || 'корень'}» (${Math.round(length / 1024 / 1024)} МБ).`);
    res.json({ ok: true, data: { id: file.id } });
  } catch (err) {
    if (req.destroyed) return; // the browser cancelled
    log.warn(`Загрузка «${name}» упала`, err);
    fail(502, err instanceof Error ? err.message : String(err));
  }
}

async function refreshUploaded(id: string, folderPath: string): Promise<void> {
  try {
    const res = await googleFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`,
    );
    if (!res.ok) return;
    const file = (await res.json()) as DriveFile;
    upsertDriveFile(db(), file, folderPath, Date.now());
    await refreshThumbnails([file]);
  } catch (err) {
    log.debug(`Превью для ${id} не обновилось`, err);
  }
}
