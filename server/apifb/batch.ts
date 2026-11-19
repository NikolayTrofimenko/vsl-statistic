import type {
  ApifbBatchInput,
  ApifbBatchResult,
  ApifbEventPayload,
  ApifbLoadInput,
  ApifbLoadResult,
  ApifbPreview,
} from '../../src/shared/api.types';
import { loadApifbDoc } from './docs';
import { parseApifbLines } from './parse';
import { META_EVENT_CHUNK, sendApifbEventChunk } from './send';

export async function previewApifbDoc(verticalId: string, geoId: string): Promise<ApifbPreview> {
  const loaded = await loadEvents({ verticalId, geoId });
  return {
    geoLabel: loaded.geoLabel,
    docId: loaded.docId,
    count: loaded.events.length,
    sample: loaded.events
      .slice(0, 5)
      .map((e) => summarize(e.eventName, e.phone, e.clientIp, e.externalId)),
  };
}

export async function loadEvents(input: ApifbLoadInput): Promise<ApifbLoadResult> {
  const rawText = String(input?.rawText ?? '').trim();
  if (rawText) {
    const events = parseApifbLines(rawText).map((e) => e.input);
    if (!events.length) throw new Error('В тексте нет строк APIFB.');
    return { geoLabel: 'вставка', docId: '—', events };
  }
  const verticalId = String(input?.verticalId ?? '').trim();
  const geoId = String(input?.geoId ?? '').trim();
  if (!verticalId || !geoId) throw new Error('Выбери направление и гео — или вставь строки.');
  const { geoLabel, docId, events } = await loadApifbDoc(verticalId, geoId);
  return { geoLabel, docId, events: events.map((e) => e.input) };
}

/**
 * One chunk (≤50 events) → one Meta Graph call. The UI loads the dump once
 * and walks chunks so progress moves and nothing hits a multi-minute RPC timeout.
 */
export async function runApifbBatch(input: ApifbBatchInput): Promise<ApifbBatchResult> {
  const pixelId = String(input?.pixelId ?? '').trim();
  const accessToken = String(input?.accessToken ?? '').trim();
  if (!pixelId) throw new Error('Укажи Pixel ID.');
  if (!accessToken) throw new Error('Укажи access token.');

  const events = Array.isArray(input?.events) ? (input.events as ApifbEventPayload[]) : [];
  if (!events.length) throw new Error('Нет событий в чанке.');
  if (events.length > META_EVENT_CHUNK) {
    throw new Error(`Слишком большой чанк (макс. ${META_EVENT_CHUNK}).`);
  }

  const offset = Math.max(0, Number(input.indexOffset ?? 0) || 0);
  const testEventCode = input.testEventCode?.trim() || null;
  const result = await sendApifbEventChunk(pixelId, accessToken, events, testEventCode);

  if (result.ok) {
    return {
      total: events.length,
      ok: events.length,
      failed: 0,
      items: events.map((e, i) => ({
        index: offset + i,
        ok: true,
        eventName: e.eventName,
        error: null,
      })),
    };
  }

  return {
    total: events.length,
    ok: 0,
    failed: events.length,
    items: events.map((e, i) => ({
      index: offset + i,
      ok: false,
      eventName: e.eventName,
      error: result.error || 'ошибка Meta',
    })),
  };
}

function summarize(
  eventName: string,
  phone: string | null | undefined,
  ip: string | null | undefined,
  externalId: string | null | undefined,
): string {
  return [eventName, phone || ip || externalId || '—'].join(' · ');
}
