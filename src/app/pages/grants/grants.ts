import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
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
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../core/services/api.service';
import { ConfirmService } from '../../core/services/confirm.service';
import type {
  GrantGroup,
  GrantItem,
  GrantKind,
  GrantLogEntry,
  GrantsOverview,
  GrantTarget,
  GrantTeam,
} from '../../../shared/api.types';
import { KIND_LABELS, ShareDialog, ShareDialogData } from './share-dialog';
import { TeamDialog, TeamDialogData } from './team-dialog';

type View = 'offers' | 'landings' | 'teams' | 'log';

/**
 * "Доступы": which Keitaro users see which offer and landing groups. A new
 * offer group is shared in one dialog — tick a team or buyers — instead of
 * editing every buyer in Keitaro. The head of buying sees and shares to
 * everyone; a team lead — only to the teams they lead.
 */
@Component({
  selector: 'app-grants',
  imports: [
    DatePipe,
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatTooltipModule,
  ],
  template: `
    <header class="page-header">
      <div>
        <h1>Доступы</h1>
        <p>
          Кто из баеров видит какие офферы и ленды в Keitaro. Нашёл новую группу — «Пошарить» и галочками
          отметь команду или баеров; права в Keitaro поменяются сразу.
          @if (data() && !data()!.head) {
            Ты раздаёшь доступ только своим командам.
          }
        </p>
      </div>
      <div class="actions">
        <button mat-button (click)="load()" [disabled]="loading()" matTooltip="Перечитать Keitaro">
          <mat-icon>refresh</mat-icon><span>Обновить</span>
        </button>
        <button mat-flat-button (click)="editTeam(null)"><mat-icon>group_add</mat-icon><span>Команда</span></button>
      </div>
    </header>

    <div class="toolbar">
      <mat-button-toggle-group [value]="view()" (change)="setView($event.value)" hideSingleSelectionIndicator>
        <mat-button-toggle value="offers">Офферы</mat-button-toggle>
        <mat-button-toggle value="landings">Ленды</mat-button-toggle>
        <mat-button-toggle value="teams">Команды · {{ data()?.teams?.length ?? 0 }}</mat-button-toggle>
        <mat-button-toggle value="log">Журнал</mat-button-toggle>
      </mat-button-toggle-group>
      @if (view() === 'offers' || view() === 'landings') {
        <mat-form-field class="search" subscriptSizing="dynamic">
          <mat-icon matPrefix>search</mat-icon>
          <mat-label>Группа, оффер или баер</mat-label>
          <input matInput [ngModel]="query()" (ngModelChange)="query.set($event)" />
        </mat-form-field>
        <mat-button-toggle-group [value]="sort()" (change)="sort.set($event.value)" hideSingleSelectionIndicator class="sort">
          <mat-button-toggle value="created" matTooltip="По дате создания группы в Keitaro">Новые группы</mat-button-toggle>
          <mat-button-toggle value="updated" matTooltip="Куда последним добавили оффер">Недавно пополненные</mat-button-toggle>
          <mat-button-toggle value="name">А–Я</mat-button-toggle>
        </mat-button-toggle-group>
        <mat-checkbox [ngModel]="onlyFresh()" (ngModelChange)="onlyFresh.set($event)">Только никому не выданные</mat-checkbox>
      }
    </div>

    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }
    @if (error()) {
      <div class="banner error">{{ error() }}</div>
    }

    @if (data(); as d) {
      @switch (view()) {
        @case ('teams') {
          <div class="teams">
            @for (t of d.teams; track t.id) {
              <article class="team">
                <div class="team-head">
                  <b>{{ t.name }}</b>
                  <span class="faint">{{ t.leadLogin ? 'лид ' + t.leadLogin : 'без тимлида' }}</span>
                  <span class="spacer"></span>
                  <button mat-icon-button (click)="editTeam(t)" matTooltip="Изменить"><mat-icon>edit</mat-icon></button>
                  <button mat-icon-button (click)="deleteTeam(t)" matTooltip="Удалить команду"><mat-icon>delete</mat-icon></button>
                </div>
                <div class="chips">
                  @for (m of t.members; track m) {
                    <span class="chip mono" [class.gone]="!d.buyers.includes(m)" [matTooltip]="d.buyers.includes(m) ? '' : 'Нет в Keitaro'">{{ m }}</span>
                  } @empty {
                    <span class="faint">Пока никого</span>
                  }
                </div>
              </article>
            } @empty {
              <p class="faint">
                Команд нет. Создай, например, «NLM» с тимлидом и его баерами — потом шарить на всю команду одной галочкой.
              </p>
            }
          </div>
        }
        @case ('log') {
          <table class="log">
            <thead>
              <tr><th>Когда</th><th>Кто</th><th>Что</th><th>Выдано</th><th>Забрано</th><th>Ошибки</th></tr>
            </thead>
            <tbody>
              @for (b of batches(); track b.id) {
                <tr [class.batch]="b.rows.length > 1" (click)="b.rows.length > 1 && toggleBatch(b.id)">
                  <td class="mono nowrap">{{ b.at | date: 'dd.MM HH:mm' }}</td>
                  <td>{{ b.by ?? '—' }}</td>
                  <td>
                    @if (b.rows.length === 1) {
                      <span class="faint">{{ kindLabel(b.rows[0].kind) }}</span> {{ b.rows[0].targetName }}
                    } @else {
                      <mat-icon class="chev small-icon">{{ openBatches().has(b.id) ? 'expand_more' : 'chevron_right' }}</mat-icon>
                      {{ b.rows.length }} позиц.: <span class="faint">{{ b.preview }}</span>
                    }
                  </td>
                  <td class="mono add">{{ b.added.join(', ') }}</td>
                  <td class="mono remove">{{ b.removed.join(', ') }}</td>
                  <td class="mono remove">{{ b.failed.join(', ') }}</td>
                </tr>
                @if (b.rows.length > 1 && openBatches().has(b.id)) {
                  @for (e of b.rows; track e.id) {
                    <tr class="sub">
                      <td></td>
                      <td></td>
                      <td><span class="faint">{{ kindLabel(e.kind) }}</span> {{ e.targetName }}</td>
                      <td class="mono add">{{ e.added.join(', ') }}</td>
                      <td class="mono remove">{{ e.removed.join(', ') }}</td>
                      <td class="mono remove">{{ e.failed.join(', ') }}</td>
                    </tr>
                  }
                }
              } @empty {
                <tr><td colspan="6" class="faint">Пока ничего не раздавали</td></tr>
              }
            </tbody>
          </table>
        }
        @default {
          <div class="list-head">
            <mat-checkbox
              [checked]="allShownPicked()"
              [indeterminate]="someShownPicked()"
              (change)="pickShown($event.checked)"
            >
              Выбрать все группы в списке ({{ shownGroups().length }})
            </mat-checkbox>
          </div>
          <div class="groups">
            @for (g of shownGroups(); track g.id) {
              <section class="group" [class.open]="isOpen(g)">
                <div class="group-row" (click)="toggleOpen(g)">
                  @if (g.id) {
                    <mat-checkbox
                      class="pick"
                      [checked]="isPicked(groupKind(), g.id)"
                      (click)="$event.stopPropagation()"
                      (change)="pick(groupKind(), g, $event.checked)"
                    />
                  } @else {
                    <span class="pick-gap"></span>
                  }
                  <mat-icon class="chev">{{ isOpen(g) ? 'expand_more' : 'chevron_right' }}</mat-icon>
                  <span class="gname">{{ g.name }}</span>
                  <span class="faint count">{{ g.items.length }} {{ view() === 'offers' ? 'офф.' : 'ленд.' }}</span>
                  @if (g.id) {
                    @if (g.holders.length) {
                      <span class="holders" [matTooltip]="g.holders.join(', ')">
                        {{ holdersLabel(g.holders) }}
                      </span>
                    } @else {
                      <span class="fresh">никому не выдана</span>
                    }
                    <span class="spacer"></span>
                    <button mat-stroked-button (click)="$event.stopPropagation(); shareGroup(g)">
                      <mat-icon>share</mat-icon><span>Пошарить группу</span>
                    </button>
                  } @else {
                    <span class="faint">шарятся только по одному</span>
                  }
                </div>
                @if (isOpen(g)) {
                  <table class="items">
                    <tbody>
                      @for (i of g.items; track i.id) {
                        <tr [class.archived]="i.archived" [class.picked]="isPicked(itemKind(), i.id)">
                          <td class="pick-cell">
                            <mat-checkbox [checked]="isPicked(itemKind(), i.id)" (change)="pick(itemKind(), i, $event.checked)" />
                          </td>
                          <td class="mono faint id">#{{ i.id }}</td>
                          <td>{{ i.name }}@if (i.archived) {<span class="faint"> · архив</span>}</td>
                          <td class="item-holders" [matTooltip]="i.holders.join(', ')">
                            @if (i.holders.length) {
                              + отдельно: {{ holdersLabel(i.holders) }}
                            }
                          </td>
                          <td class="right">
                            <button mat-button (click)="shareItem(g, i)"><mat-icon>share</mat-icon><span>Пошарить</span></button>
                          </td>
                        </tr>
                      } @empty {
                        <tr><td class="faint" colspan="5">Пусто</td></tr>
                      }
                    </tbody>
                  </table>
                }
              </section>
            } @empty {
              <p class="faint">Ничего не нашлось</p>
            }
          </div>
        }
      }
    }

    @if (selected().length) {
      <div class="pick-bar">
        <span><b>Выбрано:</b> {{ selectionLabel() }}</span>
        <span class="spacer"></span>
        <button mat-button (click)="clearPicks()">Сбросить</button>
        <button mat-flat-button (click)="shareSelected()"><mat-icon>share</mat-icon><span>Пошарить выбранные</span></button>
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
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 16px;
        margin-bottom: 12px;
      }
      .search {
        width: 280px;
      }
      .sort {
        font-size: 13px;
      }
      .banner.error {
        padding: 10px 14px;
        border: 1px solid var(--danger);
        color: var(--danger);
        margin-bottom: 12px;
      }
      .groups {
        border-top: 1px solid var(--divider);
      }
      .group {
        border-bottom: 1px solid var(--divider);
      }
      .group.open {
        background: var(--surface-2);
      }
      .group-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 8px;
        cursor: pointer;
        min-height: 44px;
      }
      .group-row:hover {
        background: var(--accent-soft);
      }
      .chev {
        color: var(--text-faint);
      }
      .gname {
        font-weight: 600;
      }
      .count {
        font-size: 12px;
      }
      .holders {
        font-size: 12px;
        color: var(--text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 50%;
      }
      .fresh {
        font-size: 11px;
        padding: 1px 8px;
        border: 1px solid var(--accent-border);
        background: var(--accent-soft);
        color: var(--accent-text);
      }
      .spacer {
        flex: 1;
      }
      .items {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
        margin: 0 0 6px;

        td {
          padding: 2px 8px;
          border-top: 1px solid var(--divider);
        }
        td.id {
          width: 60px;
          padding-left: 42px;
        }
        .right {
          text-align: right;
          width: 140px;
        }
      }
      .item-holders {
        font-size: 12px;
        color: var(--text-muted);
      }
      tr.archived {
        opacity: 0.55;
      }
      .teams {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        gap: 12px;
      }
      .team {
        border: 1px solid var(--divider);
        padding: 8px 12px 12px;
      }
      .team-head {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 4px;
      }
      .chip {
        font-size: 12px;
        padding: 1px 6px;
        border: 1px solid var(--divider-strong);
      }
      .chip.gone {
        text-decoration: line-through;
        color: var(--text-faint);
      }
      .log {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;

        th {
          text-align: left;
          font-weight: 400;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--text-faint);
          padding: 4px 8px;
          border-bottom: 1px solid var(--divider-strong);
        }
        td {
          padding: 4px 8px;
          border-bottom: 1px solid var(--divider);
          vertical-align: top;
        }
      }
      .nowrap {
        white-space: nowrap;
      }
      .log tr.batch {
        cursor: pointer;
      }
      .log tr.batch:hover td {
        background: var(--accent-soft);
      }
      .log tr.sub td {
        font-size: 12px;
        border-bottom-style: dashed;
      }
      .small-icon {
        font-size: 18px;
        width: 18px;
        height: 18px;
        vertical-align: -4px;
      }
      .list-head {
        padding: 2px 8px;
        font-size: 13px;
      }
      .pick-gap {
        width: 40px;
        flex: none;
      }
      .items .pick-cell {
        width: 40px;
        padding-left: 34px;
      }
      .items td.id {
        padding-left: 4px;
      }
      tr.picked td {
        background: var(--accent-soft);
      }
      .pick-bar {
        position: sticky;
        bottom: 0;
        z-index: 2;
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 12px;
        padding: 8px 12px;
        background: var(--surface-3);
        border: 1px solid var(--accent-border);
        box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.25);
      }
      .add {
        color: #3f7d4e;
      }
      .remove {
        color: var(--danger);
      }
    `,
  ],
})
export class GrantsPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MatDialog);
  private readonly ask = inject(ConfirmService);
  private readonly snack = inject(MatSnackBar);

  readonly data = signal<GrantsOverview | null>(null);
  readonly log = signal<GrantLogEntry[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly view = signal<View>('offers');
  readonly query = signal('');
  readonly onlyFresh = signal(false);
  readonly sort = signal<'created' | 'updated' | 'name'>('created');
  private readonly opened = signal(new Set<string>());
  /** Picked targets by "kind:id", kept across the Офферы/Ленды tabs. */
  private readonly picks = signal(new Map<string, GrantTarget>());
  readonly selected = computed(() => [...this.picks().values()]);
  readonly openBatches = signal(new Set<number>());

  readonly groupKind = computed<GrantKind>(() => (this.view() === 'landings' ? 'landing_group' : 'offer_group'));
  readonly itemKind = computed<GrantKind>(() => (this.view() === 'landings' ? 'landing' : 'offer'));

  readonly allShownPicked = computed(() => {
    const groups = this.shownGroups().filter((g) => g.id);
    return groups.length > 0 && groups.every((g) => this.isPicked(this.groupKind(), g.id));
  });
  readonly someShownPicked = computed(
    () => !this.allShownPicked() && this.shownGroups().some((g) => g.id && this.isPicked(this.groupKind(), g.id)),
  );

  readonly selectionLabel = computed(() => {
    const n = (kind: GrantKind) => this.selected().filter((t) => t.kind === kind).length;
    return [
      [n('offer_group'), 'гр. офферов'],
      [n('offer'), 'офферов'],
      [n('landing_group'), 'гр. лендов'],
      [n('landing'), 'лендов'],
    ]
      .filter(([k]) => k)
      .map(([k, label]) => `${k} ${label}`)
      .join(', ');
  });

  /** Log rows folded into shares. */
  readonly batches = computed(() => {
    const out: { id: number; at: number; by: string | null; rows: GrantLogEntry[]; preview: string; added: string[]; removed: string[]; failed: string[] }[] = [];
    for (const e of this.log()) {
      let b = out.at(-1);
      if (!b || b.id !== e.batchId) out.push((b = { id: e.batchId, at: e.at, by: e.by, rows: [], preview: '', added: [], removed: [], failed: [] }));
      b.rows.push(e);
    }
    const uniq = (list: string[]) => [...new Set(list)].sort();
    for (const b of out) {
      b.preview = b.rows.slice(0, 3).map((r) => r.targetName).join(', ') + (b.rows.length > 3 ? '…' : '');
      b.added = uniq(b.rows.flatMap((r) => r.added));
      b.removed = uniq(b.rows.flatMap((r) => r.removed));
      b.failed = uniq(b.rows.flatMap((r) => r.failed));
    }
    return out;
  });

  readonly shownGroups = computed(() => {
    const d = this.data();
    if (!d) return [];
    const groups = this.view() === 'landings' ? d.landingGroups : d.offerGroups;
    const q = this.query().trim().toLowerCase();
    // Keitaro ids only grow, so the id is the creation order; loose items stay last.
    const newestItem = (g: GrantGroup) => Math.max(0, ...g.items.map((i) => i.id));
    const sorted = [...groups].sort((a, b) => {
      if (!a.id || !b.id) return a.id ? -1 : b.id ? 1 : 0;
      const by = this.sort();
      if (by === 'name') return a.name.localeCompare(b.name, 'ru');
      return by === 'created' ? b.id - a.id : newestItem(b) - newestItem(a);
    });
    return sorted.filter((g) => {
      if (this.onlyFresh() && (!g.id || g.holders.length)) return false;
      if (!q) return true;
      return (
        g.name.toLowerCase().includes(q) ||
        g.holders.some((h) => h.toLowerCase() === q) ||
        g.items.some((i) => i.name.toLowerCase().includes(q) || String(i.id) === q)
      );
    });
  });

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      this.data.set(await this.api.grants.overview());
      if (this.view() === 'log') await this.loadLog();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  async setView(view: View): Promise<void> {
    this.view.set(view);
    if (view === 'log') await this.loadLog();
  }

  private async loadLog(): Promise<void> {
    try {
      this.log.set(await this.api.grants.log());
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
    }
  }

  isOpen(g: GrantGroup): boolean {
    return this.opened().has(`${this.view()}:${g.id}`) || (this.query().trim().length > 1 && this.matchesItem(g));
  }

  toggleOpen(g: GrantGroup): void {
    const key = `${this.view()}:${g.id}`;
    this.opened.update((s) => {
      const next = new Set(s);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  private matchesItem(g: GrantGroup): boolean {
    const q = this.query().trim().toLowerCase();
    return g.items.some((i) => i.name.toLowerCase().includes(q));
  }

  holdersLabel(holders: string[]): string {
    return holders.length <= 6 ? holders.join(', ') : `${holders.slice(0, 5).join(', ')} и ещё ${holders.length - 5}`;
  }

  kindLabel(kind: GrantKind): string {
    return KIND_LABELS[kind];
  }

  shareGroup(g: GrantGroup): Promise<void> {
    return this.share([{ kind: this.groupKind(), id: g.id, name: g.name }]);
  }

  shareItem(g: GrantGroup, i: GrantItem): Promise<void> {
    return this.share([{ kind: this.itemKind(), id: i.id, name: i.name }]);
  }

  shareSelected(): Promise<void> {
    return this.share(this.selected(), true);
  }

  isPicked(kind: GrantKind, id: number): boolean {
    return this.picks().has(`${kind}:${id}`);
  }

  pick(kind: GrantKind, x: { id: number; name: string }, on: boolean): void {
    this.setPicks([{ kind, id: x.id, name: x.name }], on);
  }

  pickShown(on: boolean): void {
    const kind = this.groupKind();
    this.setPicks(this.shownGroups().filter((g) => g.id).map((g) => ({ kind, id: g.id, name: g.name })), on);
  }

  clearPicks(): void {
    this.picks.set(new Map());
  }

  toggleBatch(id: number): void {
    this.openBatches.update((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  private setPicks(targets: GrantTarget[], on: boolean): void {
    this.picks.update((m) => {
      const next = new Map(m);
      for (const t of targets) on ? next.set(`${t.kind}:${t.id}`, t) : next.delete(`${t.kind}:${t.id}`);
      return next;
    });
  }

  /** Current holders of a target, from the last overview. */
  private holdersOf(t: GrantTarget): string[] {
    const d = this.data();
    if (!d) return [];
    const groups = t.kind === 'offer_group' || t.kind === 'offer' ? d.offerGroups : d.landingGroups;
    if (t.kind === 'offer_group' || t.kind === 'landing_group') return groups.find((g) => g.id === t.id)?.holders ?? [];
    for (const g of groups) {
      const item = g.items.find((i) => i.id === t.id);
      if (item) return item.holders;
    }
    return [];
  }

  private async share(targets: GrantTarget[], fromSelection = false): Promise<void> {
    const d = this.data();
    if (!d || !targets.length) return;
    const ref = this.dialog.open<ShareDialog, ShareDialogData>(ShareDialog, {
      width: '720px',
      maxWidth: '96vw',
      data: {
        targets: targets.map((target) => ({ target, holders: this.holdersOf(target) })),
        buyers: d.buyers,
        shareable: d.shareable,
        fullOffers: d.fullOffers,
        fullLandings: d.fullLandings,
        teams: d.teams,
        landingGroups: d.landingGroups,
      },
    });
    const dialog = ref.componentInstance;
    await firstValueFrom(ref.afterClosed());
    if (dialog.results()) {
      if (fromSelection) this.clearPicks();
      await this.load();
    }
  }

  async editTeam(team: GrantTeam | null): Promise<void> {
    const d = this.data();
    if (!d) return;
    const ref = this.dialog.open<TeamDialog, TeamDialogData, GrantTeam>(TeamDialog, {
      width: '600px',
      maxWidth: '96vw',
      data: { team, buyers: d.buyers, head: d.head, leads: d.leads },
    });
    if (await firstValueFrom(ref.afterClosed())) {
      await this.load();
      this.view.set('teams');
    }
  }

  async deleteTeam(team: GrantTeam): Promise<void> {
    const sure = await this.ask.confirm({
      title: `Удалить команду ${team.name}?`,
      message: 'Права баеров в Keitaro не изменятся — пропадёт только сама команда.',
      ok: 'Удалить',
    });
    if (!sure) return;
    try {
      await this.api.grants.deleteTeam(team.id);
      await this.load();
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
    }
  }
}
