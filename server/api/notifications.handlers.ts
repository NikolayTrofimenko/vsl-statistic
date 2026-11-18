import { handle } from './rpc';
import { currentUser } from '../users';
import { listNotifications, markAllRead, unreadCount } from '../notifications';
import type { NotificationPage } from '../../src/shared/api.types';

/** Open to everyone signed in; the feed is filtered by the caller's sections. */
export function registerNotificationsHandlers(): void {
  handle('notifications:list', (before: number | null): NotificationPage => listNotifications(currentUser(), before ? Number(before) : null));
  handle('notifications:unread', (): number => unreadCount(currentUser()));
  handle('notifications:markRead', (): void => markAllRead(currentUser()));
}
