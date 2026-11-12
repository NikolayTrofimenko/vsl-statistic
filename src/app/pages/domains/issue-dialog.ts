import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { ApiService } from '../../core/services/api.service';
import type { IssueResult, RootDomain, SubdomainSlot } from '../../../shared/api.types';

export interface IssueDialogData {
  roots: RootDomain[];
  buyers: string[];
  root?: string;
  /** Pre-filled buyer (after "Передать"). */
  buyer?: string;
}

/**
 * Hand a buyer N subdomains: pick the buyer, the root (theirs first, then
 * shared and unassigned ones, then other buyers' clean ones), how many — the
 * next free standard names are created in Cloudflare and Keitaro. Taking
 * another buyer's root can hand the whole root over in the same step.
 */
@Component({
  selector: 'app-issue-dialog',
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
  ],
  template: `
    <h2 mat-dialog-title>Выдать поддомены</h2>
    <mat-dialog-content>
      @if (!results()) {
        <div class="fields">
          <mat-form-field>
            <mat-label>Баер (группа в Keitaro)</mat-label>
            <input matInput [ngModel]="buyer()" (ngModelChange)="setBuyer($event)" [attr.list]="'buyers'" placeholder="PVP" />
            <datalist id="buyers">
              @for (b of data.buyers; track b) {
                <option [value]="b"></option>
              }
            </datalist>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Сколько</mat-label>
            <input matInput type="number" min="1" [max]="maxCount()" [ngModel]="count()" (ngModelChange)="count.set(+$event)" />
          </mat-form-field>
          <mat-form-field class="wide">
            <mat-label>Домен</mat-label>
            <mat-select [ngModel]="root()" (ngModelChange)="pickRoot($event)">
              @for (g of groups(); track g.label) {
                <mat-optgroup [label]="g.label">
                  @for (r of g.roots; track r.name) {
                    <mat-option [value]="r.name">
                      {{ r.name }} — свободно {{ r.freeSlots }}@if (r.subdomains) {<span>, выдано {{ r.subdomains }}</span>} · {{ r.owner ?? 'без владельца' }}@if (r.sharedPixel) {<span> · общий пиксель</span>}
                    </mat-option>
                  }
                </mat-optgroup>
              }
            </mat-select>
          </mat-form-field>
        </div>
        @if (foreign(); as f) {
          <mat-checkbox class="transfer" [ngModel]="transfer()" (ngModelChange)="transfer.set($event)">
            Передать домен {{ buyerCode() }} — сейчас он у {{ f.owner }}@if (f.subdomains) {<span> (на нём уже {{ f.subdomains }} поддом.)</span>}
          </mat-checkbox>
        }
        @if (loadingSlots()) {
          <mat-progress-bar mode="indeterminate" />
        } @else if (planned().length) {
          <div class="eyebrow">Будут созданы</div>
          <div class="hosts mono">
            @for (s of planned(); track s.name) {
              <span>{{ s.host }}</span>
            }
          </div>
        }
        @if (error()) {
          <p class="error">{{ error() }}</p>
        }
      } @else {
        <div class="hosts mono">
          @for (r of results()!; track r.host) {
            <span [class.bad]="!r.ok">{{ r.ok ? '✓' : '✕' }} {{ r.host }}@if (r.error) {<span class="err"> — {{ r.error }}</span>}</span>
          }
        </div>
        <p class="muted">SSL Keitaro выпустит сам, обычно за несколько минут.</p>
      }
      @if (running()) {
        <mat-progress-bar mode="indeterminate" />
      }
    </mat-dialog-content>
    <mat-dialog-actions>
      <span class="spacer"></span>
      @if (!results()) {
        <button mat-button mat-dialog-close>Отмена</button>
        <button mat-flat-button [disabled]="running() || !buyer().trim() || !planned().length" (click)="run()">
          Выдать {{ planned().length }}
        </button>
      } @else {
        <button mat-flat-button [mat-dialog-close]="true">Готово</button>
      }
    </mat-dialog-actions>
  `,
  styles: [
    `
      .fields {
        display: grid;
        grid-template-columns: 1fr 120px;
        gap: 0 12px;
      }
      .wide {
        grid-column: 1 / -1;
      }
      .transfer {
        display: block;
        margin: -4px 0 6px;
      }
      .hosts {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 12px;
        margin: 6px 0 10px;
      }
      .bad,
      .error {
        color: var(--danger);
      }
      .err {
        font-family: var(--app-font);
      }
      .muted {
        color: var(--text-muted);
        font-size: 12px;
      }
      .spacer {
        flex: 1;
      }
    `,
  ],
})
export class IssueDialog implements OnInit {
  readonly data = inject<IssueDialogData>(MAT_DIALOG_DATA);
  private readonly api = inject(ApiService);
  private readonly ref = inject(MatDialogRef<IssueDialog, boolean>);

  readonly buyer = signal(this.data.buyer ?? '');
  readonly root = signal<string | null>(this.data.root ?? null);
  /** Hand the chosen root to the buyer as well (offered when it is someone else's). */
  readonly transfer = signal(false);
  /** The person chose the root — stop following the buyer field. */
  private rootPicked = Boolean(this.data.root);
  readonly count = signal(5);
  readonly slots = signal<SubdomainSlot[]>([]);
  readonly loadingSlots = signal(false);
  readonly running = signal(false);
  readonly error = signal<string | null>(null);
  readonly results = signal<IssueResult[] | null>(null);

  readonly buyerCode = computed(() => this.buyer().trim().toUpperCase());

  /** Usable roots, the buyer's own first, then shared, then unassigned (PVP gets the leftovers). */
  readonly candidates = computed(() => {
    const rank = (r: RootDomain) => this.rankOf(r);
    return this.data.roots
      .filter((r) => r.namecheap && r.freeSlots > 0 && !r.banned && !r.service && !r.expired && r.dns !== 'namecheap')
      .sort((a, b) => rank(a) - rank(b) || (b.expiresAt ?? '').localeCompare(a.expiresAt ?? ''));
  });

  /** The same list, labelled: whose root it is decides whether it can just be used. */
  readonly groups = computed(() => {
    const buyer = this.buyerCode();
    const own = this.candidates().filter((r) => this.rankOf(r) <= 1);
    const shared = this.candidates().filter((r) => this.rankOf(r) === 2 || this.rankOf(r) === 3);
    const others = this.candidates().filter((r) => this.rankOf(r) === 4);
    return [
      { label: buyer ? `Домены ${buyer}` : 'Домены баера', roots: own },
      { label: 'Общий пиксель / без владельца', roots: shared },
      { label: 'Других баеров — с передачей или в долю', roots: others },
    ].filter((g) => g.roots.length);
  });

  /** The chosen root belongs to someone else (not shared, not unassigned). */
  readonly foreign = computed(() => {
    const r = this.data.roots.find((x) => x.name === this.root());
    const buyer = this.buyerCode();
    if (!r || !buyer || !r.owner) return null;
    return (r.owner ?? '').split('/').includes(buyer) ? null : r;
  });

  readonly free = computed(() => this.slots().filter((s) => !s.extra && s.state === 'free'));
  readonly maxCount = computed(() => this.free().length);
  readonly planned = computed(() => this.free().slice(0, Math.max(0, Math.min(this.count(), this.maxCount()))));

  async ngOnInit(): Promise<void> {
    if (this.root()) await this.loadSlots(this.root()!);
  }

  setBuyer(value: string): void {
    this.buyer.set(value);
    // Follow the best root for this buyer unless one was chosen on purpose.
    if (!this.rootPicked) {
      const best = this.candidates()[0]?.name ?? null;
      if (best && best !== this.root()) void this.setRoot(best);
    }
    this.suggestTransfer();
  }

  async pickRoot(root: string): Promise<void> {
    this.rootPicked = true;
    await this.setRoot(root);
  }

  async setRoot(root: string): Promise<void> {
    this.root.set(root);
    this.suggestTransfer();
    await this.loadSlots(root);
  }

  async run(): Promise<void> {
    const root = this.root();
    if (!root) return;
    this.running.set(true);
    this.error.set(null);
    try {
      const results = await this.api.domains.issue({ root, buyer: this.buyerCode(), names: this.planned().map((s) => s.name) });
      if (this.foreign() && this.transfer() && results.some((r) => r.ok)) {
        await this.api.domains.update(root, { owner: this.buyerCode() });
      }
      this.results.set(results);
      this.ref.disableClose = true;
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.running.set(false);
    }
  }

  /** 0 own · 1 already has hosts there · 2 shared pixel · 3 unassigned / PVP leftovers · 4 someone else's. */
  private rankOf(r: RootDomain): number {
    const buyer = this.buyerCode();
    const owners = (r.owner ?? '').split('/');
    if (buyer && owners.includes(buyer)) return 0;
    if (buyer && r.buyers.includes(buyer)) return 1;
    if (r.sharedPixel) return 2;
    if (!r.owner || owners.includes('PVP')) return 3;
    return 4;
  }

  /** A clean root of someone else's is usually being handed over: tick "передать" for it. */
  private suggestTransfer(): void {
    const f = this.foreign();
    this.transfer.set(Boolean(f && f.subdomains === 0));
  }

  private async loadSlots(root: string): Promise<void> {
    this.loadingSlots.set(true);
    try {
      this.slots.set(await this.api.domains.subdomains(root));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loadingSlots.set(false);
    }
  }
}
