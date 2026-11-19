import { googleConnected, googleFetch } from '../drive/google';

/** Index spreadsheet «Пиксельная» — vertical tabs → geo → Google Doc with APIFB lines. */
const INDEX_SHEET_ID = '1mNE5jDONDqsoEb7eLY9pe3yBmeEO0jhyh2LruR6f0p4';

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

export const APIFB_VERTICALS: ApifbVertical[] = [
  { id: 'prost', label: 'Прост/потенция', gid: 0 },
  { id: 'diabetes', label: 'Диабет', gid: 133208286 },
  { id: 'weightloss', label: 'Похудалка', gid: 1703629771 },
];

/** Geos for one vertical, read from the index sheet (needs Drive connected). */
export async function listApifbGeos(verticalId: string): Promise<ApifbGeo[]> {
  const vertical = APIFB_VERTICALS.find((v) => v.id === verticalId);
  if (!vertical) throw new Error('Неизвестное направление.');
  if (!googleConnected()) {
    throw new Error('Google Drive не подключён — нужен доступ к таблице «Пиксельная» и докам.');
  }

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
  return value
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'geo';
}

/** Minimal CSV line split (quoted fields). */
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
