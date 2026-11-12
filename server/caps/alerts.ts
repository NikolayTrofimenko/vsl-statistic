import { db } from '../db';
import { publicUrl } from '../config';
import { scopedLogger } from '../logger';
import { escapeHtml, sendTelegram, telegramConfigured } from '../notify/telegram';
import { keitaroConfigured } from './keitaro';
import { capsReport } from './index';
import type { CapDay } from '../../src/shared/api.types';

/**
 * Cap alerts in Telegram, checked every few minutes. Each kind goes out at
 * most once per cap per day (Moscow):
 *   risk  — at the current pace the limit is exceeded before midnight;
 *   p90   — 90% of the limit reached;
 *   p100  — the limit reached;
 * and one evening summary of caps heading for "недолив".
 */

const log = scopedLogger('cap-alerts');

const CHECK_MS = 5 * 60_000;
/** Too little of the day gone to trust a forecast. */
const MIN_HOURS_FOR_FORECAST = 2;
/** Moscow hour of the evening "недолив" summary. */
const EVENING_HOUR = 21;

type Kind = 'risk' | 'p90' | 'p100' | 'evening';

export function startCapAlerts(): void {
  const tick = () => void check().catch((err) => log.warn('Проверка кап упала', err));
  setTimeout(tick, 30_000).unref();
  setInterval(tick, CHECK_MS).unref();
}

async function check(): Promise<void> {
  if (!telegramConfigured() || !keitaroConfigured()) return;
  const report = await capsReport();
  if (report.error) return; // stale numbers are worse than none
  const day = report.date;

  for (const cap of report.caps.filter((c) => c.active)) {
    const share = cap.leads / cap.dailyLimit;
    if (share >= 1) {
      await once(cap.id, day, 'p100', () => `🛑 <b>${name(cap)}</b>: капа выбрана — ${cap.leads}/${cap.dailyLimit} (${pct(share)}). Стопаем.`);
      continue;
    }
    if (share >= 0.9) {
      await once(cap.id, day, 'p90', () => `🟠 <b>${name(cap)}</b>: ${cap.leads}/${cap.dailyLimit} (${pct(share)}) — осталось ${cap.dailyLimit - cap.leads}.`);
    }
    if (cap.projected !== null && cap.projected > cap.dailyLimit && report.elapsedHours >= MIN_HOURS_FOR_FORECAST) {
      await once(cap.id, day, 'risk', () => {
        const eta = etaHour(cap, report.elapsedHours);
        return (
          `⚠️ <b>${name(cap)}</b>: перельём. Сейчас ${cap.leads}/${cap.dailyLimit} (${pct(share)}), ` +
          `прогноз к концу суток ${cap.projected}.` +
          (eta ? ` При текущем темпе капа закончится около ${eta} МСК.` : '')
        );
      });
    }
  }

  if (report.isToday && report.elapsedHours >= EVENING_HOUR) {
    const under = report.caps.filter((c) => c.active && c.status === 'under');
    if (under.length) {
      await once(0, day, 'evening', () =>
        [
          `📉 <b>Недолив к концу суток</b> (прогноз):`,
          ...under.map((c) => `• ${name(c)}: ${c.leads}/${c.dailyLimit}, прогноз ${c.projected ?? c.leads} (${pct((c.projected ?? c.leads) / c.dailyLimit)})`),
          `<a href="${publicUrl()}/caps">Капы</a>`,
        ].join('\n'),
      );
    }
  }
}

/** Send unless this kind already went out for the cap today. */
async function once(capId: number, day: string, kind: Kind, text: () => string): Promise<void> {
  const conn = db();
  if (conn.prepare('SELECT 1 FROM cap_alerts WHERE cap_id = ? AND day = ? AND kind = ?').get(capId, day, kind)) return;
  await sendTelegram(text());
  conn.prepare('INSERT INTO cap_alerts (cap_id, day, kind, sent_at) VALUES (?, ?, ?, ?)').run(capId, day, kind, Date.now());
  log.info(`Уведомление ${kind} по капе ${capId} за ${day} отправлено.`);
}

/** Moscow time the limit runs out at the current pace, as HH:MM. */
function etaHour(cap: CapDay, elapsed: number): string | null {
  if (cap.projected === null || elapsed >= 24) return null;
  const pace = (cap.projected - cap.leads) / (24 - elapsed);
  if (!(pace > 0)) return null;
  const at = elapsed + (cap.dailyLimit - cap.leads) / pace;
  if (at >= 24) return null;
  return `${String(Math.floor(at)).padStart(2, '0')}:${String(Math.floor((at % 1) * 60)).padStart(2, '0')}`;
}

function name(cap: CapDay): string {
  return escapeHtml(cap.name);
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}
