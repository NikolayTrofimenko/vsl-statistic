import type { DashPeriod, DashPeriodKind } from '../../src/shared/dashboard.types';

/** Weeks (Mon–Sun) and months in Moscow time, the dashboard's only calendar. */

export const TZ = 'Europe/Moscow';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/**
 * One formatter for the whole process: building an Intl.DateTimeFormat per
 * call allocates ICU memory outside the JS heap — thousands of card moves took
 * the 512 MB container down.
 */
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** YYYY-MM-DD in Moscow. */
export function dayIn(at: Date | string): string {
  return DAY_FORMAT.format(typeof at === 'string' ? new Date(at) : at);
}

export function today(): string {
  return dayIn(new Date());
}

export function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** The week (Mon–Sun) or month holding `anchor`, moved by `shift` periods. */
export function periodOf(kind: DashPeriodKind, anchor: string, shift = 0): DashPeriod {
  const now = today();
  let from: string;
  let to: string;
  if (kind === 'week') {
    const d = new Date(`${anchor}T12:00:00Z`);
    from = shiftDay(anchor, -((d.getUTCDay() + 6) % 7) + shift * 7);
    to = shiftDay(from, 6);
  } else {
    const [y, m] = anchor.split('-').map(Number) as [number, number];
    const first = new Date(Date.UTC(y, m - 1 + shift, 1, 12));
    from = first.toISOString().slice(0, 10);
    to = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12)).toISOString().slice(0, 10);
  }
  const current = from <= now && now <= to;
  return { kind, from, to, label: labelOf(kind, from, current ? now : to, current), current };
}

/** A running period is labelled up to today — its future days hold nothing. */
function labelOf(kind: DashPeriodKind, from: string, to: string, current: boolean): string {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [, tm, td] = to.split('-').map(Number) as [number, number, number];
  if (kind === 'month') return current ? `${MONTH_NAMES[fm - 1]} ${fy} · по ${td}-е` : `${MONTH_NAMES[fm - 1]} ${fy}`;
  if (current && from === to) return `${fd} ${MONTHS[fm - 1]}, сегодня`;
  return fm === tm ? `${fd}–${td} ${MONTHS[fm - 1]}` : `${fd} ${MONTHS_SHORT[fm - 1]} – ${td} ${MONTHS_SHORT[tm - 1]}`;
}

/** A sparkline bar's label: "3–9 ноя" / "27 окт – 2 ноя" / "окт 2026"; the running one says so. */
export function shortLabel(p: DashPeriod): string {
  const [fy, m, d] = p.from.split('-').map(Number) as [number, number, number];
  const now = p.current ? ' (сейчас)' : '';
  if (p.kind === 'month') return `${MONTHS_SHORT[m - 1]} ${fy}${now}`;
  const [, tm, td] = p.to.split('-').map(Number) as [number, number, number];
  return (m === tm ? `${d}–${td} ${MONTHS_SHORT[m - 1]}` : `${d} ${MONTHS_SHORT[m - 1]} – ${td} ${MONTHS_SHORT[tm - 1]}`) + now;
}

/** The last day a snapshot can be taken for: the period's end, or today while it runs. */
export function endOf(p: DashPeriod): string {
  const now = today();
  return p.to < now ? p.to : now;
}

export function inside(day: string | null | undefined, p: DashPeriod): boolean {
  return day != null && p.from <= day && day <= p.to;
}

/** "27.10". */
export function fmtDay(day: string | null | undefined): string | null {
  if (!day) return null;
  const [, m, d] = day.split('-');
  return `${d}.${m}`;
}
