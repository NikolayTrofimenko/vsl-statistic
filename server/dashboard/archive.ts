import { googleConnected, googleFetch } from '../drive/google';
import { scopedLogger } from '../logger';
import { dayIn, fmtDay, inside, shortLabel } from './periods';
import type { DashDetail, DashMetric, DashPeriod } from '../../src/shared/dashboard.types';

/**
 * «Связок найдено и передано в отдел новых связок»: the analysts' archive on
 * Google Drive («База лендов Euphoria»). Top-level folders are verticals; each
 * item inside a vertical (a video of the landing, or a folder) is one link,
 * counted on the day it was put there (Moscow); Mac's .DS_Store is skipped.
 * Read live from Drive, cached for a few minutes.
 */

const log = scopedLogger('dashboard');

export const ARCHIVE_FOLDER_ID = '1XsNWkBCubnbSPyfpfTmsYRgJrt7QjJiR';
const METRIC_ID = 'analytics.found';
const LABEL = 'Связок найдено и передано в отдел новых связок';
const SOURCE = 'Google Диск · База лендов';
const FOLDER = 'application/vnd.google-apps.folder';
const CACHE_MS = 5 * 60 * 1000;

interface ArchiveLink {
  id: string;
  name: string;
  vertical: string;
  day: string;
  folder: boolean;
}

interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
}

let cache: { at: number; links: ArchiveLink[] } | null = null;
let inflight: Promise<ArchiveLink[]> | null = null;

async function children(parent: string, foldersOnly: boolean): Promise<DriveItem[]> {
  const out: DriveItem[] = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${parent}' in parents and ${foldersOnly ? `mimeType = '${FOLDER}' and ` : ''}trashed = false`);
    const r = await googleFetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&supportsAllDrives=true&includeItemsFromAllDrives=true` +
        `&pageSize=1000&fields=nextPageToken,files(id,name,mimeType,createdTime)${pageToken ? `&pageToken=${pageToken}` : ''}`,
    );
    if (!r.ok) throw new Error(`Google Drive ответил ${r.status}`);
    const j = (await r.json()) as { files: DriveItem[]; nextPageToken?: string };
    out.push(...j.files);
    pageToken = j.nextPageToken ?? '';
  } while (pageToken);
  return out.filter((f) => !f.name.startsWith('.'));
}

async function loadArchive(): Promise<ArchiveLink[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.links;
  inflight ??= (async () => {
    try {
      const verticals = await children(ARCHIVE_FOLDER_ID, true);
      const lists = await Promise.all(
        verticals.map(async (v) =>
          (await children(v.id, false)).map((f) => ({
            id: f.id,
            name: f.name.replace(/\.(mp4|mov|webm|m4v)$/i, ''),
            vertical: v.name,
            day: dayIn(f.createdTime),
            folder: f.mimeType === FOLDER,
          })),
        ),
      );
      const links = lists.flat();
      cache = { at: Date.now(), links };
      return links;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function archiveMetric(periods: DashPeriod[]): Promise<DashMetric> {
  const base: DashMetric = { id: METRIC_ID, label: LABEL, status: 'live', source: SOURCE, unit: 'count', value: null, previous: null, series: [], detail: true };
  if (!googleConnected()) return { ...base, status: 'pending', detail: false, source: 'Google Drive не подключён' };
  try {
    const links = await loadArchive();
    const pick = (p: DashPeriod) => links.filter((l) => inside(l.day, p));
    const counted = pick(periods.at(-1)!);
    const byVertical = new Map<string, number>();
    for (const l of counted) byVertical.set(l.vertical, (byVertical.get(l.vertical) ?? 0) + 1);
    return {
      ...base,
      value: counted.length,
      previous: pick(periods.at(-2)!).length,
      series: periods.map((p) => ({ label: shortLabel(p), value: pick(p).length })),
      note: [...byVertical].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}: ${n}`).join(' · ') || undefined,
    };
  } catch (err) {
    log.warn(`Архив связок: ${err instanceof Error ? err.message : String(err)}`);
    return { ...base, note: `Google Drive: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function archiveDetail(period: DashPeriod): Promise<DashDetail> {
  const links = (await loadArchive()).filter((l) => inside(l.day, period)).sort((a, b) => b.day.localeCompare(a.day));
  return {
    title: `${LABEL} · ${period.label}`,
    columns: ['Вертикаль', 'Добавлена'],
    rows: links.map((l) => ({
      name: l.name,
      cells: [l.vertical, fmtDay(l.day)],
      url: l.folder ? `https://drive.google.com/drive/folders/${l.id}` : `https://drive.google.com/file/d/${l.id}/view`,
    })),
  };
}
