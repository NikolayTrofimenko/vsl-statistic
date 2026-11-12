import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Clipboard } from '@angular/cdk/clipboard';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../core/services/api.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { formatBytes, formatDate, formatDuration } from '../../core/format';
import { countryName, languageName } from '../../../shared/geo';
import type {
  CreoQueueState,
  DriveFolder,
  DriveStatus,
  LibraryVideo,
  Tag,
  Vertical,
} from '../../../shared/api.types';
import { UploadDialog, UploadDialogData } from './upload-dialog';
import { TagDialog, TagDialogResult } from './tag-dialog';
import { PlayerDialog, PlayerDialogData, TagHost } from './player-dialog';
import { NONE, orNull } from '../../core/select';

/** Sidebar selection: every vertical, or one. */
type VerticalFilter = 'all' | number;
/** A tag id, '-' for creatives without any visible tag, null for no filter. */
type TagFilter = number | '-' | null;

const SYNC_POLL_MS = 2000;

@Component({
  selector: 'app-library',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatMenuModule,
    MatProgressBarModule,
    MatSelectModule,
    MatTooltipModule,
    RouterLink,
  ],
  template: `
    <header class="page-header">
      <div>
        <h1>Библиотека крео</h1>
        <p>
          Крео из папки Google Drive по вертикалям, с расшифровкой и переводом на русский. У каждого
          крео постоянный ID — копируй его в Кайтен и в название кампании. Файлы остаются на Drive.
        </p>
      </div>
      <div class="header-actions">
        @if (canHistory()) {
          <a mat-stroked-button routerLink="/history" matTooltip="Сколько крео добавилось по месяцам, кто загрузил, что удалено">
            <mat-icon>history</mat-icon>
            <span>История загрузок</span>
          </a>
        }
        @if (isAdmin()) {
          <a mat-stroked-button routerLink="/verticals" matTooltip="Коды вертикалей для ID крео">
            <mat-icon>folder_special</mat-icon>
            <span>Вертикали</span>
          </a>
        }
        @if (status()?.connected) {
          <button
            mat-flat-button
            color="primary"
            (click)="upload()"
            [disabled]="!status()!.writable"
            [matTooltip]="status()!.writable ? '' : 'Drive подключён только на чтение — переподключи его с полным доступом'"
          >
            <mat-icon>cloud_upload</mat-icon>
            <span>Загрузить крео</span>
          </button>
          <span class="account mono" [matTooltip]="'Папка ' + status()!.folderId">
            {{ status()!.email ?? 'Drive подключён' }}
          </span>
          <button
            mat-stroked-button
            [disabled]="status()!.sync.running"
            (click)="sync()"
            matTooltip="Обновить список видео с Drive"
          >
            <mat-icon>sync</mat-icon>
            <span>{{ status()!.sync.running ? 'Синхронизирую…' : 'Синхронизировать' }}</span>
          </button>
          @if (isAdmin()) {
            <button mat-icon-button [matMenuTriggerFor]="driveMenu" aria-label="Подключение Drive">
              <mat-icon>more_vert</mat-icon>
            </button>
            <mat-menu #driveMenu="matMenu">
              <a mat-menu-item [href]="connectUrl">
                <mat-icon>swap_horiz</mat-icon>
                <span>Подключить другой аккаунт</span>
              </a>
              <button mat-menu-item (click)="disconnect()">
                <mat-icon>link_off</mat-icon>
                <span>Отключить Drive</span>
              </button>
            </mat-menu>
          }
        } @else if (status()?.configured && isAdmin()) {
          <a mat-flat-button color="primary" [href]="connectUrl">
            <mat-icon>add_link</mat-icon>
            <span>Подключить Google Drive</span>
          </a>
        }
      </div>
    </header>

    @if (status()?.sync?.running) {
      <mat-progress-bar mode="indeterminate" class="sync-bar" />
    }

    @if (queue(); as q) {
      @if (q.enabled && (q.pending > 0 || q.untranslated > 0 || q.lastError || q.translationPaused)) {
        <div class="queue">
          <mat-icon>graphic_eq</mat-icon>
          <span>
            Расшифровка: готово {{ q.done }}, в очереди {{ q.pending }}
            @if (q.translationEnabled && q.untranslated > 0) {
              · ждут перевода {{ q.untranslated }}
            }
            @if (q.current; as c) {
              · {{ c.step === 'transcribe' ? 'расшифровываю' : 'перевожу' }} «{{ c.name }}»
            }
          </span>
          @if (q.lastError) {
            <span class="queue-error">пауза: {{ q.lastError }}</span>
          }
          @if (q.translationPaused) {
            <span class="queue-error">перевод на паузе: {{ q.translationPaused }}</span>
          }
        </div>
      }
      @if (q.enabled && !q.translationEnabled) {
        <div class="banner">
          <mat-icon>translate</mat-icon>
          <div>Перевод на русский выключен: на сервере не задан ANTHROPIC_API_KEY. Расшифровка оригинала работает.</div>
        </div>
      }
    }

    @if (error(); as message) {
      <div class="banner danger">
        <mat-icon>error_outline</mat-icon>
        <div>{{ message }}</div>
      </div>
    }
    @if (status() && !status()!.configured) {
      <div class="banner">
        <mat-icon>key</mat-icon>
        <div>
          Не настроен OAuth-клиент Google. Задай <code>GOOGLE_CLIENT_ID</code> и
          <code>GOOGLE_CLIENT_SECRET</code> в <code>.env</code> и перезапусти сервер. Redirect URI
          клиента: <code>{{ status()!.redirectUri }}</code>
        </div>
      </div>
    } @else if (status() && !status()!.connected) {
      <div class="banner">
        <mat-icon>cloud_off</mat-icon>
        <div>
          @if (isAdmin()) {
            Drive не подключён — войди аккаунтом, у которого есть доступ к папке с видео.
          } @else {
            Drive не подключён. Подключить его может только админ.
          }
        </div>
      </div>
    }
    @if (status()?.sync?.lastError; as syncError) {
      <div class="banner danger">
        <mat-icon>sync_problem</mat-icon>
        <div>Последняя синхронизация упала: {{ syncError }}</div>
      </div>
    }

    <div class="layout">
      <aside class="verticals">
        <div class="eyebrow verticals-head">Вертикали</div>
        <button class="v-item" [class.active]="verticalFilter() === 'all'" (click)="selectVertical('all')">
          <span class="v-code mono all">ALL</span>
          <span class="v-name">Все вертикали</span>
          <span class="v-count mono">{{ activeVideos().length }}@if (newCount(); as n) {<span class="plus">+{{ n }}</span>}</span>
        </button>
        @for (v of sidebarVerticals(); track v.id) {
          <button class="v-item" [class.active]="verticalFilter() === v.id" (click)="selectVertical(v.id)">
            <span class="v-code mono">{{ v.code }}</span>
            <span class="v-name" [title]="verticalName(v)">{{ verticalName(v) }}</span>
            <span class="v-count mono">{{ v.active }}@if (v.fresh) {<span class="plus">+{{ v.fresh }}</span>}</span>
          </button>
        }
      </aside>

      <section class="content">
        <div class="toolbar">
          <mat-form-field class="filter">
            <mat-label>Новые за</mat-label>
            <mat-select [ngModel]="newWindow()" (ngModelChange)="setNewWindow($event)">
              <mat-option [value]="3">3 дня</mat-option>
              <mat-option [value]="7">неделю</mat-option>
              <mat-option [value]="14">2 недели</mat-option>
              <mat-option [value]="30">месяц</mat-option>
              <mat-option value="seen">с моей отметки</mat-option>
            </mat-select>
          </mat-form-field>
          <button
            class="new-chip"
            [class.active]="onlyNew()"
            [disabled]="newInView() === 0"
            (click)="onlyNew.set(!onlyNew())"
            [matTooltip]="newInView() ? 'Показать только новые' : 'За этот период новых крео нет'"
          >
            <mat-icon>fiber_new</mat-icon>
            <span>Новые: {{ newInView() }}</span>
          </button>
          @if (newWindow() === 'seen' && newCount() > 0) {
            <button mat-button (click)="markSeen()" [matTooltip]="'Отметка стоит с ' + seenLabel() + '. Сбросить «новое» — только для тебя'">
              <mat-icon>done_all</mat-icon>
              <span>Отметить просмотренными</span>
            </button>
          }
          <mat-form-field class="filter">
            <mat-label>Гео</mat-label>
            <mat-select [ngModel]="geoFilter() ?? NONE" (ngModelChange)="geoFilter.set(orNull($event))">
              <mat-option [value]="NONE">Все</mat-option>
              <mat-option value="-">Не указано ({{ geoCounts().get('-') ?? 0 }})</mat-option>
              @for (g of geoOptions(); track g.code) {
                <mat-option [value]="g.code">{{ g.name }} · {{ g.code }} ({{ g.count }})</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field class="filter">
            <mat-label>Язык</mat-label>
            <mat-select [ngModel]="langFilter() ?? NONE" (ngModelChange)="langFilter.set(orNull($event))">
              <mat-option [value]="NONE">Все</mat-option>
              @for (l of langOptions(); track l.code) {
                <mat-option [value]="l.code">{{ l.name }} ({{ l.count }})</mat-option>
              }
              <mat-option value="-">Не определён ({{ langCounts().get('-') ?? 0 }})</mat-option>
            </mat-select>
          </mat-form-field>
          <mat-form-field class="filter">
            <mat-label>Тег</mat-label>
            <mat-select [ngModel]="tagFilter() ?? NONE" (ngModelChange)="tagFilter.set(orNull($event))">
              <mat-option [value]="NONE">Все</mat-option>
              @for (t of tagOptions(); track t.tag.id) {
                <mat-option [value]="t.tag.id">
                  <span class="opt-dot" [style.background]="t.tag.color"></span>{{ t.tag.name }}@if (!t.tag.mine) {<span class="opt-owner"> · {{ t.tag.ownerLogin }}</span>} ({{ t.count }})
                </mat-option>
              }
              <mat-option value="-">Без тегов ({{ tagCounts().get('-') ?? 0 }})</mat-option>
            </mat-select>
          </mat-form-field>
          <mat-form-field class="filter">
            <mat-label>Сортировка</mat-label>
            <mat-select [ngModel]="sortMode()" (ngModelChange)="sortMode.set($event)">
              <mat-option value="new">Сначала новые</mat-option>
              <mat-option value="old">Сначала старые</mat-option>
              <mat-option value="id">По ID</mat-option>
              <mat-option value="name">По имени файла</mat-option>
            </mat-select>
          </mat-form-field>
          <button mat-button [matMenuTriggerFor]="tagsMenu">
            <mat-icon>sell</mat-icon>
            <span>Мои теги</span>
          </button>
          <mat-menu #tagsMenu="matMenu">
            @for (t of myTags(); track t.id) {
              <button mat-menu-item [matMenuTriggerFor]="tagActions" [matMenuTriggerData]="{ tag: t }">
                <span class="opt-dot" [style.background]="t.color"></span>
                <span>{{ t.name }} <span class="opt-owner">({{ t.count }})</span></span>
              </button>
            } @empty {
              <div class="menu-hint">Тегов пока нет. Повесь первый на любом крео.</div>
            }
            <button mat-menu-item (click)="createTag()">
              <mat-icon>add</mat-icon><span>Новый тег…</span>
            </button>
          </mat-menu>
          <mat-menu #tagActions="matMenu">
            <ng-template matMenuContent let-tag="tag">
              <button mat-menu-item (click)="editTag(tag)">
                <mat-icon>edit</mat-icon><span>Переименовать</span>
              </button>
              <button mat-menu-item (click)="deleteTag(tag)">
                <mat-icon>delete_outline</mat-icon><span>Удалить</span>
              </button>
            </ng-template>
          </mat-menu>
          @if (isAdmin() && reportCount() > 0) {
            <button
              class="new-chip report-chip"
              [class.active]="onlyReports()"
              (click)="onlyReports.set(!onlyReports())"
              matTooltip="Показать только крео, где сообщили об ошибке"
            >
              <mat-icon>report</mat-icon>
              <span>Ошибки: {{ reportCount() }}</span>
            </button>
          }
          @if (isAdmin() && duplicateCount() > 0) {
            <button
              class="new-chip dup-chip"
              [class.active]="onlyDuplicates()"
              (click)="onlyDuplicates.set(!onlyDuplicates())"
              matTooltip="Показать только крео, отмеченные как повтор"
            >
              <mat-icon>content_copy</mat-icon>
              <span>Отмечены как повтор: {{ duplicateCount() }}</span>
            </button>
          }
          @if (removedCount() > 0) {
            <button mat-button (click)="showRemoved.set(!showRemoved())">
              <mat-icon>{{ showRemoved() ? 'visibility_off' : 'visibility' }}</mat-icon>
              <span>Удалённые с Drive ({{ removedCount() }})</span>
            </button>
          }
        </div>

        @if (!loaded()) {
          <mat-progress-bar mode="indeterminate" />
        } @else if (filtered().length === 0) {
          <div class="empty">
            <mat-icon>video_library</mat-icon>
            <p>{{ videos().length ? 'Ничего не найдено' : 'Видео пока нет' }}</p>
            @if (!videos().length && status()?.connected) {
              <small>Нажми «Синхронизировать», чтобы подтянуть видео из папки Drive.</small>
            }
          </div>
        } @else {
          <div class="summary mono">{{ filtered().length }} крео · {{ totalDuration(filtered()) }}</div>
          <div class="grid">
            @for (v of filtered(); track v.id) {
              <article class="card" [class.removed]="v.removed" [class.is-new]="isNew(v)">
                <button class="thumb" (click)="open(v)" [attr.aria-label]="'Смотреть ' + (v.creoId ?? v.name)">
                  @if (v.hasThumb) {
                    <img [src]="thumbUrl(v)" alt="" loading="lazy" />
                  } @else {
                    <mat-icon class="no-thumb">movie</mat-icon>
                  }
                  <span class="duration mono">{{ duration(v.durationSec) }}</span>
                  @if (v.landingCount && isAdmin()) {
                    <span class="on-lands mono" matTooltip="Привязано к видео на лендах">
                      <mat-icon>insights</mat-icon>{{ v.landingCount }}
                    </span>
                  }
                  <span class="play"><mat-icon>play_arrow</mat-icon></span>
                </button>
                <div class="body">
                  <div class="id-row">
                    <span class="creo-id mono">{{ v.creoId ?? '—' }}</span>
                    @if (v.creoId) {
                      <button class="copy-id" (click)="copyId(v)" matTooltip="Скопировать ID" aria-label="Скопировать ID">
                        <mat-icon>content_copy</mat-icon>
                      </button>
                    }
                    @if (isNew(v)) {
                      <span class="new-badge">новое</span>
                    }
                    @if (v.reports.length) {
                      <span class="dup-badge" [matTooltip]="reportHint(v)">ошибка</span>
                    }
                    @if (v.duplicateMarks.length) {
                      <span class="dup-badge" [matTooltip]="duplicateHint(v)">
                        повтор@if (isAdmin() && v.duplicateMarks.length > 1) {<span> ×{{ v.duplicateMarks.length }}</span>}
                      </span>
                    }
                  </div>
                  <div class="tags">
                    @if (v.geo) {
                      <span class="tag geo" [matTooltip]="'Гео: ' + country(v.geo) + (v.geoSource === 'name' ? ' (по имени файла)' : '')">{{ v.geo }}</span>
                    }
                    @if (v.lang) {
                      <!-- Spoken language, spelled out: a bare "es" next to a geo
                           chip reads as Spain, not Spanish. -->
                      <span class="tag lang" matTooltip="Язык речи, определён по аудио"><mat-icon>record_voice_over</mat-icon>{{ language(v.lang).toLowerCase() }}</span>
                    }
                    @if (v.transcribeStatus === 'pending') {
                      <span class="tag faint" matTooltip="Расшифровка в очереди"><mat-icon>hourglass_empty</mat-icon></span>
                    } @else if (v.transcribeStatus === 'failed') {
                      <span class="tag bad" matTooltip="Расшифровка не удалась"><mat-icon>error_outline</mat-icon></span>
                    } @else if (v.hasTranslation) {
                      <span class="tag faint" matTooltip="Есть расшифровка и перевод"><mat-icon>translate</mat-icon></span>
                    } @else if (v.hasTranscript) {
                      <span class="tag faint" matTooltip="Есть расшифровка, перевод готовится"><mat-icon>subject</mat-icon></span>
                    }
                  </div>
                  <div class="user-tags">
                    @for (t of tagsOf(v); track t.id) {
                      <span class="utag" [style.--tag]="t.color" [matTooltip]="t.mine ? '' : 'Тег баера ' + t.ownerLogin">
                        {{ t.name }}@if (!t.mine) {<span class="utag-owner">· {{ t.ownerLogin }}</span>}
                      </span>
                    }
                    <button class="utag-add" [matMenuTriggerFor]="assign" matTooltip="Мои теги на этом крео" aria-label="Теги">
                      <mat-icon>{{ tagsOf(v).length ? 'edit' : 'sell' }}</mat-icon>
                      @if (!tagsOf(v).length) {
                        <span>тег</span>
                      }
                    </button>
                    <mat-menu #assign="matMenu">
                      @for (t of myTags(); track t.id) {
                        <button mat-menu-item (click)="toggleTag(v, t)">
                          <mat-icon>{{ v.tagIds.includes(t.id) ? 'check_box' : 'check_box_outline_blank' }}</mat-icon>
                          <span class="opt-dot" [style.background]="t.color"></span><span>{{ t.name }}</span>
                        </button>
                      }
                      <button mat-menu-item (click)="createTag(v)">
                        <mat-icon>add</mat-icon><span>Новый тег…</span>
                      </button>
                    </mat-menu>
                  </div>
                  <div class="sub mono">
                    @if (v.createdAt) {
                      <span matTooltip="Добавлено на Drive" [class.fresh-date]="isNew(v)">{{ date(v.createdAt) }}</span>
                    }
                    @if (folderLabel(v); as folder) {
                      <span class="folder" [title]="folder">{{ folder }}</span>
                    }
                    <span>{{ bytes(v.size) }}</span>
                    @if (v.removed) {
                      <span class="removed-tag">удалено</span>
                    }
                  </div>
                  @if (v.note) {
                    <div class="note" [title]="v.note">{{ v.note }}</div>
                  }
                  <div class="file-name" [title]="v.name">{{ v.name }}</div>
                </div>
              </article>
            }
          </div>
        }
      </section>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .header-actions {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-shrink: 0;
      }
      .account {
        font-size: 12px;
        color: var(--text-muted);
      }
      .plus {
        margin-left: 6px;
        color: var(--accent-text);
        font-weight: 600;
      }
      .new-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 36px;
        padding: 0 12px;
        border: 1px solid var(--accent-border);
        background: var(--accent-soft);
        color: var(--accent-text);
        font: inherit;
        font-weight: 600;
        cursor: pointer;

        &.active {
          background: var(--accent);
          color: var(--accent-contrast);
          border-color: var(--accent);
        }
      }
      .card.is-new {
        border-color: var(--accent-border);
        box-shadow: inset 0 2px 0 var(--accent-text);
      }
      .new-badge {
        display: inline-block;
        margin-left: auto;
        padding: 0 5px;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        background: var(--accent);
        color: var(--accent-contrast);
      }
      .fresh-date {
        color: var(--accent-text);
        font-weight: 600;
      }
      .queue {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        font-size: 12px;
        color: var(--text-muted);
        margin-bottom: 12px;

        mat-icon {
          font-size: 18px;
          width: 18px;
          height: 18px;
          color: var(--text-faint);
        }
      }
      .queue-error {
        color: var(--warn);
      }
      .filter {
        width: 170px;
      }
      .tags {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin: 4px 0 2px;
        min-height: 20px;
      }
      .tag {
        display: inline-flex;
        align-items: center;
        font-family: var(--font-mono);
        font-size: 11px;
        text-transform: uppercase;
        padding: 0 6px;
        height: 18px;
        border: 1px solid var(--divider-strong);
        color: var(--text-muted);

        mat-icon {
          font-size: 13px;
          width: 13px;
          height: 13px;
        }
        &.geo {
          color: var(--text);
          border-color: var(--accent-border);
          background: var(--accent-soft);
        }
        &.lang {
          gap: 3px;
          text-transform: none;
          font-family: var(--app-font);
          border-color: transparent;
          padding: 0 2px;
        }
        &.faint {
          border-color: transparent;
          color: var(--text-faint);
          padding: 0 2px;
        }
        &.bad {
          border-color: transparent;
          color: var(--danger);
          padding: 0 2px;
        }
      }
      .user-tags {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        margin: 4px 0;
      }
      .utag {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        height: 20px;
        padding: 0 7px;
        font-size: 12px;
        color: var(--text);
        border: 1px solid var(--tag);
        border-left-width: 4px;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .utag-owner {
        color: var(--text-faint);
        font-size: 11px;
      }
      .utag-add {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        height: 20px;
        padding: 0 5px;
        background: none;
        border: 1px dashed var(--divider-strong);
        color: var(--text-faint);
        font: inherit;
        font-size: 12px;
        cursor: pointer;

        mat-icon {
          font-size: 14px;
          width: 14px;
          height: 14px;
        }
        &:hover {
          color: var(--text);
          border-color: var(--text-muted);
        }
      }
      .opt-dot {
        display: inline-block;
        width: 10px;
        height: 10px;
        margin-right: 8px;
        vertical-align: 0;
      }
      .opt-owner {
        color: var(--text-faint);
      }
      .menu-hint {
        padding: 8px 16px;
        font-size: 12px;
        color: var(--text-faint);
        max-width: 220px;
      }
      .sync-bar {
        margin-bottom: 12px;
      }
      .banner {
        display: flex;
        align-items: center;
        gap: 10px;
        background: var(--warn-soft);
        border: 1px solid var(--warn);
        color: var(--warn);
        padding: 10px 14px;
        font-size: 13px;
        margin-bottom: 12px;
      }
      .banner.danger {
        background: var(--danger-soft);
        border-color: var(--danger);
        color: var(--danger);
      }
      .layout {
        display: grid;
        grid-template-columns: 230px minmax(0, 1fr);
        gap: 24px;
        align-items: start;
      }
      .verticals {
        position: sticky;
        top: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .verticals-head {
        padding: 8px 10px;
      }
      .v-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        background: none;
        border: none;
        color: var(--text);
        font: inherit;
        text-align: left;
        cursor: pointer;
        width: 100%;
      }
      .v-item:hover {
        background: var(--hover);
      }
      .v-item.active {
        background: var(--hover-strong);
        box-shadow: inset 2px 0 0 var(--accent-text);
      }
      .v-code {
        flex: 0 0 auto;
        font-size: 11px;
        letter-spacing: 0.04em;
        color: var(--text-muted);
        width: 30px;
      }
      .v-code.all {
        color: var(--text-faint);
      }
      .v-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .v-count {
        color: var(--text-faint);
        font-size: 12px;
      }
      .toolbar {
        display: flex;
        align-items: flex-end;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .summary {
        font-size: 12px;
        color: var(--text-faint);
        margin-bottom: 10px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 16px;
      }
      .card {
        display: flex;
        flex-direction: column;
        background: var(--surface);
        border: 1px solid var(--divider);
        min-width: 0;
      }
      .card.removed {
        opacity: 0.55;
      }
      .thumb {
        position: relative;
        aspect-ratio: 16 / 9;
        background: #0b0b0c;
        border: none;
        padding: 0;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;

        img {
          width: 100%;
          height: 100%;
          object-fit: contain;
        }
        .no-thumb {
          color: #555;
          font-size: 36px;
          width: 36px;
          height: 36px;
        }
        .play {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(0, 0, 0, 0.35);
          color: #fff;
          opacity: 0;
          transition: opacity 0.12s;

          mat-icon {
            font-size: 44px;
            width: 44px;
            height: 44px;
          }
        }
        &:hover .play,
        &:focus-visible .play {
          opacity: 1;
        }
      }
      .duration,
      .on-lands {
        position: absolute;
        bottom: 6px;
        background: rgba(0, 0, 0, 0.75);
        color: #fff;
        font-size: 11px;
        padding: 1px 6px;
      }
      .duration {
        right: 6px;
      }
      .on-lands {
        left: 6px;
        display: inline-flex;
        align-items: center;
        gap: 3px;

        mat-icon {
          font-size: 13px;
          width: 13px;
          height: 13px;
        }
      }
      .body {
        display: flex;
        flex-direction: column;
        flex: 1;
        padding: 10px 12px 10px;
        min-width: 0;
      }
      .id-row {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .creo-id {
        font-size: 18px;
        font-weight: 600;
        letter-spacing: 0.02em;
        color: var(--text);
      }
      .copy-id {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        padding: 0;
        background: none;
        border: none;
        color: var(--text-faint);
        cursor: pointer;

        mat-icon {
          font-size: 16px;
          width: 16px;
          height: 16px;
        }
        &:hover {
          color: var(--text);
          background: var(--hover);
        }
      }
      .sub {
        display: flex;
        gap: 10px;
        font-size: 11px;
        color: var(--text-faint);
        min-width: 0;
      }
      .folder {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      .dup-badge {
        font-family: var(--font-mono);
        font-size: 10px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 1px 6px;
        border: 1px solid var(--danger);
        color: var(--danger);
        white-space: nowrap;
      }
      .removed-tag {
        color: var(--danger);
      }
      .note {
        margin-top: 4px;
        font-size: 12px;
        color: var(--text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .file-name {
        margin-top: auto;
        padding-top: 6px;
        font-size: 11px;
        color: var(--text-faint);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 80px 16px;
        color: var(--text-muted);
        text-align: center;

        mat-icon {
          font-size: 44px;
          width: 44px;
          height: 44px;
          opacity: 0.4;
          margin-bottom: 8px;
        }
        p {
          margin: 0 0 4px;
          font-weight: 600;
          font-size: 14px;
        }
      }
    `,
  ],
})
export class LibraryPage implements OnInit, OnDestroy, TagHost {
  readonly NONE = NONE;
  readonly orNull = orNull;
  private readonly api = inject(ApiService);
  private readonly ask = inject(ConfirmService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly clipboard = inject(Clipboard);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly status = signal<DriveStatus | null>(null);
  readonly videos = signal<LibraryVideo[]>([]);
  readonly verticals = signal<Vertical[]>([]);
  readonly tags = signal<Tag[]>([]);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);

  readonly verticalFilter = signal<VerticalFilter>(readVertical());
  /**
   * "New" = appeared in the library after this viewer last pressed "mark
   * seen". Kept per browser, so each buyer has their own. A first visit
   * starts from now — the existing library isn't all "new".
   */
  readonly seenAt = signal<number>(readSeenAt());
  readonly newWindow = signal<NewWindow>(readNewWindow());
  readonly onlyNew = signal(false);
  readonly geoFilter = signal<string | null>(null);
  readonly langFilter = signal<string | null>(null);
  readonly tagFilter = signal<TagFilter>(null);
  readonly sortMode = signal<'new' | 'old' | 'id' | 'name'>('new');
  readonly showRemoved = signal(false);
  readonly onlyDuplicates = signal(false);
  readonly onlyReports = signal(false);
  readonly queue = signal<CreoQueueState | null>(null);
  private folders: DriveFolder[] = [];

  readonly date = formatDate;
  readonly country = countryName;
  readonly language = languageName;
  readonly duration = formatDuration;
  readonly bytes = formatBytes;

  readonly connectUrl = this.api.drive.connectUrl();
  /** Only an admin may re-point the Drive connection (the server enforces it too). */
  readonly isAdmin = this.api.isAdmin;
  readonly canHistory = computed(() => this.api.can('history'));

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private queueTimer: ReturnType<typeof setInterval> | null = null;

  private readonly tagById = computed(() => new Map(this.tags().map((t) => [t.id, t])));
  private readonly verticalById = computed(() => new Map(this.verticals().map((v) => [v.id, v])));
  readonly myTags = computed(() => this.tags().filter((t) => t.mine));

  readonly activeVideos = computed(() => this.videos().filter((v) => !v.removed));
  readonly removedCount = computed(() => this.videos().length - this.activeVideos().length);
  readonly reportCount = computed(() => this.activeVideos().filter((v) => v.reports.length).length);
  readonly duplicateCount = computed(() => this.activeVideos().filter((v) => v.duplicateMarks.length).length);
  readonly newVideos = computed(() => this.activeVideos().filter((v) => this.isNew(v)));
  readonly newCount = computed(() => this.newVideos().length);
  readonly seenLabel = computed(() => new Date(this.seenAt()).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));

  /** Verticals that hold anything, with their active and "new" counts. */
  readonly sidebarVerticals = computed(() => {
    const active = countBy(this.activeVideos(), (v) => v.verticalId);
    const fresh = countBy(this.newVideos(), (v) => v.verticalId);
    const any = countBy(this.videos(), (v) => v.verticalId);
    return this.verticals()
      .filter((v) => (active.get(v.id) ?? 0) > 0 || (this.showRemoved() && any.has(v.id)) || this.verticalFilter() === v.id)
      .map((v) => ({ ...v, active: active.get(v.id) ?? 0, fresh: fresh.get(v.id) ?? 0 }));
  });

  /**
   * Each dropdown counts within every other active filter (vertical,
   * language, tag, "only new") but not its own — so "Болгария (1)" means one
   * Bulgarian creative in the chosen vertical, and picking it never shows nothing.
   */
  readonly geoCounts = computed(() =>
    countBy(this.videos().filter((v) => this.matches(v, 'geo')), (v) => v.geo ?? '-'),
  );
  readonly langCounts = computed(() =>
    countBy(this.videos().filter((v) => this.matches(v, 'lang')), (v) => v.lang ?? '-'),
  );
  readonly tagCounts = computed(() => {
    const out = new Map<number | '-', number>();
    for (const v of this.videos().filter((x) => this.matches(x, 'tag'))) {
      const ids = this.visibleTagIds(v);
      if (!ids.length) out.set('-', (out.get('-') ?? 0) + 1);
      for (const id of ids) out.set(id, (out.get(id) ?? 0) + 1);
    }
    return out;
  });
  readonly geoOptions = computed(() =>
    [...withSelected(this.geoCounts(), this.geoFilter())]
      .filter(([code]) => code !== '-')
      .map(([code, count]) => ({ code, name: countryName(code), count }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
  );
  readonly langOptions = computed(() =>
    [...withSelected(this.langCounts(), this.langFilter())]
      .filter(([code]) => code !== '-')
      .map(([code, count]) => ({ code, name: languageName(code), count }))
      .sort((a, b) => b.count - a.count),
  );
  /** Every visible tag stays listed (own first), so an unused one can still be picked. */
  readonly tagOptions = computed(() =>
    this.tags().map((tag) => ({ tag, count: this.tagCounts().get(tag.id) ?? 0 })),
  );

  readonly filtered = computed(() => this.sortVideos(this.videos().filter((v) => this.matches(v))));
  /** "New" within the chosen vertical — what the "only new" chip would show. */
  readonly newInView = computed(
    () => this.videos().filter((v) => this.matches(v, 'new') && !v.removed && this.isNew(v)).length,
  );

  async ngOnInit(): Promise<void> {
    const params = this.route.snapshot.queryParamMap;
    const driveError = params.get('driveError');
    if (driveError) this.error.set(`Google Drive: ${driveError}`);
    if (params.get('driveConnected')) this.snack.open('Google Drive подключён — синхронизирую…', undefined, { duration: 4000 });
    if (driveError || params.get('driveConnected')) {
      void this.router.navigate([], { queryParams: {}, replaceUrl: true });
    }
    await Promise.all([this.refreshStatus(), this.loadLibrary(), this.refreshQueue()]);
    this.queueTimer = setInterval(() => void this.refreshQueue(), QUEUE_POLL_MS);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.queueTimer) clearInterval(this.queueTimer);
  }

  selectVertical(value: VerticalFilter): void {
    this.verticalFilter.set(value);
    writeVertical(value);
  }

  verticalName(v: Vertical): string {
    return v.name || 'Корень папки';
  }

  async upload(): Promise<void> {
    if (!this.folders.length) this.folders = (await this.guard(() => this.api.library.folders())) ?? [];
    const selected = this.verticalFilter();
    const vertical = selected === 'all' ? undefined : this.verticalById().get(selected);
    const ref = this.dialog.open<UploadDialog, UploadDialogData, boolean>(UploadDialog, {
      data: { folders: this.folders, folderPath: vertical?.name },
      width: '720px',
      maxWidth: '95vw',
      disableClose: true,
    });
    const uploaded = await firstValueFrom(ref.afterClosed());
    if (uploaded) await Promise.all([this.loadLibrary(), this.refreshQueue()]);
  }

  thumbUrl(v: LibraryVideo): string {
    return `${this.api.library.thumbUrl(v.id)}?v=${encodeURIComponent(v.modifiedAt)}`;
  }

  /** Where the file sits: the full path across verticals, the subfolder inside one. */
  folderLabel(v: LibraryVideo): string {
    if (this.verticalFilter() === 'all') return v.folderPath;
    const slash = v.folderPath.indexOf('/');
    return slash < 0 ? '' : v.folderPath.slice(slash + 1);
  }

  copyId(v: LibraryVideo): void {
    if (!v.creoId) return;
    this.clipboard.copy(v.creoId);
    this.snack.open(`Скопировано: ${v.creoId}`, undefined, { duration: 2000 });
  }

  /* ------------------------- tags (TagHost) ------------------------- */

  tagsOf(v: LibraryVideo): Tag[] {
    const byId = this.tagById();
    return v.tagIds.map((id) => byId.get(id)).filter((t): t is Tag => !!t);
  }

  async toggleTag(v: LibraryVideo, tag: Tag): Promise<void> {
    const current = this.videoById(v.id) ?? v;
    const on = !current.tagIds.includes(tag.id);
    const ok = await this.guard(() => this.api.tags.toggle(v.id, tag.id, on).then(() => true));
    if (!ok) return;
    this.patchLocal(v.id, {
      tagIds: on ? [...current.tagIds, tag.id] : current.tagIds.filter((id) => id !== tag.id),
    });
    this.bumpTagCount(tag.id, on ? 1 : -1);
  }

  async createTag(assignTo?: LibraryVideo): Promise<void> {
    const result = await this.openTagDialog(null);
    if (!result) return;
    const tag = await this.guard(() => this.api.tags.save(result));
    if (!tag) return;
    this.tags.update((list) => [...list, tag]);
    if (assignTo) await this.toggleTag(assignTo, tag);
  }

  async editTag(tag: Tag): Promise<void> {
    const result = await this.openTagDialog(tag);
    if (!result) return;
    const saved = await this.guard(() => this.api.tags.save({ id: tag.id, ...result }));
    if (saved) this.tags.update((list) => list.map((t) => (t.id === saved.id ? saved : t)));
  }

  async deleteTag(tag: Tag): Promise<void> {
    const sure = await this.ask.confirm({
      title: `Удалить тег «${tag.name}»?`,
      message: `Он снимется со всех крео (${tag.count}).`,
      ok: 'Удалить',
      danger: true,
    });
    if (!sure) return;
    const ok = await this.guard(() => this.api.tags.delete(tag.id).then(() => true));
    if (!ok) return;
    if (this.tagFilter() === tag.id) this.tagFilter.set(null);
    this.tags.update((list) => list.filter((t) => t.id !== tag.id));
    this.videos.update((list) =>
      list.map((v) => (v.tagIds.includes(tag.id) ? { ...v, tagIds: v.tagIds.filter((id) => id !== tag.id) } : v)),
    );
  }

  /** The current copy of a video — the dialog's snapshot goes stale as tags change. */
  videoById(id: string): LibraryVideo | undefined {
    return this.videos().find((v) => v.id === id);
  }

  /* ------------------------- duplicates, deletion ------------------------- */

  reportHint(v: LibraryVideo): string {
    return v.reports.map((r) => `${r.mine ? 'Ты' : r.login}: ${r.text}`).join('; ');
  }

  async saveReport(v: LibraryVideo, text: string): Promise<boolean> {
    const report = await this.guard(() => this.api.reports.save(v.id, text));
    if (!report) return false;
    const current = this.videoById(v.id) ?? v;
    this.patchLocal(v.id, { reports: [...current.reports.filter((r) => !r.mine), report] });
    return true;
  }

  async removeReport(v: LibraryVideo): Promise<void> {
    const ok = await this.guard(() => this.api.reports.remove(v.id).then(() => true));
    if (!ok) return;
    const current = this.videoById(v.id) ?? v;
    this.patchLocal(v.id, { reports: current.reports.filter((r) => !r.mine) });
  }

  async resolveReports(v: LibraryVideo): Promise<void> {
    const ok = await this.guard(() => this.api.reports.resolve(v.id).then(() => true));
    if (ok) this.patchLocal(v.id, { reports: [] });
  }

  duplicateHint(v: LibraryVideo): string {
    return v.duplicateMarks
      .map((m) => `${m.mine ? 'Ты' : m.login}: повтор${m.originalId ? ` ${m.originalId}` : ''}`)
      .join('; ');
  }

  async markDuplicate(v: LibraryVideo, originalId: string | null): Promise<boolean> {
    const mark = await this.guard(() => this.api.duplicates.mark(v.id, originalId));
    if (!mark) return false;
    const current = this.videoById(v.id) ?? v;
    this.patchLocal(v.id, { duplicateMarks: [...current.duplicateMarks.filter((m) => !m.mine), mark] });
    return true;
  }

  async unmarkDuplicate(v: LibraryVideo): Promise<void> {
    const ok = await this.guard(() => this.api.duplicates.unmark(v.id).then(() => true));
    if (!ok) return;
    const current = this.videoById(v.id) ?? v;
    this.patchLocal(v.id, { duplicateMarks: current.duplicateMarks.filter((m) => !m.mine) });
  }

  async clearDuplicates(v: LibraryVideo): Promise<void> {
    const ok = await this.guard(() => this.api.duplicates.clear(v.id).then(() => true));
    if (ok) this.patchLocal(v.id, { duplicateMarks: [] });
  }

  async deleteVideo(v: LibraryVideo): Promise<boolean> {
    const label = v.creoId ?? v.name;
    const sure = await this.ask.confirm({
      title: `Удалить ${label}?`,
      message: 'Файл уйдёт в корзину Google Drive — восстановить можно в течение 30 дней. ID крео больше никому не выдаётся.',
      ok: 'Удалить',
      danger: true,
    });
    if (!sure) return false;
    const ok = await this.guard(() => this.api.library.delete(v.id).then(() => true));
    if (!ok) return false;
    this.videos.update((list) => list.filter((x) => x.id !== v.id));
    this.snack.open(`${label} удалён — файл в корзине Drive`, undefined, { duration: 4000 });
    return true;
  }

  openByCreoId(creoId: string): void {
    const video = this.videos().find((v) => v.creoId === creoId);
    if (video) this.open(video);
    else this.snack.open(`Крео ${creoId} нет в библиотеке (удалено?)`, 'OK', { duration: 4000 });
  }

  /* ------------------------- "new" ------------------------- */

  /**
   * A period counts by the date the file was added to Drive — the same for
   * everyone, visible at once. "Since my mark" counts by when it reached
   * this library, per viewer: "I synced, what came in?".
   */
  isNew(v: LibraryVideo): boolean {
    const window = this.newWindow();
    if (window === 'seen') return v.firstSeenAt > this.seenAt();
    const added = Date.parse(v.createdAt ?? '') || v.firstSeenAt;
    return added > Date.now() - window * 86_400_000;
  }

  setNewWindow(value: NewWindow): void {
    this.newWindow.set(value);
    this.onlyNew.set(false);
    try {
      localStorage.setItem(NEW_WINDOW_KEY, String(value));
    } catch {
      /* storage unavailable */
    }
  }

  markSeen(): void {
    const now = Date.now();
    this.seenAt.set(now);
    this.onlyNew.set(false);
    writeSeenAt(now);
  }

  totalDuration(videos: LibraryVideo[]): string {
    return formatDuration(videos.reduce((s, v) => s + (v.durationSec ?? 0), 0));
  }

  async sync(): Promise<void> {
    const current = this.status();
    if (current) this.status.set({ ...current, sync: { ...current.sync, running: true } });
    void this.api.drive.sync().then(() => this.afterSync());
    this.schedulePoll();
  }

  async disconnect(): Promise<void> {
    await this.guard(() => this.api.drive.disconnect());
    await this.refreshStatus();
  }

  open(video: LibraryVideo): void {
    const ref = this.dialog.open<PlayerDialog, PlayerDialogData>(PlayerDialog, {
      data: { video, host: this, isAdmin: this.isAdmin() },
      width: '1180px',
      maxWidth: '96vw',
    });
    ref.afterClosed().subscribe((patch) => {
      if (!patch) return;
      this.patchLocal(video.id, patch.geo !== undefined ? { ...patch, geoSource: 'manual' } : patch);
    });
  }

  /* ------------------------- internals ------------------------- */

  /** Every active filter, optionally minus one (for that filter's own counts). */
  private matches(v: LibraryVideo, except?: 'geo' | 'lang' | 'tag' | 'new'): boolean {
    if (v.removed && !this.showRemoved()) return false;
    const vf = this.verticalFilter();
    if (vf !== 'all' && v.verticalId !== vf) return false;
    const geo = this.geoFilter();
    if (except !== 'geo' && geo && (v.geo ?? '-') !== geo) return false;
    const lang = this.langFilter();
    if (except !== 'lang' && lang && (v.lang ?? '-') !== lang) return false;
    const tag = this.tagFilter();
    if (except !== 'tag' && tag !== null) {
      const ids = this.visibleTagIds(v);
      if (tag === '-' ? ids.length > 0 : !ids.includes(tag)) return false;
    }
    if (except !== 'new' && this.onlyNew() && !this.isNew(v)) return false;
    if (this.onlyDuplicates() && !v.duplicateMarks.length) return false;
    if (this.onlyReports() && !v.reports.length) return false;
    return true;
  }

  private visibleTagIds(v: LibraryVideo): number[] {
    const byId = this.tagById();
    return v.tagIds.filter((id) => byId.has(id));
  }

  private bumpTagCount(id: number, delta: number): void {
    this.tags.update((list) => list.map((t) => (t.id === id ? { ...t, count: Math.max(0, t.count + delta) } : t)));
  }

  private openTagDialog(tag: Tag | null): Promise<TagDialogResult | undefined> {
    return firstValueFrom(
      this.dialog.open<TagDialog, Tag | null, TagDialogResult>(TagDialog, { data: tag }).afterClosed(),
    );
  }

  private patchLocal(id: string, patch: Partial<LibraryVideo>): void {
    this.videos.update((list) => list.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  }

  private async refreshStatus(): Promise<void> {
    const status = await this.guard(() => this.api.drive.status());
    if (!status) return;
    this.status.set(status);
    if (status.sync.running) this.schedulePoll();
  }

  private schedulePoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      const wasRunning = this.status()?.sync.running;
      await this.refreshStatus();
      if (wasRunning && !this.status()?.sync.running) await this.afterSync();
    }, SYNC_POLL_MS);
  }

  private async afterSync(): Promise<void> {
    await Promise.all([this.refreshStatus(), this.loadLibrary()]);
  }

  /** Newest first by default: buyers look for what was just added. */
  private sortVideos(list: LibraryVideo[]): LibraryVideo[] {
    const mode = this.sortMode();
    const time = (v: LibraryVideo) => Date.parse(v.createdAt ?? v.modifiedAt) || 0;
    return [...list].sort((a, b) =>
      mode === 'name'
        ? a.name.localeCompare(b.name, 'ru')
        : mode === 'id'
          ? (a.creoId ?? '').localeCompare(b.creoId ?? '')
          : mode === 'new'
            ? time(b) - time(a)
            : time(a) - time(b),
    );
  }

  /** Poll the transcription queue; reload the cards when work completed. */
  private async refreshQueue(): Promise<void> {
    const next = await this.api.library.queue().catch(() => null);
    if (!next) return;
    const prev = this.queue();
    this.queue.set(next);
    if (prev && (prev.done !== next.done || prev.untranslated !== next.untranslated)) {
      const videos = await this.api.library.list().catch(() => null);
      if (videos) this.videos.set(videos);
    }
  }

  private async loadLibrary(): Promise<void> {
    const [videos, verticals, tags] = await Promise.all([
      this.guard(() => this.api.library.list()),
      this.guard(() => this.api.library.verticals()),
      this.guard(() => this.api.tags.list()),
    ]);
    if (videos) this.videos.set(videos);
    if (verticals) {
      this.verticals.set(verticals);
      // A remembered vertical that no longer exists would show an empty page.
      const vf = this.verticalFilter();
      if (vf !== 'all' && !verticals.some((v) => v.id === vf)) this.selectVertical('all');
    }
    if (tags) this.tags.set(tags);
    this.loaded.set(true);
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
      return null;
    }
  }
}

const QUEUE_POLL_MS = 20_000;

const SEEN_KEY = 'vslstat.library.seenAt';
const NEW_WINDOW_KEY = 'vslstat.library.newWindow';
const VERTICAL_KEY = 'vslstat.library.vertical';

/** Days back by Drive date, or "since my mark". */
type NewWindow = 3 | 7 | 14 | 30 | 'seen';

function readNewWindow(): NewWindow {
  try {
    const v = localStorage.getItem(NEW_WINDOW_KEY);
    if (v === 'seen') return v;
    const n = Number(v);
    if (n === 3 || n === 7 || n === 14 || n === 30) return n;
  } catch {
    /* storage unavailable */
  }
  return 14;
}

function readVertical(): VerticalFilter {
  try {
    const n = Number(localStorage.getItem(VERTICAL_KEY));
    if (Number.isInteger(n) && n > 0) return n;
  } catch {
    /* storage unavailable */
  }
  return 'all';
}

function writeVertical(value: VerticalFilter): void {
  try {
    localStorage.setItem(VERTICAL_KEY, String(value));
  } catch {
    /* storage unavailable */
  }
}

function readSeenAt(): number {
  try {
    const stored = Number(localStorage.getItem(SEEN_KEY));
    if (stored > 0) return stored;
  } catch {
    /* storage unavailable */
  }
  const now = Date.now();
  writeSeenAt(now);
  return now;
}

function writeSeenAt(value: number): void {
  try {
    localStorage.setItem(SEEN_KEY, String(value));
  } catch {
    /* storage unavailable — "new" just lasts for this page view */
  }
}

/**
 * Keep the chosen option listed even when nothing matches it any more (after
 * switching vertical) — otherwise the select shows blank while still filtering.
 */
function withSelected(counts: Map<string, number>, selected: string | null): Map<string, number> {
  if (!selected || counts.has(selected)) return counts;
  return new Map(counts).set(selected, 0);
}

function countBy<T, K = string>(list: T[], key: (item: T) => K): Map<K, number> {
  const out = new Map<K, number>();
  for (const item of list) out.set(key(item), (out.get(key(item)) ?? 0) + 1);
  return out;
}
