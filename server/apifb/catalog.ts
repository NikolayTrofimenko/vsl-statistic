import { googleConnected, googleFetch } from '../drive/google';

/** Index spreadsheet «Пиксельная» — vertical tabs → geo → Google Doc with APIFB lines. */
const INDEX_SHEET_ID = '1mNE5jDONDqsoEb7eLY9pe3yBmeEO0jhyh2LruR6f0p4';

/** Skip the layout template tab. */
const SKIP_TAB = /шаблон/i;

const CACHE_TTL_MS = 60_000;

export interface ApifbVertical {
  id: string;
  label: string;
  gid: number;
}

export interface ApifbGeo {
  id: string;
  label: string;
  region: string | null;
  docId: string;
  docUrl: string;
}

let verticalsCache: { at: number; list: ApifbVertical[] } | null = null;

/** Drop cached sheet tabs — next list/geos call re-reads Google. */
export function invalidateApifbCatalog(): void {
  verticalsCache = null;
}

/**
 * Directions = sheet tabs of «Пиксельная» (except Шаблон), discovered via
 * Sheets API. New tabs show up after refresh / cache expiry.
 */
export async function listApifbVerticals(fresh = false): Promise<ApifbVertical[]> {
  if (!googleConnected()) {
    throw new Error('Google Drive не подключён — нужен доступ к таблице «Пиксельная» и докам.');
  }
  if (!fresh && verticalsCache && Date.now() - verticalsCache.at < CACHE_TTL_MS) {
    return verticalsCache.list;
  }

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${INDEX_SHEET_ID}` +
    `?fields=${encodeURIComponent('sheets.properties(sheetId,title,index)')}`;
  const res = await googleFetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Не удалось прочитать вкладки «Пиксельной» (HTTP ${res.status}). ${body.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as {
    sheets?: { properties?: { sheetId?: number; title?: string; index?: number } }[];
  };
  const list = (json.sheets ?? [])
    .map((s) => {
      const title = String(s.properties?.title ?? '').trim();
      const gid = Number(s.properties?.sheetId);
      if (!title || !Number.isFinite(gid) || SKIP_TAB.test(title)) return null;
      return { id: slug(title), label: title, gid } satisfies ApifbVertical;
    })
    .filter((v): v is ApifbVertical => v != null)
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));

  if (!list.length) {
    throw new Error('В таблице «Пиксельная» нет вкладок-направлений (кроме Шаблон).');
  }
  verticalsCache = { at: Date.now(), list };
  return list;
}

/** Geos for one vertical, read from that tab of the index sheet. */
export async function listApifbGeos(verticalId: string, fresh = false): Promise<ApifbGeo[]> {
  const verticals = await listApifbVerticals(fresh);
  const vertical = verticals.find((v) => v.id === verticalId);
  if (!vertical) throw new Error('Неизвестное направление — нажми «Обновить из Google».');

  const url =
    `https://docs.google.com/spreadsheets/d/${INDEX_SHEET_ID}/export` +
    `?format=csv&gid=${vertical.gid}`;
  const res = await googleFetch(url);
  if (!res.ok) {
    throw new Error(`Не удалось прочитать индекс (HTTP ${res.status}). Проверь доступ Drive к таблице.`);
  }
  const csv = await res.text();
  return parseIndexCsv(csv);
}

function parseIndexCsv(csv: string): ApifbGeo[] {
  const geos: ApifbGeo[] = [];
  let region: string | null = null;
  for (const raw of csv.split(/\r?\n/)) {
    const cols = parseCsvLine(raw);
    if (cols.length < 3) continue;
    const r = cols[0]?.trim() || '';
    const country = cols[1]?.trim() || '';
    const link = cols[2]?.trim() || '';
    if (r) region = r;
    const docId = docIdFromUrl(link);
    if (!country || !docId) continue;
    geos.push({
      id: slug(`${region ?? ''}-${country}`),
      label: country,
      region,
      docId,
      docUrl: link,
    });
  }
  return geos;
}

function docIdFromUrl(url: string): string | null {
  const m = url.match(/\/(?:document|file)\/d\/([a-zA-Z0-9_-]+)/);
  return m?.[1] ?? null;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-zа-яё0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'geo'
  );
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}
