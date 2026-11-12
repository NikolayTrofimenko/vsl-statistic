import { scopedLogger } from '../logger';

/**
 * Channel registry: one named handler per API method.
 *
 * Each method of the `VslStatApi` contract in `src/shared` maps to one channel,
 * so that file stays the single source of truth for both sides.
 */

const log = scopedLogger('rpc');

type StoredHandler = (...args: unknown[]) => unknown;

const channels = new Map<string, StoredHandler>();

/** Register a channel. Throws on a duplicate name — that is always a bug. */
export function handle<A extends unknown[], R>(
  channel: string,
  fn: (...args: A) => R,
): void {
  if (channels.has(channel)) {
    throw new Error(`Duplicate RPC channel: ${channel}`);
  }
  channels.set(channel, fn as unknown as StoredHandler);
}

export function hasChannel(channel: string): boolean {
  return channels.has(channel);
}

export function listChannels(): string[] {
  return [...channels.keys()].sort();
}

/** Invoke a channel with a positional argument list. */
export async function invoke(channel: string, args: unknown[]): Promise<unknown> {
  const fn = channels.get(channel);
  if (!fn) throw new Error(`Unknown channel: ${channel}`);
  const started = Date.now();
  try {
    return await fn(...args);
  } finally {
    const ms = Date.now() - started;
    if (ms > 1000) log.debug(`${channel} took ${ms}ms`);
  }
}
