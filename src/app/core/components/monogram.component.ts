import { Component, input } from '@angular/core';

/**
 * The EUPHORIA monogram.
 *
 * Geometry copied verbatim from `EUPHORIA_Avatar_Kit/svg/EUPHORIA_E_Master.svg`
 * — the brandbook forbids redrawing, stretching or outlining it, so the two
 * polygons are reproduced point for point and the viewBox does the scaling.
 *
 * Painted with `currentColor` rather than the kit's baked-in ivory, so the mark
 * follows the surface it sits on and works in both themes without a second
 * copy of the file.
 */
@Component({
  selector: 'app-monogram',
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 1000 1000"
      role="img"
      aria-label="EUPHORIA"
      focusable="false"
    >
      <polygon
        points="230,120 800,120 730,250 420,250 420,420 660,420 600,540 420,540 420,750 800,750 730,880 230,880"
        fill="currentColor"
      />
      <polygon points="140,120 260,120 260,880 140,880" fill="currentColor" />
    </svg>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        line-height: 0;
      }
    `,
  ],
})
export class MonogramComponent {
  readonly size = input(24);
}
