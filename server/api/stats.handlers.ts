import { handle } from './rpc';
import { publicUrl } from '../config';
import { createKey, listKeys, revokeKey } from '../http/public-api';
import { currentUser } from '../users';
import { craftStatus } from '../craft/sync';
import { deleteLandVideo, detail, facets, overview, updateLandVideo } from '../stats/report';
import type {
  ApiKeyInfo,
  CraftStatus,
  LandVideoDetail,
  LandVideoPatch,
  StatsOverview,
  StatsFacets,
  StatsFilter,
} from '../../src/shared/api.types';

export function registerStatsHandlers(): void {
  handle('stats:facets', (): StatsFacets => facets());
  handle('stats:overview', (filter: StatsFilter): StatsOverview => overview(filter));
  handle('stats:detail', (id: number, filter: StatsFilter): LandVideoDetail => detail(id, filter));
  handle('stats:updateLandVideo', (id: number, patch: LandVideoPatch): void => updateLandVideo(id, patch));
  handle('stats:deleteLandVideo', (id: number): void => deleteLandVideo(id));
  // No data-land in the snippet: pasted as-is it must still work, and the
  // landing then shows up under its own host + path.
  handle('stats:snippet', (): string => `<script src="${publicUrl()}/t.js" defer></script>`);
  handle('stats:apiKeys', (): ApiKeyInfo[] => listKeys());
  handle('stats:createApiKey', (name: string): { key: string; info: ApiKeyInfo } => createKey(currentUser(), name));
  handle('stats:revokeApiKey', (id: number): void => revokeKey(currentUser(), Number(id)));
  handle('stats:apiBase', (): string => `${publicUrl()}/api/v1`);
  handle('stats:craftStatus', (): CraftStatus => craftStatus());
}
