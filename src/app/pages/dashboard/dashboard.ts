import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../core/services/api.service';
import type { DashBlock, DashBuyingRow, Dashboard, DashMetric, DashPeriodKind } from '../../../shared/dashboard.types';

const REFRESH_MS = 10 * 60_000;

type BuyerSort = 'profit' | 'roi' | 'cost' | 'tested' | 'hits' | 'startedScaling' | 'scaling';
import { DetailDialog, DetailDialogData } from './detail-dialog';

const TAB_KEY = 'vslstat.dashboard.tab';

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * The owner's dashboard: Илья's company metrics in blocks, for a week or a
 * month with the change against the period before and a short history.
 * Metrics without a source yet are shown greyed, so the whole list is in
 * sight from day one.
 */
@Component({
  selector: 'app-dashboard',
  imports: [MatButtonModule, MatButtonToggleModule, MatDialogModule, MatIconModule, MatProgressBarModule, MatTooltipModule],
  template: `
    <header class="page-header">
      <div>
        <h1>Дашборд</h1>
        <p>Главные цифры компании по отделам. Нажми на плитку — откроется, кто и что за ней стоит.</p>
      </div>
      <div class="actions">
        @if (data(); as d) {
          <span class="faint small" [matTooltip]="d.kaitenConfigured ? 'Kaiten перечитывается раз в 30 минут' : ''">
            {{ d.kaitenConfigured ? 'Kaiten: ' + ago(d.kaitenSyncedAt) : 'Kaiten не подключён' }}
          </span>
        }
        <button mat-button (click)="syncNow()" [disabled]="syncing() || !data()?.kaitenConfigured" matTooltip="Перечитать Kaiten сейчас">
          <mat-icon>sync</mat-icon><span>Обновить</span>
        </button>
      </div>
    </header>

    <div class="toolbar">
      <mat-button-toggle-group [value]="kind()" (change)="setKind($event.value)" hideSingleSelectionIndicator>
        <mat-button-toggle value="week">Неделя</mat-button-toggle>
        <mat-button-toggle value="month">Месяц</mat-button-toggle>
      </mat-button-toggle-group>
      <div class="period">
        <button mat-icon-button (click)="move(-1)" matTooltip="Раньше"><mat-icon>chevron_left</mat-icon></button>
        <span class="period-label">{{ data()?.period?.label ?? '…' }}</span>
        <button mat-icon-button (click)="move(1)" [disabled]="data()?.period?.current" matTooltip="Позже"><mat-icon>chevron_right</mat-icon></button>
      </div>
      @if (!data()?.period?.current) {
        <button mat-button (click)="toToday()">К текущей</button>
      } @else {
        <span class="faint small">период идёт — цифры ещё растут</span>
      }
    </div>

    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }
    @if (error()) {
      <div class="banner error">{{ error() }}</div>
    }

    @if (data(); as d) {
      <nav class="tabs" role="tablist">
        @for (b of d.blocks; track b.id) {
          <button
            role="tab"
            class="tab"
            [class.active]="b.id === activeTab()"
            [class.soon]="!liveCount(b)"
            [attr.aria-selected]="b.id === activeTab()"
            (click)="setTab(b.id)"
            [matTooltip]="liveCount(b) ? '' : 'Источники ещё не подключены'"
          >
            {{ b.title }}
            @if (!panelsOnly.has(b.id)) {
              <span class="tab-count">{{ liveCount(b) }}/{{ b.metrics.length }}</span>
            }
          </button>
        }
      </nav>
      @for (b of d.blocks; track b.id) {
        @if (b.id === activeTab()) {
        <section class="block">
          @if (!panelsOnly.has(b.id)) {
          <div class="tiles">
            @for (m of b.metrics; track m.id) {
              <button
                class="tile"
                [class.pending]="m.status === 'pending'"
                [class.clickable]="m.detail"
                [disabled]="!m.detail"
                (click)="openDetail(m)"
              >
                <span class="label">{{ m.label }}</span>
                @if (m.status === 'pending') {
                  <span class="value muted">—</span>
                  <span class="pending-note">Источник не подключён</span>
                } @else {
                  <span class="value">{{ m.value === null ? '—' : fmt(m.value, m) }}</span>
                  @if (m.previous !== null && m.value !== null) {
                    <span class="delta">
                      <mat-icon class="delta-icon">{{ deltaIcon(m) }}</mat-icon>
                      {{ deltaText(m) }}
                      <span class="faint">{{ m.snapshot ? 'к концу прошл.' : 'к прошл.' }} {{ d.period.kind === 'week' ? 'неделе' : 'месяцу' }}</span>
                    </span>
                  }
                  @if (m.series.length) {
                    <span class="spark-readout" [class.on]="sparkHover()?.id === m.id">
                      @if (sparkHover()?.id === m.id && m.series[sparkHover()!.i]; as p) {
                        {{ p.label }}: <b>{{ fmt(p.value, m) }}</b>
                      } @else {
                        {{ m.series.length }} {{ d.period.kind === 'week' ? 'нед.' : 'мес.' }} · наведи на столбик
                      }
                    </span>
                    <svg
                      class="spark"
                      [attr.viewBox]="'0 0 ' + m.series.length * 12 + ' 28'"
                      preserveAspectRatio="none"
                      aria-hidden="true"
                      (mouseleave)="sparkHover.set(null)"
                    >
                      @for (p of m.series; track $index; let last = $last) {
                        <rect
                          [attr.x]="$index * 12 + 1"
                          [attr.y]="28 - barHeight(m, p.value)"
                          width="10"
                          [attr.height]="barHeight(m, p.value)"
                          rx="2"
                          [class.now]="last"
                          [class.neg]="p.value < 0"
                          [class.hover]="sparkHover()?.id === m.id && sparkHover()?.i === $index"
                        />
                        <!-- Full-height hit zone: a zero bar is a sliver, too small to aim at. -->
                        <rect class="hit" [attr.x]="$index * 12" y="0" width="12" height="28" (mouseenter)="sparkHover.set({ id: m.id, i: $index })" />
                      }
                    </svg>
                  }
                  @if (m.note) {
                    <span class="note">{{ m.note }}</span>
                  }
                }
                <span class="source">{{ m.source }}</span>
              </button>
            }
          </div>
          }

          @if (b.id === 'buying') {
            <div class="panel wide">
              <h3>По баерам · {{ d.period.label }}</h3>
              @if (d.buying.moneyError) {
                <p class="error small">Keitaro: {{ d.buying.moneyError }} — деньги не показаны, связки посчитаны.</p>
              }
              <div class="table-wrap">
                <table class="buyers">
                  <thead>
                    <tr>
                      <th class="left">Баер</th>
                      @for (c of buyerColumns; track c.key) {
                        <th
                          class="sortable"
                          [class.sorted]="buyerSort() === c.key"
                          [matTooltip]="c.hint"
                          (click)="buyerSort.set(c.key)"
                        >
                          {{ c.label }}
                        </th>
                      }
                    </tr>
                  </thead>
                  <tbody>
                    @for (r of sortedBuyers(); track r.buyer) {
                      <tr>
                        <td class="left mono strong">{{ r.buyer }}</td>
                        <td class="mono" [class.neg]="(r.profit ?? 0) < 0">{{ r.profit === null ? '—' : money(r.profit) }}</td>
                        <td class="mono" [class.neg]="(r.roi ?? 0) < 0">{{ r.roi === null ? '—' : Math.round(r.roi) + '%' }}</td>
                        <td class="mono">{{ r.cost === null ? '—' : money(r.cost) }}</td>
                        <td class="mono">{{ r.tested || '' }}</td>
                        <td class="mono">
                          @if (r.tested) {
                            {{ r.hits }} <span class="faint">{{ pct(r.hits, r.tested) }}</span>
                          }
                        </td>
                        <td class="mono">{{ r.startedScaling || '' }}</td>
                        <td class="mono strong">{{ r.scaling || '' }}</td>
                      </tr>
                    } @empty {
                      <tr><td class="left faint" colspan="8">Пусто</td></tr>
                    }
                  </tbody>
                  @if (buyerTotals(); as t) {
                    <tfoot>
                      <tr>
                        <td class="left">Итого</td>
                        <td class="mono" [class.neg]="t.profit < 0">{{ money(t.profit) }}</td>
                        <td class="mono">{{ t.cost ? Math.round(((t.profit) / t.cost) * 100) + '%' : '—' }}</td>
                        <td class="mono">{{ money(t.cost) }}</td>
                        <td class="mono">{{ t.tested }}</td>
                        <td class="mono">{{ t.hits }} <span class="faint">{{ pct(t.hits, t.tested) }}</span></td>
                        <td class="mono">{{ t.startedScaling }}</td>
                        <td class="mono">{{ t.scaling }}</td>
                      </tr>
                    </tfoot>
                  }
                </table>
              </div>
              <p class="faint small">
                Деньги — Keitaro (группа кампаний = баер), только подтверждённые лиды. Связки — Kaiten: у связки с двумя баерами она
                засчитана обоим, поэтому «Итого» по связкам может быть больше плиток выше.
              </p>
            </div>
          }

          @if (b.id === 'hiring' && d.hiring; as h) {
            <div class="panels">
              <div class="panel">
                <h3>Воронка найма · {{ d.period.label }}</h3>
                @for (s of h.funnel; track s.label; let i = $index) {
                  <div class="funnel-row" [matTooltip]="i > 0 && h.funnel[i - 1].count ? 'Из прошлого этапа: ' + pct(s.count, h.funnel[i - 1].count) : ''">
                    <span class="f-label">{{ s.label }}</span>
                    <span class="f-track"><span class="f-bar" [style.width.%]="funnelWidth(h.funnel[0].count, s.count)"></span></span>
                    <span class="f-count">{{ s.count }}</span>
                  </div>
                }
                <p class="faint small">
                  Этап засчитан, даже если карточку перетащили через него. Дата выхода на ИС — из поля «Испытательный срок», если заполнено.
                </p>
              </div>
              <div class="panel">
                <h3>Кто вышел на ИС за период — что с ними сейчас</h3>
                @if (h.cohort.started) {
                  <div class="cohort">
                    <div><b>{{ h.cohort.passed }}</b><span>прошли</span></div>
                    <div><b>{{ h.cohort.failed }}</b><span>не прошли</span></div>
                    <div><b>{{ h.cohort.inProgress }}</b><span>ещё на ИС</span></div>
                  </div>
                  <p class="faint small">из {{ h.cohort.started }} вышедших · конверсия {{ pct(h.cohort.passed, h.cohort.started) }}</p>
                } @else {
                  <p class="faint">За период на ИС никто не выходил</p>
                }
                <h3 class="mt">Источники</h3>
                <table class="sources">
                  <thead><tr><th class="left">Источник</th><th>Отклики</th><th>Вышли на ИС</th><th>Прошли ИС</th></tr></thead>
                  <tbody>
                    @for (s of h.sources; track s.source) {
                      <tr><td class="left">{{ s.source }}</td><td>{{ s.responses }}</td><td>{{ s.started }}</td><td>{{ s.passed }}</td></tr>
                    } @empty {
                      <tr><td class="left faint" colspan="4">Пусто</td></tr>
                    }
                  </tbody>
                </table>
              </div>
            </div>
          }
        </section>
        }
      }
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .small {
        font-size: 12px;
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 16px;
        margin-bottom: 16px;
      }
      .period {
        display: flex;
        align-items: center;
      }
      .period-label {
        min-width: 150px;
        text-align: center;
        font-weight: 600;
      }
      .banner.error {
        padding: 10px 14px;
        border: 1px solid var(--danger);
        color: var(--danger);
        margin-bottom: 12px;
      }
      .block {
        margin-bottom: 28px;
      }
      .tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 2px;
        margin-bottom: 16px;
        border-bottom: 1px solid var(--divider-strong);
      }
      .tab {
        font: inherit;
        font-size: 14px;
        color: var(--text-muted);
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
        padding: 8px 14px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .tab:hover {
        color: var(--text);
        background: var(--accent-soft);
      }
      .tab.active {
        color: var(--text);
        font-weight: 600;
        border-bottom-color: var(--accent-text);
      }
      .tab.soon {
        color: var(--text-faint);
      }
      .tab-count {
        font-family: var(--font-mono);
        font-size: 11px;
        font-weight: 400;
        color: var(--text-faint);
      }
      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 12px;
      }
      .tile {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
        text-align: left;
        font: inherit;
        color: var(--text);
        background: var(--surface-2);
        border: 1px solid var(--divider);
        padding: 12px 14px;
        min-height: 150px;
      }
      .tile.clickable {
        cursor: pointer;
      }
      .tile.clickable:hover {
        border-color: var(--accent-border);
        background: var(--surface-3);
      }
      .tile.pending {
        background: none;
        border-style: dashed;
      }
      .label {
        font-size: 12px;
        color: var(--text-muted);
        line-height: 1.25;
      }
      .value {
        font-family: var(--font-mono);
        font-size: 30px;
        font-weight: 600;
        line-height: 1.1;
        font-variant-numeric: tabular-nums;
      }
      .value.muted {
        color: var(--text-faint);
      }
      .pending-note {
        font-size: 12px;
        color: var(--text-faint);
      }
      .delta {
        display: flex;
        align-items: center;
        gap: 3px;
        font-size: 12px;
        font-family: var(--font-mono);
      }
      .delta-icon {
        font-size: 16px;
        width: 16px;
        height: 16px;
      }
      .spark {
        width: 100%;
        height: 28px;
        margin-top: 2px;

        rect {
          fill: var(--text-faint);
          opacity: 0.55;
        }
        rect.now {
          fill: var(--accent-text);
          opacity: 1;
        }
        rect.neg {
          fill: var(--danger);
        }
        rect.hover {
          opacity: 1;
          fill: var(--text);
        }
        rect.hit {
          fill: transparent;
          opacity: 1;
          pointer-events: all;
        }
      }
      .spark-readout {
        margin-top: 6px;
        font-size: 11px;
        color: var(--text-faint);
        line-height: 1.3;
        min-height: 14px;
      }
      .spark-readout.on {
        color: var(--text);
      }
      .spark-readout b {
        font-weight: 600;
      }
      .note {
        font-size: 11px;
        color: var(--text-muted);
        line-height: 1.3;
      }
      .source {
        margin-top: auto;
        padding-top: 6px;
        font-size: 10px;
        font-family: var(--font-mono);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-faint);
      }
      .panels {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
        gap: 12px;
        margin-top: 12px;
      }
      .panel {
        border: 1px solid var(--divider);
        padding: 12px 14px;
      }
      .panel h3 {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-muted);
        margin: 0 0 8px;
      }
      .panel h3.mt {
        margin-top: 14px;
      }
      .panel.wide {
        margin-top: 12px;
      }
      .table-wrap {
        overflow-x: auto;
      }
      .buyers {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
        font-variant-numeric: tabular-nums;

        th {
          font-weight: 400;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-faint);
          text-align: right;
          padding: 4px 8px;
          border-bottom: 1px solid var(--divider-strong);
          white-space: nowrap;
        }
        th.sortable {
          cursor: pointer;
        }
        th.sortable:hover,
        th.sorted {
          color: var(--text);
        }
        th.sorted::after {
          content: ' ↓';
        }
        td {
          text-align: right;
          padding: 4px 8px;
          border-bottom: 1px solid var(--divider);
          white-space: nowrap;
        }
        .left {
          text-align: left;
        }
        .strong {
          font-weight: 600;
        }
        .neg {
          color: var(--danger);
        }
        tbody tr:hover td {
          background: var(--accent-soft);
        }
        tfoot td {
          font-weight: 600;
          border-top: 1px solid var(--divider-strong);
          border-bottom: none;
        }
      }
      .error {
        color: var(--danger);
      }
      .funnel-row {
        display: grid;
        grid-template-columns: 190px 1fr 36px;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        padding: 2px 0;
      }
      .f-track {
        height: 12px;
        background: var(--divider);
      }
      .f-bar {
        display: block;
        height: 100%;
        background: var(--accent-text);
        border-radius: 0 4px 4px 0;
        min-width: 2px;
      }
      .f-count {
        text-align: right;
        font-family: var(--font-mono);
      }
      .cohort {
        display: flex;
        gap: 24px;

        div {
          display: flex;
          flex-direction: column;
        }
        b {
          font-family: var(--font-mono);
          font-size: 24px;
        }
        span {
          font-size: 12px;
          color: var(--text-muted);
        }
      }
      .sources {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;

        th {
          font-weight: 400;
          font-size: 11px;
          color: var(--text-faint);
          text-align: right;
          padding: 3px 6px;
          border-bottom: 1px solid var(--divider-strong);
        }
        td {
          text-align: right;
          padding: 3px 6px;
          border-bottom: 1px solid var(--divider);
          font-family: var(--font-mono);
        }
        .left {
          text-align: left;
          font-family: inherit;
        }
      }
    `,
  ],
})
export class DashboardPage implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);

  readonly data = signal<Dashboard | null>(null);
  readonly loading = signal(false);
  readonly syncing = signal(false);
  readonly error = signal('');
  readonly kind = signal<DashPeriodKind>('week');
  /** A day inside the shown period; null — today. */
  private readonly anchor = signal<string | null>(null);

  /** The open tab (a block id); remembered per browser. */
  readonly tab = signal<string | null>(readStored(TAB_KEY));
  readonly activeTab = computed(() => {
    const blocks = this.data()?.blocks ?? [];
    return blocks.find((b) => b.id === this.tab())?.id ?? blocks[0]?.id ?? null;
  });

  readonly Math = Math;
  /** Tabs shown as their panels only, no tiles (hiring: the funnel and the cohort say it all). */
  readonly panelsOnly = new Set(['hiring']);

  readonly buyerColumns: { key: BuyerSort; label: string; hint: string }[] = [
    { key: 'profit', label: 'Прибыль', hint: 'Подтверждённый доход − расход' },
    { key: 'roi', label: 'ROI', hint: '' },
    { key: 'cost', label: 'Расход', hint: '' },
    { key: 'tested', label: 'Протестировано', hint: 'Связок получили итог теста за период' },
    { key: 'hits', label: 'Зашло', hint: 'Из протестированных — сколько дошли до масштаба' },
    { key: 'startedScaling', label: 'В масштаб', hint: 'Связок впервые перешли в «Масштабирую» за период' },
    { key: 'scaling', label: 'Масштабирует', hint: 'Связок в «Масштабирую» на конец периода' },
  ];
  readonly buyerSort = signal<BuyerSort>('profit');
  readonly sortedBuyers = computed(() => {
    const key = this.buyerSort();
    return [...(this.data()?.buying.rows ?? [])].sort((a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity));
  });
  readonly buyerTotals = computed(() => {
    const rows = this.data()?.buying.rows ?? [];
    if (rows.length < 2) return null;
    const sum = (f: (r: DashBuyingRow) => number | null) => rows.reduce((s, r) => s + (f(r) ?? 0), 0);
    return {
      profit: sum((r) => r.profit),
      cost: sum((r) => r.cost),
      tested: sum((r) => r.tested),
      hits: sum((r) => r.hits),
      startedScaling: sum((r) => r.startedScaling),
      scaling: sum((r) => r.scaling),
    };
  });

  readonly anchorDay = computed(() => this.data()?.period.from ?? this.anchor() ?? '');

  /** A tab left open for hours still shows fresh numbers: reload every 10 min and on coming back to it. */
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private loadedAt = 0;
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible' && Date.now() - this.loadedAt > REFRESH_MS / 2) void this.load();
  };

  async ngOnInit(): Promise<void> {
    this.refreshTimer = setInterval(() => document.visibilityState === 'visible' && void this.load(), REFRESH_MS);
    document.addEventListener('visibilitychange', this.onVisible);
    await this.load();
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  async load(): Promise<void> {
    this.loadedAt = Date.now();
    this.loading.set(true);
    this.error.set('');
    try {
      this.data.set(await this.api.dashboard.overview(this.kind(), this.anchor()));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  setTab(id: string): void {
    this.tab.set(id);
    try {
      localStorage.setItem(TAB_KEY, id);
    } catch {
      // Private mode / blocked storage: the tab just isn't remembered.
    }
  }

  liveCount(b: DashBlock): number {
    return b.metrics.filter((m) => m.status === 'live').length;
  }

  setKind(kind: DashPeriodKind): void {
    this.kind.set(kind);
    void this.load();
  }

  move(step: number): void {
    const p = this.data()?.period;
    if (!p) return;
    const d = new Date(`${step < 0 ? p.from : p.to}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + step);
    this.anchor.set(d.toISOString().slice(0, 10));
    void this.load();
  }

  toToday(): void {
    this.anchor.set(null);
    void this.load();
  }

  async syncNow(): Promise<void> {
    this.syncing.set(true);
    try {
      await this.api.dashboard.sync();
      await this.load();
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
    } finally {
      this.syncing.set(false);
    }
  }

  openDetail(m: DashMetric): void {
    if (!m.detail) return;
    this.dialog.open<DetailDialog, DetailDialogData>(DetailDialog, {
      width: '900px',
      maxWidth: '96vw',
      data: { metricId: m.id, label: m.label, kind: this.kind(), anchor: this.anchorDay() },
    });
  }

  fmt(n: number, m: DashMetric): string {
    if (m.unit !== 'money') return n.toLocaleString('ru-RU');
    const abs = Math.round(Math.abs(n)).toLocaleString('ru-RU');
    return `${n < 0 ? '−' : ''}$${abs}`;
  }

  deltaText(m: DashMetric): string {
    const diff = (m.value ?? 0) - (m.previous ?? 0);
    if (diff === 0) return 'без изменений';
    const sign = diff > 0 ? '+' : '−';
    const abs = Math.abs(diff);
    return m.unit === 'money' ? `${sign}$${Math.round(abs).toLocaleString('ru-RU')}` : `${sign}${abs}`;
  }

  deltaIcon(m: DashMetric): string {
    const diff = (m.value ?? 0) - (m.previous ?? 0);
    return diff > 0 ? 'arrow_upward' : diff < 0 ? 'arrow_downward' : 'remove';
  }

  /** The sparkline bar under the pointer: which tile, which period. */
  readonly sparkHover = signal<{ id: string; i: number } | null>(null);

  /** Bars scaled to the largest magnitude; a zero still shows a sliver. */
  barHeight(m: DashMetric, v: number): number {
    const max = Math.max(1, ...m.series.map((p) => Math.abs(p.value)));
    return Math.max(1.5, (Math.abs(v) / max) * 26);
  }

  funnelWidth(top: number, n: number): number {
    return top ? (n / top) * 100 : 0;
  }

  money(n: number): string {
    return `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n)).toLocaleString('ru-RU')}`;
  }

  pct(n: number, of: number): string {
    return of ? `${Math.round((n / of) * 100)}%` : '—';
  }

  ago(at: number | null): string {
    if (!at) return 'ещё не синхронизирован';
    const min = Math.round((Date.now() - at) / 60_000);
    return min < 1 ? 'только что' : min < 60 ? `${min} мин назад` : `${Math.round(min / 60)} ч назад`;
  }
}
