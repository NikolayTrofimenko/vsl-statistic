import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../core/services/api.service';
import type { CapBuyerRow, CapBuyers, CapDay, CapInput, CapsReport, CapStatus } from '../../../shared/api.types';
import { CapDialog } from './cap-dialog';

const REFRESH_MS = 2 * 60_000;

/**
 * Admin page: today's leads against each partner's daily cap, summed over
 * every landing, with an end-of-day forecast at the current pace — so the
 * head of buying sees "недолив" or "перелив, стопаем" before the day is over.
 */
@Component({
  selector: 'app-caps',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    MatTooltipModule,
  ],
  template: `
    <header class="page-header">
      <div>
        <h1>Капы</h1>
        <p>
          Лиды за сутки по МСК со всех лендов против лимита партнёрки. Считаются все лиды из
          Keitaro, в любом статусе. Прогноз — по темпу последних трёх часов.
        </p>
      </div>
      <div class="actions">
        <mat-form-field class="date" subscriptSizing="dynamic">
          <mat-label>День</mat-label>
          <input matInput type="date" [ngModel]="date()" (ngModelChange)="setDate($event)" />
        </mat-form-field>
        <button mat-button (click)="load()" [disabled]="loading()" matTooltip="Обновить из Keitaro">
          <mat-icon>refresh</mat-icon><span>Обновить</span>
        </button>
        <button mat-flat-button (click)="edit(null)">
          <mat-icon>add</mat-icon><span>Капа</span>
        </button>
      </div>
    </header>

    @if (loading() && !report()) {
      <mat-progress-bar mode="indeterminate" />
    }
    @if (report(); as r) {
      @if (!r.configured) {
        <p class="banner">Keitaro не подключён: на сервере в .env нужны KEITARO_URL и KEITARO_API_KEY.</p>
      }
      @if (r.error) {
        <p class="banner error">Keitaro: {{ r.error }}</p>
      }
      <div class="meta mono">
        {{ r.isToday ? 'Сегодня' : 'День' }} {{ r.date }} · МСК
        @if (r.isToday) { · прошло {{ hoursLabel(r.elapsedHours) }} }
        @if (r.fetchedAt) { · данные на {{ time(r.fetchedAt) }} }
        ·
        @if (r.telegram) {
          <button class="tg" (click)="testTelegram()" matTooltip="Перелив по прогнозу, 90% и 100% капы, вечерний недолив — каждое раз в сутки. Нажми, чтобы отправить тест">
            уведомления в Telegram включены
          </button>
        } @else {
          <span matTooltip="Нужны TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env на сервере">Telegram не подключён</span>
        }
      </div>

      @if (r.caps.length) {
        <div class="filters">
          <mat-form-field class="filter" subscriptSizing="dynamic">
            <mat-label>Партнёрка</mat-label>
            <mat-select [ngModel]="networkFilter()" (ngModelChange)="networkFilter.set($event)">
              <mat-option [value]="ALL">Все</mat-option>
              @for (o of networkOptions(); track o.name) {
                <mat-option [value]="o.name">{{ o.name }} ({{ o.count }})</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field class="filter" subscriptSizing="dynamic">
            <mat-label>Гео</mat-label>
            <mat-select [ngModel]="countryFilter()" (ngModelChange)="countryFilter.set($event)">
              <mat-option [value]="ALL">Все</mat-option>
              @for (o of countryOptions(); track o.name) {
                <mat-option [value]="o.name">{{ o.name }} ({{ o.count }})</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field class="filter search" subscriptSizing="dynamic">
            <mat-icon matPrefix>search</mat-icon>
            <mat-label>Название</mat-label>
            <input matInput [ngModel]="nameFilter()" (ngModelChange)="nameFilter.set($event)" />
          </mat-form-field>
          @if (filtersOn()) {
            <button mat-button (click)="resetFilters()">Сбросить</button>
            <span class="faint mono">{{ shownCaps().length }} из {{ r.caps.length }}</span>
          }
        </div>
      }

      <div class="caps">
        @for (c of shownCaps(); track c.id) {
          <article class="cap" [class.inactive]="!c.active" [attr.data-status]="c.status">
            <div class="cap-head">
              <div class="cap-name">{{ c.name }}</div>
              <span class="status">{{ statusLabel(c.status) }}</span>
              <button mat-icon-button class="edit" (click)="edit(c)" aria-label="Изменить капу"><mat-icon>edit</mat-icon></button>
            </div>
            <div class="numbers">
              <span class="leads mono">{{ c.leads }}</span>
              <span class="of mono">/ {{ c.dailyLimit }}</span>
              <span class="share mono">{{ percent(c.leads, c.dailyLimit) }}</span>
            </div>
            <div class="bar" [matTooltip]="barHint(c)">
              <div class="fill" [style.width.%]="min100(c.leads / c.dailyLimit)"></div>
              @if (c.projected !== null && c.projected > c.leads) {
                <div
                  class="forecast"
                  [style.left.%]="min100(c.leads / c.dailyLimit)"
                  [style.width.%]="min100(c.projected / c.dailyLimit) - min100(c.leads / c.dailyLimit)"
                ></div>
              }
            </div>
            <div class="sub">
              @if (c.projected !== null) {
                <span>Прогноз на конец суток: <b class="mono">{{ c.projected }}</b> ({{ percent(c.projected, c.dailyLimit) }})</span>
              }
              <span>Осталось до капы: <b class="mono">{{ Math.max(0, c.dailyLimit - c.leads) }}</b></span>
            </div>

            <div class="hours" aria-label="Лиды по часам">
              @for (n of c.hourly; track $index) {
                <div class="hour" [class.future]="r.isToday && $index > r.elapsedHours" [matTooltip]="$index + ':00 — ' + n + ' лид.'">
                  <div class="hbar" [style.height.%]="hourHeight(c, n)"></div>
                </div>
              }
            </div>
            <div class="hour-axis mono"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>

            <details class="buyers" (toggle)="onBuyersToggle(c, $event)">
              <summary>Баеры: кто льёт и окупаемость</summary>
              @if (buyersOf(c.id); as b) {
                <div class="buyers-head">
                  <span class="faint">Период</span>
                  @for (d of [1, 7, 14, 30]; track d) {
                    <button class="days-btn" [class.active]="b.days === d" (click)="loadBuyers(c, d)">{{ d }} дн</button>
                  }
                </div>
                <div class="btable-wrap">
                <table class="btable">
                  <thead>
                    <tr class="groups">
                      <th rowspan="2" class="left">Баер</th>
                      <th colspan="2" class="grp">Капа · {{ b.date }}</th>
                      <th [attr.colspan]="b.days > 1 ? 6 : 5" class="grp approved">
                        {{ b.days === 1 ? 'За день' : 'За ' + b.days + ' дн' }} · только подтверждённые
                      </th>
                    </tr>
                    <tr>
                      <th matTooltip="Все лиды за день — так считается капа">Лиды</th>
                      <th>Доля</th>
                      @if (b.days > 1) {
                        <th class="sep" [matTooltip]="'Все лиды за ' + b.days + ' дн'">Лиды</th>
                      }
                      <th [class.sep]="b.days === 1" matTooltip="Подтверждённые лиды и их доля от всех">Апрув</th>
                      <th>Расход</th>
                      <th matTooltip="Выплаты по подтверждённым лидам">Доход</th>
                      <th matTooltip="Доход − расход">Прибыль</th>
                      <th>ROI</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (r of b.rows; track r.buyer) {
                      <tr>
                        <td class="left mono strong">{{ r.buyer ?? 'без группы' }}</td>
                        <td class="mono strong">{{ r.dayLeads }}</td>
                        <td class="mono faint">{{ c.leads ? percent(r.dayLeads, c.leads) : '—' }}</td>
                        @if (b.days > 1) {
                          <td class="mono sep">{{ r.leads }}</td>
                        }
                        <td class="mono" [class.sep]="b.days === 1" [matTooltip]="statusHint(r)">
                          {{ r.sales }} <span class="faint">{{ r.leads ? percent(r.sales, r.leads) : '' }}</span>
                        </td>
                        @if (r.costMissing) {
                          <td class="faint nocost" colspan="1" matTooltip="Расходы не подтянулись в Keitaro">не подтянулись</td>
                        } @else {
                          <td class="mono">{{ money(r.cost) }}</td>
                        }
                        <td class="mono">{{ money(r.revenue) }}</td>
                        <td class="mono" [class.good]="(r.profit ?? 0) > 0" [class.bad-roi]="(r.profit ?? 0) < 0">
                          {{ r.profit === null ? '—' : money(r.profit, true) }}
                        </td>
                        <td
                          class="mono strong"
                          [class.good]="(r.roi ?? 0) >= 50"
                          [class.bad-roi]="r.roi !== null && r.roi < 0"
                          [matTooltip]="r.roiIfApproved !== null && r.pending ? 'Если подтвердят все ожидающие: ' + Math.round(r.roiIfApproved) + '%' : ''"
                        >
                          {{ r.roi === null ? '—' : Math.round(r.roi) + '%' }}
                        </td>
                      </tr>
                    } @empty {
                      <tr><td class="left faint" colspan="9">Лидов нет</td></tr>
                    }
                  </tbody>
                  @if (b.rows.length > 1) {
                    @let t = buyerTotals(b);
                    <tfoot>
                      <tr>
                        <td class="left">Итого</td>
                        <td class="mono">{{ t.dayLeads }}</td>
                        <td></td>
                        @if (b.days > 1) {
                          <td class="mono sep">{{ t.leads }}</td>
                        }
                        <td class="mono" [class.sep]="b.days === 1">
                          {{ t.sales }} <span class="faint">{{ t.leads ? percent(t.sales, t.leads) : '' }}</span>
                        </td>
                        <td class="mono">{{ money(t.cost) }}</td>
                        <td class="mono">{{ money(t.paidRevenue) }}</td>
                        <td class="mono" [class.good]="t.profit > 0" [class.bad-roi]="t.profit < 0">{{ money(t.profit, true) }}</td>
                        <td class="mono" [class.good]="(t.roi ?? 0) >= 50" [class.bad-roi]="t.roi !== null && t.roi < 0">
                          {{ t.roi === null ? '—' : Math.round(t.roi) + '%' }}
                        </td>
                      </tr>
                    </tfoot>
                  }
                </table>
                </div>
                @let tp = buyerTotals(b);
                @if (tp.waiting) {
                  <div class="waiting small">
                    Ещё ждут решения партнёрки: <b class="mono">{{ tp.waiting }}</b> лид. на <b class="mono">{{ money(tp.pending) }}</b>
                    @if (tp.roiIfApproved !== null) {
                      — если подтвердят все, ROI будет <b class="mono">{{ Math.round(tp.roiIfApproved) }}%</b>
                    }
                    <span class="faint">(в таблицу не входят)</span>
                  </div>
                }
                <div class="faint small">
                  {{ b.days === 1 ? 'За один день ROI почти всегда отрицательный: выкуп подтверждается через несколько дней. Для решения по капе смотри 7 дн.' : 'За последние дни ROI занижен — выкуп ещё подтверждается.' }}
                  @if (hasMissingCost(b)) { Деньги в «Итого» — без баеров, у которых расход не подтянулся. }
                </div>
              } @else if (buyersError(c.id); as e) {
                <div class="bad-roi small">{{ e }}</div>
              } @else {
                <mat-progress-bar mode="indeterminate" />
              }
            </details>

            <details>
              <summary>Офферы Keitaro: {{ c.offers.length }}</summary>
              <ul class="offers">
                @for (o of c.offers; track o.id) {
                  <li><span class="mono">{{ o.leads }}</span> {{ o.name }} <span class="faint">#{{ o.id }}</span></li>
                }
              </ul>
            </details>
            @if (c.note) {
              <div class="note">{{ c.note }}</div>
            }
          </article>
        } @empty {
          <div class="empty">
            <mat-icon>speed</mat-icon>
            <p>{{ r.caps.length ? 'Под фильтры ничего не подходит' : 'Кап пока нет' }}</p>
            <small>Нажми «Капа», дай название (например, Proman · IN), лимит и отметь офферы Keitaro, лиды которых в неё идут.</small>
          </div>
        }
      </div>
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
      .date {
        width: 170px;
      }
      .banner {
        padding: 10px 14px;
        border: 1px solid var(--divider-strong);
        background: var(--surface-2);
      }
      .banner.error {
        color: var(--danger);
        border-color: var(--danger);
      }
      .filters {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 12px;
        margin-bottom: 14px;
      }
      .filter {
        width: 200px;
      }
      .filter.search {
        width: 240px;
      }
      .meta {
        color: var(--text-faint);
        font-size: 12px;
        margin-bottom: 12px;
      }
      .tg {
        border: 0;
        background: none;
        padding: 0;
        font: inherit;
        color: inherit;
        text-decoration: underline dotted;
        cursor: pointer;
      }
      .caps {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
        gap: 16px;
      }
      .cap {
        --status: var(--text-muted);
        border: 1px solid var(--divider);
        border-top: 3px solid var(--status);
        background: var(--surface);
        padding: 12px 14px;
      }
      .cap[data-status='over'],
      .cap[data-status='risk'] {
        --status: var(--danger);
      }
      .cap[data-status='ok'] {
        --status: #3f7d4e;
      }
      .cap[data-status='under'] {
        --status: #b07a1f;
      }
      .cap.inactive {
        opacity: 0.55;
      }
      .cap-head {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .cap-name {
        font-size: 16px;
        font-weight: 600;
        flex: 1;
      }
      .status {
        font-family: var(--font-mono);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--status);
      }
      .edit {
        color: var(--text-faint);
      }
      .numbers {
        display: flex;
        align-items: baseline;
        gap: 6px;
        margin: 4px 0 8px;
      }
      .leads {
        font-size: 32px;
        font-weight: 600;
      }
      .of {
        font-size: 16px;
        color: var(--text-muted);
      }
      .share {
        margin-left: auto;
        color: var(--status);
        font-weight: 600;
      }
      .bar {
        position: relative;
        height: 10px;
        background: var(--surface-2);
        border: 1px solid var(--divider);
        overflow: hidden;
      }
      .fill {
        position: absolute;
        inset: 0 auto 0 0;
        background: var(--status);
      }
      .forecast {
        position: absolute;
        top: 0;
        bottom: 0;
        background: repeating-linear-gradient(45deg, var(--status) 0 3px, transparent 3px 7px);
        opacity: 0.5;
      }
      .sub {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 16px;
        margin: 8px 0 10px;
        font-size: 13px;
        color: var(--text-muted);

        b {
          color: var(--text);
        }
      }
      .hours {
        display: grid;
        grid-template-columns: repeat(24, 1fr);
        gap: 2px;
        height: 44px;
        align-items: end;
      }
      .hour {
        height: 100%;
        display: flex;
        align-items: flex-end;
        background: var(--surface-2);
      }
      .hour.future {
        opacity: 0.35;
      }
      .hbar {
        width: 100%;
        background: var(--text-muted);
      }
      .hour-axis {
        display: flex;
        justify-content: space-between;
        font-size: 10px;
        color: var(--text-faint);
        margin: 2px 0 8px;
      }
      .buyers-head {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 6px 0;
        font-size: 12px;
      }
      .days-btn {
        border: 1px solid var(--divider-strong);
        background: none;
        color: var(--text-muted);
        font-size: 11px;
        padding: 1px 6px;
        cursor: pointer;
      }
      .days-btn.active {
        background: var(--accent-soft);
        color: var(--text);
      }
      /* The breakdown is wide: the card takes the whole row while it's open. */
      .cap:has(details.buyers[open]) {
        grid-column: 1 / -1;
      }
      .btable {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
        font-variant-numeric: tabular-nums;

        tr.groups th {
          border-bottom: 1px solid var(--divider);
          padding-top: 2px;
        }
        th.grp {
          text-align: center;
          letter-spacing: 0.04em;
        }
        th.grp.approved {
          color: #3f7d4e;
        }
        tbody tr:hover td {
          background: var(--accent-soft);
        }
        tfoot td {
          font-weight: 600;
          border-top: 1px solid var(--divider-strong);
          border-bottom: none;
          padding-top: 5px;
        }

        th {
          font-family: var(--font-mono);
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          font-weight: 400;
          color: var(--text-faint);
          text-align: right;
          padding: 4px 3px;
          border-bottom: 1px solid var(--divider-strong);
        }
        td {
          text-align: right;
          padding: 3px 3px;
          border-bottom: 1px solid var(--divider);
          white-space: nowrap;
        }
        .left {
          text-align: left;
        }
      }
      .strong {
        font-weight: 600;
      }
      .good {
        color: #3f7d4e;
      }
      .bad-roi {
        color: var(--danger);
      }
      .btable-wrap {
        overflow-x: auto;
      }
      td.nocost {
        white-space: normal;
        line-height: 1.15;
        min-width: 64px;
      }
      .waiting {
        margin-top: 6px;
        color: var(--text-muted);
      }
      .nocost {
        font-size: 11px;
      }
      .small {
        font-size: 11px;
        margin-top: 4px;
      }
      details summary {
        cursor: pointer;
        font-size: 13px;
        color: var(--text-muted);
      }
      .offers {
        margin: 6px 0 0;
        padding-left: 18px;
        font-size: 13px;
      }
      .faint {
        color: var(--text-faint);
      }
      .note {
        margin-top: 8px;
        font-size: 12px;
        color: var(--text-muted);
      }
      .empty {
        grid-column: 1 / -1;
        text-align: center;
        color: var(--text-muted);
        padding: 40px 0;
      }
    `,
  ],
})
export class CapsPage implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);

  readonly report = signal<CapsReport | null>(null);
  readonly loading = signal(false);
  /** '' = today (server's Moscow date). */
  readonly date = signal('');
  readonly Math = Math;

  private timer: ReturnType<typeof setInterval> | null = null;

  readonly ALL = ALL;
  readonly networkFilter = signal<string>(ALL);
  readonly countryFilter = signal<string>(ALL);
  readonly nameFilter = signal('');
  readonly filtersOn = computed(
    () => this.networkFilter() !== ALL || this.countryFilter() !== ALL || this.nameFilter().trim() !== '',
  );

  readonly shownCaps = computed(() => (this.report()?.caps ?? []).filter((c) => this.matches(c)));

  /** Each dropdown counts within the other filters, so a pick never shows nothing. */
  readonly networkOptions = computed(() => this.options((c) => c.networks, 'network'));
  readonly countryOptions = computed(() => this.options((c) => c.countries, 'country'));

  readonly maxHour = computed(() => new Map((this.report()?.caps ?? []).map((c) => [c.id, Math.max(1, ...c.hourly)])));

  async ngOnInit(): Promise<void> {
    await this.load();
    this.timer = setInterval(() => {
      if (this.report()?.isToday) void this.load();
    }, REFRESH_MS);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const report = await this.api.caps.report(this.date() || undefined);
      // Breakdowns belong to the day shown: another day drops them (loader), a refresh keeps them on screen.
      if (report.date !== this.report()?.date) this.buyerData.set(new Map());
      this.buyerErrors.set(new Map());
      this.report.set(report);
      if (!this.date()) this.date.set(report.date);
      for (const c of report.caps) {
        if (this.openBuyers.has(c.id)) void this.loadBuyers(c, this.buyersOf(c.id)?.days ?? 1);
      }
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
    } finally {
      this.loading.set(false);
    }
  }

  resetFilters(): void {
    this.networkFilter.set(ALL);
    this.countryFilter.set(ALL);
    this.nameFilter.set('');
  }

  private matches(c: CapDay, except?: 'network' | 'country'): boolean {
    const network = this.networkFilter();
    if (except !== 'network' && network !== ALL && !c.networks.includes(network)) return false;
    const country = this.countryFilter();
    if (except !== 'country' && country !== ALL && !c.countries.includes(country)) return false;
    const words = this.nameFilter().toLowerCase().split(/\s+/).filter(Boolean);
    const hay = `${c.name} ${c.note}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  }

  private options(values: (c: CapDay) => string[], except: 'network' | 'country'): { name: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const c of this.report()?.caps ?? []) {
      if (!this.matches(c, except)) continue;
      for (const v of values(c)) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const selected = except === 'network' ? this.networkFilter() : this.countryFilter();
    if (selected !== ALL && !counts.has(selected)) counts.set(selected, 0);
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  private readonly buyerData = signal(new Map<number, CapBuyers>());
  private readonly buyerErrors = signal(new Map<number, string>());

  /** Caps whose breakdown is expanded — refreshed along with the report. */
  private readonly openBuyers = new Set<number>();

  buyersOf(capId: number): CapBuyers | undefined {
    return this.buyerData().get(capId);
  }

  buyersError(capId: number): string | undefined {
    return this.buyerErrors().get(capId);
  }

  onBuyersToggle(c: CapDay, event: Event): void {
    if (!(event.target as HTMLDetailsElement).open) {
      this.openBuyers.delete(c.id);
      return;
    }
    this.openBuyers.add(c.id);
    if (!this.buyersOf(c.id)) void this.loadBuyers(c, 1);
  }

  async loadBuyers(c: CapDay, days: number): Promise<void> {
    const date = this.report()?.date ?? '';
    try {
      const data = await this.api.caps.buyers(c.id, date, days);
      if (date !== this.report()?.date) return; // the day changed meanwhile
      this.buyerData.update((m) => new Map(m).set(c.id, data));
    } catch (err) {
      this.buyerErrors.update((m) => new Map(m).set(c.id, err instanceof Error ? err.message : String(err)));
    }
  }

  async testTelegram(): Promise<void> {
    try {
      await this.api.caps.testTelegram();
      this.snack.open('Тестовое сообщение отправлено', undefined, { duration: 3000 });
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
    }
  }

  setDate(value: string): void {
    this.date.set(value);
    void this.load();
  }

  async edit(cap: CapDay | null): Promise<void> {
    const ref = this.dialog.open<CapDialog, CapDay | null, CapInput | 'deleted'>(CapDialog, {
      data: cap,
      width: '760px',
      maxWidth: '95vw',
    });
    if (await firstValueFrom(ref.afterClosed())) await this.load();
  }

  statusLabel(status: CapStatus): string {
    return { under: 'недолив', ok: 'в норме', risk: 'перельём', over: 'перелив' }[status];
  }

  barHint(c: CapDay): string {
    return c.projected === null
      ? `${c.leads} из ${c.dailyLimit}`
      : `Сейчас ${c.leads}, прогноз ${c.projected} из ${c.dailyLimit}`;
  }

  /** $1 234, or +$1 234 / −$1 234 with `signed`. */
  money(n: number, signed = false): string {
    const abs = Math.round(Math.abs(n)).toLocaleString('ru-RU');
    const sign = n < 0 ? '−' : signed && n > 0 ? '+' : '';
    return `${sign}$${abs}`;
  }

  hasMissingCost(b: CapBuyers): boolean {
    return b.rows.length > 1 && b.rows.some((r) => r.costMissing);
  }

  statusHint(r: CapBuyerRow): string {
    return `Подтверждено ${r.sales} · ждут ${r.waiting} · отклонено ${r.rejected}`;
  }

  /** Column sums; cost, profit and ROI only over buyers whose spend reached Keitaro. */
  buyerTotals(b: CapBuyers) {
    const t = { dayLeads: 0, leads: 0, sales: 0, waiting: 0, revenue: 0, pending: 0, cost: 0, paidRevenue: 0, paidPending: 0 };
    for (const r of b.rows) {
      t.dayLeads += r.dayLeads;
      t.leads += r.leads;
      t.sales += r.sales;
      t.waiting += r.waiting;
      t.revenue += r.revenue;
      t.pending += r.pending;
      if (r.costMissing) continue;
      t.cost += r.cost;
      t.paidRevenue += r.revenue;
      t.paidPending += r.pending;
    }
    const roi = (gain: number) => (t.cost > 0 ? ((gain - t.cost) / t.cost) * 100 : null);
    return { ...t, profit: t.paidRevenue - t.cost, roi: roi(t.paidRevenue), roiIfApproved: roi(t.paidRevenue + t.paidPending) };
  }

  percent(n: number, of: number): string {
    return `${Math.round((n / of) * 100)}%`;
  }

  min100(share: number): number {
    return Math.min(100, Math.max(0, share * 100));
  }

  hourHeight(c: CapDay, n: number): number {
    return (n / (this.maxHour().get(c.id) ?? 1)) * 100;
  }

  hoursLabel(h: number): string {
    return `${Math.floor(h)} ч ${String(Math.round((h % 1) * 60)).padStart(2, '0')} мин`;
  }

  time(ms: number): string {
    return new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
}

const ALL = 'all';
