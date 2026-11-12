import * as fs from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Request, Response } from 'express';
import { db } from '../db';
import { completeConsent, consentUrl, googleFetch } from '../drive/google';
import { runSync, thumbPath } from '../drive/sync';
import { scopedLogger } from '../logger';

/**
 * Drive endpoints that are not plain RPC: the OAuth redirect pair (full-page
 * navigations) and the binary routes the browser loads directly — preview
 * frames and the video stream.
 */

const log = scopedLogger('drive-http');

/** Headers passed through from Drive so the <video> element can seek. */
const STREAM_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges'];

export function oauthStart(_req: Request, res: Response): void {
  try {
    res.redirect(consentUrl());
  } catch (err) {
    res.redirect(`/library?driveError=${encodeURIComponent(message(err))}`);
  }
}

export async function oauthCallback(req: Request, res: Response): Promise<void> {
  const code = String(req.query['code'] ?? '');
  const state = String(req.query['state'] ?? '');
  const denied = req.query['error'];
  if (denied || !code) {
    res.redirect(`/library?driveError=${encodeURIComponent(String(denied ?? 'Доступ не выдан.'))}`);
    return;
  }
  try {
    await completeConsent(code, state);
    void runSync();
    res.redirect('/library?driveConnected=1');
  } catch (err) {
    log.warn(`OAuth callback: ${message(err)}`);
    res.redirect(`/library?driveError=${encodeURIComponent(message(err))}`);
  }
}

export function serveThumb(req: Request, res: Response): void {
  let file: string;
  try {
    file = thumbPath(String(req.params['id']));
  } catch {
    res.status(400).end();
    return;
  }
  if (!fs.existsSync(file)) {
    res.status(404).end();
    return;
  }
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(file);
}

/** Proxy the file from Drive, forwarding Range so playback and seeking work. */
export async function streamVideo(req: Request, res: Response): Promise<void> {
  const id = String(req.params['id']);
  const known = db().prepare('SELECT name FROM drive_files WHERE id = ?').get(id) as { name: string } | undefined;
  if (!known) {
    res.status(404).json({ ok: false, error: 'Видео нет в библиотеке.' });
    return;
  }
  await pipeDriveFile(req, res, id, known.name);
}

/** An image or video of a knowledge-base document: the same proxy, for files listed in `kb_files` only. */
export async function serveKnowledgeFile(req: Request, res: Response): Promise<void> {
  const id = String(req.params['id']);
  const known = db().prepare('SELECT name FROM kb_files WHERE drive_file_id = ?').get(id) as
    | { name: string }
    | undefined;
  if (!known) {
    res.status(404).json({ ok: false, error: 'Файла нет в базе знаний.' });
    return;
  }
  await pipeDriveFile(req, res, id, known.name);
}

async function pipeDriveFile(req: Request, res: Response, id: string, fileName: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (req.headers.range) headers['Range'] = req.headers.range;

  const abort = new AbortController();
  req.on('close', () => abort.abort());

  try {
    const upstream = await googleFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
      { headers, signal: abort.signal },
    );
    if (!upstream.ok || !upstream.body) {
      res.status(upstream.status === 416 ? 416 : 502).end();
      return;
    }
    res.status(upstream.status);
    for (const name of STREAM_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.query['download']) {
      // RFC 5987 form: file names are often Cyrillic.
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    }
    Readable.fromWeb(upstream.body as unknown as WebReadableStream).on('error', () => res.end()).pipe(res);
  } catch (err) {
    if (abort.signal.aborted) return;
    log.warn(`Стрим ${id}: ${message(err)}`);
    if (!res.headersSent) res.status(502).json({ ok: false, error: message(err) });
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
