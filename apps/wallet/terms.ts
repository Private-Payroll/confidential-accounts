import { WalletFacade } from '@midnightntwrk/wallet-sdk';
import { FACADE_CONFIG } from './facade.js';
import { NETWORK } from './config.js';

/**
 * THE NETWORK'S TERMS — decided once, built later, exactly as decided:
 * shown ONCE, on the first LIVE send screen; the hash recorded locally;
 * BLOCKING NOTHING. The facade's own documentation says wallet builders
 * should display the current T&C and obtain the hash
 * (`WalletFacade.fetchTermsAndConditions` — wallet-sdk-facade/dist/
 * index.d.ts:243–258), and it was checked that no submit, balance or
 * transfer path takes the hash — so this is the network's expectation met,
 * never a gate of ours in front of somebody's own money.
 *
 * FETCHING IS AN INDEXER CALL, which is why the rehearsal never does it
 * (its promise is that nothing dials), and why the live send screen — a
 * deliberate act, behind a button named Send — is where it happens.
 *
 * The record is a NETWORK fact, not an account fact, so unlike every
 * account-scoped record in `storage.ts` it is not sealed to a secret or
 * fingerprint-checked: the same terms stand for whoever uses this browser,
 * and the key carries the network name so a testnet record can never stand
 * in for stagenet's.
 */

export interface TermsSeen {
  /** The hex SHA-256 of the terms document, as the indexer reported it. */
  readonly hash: string;
  /** Where the document itself lives — shown as a link, never fetched. */
  readonly url: string;
  /** When this browser first showed them, epoch ms. */
  readonly seenAt: number;
}

const KEY = `midnight-identity:terms:${NETWORK}`;

/** The terms this browser has already shown, or null. A damaged record is
 * a cache miss, never a dead end: the terms simply show again. */
export function loadTermsSeen(): TermsSeen | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Partial<TermsSeen>;
    if (typeof record.hash !== 'string' || typeof record.url !== 'string'
      || typeof record.seenAt !== 'number') return null;
    return { hash: record.hash, url: record.url, seenAt: record.seenAt };
  } catch {
    return null;
  }
}

export function recordTermsSeen(terms: { hash: string; url: string }): void {
  try {
    const record: TermsSeen = { hash: terms.hash, url: terms.url, seenAt: Date.now() };
    localStorage.setItem(KEY, JSON.stringify(record));
  } catch { /* a failure to record means they show again — never worse */ }
}

/** The SDK's own static fetch, over this wallet's own configuration. */
export function fetchNetworkTerms(): Promise<{ hash: string; url: string }> {
  return WalletFacade.fetchTermsAndConditions(FACADE_CONFIG);
}
