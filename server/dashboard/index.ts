import { keitaroCall, keitaroConfigured } from '../caps/keitaro';
import { kaitenCardUrl, kaitenConfigured, kaitenSyncedAt } from '../kaiten';
import { Card, firstEntry, loadCards } from './cards';
import { linkDetail, linkMetrics, linksByBuyer, loadLinks } from './links';
import { taskDetail, taskMetrics } from './tasks';
import { archiveDetail, archiveMetric } from './archive';
import { dayIn, endOf, fmtDay, inside, periodOf, shortLabel, today, TZ } from './periods';
import type {
  DashBlock,
  DashBuying,
  DashDetail,
  DashDetailRow,
  DashHiring,
  DashMetric,
  DashPeriod,
  DashPeriodKind,
  Dashboard,
} from '../../src/shared/dashboard.types';

/**
 * The owner's dashboard: Илья's list of company metrics, block by block.
 * Hiring and links come from Kaiten (cards and their column moves, see
 * `server/kaiten`), buying profit from Keitaro; the rest are shown as
 * "источник не подключён" until their sources are wired in.
 */

const SERIES = { week: 8, month: 6 } as const;

/* ------------------------- Kaiten: hiring ------------------------- */

const BOARD = { recruiting: 1962805, probation: 1957064, staff: 1970273 } as const;
const HIRING_BOARDS = [BOARD.recruiting, BOARD.probation, BOARD.staff];
const COL = {
  passed: 6759976,
  failed: 6806278,
  onboarding: 6806260,
  hired: 6806261,
  offboarding: 6806262,
  fired: 6806266,
} as const;
const PROP = { department: 674228, position: 674229, source: 674221, probationDate: 674231 } as const;

/** Funnel stages; a column's rank says how far a card that entered it got. */
const STAGES = ['Отклик', 'Вышел на контакт', 'Первое собеседование', 'Собеседование с руководителем', 'Оффер принят', 'Вышел на ИС', 'Прошёл ИС'];
const RANK: Record<number, number> = {
  6780229: 0, // Отклики
  6780230: 1, // Вышел на контакт
  6780246: 2, // Проведено первое собеседование
  6793150: 2, // Передан на рассмотрение
  6780863: 3, // Собеседование с руководителем
  6780895: 3, // Отправить оффер
  6781159: 4, // Оффер принят
  6759973: 5, // Вышел на ИС
  6759974: 5, // Первая неделя пройдена
  6759972: 5, // 30 дней пройдено
  6759975: 5, // Испытательный срок пройден (итог — в подколонках)
  [COL.failed]: 5,
  [COL.passed]: 6,
};
const COLUMN_TITLES: Record<number, string> = {
  6780229: 'Отклики',
  6780230: 'Вышел на контакт',
  6780231: 'Не подходит',
  6780246: 'Первое собеседование',
  6793150: 'Передан на рассмотрение',
  6780863: 'Собеседование с руководителем',
  6780895: 'Отправить оффер',
  6781159: 'Оффер принят',
  6790214: 'Резерв',
  6759973: 'Вышел на ИС',
  6759974: 'Первая неделя пройдена',
  6759972: '30 дней пройдено',
  6759975: 'Итог ИС',
  [COL.passed]: 'ИС пройден',
  [COL.failed]: 'ИС не пройден',
  [COL.onboarding]: 'Онбординг',
  [COL.hired]: 'Принят на работу',
  [COL.offboarding]: 'Офбординг',
  [COL.fired]: 'Уволен',
};

interface Person {
  card: Card;
  department: string | null;
  position: string | null;
  source: string | null;
  /** Day each funnel stage was first reached; null — not reached. */
  reached: (string | null)[];
  startedIS: string | null;
  passed: string | null;
  failed: string | null;
  joinedStaff: string | null;
  fired: string | null;
}

function loadPeople(): Person[] {
  return loadCards(HIRING_BOARDS).map((card) => {
    const reached: (string | null)[] = STAGES.map(() => null);
    let joinedStaff: string | null = null;
    for (const m of card.moves) {
      const rank = RANK[m.column] ?? RANK[m.parent] ?? (m.board === BOARD.probation ? 5 : m.board === BOARD.recruiting ? 0 : -1);
      reached[0] ??= m.day;
      for (let k = 0; k <= rank; k++) reached[k] ??= m.day;
      if (m.board === BOARD.staff) joinedStaff ??= m.day;
    }
    // The probation date field, when filled, is the real start — cards are sometimes dragged in later.
    const startedIS = dateProp(card.props[`id_${PROP.probationDate}`]) ?? reached[5] ?? null;
    if (startedIS) reached[5] = startedIS;
    return {
      card,
      department: card.select(PROP.department).join(', ') || null,
      position: card.select(PROP.position).join(', ') || null,
      source: card.select(PROP.source).join(', ') || null,
      reached,
      startedIS,
      passed: reached[6] ?? null,
      failed: firstEntry(card, new Set([COL.failed])),
      joinedStaff,
      fired: firstEntry(card, new Set([COL.fired])),
    };
  });
}

/** Kaiten date property: "2026-10-27", "2026-10-27T…" or { date: … }. */
function dateProp(v: unknown): string | null {
  const raw = v && typeof v === 'object' && 'date' in v ? (v as { date: unknown }).date : v;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  return raw.length > 10 ? dayIn(raw) : raw;
}

/** On probation at the end of `day`. */
function onProbation(p: Person, day: string): boolean {
  if (!p.startedIS || p.startedIS > day) return false;
  if ((p.passed && p.passed <= day) || (p.failed && p.failed <= day)) return false;
  if (day >= today()) return !p.card.archived && p.card.board === BOARD.probation;
  return true;
}

/** In staff (onboarding or hired) at the end of `day`. */
function inStaff(p: Person, day: string): boolean {
  if (!p.joinedStaff || p.joinedStaff > day) return false;
  if (p.fired && p.fired <= day) return false;
  if (day >= today()) {
    return !p.card.archived && p.card.board === BOARD.staff && (p.card.column === COL.onboarding || p.card.column === COL.hired);
  }
  return true;
}

/** "Медиабаер: 2 · Тимлид: 1" — by position, else by department. */
function breakdown(people: Person[]): string | undefined {
  if (!people.length) return undefined;
  const n = new Map<string, number>();
  for (const p of people) {
    const key = p.position ?? p.department ?? 'без должности';
    n.set(key, (n.get(key) ?? 0) + 1);
  }
  return [...n].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(' · ');
}

interface HiringMetricDef {
  id: string;
  label: string;
  /** People counted in a period. */
  flow?: (p: Person, period: DashPeriod) => boolean;
  /** A state at the period's end. */
  snapshot?: (p: Person, day: string) => boolean;
}

const HIRING_METRICS: HiringMetricDef[] = [
  { id: 'hiring.started', label: 'Вышли на испытательный срок', flow: (p, d) => inside(p.startedIS, d) },
  { id: 'hiring.passed', label: 'Прошли испытательный срок', flow: (p, d) => inside(p.passed, d) },
  { id: 'hiring.failed', label: 'Не прошли испытательный срок', flow: (p, d) => inside(p.failed, d) },
  { id: 'hiring.onProbation', label: 'Сейчас на испытательном', snapshot: onProbation },
  { id: 'hiring.responses', label: 'Откликов', flow: (p, d) => inside(p.reached[0], d) },
  { id: 'hiring.offers', label: 'Приняли оффер', flow: (p, d) => inside(p.reached[4], d) },
  { id: 'hiring.staff', label: 'В штате', snapshot: inStaff },
  { id: 'hiring.fired', label: 'Уволено', flow: (p, d) => inside(p.fired, d) },
];

function hiringBlock(people: Person[], periods: DashPeriod[]): DashBlock {
  const period = periods.at(-1)!;
  const metrics: DashMetric[] = HIRING_METRICS.map((m) => {
    const pick = (p: DashPeriod) => people.filter((x) => (m.flow ? m.flow(x, p) : m.snapshot!(x, endOf(p))));
    const counted = pick(period);
    return {
      id: m.id,
      label: m.label,
      status: 'live',
      source: 'Kaiten · Найм и коммуникации',
      unit: 'count',
      value: counted.length,
      previous: pick(periods.at(-2)!).length,
      series: periods.map((p) => ({ label: shortLabel(p), value: pick(p).length })),
      note: m.id === 'hiring.responses' || m.id === 'hiring.offers' ? undefined : breakdown(counted),
      detail: true,
      snapshot: Boolean(m.snapshot),
    };
  });
  return { id: 'hiring', title: 'Найм и коммуникации', metrics };
}

function hiringPanels(people: Person[], period: DashPeriod): DashHiring {
  const funnel = STAGES.map((label, k) => ({ label, count: people.filter((p) => inside(p.reached[k], period)).length }));
  const bySource = new Map<string, { responses: number; started: number; passed: number }>();
  const row = (s: string | null) => {
    const key = s ?? 'не указан';
    let r = bySource.get(key);
    if (!r) bySource.set(key, (r = { responses: 0, started: 0, passed: 0 }));
    return r;
  };
  for (const p of people) {
    if (inside(p.reached[0], period)) row(p.source).responses++;
    if (inside(p.startedIS, period)) row(p.source).started++;
    if (inside(p.passed, period)) row(p.source).passed++;
  }
  const cohort = people.filter((p) => inside(p.startedIS, period));
  return {
    funnel,
    sources: [...bySource].map(([source, r]) => ({ source, ...r })).sort((a, b) => b.responses - a.responses),
    cohort: {
      started: cohort.length,
      passed: cohort.filter((p) => p.passed).length,
      failed: cohort.filter((p) => p.failed && !p.passed).length,
      inProgress: cohort.filter((p) => !p.passed && !p.failed).length,
    },
  };
}

function hiringDetail(metricId: string, period: DashPeriod): DashDetail {
  const def = HIRING_METRICS.find((m) => m.id === metricId);
  if (!def) throw new Error('Нет такой метрики.');
  const end = endOf(period);
  const now = today();
  const people = loadPeople().filter((p) => (def.flow ? def.flow(p, period) : def.snapshot!(p, end)));
  const days = (from: string | null, to: string | null) =>
    from ? Math.round((Date.parse(to ?? now) - Date.parse(from)) / 86_400_000) : null;
  const rows: DashDetailRow[] = people
    .sort((a, b) => (b.startedIS ?? b.reached[0] ?? '').localeCompare(a.startedIS ?? a.reached[0] ?? ''))
    .map((p) => ({
      name: p.card.title,
      cells: [
        p.department,
        p.position,
        p.source,
        fmtDay(p.reached[0]),
        fmtDay(p.startedIS),
        p.startedIS ? days(p.startedIS, p.passed ?? p.failed) : null,
        (p.card.archived ? 'в архиве · ' : '') + (COLUMN_TITLES[p.card.column] ?? `колонка ${p.card.column}`),
      ],
      url: kaitenCardUrl(p.card.id),
    }));
  return {
    title: `${def.label} · ${def.snapshot ? `на ${fmtDay(end)}` : period.label}`,
    columns: ['Департамент', 'Должность', 'Источник', 'Отклик', 'Вышел на ИС', 'Дней на ИС', 'Сейчас'],
    rows,
  };
}

/* ------------------------- Keitaro: buying profit ------------------------- */

const KEITARO_TTL_MS = 10 * 60_000;
const keitaroCache = new Map<string, { at: number; rows: Record<string, unknown>[] }>();

/** A Keitaro report over [from, to] (Moscow), cached for 10 minutes. */
async function report(from: string, to: string, dimension: 'day' | 'campaign_group'): Promise<Record<string, unknown>[]> {
  const key = `${dimension}:${from}:${to}`;
  const hit = keitaroCache.get(key);
  if (hit && Date.now() - hit.at < KEITARO_TTL_MS) return hit.rows;
  const res = await keitaroCall<{ rows?: Record<string, unknown>[] }>('/admin_api/v1/report/build', {
    range: { from: `${from} 00:00:00`, to: `${to} 23:59:59`, timezone: TZ },
    dimensions: [dimension],
    // Approved only: 'revenue' would add the expected payout of pending leads.
    measures: ['sale_revenue', 'cost', 'sales', 'conversions'],
    limit: 1000,
  });
  const rows = res.rows ?? [];
  keitaroCache.set(key, { at: Date.now(), rows });
  return rows;
}

async function profitMetric(periods: DashPeriod[]): Promise<DashMetric> {
  const base: DashMetric = {
    id: 'buying.profit',
    label: 'Прибыль от баинга',
    status: 'live',
    source: 'Keitaro · подтверждённые лиды − расход',
    unit: 'money',
    value: null,
    previous: null,
    series: [],
    detail: true,
  };
  if (!keitaroConfigured()) return { ...base, status: 'pending', source: 'Keitaro не настроен' };
  try {
    const rows = await report(periods[0]!.from, periods.at(-1)!.to, 'day');
    const sum = (p: DashPeriod) => {
      let total = 0;
      for (const r of rows) {
        if (inside(String(r['day'] ?? '').slice(0, 10), p)) total += Number(r['sale_revenue'] ?? 0) - Number(r['cost'] ?? 0);
      }
      return Math.round(total);
    };
    return {
      ...base,
      value: sum(periods.at(-1)!),
      previous: sum(periods.at(-2)!),
      series: periods.map((p) => ({ label: shortLabel(p), value: sum(p) })),
      note: 'Свежие дни занижены: выкуп подтверждается через несколько дней',
    };
  } catch (err) {
    return { ...base, note: `Keitaro: ${err instanceof Error ? err.message : String(err)}` };
  }
}

interface BuyerMoney {
  revenue: number;
  cost: number;
  leads: number;
  sales: number;
}

async function moneyByBuyer(period: DashPeriod): Promise<Map<string, BuyerMoney>> {
  const out = new Map<string, BuyerMoney>();
  for (const r of await report(period.from, period.to, 'campaign_group')) {
    const m = {
      revenue: Number(r['sale_revenue'] ?? 0),
      cost: Number(r['cost'] ?? 0),
      leads: Number(r['conversions'] ?? 0),
      sales: Number(r['sales'] ?? 0),
    };
    if (m.revenue || m.cost || m.leads) out.set(r['campaign_group'] ? String(r['campaign_group']) : 'без группы', m);
  }
  return out;
}

async function profitDetail(period: DashPeriod): Promise<DashDetail> {
  const rows = [...(await moneyByBuyer(period))].sort((a, b) => b[1].revenue - b[1].cost - (a[1].revenue - a[1].cost));
  return {
    title: `Прибыль от баинга · ${period.label}`,
    columns: ['Лиды', 'Апрув', 'Доход', 'Расход', 'Прибыль', 'ROI'],
    rows: rows.map(([buyer, r]) => ({
      name: buyer,
      cells: [
        r.leads,
        r.sales,
        money(r.revenue),
        money(r.cost),
        money(r.revenue - r.cost),
        r.cost > 0 ? `${Math.round(((r.revenue - r.cost) / r.cost) * 100)}%` : '—',
      ],
      url: null,
    })),
  };
}

function money(n: number): string {
  return `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('ru-RU')}`;
}

/** Keitaro money and Kaiten links side by side, per buyer code (the same codes in both). */
async function buyingPanel(period: DashPeriod, links: ReturnType<typeof loadLinks> | null): Promise<DashBuying> {
  let moneyBy = new Map<string, BuyerMoney>();
  let moneyError: string | null = null;
  if (keitaroConfigured()) {
    try {
      moneyBy = await moneyByBuyer(period);
    } catch (err) {
      moneyError = err instanceof Error ? err.message : String(err);
    }
  }
  const linkBy = links ? linksByBuyer(links, period) : new Map();
  const buyers = new Set([...moneyBy.keys(), ...linkBy.keys()]);
  const rows = [...buyers].map((buyer) => {
    const m = moneyBy.get(buyer);
    const l = linkBy.get(buyer);
    return {
      buyer,
      revenue: m ? Math.round(m.revenue) : null,
      cost: m ? Math.round(m.cost) : null,
      profit: m ? Math.round(m.revenue - m.cost) : null,
      roi: m && m.cost > 0 ? Math.round(((m.revenue - m.cost) / m.cost) * 1000) / 10 : null,
      tested: l?.tested ?? 0,
      hits: l?.hits ?? 0,
      startedScaling: l?.startedScaling ?? 0,
      scaling: l?.scaling ?? 0,
    };
  });
  rows.sort((a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity) || b.scaling - a.scaling);
  return { rows, moneyError };
}

/* ------------------------- not connected yet ------------------------- */

function pending(id: string, label: string, source: string): DashMetric {
  return { id, label, status: 'pending', source, unit: 'count', value: null, previous: null, series: [], detail: false };
}

/* ------------------------- API ------------------------- */

export async function dashboard(kind: DashPeriodKind, anchor: string | null): Promise<Dashboard> {
  const k: DashPeriodKind = kind === 'month' ? 'month' : 'week';
  const day = anchor && /^\d{4}-\d{2}-\d{2}$/.test(anchor) ? anchor : today();
  const periods = Array.from({ length: SERIES[k] }, (_, i) => periodOf(k, day, i - SERIES[k] + 1));
  const period = periods.at(-1)!;

  const hasKaiten = kaitenConfigured();
  const people = hasKaiten ? loadPeople() : [];
  const links = hasKaiten ? loadLinks() : null;
  const [profit, buying, found] = await Promise.all([profitMetric(periods), buyingPanel(period, links), archiveMetric(periods)]);

  const blocks: DashBlock[] = [
    hasKaiten
      ? hiringBlock(people, periods)
      : {
          id: 'hiring',
          title: 'Найм и коммуникации',
          metrics: [
            pending('hiring.started', 'Вышли на испытательный срок', 'Kaiten не настроен'),
            pending('hiring.passed', 'Прошли испытательный срок', 'Kaiten не настроен'),
          ],
        },
    {
      id: 'marketing',
      title: 'Маркетинг, реклама, продажи',
      metrics: links
        ? linkMetrics(links, periods, 'marketing')
        : [
            pending('marketing.tested', 'Новых протестированных офферов', 'Kaiten не настроен'),
            pending('marketing.scaled', 'Новых офферов передано в масштабирование', 'Kaiten не настроен'),
          ],
    },
    {
      id: 'finance',
      title: 'Бухгалтерия',
      metrics: [
        pending('finance.income', 'Доход компании', 'Учёт финансиста — нужен источник'),
        pending('finance.expenses', 'Расходы компании', 'Учёт финансиста — нужен источник'),
      ],
    },
    {
      id: 'analytics',
      title: 'Аналитика',
      metrics: [
        found,
        ...(links
          ? [...linkMetrics(links, periods, 'analytics'), ...taskMetrics(periods)]
          : [
              pending('analytics.toTest', 'Связок передано на тестирование', 'Kaiten не настроен'),
              pending('analytics.tech', 'Технических задач выполнено', 'Kaiten не настроен'),
              pending('analytics.promo', 'Промо задач выполнено', 'Kaiten не настроен'),
            ]),
      ],
    },
    {
      id: 'buying',
      title: 'Баинг',
      metrics: [
        profit,
        ...(links
          ? linkMetrics(links, periods, 'buying')
          : [
              pending('buying.tested', 'Связок протестировано', 'Kaiten не настроен'),
              pending('buying.startedScaling', 'Связок начали масштабировать', 'Kaiten не настроен'),
              pending('buying.scaling', 'Всего масштабируемых связок', 'Kaiten не настроен'),
            ]),
      ],
    },
    {
      id: 'growth',
      title: 'Развитие компании',
      metrics: [pending('growth.leads', 'Целевых лидов с конференций и рекомендаций', 'Ручной ввод')],
    },
  ];

  return {
    period,
    previous: periods.at(-2)!,
    blocks,
    hiring: hasKaiten ? hiringPanels(people, period) : null,
    buying,
    kaitenSyncedAt: kaitenSyncedAt(),
    kaitenConfigured: hasKaiten,
  };
}

export async function dashboardDetail(metricId: string, kind: DashPeriodKind, anchor: string): Promise<DashDetail> {
  const period = periodOf(kind === 'month' ? 'month' : 'week', /^\d{4}-\d{2}-\d{2}$/.test(anchor) ? anchor : today());
  if (metricId === 'buying.profit') return profitDetail(period);
  if (metricId === 'analytics.found') return archiveDetail(period);
  if (metricId === 'analytics.tech' || metricId === 'analytics.promo') return taskDetail(metricId, period);
  if (/^(buying|marketing|analytics)\./.test(metricId)) return linkDetail(metricId, period);
  if (metricId.startsWith('hiring.')) return hiringDetail(metricId, period);
  throw new Error('У этой метрики нет расшифровки.');
}
