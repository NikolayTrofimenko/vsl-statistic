import * as fs from 'node:fs';
import { db, transaction } from '../db';
import { scopedLogger } from '../logger';
import { urlKey } from '../stats/identity';
import type { CraftStatus } from '../../src/shared/api.types';

/**
 * Names for landing videos, taken from craft-lander's video catalog.
 *
 * craft-lander cuts VSLs into HLS streams on R2 and records each one's name
 * with its `master.m3u8` URL — the very URL a landing plays and the tracker
 * reports. So a landing video is matched to its name by URL alone.
 *
 * The catalog is read straight from craft-lander's data volume, mounted
 * read-only (`CRAFT_VIDEOS_FILE`), and re-read whenever the file changes.
 * Nothing is written back and no craft-lander credentials are needed.
 */

const log = scopedLogger('craft-sync');

const POLL_MS = 60_000;

interface CraftVideo {
  id: string;
  name: string;
  status: string;
  masterUrl?: string;
  durationSec?: number;
  createdAt?: string;
}

const state: CraftStatus = { configured: false, count: 0, syncedAt: null, error: null };
let lastMtime = 0;

export function craftStatus(): CraftStatus {
  return { ...state };
}

export function startCraftSync(): void {
  const file = catalogFile();
  state.configured = Boolean(file);
  if (!file) return;
  syncCatalog();
  setInterval(syncCatalog, POLL_MS).unref();
}

/** Re-read the catalog if it changed since the last read. */
export function syncCatalog(force = false): CraftStatus {
  const file = catalogFile();
  if (!file) return craftStatus();
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (!force && mtime === lastMtime) return craftStatus();

    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { videos?: CraftVideo[] };
    const videos = (parsed.videos ?? []).filter((v) => v.masterUrl && v.status === 'ready');

    const conn = db();
    const now = Date.now();
    const upsert = conn.prepare(`
      INSERT INTO craft_videos (id, name, url, url_key, duration, created_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, url = excluded.url, url_key = excluded.url_key,
        duration = excluded.duration, created_at = excluded.created_at, synced_at = excluded.synced_at
    `);
    transaction(conn, () => {
      for (const v of videos) {
        upsert.run(v.id, v.name, v.masterUrl!, urlKey(v.masterUrl!), v.durationSec ?? null, v.createdAt ?? null, now);
      }
      // Deleted in craft-lander → no longer a name we can vouch for.
      conn.prepare('DELETE FROM craft_videos WHERE synced_at < ?').run(now);
    });

    lastMtime = mtime;
    state.count = videos.length;
    state.syncedAt = now;
    state.error = null;
    log.info(`Каталог craft-lander: ${videos.length} видео.`);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    log.warn(`Не удалось прочитать каталог craft-lander: ${state.error}`);
  }
  return craftStatus();
}

/** name by stream-URL key, for labelling landing videos. */
export function craftNamesByUrl(): Map<string, { id: string; name: string }> {
  const rows = db().prepare('SELECT id, name, url_key FROM craft_videos').all() as {
    id: string;
    name: string;
    url_key: string;
  }[];
  return new Map(rows.map((r) => [r.url_key, { id: r.id, name: r.name }]));
}

function catalogFile(): string {
  return process.env['CRAFT_VIDEOS_FILE']?.trim() ?? '';
}
