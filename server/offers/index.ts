import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Request, Response } from 'express';
import { db } from '../db';
import { dataDir } from '../config';
import { scopedLogger } from '../logger';
import { COUNTRIES } from '../../src/shared/geo';
import { OFFER_CURRENCIES as CURRENCIES } from '../../src/shared/offers';
import type { Offer, OfferInput } from '../../src/shared/api.types';

/**
 * Офферы: a hand-kept card per offer (cap, payout, guarantee, call centre,
 * region exclusions, brief, photo). Section `offers` reads, `offersEdit`
 * writes — checked in `server/http/app.ts`. Photos sit in the data volume
 * (data/offers/), a few hundred KB each.
 */

const log = scopedLogger('offers');

const MAX_PHOTO = 10 * 1024 * 1024;

interface Row {
  id: number;
  name: string;
  vertical: string;
  geo: string;
  partner: string;
  cap: number | null;
  payout: number | null;
  payout_currency: string;
  land_price: string;
  guarantee: number | null;
  brief: string;
  cc_mode: string;
  cc_language: string;
  region_exclusions: string;
  photo: string | null;
  active: number;
  updated_at: number;
  updated_by_login: string | null;
}

const SELECT = `SELECT o.*, u.login AS updated_by_login FROM offers o LEFT JOIN users u ON u.id = o.updated_by`;

export function listOffers(): Offer[] {
  return (db().prepare(`${SELECT} ORDER BY o.active DESC, o.name COLLATE NOCASE`).all() as unknown as Row[]).map(toOffer);
}

export function saveOffer(input: OfferInput, userId: number): Offer {
  const f = clean(input);
  const conn = db();
  const now = Date.now();
  let id = input.id;
  const values = [
    f.name, f.vertical, f.geo, f.partner, f.cap, f.payout, f.payoutCurrency, f.landPrice, f.guarantee,
    f.brief, f.ccMode, f.ccLanguage, f.regionExclusions, f.active ? 1 : 0, userId, now,
  ];
  if (id) {
    const res = conn
      .prepare(
        `UPDATE offers SET name = ?, vertical = ?, geo = ?, partner = ?, cap = ?, payout = ?, payout_currency = ?, land_price = ?,
         guarantee = ?, brief = ?, cc_mode = ?, cc_language = ?, region_exclusions = ?, active = ?, updated_by = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(...values, id);
    if (!res.changes) throw new Error('Оффер не найден.');
  } else {
    id = Number(
      conn
        .prepare(
          `INSERT INTO offers (name, vertical, geo, partner, cap, payout, payout_currency, land_price, guarantee,
           brief, cc_mode, cc_language, region_exclusions, active, updated_by, updated_at, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...values, userId, now).lastInsertRowid,
    );
  }
  log.info(`Оффер «${f.name}» сохранён.`);
  return get(id);
}

export function deleteOffer(id: number): void {
  const conn = db();
  const row = conn.prepare('SELECT name, photo FROM offers WHERE id = ?').get(id) as { name: string; photo: string | null } | undefined;
  if (!row) return;
  conn.prepare('DELETE FROM offers WHERE id = ?').run(id);
  if (row.photo) fs.rm(path.join(photoDir(), row.photo), { force: true }, () => undefined);
  log.info(`Оффер «${row.name}» удалён.`);
}

/** POST /api/offers/photo/:id — raw image body (png, jpg, webp); replaces the old one. */
export function uploadOfferPhoto(req: Request, res: Response): void {
  const id = Number(req.params['id']);
  const row = db().prepare('SELECT photo FROM offers WHERE id = ?').get(id) as { photo: string | null } | undefined;
  if (!row) {
    res.status(404).json({ ok: false, error: 'Оффер не найден.' });
    return;
  }
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !body.length) {
    res.status(400).json({ ok: false, error: 'Пустой файл.' });
    return;
  }
  const ext = imageExt(body);
  if (!ext) {
    res.status(400).json({ ok: false, error: 'Нужна картинка PNG, JPG или WEBP.' });
    return;
  }
  const name = `${id}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(photoDir(), name), body);
  db().prepare('UPDATE offers SET photo = ? WHERE id = ?').run(name, id);
  if (row.photo) fs.rm(path.join(photoDir(), row.photo), { force: true }, () => undefined);
  res.json({ ok: true, data: get(id) });
}

/** GET /api/offers/photo/:id */
export function serveOfferPhoto(req: Request, res: Response): void {
  const row = db().prepare('SELECT photo FROM offers WHERE id = ?').get(Number(req.params['id'])) as { photo: string | null } | undefined;
  const file = row?.photo ? path.join(photoDir(), row.photo) : null;
  if (!file || !fs.existsSync(file)) {
    res.status(404).end();
    return;
  }
  // The URL carries a version (?v=…), so the browser may keep it.
  res.setHeader('Cache-Control', 'private, max-age=604800');
  res.sendFile(file);
}

export { MAX_PHOTO };

function photoDir(): string {
  return dataDir('offers');
}

function imageExt(b: Buffer): string | null {
  if (b.length > 8 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function clean(input: OfferInput) {
  const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
  const num = (v: unknown, label: string, min: number, max: number): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label}: число от ${min} до ${max}.`);
    return n;
  };
  const name = text(input.name, 120);
  if (!name) throw new Error('Нужно название оффера.');
  const geo = text(input.geo, 2).toUpperCase();
  if (geo && !(geo in COUNTRIES)) throw new Error(`Неизвестное гео: ${geo}`);
  const currency = text(input.payoutCurrency, 3).toUpperCase() || 'USD';
  if (!CURRENCIES.includes(currency)) throw new Error(`Неизвестная валюта: ${currency}`);
  const cap = num(input.cap, 'Капа', 0, 1_000_000);
  return {
    name,
    vertical: text(input.vertical, 80),
    geo,
    partner: text(input.partner, 80),
    cap: cap === null ? null : Math.round(cap),
    payout: num(input.payout, 'Выплата', 0, 1_000_000),
    payoutCurrency: currency,
    landPrice: text(input.landPrice, 80),
    guarantee: num(input.guarantee, 'Гарант', 0, 100),
    brief: text(input.brief, 20_000),
    ccMode: text(input.ccMode, 200),
    ccLanguage: text(input.ccLanguage, 80),
    regionExclusions: text(input.regionExclusions, 2000),
    active: input.active !== false,
  };
}

function get(id: number): Offer {
  const row = db().prepare(`${SELECT} WHERE o.id = ?`).get(id) as Row | undefined;
  if (!row) throw new Error('Оффер не найден.');
  return toOffer(row);
}

function toOffer(r: Row): Offer {
  const version = r.photo?.match(/-(\d+)\./)?.[1];
  return {
    id: r.id,
    name: r.name,
    vertical: r.vertical,
    geo: r.geo,
    partner: r.partner,
    cap: r.cap,
    payout: r.payout,
    payoutCurrency: r.payout_currency,
    landPrice: r.land_price,
    guarantee: r.guarantee,
    brief: r.brief,
    ccMode: r.cc_mode,
    ccLanguage: r.cc_language,
    regionExclusions: r.region_exclusions,
    photoUrl: r.photo ? `/api/offers/photo/${r.id}?v=${version ?? '0'}` : null,
    active: r.active === 1,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by_login,
  };
}
