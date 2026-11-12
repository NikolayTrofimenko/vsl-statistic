import { inject, Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { ConfirmDialog, ConfirmDialogData, ConfirmDialogResult } from '../components/confirm-dialog';

/**
 * Asking the person something — in the app's own dialog, not the browser's
 * `confirm()` / `prompt()`.
 *
 *   if (!(await this.ask.confirm({ title: 'Удалить тег?', danger: true }))) return;
 *   const code = await this.ask.prompt({ title: 'Кому передать?', input: { label: 'Баер' } });
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly dialog = inject(MatDialog);

  /** The full answer: null when cancelled. */
  async open(data: ConfirmDialogData): Promise<ConfirmDialogResult | null> {
    const ref = this.dialog.open<ConfirmDialog, ConfirmDialogData, ConfirmDialogResult>(ConfirmDialog, {
      data,
      width: '480px',
      maxWidth: '95vw',
      autoFocus: data.input ? 'first-tabbable' : 'dialog',
    });
    return (await firstValueFrom(ref.afterClosed())) ?? null;
  }

  async confirm(data: Omit<ConfirmDialogData, 'input'>): Promise<boolean> {
    return (await this.open(data)) !== null;
  }

  /** The typed value, or null when cancelled. */
  async prompt(data: ConfirmDialogData & { input: NonNullable<ConfirmDialogData['input']> }): Promise<string | null> {
    return (await this.open(data))?.value ?? null;
  }
}
