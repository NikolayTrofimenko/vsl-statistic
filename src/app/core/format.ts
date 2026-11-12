/** Display helpers shared by the pages. */

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatPercent(share: number | null | undefined, digits = 1): string {
  if (share == null || !Number.isFinite(share)) return '—';
  return `${(share * 100).toFixed(digits).replace(/\.0+$/, '')}%`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit >= 2 ? 1 : 0)} ${units[unit]}`;
}

export function formatCount(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString('ru-RU');
}

/** YYYY-MM-DD of a Date in UTC — the day key the stats are bucketed by. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function daysAgo(n: number): string {
  return isoDay(new Date(Date.now() - n * 24 * 60 * 60 * 1000));
}

/**
 * What to call a landing video: craft-lander's name for its stream first, then
 * the linked library file, then the stream URL itself.
 */
export function videoLabel(v: {
  craftName: string | null;
  driveFileName: string | null;
  unresolvedSrc: boolean;
  src: string;
}): string {
  if (v.craftName) return v.craftName;
  if (v.driveFileName) return v.driveFileName;
  if (v.unresolvedSrc) return 'поток не определён (старая версия трекера)';
  try {
    const url = new URL(v.src);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return v.src;
  }
}

/** "07.10.2026" — a date without the time, in the viewer's zone. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru-RU');
}
