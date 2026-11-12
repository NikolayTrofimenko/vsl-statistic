import { handle } from './rpc';
import {
  banSub,
  buyDomain,
  buyerGroups,
  checkDomains,
  cleanupRoot,
  domainsOverview,
  issueSubdomains,
  renewDomains,
  slotsOf,
  updateRoot,
} from '../domains';
import { currentUser } from '../users';
import type {
  BuyInput,
  BuyResult,
  DomainCheck,
  DomainsOverview,
  IssueInput,
  IssueResult,
  RenewResult,
  RootPatch,
  SubdomainSlot,
} from '../../src/shared/api.types';

/** Admin only — gated by `adminOnly()` in `server/http/app.ts`. */
export function registerDomainsHandlers(): void {
  handle('domains:overview', (fresh: boolean | null): Promise<DomainsOverview> => domainsOverview(Boolean(fresh)));
  handle('domains:subdomains', (root: string): Promise<SubdomainSlot[]> => slotsOf(String(root)));
  handle('domains:update', (root: string, patch: RootPatch): void => updateRoot(String(root), patch ?? {}));
  handle('domains:banSub', (host: string, banned: boolean, remove: boolean): Promise<void> =>
    banSub(String(host), Boolean(banned), Boolean(remove)),
  );
  handle('domains:buyers', (): Promise<string[]> => buyerGroups());
  handle('domains:issue', (input: IssueInput): Promise<IssueResult[]> => issueSubdomains(currentUser(), input));
  handle('domains:cleanup', (root: string): Promise<{ removed: number }> => cleanupRoot(currentUser(), String(root)));
  handle('domains:renew', (domains: string[]): Promise<RenewResult[]> =>
    renewDomains(currentUser(), Array.isArray(domains) ? domains : []),
  );
  handle('domains:check', (domains: string[]): Promise<DomainCheck[]> => checkDomains(Array.isArray(domains) ? domains : []));
  handle('domains:buy', (input: BuyInput): Promise<BuyResult> => buyDomain(currentUser(), input));
}
