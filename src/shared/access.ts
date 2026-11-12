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
];

/** What an account without an access role sees — the same as before roles existed. */
export const DEFAULT_SECTIONS: Section[] = ['library'];

export function isSection(value: unknown): value is Section {
  return SECTIONS.some((s) => s.id === value);
}
