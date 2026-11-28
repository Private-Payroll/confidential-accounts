/**
 * **WHAT EVERY MONEY STEP ON A VAULT READS THE SAME WAY, IN ONE PLACE**: the
 * vault's notes as this device reads them off the chain, the transaction that
 * created one of its outputs, a coin or a hash as the vault worker is handed
 * one, what a step sent straight to the chain is named by, and a time written
 * into a sentence. Creating a vault, the deposits, the payments, the rebuild of
 * the notes and the browser's check each call these, so each has one copy.
 */
import type { Hex } from '../../../src/core/crypto.js';
import type { EventOnTheWire, NoteOnTheWire } from './vault-builder.js';
import type { CreatingTransactionAnswer, VaultBuilderClient } from './vault-worker-client.js';
import { type ChainHereDoors, type VaultChainView } from './vault-doors.js';
import { notesOfARead, readHere, theWalletsIndexer } from './vault-read-here.js';

/** A time written into a sentence a person reads: the moment a deposit or a payment still on its way can no longer land, in this browser's own language and zone. */
export const timeShown = (ms: number): string => new Date(ms).toLocaleString();

/**
 * **THE VAULT'S NOTES AS THE CHAIN HOLDS THEM, READ ON THIS DEVICE**, for a
 * step that only asks whether a note it sent or spent has landed: the same read
 * as `vaultStandingHere`, without asking the wallet who holds the vault.
 */
export async function notesAsThisDeviceReadsThem(
  doors: Pick<ChainHereDoors, 'builder' | 'indexer'>,
  vault: Hex
): Promise<VaultChainView> {
  return notesOfARead(vault, await readHere(doors, vault));
}

/**
 * What a step sent straight to the chain is named by: nothing, since no service answered for it. The step is then
 * found on the chain as one whose answer from the service was lost: by the coin it kept, or, for a payment that keeps
 * no change, by its own transaction.
 */
export const NAMED_BY_NOTHING: { readonly txRef: string; readonly transactionHash: string | null } = Object.freeze({
  txRef: '',
  transactionHash: null
});

/**
 * `not-yet` carries `listed` when the vault's history was read in full and no
 * transaction on it carries the output: the chain has not made it, or the
 * indexer has not caught up. Without it, something could not be read.
 */
type CreatingTransactionFound =
  | { state: 'found'; createdIn: Hex }
  | { state: 'not-yet'; listed?: 'none' }
  | { state: 'unknown'; why: string; listed?: 'none' };

/**
 * **WHICH TRANSACTION CREATED AN OUTPUT OF THIS VAULT, AS THE CHAIN SAYS, OR
 * WHY IT CANNOT BE SAID.**
 *
 * Asked first of the transaction the service named, by its hash, when it named
 * one; then, when that does not answer, of the vault's own history by the
 * output's commitment, which needs nothing from the send at all. Either way
 * the events must carry exactly one output with this commitment, owned by this
 * vault, and be one transaction's: that is judged in the vault worker, because
 * judging it loads the ledger, which this page does not carry. So a lookup
 * proposes a transaction and never decides one. `not-yet` is a chain or a
 * worker that cannot answer yet, and asking again may answer it.
 */
export async function creatingTransactionOfOutput(
  doors: {
    readonly builder: Pick<VaultBuilderClient, 'creatingTransaction' | 'eventsOf' | 'createdBy'>;
    readonly indexer: ChainHereDoors['indexer'];
  },
  vault: Hex,
  output: string,
  transactionHash: string | null,
  /** What the output is, as a refusal names it. */
  what = 'this deposit'
): Promise<CreatingTransactionFound> {
  const judge = async (hash: string, events: EventOnTheWire[]): Promise<CreatingTransactionFound> => {
    if (events.length === 0) return { state: 'not-yet' };
    let judged: CreatingTransactionAnswer;
    try {
      judged = await doors.builder.creatingTransaction({ vault, commitment: output, transactionHash: hash, events });
    } catch {
      return { state: 'not-yet' };
    }
    if (judged.state === 'found') return { state: 'found', createdIn: judged.createdIn as Hex };
    if (judged.state === 'refused')
      return { state: 'unknown', why: `the transfer this page was given does not show ${what}` };
    return { state: 'not-yet' };
  };
  const indexer = await theWalletsIndexer(doors, vault);
  const named = transactionHash === null ? null : transactionHash.toLowerCase();
  let byName: CreatingTransactionFound | null = null;
  if (named !== null && HEX64.test(named)) {
    try {
      byName = await judge(named, await doors.builder.eventsOf({ transactionHash: named, indexer }));
    } catch {
      byName = { state: 'not-yet' };
    }
    if (byName.state === 'found') return byName;
  }
  let byOutput: CreatingTransactionFound;
  try {
    const found = await doors.builder.createdBy({ vault, commitment: output, indexer });
    byOutput =
      found === null
        ? { state: 'not-yet', listed: 'none' }
        : await judge(String(found.transactionHash).toLowerCase(), found.events);
  } catch {
    byOutput = { state: 'not-yet' };
  }
  if (byOutput.state === 'found' || byOutput.state === 'unknown') return byOutput;
  /* The history could not be read in full: ask again. */
  if (byOutput.listed !== 'none') return byOutput;
  /* The history, read in full, has no transaction that carries it: what the named one said stands, if it said anything. */
  return byName?.state === 'unknown' ? { ...byName, listed: 'none' } : byOutput;
}

export const HEX64 = /^[0-9a-f]{64}$/u;

export const lowerOf = (h: string): string => h.toLowerCase();
export const coinOnTheWire = (c: {
  readonly nonce: Hex;
  readonly token: Hex;
  readonly value: bigint;
}): NoteOnTheWire => ({ nonce: c.nonce, token: c.token, value: c.value.toString() });
