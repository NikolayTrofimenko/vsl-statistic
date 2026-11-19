import { kaitenCardUrl } from '../kaiten';
import { Card, columnAt, firstEntry, loadCards } from './cards';
import { endOf, fmtDay, inside, shortLabel, today } from './periods';
import type { DashDetail, DashMetric, DashPeriod } from '../../src/shared/dashboard.types';

/**
 * "Связки общий поток" (Kaiten board 1560820): an offer/link card goes
 * search → integration → ready → В ТЕСТЕ → a verdict (МАСШТАБИРУЮ / НЕ ЗАШЛА /
 * ОТЖАТА / 500+ В НОЛЬ). Cards go back and forth, so "started scaling" is the
 * first entry, and "scaling now" is where the card sits at the period's end.
 */

export const LINKS_BOARD = 1560820;

const COL = {
  newOffers: 6802453,
  newLinks: 6421897,
  ready: 5415851,
  testing: 5532532,
  scaling: 5532556,
  failed: 5532557,
  squeezed: 5532572,
  zero: 6433208,
  paused: 5800962,
  noCap: 6669151,
} as const;

const COLUMN_TITLES: Record<number, string> = {
  5472438: 'Очередь на поиск оффера',
  5415850: 'Поиск оффера',
  5523958: 'Переговоры с ПП',
  [COL.newOffers]: 'Новые офферы на тест',
  [COL.newLinks]: 'Новые связки на тест',
  5415849: 'Очередь на интеграцию',
  5478585: 'Интеграция оффера',
  [COL.ready]: 'Готов к запуску',
  [COL.testing]: 'В тесте',
  [COL.scaling]: 'Масштабирую',
  [COL.failed]: 'Не зашла / не подходит',
  [COL.squeezed]: 'Отжата',
  [COL.zero]: '500+ спенда, но в ноль',
  [COL.paused]: 'Оффер на паузе',
  [COL.noCap]: 'Нет капы (в очереди)',
};

/** A verdict after a test: the link was tested. */
const VERDICTS = new Set<number>([COL.scaling, COL.failed, COL.squeezed, COL.zero]);
const SCALING = new Set<number>([COL.scaling]);
const TESTING = new Set<number>([COL.testing]);
const NEW_OFFERS = new Set<number>([COL.newOffers]);

const PROP = { buyer: 507373, team: 506928, vertical: 508175, geo: 508176 } as const;

/** Kaiten card types on the board. */
const TYPE = { offerRequest: 571295, newLink: 711087 } as const;

export interface Link {
  card: Card;
  buyers: string[];
  team: string | null;
  vertical: string | null;
  geo: string | null;
  toTest: string | null;
  /** First day in «Новые офферы на тест» — the offer was handed over for testing. */
  newOffer: string | null;
  tested: string | null;
  scaled: string | null;
}

export function loadLinks(): Link[] {
  return loadCards([LINKS_BOARD]).map((card) => ({
    card,
    buyers: card.select(PROP.buyer),
    team: card.select(PROP.team).join(', ') || null,
    vertical: card.select(PROP.vertical).map(short).join(', ') || null,
    geo: card.select(PROP.geo).map(short).join(', ') || null,
    toTest: firstEntry(card, TESTING),
    newOffer: firstEntry(card, NEW_OFFERS),
    tested: firstEntry(card, VERDICTS),
    scaled: firstEntry(card, SCALING),
  }));
}

/** "WL — Похудение" → "WL", "US — США 🇺🇸" → "US". */
function short(value: string): string {
  return value.split(/\s+[—-]\s+/)[0]!.trim();
}

/** Sitting in МАСШТАБИРУЮ at the end of `day` (today — the live card, archive counts). */
function scalingAt(l: Link, day: string): boolean {
  if (day >= today()) return !l.card.archived && l.card.column === COL.scaling;
  return columnAt(l.card, day) === COL.scaling;
}

interface LinkMetricDef {
  id: string;
  label: string;
  /** Dashboard block the tile sits in. */
  block: 'buying' | 'marketing' | 'analytics';
  /** Only cards of this Kaiten type; all cards when unset. */
  type?: number;
  /** Tile caption split: by buyer, or by team (offer requests rarely carry a buyer). */
  split: 'buyer' | 'team';
  flow?: (l: Link, p: DashPeriod) => boolean;
  snapshot?: (l: Link, day: string) => boolean;
}

export const LINK_METRICS: LinkMetricDef[] = [
  // Only «Новые связки на тест» cards: landing edits and offer requests reach the same verdict columns (Илья, 16.11).
  {
    id: 'buying.tested',
    label: 'Связок протестировано',
    block: 'buying',
    type: TYPE.newLink,
    split: 'buyer',
    flow: (l, p) => inside(l.tested, p),
  },
  { id: 'buying.startedScaling', label: 'Связок начали масштабировать', block: 'buying', split: 'buyer', flow: (l, p) => inside(l.scaled, p) },
  { id: 'buying.scaling', label: 'Всего масштабируемых связок', block: 'buying', split: 'buyer', snapshot: scalingAt },
  // Offer requests (19.11): proposed = first lands in «Новые офферы на тест»;
  // tested = gets past «В тесте» to a verdict; scaled = first reaches «Масштабирую».
  {
    id: 'marketing.proposed',
    label: 'Новых предложенных офферов',
    block: 'marketing',
    type: TYPE.offerRequest,
    split: 'team',
    flow: (l, p) => inside(l.newOffer, p),
  },
  {
    id: 'marketing.tested',
    label: 'Новых протестированных офферов',
    block: 'marketing',
    type: TYPE.offerRequest,
    split: 'team',
    flow: (l, p) => inside(l.tested, p),
  },
  {
    id: 'marketing.scaled',
    label: 'Новых офферов передано в масштабирование',
    block: 'marketing',
    type: TYPE.offerRequest,
    split: 'team',
    flow: (l, p) => inside(l.scaled, p),
  },
  // A "Новые связки на тест" card is the hand-over itself: counted on the day it was created.
  {
    id: 'analytics.toTest',
    label: 'Связок передано на тестирование',
    block: 'analytics',
    type: TYPE.newLink,
    split: 'team',
    flow: (l, p) => inside(l.card.created, p),
  },
];

const ofType = (m: LinkMetricDef) => (l: Link) => m.type === undefined || l.card.type === m.type;

/** "WWW: 5 · NLM: 3 · ещё 4" — a card with two buyers (teams) counts for both. */
function splitNote(links: Link[], split: 'buyer' | 'team'): string | undefined {
  if (!links.length) return undefined;
  const n = new Map<string, number>();
  for (const l of links) {
    const keys = split === 'buyer' ? l.buyers : (l.team?.split(', ') ?? []);
    for (const k of keys.length ? keys : [split === 'buyer' ? 'без баера' : 'без команды']) n.set(k, (n.get(k) ?? 0) + 1);
  }
  const sorted = [...n].sort((a, b) => b[1] - a[1]);
  const head = sorted.slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(' · ');
  return sorted.length > 3 ? `${head} · ещё ${sorted.length - 3}` : head;
}

export function linkMetrics(links: Link[], periods: DashPeriod[], block: LinkMetricDef['block']): DashMetric[] {
  const period = periods.at(-1)!;
  return LINK_METRICS.filter((m) => m.block === block).map((m) => {
    const mine = links.filter(ofType(m));
    const pick = (p: DashPeriod) => mine.filter((l) => (m.flow ? m.flow(l, p) : m.snapshot!(l, endOf(p))));
    const counted = pick(period);
    return {
      id: m.id,
      label: m.label,
      status: 'live',
      source: 'Kaiten · Связки общий поток',
      unit: 'count',
      value: counted.length,
      previous: pick(periods.at(-2)!).length,
      series: periods.map((p) => ({ label: shortLabel(p), value: pick(p).length })),
      note: splitNote(counted, m.split),
      detail: true,
      snapshot: Boolean(m.snapshot),
    };
  });
}

/** Per buyer: links tested / started scaling in the period, scaling at its end. */
export function linksByBuyer(links: Link[], period: DashPeriod): Map<string, { tested: number; startedScaling: number; scaling: number; hits: number }> {
  const out = new Map<string, { tested: number; startedScaling: number; scaling: number; hits: number }>();
  const end = endOf(period);
  for (const l of links) {
    const tested = l.card.type === TYPE.newLink && inside(l.tested, period);
    const started = inside(l.scaled, period);
    const now = scalingAt(l, end);
    if (!tested && !started && !now) continue;
    for (const b of l.buyers.length ? l.buyers : ['без баера']) {
      let r = out.get(b);
      if (!r) out.set(b, (r = { tested: 0, startedScaling: 0, scaling: 0, hits: 0 }));
      if (tested) r.tested++;
      // A tested link that got to scaling at some point counts as a hit.
      if (tested && l.scaled) r.hits++;
      if (started) r.startedScaling++;
      if (now) r.scaling++;
    }
  }
  return out;
}

export function linkDetail(metricId: string, period: DashPeriod): DashDetail {
  const def = LINK_METRICS.find((m) => m.id === metricId);
  if (!def) throw new Error('Нет такой метрики.');
  const end = endOf(period);
  const links = loadLinks()
    .filter(ofType(def))
    .filter((l) => (def.flow ? def.flow(l, period) : def.snapshot!(l, end)))
    .sort((a, b) => (b.scaled ?? b.tested ?? b.card.created).localeCompare(a.scaled ?? a.tested ?? a.card.created));
  return {
    title: `${def.label} · ${def.snapshot ? `на ${fmtDay(end)}` : period.label}`,
    columns: ['Баер', 'Команда', 'Вертикаль', 'ГЕО', 'Создана', 'В тест', 'Итог теста', 'В масштаб', 'Сейчас'],
    rows: links.map((l) => ({
      name: l.card.title,
      cells: [
        l.buyers.join(', ') || null,
        l.team,
        l.vertical,
        l.geo,
        fmtDay(l.card.created),
        fmtDay(l.toTest),
        fmtDay(l.tested),
        fmtDay(l.scaled),
        (l.card.archived ? 'в архиве · ' : '') + (COLUMN_TITLES[l.card.column] ?? `колонка ${l.card.column}`),
      ],
      url: kaitenCardUrl(l.card.id),
    })),
  };
}
