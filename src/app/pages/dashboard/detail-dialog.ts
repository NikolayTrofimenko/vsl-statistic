import { Component, inject, OnInit, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ApiService } from '../../core/services/api.service';
import type { DashDetail, DashPeriodKind } from '../../../shared/dashboard.types';

export interface DetailDialogData {
  metricId: string;
  label: string;
  kind: DashPeriodKind;
  anchor: string;
}

/** Who / what is behind a dashboard number. */
@Component({
  selector: 'app-dash-detail-dialog',
  imports: [MatDialogModule, MatButtonModule, MatIconModule, MatProgressBarModule],
  template: `
    <h2 mat-dialog-title>{{ detail()?.title ?? data.label }}</h2>
    <mat-dialog-content>
      @if (detail(); as d) {
        <div class="wrap">
          <table>
            <thead>
              <tr>
                <th class="left">{{ data.metricId === 'buying.profit' ? 'Баер' : 'Кто' }}</th>
                @for (c of d.columns; track c) {
                  <th>{{ c }}</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (r of d.rows; track $index) {
                <tr>
                  <td class="left">
                    @if (r.url) {
                      <a [href]="r.url" target="_blank" rel="noopener">{{ r.name }}</a>
                    } @else {
                      {{ r.name }}
                    }
                  </td>
                  @for (v of r.cells; track $index) {
                    <td>{{ v ?? '—' }}</td>
                  }
                </tr>
              } @empty {
                <tr><td class="left faint" [attr.colspan]="d.columns.length + 1">Никого за этот период</td></tr>
              }
            </tbody>
          </table>
        </div>
      } @else if (error()) {
        <div class="error">{{ error() }}</div>
      } @else {
        <mat-progress-bar mode="indeterminate" />
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Закрыть</button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .wrap {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
        font-variant-numeric: tabular-nums;
      }
      th {
        font-weight: 400;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-faint);
        text-align: right;
        padding: 4px 8px;
        border-bottom: 1px solid var(--divider-strong);
        white-space: nowrap;
      }
      td {
        text-align: right;
        padding: 5px 8px;
        border-bottom: 1px solid var(--divider);
        white-space: nowrap;
      }
      .left {
        text-align: left;
      }
      a {
        color: var(--accent-text);
      }
      .error {
        color: var(--danger);
      }
    `,
  ],
})
export class DetailDialog implements OnInit {
  readonly data = inject<DetailDialogData>(MAT_DIALOG_DATA);
  private readonly api = inject(ApiService);
  readonly detail = signal<DashDetail | null>(null);
  readonly error = signal('');

  async ngOnInit(): Promise<void> {
    try {
      this.detail.set(await this.api.dashboard.detail(this.data.metricId, this.data.kind, this.data.anchor));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }
}
