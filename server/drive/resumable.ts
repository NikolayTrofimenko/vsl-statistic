import type { Request } from 'express';
import { Agent, fetch as undiciFetch } from 'undici';
import { googleFetch } from './google';
import { FILE_FIELDS, type DriveFile } from './sync';

/**
 * Pipe a request body into a Drive resumable upload session, so nothing is
 * buffered on this server. Throws with Drive's answer when it refuses.
 */

// A multi-gigabyte upload outlives undici's default body/header timeouts.
const uploadAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export interface DriveUpload {
  name: string;
  parentId: string;
  contentType: string;
  length: number;
}

export async function uploadToDrive(req: Request, up: DriveUpload): Promise<DriveFile> {
  // 1. Open a resumable session with the file's metadata.
  const init = await googleFetch(
    `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': up.contentType,
        'X-Upload-Content-Length': String(up.length),
      },
      body: JSON.stringify({ name: up.name, parents: [up.parentId] }),
    },
  );
  const session = init.headers.get('location');
  if (!init.ok || !session) {
    const text = await init.text().catch(() => '');
    throw new Error(`Drive не открыл загрузку (${init.status}): ${text.slice(0, 200)}`);
  }

  // 2. Pipe the body into it. The session URI itself authorises the upload,
  //    so no bearer token is needed here.
  const put = await undiciFetch(session, {
    method: 'PUT',
    headers: { 'Content-Type': up.contentType, 'Content-Length': String(up.length) },
    body: req,
    duplex: 'half',
    dispatcher: uploadAgent,
  });
  if (!put.ok) {
    const text = await put.text().catch(() => '');
    throw new Error(`Drive не принял файл (${put.status}): ${text.slice(0, 200)}`);
  }
  return (await put.json()) as DriveFile;
}

/** Move a file to the Drive trash (restorable there for 30 days). */
export async function trashDriveFile(id: string): Promise<void> {
  const res = await googleFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,trashed`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ trashed: true }),
    },
  );
  // Already gone is fine — the goal is that it's not there.
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw new Error(`Drive не удалил файл (${res.status}): ${text.slice(0, 200)}`);
  }
}

/** Drive accepts almost anything; keep names readable and free of paths. */
export function sanitizeFileName(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}
