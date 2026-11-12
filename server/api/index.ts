import { registerCapsHandlers } from './caps.handlers';
import { registerDomainsHandlers } from './domains.handlers';
import { registerDashboardHandlers } from './dashboard.handlers';
import { registerDriveHandlers } from './drive.handlers';
import { registerGrantsHandlers } from './grants.handlers';
import { registerKnowledgeHandlers } from './knowledge.handlers';
import { registerLibraryHandlers } from './library.handlers';
import { registerStatsHandlers } from './stats.handlers';
import { registerUsersHandlers } from './users.handlers';

export function registerApiHandlers(): void {
  registerCapsHandlers();
  registerDomainsHandlers();
  registerDashboardHandlers();
  registerDriveHandlers();
  registerGrantsHandlers();
  registerKnowledgeHandlers();
  registerLibraryHandlers();
  registerStatsHandlers();
  registerUsersHandlers();
}
