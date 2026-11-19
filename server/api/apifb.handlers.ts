import { handle } from './rpc';
import { loadEvents, previewApifbDoc, runApifbBatch } from '../apifb/batch';
import { invalidateApifbCatalog, listApifbGeos, listApifbVerticals } from '../apifb/catalog';
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
  ApifbVerticalsResult,
} from '../../src/shared/api.types';

/** Admin only — `apifb:*` in `channelAccess()`. */
export function registerApifbHandlers(): void {
  handle('apifb:send', (input: ApifbSendInput): Promise<ApifbSendResult> => sendApifbEvent(input));
  handle('apifb:verticals', async (fresh?: boolean): Promise<ApifbVerticalsResult> => {
    if (fresh) invalidateApifbCatalog();
    const { list, warning } = await listApifbVerticals(Boolean(fresh));
    return { items: list.map(({ id, label }) => ({ id, label })), warning };
  });
  handle('apifb:geos', async (verticalId: string, fresh?: boolean): Promise<ApifbGeoInfo[]> => {
    const geos = await listApifbGeos(String(verticalId ?? ''), Boolean(fresh));
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
