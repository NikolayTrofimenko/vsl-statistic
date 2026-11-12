import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { ApiService } from '../../core/services/api.service';
import { COUNTRIES, countryName } from '../../../shared/geo';
import { OFFER_CURRENCIES } from '../../../shared/offers';
import type { Offer, OfferInput } from '../../../shared/api.types';

export function money(o: Pick<Offer, 'payout' | 'payoutCurrency'>): string {
  if (o.payout === null) return '—';
  const n = o.payout.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  return o.payoutCurrency === 'USD' ? `$${n}` : `${n} ${o.payoutCurrency}`;
}

/* ------------------------------ card ------------------------------ */

export interface OfferViewData {
  offer: Offer;
  canEdit: boolean;
}

/** Everything about one offer. Closes with 'edit' when an editor asks to change it. */
@Component({
  selector: 'app-offer-view',
  imports: [MatDialogModule, MatButtonModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>
      {{ o.name }}
      @if (!o.active) {
        <span class="off">выключен</span>
      }
    </h2>
    <mat-dialog-content>
      <div class="top">
        @if (o.photoUrl) {
          <a [href]="o.photoUrl" target="_blank" rel="noopener"><img class="photo" [src]="o.photoUrl" alt="" /></a>
        }
        <dl class="facts">
          <dt>Вертикаль</dt><dd>{{ o.vertical || '—' }}</dd>
          <dt>Гео</dt><dd>{{ o.geo ? o.geo + ' · ' + country(o.geo) : '—' }}</dd>
          <dt>ПП</dt><dd>{{ o.partner || '—' }}</dd>
          <dt>Выплата</dt><dd>{{ pay(o) }}</dd>
          <dt>Капа</dt><dd>{{ o.cap ?? '—' }}</dd>
          <dt>Гарант</dt><dd>{{ o.guarantee !== null ? o.guarantee + '%' : '—' }}</dd>
          <dt>Цена на ленде</dt><dd>{{ o.landPrice || '—' }}</dd>
          <dt>Режим КЦ</dt><dd>{{ o.ccMode || '—' }}</dd>
          <dt>Язык КЦ</dt><dd>{{ o.ccLanguage || '—' }}</dd>
        </dl>
      </div>
      @if (o.regionExclusions) {
        <div class="section">
          <div class="eyebrow">Исключения по регионам</div>
          <div class="text">{{ o.regionExclusions }}</div>
        </div>
      }
      @if (o.brief) {
        <div class="section">
          <div class="eyebrow">Бриф / состав</div>
          <div class="text">{{ o.brief }}</div>
        </div>
      }
      <div class="updated">Обновлено {{ date(o.updatedAt) }}{{ o.updatedBy ? ' · ' + o.updatedBy : '' }}</div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      @if (data.canEdit) {
        <button mat-stroked-button [mat-dialog-close]="'edit'"><mat-icon>edit</mat-icon>Изменить</button>
      }
      <button mat-button mat-dialog-close>Закрыть</button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .off {
        margin-left: 8px;
        font-family: var(--font-sans, inherit);
        font-size: 12px;
        color: var(--text-faint);
      }
      .top {
        display: flex;
        gap: 20px;
        flex-wrap: wrap;
        align-items: flex-start;
      }
      .photo {
        width: 180px;
        max-height: 240px;
        object-fit: contain;
        border-radius: 8px;
        background: var(--surface-2);
      }
      .facts {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 6px 16px;
        margin: 0;
        flex: 1;
        min-width: 240px;
        font-size: 14px;
      }
      dt {
        color: var(--text-muted);
      }
      dd {
        margin: 0;
        color: var(--text);
        overflow-wrap: anywhere;
      }
      .section {
        margin-top: 18px;
      }
      .eyebrow {
        margin-bottom: 6px;
      }
      .text {
        white-space: pre-wrap;
        font-size: 14px;
        line-height: 1.55;
        color: var(--text);
        overflow-wrap: anywhere;
      }
      .updated {
        margin-top: 18px;
        font-size: 12px;
        color: var(--text-faint);
      }
    `,
  ],
})
export class OfferViewDialog {
  readonly data = inject<OfferViewData>(MAT_DIALOG_DATA);
  readonly o = this.data.offer;
  readonly country = countryName;
  readonly pay = money;

  date(ms: number): string {
    return new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  }
}

/* ------------------------------ form ------------------------------ */

export interface OfferEditData {
  offer?: Offer;
  verticals: string[];
  partners: string[];
}

/** Add or change an offer (section offersEdit). */
@Component({
  selector: 'app-offer-edit',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>{{ data.offer ? 'Изменить оффер' : 'Новый оффер' }}</h2>
    <mat-dialog-content>
      <div class="form">
        <div class="photo-box">
          @if (preview(); as p) {
            <img [src]="p" alt="" />
          } @else {
            <mat-icon>image</mat-icon>
          }
          <button mat-stroked-button type="button" (click)="picker.click()" [disabled]="busy()">
            {{ preview() ? 'Другое фото' : 'Фото оффера' }}
          </button>
          <input #picker type="file" accept="image/png,image/jpeg,image/webp" hidden (change)="pick(picker)" />
        </div>
        <div class="grid">
          <label class="wide">
            <span>Название *</span>
            <input [(ngModel)]="f.name" maxlength="120" />
          </label>
          <label>
            <span>Вертикаль</span>
            <input [(ngModel)]="f.vertical" maxlength="80" list="offer-verticals" />
            <datalist id="offer-verticals">
              @for (v of data.verticals; track v) {
                <option [value]="v"></option>
              }
            </datalist>
          </label>
          <label>
            <span>Гео</span>
            <select [(ngModel)]="f.geo">
              <option value="">—</option>
              @for (c of countries; track c[0]) {
                <option [value]="c[0]">{{ c[0] }} · {{ c[1] }}</option>
              }
            </select>
          </label>
          <label>
            <span>ПП (партнёрка)</span>
            <input [(ngModel)]="f.partner" maxlength="80" list="offer-partners" />
            <datalist id="offer-partners">
              @for (p of data.partners; track p) {
                <option [value]="p"></option>
              }
            </datalist>
          </label>
          <label>
            <span>Капа, лидов в день</span>
            <input type="number" min="0" step="1" [(ngModel)]="f.cap" />
          </label>
          <label>
            <span>Выплата</span>
            <div class="pair">
              <input type="number" min="0" step="0.01" [(ngModel)]="f.payout" />
              <select [(ngModel)]="f.payoutCurrency">
                @for (c of currencies; track c) {
                  <option [value]="c">{{ c }}</option>
                }
              </select>
            </div>
          </label>
          <label>
            <span>Гарант, % лидов</span>
            <input type="number" min="0" max="100" step="1" [(ngModel)]="f.guarantee" />
          </label>
          <label>
            <span>Цена на ленде</span>
            <input [(ngModel)]="f.landPrice" maxlength="80" placeholder="Например: 990 MXN" />
          </label>
          <label>
            <span>Режим КЦ</span>
            <input [(ngModel)]="f.ccMode" maxlength="200" placeholder="Например: 9–21 по местному, без выходных" />
          </label>
          <label>
            <span>Язык КЦ</span>
            <input [(ngModel)]="f.ccLanguage" maxlength="80" />
          </label>
          <label class="wide">
            <span>Исключения по регионам</span>
            <textarea rows="2" [(ngModel)]="f.regionExclusions" maxlength="2000"></textarea>
          </label>
          <label class="wide">
            <span>Бриф / состав</span>
            <textarea rows="6" [(ngModel)]="f.brief" maxlength="20000"></textarea>
          </label>
          <label class="check wide">
            <input type="checkbox" [(ngModel)]="f.active" />
            <span>Оффер активен (выключенные скрыты из списка по умолчанию)</span>
          </label>
        </div>
      </div>
      @if (error(); as e) {
        <div class="error">{{ e }}</div>
      }
    </mat-dialog-content>
    <mat-dialog-actions>
      @if (data.offer) {
        <button mat-button class="danger" (click)="remove()" [disabled]="busy()"><mat-icon>delete</mat-icon>Удалить</button>
      }
      <span class="spacer"></span>
      <button mat-button mat-dialog-close [disabled]="busy()">Отмена</button>
      <button mat-flat-button (click)="save()" [disabled]="busy() || !f.name.trim()">Сохранить</button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .form {
        display: flex;
        gap: 20px;
        flex-wrap: wrap;
        align-items: flex-start;
      }
      .photo-box {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        width: 150px;
      }
      .photo-box img,
      .photo-box > mat-icon {
        width: 150px;
        height: 150px;
        object-fit: contain;
        border-radius: 8px;
        background: var(--surface-2);
      }
      .photo-box > mat-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 40px;
        color: var(--text-faint);
      }
      .grid {
        flex: 1;
        min-width: 260px;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px 14px;
      }
      @media (max-width: 640px) {
        .grid {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .wide {
        grid-column: 1 / -1;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 12px;
        color: var(--text-muted);
        min-width: 0;
      }
      input:not([type='checkbox']),
      select,
      textarea {
        width: 100%;
        box-sizing: border-box;
        padding: 8px 10px;
        border: 1px solid var(--divider-strong);
        border-radius: 8px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        font-size: 14px;
      }
      textarea {
        resize: vertical;
        line-height: 1.5;
      }
      input:focus,
      select:focus,
      textarea:focus {
        outline: 2px solid var(--ring);
      }
      .pair {
        display: flex;
        gap: 6px;
      }
      .pair select {
        width: 90px;
        flex: none;
      }
      .check {
        flex-direction: row;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        color: var(--text);
      }
      .error {
        margin-top: 12px;
        color: var(--danger);
        font-size: 13px;
      }
      .spacer {
        flex: 1;
      }
      .danger {
        color: var(--danger);
      }
    `,
  ],
})
export class OfferEditDialog {
  private readonly api = inject(ApiService);
  private readonly ref = inject(MatDialogRef<OfferEditDialog, Offer | 'deleted'>);
  readonly data = inject<OfferEditData>(MAT_DIALOG_DATA);

  readonly countries = Object.entries(COUNTRIES).sort((a, b) => a[0].localeCompare(b[0]));
  readonly currencies = OFFER_CURRENCIES;

  readonly f: OfferInput = this.data.offer
    ? (({ photoUrl: _p, updatedAt: _u, updatedBy: _b, ...rest }) => rest)(this.data.offer)
    : {
        name: '',
        vertical: '',
        geo: '',
        partner: '',
        cap: null,
        payout: null,
        payoutCurrency: 'USD',
        landPrice: '',
        guarantee: null,
        brief: '',
        ccMode: '',
        ccLanguage: '',
        regionExclusions: '',
        active: true,
      };

  private photo: File | null = null;
  readonly preview = signal<string | null>(this.data.offer?.photoUrl ?? null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  pick(el: HTMLInputElement): void {
    const file = el.files?.[0];
    el.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      this.error.set('Фото больше 10 МБ.');
      return;
    }
    this.photo = file;
    this.preview.set(URL.createObjectURL(file));
  }

  async save(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      let saved = await this.api.offers.save(this.f);
      if (this.photo) saved = await this.api.offers.uploadPhoto(saved.id, this.photo);
      this.ref.close(saved);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
      this.busy.set(false);
    }
  }

  async remove(): Promise<void> {
    const o = this.data.offer;
    if (!o || !confirm(`Удалить оффер «${o.name}»? Если он просто не льётся — лучше снять галочку «активен».`)) return;
    this.busy.set(true);
    try {
      await this.api.offers.delete(o.id);
      this.ref.close('deleted');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
      this.busy.set(false);
    }
  }
}
