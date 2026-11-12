import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { ApiService } from '../../core/services/api.service';
import { ConfirmService } from '../../core/services/confirm.service';
import type { CapDay, CapInput, CapRule, KeitaroOffer } from '../../../shared/api.types';
import { matchesRule } from '../../../shared/caps-rule';
import { NONE, orNull } from '../../core/select';

/**
 * Create or edit a cap: name, daily limit, and the Keitaro offers whose leads
 * count towards it — by rule (partner + geo + name words; offers added later
 * join by themselves, unticked ones are excluded) or picked by hand. Offers
 * are listed by their Keitaro group; a whole group can be ticked at once.
 */
@Component({
  selector: 'app-cap-dialog',
  imports: [
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    MatSlideToggleModule,
  ],
  template: `
    <h2 mat-dialog-title>{{ data ? 'Капа «' + data.name + '»' : 'Новая капа' }}</h2>
    <mat-dialog-content>
      <div class="fields">
        <mat-form-field class="name">
          <mat-label>Название</mat-label>
          <input matInput [(ngModel)]="name" placeholder="Proman · IN" maxlength="80" />
        </mat-form-field>
        <mat-form-field class="limit">
          <mat-label>Лимит лидов в сутки (МСК)</mat-label>
          <input matInput type="number" min="1" [(ngModel)]="limit" />
        </mat-form-field>
        <mat-form-field class="note">
          <mat-label>Заметка</mat-label>
          <input matInput [(ngModel)]="note" maxlength="500" placeholder="Кто выставил, с какого числа…" />
        </mat-form-field>
        <mat-slide-toggle [(ngModel)]="active">Активна</mat-slide-toggle>
      </div>

      <div class="offers-head">
        <mat-button-toggle-group [value]="mode()" (change)="mode.set($event.value)" aria-label="Как выбирать офферы">
          <mat-button-toggle value="rule">По правилу</mat-button-toggle>
          <mat-button-toggle value="manual">Вручную</mat-button-toggle>
        </mat-button-toggle-group>
        <span class="faint">
          @if (mode() === 'rule') {
            Все офферы партнёрки под условия — и новые тоже, сами. Снятая галка исключает оффер.
          } @else {
            Только отмеченные офферы. Новые офферы сами не добавятся.
          }
        </span>
      </div>

      @if (mode() === 'rule') {
        <div class="offers-filters">
          <mat-form-field class="network" subscriptSizing="dynamic">
            <mat-label>Партнёрка</mat-label>
            <mat-select [ngModel]="ruleNetwork()" (ngModelChange)="ruleNetwork.set($event); ruleCountry.set(null)">
              @for (n of networks(); track n.id) {
                <mat-option [value]="n.id">{{ n.name }} ({{ n.count }})</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field class="country" subscriptSizing="dynamic">
            <mat-label>Гео</mat-label>
            <mat-select [ngModel]="ruleCountry() ?? NONE" (ngModelChange)="ruleCountry.set(orNull($event))" [disabled]="ruleNetwork() === null">
              <mat-option [value]="NONE">Любое</mat-option>
              @for (c of countries(); track c.name) {
                <mat-option [value]="c.name">{{ c.name }} ({{ c.count }})</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field class="search" subscriptSizing="dynamic">
            <mat-label>Название содержит</mat-label>
            <input matInput [ngModel]="ruleName()" (ngModelChange)="ruleName.set($event)" placeholder="необязательно" />
          </mat-form-field>
        </div>
        <div class="eyebrow counted">Считаются: {{ ruleCounted() }} из {{ ruleMatches().length }} подходящих</div>
      } @else {
        <div class="offers-filters">
          <mat-form-field class="network" subscriptSizing="dynamic">
            <mat-label>Партнёрка</mat-label>
            <mat-select [ngModel]="network()" (ngModelChange)="network.set($event)">
              <mat-option [value]="ALL">Все партнёрки</mat-option>
              @for (n of networks(); track n.id) {
                <mat-option [value]="n.id">{{ n.name }} ({{ n.count }})</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field class="search" subscriptSizing="dynamic">
            <mat-icon matPrefix>search</mat-icon>
            <input matInput [ngModel]="query()" (ngModelChange)="query.set($event)" placeholder="IN, название ленда, группа…" />
          </mat-form-field>
          <mat-checkbox [ngModel]="showArchived()" (ngModelChange)="showArchived.set($event)">архивные</mat-checkbox>
        </div>
        <div class="eyebrow counted">Выбрано: {{ selected().size }}</div>
      }

      @if (loading()) {
        <mat-progress-bar mode="indeterminate" />
      } @else if (error(); as e) {
        <p class="error">{{ e }}</p>
      } @else {
        <div class="offers">
          @for (g of groups(); track g.name) {
            <div class="group">
              <mat-checkbox
                class="group-box"
                [checked]="g.picked === g.offers.length"
                [indeterminate]="g.picked > 0 && g.picked < g.offers.length"
                (change)="setChecked(g.offers, $event.checked)"
              >
                <b>{{ g.name }}</b> <span class="faint">({{ g.picked }}/{{ g.offers.length }})</span>
              </mat-checkbox>
              @for (o of g.offers; track o.id) {
                <mat-checkbox class="offer" [checked]="isChecked(o)" (change)="setChecked([o], $event.checked)">
                  {{ o.name }}
                  <span class="faint">
                    @if (o.network) { · {{ o.network }} }
                    @if (o.country) { · {{ o.country }} }
                    @if (o.archived) { · архив }
                    · #{{ o.id }}
                  </span>
                </mat-checkbox>
              }
            </div>
          } @empty {
            <p class="faint">{{ emptyHint() }}</p>
          }
        </div>
      }
    </mat-dialog-content>
    <mat-dialog-actions>
      @if (data) {
        <button mat-button class="danger" (click)="remove()">Удалить капу</button>
      }
      <span class="spacer"></span>
      <button mat-button mat-dialog-close>Отмена</button>
      <button mat-flat-button [disabled]="saving() || !name.trim() || !(limit > 0) || (mode() === 'rule' ? ruleNetwork() === null : !selected().size)" (click)="save()">
        Сохранить
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .fields {
        display: grid;
        grid-template-columns: 1fr 220px;
        gap: 0 12px;
        align-items: center;
      }
      .note {
        grid-column: 1 / -1;
      }
      .offers-head {
        display: flex;
        align-items: center;
        gap: 12px;
        margin: 14px 0 10px;
      }
      .country {
        width: 180px;
      }
      .counted {
        margin-bottom: 6px;
      }
      .offers-filters {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 8px;
      }
      .network {
        width: 240px;
      }
      .search {
        flex: 1;
      }
      .offers {
        max-height: 42vh;
        overflow: auto;
        border: 1px solid var(--divider);
        padding: 6px 10px;
      }
      .group {
        display: flex;
        flex-direction: column;
        padding: 4px 0;
        border-bottom: 1px solid var(--divider);
      }
      .group:last-child {
        border-bottom: 0;
      }
      .offer {
        margin-left: 24px;
        font-size: 13px;
      }
      .faint {
        color: var(--text-faint);
        font-size: 12px;
      }
      .error {
        color: var(--danger);
      }
      .danger {
        color: var(--danger);
      }
      .spacer {
        flex: 1;
      }
    `,
  ],
})
export class CapDialog implements OnInit {
  readonly NONE = NONE;
  readonly orNull = orNull;
  readonly data = inject<CapDay | null>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<CapDialog, CapInput | 'deleted'>);
  private readonly api = inject(ApiService);
  private readonly ask = inject(ConfirmService);

  name = this.data?.name ?? '';
  limit = this.data?.dailyLimit ?? 0;
  note = this.data?.note ?? '';
  active = this.data?.active ?? true;

  readonly offers = signal<KeitaroOffer[]>([]);
  readonly mode = signal<'rule' | 'manual'>(this.data && !this.data.rule ? 'manual' : 'rule');
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  /* rule mode */
  readonly ruleNetwork = signal<number | null>(this.data?.rule?.networkId ?? null);
  readonly ruleCountry = signal<string | null>(this.data?.rule?.country ?? null);
  readonly ruleName = signal(this.data?.rule?.nameContains ?? '');
  readonly excluded = signal(new Set<number>(this.data?.excludedIds ?? []));

  /* manual mode */
  readonly selected = signal(new Set<number>(this.data && !this.data.rule ? this.data.offers.map((o) => o.id) : []));
  readonly query = signal('');
  readonly showArchived = signal(false);
  readonly ALL = ALL;
  readonly network = signal<number | typeof ALL>(ALL);

  private readonly rule = computed<CapRule | null>(() => {
    const networkId = this.ruleNetwork();
    return networkId === null ? null : { networkId, country: this.ruleCountry(), nameContains: this.ruleName() };
  });
  readonly ruleMatches = computed(() => {
    const rule = this.rule();
    return rule ? this.offers().filter((o) => matchesRule(o, rule)) : [];
  });
  readonly ruleCounted = computed(() => this.ruleMatches().filter((o) => !this.excluded().has(o.id)).length);

  /** Partners (Keitaro affiliate networks) with their offer counts. */
  readonly networks = computed(() => {
    const counts = new Map<number, { id: number; name: string; count: number }>();
    for (const o of this.offers()) {
      if (o.networkId === null) continue;
      if (o.archived && this.mode() === 'manual' && !this.showArchived()) continue;
      const entry = counts.get(o.networkId) ?? { id: o.networkId, name: o.network ?? `#${o.networkId}`, count: 0 };
      entry.count++;
      counts.set(o.networkId, entry);
    }
    return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  });

  /** Geos among the chosen partner's offers. */
  readonly countries = computed(() => {
    const counts = new Map<string, number>();
    for (const o of this.offers()) {
      if (o.networkId !== this.ruleNetwork() || !o.country) continue;
      counts.set(o.country, (counts.get(o.country) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  });

  /** The offers listed, by Keitaro group. */
  readonly groups = computed(() => {
    const list = this.mode() === 'rule' ? this.ruleMatches() : this.manualListed();
    const byGroup = new Map<string, KeitaroOffer[]>();
    for (const o of list) {
      const key = o.group ?? 'Без группы';
      const group = byGroup.get(key);
      if (group) group.push(o);
      else byGroup.set(key, [o]);
    }
    return [...byGroup].map(([name, offers]) => ({
      name,
      offers,
      picked: offers.filter((o) => this.isChecked(o)).length,
    }));
  });

  /** Manual mode: matches of the partner/search filter, plus everything ticked. */
  private readonly manualListed = computed(() => {
    const words = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    const network = this.network();
    const picked = this.selected();
    // Thousands of offers: list them only once a partner is picked or something is typed.
    return this.offers().filter((o) => {
      if (picked.has(o.id)) return true;
      const hay = [o.name, o.group, o.network, o.country, String(o.id)].join(' ').toLowerCase();
      return (
        (network !== ALL || words.length > 0) &&
        (network === ALL || o.networkId === network) &&
        words.every((w) => hay.includes(w)) &&
        (this.showArchived() || !o.archived)
      );
    });
  });

  async ngOnInit(): Promise<void> {
    try {
      const offers = await this.api.caps.offers();
      this.offers.set(offers);
      // Editing a manual cap: open on the partner its offers belong to.
      const mine = offers.find((o) => this.selected().has(o.id) && o.networkId !== null);
      if (mine) this.network.set(mine.networkId!);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
    this.loading.set(false);
  }

  emptyHint(): string {
    if (this.mode() === 'rule') {
      return this.ruleNetwork() === null ? 'Выбери партнёрку.' : 'Сейчас под условия не подходит ни один оффер.';
    }
    return this.query().trim() || this.network() !== ALL
      ? 'Ничего не найдено.'
      : 'Выбери партнёрку или начни вводить название оффера.';
  }

  isChecked(o: KeitaroOffer): boolean {
    return this.mode() === 'rule' ? !this.excluded().has(o.id) : this.selected().has(o.id);
  }

  setChecked(offers: KeitaroOffer[], on: boolean): void {
    if (this.mode() === 'rule') {
      const next = new Set(this.excluded());
      for (const o of offers) {
        if (on) next.delete(o.id);
        else next.add(o.id);
      }
      this.excluded.set(next);
    } else {
      const next = new Set(this.selected());
      for (const o of offers) {
        if (on) next.add(o.id);
        else next.delete(o.id);
      }
      this.selected.set(next);
    }
  }

  async save(): Promise<void> {
    const input: CapInput = {
      id: this.data?.id,
      name: this.name.trim(),
      dailyLimit: Number(this.limit),
      rule: this.mode() === 'rule' ? this.rule() : null,
      // Only exclusions that still match matter; the rest would just pile up.
      excludedIds: this.offers().length
        ? this.ruleMatches().filter((o) => this.excluded().has(o.id)).map((o) => o.id)
        : [...this.excluded()],
      offerIds: this.mode() === 'manual' ? [...this.selected()] : [],
      note: this.note,
      active: this.active,
    };
    this.saving.set(true);
    try {
      await this.api.caps.save(input);
      this.ref.close(input);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.saving.set(false);
    }
  }

  async remove(): Promise<void> {
    if (!this.data) return;
    const ok = await this.ask.confirm({ title: `Удалить капу «${this.data.name}»?`, ok: 'Удалить', danger: true });
    if (!ok) return;
    await this.api.caps.delete(this.data.id);
    this.ref.close('deleted');
  }
}

const ALL = 'all';
