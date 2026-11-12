import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataDir, driveFolderId } from '../config';
import { db, transaction } from '../db';
import { scopedLogger } from '../logger';
import { googleConnected, googleFetch } from './google';
import type { SyncState } from '../../src/shared/api.types';
import { geoFromName } from '../../src/shared/geo';
import { wake } from '../creo/transcribe';
import { syncCreoIds } from '../creo/ids';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Mirror the Drive library folder into `drive_files`.
 *
 * Walks the folder tree from `DRIVE_FOLDER_ID`, upserts every video's
 * metadata, caches a preview frame, and flags files that disappeared as
 * `removed` rather than deleting them — a landing's stats may still link to
 * one. Only metadata is pulled; the video itself stays on Drive and is
 * streamed through `/api/drive/stream/:id` when someone presses play.
 */

const log = scopedLogger('drive-sync');

const API = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const FILE_FIELDS =
  'id,name,mimeType,size,createdTime,modifiedTime,thumbnailLink,webViewLink,videoMediaMetadata';
/** Thumbnail requested from Google, in px on the long side. */
const THUMB_SIZE = 640;
const THUMB_CONCURRENCY = 6;
/** Re-sync automatically this often while connected. */
const AUTO_SYNC_MS = 30 * 60 * 1000;

const state: SyncState = {
  running: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastError: null,
  lastCount: null,
};

export function syncState(): SyncState {
  return { ...state };
}

/** Start a sync unless one is already running; resolves when it finishes. */
export async function runSync(): Promise<SyncState> {
  if (state.running) return syncState();
  state.running = true;
  state.lastStartedAt = Date.now();
  state.lastError = null;
  try {
    state.lastCount = await syncLibrary();
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    log.warn(`Синхронизация упала: ${state.lastError}`);
  } finally {
    state.running = false;
    state.lastFinishedAt = Date.now();
  }
  return syncState();
}

export function startAutoSync(): void {
  const tick = () => {
    if (googleConnected() && driveFolderId()) void runSync();
  };
  setTimeout(tick, 5_000).unref();
  setInterval(tick, AUTO_SYNC_MS).unref();
}

export function thumbPath(id: string): string {
  // Drive ids are [A-Za-z0-9_-]; anything else never reaches the disk.
  if (!/^[\w-]+$/.test(id)) throw new Error('Некорректный id файла.');
  return path.join(dataDir('thumbs'), `${id}.jpg`);
}

/* ------------------------- internals ------------------------- */

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime?: string;
  modifiedTime: string;
  thumbnailLink?: string;
  webViewLink?: string;
  videoMediaMetadata?: { durationMillis?: string; width?: number; height?: number };
}

interface FoundVideo extends DriveFile {
  folderPath: string;
}

async function syncLibrary(): Promise<number> {
  const rootId = driveFolderId();
  if (!rootId) throw new Error('DRIVE_FOLDER_ID не задан в .env.');
  if (!googleConnected()) throw new Error('Google Drive не подключён.');

  const started = Date.now();
  const videos: FoundVideo[] = [];
  // Breadth-first over the tree; `seen` guards against shortcut loops.
  const queue: { id: string; path: string }[] = [{ id: rootId, path: '' }];
  const seen = new Set<string>();
  const folders: { id: string; path: string }[] = [];
  while (queue.length) {
    const folder = queue.shift()!;
    if (seen.has(folder.id)) continue;
    seen.add(folder.id);
    folders.push(folder);
    for (const file of await listChildren(folder.id)) {
      if (file.mimeType === FOLDER_MIME) {
        queue.push({ id: file.id, path: folder.path ? `${folder.path}/${file.name}` : file.name });
      } else if (file.mimeType.startsWith('video/')) {
        videos.push({ ...file, folderPath: folder.path });
      }
    }
  }

  const conn = db();
  const upsertFolder = conn.prepare(
    'INSERT INTO drive_folders (id, path, synced_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET path = excluded.path, synced_at = excluded.synced_at',
  );
  transaction(conn, () => {
    for (const v of videos) upsertDriveFile(conn, v, v.folderPath, started);
    conn.prepare('UPDATE drive_files SET removed = 1 WHERE synced_at < ?').run(started);
    for (const folder of folders) upsertFolder.run(folder.id, folder.path, started);
    conn.prepare('DELETE FROM drive_folders WHERE synced_at < ?').run(started);
  });
  syncCreoIds(conn);

  await refreshThumbnails(videos);
  wake();
  log.info(`Синхронизировано видео: ${videos.length} (${Date.now() - started} мс).`);
  return videos.length;
}

/**
 * Insert or refresh one video's Drive metadata. Ours stays ours: group, note
 * and transcript are never touched, and a geo someone set by hand wins over
 * the one guessed from the file name (which is re-guessed on rename).
 */
export function upsertDriveFile(conn: DatabaseSync, v: DriveFile, folderPath: string, syncedAt: number): void {
  const meta = v.videoMediaMetadata;
  const geo = geoFromName(v.name);
  conn
    .prepare(
      `
    INSERT INTO drive_files
      (id, name, mime_type, size, duration_ms, width, height, folder_path, created_at, modified_at,
       web_view_link, geo, geo_source, removed, synced_at, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, mime_type = excluded.mime_type, size = excluded.size,
      duration_ms = excluded.duration_ms, width = excluded.width, height = excluded.height,
      folder_path = excluded.folder_path, created_at = excluded.created_at,
      modified_at = excluded.modified_at, web_view_link = excluded.web_view_link,
      geo = CASE WHEN drive_files.geo_source = 'manual' THEN drive_files.geo ELSE excluded.geo END,
      geo_source = CASE WHEN drive_files.geo_source = 'manual' THEN 'manual' ELSE excluded.geo_source END,
      -- Deleted through the service stays gone, even if restored from the Drive trash.
      removed = CASE WHEN drive_files.deleted_at IS NULL THEN 0 ELSE 1 END, synced_at = excluded.synced_at
  `,
    )
    .run(
      v.id,
      v.name,
      v.mimeType,
      v.size ? Number(v.size) : null,
      meta?.durationMillis ? Number(meta.durationMillis) : null,
      meta?.width ?? null,
      meta?.height ?? null,
      folderPath,
      v.createdTime ?? null,
      v.modifiedTime,
      v.webViewLink ?? null,
      geo,
      geo ? 'name' : null,
      syncedAt,
      // Only on insert: ON CONFLICT leaves it alone, so it keeps the first sighting.
      syncedAt,
    );
}

async function listChildren(folderId: string): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await googleFetch(`${API}?${params}`);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 403 && text.includes('insufficient')) {
        throw new Error('У подключённого аккаунта нет доступа к Drive: при подключении не отметили галочку Google Диска. Нажми «Подключить другой аккаунт» и выдай доступ.');
      }
      if (res.status === 404) {
        throw new Error(`Папка ${folderId} не найдена или аккаунт не имеет к ней доступа.`);
      }
      throw new Error(`Drive API ${res.status}: ${text.slice(0, 300)}`);
    }
    const body = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
    out.push(...(body.files ?? []));
    pageToken = body.nextPageToken;
  } while (pageToken);
  return out;
}

/**
 * Download preview frames for new or changed files. `thumbnailLink` is
 * short-lived and needs the bearer token, so frames are cached on disk and
 * served from there. Drive may not have rendered one yet for a fresh upload —
 * those are simply retried on the next sync.
 */
export async function refreshThumbnails(videos: DriveFile[]): Promise<void> {
  const conn = db();
  const current = new Map(
    (conn.prepare('SELECT id, thumb_at FROM drive_files').all() as { id: string; thumb_at: string | null }[]).map(
      (r) => [r.id, r.thumb_at],
    ),
  );
  const todo = videos.filter(
    (v) => v.thumbnailLink && (current.get(v.id) !== v.modifiedTime || !fs.existsSync(thumbPath(v.id))),
  );
  const mark = conn.prepare('UPDATE drive_files SET thumb_at = ? WHERE id = ?');

  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const v = todo[next++]!;
      try {
        const url = v.thumbnailLink!.replace(/=s\d+$/, `=s${THUMB_SIZE}`);
        const res = await googleFetch(url);
        if (!res.ok) continue;
        fs.writeFileSync(thumbPath(v.id), Buffer.from(await res.arrayBuffer()));
        mark.run(v.modifiedTime, v.id);
      } catch (err) {
        log.debug(`Превью ${v.id} не скачалось: ${err instanceof Error ? err.message : err}`);
      }
    }
  };
  await Promise.all(Array.from({ length: THUMB_CONCURRENCY }, worker));
}
