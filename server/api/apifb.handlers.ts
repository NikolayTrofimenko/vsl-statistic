import { handle } from './rpc';
import { loadEvents, previewApifbDoc, runApifbBatch } from '../apifb/batch';
import { APIFB_VERTICALS, listApifbGeos } from '../apifb/catalog';
import { sendApifbEvent } from '../apifb/send';
import type {
  ApifbBatchInput,
  ApifbBatchResult,
  ApifbGeoInfo,
  ApifbLoadInput,
  ApifbLoadResult,
  ApifbPreview,
  ApifbSendInput,
  ApifbSendResult,
  ApifbVerticalInfo,
} from '../../src/shared/api.types';

/** Admin only — `apifb:*` in `channelAccess()`. */
export function registerApifbHandlers(): void {
  handle('apifb:send', (input: ApifbSendInput): Promise<ApifbSendResult> => sendApifbEvent(input));
  handle(
    'apifb:verticals',
    (): ApifbVerticalInfo[] => APIFB_VERTICALS.map(({ id, label }) => ({ id, label })),
  );
  handle('apifb:geos', async (verticalId: string): Promise<ApifbGeoInfo[]> => {
    const geos = await listApifbGeos(String(verticalId ?? ''));
    return geos.map(({ id, label, region, docId }) => ({ id, label, region, docId }));
  });
  handle(
    'apifb:preview',
    (verticalId: string, geoId: string): Promise<ApifbPreview> =>
      previewApifbDoc(String(verticalId ?? ''), String(geoId ?? '')),
  );
  handle('apifb:load', (input: ApifbLoadInput): Promise<ApifbLoadResult> => loadEvents(input));
  handle('apifb:batch', (input: ApifbBatchInput): Promise<ApifbBatchResult> => runApifbBatch(input));
}
