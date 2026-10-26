/**
 * **WHAT A VAULT HOLDS PRIVATELY, READ ON A SIGNER'S DEVICE FROM THE POOL THAT
 * DEVICE OPENS, AGAINST WHAT THE CHAIN SAYS THE VAULT HOLDS.**
 *
 * A vault's private money is its notes. The chain holds only a commitment to
 * each one, which says nothing about its value, and the record of the notes
 * themselves is sealed so that only a signer's own key opens it. So the one
 * place a private balance can be read is a signer's device, and this is that
 * reader. It answers the same three ways the service's reader does:
 *
 *   - **held**, only when every note the pool records is one the chain holds.
 *     A note the chain holds that the pool does not is counted when a record
 *     on this device names it as the vault's (a payment's change, a deposit
 *     on its way, or a note the rebuild before the read found in the vault's
 *     records), and otherwise ignored: anyone may deposit into a vault, and
 *     a note nothing here names is not money the vault can spend;
 *   - **unreadable**, when the chain did not answer or shows no vault here,
 *     or the vault has notes on the chain and this device has no record of
 *     them;
 *   - **contradicted**, when the pool and the chain disagree. A pool that
 *     disagrees with the chain has no balance: it is never summed.
 *
 * `privateNotes` is the same read for a screen, and adds a fourth answer:
 * **nothing yet**, for a vault whose pool was never opened and which holds no
 * note on the chain. A pool that is missing while the chain holds notes is
 * not nothing: it is a record this device cannot find, and is unreadable.
 *
 * **IT READS PUBLIC MONEY TOO.** Public money is a contract balance read off
 * the vault's state, and a read of the vault carries it as a list of tokens and
 * amounts. A payment's check reads that list here, from the same read of the
 * vault, so no payment's amount goes to the company's service to be checked
 * there. `readPublicHoldings` reads the same list for the vault's screen, and
 * says so when there is none to read.
 *
 * **NOTHING IT READS LEAVES THIS DEVICE.** The vault's address goes out to ask
 * the chain what it holds; the notes, their values and the sum stay here.
 */
import type { LedgerForm } from '../../../src/core/assets.js';
import type { Hex } from '../../../src/core/crypto.js';
import type { FitAnswer, HoldingAnswer, PaymentAsked, VaultHoldings } from '../../../src/core/vault-holdings.js';
import { poolAgainstChain } from '../../../src/midnight/pool-against-chain.js';
import type { PaymentsFitAnswer } from '../../../src/midnight/vault-notes.js';
import type { PoolTheChainHolds } from './deposit-on-device.js';

/** One note as this device's pool records it. */
export interface PoolNote {
  readonly nonce: Hex;
  readonly token: Hex;
  readonly value: bigint;
  readonly createdIn?: Hex;
}

export interface DeviceHoldingsDoors {
  /**
   * What the chain holds for the vault now, as this device's vault worker read
   * it at the indexer the person's own wallet names: the vault's note
   * commitments, and whether they were read off a ledger of the shape this
   * build's vault has. A ledger of another shape answers the
   * question about notes out of whichever field sits in that place.
   */
  readonly chain: (vault: Hex) => Promise<ChainNotesView>;
  /** The vault's pool, opened on this device with this signer's own key, or `null` when the company's records hold no pool for it at all (never opened). A pool that is there and cannot be opened throws. */
  readonly pool: (vault: Hex) => Promise<readonly PoolNote[] | null>;
  /** The commitment the vault holds on the chain for one note, computed on this device. */
  readonly heldCommitmentOf: (vault: Hex, note: PoolNote) => Promise<string>;
  /**
   * Whether the notes can make the payments one at a time, through the choice
   * of note a payment makes: `fits`, or `does-not-fit` naming the first they
   * cannot. Refuses only when it could not ask.
   */
  readonly paymentsFit: (notes: readonly PoolNote[], payments: ReadonlyArray<{ token: Hex; amount: bigint }>) => Promise<PaymentsFitAnswer>;
  /**
   * The notes this device's records name as the vault's that its pool may not
   * hold yet: the change of a payment on its way, the coin of a deposit on its
   * way. Absent, nothing is recovered, and every note the pool does not hold is
   * ignored.
   */
  readonly accountedFor?: (vault: Hex) => Promise<readonly PoolNote[]>;
  /**
   * **THE POOL AND JOURNALS THE CHAIN VOUCHES FOR, FILED AGAIN UNDER THIS
   * DEVICE'S OWN SEAT** (`fileThePoolTheChainHolds`), asked on every read: a
   * seat that left may have carried out a payment after its removal was raised
   * and filed past the boundary its leaving keeps, and no pool or journal write
   * is built on top of such a version until this has run. `held` says whether
   * the chain holds a note. When it filed the pool, the pool is read again;
   * anything it could not take is said as the read's answer. Absent, such a
   * pool stays contradicted. A door that also rebuilds the vault's notes
   * (`vaultNotesHere`) returns them as `notes`: each is a note the chain holds
   * that the vault's records name, and is counted as `accountedFor`'s are.
   */
  readonly fileAgain?: (vault: Hex, held: (note: PoolNote) => Promise<boolean>) => Promise<
    Pick<PoolTheChainHolds, 'answer' | 'said'> & { readonly notes?: readonly PoolNote[] }
  >;
}

/** The parts of a read of a vault this reader reads: this device's own, in its vault worker. */
export interface ChainNotesView {
  readonly onChain: boolean;
  readonly notes?: readonly string[];
  /** `true` only when the notes were read off a ledger of the shape this build's vault has. */
  readonly notesFromThisBuild?: boolean;
  /** Why they were not, when the read could say. */
  readonly notesWhy?: string;
}

/** Where an unreadable answer broke: the chain could not be asked or shows no vault, the chain's ledger is not the shape this build reads, or this device has no record of notes the chain holds. */
type UnreadableBecause = 'chain' | 'layout' | 'record';

type Reconciled = { readonly of: 'notes'; readonly notes: readonly PoolNote[] }
  | { readonly of: 'nothing-yet' }
  | { readonly of: 'unreadable'; readonly why: string; readonly because: UnreadableBecause; readonly cause?: unknown }
  | { readonly of: 'contradicted'; readonly why: string };

const why = (e: unknown): string => (e as Error)?.message ?? String(e);

/**
 * **THE POOL, ONLY IF THE CHAIN AGREES WITH IT, BOTH WAYS.** Which answer it
 * is, is `poolAgainstChain`'s, the same comparison the company's service makes
 * over its own read; what is here is how this device reads the chain and says
 * each answer.
 */
async function reconciled(doors: DeviceHoldingsDoors, vault: Hex): Promise<Reconciled> {
  let view: ChainNotesView;
  try {
    view = await doors.chain(vault);
  } catch (e) {
    return { of: 'unreadable', because: 'chain', cause: e, why: `the chain could not be asked what this vault holds: ${why(e)}` };
  }
  if (view?.onChain !== true) {
    return { of: 'unreadable', because: 'chain', why: 'the chain shows no vault at this address yet' };
  }
  if (!Array.isArray(view.notes)) {
    return { of: 'unreadable', because: 'chain', why: 'the chain was read and did not say which notes this vault holds' };
  }
  if (view.notesFromThisBuild !== true) {
    return {
      of: 'unreadable',
      because: 'layout',
      why: 'the read of the chain did not confirm that this vault is laid out the way this version of the product '
        + `reads one, so which notes it holds is not known${typeof view.notesWhy === 'string' ? `: ${view.notesWhy}` : ''}`,
    };
  }
  const onChain = new Set(view.notes.map((n) => String(n).toLowerCase()));
  if (doors.fileAgain === undefined) return againstTheChain(doors, vault, onChain);
  const filed = await doors.fileAgain(vault, async (note) => onChain.has((await doors.heldCommitmentOf(vault, note)).toLowerCase()));
  /* What a seat that left filed and this device could not take is said, never summed past. */
  if (filed.said.length > 0) return { of: 'contradicted', why: `${filed.said.join('. ')}.` };
  return againstTheChain(doors, vault, onChain, filed.notes);
}

/** The pool this device believes against the notes the chain holds for the vault (`onChain`), once. */
async function againstTheChain(
  doors: DeviceHoldingsDoors, vault: Hex, onChain: ReadonlySet<string>, rebuilt: readonly PoolNote[] = [],
): Promise<Reconciled> {
  const filed = await doors.pool(vault);
  if (filed === null) {
    if (onChain.size === 0) return { of: 'nothing-yet' };
    return {
      of: 'unreadable',
      because: 'record',
      why: `the chain holds ${onChain.size} note(s) for this vault and this device has no record of its notes`,
    };
  }
  const notes = filed;
  const held: Array<{ note: PoolNote; commitment: string }> = [];
  for (const note of notes) held.push({ note, commitment: (await doors.heldCommitmentOf(vault, note)).toLowerCase() });
  const named: Array<{ note: PoolNote; commitment: string }> = [];
  for (const note of [...(await doors.accountedFor?.(vault) ?? []), ...rebuilt]) {
    named.push({ note, commitment: (await doors.heldCommitmentOf(vault, note)).toLowerCase() });
  }
  const verdict = poolAgainstChain(held, { has: (c) => onChain.has(c), size: BigInt(onChain.size) }, named);
  if (verdict.of === 'pool-claims-more') {
    return {
      of: 'contradicted',
      why: `${verdict.missing.length} of the ${notes.length} note(s) this vault's record holds are not among the notes the `
        + 'chain holds for it, so the record claims money the vault cannot spend',
    };
  }
  if (verdict.of === 'counts-differ') {
    return {
      of: 'contradicted',
      why: `this vault's record holds ${verdict.poolHolds} note(s) and counts one of them more than once, so it counts money twice`,
    };
  }
  /* Notes nothing here names are left out: never the vault's to spend, and never a reason to stop reading. */
  return { of: 'notes', notes: [...notes, ...verdict.recovered] };
}

/** What a screen is told of a vault's private notes. `amounts` has one sum for each token asked for, in the order they were asked, and `unrecognised` counts the other tokens the vault holds a note of, none of which is summed. */
type PrivateNotesAnswer =
  | { readonly of: 'held'; readonly amounts: readonly bigint[]; readonly unrecognised: number }
  | { readonly of: 'nothing-yet' }
  | { readonly of: 'unreadable'; readonly why: string; readonly because: UnreadableBecause; readonly cause?: unknown }
  | { readonly of: 'contradicted'; readonly why: string };

interface DeviceVaultHoldings extends VaultHoldings {
  privateNotes(vault: string, named: readonly string[]): Promise<PrivateNotesAnswer>;
}

const NO_NOTES_YET = 'this vault has no record of private notes yet, so its private money is not known';

export const deviceVaultHoldings = (doors: DeviceHoldingsDoors): DeviceVaultHoldings => ({
  privateNotes: async (vault: string, named: readonly string[]): Promise<PrivateNotesAnswer> => {
    const r = await reconciled(doors, vault as Hex);
    if (r.of !== 'notes') return r;
    const sums = new Map<string, bigint>();
    for (const token of named) sums.set(token.toLowerCase(), 0n);
    const others = new Set<string>();
    for (const note of r.notes) {
      const token = note.token.toLowerCase();
      const sum = sums.get(token);
      if (sum !== undefined) sums.set(token, sum + note.value);
      else if (note.value > 0n) others.add(token);
    }
    return { of: 'held', amounts: named.map((t) => sums.get(t.toLowerCase())!), unrecognised: others.size };
  },

  held: async (vault: string, form: LedgerForm, token: string): Promise<HoldingAnswer> => {
    if (form === 'unshielded') {
      const read = await publicHoldingsOfTheVault(doors, vault);
      if (read.of !== 'held') return read;
      const wanted = token.toLowerCase();
      return { of: 'held', amount: read.holdings.filter((h) => h.token.toLowerCase() === wanted).reduce((a, h) => a + h.amount, 0n) };
    }
    if (form !== 'shielded') return { of: 'unreadable', why: `"${String(form)}" is not a form money takes on Midnight` };
    const r = await reconciled(doors, vault as Hex);
    if (r.of === 'nothing-yet') return { of: 'unreadable', why: NO_NOTES_YET };
    if (r.of !== 'notes') return r.of === 'unreadable' ? { of: 'unreadable', why: r.why } : { of: 'contradicted', why: r.why };
    const wanted = token.toLowerCase();
    return { of: 'held', amount: r.notes.filter((n) => n.token.toLowerCase() === wanted).reduce((a, n) => a + n.value, 0n) };
  },

  fits: async (vault: string, payments: ReadonlyArray<PaymentAsked>): Promise<FitAnswer> => {
    if (payments.length > 0 && payments.every((p) => p.payee.kind === 'unshielded')) return publicPaymentsFit(doors, vault, payments);
    if (payments.some((p) => p.payee.kind !== 'shielded')) {
      return { of: 'unreadable', why: 'these payments mix private and public money, and a vault pays one run in one form' };
    }
    const r = await reconciled(doors, vault as Hex);
    if (r.of === 'nothing-yet') return { of: 'unreadable', why: NO_NOTES_YET };
    if (r.of !== 'notes') return r.of === 'unreadable' ? { of: 'unreadable', why: r.why } : { of: 'contradicted', why: r.why };
    /*
     * Only the walk's own answer is an answer about the notes. Anything else -
     * the background thread not starting, a payment it could not read - is a
     * failure to ask, and is passed on as that rather than as money short.
     */
    const answer = await doors.paymentsFit(r.notes, payments.map((p) => ({ token: p.token as Hex, amount: p.amount })));
    if (answer?.of === 'fits') return { of: 'fits' };
    if (answer?.of === 'does-not-fit') {
      /* The note-level reason ends by advising a merge, and no vault can merge notes. */
      return { of: 'does-not-fit', why: String(answer.why).replace(/\s*Merge them first[^.]*\.?\s*$/, '') };
    }
    throw new Error('the check of whether this vault can make each payment did not finish on this device. Reload the page and try again');
  },
});

/* ------------------------------------------------ what it holds publicly */

/** The vault's public money from the same read of the vault the private reads ask, or why it could not be read. */
async function publicHoldingsOfTheVault(doors: DeviceHoldingsDoors, vault: string): Promise<PublicHoldingsAnswer> {
  try {
    return publicHoldingsFromView(await doors.chain(vault as Hex));
  } catch (e) {
    return { of: 'unreadable', why: `the chain could not be asked what this vault holds publicly: ${why(e)}` };
  }
}

/**
 * **WHETHER THE VAULT'S PUBLIC MONEY COVERS EVERY PUBLIC PAYMENT ASKED.** A public
 * payment is paid out of the contract's balance in the token it names, with no
 * notes to fit, so it fits when the balance of each token covers what the
 * payments in that token add up to.
 */
async function publicPaymentsFit(doors: DeviceHoldingsDoors, vault: string, payments: ReadonlyArray<PaymentAsked>): Promise<FitAnswer> {
  const read = await publicHoldingsOfTheVault(doors, vault);
  if (read.of !== 'held') return read;
  const asked = new Map<string, bigint>();
  for (const p of payments) asked.set(p.token.toLowerCase(), (asked.get(p.token.toLowerCase()) ?? 0n) + p.amount);
  for (const [token, amount] of asked) {
    const held = read.holdings.filter((h) => h.token.toLowerCase() === token).reduce((a, h) => a + h.amount, 0n);
    if (held < amount) return { of: 'does-not-fit', why: `the vault holds ${held} of token ${token} publicly and the payments in it add up to ${amount}` };
  }
  return { of: 'fits' };
}

/** What the vault's screen shows about its public money: every token and amount, or why it could not be read. */
export type PublicHoldingsAnswer =
  | { readonly of: 'held'; readonly holdings: ReadonlyArray<{ readonly token: string; readonly amount: bigint }> }
  | { readonly of: 'unreadable'; readonly why: string };

const COLOUR = /^[0-9a-f]{64}$/u;
const WHOLE = /^[0-9]+$/u;

/**
 * **THE VAULT'S PUBLIC MONEY, AS A READ OF THE VAULT'S STATE GAVE IT.** An empty list is the vault holding no public money; anything that is
 * not a list of tokens and whole amounts is not a reading, and is said to be
 * unreadable rather than shown as nothing.
 */
function publicHoldingsFromView(view: unknown): PublicHoldingsAnswer {
  const v = view as { onChain?: unknown; publicBalances?: unknown; publicBalancesWhy?: unknown } | null | undefined;
  if (v?.onChain !== true) return { of: 'unreadable', why: 'the vault is not on the chain yet' };
  if (!Array.isArray(v.publicBalances)) {
    return {
      of: 'unreadable',
      why: typeof v.publicBalancesWhy === 'string' && v.publicBalancesWhy !== ''
        ? v.publicBalancesWhy
        : 'the read of the chain did not say what this vault holds in public money',
    };
  }
  const holdings: Array<{ token: string; amount: bigint }> = [];
  for (const row of v.publicBalances as Array<{ token?: unknown; amount?: unknown } | null>) {
    if (typeof row?.token !== 'string' || !COLOUR.test(row.token)
      || typeof row.amount !== 'string' || !WHOLE.test(row.amount)) {
      return {
        of: 'unreadable',
        why: 'the read of the vault gave an amount this page cannot read, so none is shown',
      };
    }
    holdings.push({ token: row.token, amount: BigInt(row.amount) });
  }
  return { of: 'held', holdings };
}

/** Reads the vault now and reads its public money from that read; a failed read is unreadable, never nothing. */
export async function readPublicHoldings(chain: () => Promise<unknown>): Promise<PublicHoldingsAnswer> {
  try {
    return publicHoldingsFromView(await chain());
  } catch (e) {
    return { of: 'unreadable', why: `this vault could not be read from the chain: ${why(e)}` };
  }
}
