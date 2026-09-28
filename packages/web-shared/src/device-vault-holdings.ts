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
 * **IT READS PRIVATE MONEY FOR PAYMENTS.** Public money is a contract balance
 * the company's service reads off the vault's state, and a payment's check asks
 * it there. What this file does with public money is only to show it:
 * `publicHoldingsFromView` reads the service's list for the vault's screen, and
 * says so when there is none to read.
 *
 * **NOTHING IT READS LEAVES THIS DEVICE.** The vault's address goes out to ask
 * the chain what it holds; the notes, their values and the sum stay here.
 */
import { assets, formatAmount, ledgerFormOf, type Asset, type AssetRegistry, type LedgerForm } from '../../../src/core/assets.js';
import type { Hex } from '../../../src/core/crypto.js';
import type { FitAnswer, HoldingAnswer, PaymentAsked, VaultHoldings } from '../../../src/core/vault-holdings.js';
import { poolAgainstChain } from '../../../src/midnight/pool-against-chain.js';
import type { PaymentsFitAnswer } from '../../../src/midnight/vault-notes.js';

/** One note as this device's pool records it. */
export interface PoolNote {
  readonly nonce: Hex;
  readonly token: Hex;
  readonly value: bigint;
  readonly createdIn?: Hex;
}

export interface DeviceHoldingsDoors {
  /**
   * What the chain holds for the vault now, as the company's service reports
   * it: the vault's note commitments, and whether they were read off a ledger
   * of the shape this build's vault has. A ledger of another shape answers the
   * question about notes out of whichever field sits in that place.
   */
  readonly chain: (vault: Hex) => Promise<ChainNotesView>;
  /** The vault's pool, opened on this device with this signer's own key. */
  readonly pool: (vault: Hex) => Promise<readonly PoolNote[]>;
  /** The commitment the vault holds on the chain for one note, computed on this device. */
  readonly heldCommitmentOf: (vault: Hex, note: PoolNote) => Promise<string>;
  /**
   * Whether the notes can make the payments one at a time, through the choice
   * of note a payment makes: `fits`, or `does-not-fit` naming the first they
   * cannot. Refuses only when it could not ask.
   */
  readonly paymentsFit: (notes: readonly PoolNote[], payments: ReadonlyArray<{ token: Hex; amount: bigint }>) => Promise<PaymentsFitAnswer>;
}

/** The parts of the service's view of a vault this reader reads. */
export interface ChainNotesView {
  readonly onChain: boolean;
  readonly notes?: readonly string[];
  /** `true` only when the notes were read off a ledger of the shape this build's vault has. */
  readonly notesFromThisBuild?: boolean;
  /** Why they were not, when the service could say. */
  readonly notesWhy?: string;
}

type Reconciled = { readonly of: 'notes'; readonly notes: readonly PoolNote[] }
  | { readonly of: 'unreadable'; readonly why: string }
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
    return { of: 'unreadable', why: `the chain could not be asked what this vault holds: ${why(e)}` };
  }
  if (view?.onChain !== true) {
    return { of: 'unreadable', why: 'the chain shows no vault at this address yet' };
  }
  if (!Array.isArray(view.notes)) {
    return { of: 'unreadable', why: 'the chain was read and did not say which notes this vault holds' };
  }
  if (view.notesFromThisBuild !== true) {
    return {
      of: 'unreadable',
      why: 'the company\'s service did not confirm that this vault is laid out the way this version of the product '
        + `reads one, so which notes it holds is not known${typeof view.notesWhy === 'string' ? `: ${view.notesWhy}` : ''}`,
    };
  }
  const onChain = new Set(view.notes.map((n) => String(n).toLowerCase()));
  const notes = await doors.pool(vault);
  const held: Array<{ note: PoolNote; commitment: string }> = [];
  for (const note of notes) held.push({ note, commitment: (await doors.heldCommitmentOf(vault, note)).toLowerCase() });
  const verdict = poolAgainstChain(held, { has: (c) => onChain.has(c), size: BigInt(onChain.size) });
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
      why: `the chain holds ${verdict.chainHolds} note(s) for this vault and its record holds ${verdict.poolHolds}, so `
        + (verdict.chainHolds > verdict.poolHolds
          ? 'money reached the vault that the record does not show'
          : 'the record counts one note the chain holds more than once'),
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

/** What the vault's screen shows about its public money: every token and amount, or why it could not be read. */
export type PublicHoldingsAnswer =
  | { readonly of: 'held'; readonly holdings: ReadonlyArray<{ readonly token: string; readonly amount: bigint }> }
  | { readonly of: 'unreadable'; readonly why: string };

const COLOUR = /^[0-9a-f]{64}$/u;
const WHOLE = /^[0-9]+$/u;

/**
 * **THE VAULT'S PUBLIC MONEY, AS THE COMPANY'S SERVICE READ IT OFF THE VAULT'S
 * STATE.** An empty list is the vault holding no public money; anything that is
 * not a list of tokens and whole amounts is not a reading, and is said to be
 * unreadable rather than shown as nothing.
 */
export function publicHoldingsFromView(view: unknown): PublicHoldingsAnswer {
  const v = view as { onChain?: unknown; publicBalances?: unknown; publicBalancesWhy?: unknown } | null | undefined;
  if (v?.onChain !== true) return { of: 'unreadable', why: 'the vault is not on the chain yet' };
  if (!Array.isArray(v.publicBalances)) {
    return {
      of: 'unreadable',
      why: typeof v.publicBalancesWhy === 'string' && v.publicBalancesWhy !== ''
        ? v.publicBalancesWhy
        : 'the company\'s service did not say what this vault holds in public money',
    };
  }
  const holdings: Array<{ token: string; amount: bigint }> = [];
  for (const row of v.publicBalances as Array<{ token?: unknown; amount?: unknown } | null>) {
    if (typeof row?.token !== 'string' || !COLOUR.test(row.token)
      || typeof row.amount !== 'string' || !WHOLE.test(row.amount)) {
      return {
        of: 'unreadable',
        why: 'the service sent an amount this page cannot read, so none is shown',
      };
    }
    holdings.push({ token: row.token, amount: BigInt(row.amount) });
  }
  return { of: 'held', holdings };
}

/** Asks the service for the vault's view now and reads its public money; a failed ask is unreadable, never nothing. */
export async function readPublicHoldings(chain: () => Promise<unknown>): Promise<PublicHoldingsAnswer> {
  try {
    return publicHoldingsFromView(await chain());
  } catch (e) {
    return { of: 'unreadable', why: `this page could not reach the company's service: ${why(e)}` };
  }
}

/** What the screen says for any balance it could not read. The reason stays in the answer, not on the screen. */
export const PUBLIC_BALANCE_UNREAD = 'What this vault holds publicly could not be read, so no amount is shown. '
  + 'That does not mean it holds nothing.';

/**
 * **THE LINES THE VAULT'S SCREEN SHOWS FOR ITS PUBLIC MONEY.** A token an asset
 * in the registry names is shown in that asset; one no asset names is shown as
 * a count of units, so it is still counted. Money put in privately is never in
 * this list, and the empty answer says so, so it is not read as an empty vault.
 */
export function sayPublicHoldings(answer: PublicHoldingsAnswer, registry: AssetRegistry = assets): string[] {
  if (answer.of === 'unreadable') return [PUBLIC_BALANCE_UNREAD];
  if (answer.holdings.length === 0) return ['This vault holds no money publicly. Money put in privately is not counted here.'];
  const named = new Map<string, Asset>();
  for (const a of registry.enabled()) {
    try {
      const form = ledgerFormOf(a, 'unshielded');
      if (form.of === 'token') named.set(form.token.toLowerCase().replace(/^0x/u, ''), a);
    } catch { /* an asset that does not say its forms names no public token */ }
  }
  return [
    ...answer.holdings.map((h) => {
      const asset = named.get(h.token);
      return asset
        ? `${formatAmount(h.amount, asset)} ${asset.code}, held publicly`
        : `${h.amount} units of a currency this service does not recognise, held publicly`;
    }),
    'Anyone can look up money held publicly.',
  ];
}
