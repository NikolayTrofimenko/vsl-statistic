import type { DatabaseSync } from 'node:sqlite';
import { driveFolderId } from '../config';
import { db, transaction } from '../db';
import { scopedLogger } from '../logger';

/**
 * Verticals and permanent creative IDs.
 *
 * A vertical is a top-level folder under the library root (files lying in
 * the root itself form one more). Each gets a three-letter code, by default
 * transliterated from the folder name (Суставы → SUS), and every creative an
 * ID `<code>-<number>` — SUS-0142 — numbered per vertical in Drive-date
 * order. An ID is issued once and stays: buyers paste it into Kaiten and FB
 * campaign names, so moving the file elsewhere must not change it.
 */

const log = scopedLogger('creo-ids');

const CODE_RE = /^[A-Z]{3}$/;
const ROOT_CODE = 'GEN';

/** Bring verticals and IDs up to date after files were added or moved. */
export function syncCreoIds(conn: DatabaseSync = db()): void {
  transaction(conn, () => {
    refreshVerticals(conn);
    const issued = assignIds(conn);
    if (issued) log.info(`Выдано ID крео: ${issued}.`);
  });
}

/** Admin: new code for a vertical. Applies to IDs issued from now on. */
export function setVerticalCode(id: number, raw: string): void {
  const code = String(raw ?? '').trim().toUpperCase();
  if (!CODE_RE.test(code)) throw new Error('Код вертикали — ровно 3 латинские буквы.');
  const conn = db();
  const owner = conn.prepare('SELECT vertical_id FROM vertical_codes WHERE code = ?').get(code) as
    | { vertical_id: number }
    | undefined;
  if (owner && owner.vertical_id !== id) throw new Error(`Код ${code} уже занят другой вертикалью.`);
  transaction(conn, () => {
    const result = conn.prepare('UPDATE verticals SET code = ? WHERE id = ?').run(code, id);
    if (!result.changes) throw new Error('Вертикаль не найдена.');
    conn.prepare('INSERT OR IGNORE INTO vertical_codes (code, vertical_id) VALUES (?, ?)').run(code, id);
  });
}

/* ------------------------- internals ------------------------- */

interface VerticalRow {
  id: number;
  folder_id: string | null;
  name: string;
  code: string;
}

/**
 * One vertical per top-level Drive folder, keyed by folder id so a rename
 * keeps the code. Then point every file at the vertical of its current
 * top-level folder. A folder that is gone from Drive (its files recorded as
 * removed) still gets a vertical by name, so those files get IDs too.
 */
function refreshVerticals(conn: DatabaseSync): void {
  const rootId = driveFolderId();
  const folders = conn
    .prepare(`SELECT id, path FROM drive_folders WHERE instr(path, '/') = 0`)
    .all() as { id: string; path: string }[];
  if (rootId && !folders.some((f) => f.path === '')) folders.push({ id: rootId, path: '' });

  const verticals = conn.prepare('SELECT id, folder_id, name, code FROM verticals').all() as unknown as VerticalRow[];
  const byFolder = new Map(verticals.filter((v) => v.folder_id).map((v) => [v.folder_id!, v]));
  const byName = new Map<string, VerticalRow>();
  const rename = conn.prepare('UPDATE verticals SET name = ? WHERE id = ?');

  for (const folder of folders) {
    const existing = byFolder.get(folder.id);
    if (existing) {
      if (existing.name !== folder.path) rename.run(folder.path, existing.id);
      byName.set(folder.path, { ...existing, name: folder.path });
    } else {
      byName.set(folder.path, createVertical(conn, folder.id, folder.path));
    }
  }
  // Verticals whose folder is gone: still reachable by name for their files.
  for (const v of verticals) if (!byName.has(v.name)) byName.set(v.name, v);

  const files = conn.prepare('SELECT id, folder_path, vertical_id FROM drive_files').all() as {
    id: string;
    folder_path: string;
    vertical_id: number | null;
  }[];
  const point = conn.prepare('UPDATE drive_files SET vertical_id = ? WHERE id = ?');
  for (const f of files) {
    const top = f.folder_path.split('/')[0] ?? '';
    let vertical = byName.get(top);
    if (!vertical) {
      vertical = createVertical(conn, null, top);
      byName.set(top, vertical);
    }
    if (f.vertical_id !== vertical.id) point.run(vertical.id, f.id);
  }
}

function createVertical(conn: DatabaseSync, folderId: string | null, name: string): VerticalRow {
  const taken = new Set(
    (conn.prepare('SELECT code FROM vertical_codes').all() as { code: string }[]).map((r) => r.code),
  );
  const code = pickCode(name, taken);
  const id = Number(
    conn.prepare('INSERT INTO verticals (folder_id, name, code) VALUES (?, ?, ?)').run(folderId, name, code)
      .lastInsertRowid,
  );
  conn.prepare('INSERT INTO vertical_codes (code, vertical_id) VALUES (?, ?)').run(code, id);
  log.info(`Новая вертикаль «${name || 'корень'}» → ${code}.`);
  return { id, folder_id: folderId, name, code };
}

/**
 * Issue IDs to files that have none, oldest Drive date first, so the
 * initial numbering follows the order creatives were added.
 */
function assignIds(conn: DatabaseSync): number {
  const todo = conn
    .prepare(
      `SELECT df.id, df.created_at, df.first_seen_at, df.vertical_id
       FROM drive_files df WHERE df.creo_id IS NULL AND df.vertical_id IS NOT NULL`,
    )
    .all() as { id: string; created_at: string | null; first_seen_at: number | null; vertical_id: number }[];
  if (!todo.length) return 0;

  const time = (f: (typeof todo)[number]) => Date.parse(f.created_at ?? '') || f.first_seen_at || 0;
  todo.sort((a, b) => time(a) - time(b) || a.id.localeCompare(b.id));

  const vertical = conn.prepare('SELECT code, next_num FROM verticals WHERE id = ?');
  const used = conn.prepare('SELECT 1 FROM drive_files WHERE creo_id = ?');
  const issue = conn.prepare('UPDATE drive_files SET creo_id = ? WHERE id = ?');
  const advance = conn.prepare('UPDATE verticals SET next_num = ? WHERE id = ?');

  for (const f of todo) {
    const v = vertical.get(f.vertical_id) as { code: string; next_num: number };
    let num = v.next_num;
    let creoId = formatId(v.code, num);
    // Only after a code change can a number already be taken; skip past it.
    while (used.get(creoId)) creoId = formatId(v.code, ++num);
    issue.run(creoId, f.id);
    advance.run(num + 1, f.vertical_id);
  }
  return todo.length;
}

function formatId(code: string, num: number): string {
  return `${code}-${String(num).padStart(4, '0')}`;
}

/**
 * Three letters from the name: the first three, then the first two plus a
 * later letter, then the first plus two later ones, then the first plus any
 * pair — the first free one wins. Гипертония → GIP, Гипопотенция → GIO.
 */
export function pickCode(name: string, taken: ReadonlySet<string>): string {
  const letters = [...(translit(name).replace(/[^A-Z]/g, '') || ROOT_CODE)];
  while (letters.length < 3) letters.push('X');
  const candidates: string[] = [letters.slice(0, 3).join('')];
  for (let k = 2; k < letters.length; k++) candidates.push(letters[0]! + letters[1]! + letters[k]!);
  for (let j = 1; j < letters.length; j++) {
    for (let k = j + 1; k < letters.length; k++) candidates.push(letters[0]! + letters[j]! + letters[k]!);
  }
  for (const code of candidates) if (!taken.has(code)) return code;
  const az = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const a of az) for (const b of az) if (!taken.has(letters[0] + a + b)) return letters[0] + a + b;
  throw new Error('Не осталось свободных кодов вертикали.');
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};

function translit(text: string): string {
  return [...text.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join('').toUpperCase();
}
