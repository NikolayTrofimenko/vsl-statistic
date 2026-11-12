import type { Request, Response } from 'express';
import sanitizeHtml from 'sanitize-html';
import { db, getSetting, setSetting } from '../db';
import { driveFolderId } from '../config';
import { driveWritable, googleConnected, googleFetch } from '../drive/google';
import { sanitizeFileName, trashDriveFile, uploadToDrive } from '../drive/resumable';
import { sessionUser } from '../http/auth';
import { scopedLogger } from '../logger';
import type { KbDoc, KbDocInput, KbDocSummary, KbFile } from '../../src/shared/api.types';

/**
 * База знаний: documents — formatted text with images and videos inside.
 * Everyone signed in reads; only the admin writes. The HTML is sanitized here
 * on every save (the page renders it as is). Images and videos live on Google
 * Drive in a folder of their own — next to the library folder, not inside it,
 * or the library sync would take them for creatives — and are served through
 * /api/knowledge/file/:id, which only serves files listed in `kb_files`.
 */

const log = scopedLogger('knowledge');

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const MAX_VIDEO = 5 * 1024 * 1024 * 1024;
const MAX_IMAGE = 25 * 1024 * 1024;
const MAX_HTML = 1_000_000;
const FILE_URL = '/api/knowledge/file/';
const FOLDER_SETTING = 'kb_drive_folder_id';
const FOLDER_NAME = 'База знаний (сервис аналитики)';

interface Row {
  id: number;
  title: string;
  topic: string;
  body: string | null;
  created_by_login: string | null;
  updated_at: number;
}

const SELECT = `SELECT k.id, k.title, k.topic, k.body, k.updated_at, u.login AS created_by_login
  FROM kb_items k LEFT JOIN users u ON u.id = k.created_by`;

export function listDocs(): KbDocSummary[] {
  return (db().prepare(`${SELECT} ORDER BY k.topic COLLATE NOCASE, k.title COLLATE NOCASE`).all() as unknown as Row[]).map(summary);
}

export function getDoc(id: number): KbDoc {
  const row = db().prepare(`${SELECT} WHERE k.id = ?`).get(id) as Row | undefined;
  if (!row) throw new Error('Документ не найден.');
  return { ...summary(row), html: row.body ?? '' };
}

/** Admin: create or update a document. */
export function saveDoc(input: KbDocInput, userId: number | null): KbDoc {
  const title = String(input.title ?? '').trim().slice(0, 200);
  if (!title) throw new Error('Нужно название документа.');
  const topic = String(input.topic ?? '').trim().slice(0, 80);
  const raw = String(input.html ?? '');
  if (raw.length > MAX_HTML) throw new Error('Документ слишком большой.');
  const html = clean(raw);
  const conn = db();
  const now = Date.now();
  let id = input.id;
  if (id) {
    const res = conn.prepare('UPDATE kb_items SET title = ?, topic = ?, body = ?, updated_at = ? WHERE id = ?').run(title, topic, html, now, id);
    if (!res.changes) throw new Error('Документ не найден.');
  } else {
    id = Number(
      conn
        .prepare(`INSERT INTO kb_items (kind, title, topic, body, created_by, created_at, updated_at) VALUES ('doc', ?, ?, ?, ?, ?, ?)`)
        .run(title, topic, html, userId, now, now).lastInsertRowid,
    );
  }
  log.info(`База знаний: «${title}» сохранён.`);
  return getDoc(id);
}

/** Admin: remove a document; images and videos no other document uses go to the Drive trash. */
export async function deleteDoc(id: number): Promise<void> {
  const conn = db();
  const row = conn.prepare('SELECT title, body FROM kb_items WHERE id = ?').get(id) as { title: string; body: string | null } | undefined;
  if (!row) return;
  conn.prepare('DELETE FROM kb_items WHERE id = ?').run(id);
  log.info(`База знаний: «${row.title}» удалён.`);

  const others = (conn.prepare('SELECT body FROM kb_items').all() as { body: string | null }[]).map((r) => r.body ?? '').join('\n');
  for (const fileId of fileIds(row.body ?? '')) {
    if (others.includes(FILE_URL + fileId)) continue;
    try {
      if (googleConnected()) await trashDriveFile(fileId);
      conn.prepare('DELETE FROM kb_files WHERE drive_file_id = ?').run(fileId);
    } catch (err) {
      log.warn(`База знаний: файл ${fileId} не удалился с Drive`, err);
    }
  }
}

/**
 * Admin: upload an image or video for a document. Raw file body, piped into Drive.
 *   POST /api/knowledge/upload?name=…   body: the file
 */
export async function uploadKnowledge(req: Request, res: Response): Promise<void> {
  const fail = (status: number, error: string) => {
    if (!res.headersSent) res.status(status).json({ ok: false, error });
  };
  if (!googleConnected()) return fail(409, 'Google Drive не подключён.');
  if (!driveWritable()) return fail(409, 'Подключение Drive только на чтение — загрузка невозможна.');

  const name = sanitizeFileName(String(req.query['name'] ?? ''));
  if (!name) return fail(400, 'Пустое имя файла.');
  const kind = VIDEO_EXT.test(name) ? 'video' : IMAGE_EXT.test(name) ? 'image' : null;
  if (!kind) return fail(400, 'Можно вставить картинку (png, jpg, gif, webp) или видео (mp4, mov, webm…).');

  const length = Number(req.headers['content-length']);
  if (!Number.isFinite(length) || length <= 0) return fail(411, 'Нужен размер файла (Content-Length).');
  if (length > (kind === 'video' ? MAX_VIDEO : MAX_IMAGE)) return fail(413, kind === 'video' ? 'Видео больше 5 ГБ.' : 'Картинка больше 25 МБ.');
  const contentType = String(req.headers['content-type'] || (kind === 'video' ? 'video/mp4' : 'image/png'));

  try {
    const parentId = await knowledgeFolder();
    const file = await uploadToDrive(req, { name, parentId, contentType, length });
    db()
      .prepare('INSERT OR REPLACE INTO kb_files (drive_file_id, name, mime, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(file.id, name, contentType, length, sessionUser(req)?.id ?? null, Date.now());
    log.info(`База знаний: загружено «${name}» (${Math.round(length / 1024 / 1024)} МБ).`);
    const data: KbFile = { id: file.id, url: FILE_URL + file.id, kind, name };
    res.json({ ok: true, data });
  } catch (err) {
    if (req.destroyed) return; // the browser cancelled
    log.warn(`База знаний: загрузка «${name}» упала`, err);
    fail(502, err instanceof Error ? err.message : String(err));
  }
}

/* ------------------------------ HTML ------------------------------ */

/** What the editor produces, nothing more. Media only from our own file proxy (images may also be https). */
function clean(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'h2', 'h3', 'strong', 'b', 'em', 'i', 'u', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'hr', 'a', 'img', 'video'],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt'],
      video: ['src', 'controls', 'preload'],
      ol: ['start'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tg'],
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    exclusiveFilter: (frame) =>
      (frame.tag === 'video' && !String(frame.attribs['src'] ?? '').startsWith(FILE_URL)) ||
      (frame.tag === 'img' && !/^(\/api\/knowledge\/file\/|https:\/\/)/.test(String(frame.attribs['src'] ?? ''))),
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { href: attribs['href'] ?? '', target: '_blank', rel: 'noopener noreferrer' } }),
      video: (tagName, attribs) => ({ tagName, attribs: { src: attribs['src'] ?? '', controls: 'true', preload: 'metadata' } }),
      b: 'strong',
      i: 'em',
    },
  });
}

function fileIds(html: string): string[] {
  return [...html.matchAll(/\/api\/knowledge\/file\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
}

function summary(r: Row): KbDocSummary {
  const html = r.body ?? '';
  return {
    id: r.id,
    title: r.title,
    topic: r.topic,
    excerpt: plainText(html).slice(0, 220),
    hasVideo: html.includes('<video'),
    hasImage: html.includes('<img'),
    createdBy: r.created_by_login,
    updatedAt: r.updated_at,
  };
}

function plainText(html: string): string {
  return sanitizeHtml(html.replace(/<\/(p|h2|h3|li|blockquote)>/g, ' '), { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------ Drive folder ------------------------------ */

/** Our Drive folder for document files: made once, beside the library folder (or in My Drive). */
async function knowledgeFolder(): Promise<string> {
  const saved = getSetting(FOLDER_SETTING);
  if (saved) {
    const check = await googleFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(saved)}?supportsAllDrives=true&fields=id,trashed`,
    );
    if (check.ok && !((await check.json()) as { trashed?: boolean }).trashed) return saved;
  }

  let parent = 'root';
  const lib = await googleFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFolderId())}?supportsAllDrives=true&fields=parents`,
  );
  if (lib.ok) parent = ((await lib.json()) as { parents?: string[] }).parents?.[0] ?? 'root';

  const res = await googleFetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }),
  });
  if (!res.ok) throw new Error(`Drive не создал папку базы знаний (${res.status}).`);
  const id = ((await res.json()) as { id: string }).id;
  setSetting(FOLDER_SETTING, id);
  log.info(`База знаний: создана папка на Drive ${id}.`);
  return id;
}
