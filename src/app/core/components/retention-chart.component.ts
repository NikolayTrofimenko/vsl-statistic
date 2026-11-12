import {
  Component,
  computed,
  ElementRef,
  inject,
  input,
  OnDestroy,
  OnInit,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { formatDuration, formatPercent } from '../format';
import type { RetentionPoint } from '../../../shared/api.types';

export interface ChartMarker {
  sec: number;
  label: string;
}

const HEIGHT = 300;
const M = { top: 22, right: 16, bottom: 28, left: 44 };
const X_STEPS = [10, 30, 60, 120, 300, 600, 900, 1800, 3600];
const MAX_X_TICKS = 9;

/**
 * Audience retention: for every second of the video, the share of plays that
 * actually watched it. Optional second series — the same curve for viewers
 * who later submitted the form — shows where buyers and leavers part ways.
 *
 * Plain SVG: one axis (share, 0–100%), a crosshair that snaps to the second
 * under the pointer, vertical markers for moments such as the popup, and a
 * per-minute table as the non-visual view of the same data.
 */
@Component({
  selector: 'app-retention-chart',
  imports: [MatButtonModule],
  template: `
    <div class="head">
      @if (hasSecond()) {
        <div class="legend">
          <span class="key"><i class="line s1"></i>Все запуски</span>
          <span class="key"><i class="line s2"></i>Оставили заявку</span>
        </div>
      } @else {
        <span></span>
      }
      <button mat-button class="toggle" (click)="showTable.set(!showTable())">
        {{ showTable() ? 'График' : 'Таблица' }}
      </button>
    </div>

    @if (showTable()) {
      <div class="table-wrap">
        <table class="data mono">
          <thead>
            <tr>
              <th>Минута</th>
              <th>Смотрят</th>
              <th>Доля</th>
              @if (hasSecond()) {
                <th>Доля (заявки)</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of perMinute(); track row.sec) {
              <tr>
                <td>{{ time(row.sec) }}</td>
                <td>{{ row.viewers }}</td>
                <td>{{ pct(row.share) }}</td>
                @if (hasSecond()) {
                  <td>{{ pct(row.submitShare) }}</td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
    } @else {
      <div class="plot" (pointerleave)="hover.set(null)">
        <svg
          [attr.width]="width()"
          [attr.height]="height"
          [attr.viewBox]="'0 0 ' + width() + ' ' + height"
          tabindex="0"
          role="img"
          [attr.aria-label]="ariaLabel()"
          (pointermove)="onPointer($event)"
          (keydown)="onKey($event)"
          (blur)="hover.set(null)"
        >
          <!-- grid + y axis -->
          @for (t of yTicks; track t) {
            <line class="grid" [attr.x1]="m.left" [attr.x2]="width() - m.right" [attr.y1]="y(t)" [attr.y2]="y(t)" />
            <text class="tick" [attr.x]="m.left - 8" [attr.y]="y(t)" dy="0.32em" text-anchor="end">{{ t * 100 }}%</text>
          }
          <!-- x axis -->
          @for (t of xTicks(); track t) {
            <text class="tick" [attr.x]="x(t)" [attr.y]="height - 8" text-anchor="middle">{{ time(t) }}</text>
          }

          <!-- markers -->
          @for (mk of visibleMarkers(); track mk.sec) {
            <line class="marker" [attr.x1]="x(mk.sec)" [attr.x2]="x(mk.sec)" [attr.y1]="m.top - 6" [attr.y2]="height - m.bottom" />
            <text class="marker-label" [attr.x]="x(mk.sec) + 4" [attr.y]="m.top - 8">{{ mk.label }} · {{ time(mk.sec) }}</text>
          }

          <path class="area" [attr.d]="areaPath()" />
          <path class="line s1" [attr.d]="linePath()" />
          @if (hasSecond()) {
            <path class="line s2" [attr.d]="secondPath()" />
          }

          @if (hovered(); as h) {
            <line class="crosshair" [attr.x1]="x(h.sec)" [attr.x2]="x(h.sec)" [attr.y1]="m.top" [attr.y2]="height - m.bottom" />
            <circle class="dot s1" [attr.cx]="x(h.sec)" [attr.cy]="y(h.share)" r="4" />
            @if (h.submitShare !== null && hasSecond()) {
              <circle class="dot s2" [attr.cx]="x(h.sec)" [attr.cy]="y(h.submitShare)" r="4" />
            }
          }
        </svg>

        @if (hovered(); as h) {
          <div class="tooltip" [style.left.px]="tooltipLeft()" [style.top.px]="m.top">
            <div class="tt-time mono">{{ time(h.sec) }}</div>
            <div class="tt-row">
              <i class="line s1"></i><strong>{{ pct(h.share) }}</strong>
              <span>смотрят ({{ h.viewers }})</span>
            </div>
            @if (hasSecond() && h.submitShare !== null) {
              <div class="tt-row">
                <i class="line s2"></i><strong>{{ pct(h.submitShare) }}</strong>
                <span>из оставивших заявку</span>
              </div>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        position: relative;
      }
      .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-height: 32px;
      }
      .legend {
        display: flex;
        gap: 16px;
        font-size: 12px;
        color: var(--text-muted);
      }
      .key {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      i.line {
        display: inline-block;
        width: 14px;
        height: 2px;
        border-radius: 1px;
      }
      i.line.s1 {
        background: var(--chart-1);
      }
      i.line.s2 {
        background: var(--chart-2);
      }
      .toggle {
        font-size: 12px;
      }
      .plot {
        position: relative;
      }
      svg {
        display: block;
        outline: none;
        touch-action: pan-y;
      }
      svg:focus-visible {
        outline: 1px solid var(--ring);
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
      path.line {
        fill: none;
        stroke-width: 2;
        stroke-linejoin: round;
        stroke-linecap: round;
      }
      path.line.s1 {
        stroke: var(--chart-1);
      }
      path.line.s2 {
        stroke: var(--chart-2);
      }
      .area {
        fill: var(--chart-1);
        opacity: 0.1;
      }
      .marker {
        stroke: var(--chart-marker);
        stroke-width: 1;
      }
      .marker-label {
        fill: var(--text-muted);
        font-size: 11px;
      }
      .crosshair {
        stroke: var(--text-faint);
        stroke-width: 1;
      }
      circle.dot {
        stroke: var(--surface);
        stroke-width: 2;
      }
      circle.dot.s1 {
        fill: var(--chart-1);
      }
      circle.dot.s2 {
        fill: var(--chart-2);
      }
      .tooltip {
        position: absolute;
        pointer-events: none;
        background: var(--surface-3);
        border: 1px solid var(--divider-strong);
        padding: 8px 10px;
        font-size: 12px;
        min-width: 170px;
        z-index: 2;
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
      .table-wrap {
        max-height: 320px;
        overflow: auto;
      }
      table.data {
        border-collapse: collapse;
        width: 100%;
        font-size: 12px;

        th,
        td {
          text-align: right;
          padding: 4px 10px;
          border-bottom: 1px solid var(--divider);
        }
        th:first-child,
        td:first-child {
          text-align: left;
        }
        th {
          color: var(--text-faint);
          font-weight: 400;
          position: sticky;
          top: 0;
          background: var(--surface);
        }
      }
    `,
  ],
})
export class RetentionChartComponent implements OnInit, OnDestroy {
  readonly points = input.required<RetentionPoint[]>();
  readonly markers = input<ChartMarker[]>([]);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private observer: ResizeObserver | null = null;

  readonly m = M;
  readonly height = HEIGHT;
  readonly yTicks = [0, 0.25, 0.5, 0.75, 1];
  readonly width = signal(800);
  readonly hover = signal<number | null>(null);
  readonly showTable = signal(false);

  readonly time = formatDuration;
  readonly pct = (v: number | null) => formatPercent(v, 0);

  private readonly length = computed(() => Math.max(1, this.points().length));
  readonly hasSecond = computed(() => this.points().some((p) => p.submitShare !== null));
  readonly hovered = computed(() => {
    const sec = this.hover();
    return sec === null ? null : (this.points()[sec] ?? null);
  });

  readonly xTicks = computed(() => {
    const len = this.length();
    const step = X_STEPS.find((s) => len / s <= MAX_X_TICKS) ?? 3600;
    const ticks: number[] = [];
    for (let t = 0; t <= len; t += step) ticks.push(t);
    return ticks;
  });

  readonly visibleMarkers = computed(() =>
    this.markers().filter((mk) => mk.sec >= 0 && mk.sec <= this.length()),
  );

  /** One vertex per horizontal pixel at most — a 50-minute VSL has 3000 seconds. */
  private readonly sampled = computed(() => {
    const pts = this.points();
    const plotW = this.width() - M.left - M.right;
    if (pts.length <= plotW) return pts;
    const out: RetentionPoint[] = [];
    for (let i = 0; i < plotW; i++) out.push(pts[Math.round((i * (pts.length - 1)) / (plotW - 1))]!);
    return out;
  });

  readonly linePath = computed(() => this.path((p) => p.share));
  readonly secondPath = computed(() => this.path((p) => p.submitShare ?? 0));
  readonly areaPath = computed(() => {
    const pts = this.sampled();
    if (!pts.length) return '';
    const base = this.y(0);
    return `${this.path((p) => p.share)} L${this.x(pts[pts.length - 1]!.sec)},${base} L${this.x(pts[0]!.sec)},${base} Z`;
  });

  readonly perMinute = computed(() => this.points().filter((p) => p.sec % 60 === 0));

  readonly tooltipLeft = computed(() => {
    const h = this.hovered();
    if (!h) return 0;
    const px = this.x(h.sec);
    // Flip to the left of the crosshair near the right edge.
    return px > this.width() - 200 ? px - 190 : px + 12;
  });

  readonly ariaLabel = computed(() => {
    const pts = this.points();
    const at = (share: number) => pts.find((p) => p.share <= share)?.sec;
    const half = at(0.5);
    return `Удержание аудитории. Половина зрителей уходит к ${half === undefined ? 'концу видео' : formatDuration(half)}.`;
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

  x(sec: number): number {
    return M.left + (sec / this.length()) * (this.width() - M.left - M.right);
  }

  y(share: number): number {
    return M.top + (1 - share) * (HEIGHT - M.top - M.bottom);
  }

  onPointer(event: PointerEvent): void {
    const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
    const plotW = this.width() - M.left - M.right;
    const ratio = (event.clientX - rect.left - M.left) / plotW;
    const sec = Math.round(Math.min(1, Math.max(0, ratio)) * (this.length() - 1));
    this.hover.set(sec);
  }

  onKey(event: KeyboardEvent): void {
    const step = event.shiftKey ? 60 : 5;
    const current = this.hover() ?? 0;
    if (event.key === 'ArrowRight') this.hover.set(Math.min(this.length() - 1, current + step));
    else if (event.key === 'ArrowLeft') this.hover.set(Math.max(0, current - step));
    else return;
    event.preventDefault();
  }

  private path(value: (p: RetentionPoint) => number): string {
    return this.sampled()
      .map((p, i) => `${i ? 'L' : 'M'}${this.x(p.sec).toFixed(1)},${this.y(value(p)).toFixed(1)}`)
      .join(' ');
  }
}
