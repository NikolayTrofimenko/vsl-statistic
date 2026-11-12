import { handle } from './rpc';
import { capBuyers, capsReport, deleteCap, saveCap } from '../caps';
import { listOffers } from '../caps/keitaro';
import { sendTelegram } from '../notify/telegram';
import type { CapBuyers, CapInput, CapsReport, KeitaroOffer } from '../../src/shared/api.types';

/** Admin only — gated by `adminOnly()` in `server/http/app.ts`. */
export function registerCapsHandlers(): void {
  handle('caps:report', (date: string | null): Promise<CapsReport> => capsReport(date));
  handle('caps:offers', (): Promise<KeitaroOffer[]> => listOffers(true));
  handle('caps:save', (input: CapInput): Promise<void> => saveCap(input));
  handle('caps:delete', (id: number): void => deleteCap(Number(id)));
  handle('caps:buyers', (capId: number, date: string, days: number): Promise<CapBuyers> =>
    capBuyers(Number(capId), String(date ?? ''), Number(days)),
  );
  handle('caps:testTelegram', (): Promise<void> =>
    sendTelegram('✅ vsl-statistic: уведомления по капам будут приходить сюда.'),
  );
}
