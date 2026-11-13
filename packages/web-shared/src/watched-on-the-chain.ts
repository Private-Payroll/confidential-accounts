/**
 * **WHAT THE CHAIN SHOWS OF A CALL SENT, WAITED FOR**, at the indexer the person's own wallet names.
 */
import type { FromTheChainDoors } from './governance-from-the-chain.js';

/** How long a call sent is waited for on the chain before it is said not to have landed: two minutes, about twenty blocks. */
export const LANDED_WITHIN_MS = 2 * 60 * 1000;
/** How often the chain is read while a call sent is waited for. */
const LANDED_EVERY_MS = 5 * 1000;

/**
 * **WHAT THE CHAIN SHOWS OF A CALL SENT, WAITED FOR**: `went` read at the
 * indexer the person's own wallet names, at once and then every `everyMs`
 * until it answers or `withinMs` has passed - or, once `over` says there is
 * nothing more to wait for, after one more read; null when it never answered.
 */
export async function watchedOnTheChain<T>(
  doors: Pick<FromTheChainDoors, 'watch'>, went: () => Promise<T | null>, over: () => boolean = () => false,
): Promise<T | null> {
  const everyMs = doors.watch?.everyMs ?? LANDED_EVERY_MS;
  const withinMs = doors.watch?.withinMs ?? LANDED_WITHIN_MS;
  const sleep = doors.watch?.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  for (let waited = 0; ; waited += everyMs) {
    const seen = await went();
    if (seen !== null) return seen;
    if (waited >= withinMs || over()) return null;
    await sleep(everyMs);
  }
}
