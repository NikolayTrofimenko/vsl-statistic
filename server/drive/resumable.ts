import type { Request } from 'express';
import { Agent, fetch as undiciFetch } from 'undici';
import { googleFetch } from './google';
import { FILE_FIELDS, type DriveFile } from './sync';

/**
 * Pass a request body into a Drive resumable upload session chunk by chunk,
 * so at most one 16 MB chunk is held on this server. Throws with Drive's answer when it refuses.
 */

// A multi-gigabyte upload outlives undici's default body/header timeouts.
const uploadAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
/** Drive wants chunks in multiples of 256 KB. */
const CHUNK = 16 * 1024 * 1024;

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

  // 2. Send the body in fixed chunks. Streaming it in one PUT let undici read the
  //    browser's upload faster than Drive took it, and a 420 MB video filled the
  //    512 MB container. Now at most one chunk sits in memory. The session URI
  //    itself authorises the upload, so no bearer token is needed here.
  let sent = 0;
  let parts: Buffer[] = [];
  let buffered = 0;
  const flush = async (final: boolean): Promise<Response | null> => {
    const chunk = Buffer.concat(parts, buffered);
    parts = [];
    buffered = 0;
    const end = sent + chunk.length - 1;
    const res = (await undiciFetch(session, {
      method: 'PUT',
      headers: {
        'Content-Length': String(chunk.length),
        'Content-Range': chunk.length ? `bytes ${sent}-${end}/${up.length}` : `bytes */${up.length}`,
      },
      body: chunk,
      dispatcher: uploadAgent,
    })) as unknown as Response;
    sent += chunk.length;
    if (!final && res.status === 308) {
      await res.arrayBuffer().catch(() => undefined);
      return null;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Drive не принял файл (${res.status}): ${text.slice(0, 200)}`);
    }
    return res;
  };

  for await (const piece of req as AsyncIterable<Buffer>) {
    parts.push(piece);
    buffered += piece.length;
    // Every chunk but the last must be a multiple of 256 KB.
    while (buffered >= CHUNK && sent + buffered < up.length) {
      const all = Buffer.concat(parts, buffered);
      parts = [all.subarray(0, CHUNK)];
      buffered = CHUNK;
      const rest = all.subarray(CHUNK);
      await flush(false);
      parts = rest.length ? [Buffer.from(rest)] : [];
      buffered = rest.length;
    }
  }
  if (sent + buffered !== up.length) throw new Error('Загрузка оборвалась: пришла не вся длина файла.');
  const done = await flush(true);
  return (await done!.json()) as DriveFile;
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
