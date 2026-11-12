import { handle } from './rpc';
import { createUser, currentUser, deleteAccessRole, listAccessRoles, listUsers, saveAccessRole, setPassword, updateUser } from '../users';
import type { AccessRole, AccessRoleInput, UserInfo, UserInput, UserPatch } from '../../src/shared/api.types';

/** Admin only — gated by `adminOnly()` in `server/http/app.ts`. */
export function registerUsersHandlers(): void {
  handle('users:list', (): UserInfo[] => listUsers());
  handle('users:create', (input: UserInput): UserInfo => createUser(input));
  handle('users:update', (id: number, patch: UserPatch): void => updateUser(currentUser(), id, patch));
  handle('users:setPassword', (id: number, password: string): void => setPassword(id, password));
  handle('users:roles', (): AccessRole[] => listAccessRoles());
  handle('users:saveRole', (role: AccessRoleInput): AccessRole => saveAccessRole(role ?? { name: '', sections: [] }));
  handle('users:deleteRole', (id: number): void => deleteAccessRole(Number(id)));
}
