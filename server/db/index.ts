import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataRoot } from '../config';
import { scopedLogger } from '../logger';
import { normalizeLand, normalizeSrc } from '../stats/identity';

/**
 * The SQLite database — Node's built-in driver, so there is no native module
 * to compile on Windows or in the slim Docker image.
 *
 * Migrations are an ordered list; `PRAGMA user_version` records how many have
 * run. Append new ones, never edit a shipped one. A migration is SQL, or a
 * function when rows have to be rewritten with app logic.
 */

type Migration = string | ((conn: DatabaseSync) => void);

const log = scopedLogger('db');

const MIGRATIONS: Migration[] = [
  /* 1 — library, groups, stats */
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE video_groups (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL,
    color TEXT NOT NULL,
    sort  INTEGER NOT NULL DEFAULT 0
  );

  -- One row per video file found under the Drive root folder.
  -- group_id / note are ours; sync never touches them.
  CREATE TABLE drive_files (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size          INTEGER,
    duration_ms   INTEGER,
    width         INTEGER,
    height        INTEGER,
    folder_path   TEXT NOT NULL DEFAULT '',
    modified_at   TEXT NOT NULL,
    web_view_link TEXT,
    thumb_at      TEXT,
    removed       INTEGER NOT NULL DEFAULT 0,
    synced_at     INTEGER NOT NULL,
    group_id      INTEGER REFERENCES video_groups(id) ON DELETE SET NULL,
    note          TEXT NOT NULL DEFAULT ''
  );

  -- A video as it appears on a landing: identified by landing + stream URL.
  CREATE TABLE land_videos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    land          TEXT NOT NULL,
    video_key     TEXT NOT NULL,
    src           TEXT NOT NULL,
    duration      REAL,
    popup_at      REAL,
    drive_file_id TEXT REFERENCES drive_files(id) ON DELETE SET NULL,
    first_seen    INTEGER NOT NULL,
    last_seen     INTEGER NOT NULL,
    UNIQUE (land, src)
  );

  -- One row per page view × video. The tracker re-sends the full state of the
  -- view on every beacon, so rows are upserted, never appended.
  CREATE TABLE views (
    sid         TEXT NOT NULL,
    lv_id       INTEGER NOT NULL REFERENCES land_videos(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    day         TEXT NOT NULL,
    country     TEXT,
    device      TEXT,
    os          TEXT,
    browser     TEXT,
    referrer    TEXT,
    page        TEXT,
    subid       TEXT,
    buyer       TEXT,
    utm_source  TEXT,
    utm_campaign TEXT,
    started     INTEGER NOT NULL DEFAULT 0,
    ended       INTEGER NOT NULL DEFAULT 0,
    submitted   INTEGER NOT NULL DEFAULT 0,
    watched     BLOB,
    watched_sec INTEGER NOT NULL DEFAULT 0,
    max_pos     REAL NOT NULL DEFAULT 0,
    play_time   REAL NOT NULL DEFAULT 0,
    error       TEXT,
    marks       TEXT,
    PRIMARY KEY (sid, lv_id)
  );
  CREATE INDEX views_lv_day ON views (lv_id, day);
  CREATE INDEX views_day ON views (day);
  CREATE INDEX views_subid ON views (subid);
  `,

  /* 2 — craft-lander video catalog */
  `
  CREATE TABLE craft_videos (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    url        TEXT NOT NULL,
    url_key    TEXT NOT NULL,
    duration   REAL,
    created_at TEXT,
    synced_at  INTEGER NOT NULL
  );
  CREATE INDEX craft_videos_url_key ON craft_videos (url_key);
  `,

  /* 3 — re-home views recorded under the snippet placeholder or a blob: src */
  rehomeViews,

  /* 4 — creative library: upload date, geo, language, transcript, translation */
  `
  ALTER TABLE drive_files ADD COLUMN created_at TEXT;
  -- Country (ISO 3166-1 alpha-2). geo_source: 'name' = guessed from the file
  -- name and re-guessed on rename; 'manual' = set by a person, never touched.
  ALTER TABLE drive_files ADD COLUMN geo TEXT;
  ALTER TABLE drive_files ADD COLUMN geo_source TEXT;
  -- Spoken language (ISO 639-1) as detected by whisper.
  ALTER TABLE drive_files ADD COLUMN lang TEXT;
  ALTER TABLE drive_files ADD COLUMN transcript TEXT;
  ALTER TABLE drive_files ADD COLUMN transcript_ru TEXT;
  -- pending → done | failed. Translation can lag behind (no API key yet).
  ALTER TABLE drive_files ADD COLUMN transcribe_status TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE drive_files ADD COLUMN transcribe_error TEXT;
  ALTER TABLE drive_files ADD COLUMN transcribed_at INTEGER;
  ALTER TABLE drive_files ADD COLUMN translate_error TEXT;
  CREATE INDEX drive_files_transcribe ON drive_files (transcribe_status);

  -- Folders under the library root — upload targets.
  CREATE TABLE drive_folders (
    id        TEXT PRIMARY KEY,
    path      TEXT NOT NULL,
    synced_at INTEGER NOT NULL
  );
  `,

  /* 5 — when a video first appeared in our library (drives "new" badges) */
  `
  ALTER TABLE drive_files ADD COLUMN first_seen_at INTEGER;
  -- Everything already here counts as seen at its Drive upload time.
  UPDATE drive_files SET first_seen_at = COALESCE(CAST(strftime('%s', created_at) AS INTEGER) * 1000, synced_at);
  `,

  /* 6 — personal accounts instead of shared role passwords */
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    login         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('buyer', 'teamlead', 'admin')),
    -- A buyer's team lead: sees the buyer's tags.
    teamlead_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    -- Bumped on password reset / disabling: invalidates every issued session.
    session_gen   INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );
  `,

  /* 7 — verticals (top-level Drive folders) and permanent creative IDs */
  `
  CREATE TABLE verticals (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Top-level folder under the library root (or the root itself). NULL when
    -- the folder is gone from Drive but its files are still recorded.
    folder_id TEXT UNIQUE,
    name      TEXT NOT NULL,
    -- Prefix for new IDs. Changing it affects only IDs issued afterwards.
    code      TEXT NOT NULL UNIQUE,
    -- Next number to issue: one running sequence per vertical.
    next_num  INTEGER NOT NULL DEFAULT 1
  );
  -- Every code a vertical ever had, so no other vertical can take it and
  -- issue look-alike IDs.
  CREATE TABLE vertical_codes (
    code        TEXT PRIMARY KEY,
    vertical_id INTEGER NOT NULL REFERENCES verticals(id) ON DELETE CASCADE
  );
  -- vertical_id follows the file's current folder; creo_id (e.g. SUS-0142)
  -- is issued once and never changes, even if the file moves.
  ALTER TABLE drive_files ADD COLUMN vertical_id INTEGER REFERENCES verticals(id) ON DELETE SET NULL;
  ALTER TABLE drive_files ADD COLUMN creo_id TEXT;
  CREATE UNIQUE INDEX drive_files_creo_id ON drive_files (creo_id);
  `,

  /* 8 — per-user tags on creatives */
  `
  CREATE TABLE tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (owner_id, name)
  );
  CREATE TABLE file_tags (
    file_id    TEXT NOT NULL REFERENCES drive_files(id) ON DELETE CASCADE,
    tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (file_id, tag_id)
  );
  CREATE INDEX file_tags_tag ON file_tags (tag_id);
  `,

  /* 9 — who uploaded a creative, deletion through the service, "это повтор" marks */
  `
  -- Set for uploads through the service; NULL = appeared on Drive directly.
  ALTER TABLE drive_files ADD COLUMN uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
  -- Deleted here (file moved to the Drive trash). The row stays so the
  -- creative ID is never issued again; sync never brings it back.
  ALTER TABLE drive_files ADD COLUMN deleted_at INTEGER;
  ALTER TABLE drive_files ADD COLUMN deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

  -- One mark per person per creative; original_id is a creative ID (SUS-0087).
  CREATE TABLE duplicate_marks (
    file_id     TEXT NOT NULL REFERENCES drive_files(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_id TEXT,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (file_id, user_id)
  );
  `,

  /* 10 — caps: a partner's daily lead limit, made of Keitaro offers */
  `
  CREATE TABLE caps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    daily_limit INTEGER NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL
  );
  -- Keitaro offers whose leads count towards the cap. The name is a snapshot
  -- for when the offer is gone from Keitaro.
  CREATE TABLE cap_offers (
    cap_id     INTEGER NOT NULL REFERENCES caps(id) ON DELETE CASCADE,
    offer_id   INTEGER NOT NULL,
    offer_name TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (cap_id, offer_id)
  );
  `,

  /* 11 — caps by rule: a partner (+ geo, name words) instead of a fixed list */
  `
  -- Rule caps have rule_network_id; their cap_offers rows are the last
  -- resolved set, used when Keitaro can't be asked.
  ALTER TABLE caps ADD COLUMN rule_network_id INTEGER;
  ALTER TABLE caps ADD COLUMN rule_country TEXT;
  ALTER TABLE caps ADD COLUMN rule_name TEXT NOT NULL DEFAULT '';
  CREATE TABLE cap_excluded (
    cap_id   INTEGER NOT NULL REFERENCES caps(id) ON DELETE CASCADE,
    offer_id INTEGER NOT NULL,
    PRIMARY KEY (cap_id, offer_id)
  );
  `,

  /* 12 — Telegram cap alerts already sent (one per cap, day and kind) */
  `
  CREATE TABLE cap_alerts (
    cap_id  INTEGER NOT NULL,
    day     TEXT NOT NULL,
    kind    TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (cap_id, day, kind)
  );
  `,

  /* 13 — paid domain actions (renewals…), for the record */
  `
  CREATE TABLE domain_actions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    domain     TEXT NOT NULL,
    action     TEXT NOT NULL,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    ok         INTEGER NOT NULL,
    charged    REAL,
    error      TEXT,
    created_at INTEGER NOT NULL
  );
  `,

  /* 14 — domain registry: what only we know about a root (owner, pixel, ban, renewal call) */
  `
  CREATE TABLE domain_roots (
    name         TEXT PRIMARY KEY,
    -- A buyer, or a team whose buyers share the root (shared pixel).
    owner        TEXT,
    team         TEXT,
    shared_pixel INTEGER NOT NULL DEFAULT 0,
    -- The team's own infrastructure (tracker, this app…): never cleaned up.
    service      INTEGER NOT NULL DEFAULT 0,
    banned_at    INTEGER,
    -- yes | no | ask; NULL — not decided.
    renew        TEXT,
    renew_note   TEXT NOT NULL DEFAULT '',
    updated_at   INTEGER NOT NULL
  );
  -- A banned subdomain keeps its slot taken even after it leaves Keitaro.
  CREATE TABLE domain_sub_bans (
    host      TEXT PRIMARY KEY,
    root      TEXT NOT NULL,
    banned_at INTEGER NOT NULL
  );
  CREATE INDEX domain_sub_bans_root ON domain_sub_bans (root);
  `,

  /* 15 — "Ошибка" reports on creatives (wrong geo, wrong vertical…) */
  `
  CREATE TABLE creo_reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id     TEXT NOT NULL REFERENCES drive_files(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    -- Closed by the admin once the card is fixed; kept for the record.
    resolved_at INTEGER,
    resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX creo_reports_open ON creo_reports (file_id) WHERE resolved_at IS NULL;
  `,

  /* 16 — keys for the read-only stats API (only a hash of each key is kept) */
  `
  CREATE TABLE api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    -- First characters, to tell keys apart in the list.
    prefix       TEXT NOT NULL,
    created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at   INTEGER
  );
  `,

  /* 17 — access roles: admin-made sets of sections on top of the base role */
  `
  CREATE TABLE access_roles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    -- JSON array of section ids (src/shared/access.ts).
    sections   TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  -- NULL — the default sections (library), i.e. what everyone had before.
  ALTER TABLE users ADD COLUMN access_role_id INTEGER REFERENCES access_roles(id) ON DELETE SET NULL;
  `,

  /* 18 — Keitaro access sharing: buyer teams and a log of who shared what */
  `
  CREATE TABLE grant_teams (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    -- Our account that leads it: may edit it and share to its members.
    lead_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE TABLE grant_team_members (
    team_id INTEGER NOT NULL REFERENCES grant_teams(id) ON DELETE CASCADE,
    -- Keitaro user login.
    login   TEXT NOT NULL,
    PRIMARY KEY (team_id, login)
  );
  CREATE TABLE grant_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind        TEXT NOT NULL,
    target_id   INTEGER NOT NULL,
    target_name TEXT NOT NULL,
    -- JSON arrays of Keitaro logins.
    added       TEXT NOT NULL,
    removed     TEXT NOT NULL,
    failed      TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  `,

  /* 19 — a share of several targets is one batch in the access log */
  `
  ALTER TABLE grant_log ADD COLUMN batch_id INTEGER;
  `,

  /* 20 — Kaiten cards and their column moves (dashboard: hiring) */
  `
  CREATE TABLE kaiten_cards (
    id              INTEGER PRIMARY KEY,
    title           TEXT NOT NULL,
    board_id        INTEGER NOT NULL,
    column_id       INTEGER NOT NULL,
    archived        INTEGER NOT NULL DEFAULT 0,
    -- Kaiten custom properties as returned ({"id_674228": [19072769], …}).
    properties      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    -- The card's 'updated' when its moves were last read: unchanged → not re-read.
    history_updated TEXT,
    seen_at         INTEGER NOT NULL
  );
  CREATE TABLE kaiten_moves (
    card_id      INTEGER NOT NULL REFERENCES kaiten_cards(id) ON DELETE CASCADE,
    at           TEXT NOT NULL,
    board_id     INTEGER NOT NULL,
    column_id    INTEGER NOT NULL,
    subcolumn_id INTEGER,
    PRIMARY KEY (card_id, at, column_id)
  );
  CREATE TABLE kaiten_select_values (
    id          INTEGER PRIMARY KEY,
    property_id INTEGER NOT NULL,
    value       TEXT NOT NULL
  );
  `,

  /* 21 — copies of Keitaro users' access, a new row whenever it changed: a bad write can be undone */
  `
  CREATE TABLE keitaro_access_snapshots (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER NOT NULL,
    login    TEXT NOT NULL,
    access   TEXT NOT NULL,
    taken_at INTEGER NOT NULL
  );
  CREATE INDEX keitaro_access_snapshots_user ON keitaro_access_snapshots (user_id, id);
  `,

  /* 22 — Kaiten card type ("Запрос на новый оффер", "Новые связки на тест", …) */
  `
  ALTER TABLE kaiten_cards ADD COLUMN type_id INTEGER;
  `,

  /* 23 — one role per person: an access role also says whose tags show and whether it leads a team */
  mergeRoles,

  /* 24 — База знаний: training videos (files on Drive), articles and links */
  `
  CREATE TABLE kb_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL,
    title         TEXT NOT NULL,
    topic         TEXT NOT NULL DEFAULT '',
    description   TEXT NOT NULL DEFAULT '',
    url           TEXT,
    body          TEXT,
    drive_file_id TEXT,
    file_name     TEXT,
    mime          TEXT,
    size          INTEGER,
    created_by    INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX kb_items_file ON kb_items (drive_file_id);
  `,

  /* 25 — База знаний as documents: rich text with images and videos (files on Drive in kb_files) */
  knowledgeDocs,
];

/**
 * Early beacons carried `data-land="LAND-NAME"` (the snippet pasted unedited)
 * and hls.js `blob:` URLs, which are unique per page load. Move each such view
 * to the landing-video it actually belongs to, then drop the empty shells.
 */
/**
 * Roles used to be two picks — a base role (buyer / team lead / admin) and an
 * access role (sections). Now the access role carries it all: sections, whose
 * tags show (own / team / all) and whether its people lead a team.
 * `users.role` stays as 'admin' or a mirror of the role's `leads`.
 * Existing roles keep "own tags, no team"; team leads get a lead copy of their
 * access role ("Тимлид" when they had none).
 */
function mergeRoles(conn: DatabaseSync): void {
  conn.exec(`
    ALTER TABLE access_roles ADD COLUMN tag_scope TEXT NOT NULL DEFAULT 'own';
    ALTER TABLE access_roles ADD COLUMN leads INTEGER NOT NULL DEFAULT 0;
  `);
  const leads = conn
    .prepare(
      `SELECT u.id, u.access_role_id, r.name, r.sections FROM users u LEFT JOIN access_roles r ON r.id = u.access_role_id
       WHERE u.role = 'teamlead'`,
    )
    .all() as { id: number; access_role_id: number | null; name: string | null; sections: string | null }[];
  const made = new Map<number | null, number>();
  const insert = conn.prepare(
    `INSERT INTO access_roles (name, sections, created_at, tag_scope, leads) VALUES (?, ?, ?, 'team', 1)`,
  );
  for (const u of leads) {
    let roleId = made.get(u.access_role_id);
    if (roleId === undefined) {
      const name = u.name ? `${u.name} · тимлид` : 'Тимлид';
      const existing = conn.prepare('SELECT id FROM access_roles WHERE name = ?').get(name) as { id: number } | undefined;
      roleId = existing
        ? existing.id
        : Number(insert.run(name, u.sections ?? '["library"]', Date.now()).lastInsertRowid);
      if (existing) conn.prepare(`UPDATE access_roles SET tag_scope = 'team', leads = 1 WHERE id = ?`).run(roleId);
      made.set(u.access_role_id, roleId);
    }
    conn.prepare('UPDATE users SET access_role_id = ? WHERE id = ?').run(roleId, u.id);
  }
}

/**
 * База знаний went from separate videos / articles / links to documents:
 * rich HTML with images and videos inside. Files move to `kb_files` (the
 * proxy only serves what is listed there); existing items become documents.
 */
function knowledgeDocs(conn: DatabaseSync): void {
  conn.exec(`
    CREATE TABLE kb_files (
      drive_file_id TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      mime          TEXT,
      size          INTEGER,
      created_by    INTEGER,
      created_at    INTEGER NOT NULL
    );
  `);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const paras = (text: string | null) =>
    (text ?? '')
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
      .join('');
  const items = conn.prepare('SELECT * FROM kb_items').all() as {
    id: number; kind: string; description: string; url: string | null; body: string | null;
    drive_file_id: string | null; file_name: string | null; mime: string | null; size: number | null;
    created_by: number | null; created_at: number;
  }[];
  for (const it of items) {
    let html = paras(it.description);
    if (it.kind === 'article') html += paras(it.body);
    if (it.kind === 'link' && it.url) html += `<p><a href="${esc(it.url)}">${esc(it.url)}</a></p>`;
    if (it.kind === 'video' && it.drive_file_id) {
      conn
        .prepare('INSERT OR IGNORE INTO kb_files (drive_file_id, name, mime, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(it.drive_file_id, it.file_name ?? 'video', it.mime, it.size, it.created_by, it.created_at);
      html += `<video src="/api/knowledge/file/${esc(it.drive_file_id)}" controls="true" preload="metadata"></video>`;
    }
    conn.prepare(`UPDATE kb_items SET kind = 'doc', body = ?, description = '', url = NULL WHERE id = ?`).run(html || '<p></p>', it.id);
  }
}

function rehomeViews(conn: DatabaseSync): void {
  const suspects = conn
    .prepare("SELECT id, land, video_key, src, duration, popup_at, first_seen, last_seen FROM land_videos WHERE land = 'LAND-NAME' OR land LIKE '%{%' OR src LIKE 'blob:%'")
    .all() as { id: number; land: string; video_key: string; src: string; duration: number | null; popup_at: number | null; first_seen: number; last_seen: number }[];
  const views = conn.prepare('SELECT sid, page FROM views WHERE lv_id = ?');
  const find = conn.prepare('SELECT id FROM land_videos WHERE land = ? AND src = ?');
  const insert = conn.prepare(
    'INSERT INTO land_videos (land, video_key, src, duration, popup_at, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const touch = conn.prepare(
    'UPDATE land_videos SET first_seen = MIN(first_seen, ?), last_seen = MAX(last_seen, ?), duration = COALESCE(duration, ?), popup_at = COALESCE(popup_at, ?) WHERE id = ?',
  );
  const move = conn.prepare('UPDATE OR IGNORE views SET lv_id = ? WHERE sid = ? AND lv_id = ?');
  const drop = conn.prepare('DELETE FROM land_videos WHERE id = ? AND NOT EXISTS (SELECT 1 FROM views WHERE lv_id = ?)');

  for (const lv of suspects) {
    const src = normalizeSrc(lv.src);
    for (const v of views.all(lv.id) as { sid: string; page: string | null }[]) {
      const land = normalizeLand(lv.land, v.page);
      if (land === lv.land && src === lv.src) continue;
      const existing = find.get(land, src) as { id: number } | undefined;
      const target = existing
        ? existing.id
        : Number(insert.run(land, lv.video_key, src, lv.duration, lv.popup_at, lv.first_seen, lv.last_seen).lastInsertRowid);
      touch.run(lv.first_seen, lv.last_seen, lv.duration, lv.popup_at, target);
      move.run(target, v.sid, lv.id);
    }
    drop.run(lv.id, lv.id);
  }
}

let instance: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (instance) return instance;
  const file = path.join(dataRoot(), 'vsl-statistic.sqlite');
  const conn = new DatabaseSync(file);
  conn.exec('PRAGMA journal_mode = WAL');
  conn.exec('PRAGMA synchronous = NORMAL');
  conn.exec('PRAGMA foreign_keys = ON');
  conn.exec('PRAGMA busy_timeout = 5000');
  migrate(conn);
  instance = conn;
  return conn;
}

function migrate(conn: DatabaseSync): void {
  const row = conn.prepare('PRAGMA user_version').get() as { user_version: number };
  const current = row.user_version;
  for (let i = current; i < MIGRATIONS.length; i++) {
    transaction(conn, () => {
      const step = MIGRATIONS[i]!;
      if (typeof step === 'string') conn.exec(step);
      else step(conn);
      conn.exec(`PRAGMA user_version = ${i + 1}`);
    });
    log.info(`Миграция ${i + 1} применена.`);
  }
}

/** Run `fn` inside BEGIN/COMMIT, rolling back on throw. */
export function transaction<T>(conn: DatabaseSync, fn: () => T): T {
  conn.exec('BEGIN');
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

/* ------------------------- key/value settings ------------------------- */

export function getSetting(key: string): string | null {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string | null): void {
  if (value === null) {
    db().prepare('DELETE FROM settings WHERE key = ?').run(key);
    return;
  }
  db()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value);
}
