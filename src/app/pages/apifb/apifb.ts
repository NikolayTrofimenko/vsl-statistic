import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ApiService } from '../../core/services/api.service';
import type {
  ApifbBatchItemResult,
  ApifbBatchResult,
  ApifbEventPayload,
  ApifbGeoInfo,
  ApifbPreview,
  ApifbVerticalInfo,
} from '../../../shared/api.types';

/** Must match server `META_EVENT_CHUNK`. */
const CHUNK = 50;

/**
 * Admin: replay APIFB dumps onto a new pixel — pick vertical + geo from
 * «Пиксельная», paste pixel/token, send in Meta chunks with live progress.
 */
@Component({
  selector: 'app-apifb',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSelectModule],
  template: `
    <header class="page-header">
      <div>
        <h1>Пиксель Facebook</h1>
        <p>
          Берём выгрузку из дока по направлению и гео (таблица «Пиксельная»), подставляем новый Pixel ID и
          access token, прогоняем в Meta пачками по {{ chunkSize }} — как коллеги через
          <code>/apifb</code>. Токен в логи не пишется.
        </p>
      </div>
    </header>

    <form class="form" (ngSubmit)="run()">
      <div class="row">
        <mat-form-field>
          <mat-label>Направление</mat-label>
          <mat-select name="verticalId" [(ngModel)]="verticalId" (ngModelChange)="onVerticalChange()">
            @for (v of verticals(); track v.id) {
              <mat-option [value]="v.id">{{ v.label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Гео</mat-label>
          <mat-select name="geoId" [(ngModel)]="geoId" (ngModelChange)="onGeoChange()" [disabled]="!geos().length">
            @for (g of geos(); track g.id) {
              <mat-option [value]="g.id">
                @if (g.region) {
                  {{ g.region }} ·
                }
                {{ g.label }}
              </mat-option>
            }
          </mat-select>
        </mat-form-field>
        <button mat-stroked-button type="button" (click)="loadPreview()" [disabled]="!canPreview() || loading()">
          <mat-icon>description</mat-icon>
          <span>{{ loading() ? 'Читаю…' : 'Загрузить док' }}</span>
        </button>
      </div>

      @if (preview(); as p) {
        <div class="preview">
          <b>{{ p.count }}</b> событий · {{ p.geoLabel }}
          <span class="faint">· doc {{ p.docId }}</span>
          @if (p.sample.length) {
            <ul>
              @for (s of p.sample; track s) {
                <li>{{ s }}</li>
              }
            </ul>
          }
        </div>
      }

      <div class="row">
        <mat-form-field>
          <mat-label>Pixel ID</mat-label>
          <input matInput name="pixelId" [(ngModel)]="pixelId" autocomplete="off" inputmode="numeric" />
        </mat-form-field>
        <mat-form-field class="token">
          <mat-label>Access token</mat-label>
          <input matInput name="accessToken" [(ngModel)]="accessToken" type="password" autocomplete="off" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>Test event code</mat-label>
          <input matInput name="testEventCode" [(ngModel)]="testEventCode" autocomplete="off" placeholder="опционально" />
        </mat-form-field>
      </div>

      <details class="extra">
        <summary>Или вставить строки вручную (вместо дока)</summary>
        <mat-form-field class="raw">
          <mat-label>Строки APIFB</mat-label>
          <textarea
            matInput
            name="rawText"
            [(ngModel)]="rawText"
            rows="6"
            placeholder="Purchase#ip#ua#name#phone#…"
          ></textarea>
        </mat-form-field>
      </details>

      <div class="actions">
        <button mat-flat-button color="primary" type="submit" [disabled]="!canRun() || busy()">
          <mat-icon>send</mat-icon>
          <span>{{ busy() ? progressLabel() : 'Отправить на пиксель' }}</span>
        </button>
      </div>
    </form>

    @if (result(); as r) {
      <section class="result" [class.ok]="r.failed === 0" [class.fail]="r.failed > 0">
        <h2>
          Готово: {{ r.ok }} ok
          @if (r.failed) {
            , {{ r.failed }} ошибок
          }
          из {{ r.total }}
        </h2>
        @if (r.failed) {
          <ul class="errors">
            @for (item of failedItems(); track item.index) {
              <li>#{{ item.index + 1 }} {{ item.eventName }} — {{ item.error }}</li>
            }
          </ul>
        }
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
        align-items: flex-start;
      }
      .row mat-form-field {
        flex: 1 1 180px;
        min-width: 160px;
      }
      .row .token {
        flex: 2 1 280px;
      }
      .row button {
        margin-top: 4px;
      }
      .preview {
        margin: 4px 0 12px;
        padding: 10px 12px;
        font-size: 13px;
        background: var(--bg, transparent);
        border-radius: 6px;
        border: 1px dashed var(--divider);
      }
      .preview ul {
        margin: 6px 0 0;
        padding-left: 18px;
        color: var(--text-muted, inherit);
      }
      .faint {
        opacity: 0.65;
        font-family: var(--font-mono, monospace);
        font-size: 11px;
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
      .raw {
        width: 100%;
      }
      .actions {
        display: flex;
        gap: 8px;
        margin-top: 8px;
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
      .errors {
        margin: 0;
        padding-left: 18px;
        font-size: 13px;
        color: #c62828;
        max-height: 240px;
        overflow: auto;
      }
      code {
        font-family: var(--font-mono, monospace);
        font-size: 12px;
      }
    `,
  ],
})
export class ApifbPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly snack = inject(MatSnackBar);

  readonly chunkSize = CHUNK;

  readonly verticals = signal<ApifbVerticalInfo[]>([]);
  readonly geos = signal<ApifbGeoInfo[]>([]);
  readonly preview = signal<ApifbPreview | null>(null);
  readonly result = signal<ApifbBatchResult | null>(null);
  private loadedEvents: ApifbEventPayload[] | null = null;

  readonly verticalId = signal('');
  readonly geoId = signal('');
  readonly pixelId = signal('');
  readonly accessToken = signal('');
  readonly testEventCode = signal('');
  readonly rawText = signal('');

  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly sent = signal(0);
  readonly totalHint = signal(0);

  readonly failedItems = computed(() => (this.result()?.items ?? []).filter((i) => !i.ok).slice(0, 50));

  async ngOnInit(): Promise<void> {
    try {
      const list = await this.api.apifb.verticals();
      this.verticals.set(list);
      if (list[0]) {
        this.verticalId.set(list[0].id);
        await this.onVerticalChange();
      }
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 5000 });
    }
  }

  canPreview(): boolean {
    return Boolean(this.verticalId() && this.geoId()) || Boolean(this.rawText().trim());
  }

  canRun(): boolean {
    if (!this.pixelId().trim() || !this.accessToken().trim()) return false;
    return Boolean(this.rawText().trim()) || Boolean(this.preview()) || Boolean(this.verticalId() && this.geoId());
  }

  progressLabel(): string {
    const t = this.totalHint();
    const s = this.sent();
    return t ? `Отправляю… ${s}/${t}` : 'Отправляю…';
  }

  async onVerticalChange(): Promise<void> {
    this.geoId.set('');
    this.preview.set(null);
    this.result.set(null);
    this.loadedEvents = null;
    this.geos.set([]);
    const id = this.verticalId();
    if (!id) return;
    this.loading.set(true);
    try {
      this.geos.set(await this.api.apifb.geos(id));
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
    } finally {
      this.loading.set(false);
    }
  }

  onGeoChange(): void {
    this.preview.set(null);
    this.result.set(null);
    this.loadedEvents = null;
  }

  async loadPreview(): Promise<void> {
    this.loading.set(true);
    this.preview.set(null);
    this.loadedEvents = null;
    try {
      const raw = this.rawText().trim();
      const loaded = await this.api.apifb.load(
        raw ? { rawText: raw } : { verticalId: this.verticalId(), geoId: this.geoId() },
      );
      this.loadedEvents = loaded.events;
      this.preview.set({
        geoLabel: loaded.geoLabel,
        docId: loaded.docId,
        count: loaded.events.length,
        sample: loaded.events
          .slice(0, 5)
          .map((e) => [e.eventName, e.phone || e.clientIp || e.externalId || '—'].join(' · ')),
      });
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
    } finally {
      this.loading.set(false);
    }
  }

  async run(): Promise<void> {
    if (this.busy() || !this.canRun()) return;
    this.busy.set(true);
    this.result.set(null);
    this.sent.set(0);

    try {
      if (!this.loadedEvents?.length) {
        await this.loadPreview();
      }
      const events = this.loadedEvents;
      if (!events?.length) throw new Error('Нет событий для отправки.');

      this.totalHint.set(events.length);
      const pixelId = this.pixelId().trim();
      const accessToken = this.accessToken().trim();
      const testEventCode = this.testEventCode().trim() || null;

      let ok = 0;
      let failed = 0;
      const items: ApifbBatchItemResult[] = [];

      for (let offset = 0; offset < events.length; offset += CHUNK) {
        const chunk = events.slice(offset, offset + CHUNK);
        const part = await this.api.apifb.batch({
          pixelId,
          accessToken,
          testEventCode,
          events: chunk,
          indexOffset: offset,
        });
        ok += part.ok;
        failed += part.failed;
        items.push(...part.items);
        this.sent.set(Math.min(offset + chunk.length, events.length));
      }

      const summary: ApifbBatchResult = { total: events.length, ok, failed, items };
      this.result.set(summary);
      this.snack.open(
        failed ? `Готово с ошибками: ${ok}/${events.length}` : `Отправлено ${ok} событий`,
        'OK',
        { duration: 5000 },
      );
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
    } finally {
      this.busy.set(false);
    }
  }
}
