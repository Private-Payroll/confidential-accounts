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
 *   - **held**, only when every note the pool records is one the chain holds,
 *     and the chain holds no note the pool does not record;
 *   - **unreadable**, when the chain did not answer or shows no vault here;
 *   - **contradicted**, when the pool and the chain disagree. A pool that
 *     disagrees with the chain has no balance: it is never summed.
 *
 * **IT READS PRIVATE MONEY ONLY.** Public money is a contract balance the
 * company's service reads itself, and is asked there.
 *
 * **NOTHING IT READS LEAVES THIS DEVICE.** The vault's address goes out to ask
 * the chain what it holds; the notes, their values and the sum stay here.
 */
import type { LedgerForm } from '../core/assets.js';
import type { Hex } from '../core/crypto.js';
import type { FitAnswer, HoldingAnswer, PaymentAsked, VaultHoldings } from '../core/vault-holdings.js';

/** One note as this device's pool records it. */
export interface PoolNote {
  readonly nonce: Hex;
  readonly token: Hex;
  readonly value: bigint;
  readonly createdIn?: Hex;
}

export interface DeviceHoldingsDoors {
  /** What the chain holds for the vault now, as the company's service reports it: the vault's note commitments. */
  readonly chain: (vault: Hex) => Promise<{ readonly onChain: boolean; readonly notes?: readonly string[] }>;
  /** The vault's pool, opened on this device with this signer's own key. */
  readonly pool: (vault: Hex) => Promise<readonly PoolNote[]>;
  /** The commitment the vault holds on the chain for one note, computed on this device. */
  readonly heldCommitmentOf: (vault: Hex, note: PoolNote) => Promise<string>;
  /**
   * Returns when the notes can make the payments one at a time, through the
   * choice of note a payment makes; refuses with the first one they cannot.
   */
  readonly paymentsFit: (notes: readonly PoolNote[], payments: ReadonlyArray<{ token: Hex; amount: bigint }>) => Promise<void>;
}

type Reconciled = { readonly of: 'notes'; readonly notes: readonly PoolNote[] }
  | { readonly of: 'unreadable'; readonly why: string }
  | { readonly of: 'contradicted'; readonly why: string };

const why = (e: unknown): string => (e as Error)?.message ?? String(e);

/**
 * **THE POOL, ONLY IF THE CHAIN AGREES WITH IT, BOTH WAYS.** Every recorded
 * note must be one the chain holds, and the chain must hold exactly as many
 * notes as the pool records.
 */
async function reconciled(doors: DeviceHoldingsDoors, vault: Hex): Promise<Reconciled> {
  let view: { readonly onChain: boolean; readonly notes?: readonly string[] };
  try {
    view = await doors.chain(vault);
  } catch (e) {
    return { of: 'unreadable', why: `the chain could not be asked what this vault holds: ${why(e)}` };
  }
  if (view?.onChain !== true) {
    return { of: 'unreadable', why: 'the chain shows no vault at this address yet' };
  }
  if (!Array.isArray(view.notes)) {
    return { of: 'unreadable', why: 'the chain was read and did not say which notes this vault holds' };
  }
  const onChain = new Set(view.notes.map((n) => String(n).toLowerCase()));
  const notes = await doors.pool(vault);
  const missing: PoolNote[] = [];
  for (const note of notes) {
    if (!onChain.has((await doors.heldCommitmentOf(vault, note)).toLowerCase())) missing.push(note);
  }
  if (missing.length > 0) {
    return {
      of: 'contradicted',
      why: `${missing.length} of the ${notes.length} note(s) this vault's record holds are not among the notes the `
        + 'chain holds for it, so the record claims money the vault cannot spend',
    };
  }
  if (onChain.size !== notes.length) {
    return {
      of: 'contradicted',
      why: `the chain holds ${onChain.size} note(s) for this vault and its record holds ${notes.length}, so money `
        + 'reached the vault that the record does not show',
    };
  }
  return { of: 'notes', notes };
}

export const deviceVaultHoldings = (doors: DeviceHoldingsDoors): VaultHoldings => ({
  held: async (vault: string, form: LedgerForm, token: string): Promise<HoldingAnswer> => {
    if (form !== 'shielded') {
      return { of: 'unreadable', why: 'this device reads a vault\'s private money; its public money is read by the company\'s service' };
    }
    const r = await reconciled(doors, vault as Hex);
    if (r.of !== 'notes') return r;
    const wanted = token.toLowerCase();
    return { of: 'held', amount: r.notes.filter((n) => n.token.toLowerCase() === wanted).reduce((a, n) => a + n.value, 0n) };
  },

  fits: async (vault: string, payments: ReadonlyArray<PaymentAsked>): Promise<FitAnswer> => {
    if (payments.some((p) => p.payee.kind !== 'shielded')) {
      return { of: 'unreadable', why: 'this device reads a vault\'s private money; its public money is read by the company\'s service' };
    }
    const r = await reconciled(doors, vault as Hex);
    if (r.of !== 'notes') return r;
    try {
      await doors.paymentsFit(r.notes, payments.map((p) => ({ token: p.token as Hex, amount: p.amount })));
      return { of: 'fits' };
    } catch (e) {
      /*
       * Only the walk's own refusal is an answer about the notes. Anything else -
       * the background thread not starting, a payment it could not read - is a
       * failure to ask, and is passed on as that rather than as money short.
       * The walk's refusal crosses from the background thread as a sentence, so
       * it is recognised by the words it opens with.
       */
      if (!/^payment \d+ of \d+ cannot be made out of this vault/u.test(why(e))) throw e;
      /* The note-level reason ends by advising a merge, and no vault can merge notes. */
      return { of: 'does-not-fit', why: why(e).replace(/\s*Merge them first[^.]*\.?\s*$/, '') };
    }
  },
});
