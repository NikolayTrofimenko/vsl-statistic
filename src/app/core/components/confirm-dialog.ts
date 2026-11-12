import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

export interface ConfirmDialogData {
  title: string;
  /** Body text; line breaks are kept. */
  message?: string;
  /** Show a text field. */
  input?: {
    label: string;
    value?: string;
    placeholder?: string;
    /** Offered as you type (buyer codes…). */
    suggestions?: string[];
    /** Upper-case what is typed (codes). */
    upper?: boolean;
    /** Minimum length to enable OK. */
    minLength?: number;
    hint?: string;
  };
  /** Show a checkbox. */
  check?: { label: string; value?: boolean };
  ok?: string;
  cancel?: string;
  /** The action destroys or pays for something — a red button. */
  danger?: boolean;
}

export interface ConfirmDialogResult {
  value: string;
  checked: boolean;
}

/**
 * The app's own confirm / prompt: a title, a message, optionally a text field
 * (with suggestions) and a checkbox. Opened through `ConfirmService`, never
 * directly — so every page asks the same way, in the app's look rather than
 * the browser's.
 */
@Component({
  selector: 'app-confirm-dialog',
  imports: [
    FormsModule,
    MatDialogModule,
    MatAutocompleteModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      @if (data.message) {
        <p class="message">{{ data.message }}</p>
      }
      @if (data.input; as input) {
        <form (ngSubmit)="submit()">
          <mat-form-field class="field">
            <mat-label>{{ input.label }}</mat-label>
            <input
              matInput
              name="value"
             
              autocomplete="off"
              [ngModel]="value()"
              (ngModelChange)="setValue($event)"
              [placeholder]="input.placeholder ?? ''"
              [matAutocomplete]="auto"
            />
            @if (input.hint) {
              <mat-hint>{{ input.hint }}</mat-hint>
            }
            <mat-autocomplete #auto="matAutocomplete" (optionSelected)="setValue($event.option.value)">
              @for (s of filtered(); track s) {
                <mat-option [value]="s">{{ s }}</mat-option>
              }
            </mat-autocomplete>
          </mat-form-field>
        </form>
      }
      @if (data.check; as check) {
        <mat-checkbox [ngModel]="checked()" (ngModelChange)="checked.set($event)">{{ check.label }}</mat-checkbox>
      }
    </mat-dialog-content>
    <mat-dialog-actions>
      <span class="spacer"></span>
      <button mat-button [mat-dialog-close]="undefined">{{ data.cancel ?? 'Отмена' }}</button>
      <button mat-flat-button [class.danger]="data.danger" [disabled]="!valid()" (click)="submit()">
        {{ data.ok ?? 'OK' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .message {
        margin: 0 0 12px;
        white-space: pre-line;
        line-height: 1.5;
        color: var(--text);
      }
      .field {
        width: 100%;
      }
      .spacer {
        flex: 1;
      }
      .danger {
        --mdc-filled-button-container-color: var(--danger);
        --mat-button-filled-container-color: var(--danger);
      }
    `,
  ],
})
export class ConfirmDialog {
  readonly data = inject<ConfirmDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<ConfirmDialog, ConfirmDialogResult>);

  readonly value = signal(this.data.input?.value ?? '');
  readonly checked = signal(this.data.check?.value ?? false);

  readonly filtered = computed(() => {
    const all = this.data.input?.suggestions ?? [];
    const q = this.value().trim().toLowerCase();
    return (q ? all.filter((s) => s.toLowerCase().includes(q)) : all).slice(0, 50);
  });

  readonly valid = computed(() => !this.data.input || this.value().trim().length >= (this.data.input.minLength ?? 1));

  setValue(v: string): void {
    this.value.set(this.data.input?.upper ? String(v).toUpperCase() : String(v));
  }

  submit(): void {
    if (!this.valid()) return;
    this.ref.close({ value: this.value().trim(), checked: this.checked() });
  }
}
