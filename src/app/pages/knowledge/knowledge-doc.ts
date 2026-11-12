import { Component, computed, inject, input, OnInit, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ApiService } from '../../core/services/api.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { KbEditor } from './kb-editor';
import type { KbDoc } from '../../../shared/api.types';

const DATE = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });

/** One knowledge-base document: read it; the admin edits it in place. `/knowledge/new` starts a new one. */
@Component({
  selector: 'app-knowledge-doc',
  imports: [FormsModule, RouterLink, MatButtonModule, MatIconModule, MatProgressBarModule, KbEditor],
  template: `
    <a class="back" routerLink="/knowledge"><mat-icon>arrow_back</mat-icon>База знаний</a>

    @if (!loaded()) {
      <mat-progress-bar mode="indeterminate" />
    } @else if (editing()) {
      <div class="edit">
        <input class="title-input" [(ngModel)]="title" placeholder="Название документа" maxlength="200" (ngModelChange)="dirty.set(true)" />
        <div class="topic-row">
          <mat-icon>folder</mat-icon>
          <input class="topic-input" [(ngModel)]="topic" placeholder="Раздел (например, «Онбординг» или «Facebook»)" maxlength="80" list="kb-topics" (ngModelChange)="dirty.set(true)" />
          <datalist id="kb-topics">
            @for (t of topics(); track t) {
              <option [value]="t"></option>
            }
          </datalist>
        </div>
        <app-kb-editor [html]="doc()?.html ?? ''" (changed)="dirty.set(true)" />
        <div class="actions">
          <button mat-button (click)="cancel()" [disabled]="saving()">Отмена</button>
          <button mat-flat-button (click)="save()" [disabled]="saving() || !title.trim()">
            <mat-icon>check</mat-icon>Сохранить
          </button>
        </div>
      </div>
    } @else if (doc(); as d) {
      <article class="doc">
        <header class="doc-head">
          <div>
            @if (d.topic) {
              <div class="eyebrow">{{ d.topic }}</div>
            }
            <h1>{{ d.title }}</h1>
            <div class="meta">Обновлено {{ date(d.updatedAt) }}</div>
          </div>
          @if (api.isAdmin()) {
            <div class="head-actions">
              <button mat-stroked-button (click)="edit()"><mat-icon>edit</mat-icon>Редактировать</button>
              <button mat-button class="danger" (click)="remove(d)"><mat-icon>delete</mat-icon>Удалить</button>
            </div>
          }
        </header>
        <div class="kb-content" [innerHTML]="safe()"></div>
      </article>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        max-width: 860px;
      }
      .back {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-bottom: 12px;
        font-size: 13px;
        color: var(--text-muted);
        text-decoration: none;
      }
      .back:hover {
        color: var(--text);
      }
      .back mat-icon {
        width: 16px;
        height: 16px;
        font-size: 16px;
      }
      .doc-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
        flex-wrap: wrap;
        padding-bottom: 16px;
        margin-bottom: 20px;
        border-bottom: 1px solid var(--divider);
      }
      .doc-head h1 {
        margin: 4px 0 6px;
        font-family: var(--font-serif);
        font-size: 30px;
        font-weight: 500;
        line-height: 1.2;
        color: var(--text);
      }
      .meta {
        font-size: 12px;
        color: var(--text-faint);
      }
      .head-actions {
        display: flex;
        gap: 6px;
      }
      .danger {
        color: var(--danger);
      }
      .edit {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .title-input {
        width: 100%;
        border: 0;
        border-bottom: 1px solid var(--divider);
        padding: 6px 0;
        background: transparent;
        color: var(--text);
        font-family: var(--font-serif);
        font-size: 28px;
        outline: none;
      }
      .title-input:focus {
        border-bottom-color: var(--accent-border);
      }
      .topic-row {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--text-muted);
      }
      .topic-row mat-icon {
        font-size: 18px;
        width: 18px;
        height: 18px;
      }
      .topic-input {
        flex: 1;
        min-width: 0;
        border: 0;
        padding: 6px 0;
        background: transparent;
        color: var(--text);
        font: inherit;
        font-size: 14px;
        outline: none;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        position: sticky;
        bottom: 0;
        padding: 10px 0;
        background: var(--bg);
      }
    `,
  ],
})
export class KnowledgeDocPage implements OnInit {
  readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly ask = inject(ConfirmService);
  private readonly snack = inject(MatSnackBar);

  /** Route param: a document id, or 'new'. */
  readonly id = input.required<string>();
  private readonly editor = viewChild(KbEditor);

  readonly doc = signal<KbDoc | null>(null);
  readonly loaded = signal(false);
  readonly editing = signal(false);
  readonly saving = signal(false);
  readonly dirty = signal(false);
  readonly topics = signal<string[]>([]);
  title = '';
  topic = '';

  /** The server sanitized it on save; Angular's own sanitizer would strip the videos. */
  readonly safe = computed<SafeHtml>(() => this.sanitizer.bypassSecurityTrustHtml(this.doc()?.html ?? ''));

  async ngOnInit(): Promise<void> {
    try {
      if (this.id() === 'new') {
        if (!this.api.isAdmin()) {
          void this.router.navigateByUrl('/knowledge');
          return;
        }
        this.topic = history.state?.topic ?? '';
        await this.loadTopics();
        this.editing.set(true);
      } else {
        this.doc.set(await this.api.knowledge.get(Number(this.id())));
      }
    } catch (err) {
      this.toast(err);
    } finally {
      this.loaded.set(true);
    }
  }

  async edit(): Promise<void> {
    const d = this.doc();
    if (!d) return;
    this.title = d.title;
    this.topic = d.topic;
    await this.loadTopics();
    this.dirty.set(false);
    this.editing.set(true);
  }

  async cancel(): Promise<void> {
    if (this.dirty() && !(await this.ask.confirm({ title: 'Выйти без сохранения?', message: 'Изменения пропадут.', ok: 'Выйти', danger: true }))) {
      return;
    }
    if (!this.doc()) {
      void this.router.navigateByUrl('/knowledge');
      return;
    }
    this.editing.set(false);
  }

  async save(): Promise<void> {
    const ed = this.editor();
    if (!ed) return;
    this.saving.set(true);
    try {
      const saved = await this.api.knowledge.save({ id: this.doc()?.id, title: this.title.trim(), topic: this.topic.trim(), html: ed.getHtml() });
      const wasNew = !this.doc();
      this.doc.set(saved);
      this.dirty.set(false);
      this.editing.set(false);
      if (wasNew) void this.router.navigate(['/knowledge', saved.id], { replaceUrl: true });
    } catch (err) {
      this.toast(err);
    } finally {
      this.saving.set(false);
    }
  }

  async remove(d: KbDoc): Promise<void> {
    const ok = await this.ask.confirm({
      title: `Удалить «${d.title}»?`,
      message: 'Документ пропадёт у всех. Картинки и видео из него уйдут в корзину Google Drive (их можно восстановить там 30 дней).',
      ok: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.knowledge.delete(d.id);
      void this.router.navigateByUrl('/knowledge');
    } catch (err) {
      this.toast(err);
    }
  }

  date(ms: number): string {
    return DATE.format(ms);
  }

  private async loadTopics(): Promise<void> {
    try {
      const docs = await this.api.knowledge.list();
      this.topics.set([...new Set(docs.map((x) => x.topic).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')));
    } catch {
      /* suggestions only */
    }
  }

  private toast(err: unknown): void {
    this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
  }
}
