import type { CapRule, KeitaroOffer } from './api.types';

/**
 * Whether an offer falls under a cap's rule: the partner, then optionally the
 * geo and every word of "name contains". Shared so the dialog previews
 * exactly what the server will count — including offers added later.
 */
export function matchesRule(offer: KeitaroOffer, rule: CapRule): boolean {
  if (offer.networkId !== rule.networkId) return false;
  if (rule.country && offer.country !== rule.country) return false;
  const name = offer.name.toLowerCase();
  return ruleWords(rule.nameContains).every((w) => name.includes(w));
}

export function ruleWords(text: string | null | undefined): string[] {
  return String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}
