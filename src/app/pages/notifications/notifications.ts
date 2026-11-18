import { Component, inject, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ApiService } from '../../core/services/api.service';
import { SECTIONS } from '../../../shared/access';
import type { AppNotification, Section } from '../../../shared/api.types';

/** Уведомления: what changed in the sections this person can open. Opening the page marks all as read. */
@Component({
  selector: 'app-notifications',
  imports: [MatButtonModule, MatIconModule, MatProgressBarModule],
  template: `
    <header class="page-header">
      <div>
        <h1>Уведомления</h1>
        <p>Изменения в разделах, которые тебе доступны. Свои действия тоже видны, но не считаются новыми.</p>
      </div>
    </header>

    @if (!loaded()) {
      <mat-progress-bar mode="indeterminate" />
    } @else if (!items().length) {
      <div class="empty">
        <mat-icon>notifications_none</mat-icon>
        <div>Пока ничего не происходило.</div>
      </div>
    } @else {
      <ul class="feed">
        @for (n of items(); track n.id) {
          <li [class.unread]="n.unread" [class.link]="!!n.link" (click)="go(n)">
            <div class="top">
              <span class="section">{{ sectionLabel(n.section) }}</span>
              <span class="when">{{ when(n.createdAt) }}{{ n.actor ? ' · ' + n.actor : '' }}</span>
            </div>
            <div class="title">{{ n.title }}</div>
            @if (n.body) {
              <div class="body">{{ n.body }}</div>
            }
          </li>
        }
      </ul>
      @if (more()) {
        <button mat-button class="more" (click)="loadMore()" [disabled]="busy()">Показать ещё</button>
      }
    }
  `,
  styles: [
    `
      .feed {
        list-style: none;
        margin: 0;
        padding: 0;
        max-width: 760px;
      }
      li {
        padding: 12px 14px;
        border-bottom: 1px solid var(--divider);
        border-left: 3px solid transparent;
      }
      li.unread {
        border-left-color: var(--accent);
        background: var(--surface-2);
      }
      li.link {
        cursor: pointer;
      }
      li.link:hover {
        background: var(--surface-2);
      }
      .top {
        display: flex;
        gap: 10px;
        font-size: 11px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .when {
        margin-left: auto;
        text-transform: none;
        letter-spacing: 0;
      }
      .title {
        margin-top: 4px;
        font-size: 14px;
        font-weight: 600;
        color: var(--text);
      }
      .body {
        margin-top: 4px;
        font-size: 13px;
        color: var(--text-muted);
        white-space: pre-line;
      }
      .more {
        margin-top: 12px;
      }
      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        padding: 48px 0;
        color: var(--text-muted);
      }
    `,
  ],
})
export class NotificationsPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  readonly items = signal<AppNotification[]>([]);
  readonly loaded = signal(false);
  readonly busy = signal(false);
  readonly more = signal(false);

  async ngOnInit(): Promise<void> {
    try {
      const page = await this.api.notifications.list();
      this.items.set(page.items);
      this.more.set(page.items.length >= 50);
      if (page.unread) {
        await this.api.notifications.markRead();
      }
      this.api.unread.set(0);
    } finally {
      this.loaded.set(true);
    }
  }

  async loadMore(): Promise<void> {
    const last = this.items().at(-1);
    if (!last) return;
    this.busy.set(true);
    try {
      const page = await this.api.notifications.list(last.id);
      this.items.update((list) => [...list, ...page.items]);
      this.more.set(page.items.length >= 50);
    } finally {
      this.busy.set(false);
    }
  }

  go(n: AppNotification): void {
    if (n.link) void this.router.navigateByUrl(n.link);
  }

  sectionLabel(s: Section): string {
    return SECTIONS.find((x) => x.id === s)?.label ?? s;
  }

  when(ms: number): string {
    const d = new Date(ms);
    const today = new Date();
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === today.toDateString()) return `сегодня ${time}`;
    return `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} ${time}`;
  }
}
