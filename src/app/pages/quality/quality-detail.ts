import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { NONE, orNull } from '../../core/select';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../core/services/api.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { StatsFilterService } from '../../core/services/stats-filter.service';
import { StatsFiltersComponent } from '../../core/components/stats-filters.component';
import {
  ChartMarker,
  RetentionChartComponent,
} from '../../core/components/retention-chart.component';
import { WatchHistogramComponent } from '../../core/components/watch-histogram.component';
import { formatCount, formatDuration, formatPercent, videoLabel } from '../../core/format';
import type {
  BreakdownRow,
  LandVideoDetail,
  LibraryVideo,
  StatsFacets,
} from '../../../shared/api.types';

@Component({
  selector: 'app-quality-detail',
  imports: [
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    MatTooltipModule,
    StatsFiltersComponent,
    RetentionChartComponent,
    WatchHistogramComponent,
  ],
  template: `
    <a mat-button routerLink="/quality" class="back">
      <mat-icon>arrow_back</mat-icon>
      <span>Все видео</span>
    </a>

    @if (detail(); as d) {
      <header class="page-header">
        <div class="title">
          <h1>{{ d.summary.land }}</h1>
          <p class="mono src" [title]="d.summary.src">
            {{ label(d.summary) }}
            @if (d.summary.durationSec) {
              · {{ duration(d.summary.durationSec) }}
            }
          </p>
        </div>
      </header>
    }

    <app-stats-filters [facets]="facets()" [showLand]="false" />

    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }

    @if (detail(); as d) {
      <section class="tiles">
        <div class="tile">
          <div class="label">Визиты</div>
          <div class="value">{{ count(d.summary.views) }}</div>
        </div>
        <div class="tile">
          <div class="label">Включили видео</div>
          <div class="value">{{ pct(d.summary.playRate) }}</div>
          <div class="hint mono">{{ count(d.summary.plays) }} запусков</div>
        </div>
        <div class="tile hero">
          <div class="label">Средний просмотр</div>
          <div class="value">{{ duration(d.summary.avgWatchSec) }}</div>
          <div class="hint mono">медиана {{ duration(d.summary.medianWatchSec) }}</div>
        </div>
        <div class="tile">
          <div class="label">Дошли до попапа</div>
          <div class="value">{{ pct(d.popupReach) }}</div>
          <div class="hint mono">
            {{ d.summary.popupAtSec != null ? 'на ' + duration(d.summary.popupAtSec) : 'момент не задан' }}
          </div>
        </div>
        <div class="tile">
          <div class="label">Досмотрели до конца</div>
          <div class="value">{{ pct(d.summary.completionRate) }}</div>
        </div>
        <div class="tile">
          <div class="label">Заявки</div>
          <div class="value">{{ count(d.summary.submits) }}</div>
          <div class="hint mono">CR {{ pct(d.summary.conversion, 2) }}</div>
        </div>
        <div class="tile">
          <div class="label">Просмотр у заявок</div>
          <div class="value">{{ duration(d.summary.avgWatchSubmittersSec) }}</div>
        </div>
      </section>

      @if (d.summary.errors > 0) {
        <div class="banner danger">
          <mat-icon>error_outline</mat-icon>
          <div>
            Видео не воспроизвелось у {{ count(d.summary.errors) }} посетителей. Проверь, что поток
            открывается в браузерах из разбивки по устройствам: <code>.m3u8</code> в обычном
            <code>&lt;video&gt;</code> без hls.js играет не везде (старые Android, Firefox).
          </div>
        </div>
      }

      <section class="panel">
        <div class="panel-head">
          <h2>Удержание аудитории</h2>
          <span class="sub">доля запусков, которые смотрели каждую секунду видео</span>
        </div>
        @if (d.summary.plays > 0) {
          <app-retention-chart [points]="d.retention" [markers]="markers()" />
        } @else {
          <div class="none">Видео ещё никто не включал за этот период.</div>
        }
      </section>

      @if (d.summary.plays > 0) {
        <section class="panel">
          <div class="panel-head">
            <h2>Сколько смотрели</h2>
            <span class="sub">запуски по общему времени просмотра, шаг {{ duration(d.bucketSec) }}</span>
          </div>
          <app-watch-histogram [buckets]="d.histogram" [bucketSec]="d.bucketSec" />
        </section>
      }

      <section class="breakdowns">
        @for (b of breakdowns(); track b.title) {
          <div class="panel">
            <div class="panel-head"><h2>{{ b.title }}</h2></div>
            <table class="mini mono">
              <thead>
                <tr><th class="left"></th><th>Визиты</th><th>Запуски</th><th>Ср. просм.</th><th>Заявки</th></tr>
              </thead>
              <tbody>
                @for (r of b.rows; track r.key) {
                  <tr>
                    <td class="left">{{ r.key }}</td>
                    <td>{{ count(r.views) }}</td>
                    <td>{{ count(r.plays) }}</td>
                    <td>{{ duration(r.avgWatchSec) }}</td>
                    <td>{{ count(r.submits) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <section class="panel settings">
        <div class="panel-head"><h2>Настройки</h2></div>
        <div class="settings-row">
          <mat-form-field class="link">
            <mat-label>Видео из библиотеки</mat-label>
            <mat-select [ngModel]="d.summary.driveFileId ?? NONE" (ngModelChange)="link(orNull($event))">
              <mat-option [value]="NONE">Не привязано</mat-option>
              @for (v of library(); track v.id) {
                <mat-option [value]="v.id">
                  {{ v.creoId ? v.creoId + ' · ' : '' }}{{ v.folderPath ? v.folderPath + ' / ' : '' }}{{ v.name }}
                </mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field class="popup">
            <mat-label>Попап, секунда</mat-label>
            <input
              matInput
              type="number"
              min="0"
              [ngModel]="d.summary.popupAtSec"
              (change)="setPopup($any($event.target).value)"
            />
          </mat-form-field>
          <span class="spacer"></span>
          <button mat-button class="danger-btn" (click)="remove()">
            <mat-icon>delete_outline</mat-icon>
            <span>Удалить статистику</span>
          </button>
        </div>
        <div class="src-line mono">{{ d.summary.src }}</div>
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .back {
        margin: -8px 0 8px -8px;
      }
      .title {
        min-width: 0;
      }
      .src {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
      }
      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 1px;
        background: var(--divider);
        border: 1px solid var(--divider);
        margin-bottom: 16px;
      }
      .tile {
        background: var(--surface);
        padding: 14px 16px;
      }
      .label {
        font-size: 12px;
        color: var(--text-muted);
      }
      .value {
        font-size: 24px;
        font-weight: 600;
        margin-top: 2px;
        color: var(--text);
      }
      .tile.hero .value {
        font-size: 30px;
      }
      .hint {
        font-size: 11px;
        color: var(--text-faint);
      }
      .banner {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        font-size: 13px;
        margin-bottom: 16px;
      }
      .banner.danger {
        background: var(--danger-soft);
        border: 1px solid var(--danger);
        color: var(--danger);
      }
      .panel {
        background: var(--surface);
        border: 1px solid var(--divider);
        padding: 14px 16px;
        margin-bottom: 16px;
        min-width: 0;
      }
      .panel-head {
        display: flex;
        align-items: baseline;
        gap: 12px;
        margin-bottom: 8px;

        h2 {
          margin: 0;
          font-size: 17px;
        }
        .sub {
          font-size: 12px;
          color: var(--text-faint);
        }
      }
      .none {
        padding: 40px 0;
        text-align: center;
        color: var(--text-muted);
      }
      .breakdowns {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 16px;
        margin-bottom: 16px;

        .panel {
          margin-bottom: 0;
        }
      }
      table.mini {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;

        th {
          font-weight: 400;
          color: var(--text-faint);
          text-align: right;
          white-space: nowrap;
          padding: 4px 8px;
          border-bottom: 1px solid var(--divider-strong);
        }
        td {
          text-align: right;
          white-space: nowrap;
          padding: 5px 8px;
          border-bottom: 1px solid var(--divider);
        }
        .left {
          text-align: left;
        }
      }
      .settings-row {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }
      .link {
        width: 420px;
        max-width: 100%;
      }
      .popup {
        width: 150px;
      }
      .spacer {
        flex: 1;
      }
      .danger-btn {
        color: var(--danger);
      }
      .src-line {
        margin-top: 10px;
        font-size: 11px;
        color: var(--text-faint);
        word-break: break-all;
      }
      code {
        background: var(--code-bg);
        padding: 0 4px;
      }
    `,
  ],
})
export class QualityDetailPage {
  readonly NONE = NONE;
  readonly orNull = orNull;
  /** Route param, bound by `withComponentInputBinding`. */
  readonly id = input.required<string>();

  private readonly api = inject(ApiService);

  private readonly ask = inject(ConfirmService);
  private readonly router = inject(Router);
  private readonly snack = inject(MatSnackBar);
  private readonly filters = inject(StatsFilterService);

  readonly detail = signal<LandVideoDetail | null>(null);
  readonly facets = signal<StatsFacets | null>(null);
  readonly library = signal<LibraryVideo[]>([]);
  readonly loading = signal(true);

  readonly duration = formatDuration;
  readonly label = videoLabel;
  readonly count = formatCount;
  readonly pct = (v: number | null, digits = 0) => formatPercent(v, digits);

  private requestId = 0;

  readonly markers = computed<ChartMarker[]>(() => {
    const popup = this.detail()?.summary.popupAtSec;
    return popup != null ? [{ sec: popup, label: 'Попап' }] : [];
  });

  readonly breakdowns = computed<{ title: string; rows: BreakdownRow[] }[]>(() => {
    const d = this.detail();
    if (!d) return [];
    return [
      { title: 'Устройства', rows: d.byDevice },
      { title: 'Гео', rows: d.byCountry },
      { title: 'Баеры', rows: d.byBuyer },
      {
        title: 'По дням',
        rows: d.daily.map((r) => ({ key: r.day, views: r.views, plays: r.plays, avgWatchSec: r.avgWatchSec, submits: r.submits })),
      },
    ];
  });

  constructor() {
    effect(() => void this.load(Number(this.id()), this.filters.filter()));
    void this.api.stats.facets().then((f) => this.facets.set(f));
    void this.api.library
      .list()
      .then((list) => this.library.set(list.filter((v) => !v.removed)))
      .catch(() => undefined);
  }

  async link(driveFileId: string | null): Promise<void> {
    await this.patch({ driveFileId });
  }

  async setPopup(raw: string): Promise<void> {
    const value = raw === '' ? null : Number(raw);
    if (value !== null && (!Number.isFinite(value) || value < 0)) return;
    await this.patch({ popupAtSec: value });
  }

  async remove(): Promise<void> {
    const ok = await this.ask.confirm({
      title: 'Удалить видео и его статистику?',
      message: 'Если трекер стоит на ленде, видео появится снова — уже с новыми просмотрами.',
      ok: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    await this.api.stats.deleteLandVideo(Number(this.id()));
    void this.router.navigate(['/quality']);
  }

  private async patch(patch: { driveFileId?: string | null; popupAtSec?: number | null }): Promise<void> {
    try {
      await this.api.stats.updateLandVideo(Number(this.id()), patch);
      await this.load(Number(this.id()), this.filters.filter());
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
    }
  }

  private async load(id: number, filter: ReturnType<StatsFilterService['filter']>): Promise<void> {
    const req = ++this.requestId;
    this.loading.set(true);
    try {
      const detail = await this.api.stats.detail(id, filter);
      if (req === this.requestId) this.detail.set(detail);
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
    } finally {
      if (req === this.requestId) this.loading.set(false);
    }
  }
}
