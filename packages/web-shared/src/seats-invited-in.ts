/**
 * The seat each invitation's proposal took, read from the account's own history on a device: the leaf a successful
 * `seatInvited` call put into the account's signers, read from that call's own transaction. A seating this device cannot
 * read, or cannot tell from another, is refused rather than read as no seat.
 */
import { callsOnTheAccountIn, type GovernedCallDeps } from './governed-call-builder.js';
import { HEX64 } from '../../../src/midnight/directory-change-shape.js';
import { SeatingRefusedOnTheChain, TWO_SEATINGS, UNREAD_SEATING } from './seat-not-read-on-the-chain.js';

/** One seating the account's history shows: the proposal a `seatInvited` call closed and the one leaf it seated. */
export interface Seating { readonly proposal: string; readonly leaf: string }

type HistoryStep = {
  readonly kind: string; readonly transaction: string; readonly entryPoint?: string; readonly succeeded: boolean; readonly raw?: Uint8Array;
};

/**
 * Every seating in the account's history, oldest first: for each successful `seatInvited` call, the one proposal it
 * closed and the one leaf it put into the account's signers, read from that call's own transaction. The history's
 * states are each block's last, so no state says what one call did; the call's own operations do, whatever else its
 * block or its transaction held. Each transaction is read once. A seating step served without its transaction is a
 * read not made; one whose transaction does not read as one seating is refused for good (`SeatingRefusedOnTheChain`),
 * since a seat this device cannot read must not read as no seat.
 */
export function seatingsIn(
  deps: Pick<GovernedCallDeps, 'accountLedger' | 'runtimeState'> & Partial<Pick<GovernedCallDeps, 'ledger'>>,
  steps: readonly HistoryStep[], account: string,
): readonly Seating[] {
  if (deps.accountLedger === undefined) {
    throw new Error('this device was not given the account\'s reader, so which seat each invitation took was not read. Reload the page');
  }
  const seatings: Seating[] = [];
  const read = new Set<string>();
  for (const step of steps) {
    if (step.kind !== 'call' || !step.succeeded || read.has(step.transaction)) continue;
    if (step.raw === undefined) {
      if (step.entryPoint === 'seatInvited') {
        throw new Error('a seat taken on the account was served without its transaction, so which invitation it answered was not read. Read again');
      }
      continue;
    }
    read.add(step.transaction);
    const calls = callsOnTheAccountIn(deps, step.raw, account).filter((c) => c.entryPoint === 'seatInvited');
    if (step.entryPoint === 'seatInvited' && calls.length === 0) throw new SeatingRefusedOnTheChain(UNREAD_SEATING);
    for (const c of calls) {
      if (c.closed.size !== 1 || c.seated.size !== 1) throw new SeatingRefusedOnTheChain(UNREAD_SEATING);
      seatings.push({ proposal: [...c.closed][0]!, leaf: [...c.seated][0]! });
    }
  }
  return seatings;
}

/**
 * The leaf each proposal asked about seated among `seatings` (the account's history as `seatingsIn` read it), by its
 * identity in lower case, null for one no seating closed. Refuses the whole ask for an identity that is not thirty-two
 * bytes, and for good (`SeatingRefusedOnTheChain`) when two seatings closed one proposal asked about: a seat this
 * device cannot tell from another must not read as one of the two.
 */
export function seatsInvitedIn(seatings: readonly Seating[], proposals: readonly string[]): ReadonlyMap<string, string | null> {
  const out = new Map<string, string | null>();
  for (const asked of proposals) {
    const hex = String(asked).toLowerCase();
    if (!HEX64.test(hex)) throw new Error('an invitation\'s proposal was asked about by an identity that is not thirty-two bytes');
    const taken = seatings.filter((x) => x.proposal === hex);
    if (taken.length > 1) throw new SeatingRefusedOnTheChain(TWO_SEATINGS);
    out.set(hex, taken.length === 0 ? null : taken[0]!.leaf);
  }
  return out;
}
