import { kaitenToken, kaitenUrl } from '../config';
import { db, getSetting, setSetting } from '../db';
import { scopedLogger } from '../logger';

/**
 * Kaiten (euphoria.kaiten.ru) cards of the boards the dashboard counts, with
 * their column moves. Kaiten keeps a card's whole location history — across
 * boards too — so a sync copies cards and, for cards changed since the last
 * look, their moves; metrics are computed from the local copy.
 */

const log = scopedLogger('kaiten');

const TIMEOUT_MS = 30_000;
const SYNC_EVERY_MS = 30 * 60_000;
const PAGE = 100;
/** A small gap between calls; the rate-limit headers do the rest (Kaiten allows ~50 per window). */
const CALL_GAP_MS = 250;

/**
 * Boards synced, by Kaiten id: the hiring space (Рекрутинг → Испытательный
 * срок → Сотрудники), "Связки общий поток" (offer/link pipeline), the IT
 * department (Технические проблемы, Задачи по автоматизации) and the promo
 * department's "Креативы — общий поток" and Промо-отдел HYD (two boards).
 */
export const KAITEN_BOARDS = [1962805, 1957064, 1970273, 1560820, 1856420, 1857364, 1538010];

/**
 * Task boards read only for "done in the period": a card untouched for this
 * long cannot have moved within the dashboard's history, so its moves are not
 * fetched (the creatives board alone holds ~3000 cards).
 */
const RECENT_ONLY_BOARDS = new Set([1856420, 1857364, 1538010]);
const RECENT_MS = 270 * 24 * 60 * 60_000;

/**
 * Select properties whose values are read as names: department, position,
 * source (hiring); buyer, team, vertical, geo (links).
 */
const SELECT_PROPERTIES = [674228, 674229, 674221, 507373, 506928, 508175, 508176];

export function kaitenConfigured(): boolean {
  return Boolean(kaitenUrl() && kaitenToken());
}

let lastCall = 0;
/** Set when the window's budget ran out: no call before this moment. */
let pausedUntil = 0;

async function call<T>(pathname: string, attempt = 0): Promise<T> {
  if (!kaitenConfigured()) throw new Error('Kaiten не настроен: задай KAITEN_URL и KAITEN_TOKEN в .env.');
  const wait = Math.max(lastCall + CALL_GAP_MS, pausedUntil) - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${kaitenUrl()}/api/latest${pathname}`, {
      headers: { Authorization: `Bearer ${kaitenToken()}`, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`Kaiten недоступен: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  // Out of budget for this window: hold the next call until it resets.
  const remaining = Number(res.headers.get('x-ratelimit-remaining'));
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (res.headers.has('x-ratelimit-remaining') && remaining <= 1 && reset > 0) {
    pausedUntil = Math.min(reset * 1000 + 500, Date.now() + 70_000);
  }
  if (res.status === 429 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 15_000));
    return call<T>(pathname, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.warn(`${pathname} → ${res.status}: ${text.slice(0, 300)}`);
    if (res.status === 401 || res.status === 403) throw new Error('Kaiten отклонил токен.');
    throw new Error(`Kaiten ${res.status}`);
  }
  return (await res.json()) as T;
}

interface RawCard {
  id: number;
  title: string;
  board_id: number;
  column_id: number;
  archived?: boolean;
  condition?: number;
  created: string;
  updated: string;
  type_id?: number | null;
  properties?: Record<string, unknown> | null;
}

interface RawMove {
  board_id: number;
  column_id: number;
  subcolumn_id: number | null;
  changed: string;
}

/* ------------------------- sync ------------------------- */

let running: Promise<void> | null = null;

export function startKaitenSync(): void {
  if (!kaitenConfigured()) {
    log.info('KAITEN_URL / KAITEN_TOKEN не заданы — дашборд без Kaiten.');
    return;
  }
  const run = () => void syncKaiten().catch((err) => log.warn(`Синхронизация Kaiten: ${err instanceof Error ? err.message : err}`));
  setTimeout(run, 20_000);
  setInterval(run, SYNC_EVERY_MS);
}

/** One sync at a time; a second caller waits for the running one. */
export function syncKaiten(): Promise<void> {
  running ??= doSync().finally(() => (running = null));
  return running;
}

export function kaitenSyncedAt(): number | null {
  const v = getSetting('kaiten.syncedAt');
  return v ? Number(v) : null;
}

async function doSync(): Promise<void> {
  const started = Date.now();
  const conn = db();
  const known = new Map(
    (conn.prepare('SELECT id, history_updated FROM kaiten_cards').all() as { id: number; history_updated: string | null }[]).map(
      (r) => [r.id, r.history_updated],
    ),
  );
  const cards: RawCard[] = [];
  for (const board of KAITEN_BOARDS) {
    for (const condition of [1, 2]) {
      for (let offset = 0; ; offset += PAGE) {
        const page = await call<RawCard[]>(`/cards?board_id=${board}&condition=${condition}&limit=${PAGE}&offset=${offset}`);
        cards.push(...page);
        if (page.length < PAGE) break;
      }
    }
  }

  const upsert = conn.prepare(
    `INSERT INTO kaiten_cards (id, title, board_id, column_id, archived, properties, created_at, updated_at, seen_at, type_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, board_id = excluded.board_id, column_id = excluded.column_id,
       archived = excluded.archived, properties = excluded.properties, updated_at = excluded.updated_at, seen_at = excluded.seen_at,
       type_id = excluded.type_id`,
  );
  for (const c of cards) {
    upsert.run(
      c.id,
      String(c.title ?? ''),
      c.board_id,
      c.column_id,
      c.archived || c.condition === 2 ? 1 : 0,
      c.properties ? JSON.stringify(c.properties) : null,
      c.created,
      c.updated,
      started,
      c.type_id ?? null,
    );
  }

  let histories = 0;
  for (const c of cards) {
    if (known.get(c.id) === c.updated) continue;
    if (RECENT_ONLY_BOARDS.has(c.board_id) && started - Date.parse(c.updated) > RECENT_MS) continue;
    const moves = await call<RawMove[]>(`/cards/${c.id}/location-history`);
    conn.exec('BEGIN');
    try {
      conn.prepare('DELETE FROM kaiten_moves WHERE card_id = ?').run(c.id);
      const add = conn.prepare(
        'INSERT OR IGNORE INTO kaiten_moves (card_id, at, board_id, column_id, subcolumn_id) VALUES (?, ?, ?, ?, ?)',
      );
      for (const m of moves) add.run(c.id, m.changed, m.board_id, m.column_id, m.subcolumn_id ?? null);
      conn.prepare('UPDATE kaiten_cards SET history_updated = ? WHERE id = ?').run(c.updated, c.id);
      conn.exec('COMMIT');
    } catch (err) {
      conn.exec('ROLLBACK');
      throw err;
    }
    histories++;
  }

  for (const property of SELECT_PROPERTIES) {
    const values = await call<{ id: number; value: string }[]>(`/company/custom-properties/${property}/select-values`);
    const put = conn.prepare(
      `INSERT INTO kaiten_select_values (id, property_id, value) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET value = excluded.value`,
    );
    for (const v of values) put.run(v.id, property, v.value);
  }
  // The list leaves out deleted values, but old cards still point at them
  // (the buyer list was recreated in Oct 2026): fetch those one by one, once.
  const named = new Set((conn.prepare('SELECT id FROM kaiten_select_values').all() as { id: number }[]).map((r) => r.id));
  const missing = new Map<number, number>();
  for (const c of cards) {
    for (const property of SELECT_PROPERTIES) {
      const v = c.properties?.[`id_${property}`];
      for (const id of Array.isArray(v) ? v : v == null ? [] : [v]) {
        if (typeof id === 'number' && !named.has(id)) missing.set(id, property);
      }
    }
  }
  for (const [id, property] of missing) {
    try {
      const v = await call<{ id: number; value: string }>(`/company/custom-properties/${property}/select-values/${id}`);
      conn
        .prepare('INSERT INTO kaiten_select_values (id, property_id, value) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
        .run(v.id, property, v.value);
    } catch (err) {
      log.warn(`Значение ${id} поля ${property}: ${err instanceof Error ? err.message : err}`);
    }
  }

  setSetting('kaiten.syncedAt', String(Date.now()));
  log.info(`Kaiten: ${cards.length} карточек, история обновлена у ${histories}, ${Date.now() - started} мс`);
}

/** Card link in the Kaiten UI. */
export function kaitenCardUrl(id: number): string {
  return `${kaitenUrl()}/${id}`;
}
