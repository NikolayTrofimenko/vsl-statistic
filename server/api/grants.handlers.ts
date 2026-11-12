import { handle } from './rpc';
import { applyGrants, deleteTeam, grantLog, grantsOverview, mayOpenGrants, saveTeam } from '../grants';
import { currentUser } from '../users';
import type {
  GrantChange,
  GrantLogEntry,
  GrantResult,
  GrantsOverview,
  GrantTeam,
  GrantTeamInput,
  SessionUser,
} from '../../src/shared/api.types';

/** The head of buying (section `grants`) and team leads — each call scoped in `server/grants`. */
export function registerGrantsHandlers(): void {
  handle('grants:overview', (): Promise<GrantsOverview> => grantsOverview(caller()));
  handle('grants:apply', (changes: GrantChange[]): Promise<GrantResult[]> => applyGrants(caller(), changes));
  handle('grants:saveTeam', (input: GrantTeamInput): GrantTeam => saveTeam(caller(), input));
  handle('grants:deleteTeam', (id: number): void => deleteTeam(caller(), Number(id)));
  handle('grants:log', (): GrantLogEntry[] => grantLog(caller()));
}

function caller(): SessionUser {
  const user = currentUser();
  if (!mayOpenGrants(user)) throw new Error('Нет доступа к разделу «Доступы».');
  return user;
}
