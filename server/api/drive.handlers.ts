import { handle } from './rpc';
import { driveFolderId, googleRedirectUri } from '../config';
import { disconnect, driveWritable, googleConfigured, googleConnected, googleEmail } from '../drive/google';
import { runSync, syncState } from '../drive/sync';
import type { DriveStatus, SyncState } from '../../src/shared/api.types';

export function registerDriveHandlers(): void {
  handle('drive:status', (): DriveStatus => ({
    configured: googleConfigured(),
    connected: googleConnected(),
    email: googleEmail(),
    folderId: driveFolderId(),
    redirectUri: googleRedirectUri(),
    writable: driveWritable(),
    sync: syncState(),
  }));

  handle('drive:disconnect', (): Promise<void> => disconnect());

  handle('drive:sync', (): Promise<SyncState> => runSync());
}
