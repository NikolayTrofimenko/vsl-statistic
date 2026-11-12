import { scopedLogger } from '../logger';

/**
 * Messages to the team's Telegram chat — the same bot spendbridge uses.
 * TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID; without them nothing is sent.
 */

const log = scopedLogger('telegram');

export function telegramConfigured(): boolean {
  return Boolean(token() && chatId());
}

/** Send an HTML-formatted message; throws with Telegram's reason on failure. */
export async function sendTelegram(html: string): Promise<void> {
  if (!telegramConfigured()) throw new Error('Telegram не настроен: задай TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env.');
  const res = await fetch(`https://api.telegram.org/bot${token()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId(), text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { description?: string } | null;
    const reason = body?.description ?? `HTTP ${res.status}`;
    log.warn(`Не отправилось: ${reason}`);
    throw new Error(`Telegram: ${reason}`);
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function token(): string {
  return process.env['TELEGRAM_BOT_TOKEN']?.trim() ?? '';
}

function chatId(): string {
  return process.env['TELEGRAM_CHAT_ID']?.trim() ?? '';
}
