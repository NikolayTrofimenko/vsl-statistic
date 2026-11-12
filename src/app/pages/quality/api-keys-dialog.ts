import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Clipboard } from '@angular/cdk/clipboard';
import { MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../core/services/api.service';
import { ConfirmService } from '../../core/services/confirm.service';
import type { ApiKeyInfo } from '../../../shared/api.types';

/**
 * Admin: keys for the read-only stats API — who has one, when it was last
 * used, issue a new one (shown once), revoke. Plus a one-line example.
 */
@Component({
  selector: 'app-api-keys-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, MatTooltipModule],
  template: `
    <h2 mat-dialog-title>API статистики</h2>
    <mat-dialog-content>
      <p class="muted">
        Только чтение: те же цифры, что на этой странице. Ключ даёт доступ ко всей статистике лендов —
        выдавай по одному на человека или программу, ненужный отзывай.
      </p>

      @if (newKey(); as k) {
        <div class="new-key">
          <div class="eyebrow">Ключ — скопируй сейчас, больше он не покажется</div>
          <div class="key-row">
            <code class="mono">{{ k }}</code>
            <button mat-icon-button (click)="copy(k)" matTooltip="Скопировать"><mat-icon>content_copy</mat-icon></button>
          </div>
        </div>
      }

      <form class="create" (ngSubmit)="create()">
        <mat-form-field class="name" subscriptSizing="dynamic">
          <mat-label>Для кого ключ</mat-label>
          <input matInput name="name" [(ngModel)]="name" placeholder="софт Сергея" maxlength="80" />
        </mat-form-field>
        <button mat-flat-button type="submit" [disabled]="!name.trim()">Выдать ключ</button>
      </form>

      <table class="keys">
        @for (k of keys(); track k.id) {
          <tr>
            <td>{{ k.name }}</td>
            <td class="mono faint">{{ k.prefix }}…</td>
            <td class="faint">выдан {{ date(k.createdAt) }}@if (k.createdBy) {<span> · {{ k.createdBy }}</span>}</td>
            <td class="faint">{{ k.lastUsedAt ? 'использован ' + date(k.lastUsedAt) : 'не использовался' }}</td>
            <td><button mat-button class="danger" (click)="revoke(k)">Отозвать</button></td>
          </tr>
        } @empty {
          <tr><td class="faint">Ключей нет</td></tr>
        }
      </table>

      <div class="eyebrow">Пример</div>
      <pre class="example mono">{{ example() }}</pre>
      <p class="muted small">
        Эндпоинты: <code>/stats</code> — все видео на лендах за период (from, to — YYYY-MM-DD, по умолчанию 7 дней;
        фильтры land, device, country, buyer), <code>/stats/:id</code> — одно видео: удержание по секундам,
        разбивки, по дням; <code>/facets</code> — значения фильтров.
      </p>
    </mat-dialog-content>
    <mat-dialog-actions>
      <span class="spacer"></span>
      <button mat-button mat-dialog-close>Закрыть</button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .muted {
        color: var(--text-muted);
        font-size: 13px;
      }
      .small {
        font-size: 12px;
      }
      .new-key {
        border: 1px solid var(--accent-border);
        background: var(--accent-soft);
        padding: 8px 12px;
        margin-bottom: 12px;
      }
      .key-row {
        display: flex;
        align-items: center;
        gap: 6px;
        word-break: break-all;
      }
      .create {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 8px;
      }
      .name {
        flex: 1;
      }
      .keys {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
        margin-bottom: 14px;

        td {
          padding: 4px 6px;
          border-bottom: 1px solid var(--divider);
        }
      }
      .faint {
        color: var(--text-faint);
      }
      .danger {
        color: var(--danger);
      }
      .example {
        background: var(--surface-2);
        border: 1px solid var(--divider);
        padding: 8px 10px;
        font-size: 12px;
        white-space: pre-wrap;
        word-break: break-all;
      }
      .spacer {
        flex: 1;
      }
    `,
  ],
})
export class ApiKeysDialog implements OnInit {
  private readonly api = inject(ApiService);
  private readonly ask = inject(ConfirmService);
  private readonly clipboard = inject(Clipboard);

  readonly keys = signal<ApiKeyInfo[]>([]);
  readonly newKey = signal<string | null>(null);
  readonly base = signal('');
  name = '';

  async ngOnInit(): Promise<void> {
    const [keys, base] = await Promise.all([this.api.stats.apiKeys(), this.api.stats.apiBase()]);
    this.keys.set(keys);
    this.base.set(base);
  }

  example(): string {
    return `curl -H "Authorization: Bearer ${this.newKey() ?? 'vsl_…'}" \\\n  "${this.base()}/stats?from=2026-10-01&to=2026-10-21"`;
  }

  async create(): Promise<void> {
    const { key, info } = await this.api.stats.createApiKey(this.name.trim());
    this.newKey.set(key);
    this.keys.update((list) => [info, ...list]);
    this.name = '';
  }

  async revoke(k: ApiKeyInfo): Promise<void> {
    const ok = await this.ask.confirm({
      title: `Отозвать ключ «${k.name}»?`,
      message: 'Программа с этим ключом сразу перестанет получать данные.',
      ok: 'Отозвать',
      danger: true,
    });
    if (!ok) return;
    await this.api.stats.revokeApiKey(k.id);
    this.keys.update((list) => list.filter((x) => x.id !== k.id));
  }

  copy(text: string): void {
    this.clipboard.copy(text);
  }

  date(ms: number): string {
    return new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
}
