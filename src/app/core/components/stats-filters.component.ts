import { Component, inject, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { StatsFilterService, RangePreset } from '../services/stats-filter.service';
import type { StatsFacets } from '../../../shared/api.types';
import { NONE, orNull } from '../select';

/** One row of filters above the stats: period first, then segments. */
@Component({
  selector: 'app-stats-filters',
  imports: [FormsModule, MatButtonToggleModule, MatFormFieldModule, MatInputModule, MatSelectModule],
  template: `
    <div class="row">
      <mat-button-toggle-group
        [value]="f.preset()"
        (change)="f.setPreset($any($event.value))"
        aria-label="Период"
      >
        @for (p of presets; track p.value) {
          <mat-button-toggle [value]="p.value">{{ p.label }}</mat-button-toggle>
        }
      </mat-button-toggle-group>

      <mat-form-field class="date">
        <mat-label>С</mat-label>
        <input matInput type="date" [ngModel]="f.from()" (ngModelChange)="f.setRange($event, f.to())" />
      </mat-form-field>
      <mat-form-field class="date">
        <mat-label>По</mat-label>
        <input matInput type="date" [ngModel]="f.to()" (ngModelChange)="f.setRange(f.from(), $event)" />
      </mat-form-field>

      @if (showLand()) {
        <mat-form-field class="select wide">
          <mat-label>Ленд</mat-label>
          <mat-select [ngModel]="f.land() ?? NONE" (ngModelChange)="f.land.set(orNull($event))">
            <mat-option [value]="NONE">Все</mat-option>
            @for (v of facets()?.lands ?? []; track v) {
              <mat-option [value]="v">{{ v }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      }
      <mat-form-field class="select">
        <mat-label>Устройство</mat-label>
        <mat-select [ngModel]="f.device() ?? NONE" (ngModelChange)="f.device.set(orNull($event))">
          <mat-option [value]="NONE">Все</mat-option>
          @for (v of facets()?.devices ?? []; track v) {
            <mat-option [value]="v">{{ v }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field class="select">
        <mat-label>Гео</mat-label>
        <mat-select [ngModel]="f.country() ?? NONE" (ngModelChange)="f.country.set(orNull($event))">
          <mat-option [value]="NONE">Все</mat-option>
          @for (v of facets()?.countries ?? []; track v) {
            <mat-option [value]="v">{{ v }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field class="select">
        <mat-label>Баер</mat-label>
        <mat-select [ngModel]="f.buyer() ?? NONE" (ngModelChange)="f.buyer.set(orNull($event))">
          <mat-option [value]="NONE">Все</mat-option>
          @for (v of facets()?.buyers ?? []; track v) {
            <mat-option [value]="v">{{ v }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
    </div>
  `,
  styles: [
    `
      .row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
        margin-bottom: 16px;
      }
      .date {
        width: 140px;
      }
      .select {
        width: 120px;
      }
      .select.wide {
        width: 200px;
      }
    `,
  ],
})
export class StatsFiltersComponent {
  readonly NONE = NONE;
  readonly orNull = orNull;
  readonly f = inject(StatsFilterService);
  readonly facets = input<StatsFacets | null>(null);
  readonly showLand = input(true);

  readonly presets: { value: RangePreset; label: string }[] = [
    { value: 'today', label: 'Сегодня' },
    { value: '7d', label: '7 дней' },
    { value: '30d', label: '30 дней' },
    { value: '90d', label: '90 дней' },
  ];
}
