import Anthropic from '@anthropic-ai/sdk';
import { scopedLogger } from '../logger';

/**
 * Russian translation of a creative's transcript, through Claude.
 *
 * Buyers read it to decide whether a creative made for one country can run
 * in another unchanged, so the wording and the selling phrases matter more
 * than polish: translate, don't summarise or improve.
 */

const log = scopedLogger('translate');

/**
 * A literal translation of a short ad needs no reasoning, so the cheapest
 * current model does it — the same choice as Parse FB. TRANSLATE_MODEL
 * overrides it.
 */
const DEFAULT_MODEL = 'claude-haiku-4-5';

// Transcripts come from automatic speech recognition and are often messy
// (wrong script, repeated words, garbled stretches). Without saying so up
// front the model answers *about* the text in English instead of translating.
const SYSTEM = [
  'You translate automatic speech-recognition transcripts of video ads into Russian',
  'for a media-buying team. The transcript is inside <transcript> tags; it may be',
  'noisy, contain recognition errors, mixed scripts or repetitions — translate it',
  'anyway, as faithfully as you can, guessing the intended words from context.',
  'Keep the selling phrases, claims, numbers, names and tone; do not summarise,',
  'soften or add anything. Your entire reply must be the Russian translation only:',
  'never comment on the text, its language or its quality, never reply in English.',
].join(' ');

/** Below this share of Cyrillic letters the reply is a comment, not a translation. */
const MIN_CYRILLIC_SHARE = 0.5;

let client: Anthropic | null = null;

export function translationConfigured(): boolean {
  return Boolean(process.env['ANTHROPIC_API_KEY']?.trim());
}

/** The transcript in Russian. Throws on API failure or a refusal. */
export async function translateToRussian(text: string, language: string | null): Promise<string> {
  client ??= new Anthropic();
  const model = process.env['TRANSLATE_MODEL']?.trim() || DEFAULT_MODEL;

  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Spoken language (detected): ${language ?? 'unknown'}.\n<transcript>\n${text}\n</transcript>`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Модель отказалась переводить этот текст.');
  }
  const translated = response.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim();
  if (!translated) throw new Error('Пустой перевод.');
  const letters = translated.match(/\p{L}/gu) ?? [];
  const cyrillic = translated.match(/\p{Script=Cyrillic}/gu) ?? [];
  if (letters.length && cyrillic.length / letters.length < MIN_CYRILLIC_SHARE) {
    throw new Error('Модель ответила не переводом (расшифровка, видимо, слишком неразборчива).');
  }
  if (response.stop_reason === 'max_tokens') {
    log.warn('Перевод обрезан по max_tokens — текст очень длинный.');
  }
  return translated;
}
