import { Component, computed, effect, inject, OnInit, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { Router } from '@angular/router';
import { Clipboard } from '@angular/cdk/clipboard';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import { ApiKeysDialog } from './api-keys-dialog';
import { ApiService } from '../../core/services/api.service';
import { StatsFilterService } from '../../core/services/stats-filter.service';
import { StatsFiltersComponent } from '../../core/components/stats-filters.component';
import { formatCount, formatDuration, formatPercent, videoLabel } from '../../core/format';
import type {
  CraftStatus,
  GroupSummary,
  LandVideoSummary,
  StatsFacets,
  StatsMetrics,
  StatsOverview,
} from '../../../shared/api.types';

type Mode = 'video' | 'land' | 'flat';
type SortCol = 'name' | 'duration' | keyof StatsMetrics;

interface Column {
  id: SortCol;
  label: string;
  tip?: string;
}

const MODE_KEY = 'vslstat.quality.mode';

@Component({
  selector: 'app-quality',
  imports: [
    NgTemplateOutlet,
    MatButtonModule,
    MatButtonToggleModule,
    MatIconModule,
    MatProgressBarModule,
    MatTooltipModule,
    StatsFiltersComponent,
  ],
  template: `
    <header class="page-header">
      <div>
        <h1>Качество видео на лендах</h1>
        <p>
          Сколько реально смотрят VSL на каждом ленде: учитываются только секунды, которые
          проиграны со звуком, а перемотка не засчитывается.
        </p>
      </div>
      <div class="header-actions">
        @if (api.isAdmin()) {
          <button mat-stroked-button (click)="openApi()">
            <mat-icon>key</mat-icon>
            <span>API</span>
          </button>
        }
        <button mat-stroked-button (click)="showInstall.set(!showInstall())">
          <mat-icon>code</mat-icon>
          <span>Подключить ленд</span>
        </button>
      </div>
    </header>

    @if (showInstall()) {
      <section class="install">
        <div class="eyebrow">Одна строка в &lt;head&gt; или перед &lt;/body&gt; ленда</div>
        <div class="snippet">
          <code>{{ snippet() }}</code>
          <button mat-icon-button matTooltip="Скопировать" (click)="copy(snippet())">
            <mat-icon>content_copy</mat-icon>
          </button>
        </div>
        <ul>
          <li>
            Ленд в статистике называется по домену и пути. Своё имя можно задать атрибутом
            <code>data-land="uroactive-es"</code>.
          </li>
          <li>
            Названия видео подтягиваются из craft-lander по ссылке на поток
            @if (craft(); as c) {
              ({{ c.configured ? (c.error ? 'ошибка: ' + c.error : c.count + ' видео') : 'не подключено' }})
            }.
          </li>
          <li>
            Трекер сам находит все <code>&lt;video&gt;</code> на странице. Видео различаются по URL
            потока, поэтому одно видео на разных лендах видно отдельно.
          </li>
          <li>
            Момент попапа берётся из <code>timerPOPUP</code> ленда или из
            <code>data-popup-at="1026"</code>.
          </li>
          <li>
            Отправка формы засчитывается как заявка. <code>_subid</code> Keitaro, <code>utm_*</code>
            и баер (<code>buyer</code> / <code>sub_id_1</code>) берутся из URL и cookie.
          </li>
          <li>
            Свои события на шкале: <code>vslStat.mark('form_open')</code>.
          </li>
        </ul>
      </section>
    }

    <app-stats-filters [facets]="facets()" />

    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }

    @if (!loading() && rows().length === 0) {
      <div class="empty">
        <mat-icon>insights</mat-icon>
        <p>За этот период данных нет</p>
        <small>Подключи трекер на ленд — первые просмотры появятся здесь через несколько секунд.</small>
      </div>
    } @else if (rows().length) {
      <div class="toolbar">
        <mat-button-toggle-group [value]="mode()" (change)="setMode($event.value)" aria-label="Группировка">
          <mat-button-toggle value="video">По видео</mat-button-toggle>
          <mat-button-toggle value="land">По лендам</mat-button-toggle>
          <mat-button-toggle value="flat">Все строки</mat-button-toggle>
        </mat-button-toggle-group>
        @if (mode() !== 'flat') {
          <button mat-button (click)="toggleAll()">
            <mat-icon>{{ allOpen() ? 'unfold_less' : 'unfold_more' }}</mat-icon>
            <span>{{ allOpen() ? 'Свернуть все' : 'Развернуть все' }}</span>
          </button>
        }
      </div>

      <div class="table-wrap">
        <table class="stats">
          <thead>
            <tr>
              <th class="left sortable" [class.sorted]="sort().col === 'name'" (click)="sortBy('name')">
                {{ mode() === 'video' ? 'Видео · ленды' : mode() === 'land' ? 'Ленд · видео' : 'Ленд · видео' }}
                <mat-icon class="sort-icon">{{ sortIcon('name') }}</mat-icon>
              </th>
              @for (c of columns; track c.id) {
                <th class="sortable" [class.sorted]="sort().col === c.id" [matTooltip]="c.tip ?? ''" (click)="sortBy(c.id)">
                  <mat-icon class="sort-icon">{{ sortIcon(c.id) }}</mat-icon>{{ c.label }}
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @if (mode() === 'flat') {
              @for (r of sortedRows(); track r.id) {
                <tr class="row" (click)="open(r)" tabindex="0" (keydown.enter)="open(r)">
                  <td class="left name-cell">
                    <div class="primary">{{ r.land }}</div>
                    <div class="secondary" [class.mono]="!r.craftName && !r.driveFileName" [title]="r.src">{{ label(r) }}</div>
                  </td>
                  <ng-container *ngTemplateOutlet="metricCells; context: { $implicit: r, dur: r.durationSec }" />
                </tr>
              }
            } @else {
              @for (g of sortedGroups(); track g.key) {
                <tr class="group" [class.open]="isOpen(g)" (click)="toggle(g)" tabindex="0" (keydown.enter)="toggle(g)" [attr.aria-expanded]="isOpen(g)">
                  <td class="left name-cell">
                    <div class="group-name">
                      <mat-icon class="chevron">chevron_right</mat-icon>
                      <span class="primary" [title]="g.key">{{ g.label }}</span>
                    </div>
                    <div class="secondary indent">{{ g.memberIds.length }} {{ mode() === 'video' ? plural(g.memberIds.length, 'ленд', 'ленда', 'лендов') : plural(g.memberIds.length, 'видео', 'видео', 'видео') }}</div>
                  </td>
                  <ng-container *ngTemplateOutlet="metricCells; context: { $implicit: g, dur: g.durationSec }" />
                </tr>
                @if (isOpen(g)) {
                  @for (r of children(g); track r.id) {
                    <tr class="row child" (click)="open(r)" tabindex="0" (keydown.enter)="open(r)">
                      <td class="left name-cell">
                        @if (mode() === 'video') {
                          <div class="primary indent">{{ r.land }}</div>
                        } @else {
                          <div class="primary indent" [class.mono]="!r.craftName && !r.driveFileName" [title]="r.src">{{ label(r) }}</div>
                        }
                      </td>
                      <ng-container *ngTemplateOutlet="metricCells; context: { $implicit: r, dur: r.durationSec }" />
                    </tr>
                  }
                }
              }
            }
          </tbody>
        </table>
      </div>

      <ng-template #metricCells let-m let-dur="dur">
        <td class="mono">{{ duration(dur) }}</td>
        <td class="mono">{{ count(m.views) }}</td>
        <td class="mono">{{ pct(m.playRate) }}</td>
        <td class="mono">
          <div class="watch">
            <span>{{ duration(m.avgWatchSec) }}</span>
            @if (dur && m.avgWatchSec != null) {
              <span class="meter" [matTooltip]="pct(m.avgWatchSec / dur) + ' длины видео'">
                <span class="fill" [style.width.%]="(m.avgWatchSec / dur) * 100"></span>
              </span>
            }
          </div>
        </td>
        <td class="mono">{{ duration(m.medianWatchSec) }}</td>
        <td class="mono">{{ pct(m.completionRate) }}</td>
        <td class="mono">{{ count(m.submits) }}</td>
        <td class="mono">{{ pct(m.conversion, 2) }}</td>
        <td class="mono">{{ duration(m.avgWatchSubmittersSec) }}</td>
        <td class="mono" [class.bad]="m.errors > 0">
          @if (m.errors > 0) {
            <mat-icon class="err-icon">error_outline</mat-icon>
          }
          {{ count(m.errors) }}
        </td>
      </ng-template>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .install {
        border: 1px solid var(--divider);
        background: var(--surface);
        padding: 14px 16px;
        margin-bottom: 18px;

        ul {
          margin: 10px 0 0;
          padding-left: 18px;
          color: var(--text-muted);
          line-height: 1.7;
        }
        code {
          background: var(--code-bg);
          color: var(--code-text);
          padding: 0 4px;
        }
      }
      .header-actions {
        display: flex;
        gap: 8px;
      }
      .snippet {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 6px;

        code {
          flex: 1;
          padding: 8px 10px;
          overflow-x: auto;
          white-space: nowrap;
        }
      }
      .table-wrap {
        overflow-x: auto;
        border: 1px solid var(--divider);
        background: var(--surface);
      }
      table.stats {
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
          padding: 10px 8px;
          border-bottom: 1px solid var(--divider);
          white-space: nowrap;
          font-variant-numeric: tabular-nums;
        }
        .left {
          text-align: left;
          padding-left: 14px;
        }
        th:last-child,
        td:last-child {
          padding-right: 14px;
        }
        tbody tr {
          cursor: pointer;
        }
        tbody tr:hover,
        tbody tr:focus-visible {
          background: var(--hover);
          outline: none;
        }
      }
      .name-cell {
        max-width: 280px;
      }
      .toolbar {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 12px;
      }
      th.sortable {
        cursor: pointer;
        user-select: none;

        &:hover {
          color: var(--text-muted);
        }
        &.sorted {
          color: var(--text);
        }
      }
      .sort-icon {
        font-size: 14px;
        width: 14px;
        height: 14px;
        vertical-align: -3px;
        margin: 0 2px;
        opacity: 0;
      }
      th:hover .sort-icon,
      th.sorted .sort-icon {
        opacity: 1;
      }
      .primary {
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .secondary {
        font-size: 11px;
        color: var(--text-faint);
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .indent {
        padding-left: 26px;
      }
      tr.group td {
        background: var(--surface-2);
      }
      tr.group .primary {
        font-weight: 600;
      }
      .group-name {
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
      }
      .chevron {
        flex: 0 0 auto;
        font-size: 20px;
        width: 20px;
        height: 20px;
        color: var(--text-faint);
        transition: transform 0.12s;
      }
      tr.group.open .chevron {
        transform: rotate(90deg);
      }
      tr.child .primary {
        font-weight: 400;
        color: var(--text-muted);
      }
      .watch {
        display: inline-flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 3px;
      }
      .meter {
        display: block;
        width: 64px;
        height: 4px;
        background: var(--chart-grid);
      }
      .meter .fill {
        display: block;
        height: 100%;
        max-width: 100%;
        background: var(--chart-1);
      }
      .bad {
        color: var(--danger);
      }
      .err-icon {
        font-size: 14px;
        width: 14px;
        height: 14px;
        vertical-align: -2px;
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
export class QualityPage implements OnInit {
  readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly clipboard = inject(Clipboard);
  private readonly snack = inject(MatSnackBar);
  private readonly filters = inject(StatsFilterService);
  private readonly dialog = inject(MatDialog);

  openApi(): void {
    this.dialog.open(ApiKeysDialog, { width: '720px', maxWidth: '95vw' });
  }

  readonly overview = signal<StatsOverview>({ rows: [], byVideo: [], byLand: [] });
  readonly rows = computed(() => this.overview().rows);
  readonly mode = signal<Mode>(readMode());
  readonly sort = signal<{ col: SortCol; desc: boolean }>({ col: 'views', desc: true });
  /** Expanded groups; everything starts collapsed. */
  private readonly expanded = signal<ReadonlySet<string>>(new Set());

  readonly columns: Column[] = [
    { id: 'duration', label: 'Длина' },
    { id: 'views', label: 'Визиты' },
    { id: 'playRate', label: 'Запуск', tip: 'Доля визитов, где видео включили со звуком' },
    { id: 'avgWatchSec', label: 'Ср. просм.' },
    { id: 'medianWatchSec', label: 'Медиана' },
    { id: 'completionRate', label: 'Досмотр', tip: 'Досмотрели ≥ 90% видео' },
    { id: 'submits', label: 'Заявки' },
    { id: 'conversion', label: 'CR', tip: 'Заявки / визиты' },
    { id: 'avgWatchSubmittersSec', label: 'У заявок', tip: 'Средний просмотр у тех, кто оставил заявку' },
    { id: 'errors', label: 'Ошибки', tip: 'Ошибки воспроизведения' },
  ];

  private readonly rowsById = computed(() => new Map(this.rows().map((r) => [r.id, r])));

  readonly sortedRows = computed(() => this.sorted(this.rows(), (r) => r.land));

  readonly sortedGroups = computed(() => {
    const groups = this.mode() === 'land' ? this.overview().byLand : this.overview().byVideo;
    return this.sorted(groups, (g) => g.label);
  });

  readonly allOpen = computed(() => {
    const groups = this.sortedGroups();
    return groups.length > 0 && groups.every((g) => this.expanded().has(g.key));
  });
  readonly facets = signal<StatsFacets | null>(null);
  readonly loading = signal(true);
  readonly snippet = signal('');
  readonly showInstall = signal(false);
  readonly craft = signal<CraftStatus | null>(null);

  readonly duration = formatDuration;
  readonly label = videoLabel;
  readonly count = formatCount;
  readonly pct = (v: number | null, digits = 0) => formatPercent(v, digits);

  /** Ignore responses that arrive after a newer filter was applied. */
  private requestId = 0;

  constructor() {
    effect(() => void this.load(this.filters.filter()));
  }

  async ngOnInit(): Promise<void> {
    const [facets, snippet, craft] = await Promise.all([
      this.api.stats.facets(),
      this.api.stats.snippet(),
      this.api.stats.craftStatus(),
    ]);
    this.craft.set(craft);
    this.facets.set(facets);
    this.snippet.set(snippet);
    if (!facets.lands.length) this.showInstall.set(true);
  }

  setMode(mode: Mode): void {
    this.mode.set(mode);
    this.expanded.set(new Set());
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* storage unavailable */
    }
  }

  /** The same column again flips direction; a new one starts descending (names ascending). */
  sortBy(col: SortCol): void {
    const current = this.sort();
    this.sort.set(current.col === col ? { col, desc: !current.desc } : { col, desc: col !== 'name' });
  }

  sortIcon(col: SortCol): string {
    const s = this.sort();
    if (s.col !== col) return 'unfold_more';
    return s.desc ? 'arrow_downward' : 'arrow_upward';
  }

  isOpen(g: GroupSummary): boolean {
    return this.expanded().has(g.key);
  }

  toggle(g: GroupSummary): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (next.has(g.key)) next.delete(g.key);
      else next.add(g.key);
      return next;
    });
  }

  toggleAll(): void {
    this.expanded.set(this.allOpen() ? new Set() : new Set(this.sortedGroups().map((g) => g.key)));
  }

  /** Rows of a group, ordered by the same column as the groups. */
  children(g: GroupSummary): LandVideoSummary[] {
    const rows = g.memberIds
      .map((id) => this.rowsById().get(id))
      .filter((r): r is LandVideoSummary => !!r);
    return this.sorted(rows, (r) => (this.mode() === 'video' ? r.land : videoLabel(r)));
  }

  plural(n: number, one: string, few: string, many: string): string {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  open(row: LandVideoSummary): void {
    void this.router.navigate(['/quality', row.id]);
  }

  copy(text: string): void {
    this.clipboard.copy(text);
    this.snack.open('Скопировано', undefined, { duration: 1500 });
  }

  private async load(filter: ReturnType<StatsFilterService['filter']>): Promise<void> {
    const id = ++this.requestId;
    this.loading.set(true);
    try {
      const overview = await this.api.stats.overview(filter);
      if (id === this.requestId) this.overview.set(overview);
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
    } finally {
      if (id === this.requestId) this.loading.set(false);
    }
  }

  /** Sort by the active column; empty values always go last. */
  private sorted<T extends StatsMetrics & { durationSec: number | null }>(
    list: T[],
    name: (x: T) => string,
  ): T[] {
    const { col, desc } = this.sort();
    const dir = desc ? -1 : 1;
    return [...list].sort((a, b) => {
      if (col === 'name') return dir * name(a).localeCompare(name(b), 'ru');
      const va = col === 'duration' ? a.durationSec : a[col];
      const vb = col === 'duration' ? b.durationSec : b[col];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return dir * ((va as number) - (vb as number));
    });
  }
}

function readMode(): Mode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === 'video' || v === 'land' || v === 'flat') return v;
  } catch {
    /* storage unavailable */
  }
  return 'video';
}
