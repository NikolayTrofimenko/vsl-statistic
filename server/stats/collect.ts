import type { Request, Response } from 'express';
import { z } from 'zod';
import { db, transaction } from '../db';
import { scopedLogger } from '../logger';
import { countBits, decodeBits, MAX_SECONDS, mergeBits } from './bitmap';
import { normalizeLand, normalizeSrc } from './identity';

/**
 * Public beacon endpoint for the landing tracker (`tracker/t.js`).
 *
 * Every beacon carries the *whole* state of one page view so far — not a
 * delta — so a lost or duplicated beacon costs nothing: the row is upserted
 * and the watched-seconds bitmaps are OR-merged. That is what lets the
 * tracker fire-and-forget with `sendBeacon` on page hide.
 *
 * The body arrives as `text/plain` (sendBeacon's default) to avoid a CORS
 * preflight, so it is parsed here rather than by `express.json`.
 */

const log = scopedLogger('collect');

/** A view stops accepting updates after this long — caps abuse of old sids. */
const VIEW_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 240;

const str = (max: number) => z.string().max(max);
const optStr = (max: number) =>
  z
    .string()
    .max(max * 4)
    .nullish()
    .transform((v) => (v ? v.slice(0, max) : null));

const VideoState = z.object({
  key: str(64),
  src: str(1000).min(1),
  dur: z.number().nonnegative().max(MAX_SECONDS).nullish(),
  popupAt: z.number().nonnegative().max(MAX_SECONDS).nullish(),
  bits: str(Math.ceil((MAX_SECONDS / 8) * 4 / 3) + 8),
  maxPos: z.number().nonnegative().max(MAX_SECONDS),
  playTime: z.number().nonnegative().max(MAX_SECONDS * 2),
  started: z.boolean(),
  ended: z.boolean(),
  err: optStr(200),
});

const Beacon = z.object({
  v: z.literal(1),
  sid: z.string().regex(/^[\w-]{8,64}$/),
  land: str(200).min(1),
  page: optStr(500),
  ref: optStr(300),
  attr: z
    .object({
      subid: optStr(100),
      buyer: optStr(100),
      utm_source: optStr(200),
      utm_campaign: optStr(200),
    })
    .partial()
    .default({}),
  submitted: z.boolean(),
  videos: z.array(VideoState).max(5),
  marks: z.array(z.tuple([str(40), z.number()])).max(50).default([]),
});

type BeaconBody = z.infer<typeof Beacon>;

const hits = new Map<string, { count: number; windowStart: number }>();

export function collect(req: Request, res: Response): void {
  // Answer immediately; the browser doesn't read the response anyway.
  res.status(204).end();

  if (!allow(req.ip ?? 'unknown')) return;

  let parsed: BeaconBody;
  try {
    const raw = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    parsed = Beacon.parse(raw);
  } catch (err) {
    log.debug(`Отклонён beacon: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
    return;
  }
  try {
    store(parsed, req);
  } catch (err) {
    log.warn('Не удалось сохранить beacon', err);
  }
}

/** CORS for the tracker: any landing domain may post, nothing is credentialed. */
export function collectCors(req: Request, res: Response, next: () => void): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

/* ------------------------- storage ------------------------- */

function store(b: BeaconBody, req: Request): void {
  const conn = db();
  const now = Date.now();
  const ua = req.headers['user-agent'] ?? '';
  const client = parseUserAgent(ua);
  const country = headerCountry(req);

  const findLv = conn.prepare('SELECT id FROM land_videos WHERE land = ? AND src = ?');
  const insertLv = conn.prepare(
    'INSERT INTO land_videos (land, video_key, src, duration, popup_at, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const touchLv = conn.prepare(`
    UPDATE land_videos SET
      last_seen = ?,
      video_key = ?,
      duration = COALESCE(?, duration),
      popup_at = COALESCE(popup_at, ?)
    WHERE id = ?
  `);
  const getView = conn.prepare('SELECT created_at, watched FROM views WHERE sid = ? AND lv_id = ?');
  const upsertView = conn.prepare(`
    INSERT INTO views (
      sid, lv_id, created_at, updated_at, day, country, device, os, browser, referrer, page,
      subid, buyer, utm_source, utm_campaign, started, ended, submitted,
      watched, watched_sec, max_pos, play_time, error, marks
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sid, lv_id) DO UPDATE SET
      updated_at = excluded.updated_at,
      subid = COALESCE(excluded.subid, views.subid),
      started = MAX(views.started, excluded.started),
      ended = MAX(views.ended, excluded.ended),
      submitted = MAX(views.submitted, excluded.submitted),
      watched = excluded.watched,
      watched_sec = excluded.watched_sec,
      max_pos = MAX(views.max_pos, excluded.max_pos),
      play_time = MAX(views.play_time, excluded.play_time),
      error = COALESCE(excluded.error, views.error),
      marks = excluded.marks
  `);

  // Older tracker builds (still cached in browsers) send the snippet's
  // placeholder and hls.js blob: URLs — fold them like the current one would.
  const land = normalizeLand(b.land, b.page);

  transaction(conn, () => {
    for (const v of b.videos) {
      const src = normalizeSrc(v.src);
      const dur = v.dur && Number.isFinite(v.dur) && v.dur > 0 ? v.dur : null;
      const existingLv = findLv.get(land, src) as { id: number } | undefined;
      let lvId: number;
      if (existingLv) {
        lvId = existingLv.id;
        touchLv.run(now, v.key, dur, v.popupAt ?? null, lvId);
      } else {
        lvId = Number(insertLv.run(land, v.key, src, dur, v.popupAt ?? null, now, now).lastInsertRowid);
      }

      const prev = getView.get(b.sid, lvId) as { created_at: number; watched: Uint8Array | null } | undefined;
      if (prev && now - prev.created_at > VIEW_MAX_AGE_MS) continue;

      const bits = mergeBits(prev?.watched ?? null, decodeBits(v.bits));
      const created = prev?.created_at ?? now;
      upsertView.run(
        b.sid,
        lvId,
        created,
        now,
        new Date(created).toISOString().slice(0, 10),
        country,
        client.device,
        client.os,
        client.browser,
        refererHost(b.ref),
        b.page,
        b.attr.subid ?? null,
        b.attr.buyer ?? null,
        b.attr.utm_source ?? null,
        b.attr.utm_campaign ?? null,
        v.started ? 1 : 0,
        v.ended ? 1 : 0,
        b.submitted ? 1 : 0,
        bits,
        countBits(bits),
        v.maxPos,
        v.playTime,
        v.err,
        b.marks.length ? JSON.stringify(b.marks) : null,
      );
    }
  });
}

function allow(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now });
    if (hits.size > 50_000) hits.clear();
    return true;
  }
  entry.count++;
  return entry.count <= RATE_MAX;
}

/** Country from a CDN header, when the service sits behind Cloudflare or similar. */
function headerCountry(req: Request): string | null {
  const raw = req.headers['cf-ipcountry'] ?? req.headers['x-country-code'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
  return value && /^[A-Z]{2}$/.test(value) && value !== 'XX' ? value : null;
}

function refererHost(ref: string | null): string | null {
  if (!ref) return null;
  try {
    return new URL(ref).hostname || null;
  } catch {
    return null;
  }
}

/** Coarse client classification — enough to split retention by device. */
export function parseUserAgent(ua: string): { device: string; os: string; browser: string } {
  const device = /iPad|Tablet|(Android(?!.*Mobile))/i.test(ua)
    ? 'tablet'
    : /Mobi|iPhone|Android/i.test(ua)
      ? 'mobile'
      : 'desktop';
  const os = /iPhone|iPad|iPod/i.test(ua)
    ? 'iOS'
    : /Android/i.test(ua)
      ? 'Android'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /Mac OS X/i.test(ua)
          ? 'macOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : 'other';
  const browser = /FBAN|FBAV|FB_IAB/i.test(ua)
    ? 'Facebook'
    : /Instagram/i.test(ua)
      ? 'Instagram'
      : /TikTok|musical_ly|Bytedance/i.test(ua)
        ? 'TikTok'
        : /EdgA?\//i.test(ua)
          ? 'Edge'
          : /SamsungBrowser/i.test(ua)
            ? 'Samsung'
            : /CriOS|Chrome\//i.test(ua)
              ? 'Chrome'
              : /FxiOS|Firefox\//i.test(ua)
                ? 'Firefox'
                : /Safari\//i.test(ua)
                  ? 'Safari'
                  : 'other';
  return { device, os, browser };
}
