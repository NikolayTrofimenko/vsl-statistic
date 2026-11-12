import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { ApiService } from '../../core/services/api.service';
import type { GrantTeam } from '../../../shared/api.types';

export interface TeamDialogData {
  team: GrantTeam | null;
  /** Keitaro logins to pick members from. */
  buyers: string[];
  /** Head of buying: picks the lead; a team lead's team is always their own. */
  head: boolean;
  leads: { id: number; login: string }[];
}

/** Name a team, pick its lead (head only) and tick its Keitaro logins. */
@Component({
  selector: 'app-team-dialog',
  imports: [
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
  ],
  template: `
    <h2 mat-dialog-title>{{ data.team ? 'Команда ' + data.team.name : 'Новая команда' }}</h2>
    <mat-dialog-content>
      <div class="fields">
        <mat-form-field>
          <mat-label>Название</mat-label>
          <input matInput [ngModel]="name()" (ngModelChange)="name.set($event)" placeholder="NLM" maxlength="60" />
        </mat-form-field>
        @if (data.head) {
          <mat-form-field>
            <mat-label>Тимлид (аккаунт здесь)</mat-label>
            <mat-select [ngModel]="leadId()" (ngModelChange)="leadId.set($event)">
              <mat-option [value]="0">— без тимлида —</mat-option>
              @for (l of data.leads; track l.id) {
                <mat-option [value]="l.id">{{ l.login }}</mat-option>
              }
            </mat-select>
            <mat-hint>Он сможет сам раздавать доступы этой команде</mat-hint>
          </mat-form-field>
        }
      </div>
      <div class="row">
        <span class="label">Баеры в Keitaro · выбрано {{ members().size }}</span>
        <mat-form-field class="search" subscriptSizing="dynamic">
          <mat-icon matPrefix>search</mat-icon>
          <input matInput [ngModel]="query()" (ngModelChange)="query.set($event)" placeholder="Логин" />
        </mat-form-field>
      </div>
      <div class="buyers">
        @for (login of shown(); track login) {
          <mat-checkbox [checked]="members().has(login)" (change)="toggle(login, $event.checked)">
            <span class="mono">{{ login }}</span>
          </mat-checkbox>
        }
      </div>
      @if (error()) {
        <div class="error">{{ error() }}</div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Отмена</button>
      <button mat-flat-button (click)="save()" [disabled]="saving() || !name().trim()">Сохранить</button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .fields {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        margin-bottom: 8px;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
      }
      .label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-faint);
      }
      .search {
        width: 160px;
        margin-left: auto;
      }
      .buyers {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
        max-height: 320px;
        overflow-y: auto;
        border: 1px solid var(--divider);
        padding: 4px;
      }
      .error {
        color: var(--danger);
        margin-top: 8px;
      }
    `,
  ],
})
export class TeamDialog {
  readonly data = inject<TeamDialogData>(MAT_DIALOG_DATA);
  private readonly api = inject(ApiService);
  private readonly ref = inject(MatDialogRef<TeamDialog, GrantTeam>);

  readonly name = signal(this.data.team?.name ?? '');
  /** 0 — no lead (mat-select can't show a null option). */
  readonly leadId = signal(this.data.team?.leadUserId ?? 0);
  readonly members = signal(new Set(this.data.team?.members ?? []));
  readonly query = signal('');
  readonly saving = signal(false);
  readonly error = signal('');

  /** Members no longer in Keitaro stay listed, so they can be unticked. */
  private readonly logins = [...new Set([...this.data.buyers, ...(this.data.team?.members ?? [])])].sort();

  readonly shown = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.logins.filter((l) => !q || l.toLowerCase().includes(q));
  });

  toggle(login: string, on: boolean): void {
    this.members.update((s) => {
      const next = new Set(s);
      on ? next.add(login) : next.delete(login);
      return next;
    });
  }

  async save(): Promise<void> {
    this.saving.set(true);
    this.error.set('');
    try {
      const team = await this.api.grants.saveTeam({
        id: this.data.team?.id,
        name: this.name(),
        leadUserId: this.leadId() || null,
        members: [...this.members()],
      });
      this.ref.close(team);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.saving.set(false);
    }
  }
}
