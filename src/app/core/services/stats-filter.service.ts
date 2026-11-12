import { Injectable, computed, signal } from '@angular/core';
import { daysAgo, isoDay } from '../format';
import type { StatsFilter } from '../../../shared/api.types';

export type RangePreset = 'today' | '7d' | '30d' | '90d' | 'custom';

/**
 * Filter state shared by the overview and the detail page, so opening a
 * landing video keeps the period and segment you were looking at.
 */
@Injectable({ providedIn: 'root' })
export class StatsFilterService {
  readonly preset = signal<RangePreset>('7d');
  readonly from = signal(daysAgo(6));
  readonly to = signal(isoDay(new Date()));
  readonly land = signal<string | null>(null);
  readonly device = signal<string | null>(null);
  readonly country = signal<string | null>(null);
  readonly buyer = signal<string | null>(null);

  readonly filter = computed<StatsFilter>(() => ({
    from: this.from(),
    to: this.to(),
    land: this.land(),
    device: this.device(),
    country: this.country(),
    buyer: this.buyer(),
  }));

  setPreset(preset: RangePreset): void {
    this.preset.set(preset);
    const today = isoDay(new Date());
    const back = { today: 0, '7d': 6, '30d': 29, '90d': 89 } as const;
    if (preset !== 'custom') {
      this.from.set(daysAgo(back[preset]));
      this.to.set(today);
    }
  }

  setRange(from: string, to: string): void {
    this.preset.set('custom');
    this.from.set(from);
    this.to.set(to < from ? from : to);
  }
}
