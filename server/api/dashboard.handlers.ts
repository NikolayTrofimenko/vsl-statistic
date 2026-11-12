import { handle } from './rpc';
import { dashboard, dashboardDetail } from '../dashboard';
import { syncKaiten } from '../kaiten';
import type { DashDetail, DashPeriodKind, Dashboard } from '../../src/shared/dashboard.types';

/** Admin only (the owner / financier for now) — `dashboard:*` in `channelAccess()`. */
export function registerDashboardHandlers(): void {
  handle('dashboard:overview', (kind: DashPeriodKind, anchor: string | null): Promise<Dashboard> =>
    dashboard(kind, anchor ?? null),
  );
  handle('dashboard:detail', (metricId: string, kind: DashPeriodKind, anchor: string): Promise<DashDetail> =>
    dashboardDetail(String(metricId), kind, String(anchor ?? '')),
  );
  handle('dashboard:sync', (): Promise<void> => syncKaiten());
}
