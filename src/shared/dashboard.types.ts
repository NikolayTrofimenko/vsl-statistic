/** Company dashboard ("Дашборд"): blocks of metric tiles over a week or a month. */

export type DashPeriodKind = 'week' | 'month';

export interface DashPeriod {
  kind: DashPeriodKind;
  /** First day, YYYY-MM-DD (Moscow). */
  from: string;
  /** Last day, inclusive. */
  to: string;
  /** "27 окт – 2 ноя", "Октябрь 2026". */
  label: string;
  /** Today falls inside: the numbers are still growing. */
  current: boolean;
}

export interface DashPoint {
  label: string;
  value: number;
}

export interface DashMetric {
  id: string;
  label: string;
  /** live — counted from a source; pending — the source isn't connected yet. */
  status: 'live' | 'pending';
  /** "Kaiten · Найм", "Keitaro"; for pending — where it will come from. */
  source: string;
  unit: 'count' | 'money';
  value: number | null;
  previous: number | null;
  /** Older → newer, the shown period last. */
  series: DashPoint[];
  /** A line under the number: "2 медиабаера · 1 тимлид". */
  note?: string;
  /** Has a drill-down list (`dashboard:detail`). */
  detail: boolean;
  /** A state, not a flow: no period, no comparison ("сейчас на ИС"). */
  snapshot?: boolean;
}

export interface DashFunnelStage {
  label: string;
  count: number;
}

export interface DashSourceRow {
  source: string;
  responses: number;
  started: number;
  passed: number;
}

export interface DashBlock {
  id: string;
  title: string;
  metrics: DashMetric[];
}

export interface DashHiring {
  /** People who reached each stage in the period (a skipped stage still counts). */
  funnel: DashFunnelStage[];
  sources: DashSourceRow[];
  /** Of those who started probation in the period: how they're doing now. */
  cohort: { started: number; passed: number; failed: number; inProgress: number };
}

/** One buyer code: Keitaro money (null — no traffic) and Kaiten links over the period. */
export interface DashBuyingRow {
  buyer: string;
  revenue: number | null;
  cost: number | null;
  profit: number | null;
  /** %, null when there was no spend. */
  roi: number | null;
  /** Links that got a test verdict in the period. */
  tested: number;
  /** Of those, how many made it to scaling (ever). */
  hits: number;
  startedScaling: number;
  /** Links in МАСШТАБИРУЮ at the period's end. */
  scaling: number;
}

export interface DashBuying {
  rows: DashBuyingRow[];
  /** Keitaro failed: links are still shown. */
  moneyError: string | null;
}

export interface Dashboard {
  period: DashPeriod;
  previous: DashPeriod;
  blocks: DashBlock[];
  hiring: DashHiring | null;
  buying: DashBuying;
  /** When Kaiten was last copied; null — never (not configured or first sync pending). */
  kaitenSyncedAt: number | null;
  kaitenConfigured: boolean;
}

export interface DashDetailRow {
  name: string;
  /** Extra columns, in `columns` order. */
  cells: (string | number | null)[];
  url: string | null;
}

export interface DashDetail {
  title: string;
  columns: string[];
  rows: DashDetailRow[];
}
