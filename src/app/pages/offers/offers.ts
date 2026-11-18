import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ActivatedRoute, Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ApiService } from '../../core/services/api.service';
import { countryName } from '../../../shared/geo';
import { money, OfferEditDialog, OfferViewDialog, type OfferEditData, type OfferViewData } from './offer-dialogs';
import type { Offer } from '../../../shared/api.types';

/** Офферы: the hand-kept registry. Everyone with the section reads; `offersEdit` adds and changes. */
@Component({
  selector: 'app-offers',
  imports: [FormsModule, MatButtonModule, MatIconModule, MatProgressBarModule],
  template: `
    <header class="page-header">
      <div>
        <h1>Офферы</h1>
        <p>Условия по офферам: капа, выплата, гарант, КЦ и исключения. Нажми на строку — откроется карточка с брифом.</p>
      </div>
      @if (canEdit()) {
        <button mat-flat-button (click)="edit()"><mat-icon>add</mat-icon>Добавить оффер</button>
      }
    </header>

    @if (!loaded()) {
      <mat-progress-bar mode="indeterminate" />
    } @else {
      <div class="toolbar">
        <input class="search" type="search" placeholder="Поиск: название, ПП, бриф" [ngModel]="query()" (ngModelChange)="query.set($event)" />
        <select [ngModel]="vertical()" (ngModelChange)="vertical.set($event)">
          <option value="">Все вертикали</option>
          @for (v of verticals(); track v) {
            <option [value]="v">{{ v }}</option>
          }
        </select>
        <select [ngModel]="geo()" (ngModelChange)="geo.set($event)">
          <option value="">Все гео</option>
          @for (g of geos(); track g) {
            <option [value]="g">{{ g }} · {{ country(g) }}</option>
          }
        </select>
        <label class="check">
          <input type="checkbox" [ngModel]="showOff()" (ngModelChange)="showOff.set($event)" />
          выключенные ({{ offCount() }})
        </label>
      </div>

      @if (!rows().length) {
        <div class="empty">
          <mat-icon>local_offer</mat-icon>
          <div>{{ offers().length ? 'Ничего не нашлось.' : 'Офферов пока нет.' + (canEdit() ? ' Нажми «Добавить оффер».' : '') }}</div>
        </div>
      } @else {
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Оффер</th>
                <th>Вертикаль</th>
                <th>Гео</th>
                <th class="num">Выплата</th>
                <th class="num">Капа</th>
                <th class="num">Гарант</th>
                <th>Цена на ленде</th>
                <th>КЦ</th>
              </tr>
            </thead>
            <tbody>
              @for (o of rows(); track o.id) {
                <tr [class.off]="!o.active" (click)="open(o)" tabindex="0" (keydown.enter)="open(o)">
                  <td class="thumb">
                    @if (o.photoUrl) {
                      <img [src]="o.photoUrl" alt="" loading="lazy" />
                    }
                  </td>
                  <td>
                    <div class="name">{{ o.name }}</div>
                    @if (o.partner) {
                      <div class="sub">{{ o.partner }}</div>
                    }
                  </td>
                  <td>{{ o.vertical || '—' }}</td>
                  <td>{{ o.geo || '—' }}</td>
                  <td class="num">{{ pay(o) }}</td>
                  <td class="num">{{ o.cap ?? '—' }}</td>
                  <td class="num">{{ o.guarantee !== null ? o.guarantee + '%' : '—' }}</td>
                  <td>{{ o.landPrice || '—' }}</td>
                  <td>
                    {{ o.ccLanguage || '—' }}
                    @if (o.ccMode) {
                      <div class="sub">{{ o.ccMode }}</div>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
        margin-bottom: 16px;
      }
      .search,
      select {
        padding: 8px 12px;
        border: 1px solid var(--divider-strong);
        border-radius: 8px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        font-size: 13px;
      }
      .search {
        flex: 1;
        min-width: 200px;
        max-width: 360px;
      }
      .check {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        color: var(--text-muted);
      }
      .table-wrap {
        overflow-x: auto;
        border: 1px solid var(--divider);
        border-radius: 10px;
        background: var(--surface);
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      th {
        padding: 10px 12px;
        text-align: left;
        font-weight: 500;
        font-size: 12px;
        color: var(--text-muted);
        border-bottom: 1px solid var(--divider);
        white-space: nowrap;
      }
      td {
        padding: 8px 12px;
        border-top: 1px solid var(--divider);
        color: var(--text);
        vertical-align: middle;
      }
      tbody tr:first-child td {
        border-top: 0;
      }
      tbody tr {
        cursor: pointer;
      }
      tbody tr:hover {
        background: var(--surface-2);
      }
      tr.off td {
        color: var(--text-faint);
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .thumb {
        width: 44px;
        padding-right: 0;
      }
      .thumb img {
        display: block;
        width: 40px;
        height: 40px;
        object-fit: contain;
        border-radius: 6px;
        background: var(--surface-2);
      }
      .name {
        font-weight: 500;
      }
      .sub {
        font-size: 12px;
        color: var(--text-faint);
      }
      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        padding: 48px 16px;
        color: var(--text-muted);
        text-align: center;
      }
    `,
  ],
})
export class OffersPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly canEdit = computed(() => this.api.can('offersEdit'));
  readonly offers = signal<Offer[]>([]);
  readonly loaded = signal(false);
  readonly query = signal('');
  readonly vertical = signal('');
  readonly geo = signal('');
  readonly showOff = signal(false);
  /** Library verticals, offered as suggestions in the form. */
  private readonly libraryVerticals = signal<string[]>([]);
  /** ПП from Keitaro, offered in the form. */
  private readonly keitaroPartners = signal<string[]>([]);

  readonly country = countryName;
  readonly pay = money;

  /** Library verticals plus whatever offers already carry — the filter and the form share it. */
  readonly verticals = computed(() => uniq([...this.libraryVerticals(), ...this.offers().map((o) => o.vertical)]));
  readonly geos = computed(() => uniq(this.offers().map((o) => o.geo)));
  readonly offCount = computed(() => this.offers().filter((o) => !o.active).length);

  readonly rows = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.offers().filter(
      (o) =>
        (this.showOff() || o.active) &&
        (!this.vertical() || o.vertical === this.vertical()) &&
        (!this.geo() || o.geo === this.geo()) &&
        (!q || `${o.name} ${o.partner} ${o.brief} ${o.vertical}`.toLowerCase().includes(q)),
    );
  });

  async ngOnInit(): Promise<void> {
    await this.reload();
    // A link from a notification: /offers?open=12 opens that card.
    this.route.queryParamMap.subscribe((q) => {
      const id = Number(q.get('open'));
      if (!id) return;
      void this.router.navigate([], { queryParams: { open: null }, replaceUrl: true });
      const offer = this.offers().find((o) => o.id === id);
      if (offer) void this.open(offer);
      else this.snack.open('Этого оффера уже нет.', 'OK', { duration: 4000 });
    });
    try {
      this.libraryVerticals.set((await this.api.library.verticals()).map((v) => v.name).filter(Boolean));
    } catch {
      /* no library access: the filter falls back to the offers' own verticals */
    }
    if (this.canEdit()) {
      this.api.offers.partners().then(
        (p) => this.keitaroPartners.set(p),
        () => undefined,
      );
    }
  }

  async reload(): Promise<void> {
    try {
      this.offers.set(await this.api.offers.list());
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
    } finally {
      this.loaded.set(true);
    }
  }

  async open(offer: Offer): Promise<void> {
    const ref = this.dialog.open<OfferViewDialog, OfferViewData, 'edit' | 'copy'>(OfferViewDialog, {
      data: { offer, canEdit: this.canEdit() },
      width: '720px',
      maxWidth: '95vw',
      autoFocus: false,
    });
    const action = await firstValueFrom(ref.afterClosed());
    if (action === 'edit') await this.edit(offer);
    if (action === 'copy') await this.edit(undefined, offer);
  }

  async edit(offer?: Offer, copyFrom?: Offer): Promise<void> {
    const data: OfferEditData = {
      offer,
      copyFrom,
      verticals: this.verticals(),
      partners: uniq([...this.keitaroPartners(), ...this.offers().map((o) => o.partner)]),
    };
    const ref = this.dialog.open<OfferEditDialog, OfferEditData, Offer | 'deleted'>(OfferEditDialog, {
      data,
      width: '860px',
      maxWidth: '95vw',
      autoFocus: false,
      disableClose: true,
    });
    if (await firstValueFrom(ref.afterClosed())) await this.reload();
  }
}

function uniq(list: string[]): string[] {
  return [...new Set(list.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
}
