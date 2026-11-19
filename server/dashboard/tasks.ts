import { kaitenCardUrl } from '../kaiten';
import { Card, firstEntry, loadCards } from './cards';
import { fmtDay, inside, shortLabel } from './periods';
import type { DashDetail, DashMetric, DashPeriod } from '../../src/shared/dashboard.types';

/**
 * Department task boards: a task is done in the period its card first reached
 * the board's ГОТОВО column — moved back or archived later, it still counts.
 */

interface TaskBoard {
  id: number;
  title: string;
  done: number;
}

interface TaskMetricDef {
  id: string;
  label: string;
  source: string;
  boards: TaskBoard[];
}

export const TASK_METRICS: TaskMetricDef[] = [
  {
    id: 'analytics.tech',
    label: 'Технических задач выполнено',
    source: 'Kaiten · IT отдел · Автоматизация',
    boards: [
      { id: 1857364, title: 'Автоматизация', done: 6422386 },
    ],
  },
  {
    id: 'analytics.promo',
    label: 'Промо задач выполнено',
    source: 'Kaiten · Промо-отдел',
    boards: [
      { id: 1538010, title: 'Креативы', done: 5350122 },
    ],
  },
];

interface Task {
  card: Card;
  board: TaskBoard;
  done: string | null;
}

function loadTasks(def: TaskMetricDef): Task[] {
  const byId = new Map(def.boards.map((b) => [b.id, b]));
  const doneColumns = new Set(def.boards.map((b) => b.done));
  return loadCards(def.boards.map((b) => b.id)).map((card) => ({
    card,
    // A card may have changed boards: credit the one whose ГОТОВО it reached.
    board: byId.get(card.moves.find((m) => doneColumns.has(m.column) || doneColumns.has(m.parent))?.board ?? card.board) ?? def.boards[0]!,
    done: firstEntry(card, doneColumns),
  }));
}

/** "Проблемы: 5 · Автоматизация: 3" — only when the metric spans boards. */
function boardNote(def: TaskMetricDef, tasks: Task[]): string | undefined {
  if (def.boards.length < 2 || !tasks.length) return undefined;
  return def.boards.map((b) => `${b.title}: ${tasks.filter((t) => t.board.id === b.id).length}`).join(' · ');
}

export function taskMetrics(periods: DashPeriod[]): DashMetric[] {
  const period = periods.at(-1)!;
  return TASK_METRICS.map((def) => {
    const tasks = loadTasks(def);
    const pick = (p: DashPeriod) => tasks.filter((t) => inside(t.done, p));
    const counted = pick(period);
    return {
      id: def.id,
      label: def.label,
      status: 'live',
      source: def.source,
      unit: 'count',
      value: counted.length,
      previous: pick(periods.at(-2)!).length,
      series: periods.map((p) => ({ label: shortLabel(p), value: pick(p).length })),
      note: boardNote(def, counted),
      detail: true,
    };
  });
}

export function taskDetail(metricId: string, period: DashPeriod): DashDetail {
  const def = TASK_METRICS.find((m) => m.id === metricId);
  if (!def) throw new Error('Нет такой метрики.');
  const tasks = loadTasks(def)
    .filter((t) => inside(t.done, period))
    .sort((a, b) => b.done!.localeCompare(a.done!));
  return {
    title: `${def.label} · ${period.label}`,
    columns: ['Доска', 'Создана', 'Готово', 'Сейчас'],
    rows: tasks.map((t) => ({
      name: t.card.title,
      cells: [t.board.title, fmtDay(t.card.created), fmtDay(t.done), t.card.archived ? 'в архиве' : null],
      url: kaitenCardUrl(t.card.id),
    })),
  };
}
