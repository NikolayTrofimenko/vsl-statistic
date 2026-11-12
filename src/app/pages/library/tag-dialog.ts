import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { Tag } from '../../../shared/api.types';

/** Swatches offered for a tag — muted, distinct in both themes. */
export const TAG_COLORS = [
  '#8c3040',
  '#b5683a',
  '#a68a3d',
  '#5f8a4e',
  '#3f7f7a',
  '#4a6fa5',
  '#6f5aa0',
  '#8a8378',
];

export interface TagDialogResult {
  name: string;
  color: string;
}

@Component({
  selector: 'app-tag-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>{{ data ? 'Тег' : 'Новый тег' }}</h2>
    <mat-dialog-content>
      <form class="form" (ngSubmit)="save()">
        <mat-form-field>
          <mat-label>Название</mat-label>
          <input matInput name="name" [(ngModel)]="name" maxlength="40" autofocus />
        </mat-form-field>
        <div class="eyebrow">Цвет</div>
        <div class="swatches">
          @for (c of colors; track c) {
            <button
              type="button"
              class="swatch"
              [class.active]="c === color()"
              [style.background]="c"
              [attr.aria-label]="c"
              (click)="color.set(c)"
            ></button>
          }
        </div>
      </form>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Отмена</button>
      <button mat-flat-button color="primary" [disabled]="!name().trim()" (click)="save()">
        Сохранить
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .form {
        display: flex;
        flex-direction: column;
        gap: 12px;
        min-width: 320px;
        padding-top: 4px;
      }
      .swatches {
        display: flex;
        gap: 8px;
      }
      .swatch {
        width: 26px;
        height: 26px;
        border: 2px solid transparent;
        outline: 1px solid var(--divider);
        cursor: pointer;
        padding: 0;
      }
      .swatch.active {
        border-color: var(--surface);
        outline: 2px solid var(--text);
      }
    `,
  ],
})
export class TagDialog {
  readonly data = inject<Tag | null>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<TagDialog, TagDialogResult>);

  readonly colors = TAG_COLORS;
  readonly name = signal(this.data?.name ?? '');
  readonly color = signal(this.data?.color ?? TAG_COLORS[0]!);

  save(): void {
    const name = this.name().trim();
    if (!name) return;
    this.ref.close({ name, color: this.color() });
  }
}
