import { handle } from './rpc';
import { currentUser } from '../users';
import { deleteDoc, getDoc, listDocs, saveDoc } from '../knowledge';
import type { KbDoc, KbDocInput, KbDocSummary } from '../../src/shared/api.types';

/** list/get are open to every account; save and delete are admin channels (`server/http/app.ts`). */
export function registerKnowledgeHandlers(): void {
  handle('knowledge:list', (): KbDocSummary[] => listDocs());
  handle('knowledge:get', (id: number): KbDoc => getDoc(Number(id)));
  handle('knowledge:save', (input: KbDocInput): KbDoc => saveDoc(input ?? ({} as KbDocInput), currentUser().id));
  handle('knowledge:delete', (id: number): Promise<void> => deleteDoc(Number(id)));
}
