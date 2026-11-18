import { db } from '../db';
import { SECTIONS } from '../../src/shared/access';
import type { AppNotification, NotificationPage, Section, SessionUser } from '../../src/shared/api.types';

/**
 * Уведомления: one feed of events from every module. Each event belongs to a
 * section and is shown only to people who can open that section (the admin
 * sees all). Read state is one "seen up to id" mark per person; a person's own
 * actions are listed but never count as unread. Kept for 90 days.
 */

const KEEP_MS = 90 * 24 * 3600_000;
/** Events by the same person on the same thing within this window merge into one. */
const MERGE_MS = 2 * 60_000;

export interface NotifyInput {
  section: Section;
  /** What the event is about, e.g. "offer:12": lets close edits merge. */
  entity: string;
  title: string;
  body?: string;
  /** In-app path to open, e.g. "/offers?open=12". */
  link?: string | null;
  actorId: number | null;
  /** false — always a new entry (e.g. a deletion after a quick edit). */
  merge?: boolean;
}

export function notify(n: NotifyInput): void {
  const conn = db();
  const now = Date.now();
  const last = conn
    .prepare(
      `SELECT id, body FROM notifications WHERE entity = ? AND actor_id IS ? AND created_at > ? ORDER BY id DESC LIMIT 1`,
    )
    .get(n.entity, n.actorId, now - MERGE_MS) as { id: number; body: string } | undefined;
  if (last && n.merge !== false) {
    const body = [last.body, n.body ?? ''].filter(Boolean).join('\n');
    conn.prepare('UPDATE notifications SET body = ? WHERE id = ?').run(body, last.id);
    return;
  }
  conn
    .prepare(
      `INSERT INTO notifications (section, entity, title, body, link, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(n.section, n.entity, n.title, n.body ?? '', n.link ?? null, n.actorId, now);
  conn.prepare('DELETE FROM notifications WHERE created_at < ?').run(now - KEEP_MS);
}

function visible(user: SessionUser): { where: string; args: string[] } {
  const sections = user.role === 'admin' ? SECTIONS.map((s) => s.id) : user.sections;
  if (!sections.length) return { where: '0', args: [] };
  return { where: `n.section IN (${sections.map(() => '?').join(', ')})`, args: [...sections] };
}

function seenId(userId: number): number {
  const row = db().prepare('SELECT last_id FROM notification_seen WHERE user_id = ?').get(userId) as { last_id: number } | undefined;
  return row?.last_id ?? 0;
}

export function unreadCount(user: SessionUser): number {
  const v = visible(user);
  const row = db()
    .prepare(`SELECT COUNT(*) AS n FROM notifications n WHERE ${v.where} AND n.id > ? AND (n.actor_id IS NULL OR n.actor_id != ?)`)
    .get(...v.args, seenId(user.id), user.id) as { n: number };
  return row.n;
}

export function listNotifications(user: SessionUser, before: number | null, limit = 50): NotificationPage {
  const v = visible(user);
  const seen = seenId(user.id);
  const rows = db()
    .prepare(
      `SELECT n.*, u.login AS actor FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
       WHERE ${v.where} ${before ? 'AND n.id < ?' : ''} ORDER BY n.id DESC LIMIT ?`,
    )
    .all(...v.args, ...(before ? [before] : []), Math.min(Math.max(limit, 1), 200)) as unknown as {
    id: number;
    section: Section;
    title: string;
    body: string;
    link: string | null;
    actor_id: number | null;
    actor: string | null;
    created_at: number;
  }[];
  const items: AppNotification[] = rows.map((r) => ({
    id: r.id,
    section: r.section,
    title: r.title,
    body: r.body,
    link: r.link,
    actor: r.actor,
    createdAt: r.created_at,
    unread: r.id > seen && r.actor_id !== user.id,
  }));
  return { items, unread: unreadCount(user) };
}

/** Everything visible now counts as read. */
export function markAllRead(user: SessionUser): void {
  const max = (db().prepare('SELECT MAX(id) AS m FROM notifications').get() as { m: number | null }).m ?? 0;
  db()
    .prepare(
      `INSERT INTO notification_seen (user_id, last_id) VALUES (?, ?)
       ON CONFLICT (user_id) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)`,
    )
    .run(user.id, max);
}
