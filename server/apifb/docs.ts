import { googleConnected, googleFetch } from '../drive/google';
import { listApifbGeos } from './catalog';
import { parseApifbLines, type ParsedApifbLine } from './parse';

/** Plain-text export of a Google Doc (APIFB dump). */
export async function fetchDocText(docId: string): Promise<string> {
  if (!googleConnected()) {
    throw new Error('Google Drive не подключён.');
  }
  const url =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(docId)}/export` +
    `?mimeType=${encodeURIComponent('text/plain')}`;
  const res = await googleFetch(url);
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(
      `Не удалось скачать док ${docId} (HTTP ${res.status}). ` +
        `Аккаунт Drive должен видеть этот документ. ${err.slice(0, 200)}`,
    );
  }
  return res.text();
}

export async function loadApifbDoc(
  verticalId: string,
  geoId: string,
): Promise<{ geoLabel: string; docId: string; events: ParsedApifbLine[] }> {
  const geos = await listApifbGeos(verticalId);
  const geo = geos.find((g) => g.id === geoId);
  if (!geo) throw new Error('Гео не найдено в индексе для этого направления.');
  const text = await fetchDocText(geo.docId);
  const events = parseApifbLines(text);
  if (!events.length) {
    throw new Error(`В доке «${geo.label}» нет строк APIFB (event#ip#ua#…).`);
  }
  return { geoLabel: geo.label, docId: geo.docId, events };
}
