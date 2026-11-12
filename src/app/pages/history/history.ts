import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../core/services/api.service';
import { countryName } from '../../../shared/geo';
import type { HistoryEntry, Vertical } from '../../../shared/api.types';

/** A month key `YYYY-MM`, 'all', or 'custom' (own from/to dates). */
type Period = string;

/**
 * Admin page: how the library grew. A month-by-vertical summary, then every
 * creative that came in during the chosen period — uploaded through the
 * service (and by whom) or dropped on Drive directly — and deletions.
 * "Came in" is when the creative first showed up in this library.
 */
@Component({
  selector: 'app-history',
  imports: [
    FormsModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    MatTooltipModule,
    RouterLink,
  ],
  template: `
    <header class="page-header">
      <div>
        <a class="back" routerLink="/library"><mat-icon>arrow_back</mat-icon>Библиотека крео</a>
        <h1>История загрузок</h1>
        <p>
          Сколько крео добавилось и откуда: загружено через сервис или появилось на Drive напрямую.
          Дата — момент, когда крео появилось в библиотеке. Удалённые через сервис помечены.
        </p>
      </div>
    </header>

    @if (!loaded()) {
      <mat-progress-bar mode="indeterminate" />
    } @else {
      <section class="block">
        <div class="eyebrow">Новые крео по месяцам</div>
        <p class="hint">
          Сколько крео появилось в библиотеке за месяц в каждой вертикали. Нажми на месяц — ниже
          откроется список этих крео.
        </p>
        <div class="table-wrap">
          <table class="htable">
            <thead>
              <tr>
                <th class="left">Вертикаль</th>
                @for (m of months(); track m.key) {
                  <th class="month" [class.active]="period() === m.key" (click)="period.set(m.key)">{{ m.label }}</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (v of summaryVerticals(); track v.id) {
                <tr>
                  <td class="left">{{ v.name }} <span class="faint mono">{{ v.code }}</span></td>
                  @for (m of months(); track m.key) {
                    <td class="mono" [class.active]="period() === m.key">
                      @if (m.byVertical.get(v.id); as n) {
                        {{ n }}
                      } @else {
                        <span class="faint">·</span>
                      }
                    </td>
                  }
                </tr>
              }
            </tbody>
            <tfoot>
              <tr class="total">
                <td class="left">Всего добавлено</td>
                @for (m of months(); track m.key) {
                  <td class="mono" [class.active]="period() === m.key">{{ m.total }}</td>
                }
              </tr>
              <tr>
                <td class="left muted">из них загружено через сервис</td>
                @for (m of months(); track m.key) {
                  <td class="mono muted" [class.active]="period() === m.key">{{ m.uploaded || '·' }}</td>
                }
              </tr>
              <tr>
                <td class="left muted">удалено через сервис</td>
                @for (m of months(); track m.key) {
                  <td class="mono muted" [class.active]="period() === m.key">{{ m.deleted || '·' }}</td>
                }
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section class="block">
        <div class="toolbar">
          <mat-form-field class="filter">
            <mat-label>Период</mat-label>
            <mat-select [ngModel]="period()" (ngModelChange)="period.set($event)">
              @for (m of months(); track m.key) {
                <mat-option [value]="m.key">{{ m.label }}</mat-option>
              }
              <mat-option value="all">Весь период</mat-option>
              <mat-option value="custom">Свой период…</mat-option>
            </mat-select>
          </mat-form-field>
          @if (period() === 'custom') {
            <mat-form-field class="filter">
              <mat-label>С</mat-label>
              <input matInput type="date" [ngModel]="from()" (ngModelChange)="from.set($event)" />
            </mat-form-field>
            <mat-form-field class="filter">
              <mat-label>По</mat-label>
              <input matInput type="date" [ngModel]="to()" (ngModelChange)="to.set($event)" />
            </mat-form-field>
          }
          <mat-form-field class="filter">
            <mat-label>Вертикаль</mat-label>
            <mat-select [ngModel]="verticalFilter()" (ngModelChange)="verticalFilter.set($event)">
              <mat-option value="all">Все вертикали</mat-option>
              @for (v of summaryVerticals(); track v.id) {
                <mat-option [value]="v.id">{{ v.name }} · {{ v.code }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field class="filter">
            <mat-label>Источник</mat-label>
            <mat-select [ngModel]="sourceFilter()" (ngModelChange)="sourceFilter.set($event)">
              <mat-option value="all">Все</mat-option>
              <mat-option value="upload">Через сервис</mat-option>
              <mat-option value="drive">Drive напрямую</mat-option>
              <mat-option value="deleted">Удалённые</mat-option>
            </mat-select>
          </mat-form-field>
          <span class="summary">
            {{ shownLabel() }}: <b class="mono">{{ shown().length }}</b>
          </span>
        </div>

        <div class="table-wrap">
          <table class="htable list">
            <thead>
              <tr>
                <th class="left">ID</th>
                <th class="left">Файл</th>
                <th class="left">Вертикаль</th>
                <th class="left">Гео</th>
                <th class="left">Добавлено</th>
                <th class="left">Источник</th>
                <th class="left">Кто загрузил</th>
                <th class="left">Статус</th>
              </tr>
            </thead>
            <tbody>
              @for (e of shown(); track e.fileId) {
                <tr [class.gone]="e.deletedAt || e.removed">
                  <td class="left mono strong">{{ e.creoId ?? '—' }}</td>
                  <td class="left file" [title]="e.name">{{ e.name }}</td>
                  <td class="left">{{ verticalName(e.verticalId) }}</td>
                  <td class="left mono" [matTooltip]="e.geo ? country(e.geo) : ''">{{ e.geo ?? '—' }}</td>
                  <td class="left mono">{{ dateTime(e.firstSeenAt) }}</td>
                  <td class="left">
                    @if (e.source === 'upload') {
                      <span class="src upload"><mat-icon>upload</mat-icon>сервис</span>
                    } @else {
                      <span class="src"><mat-icon>add_to_drive</mat-icon>Drive</span>
                    }
                  </td>
                  <td class="left">{{ e.uploadedBy ?? (e.source === 'upload' ? 'удалённый аккаунт' : '—') }}</td>
                  <td class="left">
                    @if (e.deletedAt) {
                      <span class="deleted">удалён</span>
                      <span class="faint"> {{ dateTime(e.deletedAt) }}@if (e.deletedBy) {<span> · {{ e.deletedBy }}</span>}</span>
                    } @else if (e.removed) {
                      <span class="faint">нет на Drive</span>
                    }
                  </td>
                </tr>
              } @empty {
                <tr><td class="left faint" colspan="8">За этот период ничего не добавилось</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .back {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-bottom: 6px;
        font-size: 13px;
        color: var(--text-secondary, inherit);
        text-decoration: none;
        opacity: 0.75;
      }
      .back:hover {
        opacity: 1;
      }
      .back mat-icon {
        width: 16px;
        height: 16px;
        font-size: 16px;
      }
      .block {
        margin-bottom: 28px;
      }
      .eyebrow {
        margin-bottom: 8px;
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px 12px;
      }
      .filter {
        width: 190px;
      }
      .hint {
        margin: 0 0 10px;
        color: var(--text-muted);
        font-size: 13px;
      }
      .summary {
        color: var(--text-muted);
        font-size: 13px;

        b {
          color: var(--text);
        }
      }
      .table-wrap {
        overflow-x: auto;
        background: var(--surface);
        border: 1px solid var(--divider);
      }
      /* Not "grid": Tailwind's .grid utility would turn the table into a CSS grid. */
      table.htable {
        border-collapse: collapse;
        width: 100%;
        font-size: 13px;

        th {
          font-family: var(--font-mono);
          font-size: 10.5px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          font-weight: 400;
          color: var(--text-faint);
          text-align: right;
          padding: 10px 8px;
          border-bottom: 1px solid var(--divider-strong);
          white-space: nowrap;
        }
        td {
          text-align: right;
          padding: 6px 8px;
          border-bottom: 1px solid var(--divider);
          white-space: nowrap;
        }
        .left {
          text-align: left;
          padding-left: 14px;
        }
        .zero {
          color: var(--text-faint);
        }
        .strong {
          font-weight: 600;
        }
        th.month {
          cursor: pointer;
          min-width: 96px;
        }
        th.month:hover {
          color: var(--text);
        }
        th.active,
        td.active {
          background: var(--accent-soft);
          color: var(--text);
        }
        tbody tr:hover td {
          background: var(--surface-2);
        }
        tfoot td {
          border-bottom: 0;
        }
        tr.total td {
          font-weight: 600;
          border-top: 1px solid var(--divider-strong);
        }
        .muted {
          color: var(--text-muted);
          font-size: 12px;
        }
        .file {
          max-width: 280px;
          overflow: hidden;
          text-overflow: ellipsis;
          color: var(--text-muted);
        }
        tr.gone td {
          opacity: 0.65;
        }
      }
      .src {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: var(--text-muted);

        mat-icon {
          font-size: 16px;
          width: 16px;
          height: 16px;
        }
      }
      .src.upload {
        color: var(--accent-text);
      }
      .deleted {
        color: var(--danger);
        font-weight: 600;
      }
      .faint {
        color: var(--text-faint);
      }
    `,
  ],
})
export class HistoryPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly snack = inject(MatSnackBar);

  readonly entries = signal<HistoryEntry[]>([]);
  readonly verticals = signal<Vertical[]>([]);
  readonly loaded = signal(false);

  readonly period = signal<Period>(monthKey(Date.now()));
  readonly from = signal(isoDate(new Date(Date.now() - 30 * 86_400_000)));
  readonly to = signal(isoDate(new Date()));
  readonly verticalFilter = signal<number | 'all'>('all');
  readonly sourceFilter = signal<'upload' | 'drive' | 'deleted' | 'all'>('all');

  readonly country = countryName;

  private readonly verticalById = computed(() => new Map(this.verticals().map((v) => [v.id, v])));

  /** Verticals that ever got a creative — the summary's columns. */
  readonly summaryVerticals = computed(() => {
    const used = new Set(this.entries().map((e) => e.verticalId));
    return this.verticals()
      .filter((v) => used.has(v.id))
      .map((v) => ({ id: v.id, code: v.code, name: v.name || 'Корень папки' }));
  });

  /** Newest month first; the current month is listed even when empty. */
  readonly months = computed(() => {
    const out = new Map<string, Month>();
    const month = (key: string) => {
      let m = out.get(key);
      if (!m) {
        m = { key, label: monthLabel(key), total: 0, uploaded: 0, deleted: 0, byVertical: new Map() };
        out.set(key, m);
      }
      return m;
    };
    month(monthKey(Date.now()));
    for (const e of this.entries()) {
      const m = month(monthKey(e.firstSeenAt));
      m.total++;
      if (e.source === 'upload') m.uploaded++;
      if (e.verticalId != null) m.byVertical.set(e.verticalId, (m.byVertical.get(e.verticalId) ?? 0) + 1);
      if (e.deletedAt) month(monthKey(e.deletedAt)).deleted++;
    }
    return [...out.values()].sort((a, b) => b.key.localeCompare(a.key));
  });

  readonly shown = computed(() => {
    const [start, end] = this.range();
    const vertical = this.verticalFilter();
    const source = this.sourceFilter();
    return this.entries().filter((e) => {
      if (vertical !== 'all' && e.verticalId !== vertical) return false;
      if (source === 'deleted') return e.deletedAt != null && e.deletedAt >= start && e.deletedAt < end;
      if (source !== 'all' && e.source !== source) return false;
      return e.firstSeenAt >= start && e.firstSeenAt < end;
    });
  });

  /** What the list below shows, in words. */
  readonly shownLabel = computed(() => {
    const p = this.period();
    const what = this.sourceFilter() === 'deleted' ? 'Удалено' : 'Добавлено';
    if (p === 'all') return `${what} за всё время`;
    if (p === 'custom') return `${what} с ${this.from() || '…'} по ${this.to() || '…'}`;
    return `${what} за ${monthLabel(p).toLowerCase()}`;
  });

  async ngOnInit(): Promise<void> {
    try {
      const [entries, verticals] = await Promise.all([this.api.history.list(), this.api.library.verticals()]);
      this.entries.set(entries);
      this.verticals.set(verticals);
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
    }
    this.loaded.set(true);
  }

  verticalName(id: number | null): string {
    const v = id == null ? undefined : this.verticalById().get(id);
    return v ? v.name || 'Корень папки' : '—';
  }

  dateTime(ms: number): string {
    return new Date(ms).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /** The chosen period as [start, end) in ms, local time. */
  private range(): [number, number] {
    const p = this.period();
    if (p === 'all') return [0, Number.MAX_SAFE_INTEGER];
    if (p === 'custom') {
      const start = this.from() ? new Date(`${this.from()}T00:00:00`).getTime() : 0;
      const end = this.to() ? new Date(`${this.to()}T00:00:00`).getTime() + 86_400_000 : Number.MAX_SAFE_INTEGER;
      return [start, end];
    }
    const [y, m] = p.split('-').map(Number) as [number, number];
    return [new Date(y, m - 1, 1).getTime(), new Date(y, m, 1).getTime()];
  }
}

interface Month {
  key: string;
  label: string;
  total: number;
  uploaded: number;
  /** Deleted through the service during this month. */
  deleted: number;
  byVertical: Map<number, number>;
}

function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  const name = new Date(y, m - 1, 1).toLocaleString('ru-RU', { month: 'long' });
  return `${name[0]!.toUpperCase()}${name.slice(1)} ${y}`;
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
