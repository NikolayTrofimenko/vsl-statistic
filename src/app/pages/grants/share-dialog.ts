import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckbox, MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../core/services/api.service';
import { NONE, orNull } from '../../core/select';
import type { GrantChange, GrantGroup, GrantResult, GrantTarget, GrantTeam } from '../../../shared/api.types';

/** A target with who holds it now (Keitaro logins). */
export interface ShareTarget {
  target: GrantTarget;
  holders: string[];
}

export interface ShareDialogData {
  targets: ShareTarget[];
  /** Everyone sharable in principle (non-admin Keitaro users). */
  buyers: string[];
  /** Who the caller may tick; null — anyone. */
  shareable: string[] | null;
  /** Users who see all offers / all landings anyway. */
  fullOffers: string[];
  fullLandings: string[];
  teams: GrantTeam[];
  /** Offer groups among the targets can take a landing group along. */
  landingGroups: GrantGroup[];
}

export const KIND_LABELS: Record<GrantTarget['kind'], string> = {
  offer_group: 'группа офферов',
  offer: 'оффер',
  landing_group: 'группа лендов',
  landing: 'ленд',
};

/** all — give everything selected; none — take everything selected; keep — leave as is (mixed). */
type Pick = 'all' | 'none' | 'keep';

interface LandingPair {
  offerGroup: GrantTarget;
  on: boolean;
  landingGroupId: number | null;
}

/**
 * Tick who should hold one or several Keitaro targets (offer/landing groups,
 * single offers/landings). With several, a buyer holding only some of them is
 * shown half-ticked and left alone unless you click them: ticking gives every
 * target, unticking takes every target. Teams tick all their members at once;
 * offer groups can take their landing group along (to the newly ticked).
 */
@Component({
  selector: 'app-share-dialog',
  imports: [
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    MatTooltipModule,
  ],
  template: `
    <h2 mat-dialog-title>
      Пошарить: {{ single ? data.targets[0].target.name : data.targets.length + ' ' + plural(data.targets.length) }}
    </h2>
    <mat-dialog-content>
      @if (single) {
        <div class="kind faint">{{ kindLabel(data.targets[0].target) }} #{{ data.targets[0].target.id }}</div>
      } @else {
        <div class="targets">
          @for (t of data.targets; track t.target.kind + t.target.id) {
            <span class="chip" [matTooltip]="kindLabel(t.target) + ' #' + t.target.id + ' · есть у ' + t.holders.length">
              {{ t.target.name }}
            </span>
          }
        </div>
      }
      @if (!results()) {
        @if (teams().length) {
          <div class="section-title">Команды</div>
          <div class="teams">
            @for (t of teams(); track t.id) {
              <mat-checkbox
                [checked]="teamState(t) === 'all'"
                [indeterminate]="teamState(t) === 'some'"
                [disabled]="!teamLogins(t).length"
                (change)="toggleTeam(t, $event.checked)"
              >
                <b>{{ t.name }}</b>
                <span class="faint"> · {{ teamLogins(t).length }} чел.@if (t.leadLogin) {<span>, лид {{ t.leadLogin }}</span>}</span>
              </mat-checkbox>
            }
          </div>
        }

        <div class="section-title row">
          <span>Баеры</span>
          <mat-form-field class="search" subscriptSizing="dynamic">
            <mat-icon matPrefix>search</mat-icon>
            <input matInput [ngModel]="query()" (ngModelChange)="query.set($event)" placeholder="Логин" />
          </mat-form-field>
          <button mat-button (click)="setAll('all')">Все</button>
          <button mat-button (click)="setAll('none')">Никого</button>
          @if (!single) {
            <button mat-button (click)="resetPicks()" matTooltip="Вернуть как было">Сброс</button>
          }
        </div>
        @if (!single) {
          <div class="faint small legend">
            ☑ — есть во всех выбранных · ▣ — только в части (не трогаем, пока не кликнешь) · ☐ — нет ни в одной
          </div>
        }
        <div class="buyers">
          @for (login of shownLogins(); track login) {
            <mat-checkbox
              [checked]="isFull(login) || pickOf(login) === 'all'"
              [indeterminate]="!isFull(login) && pickOf(login) === 'keep'"
              [disabled]="isFull(login)"
              (change)="click(login, $event.source)"
              [class.changed]="changed(login)"
              [matTooltip]="hint(login)"
            >
              <span class="mono">{{ login }}</span>
              @if (isFull(login)) {
                <span class="faint"> видит всё</span>
              }
            </mat-checkbox>
          }
        </div>
        @if (othersHolding().length) {
          <div class="faint small">Ещё есть у не твоих баеров: {{ othersHolding().join(', ') }}</div>
        }

        @if (pairs().length) {
          <div class="section-title">Заодно выдать новым группы лендов</div>
          <div class="pairs">
            @for (p of pairs(); track p.offerGroup.id; let i = $index) {
              <div class="pair">
                <mat-checkbox [checked]="p.on" (change)="setPair(i, { on: $event.checked })"></mat-checkbox>
                <span class="pair-name" [title]="p.offerGroup.name">{{ p.offerGroup.name }}</span>
                <mat-icon class="faint">arrow_forward</mat-icon>
                <mat-form-field subscriptSizing="dynamic" class="pair-select">
                  <mat-select
                    [ngModel]="p.landingGroupId ?? NONE"
                    (ngModelChange)="setPair(i, { landingGroupId: orNull($event), on: orNull($event) !== null })"
                  >
                    <mat-option [value]="NONE">— не выбрана —</mat-option>
                    @for (g of landingGroups; track g.id) {
                      <mat-option [value]="g.id">{{ g.name }}</mat-option>
                    }
                  </mat-select>
                </mat-form-field>
              </div>
            }
          </div>
        }

        <div class="summary">
          @if (gives().length) {
            <span class="add">Выдать: <b class="mono">{{ gives().join(', ') }}</b></span>
          }
          @if (takes().length) {
            <span class="remove">Забрать: <b class="mono">{{ takes().join(', ') }}</b></span>
          }
          @if (!gives().length && !takes().length) {
            <span class="faint">Ничего не меняется</span>
          }
        </div>
        @if (error()) {
          <div class="error">{{ error() }}</div>
        }
      } @else {
        <ul class="results">
          @for (r of results(); track $index) {
            <li [class.error]="!r.ok">
              <span class="mono">{{ r.login }}</span> —
              {{ r.ok ? (r.note || 'готово') : (r.note ? r.note + '; ' : '') + r.error }}
            </li>
          } @empty {
            <li class="faint">Ничего не поменялось</li>
          }
        </ul>
      }
      @if (saving()) {
        <mat-progress-bar mode="indeterminate" />
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      @if (!results()) {
        <button mat-button mat-dialog-close>Отмена</button>
        <button mat-flat-button (click)="save()" [disabled]="saving() || (!gives().length && !takes().length)">
          Сохранить в Keitaro
        </button>
      } @else {
        <button mat-flat-button [mat-dialog-close]="true">Готово</button>
      }
    </mat-dialog-actions>
  `,
  styles: [
    `
      .kind {
        margin: -8px 0 8px;
        font-size: 12px;
      }
      .targets {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        max-height: 84px;
        overflow-y: auto;
        margin-bottom: 4px;
      }
      .chip {
        font-size: 12px;
        padding: 1px 6px;
        border: 1px solid var(--divider-strong);
      }
      .section-title {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-faint);
        margin: 12px 0 4px;
      }
      .section-title.row {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .search {
        width: 150px;
        margin-left: auto;
      }
      .legend {
        margin: -2px 0 4px;
      }
      .teams {
        display: flex;
        flex-wrap: wrap;
        gap: 0 16px;
      }
      .buyers {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
        max-height: 280px;
        overflow-y: auto;
        border: 1px solid var(--divider);
        padding: 4px;
      }
      .changed {
        background: var(--accent-soft);
      }
      .pairs {
        display: flex;
        flex-direction: column;
        gap: 2px;
        max-height: 200px;
        overflow-y: auto;
      }
      .pair {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .pair-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
      }
      .pair-select {
        flex: 1;
        min-width: 0;
      }
      .summary {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin-top: 12px;
        font-size: 13px;
      }
      .add b {
        color: #3f7d4e;
      }
      .remove b,
      .error {
        color: var(--danger);
      }
      .small {
        font-size: 12px;
      }
      .results {
        margin: 0;
        padding-left: 18px;
      }
    `,
  ],
})
export class ShareDialog {
  readonly data = inject<ShareDialogData>(MAT_DIALOG_DATA);
  private readonly api = inject(ApiService);

  readonly NONE = NONE;
  readonly orNull = orNull;
  readonly single = this.data.targets.length === 1;
  readonly landingGroups = this.data.landingGroups.filter((g) => g.id);

  /** Logins this dialog lets you tick. */
  private readonly own = (this.data.shareable ?? this.data.buyers).filter((l) => this.data.buyers.includes(l));
  private readonly fullOffers = new Set(this.data.fullOffers);
  private readonly fullLandings = new Set(this.data.fullLandings);
  /** Sees every target anyway: nothing to tick. */
  private readonly full = new Set(
    this.own.filter((l) => this.data.targets.every((t) => this.fullFor(l, t.target))),
  );
  private readonly initial = new Map(this.own.map((l) => [l, this.initialPick(l)]));

  readonly picks = signal(new Map(this.initial));
  readonly query = signal('');
  readonly saving = signal(false);
  readonly error = signal('');
  readonly results = signal<GrantResult[] | null>(null);
  readonly pairs = signal<LandingPair[]>(
    this.data.targets
      .filter((t) => t.target.kind === 'offer_group')
      .map((t) => {
        const id = this.guessLandingGroup(t.target.name);
        return { offerGroup: t.target, on: id !== null, landingGroupId: id };
      }),
  );

  readonly teams = computed(() => this.data.teams.filter((t) => t.members.length));
  readonly shownLogins = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.own.filter((l) => !q || l.toLowerCase().includes(q));
  });
  readonly othersHolding = computed(() => [
    ...new Set(this.data.targets.flatMap((t) => t.holders).filter((l) => !this.own.includes(l))),
  ]);

  /** Per target: who gets it and who loses it. */
  readonly changes = computed<GrantChange[]>(() => {
    const picks = this.picks();
    return this.data.targets.map((t) => ({
      target: t.target,
      add: this.own.filter((l) => picks.get(l) === 'all' && !t.holders.includes(l) && !this.fullFor(l, t.target)),
      remove: this.own.filter((l) => picks.get(l) === 'none' && t.holders.includes(l)),
    }));
  });

  readonly gives = computed(() => this.countByLogin('add'));
  readonly takes = computed(() => this.countByLogin('remove'));

  kindLabel(t: GrantTarget): string {
    return KIND_LABELS[t.kind];
  }

  plural(n: number): string {
    const d = n % 10;
    const h = n % 100;
    return d === 1 && h !== 11 ? 'позиция' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'позиции' : 'позиций';
  }

  isFull(login: string): boolean {
    return this.full.has(login);
  }

  pickOf(login: string): Pick {
    return this.picks().get(login) ?? 'none';
  }

  changed(login: string): boolean {
    return this.pickOf(login) !== this.initial.get(login);
  }

  hint(login: string): string {
    if (this.single || this.isFull(login)) return '';
    const has = this.data.targets.filter((t) => t.holders.includes(login));
    return has.length ? `Есть: ${has.map((t) => t.target.name).join(', ')}` : '';
  }

  /** Mixed → give all → take all → back to mixed (as it was). */
  click(login: string, box: MatCheckbox): void {
    const now = this.pickOf(login);
    const next: Pick = now === 'keep' ? 'all' : now === 'all' ? 'none' : this.initial.get(login) === 'keep' ? 'keep' : 'all';
    this.setPick([login], next);
    // The box flips itself on click; when the bound value doesn't change (none → mixed) it wouldn't be reset.
    box.checked = next === 'all';
    box.indeterminate = next === 'keep';
  }

  teamLogins(t: GrantTeam): string[] {
    return t.members.filter((m) => this.own.includes(m) && !this.full.has(m));
  }

  teamState(t: GrantTeam): 'all' | 'some' | 'none' {
    const logins = this.teamLogins(t);
    const n = logins.filter((l) => this.pickOf(l) === 'all').length;
    return n === 0 ? 'none' : n === logins.length ? 'all' : 'some';
  }

  toggleTeam(t: GrantTeam, on: boolean): void {
    this.setPick(this.teamLogins(t), on ? 'all' : 'none');
  }

  setAll(pick: Pick): void {
    this.setPick(this.shownLogins().filter((l) => !this.full.has(l)), pick);
  }

  resetPicks(): void {
    this.picks.set(new Map(this.initial));
  }

  setPair(i: number, patch: Partial<LandingPair>): void {
    this.pairs.update((list) => list.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }

  async save(): Promise<void> {
    this.saving.set(true);
    this.error.set('');
    try {
      const changes = this.changes().filter((c) => c.add.length || c.remove.length);
      // Landing groups go to whoever newly gets the offer group — never taken away here.
      for (const p of this.pairs()) {
        const landing = this.landingGroups.find((g) => g.id === p.landingGroupId);
        const add = changes.find((c) => c.target.kind === 'offer_group' && c.target.id === p.offerGroup.id)?.add ?? [];
        if (p.on && landing && add.length) {
          changes.push({ target: { kind: 'landing_group', id: landing.id, name: landing.name }, add, remove: [] });
        }
      }
      this.results.set(await this.api.grants.apply(changes));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.saving.set(false);
    }
  }

  private setPick(logins: string[], pick: Pick): void {
    this.picks.update((m) => {
      const next = new Map(m);
      for (const l of logins) next.set(l, pick);
      return next;
    });
  }

  /** "SER (3)" — how many targets each login gets / loses. */
  private countByLogin(side: 'add' | 'remove'): string[] {
    const n = new Map<string, number>();
    for (const c of this.changes()) for (const l of c[side]) n.set(l, (n.get(l) ?? 0) + 1);
    return [...n].map(([l, k]) => (this.single ? l : `${l} (${k})`));
  }

  private fullFor(login: string, t: GrantTarget): boolean {
    const offers = t.kind === 'offer_group' || t.kind === 'offer';
    return (offers ? this.fullOffers : this.fullLandings).has(login);
  }

  private initialPick(login: string): Pick {
    const n = this.data.targets.filter((t) => t.holders.includes(login)).length;
    return n === 0 ? 'none' : n === this.data.targets.length ? 'all' : 'keep';
  }

  /** The landing group named like the offer group, e.g. "PT Adenofrin" → "PT Adenofrin ленды". */
  private guessLandingGroup(offerGroupName: string): number | null {
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const name = norm(offerGroupName);
    if (!name) return null;
    const groups = this.data.landingGroups.filter((g) => g.id);
    const exact = groups.find((g) => norm(g.name) === name);
    if (exact) return exact.id;
    const words = name.split(' ').filter((w) => w.length > 2);
    let best: { id: number; score: number } | null = null;
    for (const g of groups) {
      const gw = norm(g.name).split(' ');
      const score = words.filter((w) => gw.includes(w)).length;
      if (score && (!best || score > best.score)) best = { id: g.id, score };
    }
    return best && best.score >= Math.min(2, words.length) ? best.id : null;
  }
}
