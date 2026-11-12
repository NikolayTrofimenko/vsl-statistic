import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Clipboard } from '@angular/cdk/clipboard';
import { ApiService } from '../../core/services/api.service';
import { formatBytes, formatDate, formatDuration } from '../../core/format';
import { COUNTRIES, languageName } from '../../../shared/geo';
import type { CreoText, LibraryVideo, Tag, VideoPatch } from '../../../shared/api.types';
import { NONE, orNull } from '../../core/select';

/** The library page: owns the tag list and the up-to-date copy of each video. */
export interface TagHost {
  myTags(): Tag[];
  tagsOf(video: LibraryVideo): Tag[];
  toggleTag(video: LibraryVideo, tag: Tag): Promise<void>;
  createTag(assignTo?: LibraryVideo): Promise<void>;
  videoById(id: string): LibraryVideo | undefined;
  /** Duplicate marks and deletion — the page keeps its cards in step. */
  markDuplicate(video: LibraryVideo, originalId: string | null): Promise<boolean>;
  unmarkDuplicate(video: LibraryVideo): Promise<void>;
  clearDuplicates(video: LibraryVideo): Promise<void>;
  /** "Ошибка" reports: own one saved/withdrawn, all closed by the admin. */
  saveReport(video: LibraryVideo, text: string): Promise<boolean>;
  removeReport(video: LibraryVideo): Promise<void>;
  resolveReports(video: LibraryVideo): Promise<void>;
  deleteVideo(video: LibraryVideo): Promise<boolean>;
  /** Open another creative by its ID (the original of a repeat), on top of this one. */
  openByCreoId(creoId: string): void;
}

export interface PlayerDialogData {
  video: LibraryVideo;
  host: TagHost;
  /** Show admin actions (delete, everyone's duplicate marks). The server checks again. */
  isAdmin: boolean;
}

/**
 * Watch a creative, read what is said in it (original and Russian) and edit
 * what is ours about it: tags, geo, note. Tags apply at once; geo and note
 * on "Сохранить". Playback streams through the
 * server's Drive proxy, so no Google login is needed in the browser.
 */
@Component({
  selector: 'app-player-dialog',
  imports: [
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatMenuModule,
    MatProgressBarModule,
    MatSelectModule,
    MatTooltipModule,
  ],
  template: `
    <h2 mat-dialog-title class="title">
      <span class="creo-id mono">{{ video.creoId ?? '—' }}</span>
      @if (video.creoId) {
        <button mat-icon-button class="copy-id" (click)="copyId()" matTooltip="Скопировать ID" aria-label="Скопировать ID">
          <mat-icon>content_copy</mat-icon>
        </button>
      }
    </h2>
    <mat-dialog-content>
      <div class="layout">
        <div class="player">
          <video [src]="streamUrl" controls autoplay playsinline preload="metadata"></video>
        </div>

        <div class="side">
          <div class="meta mono">
            <span>{{ duration(video.durationSec) }}</span>
            @if (video.width && video.height) {
              <span>{{ video.width }}×{{ video.height }}</span>
            }
            <span>{{ bytes(video.size) }}</span>
            @if (video.createdAt) {
              <span matTooltip="Добавлено на Drive">{{ date(video.createdAt) }}</span>
            }
          </div>
          @if (video.folderPath) {
            <div class="folder">{{ video.folderPath }}</div>
          }

          <div class="user-tags">
            @for (t of shownTags(); track t.id) {
              <span class="utag" [style.--tag]="t.color">
                {{ t.name }}@if (!t.mine) {<span class="utag-owner">· {{ t.ownerLogin }}</span>}
              </span>
            }
            <button mat-button class="tags-button" [matMenuTriggerFor]="tagMenu">
              <mat-icon>sell</mat-icon><span>Мои теги</span>
            </button>
            <mat-menu #tagMenu="matMenu">
              @for (t of data.host.myTags(); track t.id) {
                <button mat-menu-item (click)="data.host.toggleTag(current(), t)">
                  <mat-icon>{{ current().tagIds.includes(t.id) ? 'check_box' : 'check_box_outline_blank' }}</mat-icon>
                  <span class="opt-dot" [style.background]="t.color"></span><span>{{ t.name }}</span>
                </button>
              }
              <button mat-menu-item (click)="data.host.createTag(current())">
                <mat-icon>add</mat-icon><span>Новый тег…</span>
              </button>
            </mat-menu>
          </div>

          <div class="dup">
            @if (myMark(); as m) {
              <span class="dup-mine">
                <mat-icon>content_copy</mat-icon>
                <span>
                  Ты отметил как повтор@if (m.originalId) {
                    <button class="creo-link mono" (click)="data.host.openByCreoId(m.originalId)" matTooltip="Открыть оригинал">{{ m.originalId }}</button>
                  }
                </span>
              </span>
              <button mat-button (click)="data.host.unmarkDuplicate(current())">Снять отметку</button>
            } @else if (dupFormOpen()) {
              <form class="dup-form" (ngSubmit)="markDuplicate()">
                <mat-form-field class="dup-input" subscriptSizing="dynamic">
                  <mat-label>Повтор какого крео (необязательно)</mat-label>
                  <input
                    matInput
                    class="mono"
                    name="original"
                    [(ngModel)]="originalId"
                    placeholder="SUS-0087"
                    spellcheck="false"
                    autocomplete="off"
                    (input)="originalId = originalId.toUpperCase()"
                  />
                </mat-form-field>
                <button mat-flat-button type="submit" [disabled]="dupSaving()">Отметить</button>
                <button mat-button type="button" (click)="dupFormOpen.set(false)">Отмена</button>
              </form>
            } @else {
              <button mat-button (click)="dupFormOpen.set(true)" matTooltip="Это крео уже было в библиотеке под другим ID">
                <mat-icon>content_copy</mat-icon><span>Это повтор</span>
              </button>
            }
          </div>
          @if (data.isAdmin && otherMarks().length) {
            <div class="dup-admin">
              <div class="eyebrow">Отмечено как повтор: {{ current().duplicateMarks.length }}</div>
              <ul>
                @for (m of otherMarks(); track m.userId) {
                  <li>
                    <span class="mono">{{ m.login }}</span>
                    @if (m.originalId) {
                      → <button class="creo-link mono" (click)="data.host.openByCreoId(m.originalId)" matTooltip="Открыть оригинал">{{ m.originalId }}</button>
                    }
                    <span class="faint">· {{ markDate(m.createdAt) }}</span>
                  </li>
                }
              </ul>
              <button mat-button (click)="data.host.clearDuplicates(current())" matTooltip="Снять все отметки «повтор» с этого крео">
                <mat-icon>done</mat-icon><span>Не повтор</span>
              </button>
            </div>
          }

          <div class="dup">
            @if (myReport(); as r) {
              @if (!reportFormOpen()) {
                <span class="dup-mine report-mine">
                  <mat-icon>report</mat-icon>
                  <span>Ты сообщил об ошибке: «{{ r.text }}»</span>
                </span>
                <button mat-button (click)="editReport(r.text)">Изменить</button>
                <button mat-button (click)="data.host.removeReport(current())">Убрать</button>
              }
            } @else if (!reportFormOpen()) {
              <button mat-button (click)="editReport('')" matTooltip="Неверное гео, не та вертикаль, не тот язык…">
                <mat-icon>report</mat-icon><span>Ошибка</span>
              </button>
            }
            @if (reportFormOpen()) {
              <form class="dup-form" (ngSubmit)="saveReport()">
                <mat-form-field class="dup-input" subscriptSizing="dynamic">
                  <mat-label>Что не так</mat-label>
                  <input matInput name="report" [(ngModel)]="reportText" maxlength="500" placeholder="Это не Испания — крео на венгерском" autocomplete="off" />
                </mat-form-field>
                <button mat-flat-button type="submit" [disabled]="reportSaving() || !reportText.trim()">Отправить</button>
                <button mat-button type="button" (click)="reportFormOpen.set(false)">Отмена</button>
              </form>
            }
          </div>
          @if (data.isAdmin && otherReports().length) {
            <div class="dup-admin report-admin">
              <div class="eyebrow">Сообщили об ошибке: {{ current().reports.length }}</div>
              <ul>
                @for (r of otherReports(); track r.id) {
                  <li>
                    <span class="mono">{{ r.login }}</span>: {{ r.text }}
                    <span class="faint">· {{ markDate(r.createdAt) }}</span>
                  </li>
                }
              </ul>
              <button mat-button (click)="data.host.resolveReports(current())" matTooltip="Карточку поправили — закрыть все сообщения об ошибке">
                <mat-icon>done</mat-icon><span>Исправлено</span>
              </button>
            </div>
          }

          <div class="text-head">
            <div class="eyebrow">
              Текст
              @if (text()?.lang; as l) {
                · {{ language(l) }}
              }
            </div>
            @if (text()?.status === 'done' && text()?.transcript) {
              <mat-button-toggle-group [value]="tab()" (change)="tab.set($event.value)" aria-label="Язык текста">
                <mat-button-toggle value="ru" [disabled]="!text()?.transcriptRu">Русский</mat-button-toggle>
                <mat-button-toggle value="orig">Оригинал</mat-button-toggle>
              </mat-button-toggle-group>
            }
          </div>

          <div class="text">
            @if (!text()) {
              <mat-progress-bar mode="indeterminate" />
            } @else if (text()!.status === 'pending') {
              <p class="muted">Расшифровка в очереди — появится автоматически, обычно в течение нескольких минут.</p>
            } @else if (text()!.status === 'failed') {
              <p class="error">Не удалось расшифровать: {{ text()!.error }}</p>
            } @else if (!text()!.transcript) {
              <p class="muted">Речи в видео не найдено (только музыка или тишина).</p>
            } @else {
              <p class="body">{{ shownText() }}</p>
              @if (tab() === 'orig' && !text()!.transcriptRu) {
                <p class="muted small">
                  @if (text()!.translateError) {
                    Перевод не удался: {{ text()!.translateError }}
                  } @else if (text()!.lang === 'ru') {
                    Текст уже на русском.
                  } @else {
                    Перевод на русский готовится.
                  }
                </p>
              }
            }
          </div>
          <div class="text-actions">
            @if (text()?.transcript) {
              <button mat-button (click)="copy()">
                <mat-icon>content_copy</mat-icon><span>Скопировать</span>
              </button>
            }
            @if (text() && text()!.status !== 'pending') {
              <button mat-button (click)="retranscribe()" matTooltip="Расшифровать и перевести заново">
                <mat-icon>refresh</mat-icon><span>Заново</span>
              </button>
            }
          </div>

          <div class="fields">
            <mat-form-field>
              <mat-label>Гео</mat-label>
              <mat-select [ngModel]="geo ?? NONE" (ngModelChange)="geo = orNull($event)" name="geo">
                <mat-option [value]="NONE">Не указано</mat-option>
                @for (c of countries; track c.code) {
                  <mat-option [value]="c.code">{{ c.name }} · {{ c.code }}</mat-option>
                }
              </mat-select>
              @if (video.geoSource === 'name' && geo === video.geo) {
                <mat-hint>Определено по имени файла</mat-hint>
              }
            </mat-form-field>
            <mat-form-field class="note">
              <mat-label>Заметка</mat-label>
              <textarea matInput rows="2" [(ngModel)]="note" name="note" maxlength="2000"></textarea>
            </mat-form-field>
          </div>
        </div>
      </div>
      <div class="file-name mono" [title]="video.name">{{ video.name }}</div>
    </mat-dialog-content>
    <mat-dialog-actions>
      <a mat-button [href]="downloadUrl" [attr.download]="video.name">
        <mat-icon>download</mat-icon>
        <span>Скачать</span>
      </a>
      @if (video.webViewLink) {
        <a mat-button [href]="video.webViewLink" target="_blank" rel="noopener">
          <mat-icon>open_in_new</mat-icon>
          <span>Открыть в Drive</span>
        </a>
      }
      @if (data.isAdmin) {
        <button mat-button class="danger" [disabled]="deleting()" (click)="deleteVideo()">
          <mat-icon>delete_outline</mat-icon>
          <span>Удалить</span>
        </button>
      }
      <span class="spacer"></span>
      <button mat-button mat-dialog-close>Закрыть</button>
      <button mat-flat-button color="primary" [disabled]="saving()" (click)="save()">Сохранить</button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .title {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .creo-id {
        font-size: 24px;
        font-weight: 600;
        letter-spacing: 0.02em;
      }
      .copy-id {
        color: var(--text-faint);
      }
      .file-name {
        margin-top: 10px;
        font-size: 11px;
        color: var(--text-faint);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .user-tags {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        margin-top: 10px;
      }
      .utag {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        height: 22px;
        padding: 0 8px;
        font-size: 12px;
        border: 1px solid var(--tag);
        border-left-width: 4px;
      }
      .utag-owner {
        color: var(--text-faint);
        font-size: 11px;
      }
      .tags-button {
        font-size: 12px;
      }
      .opt-dot {
        display: inline-block;
        width: 10px;
        height: 10px;
        margin-right: 8px;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1.15fr) minmax(320px, 1fr);
        gap: 20px;
        align-items: start;
      }
      .player {
        background: #000;
        display: flex;
        justify-content: center;
      }
      video {
        display: block;
        max-width: 100%;
        max-height: 70vh;
      }
      .side {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        color: var(--text-muted);
        font-size: 12px;
      }
      .folder {
        color: var(--text-faint);
        font-size: 12px;
        margin-top: 2px;
      }
      .text-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin: 14px 0 6px;
      }
      .text {
        max-height: 34vh;
        overflow: auto;
        border: 1px solid var(--divider);
        background: var(--surface-2);
        padding: 10px 12px;
      }
      .body {
        margin: 0;
        white-space: pre-wrap;
        line-height: 1.6;
      }
      .muted {
        margin: 0;
        color: var(--text-muted);
      }
      .small {
        margin-top: 8px;
        font-size: 12px;
      }
      .error {
        margin: 0;
        color: var(--danger);
      }
      .text-actions {
        display: flex;
        gap: 4px;
        margin: 4px 0 10px;
      }
      .fields {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      .note {
        grid-column: 1 / -1;
      }
      .spacer {
        flex: 1;
      }
      .danger {
        color: var(--danger);
      }
      .dup {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px 8px;
        margin-top: 8px;
        font-size: 13px;
      }
      .dup-mine {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--accent-text);

        mat-icon {
          font-size: 16px;
          width: 16px;
          height: 16px;
        }
      }
      .dup-form {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
      }
      .dup-input {
        flex: 1;
      }
      .creo-link {
        border: 0;
        background: none;
        padding: 0 2px;
        color: inherit;
        font-size: inherit;
        text-decoration: underline;
        cursor: pointer;
      }
      .report-mine {
        color: var(--danger);
      }
      .dup-admin {
        margin-top: 8px;
        padding: 8px 10px;
        border: 1px solid var(--divider);
        background: var(--surface-2);
        font-size: 13px;

        ul {
          margin: 4px 0;
          padding-left: 18px;
        }
      }
      .faint {
        color: var(--text-faint);
      }
    `,
  ],
})
export class PlayerDialog implements OnInit {
  readonly NONE = NONE;
  readonly orNull = orNull;
  readonly data = inject<PlayerDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<PlayerDialog, VideoPatch>);
  private readonly api = inject(ApiService);
  private readonly clipboard = inject(Clipboard);

  readonly video = this.data.video;
  readonly streamUrl = this.api.library.streamUrl(this.video.id);
  /** Same stream, served as an attachment — the buyer's "download" button. */
  readonly downloadUrl = `${this.streamUrl}?download=1`;
  readonly saving = signal(false);
  readonly text = signal<CreoText | null>(null);
  readonly tab = signal<'ru' | 'orig'>('ru');

  readonly countries = Object.entries(COUNTRIES)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  /** Tags change while the dialog is open — read them from the page, not the snapshot. */
  readonly current = computed(() => this.data.host.videoById(this.video.id) ?? this.video);
  readonly shownTags = computed(() => this.data.host.tagsOf(this.current()));
  readonly myMark = computed(() => this.current().duplicateMarks.find((m) => m.mine) ?? null);
  readonly otherMarks = computed(() => this.current().duplicateMarks.filter((m) => !m.mine));
  readonly dupFormOpen = signal(false);
  readonly myReport = computed(() => this.current().reports.find((r) => r.mine) ?? null);
  readonly otherReports = computed(() =>
    this.data.isAdmin ? this.current().reports : this.current().reports.filter((r) => !r.mine),
  );
  readonly reportFormOpen = signal(false);
  readonly reportSaving = signal(false);
  reportText = '';
  readonly dupSaving = signal(false);
  readonly deleting = signal(false);
  originalId = '';

  note = this.video.note;
  geo: string | null = this.video.geo;

  readonly duration = formatDuration;
  readonly bytes = formatBytes;
  readonly date = formatDate;
  readonly language = languageName;

  async ngOnInit(): Promise<void> {
    const text = await this.api.library.text(this.video.id);
    this.text.set(text);
    if (!text.transcriptRu) this.tab.set('orig');
  }

  shownText(): string {
    const t = this.text();
    if (!t) return '';
    return (this.tab() === 'ru' ? t.transcriptRu : null) ?? t.transcript ?? '';
  }

  copy(): void {
    this.clipboard.copy(this.shownText());
  }

  copyId(): void {
    if (this.video.creoId) this.clipboard.copy(this.video.creoId);
  }

  async retranscribe(): Promise<void> {
    await this.api.library.retranscribe(this.video.id);
    this.text.set({ ...this.text()!, status: 'pending', transcript: null, transcriptRu: null });
  }

  markDate(ms: number): string {
    return new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }

  editReport(text: string): void {
    this.reportText = text;
    this.reportFormOpen.set(true);
  }

  async saveReport(): Promise<void> {
    this.reportSaving.set(true);
    try {
      if (await this.data.host.saveReport(this.current(), this.reportText.trim())) this.reportFormOpen.set(false);
    } finally {
      this.reportSaving.set(false);
    }
  }

  async markDuplicate(): Promise<void> {
    this.dupSaving.set(true);
    try {
      if (await this.data.host.markDuplicate(this.current(), this.originalId.trim() || null)) {
        this.dupFormOpen.set(false);
        this.originalId = '';
      }
    } finally {
      this.dupSaving.set(false);
    }
  }

  async deleteVideo(): Promise<void> {
    this.deleting.set(true);
    try {
      if (await this.data.host.deleteVideo(this.current())) this.ref.close();
    } finally {
      this.deleting.set(false);
    }
  }

  async save(): Promise<void> {
    const patch: VideoPatch = { note: this.note };
    if (this.geo !== this.video.geo) patch.geo = this.geo;
    this.saving.set(true);
    try {
      await this.api.library.update(this.video.id, patch);
      this.ref.close(patch);
    } finally {
      this.saving.set(false);
    }
  }
}
