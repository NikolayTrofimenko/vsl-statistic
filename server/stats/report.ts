import type { SQLInputValue } from 'node:sqlite';
import { db } from '../db';
import { accumulate, hasBit, MAX_SECONDS } from './bitmap';
import { isUnresolvedSrc, urlKey } from './identity';
import { craftNamesByUrl } from '../craft/sync';
import type {
  BreakdownRow,
  GroupSummary,
  StatsMetrics,
  StatsOverview,
  DailyRow,
  LandVideoDetail,
  LandVideoPatch,
  LandVideoSummary,
  StatsFacets,
  StatsFilter,
} from '../../src/shared/api.types';

/**
 * Read side of the stats: per landing-video summaries and the detail view
 * with the retention curve. Everything is computed on request from `views`
 * — at the volumes a VSL funnel sees that is milliseconds, and it keeps the
 * write path a single upsert.
 */

/** A play counts as "completed" past this share of the video. */
const COMPLETION_SHARE = 0.9;
const HISTOGRAM_TARGET_BUCKETS = 40;
const BUCKET_STEPS = [5, 10, 15, 30, 60, 120, 300, 600];

interface LvRow {
  id: number;
  land: string;
  video_key: string;
  src: string;
  duration: number | null;
  popup_at: number | null;
  drive_file_id: string | null;
  drive_name: string | null;
  last_seen: number;
}

export function facets(): StatsFacets {
  const conn = db();
  const col = (sql: string) => (conn.prepare(sql).all() as { v: string }[]).map((r) => r.v);
  return {
    lands: col('SELECT DISTINCT land AS v FROM land_videos ORDER BY land'),
    devices: col('SELECT DISTINCT device AS v FROM views WHERE device IS NOT NULL ORDER BY device'),
    countries: col('SELECT DISTINCT country AS v FROM views WHERE country IS NOT NULL ORDER BY country'),
    buyers: col('SELECT DISTINCT buyer AS v FROM views WHERE buyer IS NOT NULL ORDER BY buyer'),
  };
}

export function overview(filter: StatsFilter): StatsOverview {
  const where = viewFilter(filter);
  const lvs = new Map(loadLandVideos().map((lv) => [lv.id, lv]));
  const craft = craftNamesByUrl();

  const rows = [...aggregate(where, 'lv.id')]
    .filter(([id]) => lvs.has(Number(id)))
    .map(([id, t]) => summarize(lvs.get(Number(id))!, t, craft))
    .sort((x, y) => y.views - x.views);

  // Group totals come from the raw views, not from the rows above: a median or
  // a completion rate cannot be rebuilt from per-row medians and rates.
  const memberIds = (keyOf: (r: LandVideoSummary) => string) => {
    const out = new Map<string, number[]>();
    for (const r of rows) {
      const key = keyOf(r);
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push(r.id);
    }
    return out;
  };

  const byVideoIds = memberIds((r) => r.src);
  const byVideo = [...aggregate(where, 'lv.src')].map(([src, t]): GroupSummary => {
    const sample = rows.find((r) => r.src === src);
    return {
      key: src,
      label: sample ? videoLabel(sample) : src,
      durationSec: sample?.durationSec ?? null,
      memberIds: byVideoIds.get(src) ?? [],
      ...metrics(t, sample?.durationSec ?? null),
    };
  });

  const byLandIds = memberIds((r) => r.land);
  const byLand = [...aggregate(where, 'lv.land')].map(([land, t]): GroupSummary => ({
    key: land,
    label: land,
    durationSec: null,
    memberIds: byLandIds.get(land) ?? [],
    ...metrics(t, t.durationKnown ? 1 : null),
  }));

  return { rows, byVideo, byLand };
}

/**
 * Totals per group of views, keyed by `keyExpr` (a `land_videos` column).
 * Medians need the sorted values, so the started views are read once more.
 */
function aggregate(
  where: { sql: string; params: SQLInputValue[] },
  keyExpr: 'lv.id' | 'lv.src' | 'lv.land',
): Map<string, Totals> {
  const conn = db();
  const rows = conn
    .prepare(
      `
      SELECT ${keyExpr} AS k,
        COUNT(*) AS views,
        SUM(v.started) AS plays,
        AVG(CASE WHEN v.started = 1 THEN v.watched_sec END) AS avg_watch,
        SUM(CASE WHEN v.started = 1 AND lv.duration > 0 AND v.watched_sec >= lv.duration * ${COMPLETION_SHARE} THEN 1 ELSE 0 END) AS completed,
        MAX(CASE WHEN lv.duration > 0 THEN 1 ELSE 0 END) AS duration_known,
        SUM(v.submitted) AS submits,
        AVG(CASE WHEN v.submitted = 1 THEN v.watched_sec END) AS avg_watch_sub,
        SUM(CASE WHEN v.error IS NOT NULL THEN 1 ELSE 0 END) AS errors
      FROM views v JOIN land_videos lv ON lv.id = v.lv_id
      WHERE ${where.sql}
      GROUP BY ${keyExpr}
    `,
    )
    .all(...where.params) as {
    k: string | number;
    views: number;
    plays: number;
    avg_watch: number | null;
    completed: number;
    duration_known: number;
    submits: number;
    avg_watch_sub: number | null;
    errors: number;
  }[];

  const watched = new Map<string, number[]>();
  const watchRows = conn
    .prepare(
      `SELECT ${keyExpr} AS k, v.watched_sec FROM views v JOIN land_videos lv ON lv.id = v.lv_id
       WHERE ${where.sql} AND v.started = 1 ORDER BY v.watched_sec`,
    )
    .all(...where.params) as { k: string | number; watched_sec: number }[];
  for (const r of watchRows) {
    const key = String(r.k);
    if (!watched.has(key)) watched.set(key, []);
    watched.get(key)!.push(r.watched_sec);
  }

  return new Map(
    rows.map((a) => [
      String(a.k),
      {
        views: a.views,
        plays: a.plays,
        avgWatch: a.avg_watch,
        median: median(watched.get(String(a.k)) ?? []),
        completed: a.completed,
        durationKnown: a.duration_known === 1,
        submits: a.submits,
        avgWatchSub: a.avg_watch_sub,
        errors: a.errors,
      },
    ]),
  );
}

/** The metric block shared by rows and groups. */
function metrics(t: Totals, duration: number | null): StatsMetrics {
  return {
    views: t.views,
    plays: t.plays,
    playRate: t.views ? t.plays / t.views : null,
    avgWatchSec: t.avgWatch,
    medianWatchSec: t.median,
    completionRate: t.plays && duration ? t.completed / t.plays : null,
    submits: t.submits,
    conversion: t.views ? t.submits / t.views : null,
    avgWatchSubmittersSec: t.avgWatchSub,
    errors: t.errors,
  };
}

/** Same naming rule as the client's `videoLabel`. */
function videoLabel(r: LandVideoSummary): string {
  if (r.craftName) return r.craftName;
  if (r.driveFileName) return r.driveFileName;
  if (r.unresolvedSrc) return 'поток не определён (старая версия трекера)';
  try {
    const url = new URL(r.src);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return r.src;
  }
}

export function detail(lvId: number, filter: StatsFilter): LandVideoDetail {
  const lv = loadLandVideos(lvId)[0];
  if (!lv) throw new Error('Видео на ленде не найдено.');

  const where = viewFilter(filter);
  const rows = db()
    .prepare(
      `SELECT v.started, v.submitted, v.watched, v.watched_sec, v.error, v.day,
              v.device, v.country, v.buyer
       FROM views v WHERE ${where.sql} AND v.lv_id = ?`,
    )
    .all(...where.params, lvId) as {
    started: number;
    submitted: number;
    watched: Uint8Array | null;
    watched_sec: number;
    error: string | null;
    day: string;
    device: string | null;
    country: string | null;
    buyer: string | null;
  }[];

  const plays = rows.filter((r) => r.started);
  const longestBits = plays.reduce((m, r) => Math.max(m, (r.watched?.length ?? 0) * 8), 0);
  const length = Math.min(MAX_SECONDS, Math.ceil(lv.duration ?? longestBits) || 0);

  const counts = new Uint32Array(length);
  const submitCounts = new Uint32Array(length);
  const submitPlays = plays.filter((r) => r.submitted).length;
  let popupHits = 0;
  for (const r of plays) {
    if (!r.watched) continue;
    accumulate(r.watched, counts);
    if (r.submitted) accumulate(r.watched, submitCounts);
    if (lv.popup_at != null && hasBit(r.watched, Math.floor(lv.popup_at))) popupHits++;
  }
  const retention = Array.from(counts, (viewers, sec) => ({
    sec,
    viewers,
    share: plays.length ? viewers / plays.length : 0,
    submitShare: submitPlays ? submitCounts[sec]! / submitPlays : null,
  }));

  const bucketSec = BUCKET_STEPS.find((s) => length / s <= HISTOGRAM_TARGET_BUCKETS) ?? 600;
  const histogram = Array.from({ length: Math.max(1, Math.ceil(length / bucketSec)) }, (_, i) => ({
    fromSec: i * bucketSec,
    plays: 0,
    submits: 0,
  }));
  for (const r of plays) {
    const bucket = histogram[Math.min(histogram.length - 1, Math.floor(r.watched_sec / bucketSec))]!;
    bucket.plays++;
    if (r.submitted) bucket.submits++;
  }

  const sorted = plays.map((r) => r.watched_sec).sort((a, b) => a - b);
  const submitters = plays.filter((r) => r.submitted);
  const summary = summarize(lv, {
    views: rows.length,
    plays: plays.length,
    avgWatch: mean(plays.map((r) => r.watched_sec)),
    median: median(sorted),
    completed: plays.filter((r) => lv.duration && r.watched_sec >= lv.duration * COMPLETION_SHARE).length,
    durationKnown: Boolean(lv.duration),
    submits: rows.filter((r) => r.submitted).length,
    avgWatchSub: mean(submitters.map((r) => r.watched_sec)),
    errors: rows.filter((r) => r.error).length,
  });

  return {
    summary,
    retention,
    popupReach: lv.popup_at != null && plays.length ? popupHits / plays.length : null,
    histogram,
    bucketSec,
    byDevice: breakdown(rows, (r) => r.device ?? '—'),
    byCountry: breakdown(rows, (r) => r.country ?? '—'),
    byBuyer: breakdown(rows, (r) => r.buyer ?? '—'),
    daily: daily(rows),
  };
}

export function updateLandVideo(id: number, patch: LandVideoPatch): void {
  const conn = db();
  if (patch.driveFileId !== undefined) {
    conn.prepare('UPDATE land_videos SET drive_file_id = ? WHERE id = ?').run(patch.driveFileId, id);
  }
  if (patch.popupAtSec !== undefined) {
    const value = patch.popupAtSec == null ? null : Math.max(0, Number(patch.popupAtSec));
    conn.prepare('UPDATE land_videos SET popup_at = ? WHERE id = ?').run(value, id);
  }
}

export function deleteLandVideo(id: number): void {
  db().prepare('DELETE FROM land_videos WHERE id = ?').run(id);
}

/* ------------------------- internals ------------------------- */

function loadLandVideos(id?: number): LvRow[] {
  const sql = `
    SELECT lv.id, lv.land, lv.video_key, lv.src, lv.duration, lv.popup_at, lv.drive_file_id,
           lv.last_seen, df.name AS drive_name
    FROM land_videos lv LEFT JOIN drive_files df ON df.id = lv.drive_file_id
    ${id === undefined ? '' : 'WHERE lv.id = ?'}
  `;
  const stmt = db().prepare(sql);
  return (id === undefined ? stmt.all() : stmt.all(id)) as unknown as LvRow[];
}

function viewFilter(f: StatsFilter): { sql: string; params: SQLInputValue[] } {
  const parts = ['v.day >= ?', 'v.day <= ?'];
  const params: SQLInputValue[] = [f.from, f.to];
  if (f.land) {
    parts.push('v.lv_id IN (SELECT id FROM land_videos WHERE land = ?)');
    params.push(f.land);
  }
  if (f.device) {
    parts.push('v.device = ?');
    params.push(f.device);
  }
  if (f.country) {
    parts.push('v.country = ?');
    params.push(f.country);
  }
  if (f.buyer) {
    parts.push('v.buyer = ?');
    params.push(f.buyer);
  }
  return { sql: parts.join(' AND '), params };
}

interface Totals {
  views: number;
  plays: number;
  avgWatch: number | null;
  median: number | null;
  completed: number;
  /** At least one video in the group has a known duration. */
  durationKnown: boolean;
  submits: number;
  avgWatchSub: number | null;
  errors: number;
}

function summarize(lv: LvRow, t: Totals, craft = craftNamesByUrl()): LandVideoSummary {
  return {
    id: lv.id,
    land: lv.land,
    videoKey: lv.video_key,
    src: lv.src,
    durationSec: lv.duration,
    popupAtSec: lv.popup_at,
    driveFileId: lv.drive_file_id,
    driveFileName: lv.drive_name,
    craftName: craft.get(urlKey(lv.src))?.name ?? null,
    unresolvedSrc: isUnresolvedSrc(lv.src),
    lastSeenAt: lv.last_seen,
    ...metrics(t, lv.duration),
  };
}

interface BreakdownSource {
  started: number;
  submitted: number;
  watched_sec: number;
  day: string;
}

function breakdown<T extends BreakdownSource>(rows: T[], keyOf: (r: T) => string): BreakdownRow[] {
  const groups = new Map<string, { views: number; plays: number; watch: number; submits: number }>();
  for (const r of rows) {
    const key = keyOf(r);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { views: 0, plays: 0, watch: 0, submits: 0 }));
    g.views++;
    g.submits += r.submitted;
    if (r.started) {
      g.plays++;
      g.watch += r.watched_sec;
    }
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      views: g.views,
      plays: g.plays,
      avgWatchSec: g.plays ? g.watch / g.plays : null,
      submits: g.submits,
    }))
    .sort((a, b) => b.views - a.views);
}

function daily(rows: BreakdownSource[]): DailyRow[] {
  return breakdown(rows, (r) => r.day)
    .map((r) => ({ day: r.key, views: r.views, plays: r.plays, avgWatchSec: r.avgWatchSec, submits: r.submits }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

/** Median of an ascending list. */
function median(sorted: number[]): number | null {
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
