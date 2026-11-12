import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../core/services/api.service';
import { ConfirmService } from '../../core/services/confirm.service';
import type {
  DomainsOverview,
  RenewDecision,
  RenewResult,
  RootDomain,
  RootPatch,
  SubdomainSlot,
} from '../../../shared/api.types';
import { IssueDialog, IssueDialogData } from './issue-dialog';
import { BuyDialog, BuyDialogData } from './buy-dialog';

type View = 'work' | 'free' | 'soon' | 'expired' | 'banned' | 'service' | 'all';

/** Expiring within this many days counts as "soon". */
const SOON_DAYS = 30;
const PENDING_RETRY_MS = 8_000;

/**
 * Admin page: the domain registry that replaces Илья's sheet. Roots with
 * owner, pixel, 30 subdomain slots (issued / free / banned), expiry and the
 * renewal call; issuing subdomains to a buyer, buying a root, renewing, and
 * clearing dead roots out of Keitaro.
 */
@Component({
  selector: 'app-domains',
  imports: [
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatCheckboxModule,
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
        <h1>Домены</h1>
        <p>
          Корневые домены, кому они принадлежат и 30 поддоменов на каждом: выдан, свободен, забанен.
          Выдача создаёт запись в Cloudflare и домен в Keitaro с группой баера.
        </p>
      </div>
      <div class="actions">
        @if (data()?.balance != null) {
          <span class="balance mono" matTooltip="Баланс Namecheap">\${{ data()!.balance!.toFixed(2) }}</span>
        }
        <button mat-button (click)="load(true)" [disabled]="loading()" matTooltip="Перечитать Namecheap и Keitaro">
          <mat-icon>refresh</mat-icon><span>Обновить</span>
        </button>
        <button mat-button (click)="buy()"><mat-icon>add_shopping_cart</mat-icon><span>Купить домен</span></button>
        <button mat-flat-button (click)="issue()"><mat-icon>add_link</mat-icon><span>Выдать поддомены</span></button>
      </div>
    </header>

    @if (loading() && !data()) {
      <mat-progress-bar mode="indeterminate" />
    }
    @if (data(); as d) {
      @if (d.error) {
        <p class="banner error">{{ d.error }}</p>
      }

      <div class="toolbar">
        <mat-button-toggle-group [value]="view()" (change)="view.set($event.value)" aria-label="Какие домены">
          <mat-button-toggle value="work" matTooltip="Не забанены, не истекли, не служебные">Рабочие ({{ counts().work }})</mat-button-toggle>
          <mat-button-toggle value="free">Есть слоты ({{ counts().free }})</mat-button-toggle>
          <mat-button-toggle value="soon">Истекают ≤ {{ soonDays }} дн ({{ counts().soon }})</mat-button-toggle>
          <mat-button-toggle value="expired">Истёкшие ({{ counts().expired }})</mat-button-toggle>
          <mat-button-toggle value="banned">Бан ({{ counts().banned }})</mat-button-toggle>
          <mat-button-toggle value="service">Служебные ({{ counts().service }})</mat-button-toggle>
          <mat-button-toggle value="all">Все ({{ d.roots.length }})</mat-button-toggle>
        </mat-button-toggle-group>
        <mat-form-field class="filter" subscriptSizing="dynamic">
          <mat-label>Владелец / баер</mat-label>
          <mat-select [ngModel]="who()" (ngModelChange)="who.set($event)">
            <mat-option value="">Все</mat-option>
            @for (b of people(); track b) {
              <mat-option [value]="b">{{ b }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field class="filter" subscriptSizing="dynamic">
          <mat-icon matPrefix>search</mat-icon>
          <mat-label>Домен</mat-label>
          <input matInput [ngModel]="query()" (ngModelChange)="query.set($event)" />
        </mat-form-field>
      </div>

      @if (selected().size) {
        <div class="renew-bar">
          <span>
            Выбрано {{ selected().size }} · продление ≈ <b class="mono">\${{ selectedTotal().toFixed(2) }}</b>
            @if (d.balance !== null && selectedTotal() > d.balance) {
              <span class="warn">— больше баланса</span>
            }
          </span>
          <span class="spacer"></span>
          <button mat-button (click)="clearSelection()">Снять выбор</button>
          <button mat-flat-button [disabled]="busy()" (click)="renew()"><mat-icon>autorenew</mat-icon><span>Продлить на год</span></button>
        </div>
      }
      @if (busy()) {
        <mat-progress-bar mode="indeterminate" />
      }
      @if (renewResults().length) {
        <div class="results">
          @for (r of renewResults(); track r.domain) {
            <div [class.bad]="!r.ok">
              <span class="mono">{{ r.domain }}</span> —
              @if (r.ok) {
                продлён@if (r.charged !== null) {<span>, \${{ r.charged.toFixed(2) }}</span>}
              } @else {
                {{ r.error }}
              }
            </div>
          }
          <button mat-button (click)="renewResults.set([])">Скрыть</button>
        </div>
      }

      <div class="table-wrap">
        <table class="dtable">
          <thead>
            <tr>
              <th class="check"></th>
              <th class="left">Домен</th>
              <th class="left">Владелец</th>
              <th matTooltip="Выдано · свободно · бан (из 30)">Поддомены</th>
              <th class="left">Баеры в Keitaro</th>
              <th class="left">Истекает</th>
              <th class="left">Продлевать?</th>
              <th>Цена</th>
            </tr>
          </thead>
          <tbody>
            @for (r of shown(); track r.name) {
              <tr [class.expired]="r.expired" [class.banned]="r.banned" [class.open]="openRoot() === r.name">
                <td class="check">
                  @if (r.namecheap && !r.banned) {
                    <mat-checkbox [checked]="selected().has(r.name)" (change)="toggle(r.name, $event.checked)" />
                  }
                </td>
                <td class="left">
                  <button class="name mono" (click)="toggleOpen(r)">
                    {{ r.name }}<mat-icon>{{ openRoot() === r.name ? 'expand_less' : 'expand_more' }}</mat-icon>
                  </button>
                  @if (r.banned) {
                    <span class="tag bad">бан</span>
                  }
                  @if (r.service) {
                    <span class="tag">служебный</span>
                  }
                  @if (!r.namecheap) {
                    <span class="faint" matTooltip="Нет в аккаунте Namecheap">не в Namecheap</span>
                  }
                </td>
                <td class="left">
                  {{ r.owner ?? '—' }}
                  @if (r.team && r.team !== r.owner) {
                    <span class="faint">· {{ r.team }}</span>
                  }
                  @if (r.sharedPixel) {
                    <span class="tag" matTooltip="Общий пиксель: поддомены раздаются баерам команды">общий</span>
                  }
                </td>
                <td class="mono">
                  <span [class.alarm]="r.expired && r.subdomains" [matTooltip]="r.expired && r.subdomains ? 'Домен истёк, а поддомены ещё в Keitaro' : ''">{{ r.subdomains }}</span>
                  · <span [class.ok]="r.freeSlots">{{ r.freeSlots }}</span>
                  @if (r.bannedSubs) {
                    · <span class="bad">{{ r.bannedSubs }}</span>
                  }
                  @if (r.keitaroErrors) {
                    <span class="bad" matTooltip="Keitaro видит ошибку (не резолвится…)"> ⚠{{ r.keitaroErrors }}</span>
                  }
                </td>
                <td class="left buyers" [title]="r.buyers.join(', ')">{{ r.buyers.join(', ') || '—' }}</td>
                <td class="left">
                  @if (r.expiresAt) {
                    <span class="mono">{{ r.expiresAt }}</span>
                    <span class="days" [class.bad]="daysLeft(r) < 0" [class.soon]="daysLeft(r) >= 0 && daysLeft(r) <= soonDays">{{ daysLabel(r) }}</span>
                  } @else {
                    <span class="faint">—</span>
                  }
                </td>
                <td class="left">
                  @if (r.namecheap && !r.service) {
                    <select class="decision" [ngModel]="r.renew ?? ''" (ngModelChange)="setDecision(r, $event)" [attr.data-v]="r.renew ?? ''">
                      <option value="">—</option>
                      <option value="yes">продлевать</option>
                      <option value="no">не продлевать</option>
                      <option value="ask">спросить</option>
                    </select>
                    @if (r.renewNote) {
                      <mat-icon class="note-icon" [matTooltip]="r.renewNote">sticky_note_2</mat-icon>
                    }
                  }
                </td>
                <td class="mono">
                  @if (r.renewPrice !== null) {
                    \${{ r.renewPrice.toFixed(2) }}
                  }
                </td>
              </tr>
              @if (openRoot() === r.name) {
                <tr class="details">
                  <td></td>
                  <td colspan="7">
                    <div class="edit">
                      <label>Владелец <input class="mini mono" [value]="r.owner ?? ''" (change)="patch(r, { owner: $any($event.target).value })" [attr.list]="'people'" /></label>
                      <label>Команда <input class="mini mono" [value]="r.team ?? ''" (change)="patch(r, { team: $any($event.target).value })" /></label>
                      <mat-checkbox [checked]="r.sharedPixel" (change)="patch(r, { sharedPixel: $event.checked })">общий пиксель</mat-checkbox>
                      <mat-checkbox [checked]="r.service" (change)="patch(r, { service: $event.checked })">служебный</mat-checkbox>
                      <label class="note">Заметка <input class="mini wide" [value]="r.renewNote" (change)="patch(r, { renewNote: $any($event.target).value })" placeholder="кого спросил, что ответили" /></label>
                      <span class="spacer"></span>
                      @if (!r.banned && !r.service && !r.expired) {
                        <button mat-button (click)="transfer(r)" matTooltip="Отдать домен другому баеру и сразу выдать ему поддомены"><mat-icon>swap_horiz</mat-icon><span>Передать</span></button>
                        <button mat-button (click)="issue(r.name)" [disabled]="!r.freeSlots"><mat-icon>add_link</mat-icon><span>Выдать отсюда</span></button>
                      }
                      @if (r.subdomains && !r.service) {
                        <button mat-button (click)="cleanup(r)" matTooltip="Удалить все поддомены этого домена из Keitaro"><mat-icon>delete_sweep</mat-icon><span>Убрать из Keitaro</span></button>
                      }
                      @if (!r.service) {
                        <button mat-button class="danger" (click)="patch(r, { banned: !r.banned })">
                          <mat-icon>{{ r.banned ? 'undo' : 'block' }}</mat-icon><span>{{ r.banned ? 'Снять бан' : 'Забанен' }}</span>
                        </button>
                      }
                    </div>
                    <datalist id="people">
                      @for (b of people(); track b) {
                        <option [value]="b"></option>
                      }
                    </datalist>
                    @if (!slots()) {
                      <mat-progress-bar mode="indeterminate" />
                    } @else {
                      <div class="slots">
                        @for (s of slots()!; track s.host) {
                          <button
                            class="slot"
                            [attr.data-state]="s.state"
                            [class.extra]="s.extra"
                            [class.err]="!s.ok"
                            (click)="slotClick(s)"
                            [matTooltip]="slotHint(s)"
                          >
                            <span class="mono">{{ s.name }}</span>
                            <span class="who">{{ s.state === 'issued' ? s.buyer ?? '—' : s.state === 'banned' ? 'бан' : 'свободен' }}</span>
                          </button>
                        }
                      </div>
                      <div class="legend faint">Клик по выданному — забанить, по забаненному — снять бан.</div>
                    }
                  </td>
                </tr>
              }
            } @empty {
              <tr><td></td><td class="left faint" colspan="7">Ничего не подходит</td></tr>
            }
          </tbody>
        </table>
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
      .balance {
        font-size: 18px;
        font-weight: 600;
        margin-right: 4px;
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
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 12px;
        margin-bottom: 12px;
      }
      .filter {
        width: 190px;
      }
      .renew-bar {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 12px;
        margin-bottom: 8px;
        border: 1px solid var(--accent-border);
        background: var(--accent-soft);
      }
      .warn {
        color: var(--danger);
      }
      .spacer {
        flex: 1;
      }
      .results {
        padding: 8px 12px;
        margin-bottom: 8px;
        border: 1px solid var(--divider);
        font-size: 13px;
      }
      .table-wrap {
        overflow-x: auto;
        background: var(--surface);
        border: 1px solid var(--divider);
      }
      table.dtable {
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
          padding: 4px 8px;
          border-bottom: 1px solid var(--divider);
          white-space: nowrap;
        }
        .left {
          text-align: left;
        }
        .check {
          width: 40px;
          text-align: center;
        }
        tr.expired > td,
        tr.banned > td {
          background: var(--danger-soft);
        }
        tr.details > td {
          background: var(--surface-2);
          white-space: normal;
        }
      }
      .name {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        border: 0;
        background: none;
        padding: 0;
        color: var(--text);
        font-size: 13px;
        cursor: pointer;

        mat-icon {
          font-size: 18px;
          width: 18px;
          height: 18px;
          color: var(--text-faint);
        }
      }
      .tag {
        margin-left: 6px;
        padding: 0 5px;
        font-family: var(--font-mono);
        font-size: 10px;
        text-transform: uppercase;
        border: 1px solid var(--divider-strong);
        color: var(--text-muted);
      }
      .tag.bad {
        border-color: var(--danger);
      }
      .days {
        margin-left: 6px;
        font-size: 12px;
        color: var(--text-muted);
      }
      .days.soon {
        color: #b07a1f;
      }
      .bad {
        color: var(--danger);
      }
      .ok {
        color: #3f7d4e;
        font-weight: 600;
      }
      .alarm {
        color: var(--danger);
        font-weight: 600;
      }
      .buyers {
        max-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .faint {
        color: var(--text-faint);
      }
      .decision {
        font: inherit;
        font-size: 12px;
        padding: 2px 4px;
        background: var(--surface);
        color: var(--text);
        border: 1px solid var(--divider-strong);
      }
      .decision[data-v='no'] {
        color: var(--danger);
      }
      .decision[data-v='yes'] {
        color: #3f7d4e;
      }
      .decision[data-v='ask'] {
        color: #b07a1f;
      }
      .note-icon {
        font-size: 16px;
        width: 16px;
        height: 16px;
        vertical-align: middle;
        color: var(--text-muted);
      }
      .edit {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px 14px;
        padding: 8px 0;
        font-size: 12px;
        color: var(--text-muted);
      }
      .mini {
        width: 90px;
        margin-left: 4px;
        padding: 3px 6px;
        font-size: 12px;
        background: var(--surface);
        color: var(--text);
        border: 1px solid var(--divider-strong);
      }
      .mini.wide {
        width: 260px;
      }
      .danger {
        color: var(--danger);
      }
      .slots {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
        gap: 4px;
        padding: 4px 0 6px;
      }
      .slot {
        display: flex;
        justify-content: space-between;
        gap: 6px;
        padding: 4px 6px;
        font-size: 12px;
        text-align: left;
        border: 1px solid var(--divider);
        background: var(--surface);
        color: var(--text);
        cursor: pointer;
      }
      .slot[data-state='issued'] {
        background: rgba(214, 178, 40, 0.18);
        border-color: rgba(214, 178, 40, 0.5);
      }
      .slot[data-state='banned'] {
        background: var(--danger-soft);
        border-color: var(--danger);
        color: var(--danger);
      }
      .slot[data-state='free'] {
        color: var(--text-faint);
        cursor: default;
      }
      .slot.extra {
        border-style: dashed;
      }
      .slot.err .who::after {
        content: ' ⚠';
        color: var(--danger);
      }
      .who {
        color: var(--text-muted);
      }
      .legend {
        font-size: 11px;
        padding-bottom: 6px;
      }
    `,
  ],
})
export class DomainsPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly ask = inject(ConfirmService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);

  readonly data = signal<DomainsOverview | null>(null);
  readonly buyers = signal<string[]>([]);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly renewResults = signal<RenewResult[]>([]);
  readonly selected = signal(new Set<string>());
  readonly view = signal<View>('work');
  readonly who = signal('');
  readonly query = signal('');
  readonly openRoot = signal<string | null>(null);
  readonly slots = signal<SubdomainSlot[] | null>(null);
  readonly soonDays = SOON_DAYS;

  /** Owners and buyers — for the filter and the owner field. */
  readonly people = computed(() => {
    const set = new Set(this.buyers());
    for (const r of this.data()?.roots ?? []) {
      for (const o of (r.owner ?? '').split('/')) if (o) set.add(o);
      for (const b of r.buyers) set.add(b);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  });

  readonly counts = computed(() => {
    const roots = this.data()?.roots ?? [];
    const n = (v: View) => roots.filter((r) => this.inView(r, v)).length;
    return { work: n('work'), free: n('free'), soon: n('soon'), expired: n('expired'), banned: n('banned'), service: n('service') };
  });

  readonly shown = computed(() => {
    const words = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    const who = this.who();
    const view = this.view();
    return (this.data()?.roots ?? []).filter((r) => {
      if (!this.inView(r, view)) return false;
      if (who && !(r.owner ?? '').split('/').includes(who) && !r.buyers.includes(who)) return false;
      return words.every((w) => r.name.includes(w));
    });
  });

  readonly selectedTotal = computed(() => {
    const byName = new Map((this.data()?.roots ?? []).map((r) => [r.name, r]));
    return [...this.selected()].reduce((sum, name) => sum + (byName.get(name)?.renewPrice ?? 0), 0);
  });

  async ngOnInit(): Promise<void> {
    await this.load(false);
    this.api.domains.buyers().then((b) => this.buyers.set(b)).catch(() => undefined);
  }

  async load(fresh: boolean): Promise<void> {
    this.loading.set(true);
    try {
      const data = await this.api.domains.overview(fresh);
      this.data.set(data);
      // Balance and prices arrive a few seconds later after a server restart.
      if (data.pending) setTimeout(() => void this.load(false), PENDING_RETRY_MS);
      const open = this.openRoot();
      if (open) await this.loadSlots(open);
    } catch (err) {
      this.toast(err);
    } finally {
      this.loading.set(false);
    }
  }

  /* ------------------------- views ------------------------- */

  daysLeft(r: RootDomain): number {
    if (!r.expiresAt) return Number.POSITIVE_INFINITY;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return Math.round((new Date(`${r.expiresAt}T00:00:00`).getTime() - today) / 86_400_000);
  }

  daysLabel(r: RootDomain): string {
    const d = this.daysLeft(r);
    if (d < 0) return `истёк ${-d} дн назад`;
    if (d === 0) return 'сегодня';
    return `через ${d} дн`;
  }

  slotHint(s: SubdomainSlot): string {
    const parts = [s.host];
    if (s.campaign) parts.push(`кампания: ${s.campaign}`);
    if (s.createdAt) parts.push(`заведён ${s.createdAt.slice(0, 10)}`);
    if (s.error) parts.push(s.error);
    if (s.extra) parts.push('не из 30 стандартных');
    return parts.join(' · ');
  }

  /* ------------------------- actions ------------------------- */

  toggle(name: string, on: boolean): void {
    const next = new Set(this.selected());
    if (on) next.add(name);
    else next.delete(name);
    this.selected.set(next);
  }

  clearSelection(): void {
    this.selected.set(new Set());
  }

  async toggleOpen(r: RootDomain): Promise<void> {
    if (this.openRoot() === r.name) {
      this.openRoot.set(null);
      return;
    }
    this.openRoot.set(r.name);
    await this.loadSlots(r.name);
  }

  async setDecision(r: RootDomain, value: string): Promise<void> {
    await this.patch(r, { renew: (value || null) as RenewDecision | null });
  }

  async patch(r: RootDomain, patch: RootPatch): Promise<void> {
    try {
      await this.api.domains.update(r.name, patch);
      this.patchLocal(r.name, {
        ...(patch.owner !== undefined ? { owner: patch.owner?.trim().toUpperCase() || null } : {}),
        ...(patch.team !== undefined ? { team: patch.team?.trim().toUpperCase() || null } : {}),
        ...(patch.sharedPixel !== undefined ? { sharedPixel: patch.sharedPixel } : {}),
        ...(patch.service !== undefined ? { service: patch.service } : {}),
        ...(patch.banned !== undefined ? { banned: patch.banned, freeSlots: patch.banned ? 0 : r.freeSlots } : {}),
        ...(patch.renew !== undefined ? { renew: patch.renew } : {}),
        ...(patch.renewNote !== undefined ? { renewNote: patch.renewNote } : {}),
      });
      if (patch.banned === false) await this.load(true);
    } catch (err) {
      this.toast(err);
    }
  }

  async slotClick(s: SubdomainSlot): Promise<void> {
    if (s.state === 'free') return;
    const banning = s.state === 'issued';
    let remove = false;
    if (banning) {
      const answer = await this.ask.open({
        title: `${s.host} забанен?`,
        message: 'Слот больше не будет выдаваться.',
        check: { label: 'Сразу удалить его из Keitaro', value: true },
        ok: 'Забанен',
        danger: true,
      });
      if (!answer) return;
      remove = answer.checked;
    } else if (!(await this.ask.confirm({ title: `Снять бан с ${s.host}?`, message: 'Слот снова можно будет выдать.', ok: 'Снять бан' }))) {
      return;
    }
    try {
      await this.api.domains.banSub(s.host, banning, remove);
      await this.load(remove);
    } catch (err) {
      this.toast(err);
    }
  }

  async cleanup(r: RootDomain): Promise<void> {
    const sure = await this.ask.confirm({
      title: `Убрать ${r.name} из Keitaro?`,
      message: `Удалятся все его поддомены (${r.subdomains}) — ссылки на них перестанут работать.`,
      ok: 'Убрать',
      danger: true,
    });
    if (!sure) return;
    this.busy.set(true);
    try {
      const { removed } = await this.api.domains.cleanup(r.name);
      this.snack.open(`Убрано из Keitaro: ${removed}`, undefined, { duration: 4000 });
      await this.load(true);
    } catch (err) {
      this.toast(err);
    } finally {
      this.busy.set(false);
    }
  }

  async renew(): Promise<void> {
    const names = [...this.selected()];
    const sure = await this.ask.confirm({
      title: `Продлить на год: ${names.length} дом.`,
      message: `Примерно $${this.selectedTotal().toFixed(2)} с баланса Namecheap.\n\n${names.join('\n')}`,
      ok: 'Продлить',
      danger: true,
    });
    if (!sure) return;
    this.busy.set(true);
    try {
      const results = await this.api.domains.renew(names);
      this.renewResults.set(results);
      this.selected.set(new Set(results.filter((r) => !r.ok).map((r) => r.domain)));
      await this.load(true);
    } catch (err) {
      this.toast(err);
    } finally {
      this.busy.set(false);
    }
  }

  /** Hand the root to another buyer, then offer to issue them subdomains on it. */
  async transfer(r: RootDomain): Promise<void> {
    const answer = await this.ask.open({
      title: `Передать ${r.name}`,
      message: `Сейчас домен у ${r.owner ?? 'никого'}. Свободно слотов: ${r.freeSlots} из 30.`,
      input: {
        label: 'Новый владелец (код баера)',
        placeholder: 'ASK',
        upper: true,
        suggestions: this.people().filter((p) => p !== r.owner),
      },
      check: r.freeSlots ? { label: 'Сразу выдать ему поддомены', value: true } : undefined,
      ok: 'Передать',
    });
    if (!answer) return;
    const to = answer.value.toUpperCase();
    await this.patch(r, { owner: to });
    if (answer.checked) await this.issue(r.name, to);
  }

  async issue(root?: string, buyer?: string): Promise<void> {
    const d = this.data();
    if (!d) return;
    const ref = this.dialog.open<IssueDialog, IssueDialogData, boolean>(IssueDialog, {
      data: { roots: d.roots, buyers: this.people(), root, buyer },
      width: '640px',
      maxWidth: '95vw',
    });
    if (await firstValueFrom(ref.afterClosed())) await this.load(true);
  }

  async buy(): Promise<void> {
    const ref = this.dialog.open<BuyDialog, BuyDialogData, boolean>(BuyDialog, {
      data: { buyers: this.people(), balance: this.data()?.balance ?? null },
      width: '640px',
      maxWidth: '95vw',
    });
    if (await firstValueFrom(ref.afterClosed())) await this.load(true);
  }

  /* ------------------------- internals ------------------------- */

  private inView(r: RootDomain, view: View): boolean {
    switch (view) {
      case 'work':
        return !r.service && !r.banned && !r.expired;
      case 'free':
        return r.namecheap && !r.service && !r.banned && !r.expired && r.freeSlots > 0 && r.dns !== 'namecheap';
      case 'soon':
        return r.namecheap && !r.service && this.daysLeft(r) >= 0 && this.daysLeft(r) <= SOON_DAYS;
      case 'expired':
        return r.expired;
      case 'banned':
        return r.banned;
      case 'service':
        return r.service;
      default:
        return true;
    }
  }

  private async loadSlots(root: string): Promise<void> {
    this.slots.set(null);
    try {
      const slots = await this.api.domains.subdomains(root);
      if (this.openRoot() === root) this.slots.set(slots);
    } catch (err) {
      this.toast(err);
    }
  }

  private patchLocal(name: string, patch: Partial<RootDomain>): void {
    const d = this.data();
    if (d) this.data.set({ ...d, roots: d.roots.map((r) => (r.name === name ? { ...r, ...patch } : r)) });
  }

  private toast(err: unknown): void {
    this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
  }
}
