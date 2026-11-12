/**
 * How a landing and its video are identified in the stats.
 *
 * Both values come from the browser and both have a failure mode seen in the
 * wild, so they are normalised once here — for live beacons and for rows
 * stored before the tracker learned to avoid them.
 */

/** The install snippet's placeholder, pasted unedited onto real landings. */
const LAND_PLACEHOLDER = 'LAND-NAME';

/**
 * Landing name: the `data-land` value, or host + path when it is missing or
 * still the snippet's placeholder (or an unfilled `{macro}`).
 */
export function normalizeLand(land: string, page: string | null): string {
  const value = land.trim();
  if (value && value !== LAND_PLACEHOLDER && !value.includes('{')) return value;
  if (!page) return value || 'unknown';
  return page.replace(/index\.(html?|php)$/, '').slice(0, 200);
}

/**
 * Stream URL. Players built on Media Source Extensions (hls.js) expose a
 * `blob:` URL that is new on every page load, so it identifies nothing; such
 * views are folded into one "unresolved stream" per landing host instead of
 * creating a new video per visit.
 */
export function normalizeSrc(src: string): string {
  if (!src.startsWith('blob:')) return src;
  try {
    return `blob:${new URL(src.slice(5)).host}`;
  } catch {
    return 'blob:unknown';
  }
}

export function isUnresolvedSrc(src: string): boolean {
  return src.startsWith('blob:');
}

/** Comparison key for stream URLs: case, query string and trailing slash ignored. */
export function urlKey(url: string): string {
  return url.trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
}
