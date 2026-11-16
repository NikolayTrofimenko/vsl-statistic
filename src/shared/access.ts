import type { Section } from './api.types';

/**
 * Sections an access role can open, in menu order. Admin-only areas
 * (accounts, verticals, the Drive connection, API keys, deleting creatives)
 * are not here on purpose: they stay with the admin role and can't be granted.
 */
export const SECTIONS: { id: Section; label: string; path: string }[] = [
  { id: 'library', label: 'Библиотека крео', path: '/library' },
  { id: 'caps', label: 'Капы', path: '/caps' },
  { id: 'domains', label: 'Домены', path: '/domains' },
  { id: 'quality', label: 'Качество на лендах', path: '/quality' },
  { id: 'history', label: 'История загрузок', path: '/history' },
  { id: 'grants', label: 'Доступы в Keitaro (все команды)', path: '/grants' },
  { id: 'offers', label: 'Офферы', path: '/offers' },
  // Same page; the role may also add and change offers (implies 'offers').
  { id: 'offersEdit', label: 'Офферы: правка', path: '/offers' },
  { id: 'knowledge', label: 'База знаний', path: '/knowledge' },
  // Same page; the role may also write, upload and delete documents (implies 'knowledge').
  { id: 'knowledgeEdit', label: 'База знаний: правка', path: '/knowledge' },
];

/** What an account without an access role sees — the same as before roles existed. */
export const DEFAULT_SECTIONS: Section[] = ['library', 'knowledge'];

export function isSection(value: unknown): value is Section {
  return SECTIONS.some((s) => s.id === value);
}
