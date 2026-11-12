import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ApiService } from '../../core/services/api.service';
import { ConfirmService } from '../../core/services/confirm.service';
import type { BuyResult, DomainCheck } from '../../../shared/api.types';

export interface BuyDialogData {
  buyers: string[];
  balance: number | null;
}

/**
 * Buy a new root: check names, then register the chosen one on Namecheap,
 * add it to Cloudflare and point its NS there. New roots go to PVP unless
 * said otherwise — Илья's default.
 */
@Component({
  selector: 'app-buy-dialog',
  imports: [
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
  ],
  template: `
    <h2 mat-dialog-title>Купить домен</h2>
    <mat-dialog-content>
      @if (!result()) {
        <form class="check" (ngSubmit)="check()">
          <mat-form-field class="names" subscriptSizing="dynamic">
            <mat-label>Имена (по одному в строке)</mat-label>
            <textarea matInput rows="3" name="names" [(ngModel)]="names" placeholder="healthyroutine.store"></textarea>
          </mat-form-field>
          <button mat-button type="submit" [disabled]="busy() || !names.trim()">Проверить</button>
        </form>
        @if (checks().length) {
          <div class="checks">
            @for (c of checks(); track c.domain) {
              <label class="check-row" [class.taken]="!c.available">
                <input type="radio" name="pick" [value]="c.domain" [disabled]="!c.available" [checked]="picked() === c.domain" (change)="picked.set(c.domain)" />
                <span class="mono">{{ c.domain }}</span>
                <span>{{ c.available ? (c.price !== null ? '$' + c.price.toFixed(2) : 'свободно') : 'занято' }}</span>
              </label>
            }
          </div>
          <div class="fields">
            <mat-form-field>
              <mat-label>Владелец</mat-label>
              <input matInput [(ngModel)]="owner" [attr.list]="'buy-buyers'" />
              <datalist id="buy-buyers">
                @for (b of data.buyers; track b) {
                  <option [value]="b"></option>
                }
              </datalist>
            </mat-form-field>
            <mat-form-field>
              <mat-label>Команда</mat-label>
              <input matInput [(ngModel)]="team" placeholder="NLM, TOP, NPA…" />
            </mat-form-field>
            <mat-checkbox [(ngModel)]="sharedPixel">общий пиксель</mat-checkbox>
          </div>
        }
        @if (error()) {
          <p class="error">{{ error() }}</p>
        }
      } @else {
        <div class="steps">
          @for (s of result()!.steps; track s.step) {
            <div [class.bad]="!s.ok">{{ s.ok ? '✓' : '✕' }} {{ s.step }}@if (s.detail) {<span class="muted"> — {{ s.detail }}</span>}</div>
          }
        </div>
        @if (result()!.ok) {
          <p class="muted">Готово. NS-серверы Cloudflare начнут работать в течение часа, потом можно выдавать поддомены.</p>
        }
      }
      @if (busy()) {
        <mat-progress-bar mode="indeterminate" />
      }
    </mat-dialog-content>
    <mat-dialog-actions>
      @if (data.balance !== null) {
        <span class="muted">Баланс \${{ data.balance.toFixed(2) }}</span>
      }
      <span class="spacer"></span>
      @if (!result()) {
        <button mat-button mat-dialog-close>Отмена</button>
        <button mat-flat-button [disabled]="busy() || !picked()" (click)="buy()">Купить{{ pickedPrice() }}</button>
      } @else {
        <button mat-flat-button [mat-dialog-close]="true">Закрыть</button>
      }
    </mat-dialog-actions>
  `,
  styles: [
    `
      .check {
        display: flex;
        align-items: flex-start;
        gap: 12px;
      }
      .names {
        flex: 1;
      }
      .checks {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin: 10px 0;
      }
      .check-row {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 13px;
        cursor: pointer;
      }
      .check-row.taken {
        color: var(--text-faint);
        cursor: default;
      }
      .fields {
        display: grid;
        grid-template-columns: 1fr 1fr auto;
        gap: 0 12px;
        align-items: center;
      }
      .steps {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 13px;
      }
      .bad,
      .error {
        color: var(--danger);
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
export class BuyDialog {
  readonly data = inject<BuyDialogData>(MAT_DIALOG_DATA);
  private readonly api = inject(ApiService);
  private readonly ask = inject(ConfirmService);

  names = '';
  owner = 'PVP';
  team = '';
  sharedPixel = false;

  readonly checks = signal<DomainCheck[]>([]);
  readonly picked = signal<string | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<BuyResult | null>(null);

  pickedPrice(): string {
    const price = this.checks().find((c) => c.domain === this.picked())?.price;
    return price != null ? ` за $${price.toFixed(2)}` : '';
  }

  async check(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const list = this.names.split(/[\s,]+/).filter(Boolean);
      const checks = await this.api.domains.check(list);
      this.checks.set(checks);
      if (!checks.length) this.error.set('Ни одного корректного имени (нужно вида name.store).');
      this.picked.set(checks.find((c) => c.available)?.domain ?? null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  async buy(): Promise<void> {
    const domain = this.picked();
    if (!domain) return;
    const ok = await this.ask.confirm({
      title: `Купить ${domain}${this.pickedPrice()}?`,
      message: 'Деньги спишутся с баланса Namecheap.',
      ok: 'Купить',
      danger: true,
    });
    if (!ok) return;
    this.busy.set(true);
    try {
      this.result.set(
        await this.api.domains.buy({ domain, owner: this.owner.trim() || null, team: this.team.trim() || null, sharedPixel: this.sharedPixel }),
      );
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
