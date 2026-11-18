import { JsonPipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ApiService } from '../../core/services/api.service';
import type { ApifbSendResult } from '../../../shared/api.types';

const EVENT_NAMES = ['Lead', 'Purchase', 'CompleteRegistration', 'AddToCart', 'ViewContent', 'InitiateCheckout'];

/**
 * Admin-only: fire one Facebook Conversions API event to check that a pixel
 * and its token work. Same purpose as Keitaro's `/apifb/apifb.html`.
 */
@Component({
  selector: 'app-apifb',
  imports: [FormsModule, JsonPipe, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSelectModule],
  template: `
    <header class="page-header">
      <div>
        <h1>Тест Facebook</h1>
        <p>
          Разовая отправка события в Meta Conversions API — проверка цепочки пиксель → токен.
          Нужен хотя бы один идентификатор: email, телефон, IP+User-Agent, fbclid или external id.
          С test event code попадание видно во вкладке Test events у пикселя. Токен в логи не
          пишется.
        </p>
      </div>
    </header>

    <form class="form" (ngSubmit)="send()">
      <div class="row required">
        <mat-form-field>
          <mat-label>Pixel ID</mat-label>
          <input matInput name="pixelId" [(ngModel)]="pixelId" autocomplete="off" inputmode="numeric" />
        </mat-form-field>
        <mat-form-field class="token">
          <mat-label>Access token</mat-label>
          <input matInput name="accessToken" [(ngModel)]="accessToken" type="password" autocomplete="off" />
        </mat-form-field>
      </div>

      <div class="row">
        <mat-form-field>
          <mat-label>Событие</mat-label>
          <mat-select name="eventName" [(ngModel)]="eventName">
            @for (n of eventNames; track n) {
              <mat-option [value]="n">{{ n }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Test event code</mat-label>
          <input
            matInput
            name="testEventCode"
            [(ngModel)]="testEventCode"
            autocomplete="off"
            placeholder="из Events Manager → Test events"
          />
        </mat-form-field>
        <mat-form-field>
          <mat-label>Value</mat-label>
          <input matInput name="value" [(ngModel)]="value" type="number" step="any" />
        </mat-form-field>
        <mat-form-field class="currency">
          <mat-label>Currency</mat-label>
          <input matInput name="currency" [(ngModel)]="currency" maxlength="3" />
        </mat-form-field>
      </div>

      <details class="extra" open>
        <summary>Данные пользователя (опционально)</summary>
        <div class="row">
          <mat-form-field>
            <mat-label>Email</mat-label>
            <input matInput name="email" [(ngModel)]="email" autocomplete="off" />
          </mat-form-field>
          <mat-form-field>
            <mat-label>Телефон</mat-label>
            <input matInput name="phone" [(ngModel)]="phone" autocomplete="off" />
          </mat-form-field>
          <mat-form-field>
            <mat-label>Имя</mat-label>
            <input matInput name="firstName" [(ngModel)]="firstName" autocomplete="off" />
          </mat-form-field>
          <mat-form-field>
            <mat-label>Фамилия</mat-label>
            <input matInput name="lastName" [(ngModel)]="lastName" autocomplete="off" />
          </mat-form-field>
        </div>
        <div class="row">
          <mat-form-field>
            <mat-label>Страна (ISO, например in)</mat-label>
            <input matInput name="country" [(ngModel)]="country" maxlength="2" autocomplete="off" />
          </mat-form-field>
          <mat-form-field>
            <mat-label>Город</mat-label>
            <input matInput name="city" [(ngModel)]="city" autocomplete="off" />
          </mat-form-field>
          <mat-form-field>
            <mat-label>External ID / clickid</mat-label>
            <input matInput name="externalId" [(ngModel)]="externalId" autocomplete="off" />
          </mat-form-field>
          <mat-form-field>
            <mat-label>fbclid / fbc</mat-label>
            <input matInput name="fbc" [(ngModel)]="fbc" autocomplete="off" />
          </mat-form-field>
        </div>
        <div class="row">
          <mat-form-field>
            <mat-label>Client IP</mat-label>
            <input
              matInput
              name="clientIp"
              [(ngModel)]="clientIp"
              autocomplete="off"
              placeholder="нужен вместе с User-Agent"
            />
          </mat-form-field>
          <mat-form-field class="wide">
            <mat-label>User-Agent</mat-label>
            <input matInput name="userAgent" [(ngModel)]="userAgent" autocomplete="off" />
          </mat-form-field>
          <mat-form-field class="wide">
            <mat-label>Event source URL</mat-label>
            <input matInput name="eventSourceUrl" [(ngModel)]="eventSourceUrl" autocomplete="off" />
          </mat-form-field>
        </div>
      </details>

      <div class="actions">
        <button
          mat-flat-button
          color="primary"
          type="submit"
          [disabled]="busy() || !pixelId().trim() || !accessToken().trim()"
        >
          <mat-icon>send</mat-icon>
          <span>{{ busy() ? 'Отправляю…' : 'Отправить тест' }}</span>
        </button>
      </div>
    </form>

    @if (result(); as r) {
      <section class="result" [class.ok]="r.ok" [class.fail]="!r.ok">
        <h2>{{ r.ok ? 'Meta приняла событие' : 'Ошибка' }}</h2>
        @if (r.ok) {
          <p>
            events_received: <code>{{ r.eventsReceived ?? '—' }}</code>
            · fbtrace_id: <code>{{ r.fbtraceId ?? '—' }}</code>
          </p>
        } @else {
          <p class="err">{{ r.error }}</p>
        }
        @if (r.messages.length) {
          <pre>{{ r.messages | json }}</pre>
        }
        <h3>Что ушло (токен скрыт)</h3>
        <pre>{{ r.request | json }}</pre>
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        max-width: 960px;
      }
      .form {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 16px;
        background: var(--surface);
        border: 1px solid var(--divider);
        border-radius: 8px;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }
      .row mat-form-field {
        flex: 1 1 180px;
        min-width: 160px;
      }
      .row .token {
        flex: 2 1 280px;
      }
      .row .wide {
        flex: 2 1 280px;
      }
      .row .currency {
        flex: 0 1 100px;
        min-width: 90px;
      }
      .extra {
        margin: 8px 0 4px;
        border-top: 1px solid var(--divider);
        padding-top: 8px;
      }
      .extra summary {
        cursor: pointer;
        font-size: 13px;
        color: var(--text-muted, inherit);
        margin-bottom: 8px;
        user-select: none;
      }
      .actions {
        display: flex;
        gap: 8px;
        margin-top: 4px;
      }
      .actions button mat-icon {
        margin-right: 4px;
      }
      .result {
        margin-top: 20px;
        padding: 16px;
        border-radius: 8px;
        border: 1px solid var(--divider);
        background: var(--surface);
      }
      .result.ok {
        border-color: color-mix(in srgb, #2e7d32 45%, var(--divider));
      }
      .result.fail {
        border-color: color-mix(in srgb, #c62828 45%, var(--divider));
      }
      .result h2 {
        margin: 0 0 8px;
        font-size: 16px;
      }
      .result h3 {
        margin: 16px 0 6px;
        font-size: 13px;
        font-weight: 500;
        color: var(--text-muted, inherit);
      }
      .result p {
        margin: 0;
        font-size: 13px;
      }
      .result .err {
        color: #c62828;
      }
      .result pre {
        margin: 8px 0 0;
        padding: 10px 12px;
        font-size: 12px;
        line-height: 1.45;
        overflow: auto;
        background: var(--bg, #111);
        border-radius: 6px;
        max-height: 360px;
      }
      .result code {
        font-family: var(--font-mono, monospace);
        font-size: 12px;
      }
    `,
  ],
})
export class ApifbPage {
  private readonly api = inject(ApiService);
  private readonly snack = inject(MatSnackBar);

  readonly eventNames = EVENT_NAMES;

  /** Sample technical fields for a test send; pixel/token/name stay empty. */
  readonly pixelId = signal('');
  readonly accessToken = signal('');
  readonly eventName = signal('Purchase');
  readonly testEventCode = signal('');
  readonly email = signal('');
  readonly phone = signal('');
  readonly firstName = signal('');
  readonly lastName = signal('');
  readonly country = signal('PT');
  readonly city = signal('Aveiro');
  readonly clientIp = signal('94.132.42.187');
  readonly userAgent = signal(
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/136.0.0.0 Mobile Safari/537.36',
  );
  readonly externalId = signal('0161fe1c-bbef-413c-82f1-61b265d5dea3');
  readonly fbc = signal('');
  readonly eventSourceUrl = signal('https://www.facebook.com');
  readonly value = signal<number | null>(37);
  readonly currency = signal('USD');

  readonly busy = signal(false);
  readonly result = signal<ApifbSendResult | null>(null);

  async send(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.result.set(null);
    try {
      const r = await this.api.apifb.send({
        pixelId: this.pixelId().trim(),
        accessToken: this.accessToken().trim(),
        eventName: this.eventName().trim() || 'Lead',
        testEventCode: this.testEventCode().trim() || null,
        email: this.email().trim() || null,
        phone: this.phone().trim() || null,
        firstName: this.firstName().trim() || null,
        lastName: this.lastName().trim() || null,
        country: this.country().trim() || null,
        city: this.city().trim() || null,
        clientIp: this.clientIp().trim() || null,
        userAgent: this.userAgent().trim() || null,
        externalId: this.externalId().trim() || null,
        fbc: this.fbc().trim() || null,
        eventSourceUrl: this.eventSourceUrl().trim() || null,
        value: this.value(),
        currency: this.currency().trim() || null,
      });
      this.result.set(r);
      this.snack.open(r.ok ? 'Событие отправлено' : r.error || 'Ошибка Meta', 'OK', { duration: 4000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.snack.open(message, 'OK', { duration: 5000 });
    } finally {
      this.busy.set(false);
    }
  }
}
