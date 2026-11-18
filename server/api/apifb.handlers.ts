import { handle } from './rpc';
import { sendApifbEvent } from '../apifb/send';
import type { ApifbSendInput, ApifbSendResult } from '../../src/shared/api.types';

/** Admin only — `apifb:*` in `channelAccess()`. */
export function registerApifbHandlers(): void {
  handle('apifb:send', (input: ApifbSendInput): Promise<ApifbSendResult> => sendApifbEvent(input));
}
