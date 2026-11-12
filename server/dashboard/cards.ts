import { db } from '../db';
import { dayIn } from './periods';

/** Kaiten cards from the local copy (`server/kaiten`), with names for select properties and moves by day. */

export interface CardMove {
  /** Day (Moscow). */
  day: string;
  board: number;
  /** The subcolumn when the card sat in one, else the column. */
  column: number;
  /** The parent column (equals `column` outside subcolumns). */
  parent: number;
}

export interface Card {
  id: number;
  title: string;
  archived: boolean;
  /** Kaiten card type id; null — none. */
  type: number | null;
  /** Day (Moscow) the card was created. */
  created: string;
  /** Where the card is now (after its last move). */
  board: number;
  column: number;
  props: Record<string, unknown>;
  /** Oldest first. */
  moves: CardMove[];
  /** Names of a select property's values; empty when unset. */
  select(propertyId: number): string[];
}

export function loadCards(boards: readonly number[]): Card[] {
  const conn = db();
  const values = new Map(
    (conn.prepare('SELECT id, value FROM kaiten_select_values').all() as { id: number; value: string }[]).map((v) => [v.id, v.value]),
  );
  const rows = conn
    .prepare(
      `SELECT id, title, board_id, column_id, archived, properties, type_id, created_at FROM kaiten_cards
       WHERE board_id IN (${boards.map(() => '?').join(',')})`,
    )
    .all(...boards) as { id: number; title: string; board_id: number; column_id: number; archived: number; properties: string | null; type_id: number | null; created_at: string }[];
  const movesOf = conn.prepare('SELECT at, board_id, column_id, subcolumn_id FROM kaiten_moves WHERE card_id = ? ORDER BY at');

  return rows.map((r) => {
    const props = parseJson(r.properties);
    const moves = (movesOf.all(r.id) as { at: string; board_id: number; column_id: number; subcolumn_id: number | null }[]).map(
      (m) => ({ day: dayIn(m.at), board: m.board_id, column: m.subcolumn_id ?? m.column_id, parent: m.column_id }),
    );
    const last = moves.at(-1);
    return {
      id: r.id,
      title: r.title || `Карточка ${r.id}`,
      archived: r.archived === 1,
      type: r.type_id,
      created: dayIn(r.created_at),
      board: last?.board ?? r.board_id,
      column: last?.column ?? r.column_id,
      props,
      moves,
      select(propertyId: number): string[] {
        const v = props[`id_${propertyId}`];
        const ids = Array.isArray(v) ? v : v == null ? [] : [v];
        return ids.map((x) => values.get(Number(x))).filter((x): x is string => Boolean(x));
      },
    };
  });
}

/** First day the card entered any of `columns` (matched against the column or its parent). */
export function firstEntry(card: Card, columns: ReadonlySet<number>): string | null {
  return card.moves.find((m) => columns.has(m.column) || columns.has(m.parent))?.day ?? null;
}

/** The column the card sat in at the end of `day`; null — not on the board yet. */
export function columnAt(card: Card, day: string): number | null {
  let col: number | null = null;
  for (const m of card.moves) {
    if (m.day > day) break;
    col = m.column;
  }
  return col;
}

function parseJson(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
