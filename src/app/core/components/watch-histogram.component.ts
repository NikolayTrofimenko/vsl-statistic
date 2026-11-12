import { Component, computed, ElementRef, inject, input, OnDestroy, OnInit, signal } from '@angular/core';
import { formatDuration } from '../format';

export interface HistogramBucket {
  fromSec: number;
  plays: number;
  submits: number;
}

const HEIGHT = 220;
const M = { top: 12, right: 12, bottom: 28, left: 44 };
const MAX_BAR = 24;
const GAP = 2;

/**
 * How long people watched: plays grouped by total watched time, with the
 * plays that ended in a form submit beside them. Each bucket column is its
 * own hover target.
 */
@Component({
  selector: 'app-watch-histogram',
  template: `
    <div class="legend">
      <span class="key"><i class="sw s1"></i>Запуски</span>
      <span class="key"><i class="sw s2"></i>Из них оставили заявку</span>
    </div>
    <div class="plot" (pointerleave)="hover.set(null)">
      <svg [attr.width]="width()" [attr.height]="height" role="img" aria-label="Распределение времени просмотра">
        @for (t of yTicks(); track t) {
          <line class="grid" [attr.x1]="m.left" [attr.x2]="width() - m.right" [attr.y1]="y(t)" [attr.y2]="y(t)" />
          <text class="tick" [attr.x]="m.left - 8" [attr.y]="y(t)" dy="0.32em" text-anchor="end">{{ t }}</text>
        }
        @for (b of bars(); track b.fromSec; let i = $index) {
          @if (i % labelEvery() === 0) {
            <text class="tick" [attr.x]="b.cx" [attr.y]="height - 8" text-anchor="middle">{{ time(b.fromSec) }}</text>
          }
          <rect
            class="hit"
            [class.active]="hover() === i"
            [attr.x]="b.x0"
            [attr.y]="m.top"
            [attr.width]="b.slot"
            [attr.height]="height - m.top - m.bottom"
            (pointerenter)="hover.set(i)"
          />
          @if (b.plays > 0) {
            <path class="bar s1" [attr.d]="barPath(b.x1, b.w, b.plays)" />
          }
          @if (b.submits > 0) {
            <path class="bar s2" [attr.d]="barPath(b.x2, b.w, b.submits)" />
          }
        }
      </svg>
      @if (hovered(); as h) {
        <div class="tooltip" [style.left.px]="h.tipX">
          <div class="tt-time mono">{{ time(h.fromSec) }} – {{ time(h.fromSec + bucketSec()) }}</div>
          <div class="tt-row"><i class="sw s1"></i><strong>{{ h.plays }}</strong><span>запусков</span></div>
          <div class="tt-row"><i class="sw s2"></i><strong>{{ h.submits }}</strong><span>с заявкой</span></div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .legend {
        display: flex;
        gap: 16px;
        font-size: 12px;
        color: var(--text-muted);
        margin-bottom: 6px;
      }
      .key {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      i.sw {
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 2px;
      }
      .s1 {
        fill: var(--chart-1);
        background: var(--chart-1);
      }
      .s2 {
        fill: var(--chart-2);
        background: var(--chart-2);
      }
      .plot {
        position: relative;
      }
      svg {
        display: block;
      }
      .grid {
        stroke: var(--chart-grid);
        stroke-width: 1;
      }
      .tick {
        fill: var(--text-faint);
        font-family: var(--font-mono);
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
      }
      .hit {
        fill: transparent;
      }
      .hit.active {
        fill: var(--hover-strong);
      }
      .bar {
        pointer-events: none;
      }
      .tooltip {
        position: absolute;
        top: 8px;
        pointer-events: none;
        background: var(--surface-3);
        border: 1px solid var(--divider-strong);
        padding: 8px 10px;
        font-size: 12px;
        min-width: 140px;
      }
      .tt-time {
        color: var(--text-faint);
        margin-bottom: 4px;
      }
      .tt-row {
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--text-muted);

        strong {
          color: var(--text);
          font-weight: 600;
        }
      }
    `,
  ],
})
export class WatchHistogramComponent implements OnInit, OnDestroy {
  readonly buckets = input.required<HistogramBucket[]>();
  readonly bucketSec = input.required<number>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private observer: ResizeObserver | null = null;

  readonly m = M;
  readonly height = HEIGHT;
  readonly width = signal(800);
  readonly hover = signal<number | null>(null);
  readonly time = formatDuration;

  private readonly maxValue = computed(() => {
    const max = Math.max(1, ...this.buckets().map((b) => b.plays));
    // Round the axis up to a clean number: 1, 2, 5 × 10^n.
    const pow = 10 ** Math.floor(Math.log10(max));
    return [1, 2, 5, 10].map((k) => k * pow).find((v) => v >= max)!;
  });

  readonly yTicks = computed(() => {
    const max = this.maxValue();
    return [0, max / 4, max / 2, (max * 3) / 4, max].filter((v) => Number.isInteger(v));
  });

  readonly bars = computed(() => {
    const list = this.buckets();
    const slot = (this.width() - M.left - M.right) / Math.max(1, list.length);
    const w = Math.max(2, Math.min(MAX_BAR, (slot - GAP * 3) / 2));
    return list.map((b, i) => {
      const x0 = M.left + i * slot;
      const cx = x0 + slot / 2;
      return { ...b, x0, slot, cx, w, x1: cx - w - GAP / 2, x2: cx + GAP / 2 };
    });
  });

  readonly labelEvery = computed(() => Math.max(1, Math.ceil(this.buckets().length / 8)));

  readonly hovered = computed(() => {
    const i = this.hover();
    if (i === null) return null;
    const b = this.bars()[i];
    if (!b) return null;
    return { ...b, tipX: b.cx > this.width() - 170 ? b.cx - 160 : b.cx + 12 };
  });

  ngOnInit(): void {
    this.observer = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry?.contentRect.width ?? 0);
      if (w > 0) this.width.set(w);
    });
    this.observer.observe(this.host.nativeElement);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }

  y(value: number): number {
    return M.top + (1 - value / this.maxValue()) * (HEIGHT - M.top - M.bottom);
  }

  /** Column with a 4px rounded data end, square at the baseline. */
  barPath(x: number, w: number, value: number): string {
    const top = this.y(value);
    const base = this.y(0);
    const r = Math.min(4, w / 2, base - top);
    return `M${x},${base} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + w - r},${top} Q${x + w},${top} ${x + w},${top + r} L${x + w},${base} Z`;
  }
}
