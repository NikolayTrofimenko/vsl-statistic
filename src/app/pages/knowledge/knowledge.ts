import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { KbVideoDialog, type KbVideoData } from './kb-video-dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ApiService } from '../../core/services/api.service';
import type { KbDoc, KbDocSummary } from '../../../shared/api.types';

const NO_TOPIC = 'Без раздела';
const DATE = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Moscow' });

/** База знаний: documents grouped by section. Everyone reads; the admin writes. */
@Component({
  selector: 'app-knowledge',
  imports: [FormsModule, RouterLink, MatButtonModule, MatIconModule, MatProgressBarModule],
  template: `
    <header class="page-header">
      <div>
        <h1>База знаний</h1>
        <p>Инструкции, обучение и полезное — документами с текстом, картинками, видео и ссылками.</p>
      </div>
      @if (api.can('knowledgeEdit')) {
        <div class="add">
          <button mat-stroked-button (click)="addVideo()"><mat-icon>video_call</mat-icon>Видео</button>
          <button mat-flat-button (click)="create()"><mat-icon>add</mat-icon>Документ</button>
        </div>
      }
    </header>

    @if (!loaded()) {
      <mat-progress-bar mode="indeterminate" />
    } @else if (!docs().length) {
      <div class="empty">
        <mat-icon>school</mat-icon>
        <div>Пока пусто.{{ api.can('knowledgeEdit') ? ' Нажми «Новый документ», чтобы написать первый.' : '' }}</div>
      </div>
    } @else {
      <div class="layout">
        <nav class="topics">
          <button [class.on]="topic() === null" (click)="topic.set(null)">
            <span>Все</span><span class="n">{{ docs().length }}</span>
          </button>
          @for (t of topics(); track t.name) {
            <button [class.on]="topic() === t.name" (click)="topic.set(t.name)">
              <span>{{ t.name }}</span><span class="n">{{ t.count }}</span>
            </button>
          }
        </nav>
        <div class="main">
          <input class="search" type="search" placeholder="Поиск по названию и тексту" [ngModel]="query()" (ngModelChange)="query.set($event)" />
          @for (g of groups(); track g.name) {
            <section class="group">
              @if (topic() === null) {
                <div class="eyebrow">{{ g.name }}</div>
              }
              <div class="list">
                @for (d of g.docs; track d.id) {
                  <a class="doc" [routerLink]="['/knowledge', d.id]">
                    <mat-icon class="icon">description</mat-icon>
                    <div class="body">
                      <div class="title">{{ d.title }}</div>
                      @if (d.excerpt) {
                        <div class="excerpt">{{ d.excerpt }}</div>
                      }
                      <div class="meta">
                        @if (d.hasVideo) {
                          <span class="badge"><mat-icon>play_circle</mat-icon>видео</span>
                        }
                        @if (d.hasImage) {
                          <span class="badge"><mat-icon>image</mat-icon>картинки</span>
                        }
                        <span>{{ date(d.updatedAt) }}</span>
                      </div>
                    </div>
                  </a>
                }
              </div>
            </section>
          } @empty {
            <div class="empty small">Ничего не нашлось.</div>
          }
        </div>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .add {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .layout {
        display: grid;
        grid-template-columns: 220px minmax(0, 1fr);
        gap: 24px;
        align-items: start;
      }
      @media (max-width: 760px) {
        .layout {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .topics {
        display: flex;
        flex-direction: column;
        gap: 2px;
        position: sticky;
        top: 8px;
      }
      .topics button {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 10px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: var(--text-muted);
        font: inherit;
        font-size: 13px;
        text-align: left;
        cursor: pointer;
      }
      .topics button:hover {
        background: var(--hover);
        color: var(--text);
      }
      .topics button.on {
        background: var(--accent-soft);
        color: var(--accent-text);
      }
      .n {
        color: var(--text-faint);
      }
      .search {
        width: 100%;
        max-width: 420px;
        margin-bottom: 18px;
        padding: 8px 12px;
        border: 1px solid var(--divider-strong);
        border-radius: 8px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        font-size: 13px;
      }
      .search:focus {
        outline: 2px solid var(--ring);
      }
      .group {
        margin-bottom: 24px;
      }
      .eyebrow {
        margin-bottom: 8px;
      }
      .list {
        display: flex;
        flex-direction: column;
        border: 1px solid var(--divider);
        border-radius: 10px;
        background: var(--surface);
        overflow: hidden;
      }
      .doc {
        display: flex;
        gap: 12px;
        padding: 14px 16px;
        color: inherit;
        text-decoration: none;
        border-top: 1px solid var(--divider);
      }
      .doc:first-child {
        border-top: 0;
      }
      .doc:hover {
        background: var(--surface-2);
      }
      .icon {
        flex: none;
        color: var(--text-faint);
      }
      .body {
        min-width: 0;
      }
      .title {
        font-weight: 500;
        color: var(--text);
      }
      .excerpt {
        margin-top: 3px;
        font-size: 13px;
        color: var(--text-muted);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
        margin-top: 6px;
        font-size: 12px;
        color: var(--text-faint);
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 3px;
      }
      .badge mat-icon {
        font-size: 14px;
        width: 14px;
        height: 14px;
      }
      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        padding: 48px 16px;
        color: var(--text-muted);
        text-align: center;
      }
      .empty.small {
        padding: 24px 0;
      }
    `,
  ],
})
export class KnowledgePage implements OnInit {
  readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly snack = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);

  readonly docs = signal<KbDocSummary[]>([]);
  readonly loaded = signal(false);
  readonly query = signal('');
  readonly topic = signal<string | null>(null);

  readonly topics = computed(() => {
    const counts = new Map<string, number>();
    for (const d of this.docs()) counts.set(topicOf(d), (counts.get(topicOf(d)) ?? 0) + 1);
    return [...counts].map(([name, count]) => ({ name, count })).sort(byTopic);
  });

  readonly groups = computed(() => {
    const q = this.query().trim().toLowerCase();
    const only = this.topic();
    const map = new Map<string, KbDocSummary[]>();
    for (const d of this.docs()) {
      const t = topicOf(d);
      if (only !== null && t !== only) continue;
      if (q && !`${d.title} ${d.excerpt} ${d.topic}`.toLowerCase().includes(q)) continue;
      map.set(t, [...(map.get(t) ?? []), d]);
    }
    return [...map].map(([name, docs]) => ({ name, docs })).sort(byTopic);
  });

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    try {
      this.docs.set(await this.api.knowledge.list());
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
    } finally {
      this.loaded.set(true);
    }
  }

  async addVideo(): Promise<void> {
    const t = this.topic();
    const data: KbVideoData = {
      topics: this.topics().map((x) => x.name).filter((n) => n !== NO_TOPIC),
      topic: t && t !== NO_TOPIC ? t : '',
    };
    const ref = this.dialog.open<KbVideoDialog, KbVideoData, KbDoc>(KbVideoDialog, { data, autoFocus: false, disableClose: true });
    if (await firstValueFrom(ref.afterClosed())) await this.reload();
  }

  create(): void {
    const t = this.topic();
    void this.router.navigate(['/knowledge', 'new'], { state: { topic: t && t !== NO_TOPIC ? t : '' } });
  }

  date(ms: number): string {
    return DATE.format(ms);
  }
}

function topicOf(d: KbDocSummary): string {
  return d.topic || NO_TOPIC;
}

/** Sections alphabetically, «Без раздела» last. */
function byTopic(a: { name: string }, b: { name: string }): number {
  if (a.name === NO_TOPIC) return 1;
  if (b.name === NO_TOPIC) return -1;
  return a.name.localeCompare(b.name, 'ru');
}
