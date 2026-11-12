import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../core/services/api.service';
import { ConfirmService } from '../../core/services/confirm.service';
import type { Vertical } from '../../../shared/api.types';

/**
 * Admin page: the code of each vertical — the prefix of its creative IDs.
 * Issued IDs never change, so a new code only applies to new creatives.
 */
@Component({
  selector: 'app-verticals',
  imports: [FormsModule, MatButtonModule, MatIconModule, MatTooltipModule, RouterLink],
  template: `
    <header class="page-header">
      <div>
        <a class="back" routerLink="/library"><mat-icon>arrow_back</mat-icon>Библиотека крео</a>
        <h1>Вертикали</h1>
        <p>
          Вертикаль — папка верхнего уровня на Drive. Её код — начало ID крео (SUS-0142). Уже выданные
          ID не меняются никогда: новый код получат только крео, добавленные после смены.
        </p>
      </div>
    </header>

    <div class="table-wrap">
      <table class="verticals">
        <thead>
          <tr>
            <th class="left">Папка</th>
            <th class="left">Код</th>
            <th>Крео</th>
            <th class="left">Следующий ID</th>
          </tr>
        </thead>
        <tbody>
          @for (v of verticals(); track v.id) {
            <tr [class.gone]="!v.present">
              <td class="left">
                {{ v.name || 'Корень папки' }}
                @if (!v.present) {
                  <span class="faint">· папки нет на Drive</span>
                }
              </td>
              <td class="left">
                <form class="code-form" (ngSubmit)="save(v, input.value)">
                  <input
                    #input
                    class="code mono"
                    [value]="v.code"
                    maxlength="3"
                    spellcheck="false"
                    (input)="input.value = input.value.toUpperCase().replace(rx, '')"
                    aria-label="Код вертикали"
                  />
                  @if (input.value !== v.code) {
                    <button mat-button type="submit" [disabled]="input.value.length !== 3">Сохранить</button>
                  }
                </form>
              </td>
              <td class="mono">{{ v.count }}</td>
              <td class="left mono faint">{{ v.nextId }}</td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .back {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-bottom: 6px;
        font-size: 13px;
        color: var(--text-secondary, inherit);
        text-decoration: none;
        opacity: 0.75;
      }
      .back:hover {
        opacity: 1;
      }
      .back mat-icon {
        width: 16px;
        height: 16px;
        font-size: 16px;
      }
      .table-wrap {
        overflow-x: auto;
        background: var(--surface);
        border: 1px solid var(--divider);
        max-width: 760px;
      }
      table.verticals {
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
        }
        td {
          text-align: right;
          padding: 6px 8px;
          border-bottom: 1px solid var(--divider);
          white-space: nowrap;
        }
        .left {
          text-align: left;
          padding-left: 14px;
        }
        tr.gone td {
          opacity: 0.6;
        }
      }
      .code-form {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 36px;
      }
      .code {
        width: 64px;
        padding: 4px 8px;
        font-size: 15px;
        font-weight: 600;
        letter-spacing: 0.06em;
        background: var(--surface-2);
        color: var(--text);
        border: 1px solid var(--divider-strong);
      }
      .faint {
        color: var(--text-faint);
      }
    `,
  ],
})
export class VerticalsPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly ask = inject(ConfirmService);
  private readonly snack = inject(MatSnackBar);

  readonly verticals = signal<Vertical[]>([]);
  readonly rx = /[^A-Z]/g;

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  async save(v: Vertical, code: string): Promise<void> {
    if (code === v.code || code.length !== 3) return;
    const ok = await this.ask.confirm({
      title: `Сменить код на ${code}?`,
      message: `Вертикаль «${v.name || 'Корень папки'}»: новые крео получат ${code}-…, уже выданные ID останутся ${v.code}-….`,
      ok: 'Сменить',
    });
    if (!ok) return;
    try {
      await this.api.library.saveVertical(v.id, code);
      this.snack.open(`Новые крео получат ${code}-…`, undefined, { duration: 3000 });
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
    }
    await this.reload();
  }

  private async reload(): Promise<void> {
    try {
      this.verticals.set(await this.api.library.verticals());
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
    }
  }
}
