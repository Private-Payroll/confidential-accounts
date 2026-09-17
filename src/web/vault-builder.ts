/**
 * **A COMPANY VAULT'S FOUR TRANSACTIONS, BUILT AND PROVED ON THE SIGNER'S OWN
 * DEVICE.**
 *
 *   1. the vault's deploy, pinned to the company's account and held for one
 *      block by a temporary key made here;
 *   2. the handover of that vault to the company's committee, signed by that
 *      temporary key and by nothing else;
 *   3. a deposit of one coin the device has already chosen and recorded;
 *   4. a private payment out of the vault, spending one note the device chose
 *      from the pool it opened, against a round the company approved.
 *
 * **RUNS IN THE PROVING WORKER**, where the ledger and the prover are allowed to
 * load; the page asks for these through `vault-worker-client.ts`. Everything it
 * needs is handed in, so the same code runs in a test against the ledger's own
 * objects.
 *
 * **WHAT LEAVES THIS FILE GOES TO THE PAGE ON THIS DEVICE, AND ONLY A PROVEN
 * TRANSACTION IS SENT ON FROM THERE.** No transaction this builds carries a coin
 * of the device's: the deploy and the handover move none, the deposit's one
 * output is the vault's, and a payment out spends the vault's note into the
 * payee's coin and the vault's change. The two public keys the call builder asks
 * for are made from randomness nobody keeps. Besides the transactions, the page
 * is handed the vault's temporary key, which it keeps until the handover has
 * landed and never sends anywhere; the note a payment spends and the pool after
 * it, which it files only sealed; and a payment's confirmed hash.
 */
import { committeeReplacement, type Committee } from '../midnight/vault-committee.js';
import type { Hex } from '../core/crypto.js';
import { afterPayment, noteToSpend, withIndexRead, witnessesOver, type Note } from '../midnight/vault-notes.js';
import { changeCoinOf, type VaultCoin } from '../midnight/vault-coins.js';
import {
  establishCreatingTransaction, indexForSpend, theTransactionTheseEventsAreFrom, vaultNoteCommitment,
  type ServedEvent,
} from '../midnight/note-index.js';
import { payeeAddress } from '../midnight/payee-address.js';
import type { NetworkName } from '../midnight/network.js';
import { pathFromWire, type PrivatePaymentOnTheWire, type PrivatePaymentOrderOnTheWire } from '../midnight/private-payment-wire.js';

export interface SigningKeyLike { readonly tag: string; readonly value: string }

export interface VaultBuilderDeps {
  /** `@midnightntwrk/ledger-v9`. */
  readonly ledger: any;
  /** `@midnight-ntwrk/compact-runtime`'s `ContractState`, which the call builder reads. */
  readonly runtimeState: { deserialize(bytes: Uint8Array): unknown };
  /** `createUnprovenDeployTxFromVerifierKeys` and `createUnprovenCallTxFromInitialStates`. */
  readonly contracts: {
    createUnprovenDeployTxFromVerifierKeys(...args: any[]): Promise<any>;
    createUnprovenCallTxFromInitialStates(...args: any[]): Promise<any>;
  };
  /** The vault's compiled contract, with its witnesses. */
  readonly compiled: unknown;
  /** The vault's compiled contract with the witnesses a payment out hands it. Absent where nothing pays out. */
  readonly compiledWith?: (witnesses: ReturnType<typeof witnessesOver>) => unknown;
  /** Hands out the vault circuits' verifying keys. */
  readonly zkConfig: unknown;
  /** Proves an unproven transaction. `circuit` names the one it calls, when it calls one. */
  readonly prove: (unproven: any, circuit?: string) => Promise<{ serialize(): Uint8Array }>;
  readonly network: string;
  readonly random?: (n: number) => Uint8Array;
  readonly now?: () => number;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
};
const HEX64 = /^[0-9a-f]{64}$/u;

/** Keys the call builder asks for, from randomness this function drops. */
const throwawayKeys = (deps: VaultBuilderDeps) => {
  const seed = (deps.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(32);
  const keys = deps.ledger.ZswapSecretKeys.fromSeed(seed);
  const out = { coinPublicKey: keys.coinPublicKey, encryptionPublicKey: keys.encryptionPublicKey };
  seed.fill(0);
  try { keys.clear?.(); } catch { /* nothing to clear */ }
  return out;
};

/**
 * THE DEPLOY. The temporary key is a fresh BIP-340 key; its only job is to sign
 * the handover, and the page is given it for exactly that.
 */
export async function buildVaultDeploy(
  deps: VaultBuilderDeps, input: { readonly account: string },
): Promise<{ vault: string; temporaryKey: SigningKeyLike; proven: Uint8Array }> {
  const account = input.account.toLowerCase();
  if (!HEX64.test(account)) throw new Error('a vault is pinned to its company\'s account address, and this is not one.');
  const random = deps.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const secret = random(32);
  const temporaryKey = deps.ledger.signingKeyFromBip340(secret) as SigningKeyLike;
  secret.fill(0);
  const keys = throwawayKeys(deps);
  const built = await deps.contracts.createUnprovenDeployTxFromVerifierKeys(
    deps.zkConfig, keys.coinPublicKey,
    { compiledContract: deps.compiled, args: [{ bytes: fromHex(account) }], signingKey: temporaryKey },
    keys.encryptionPublicKey);
  const vault = String(built.public.contractAddress).toLowerCase();
  const proven = await deps.prove(built.private.unprovenTx);
  return { vault, temporaryKey: { tag: temporaryKey.tag, value: temporaryKey.value }, proven: proven.serialize() };
}

/**
 * THE HANDOVER. `counter` is the vault's counter as the chain reports it; the
 * page reads it immediately before asking.
 */
export async function buildCommitteeHandover(
  deps: VaultBuilderDeps,
  input: { readonly vault: string; readonly counter: bigint; readonly temporaryKey: SigningKeyLike; readonly to: Committee },
): Promise<{ proven: Uint8Array }> {
  const L = deps.ledger;
  let update = committeeReplacement(L, { vault: input.vault, counter: input.counter, to: input.to }) as any;
  update = update.addSignature(0n, L.signData(input.temporaryKey, update.dataToSign));
  const ttl = new Date((deps.now ?? Date.now)() + 30 * 60_000);
  const unproven = L.Transaction.fromParts(deps.network, undefined, undefined, L.Intent.new(ttl).addMaintenanceUpdate(update));
  const proven = await deps.prove(unproven);
  return { proven: proven.serialize() };
}

/**
 * THE DEPOSIT. `coin` is the one the device chose and recorded before this was
 * asked; `state` is the vault's state as the chain served it.
 */
export async function buildDeposit(
  deps: VaultBuilderDeps,
  input: {
    readonly vault: string;
    readonly coin: { readonly nonce: string; readonly token: string; readonly value: bigint };
    readonly state: Uint8Array;
  },
): Promise<{ proven: Uint8Array }> {
  const { nonce, token, value } = input.coin;
  if (!HEX64.test(nonce) || !HEX64.test(token) || value <= 0n) {
    throw new Error('this is not a coin a deposit can be made with, so nothing was built.');
  }
  const keys = throwawayKeys(deps);
  const L = deps.ledger;
  const built = await deps.contracts.createUnprovenCallTxFromInitialStates(deps.zkConfig, {
    compiledContract: deps.compiled,
    circuitId: 'deposit',
    contractAddress: input.vault.toLowerCase(),
    coinPublicKey: keys.coinPublicKey,
    initialContractState: deps.runtimeState.deserialize(input.state),
    /* A deposit spends nothing of the chain's, so the builder is given no commitment tree to read. */
    initialZswapChainState: new L.ZswapChainState(),
    ledgerParameters: L.LedgerParameters.initialParameters(),
    args: [{ nonce: fromHex(nonce), color: fromHex(token), value }],
  }, keys.encryptionPublicKey);
  const proven = await deps.prove(built.private.unprovenTx, 'deposit');
  return { proven: proven.serialize() };
}

export { hex as hexOfBytes };

/* ------------------------------------------------------------ a payment out */

/** A note the pool holds, as it crosses from the page. */
export interface NoteOnTheWire {
  readonly nonce: string;
  readonly token: string;
  readonly value: string;
  readonly createdIn?: string;
}

/** One zswap event of one transaction, as the service serves it. */
export interface EventOnTheWire {
  readonly transactionHash: string;
  readonly details: { readonly tag: string; readonly commitment?: string; readonly contract?: string; readonly mtIndex?: string };
}

/** The chain as one block saw it, each value its bytes. */
export interface PayoutChain {
  readonly blockHash: string;
  readonly vaultState: Uint8Array;
  readonly zswapState: Uint8Array;
  readonly parameters: Uint8Array;
  readonly accountState: Uint8Array;
}

const DIGITS = /^[0-9]+$/u;

const noteFromWire = (n: NoteOnTheWire): Note => {
  if (!HEX64.test(n.nonce) || !HEX64.test(n.token) || !DIGITS.test(n.value)
    || (n.createdIn !== undefined && !HEX64.test(n.createdIn))) {
    throw new Error('the pool handed over holds a note that is not one, so nothing was chosen.');
  }
  const checked = n as unknown as { readonly nonce: Hex; readonly token: Hex; readonly value: string; readonly createdIn?: Hex };
  return {
    nonce: checked.nonce, token: checked.token, value: BigInt(checked.value),
    ...(checked.createdIn === undefined ? {} : { createdIn: checked.createdIn }),
  };
};

export const noteToWire = (n: Note): NoteOnTheWire => ({
  nonce: n.nonce, token: n.token, value: n.value.toString(),
  ...(n.createdIn === undefined ? {} : { createdIn: n.createdIn }),
});

/**
 * **WHICH NOTE A PAYMENT SPENDS**, chosen by the one function every payment
 * chooses by, from the pool the page opened. Refuses with what the pool holds.
 */
export function chooseNoteForPayment(
  input: { readonly notes: readonly NoteOnTheWire[]; readonly token: string; readonly amount: string },
): NoteOnTheWire {
  if (!HEX64.test(input.token) || !DIGITS.test(input.amount)) {
    throw new Error('this payment names no token or amount a note could cover, so nothing was chosen.');
  }
  return noteToWire(noteToSpend(input.notes.map(noteFromWire), input.token as Hex, BigInt(input.amount)));
}

/**
 * **THE POOL AFTER A PAYMENT LANDED**: the spent note gone and its change added,
 * applied to what the pool holds now and not to the copy the payment was built
 * from. The same function the operator's client applies.
 */
export function poolAfterPayment(input: {
  readonly notes: readonly NoteOnTheWire[];
  readonly spent: string;
  readonly amount: string;
  readonly change: NoteOnTheWire | null;
  readonly createdIn: string | null;
}): NoteOnTheWire[] {
  if (!HEX64.test(input.spent) || !DIGITS.test(input.amount)
    || (input.createdIn !== null && !HEX64.test(input.createdIn))) {
    throw new Error('this payment cannot be recorded as it was described, so the pool was not changed.');
  }
  const change: VaultCoin | undefined = input.change === null ? undefined : (() => {
    const c = noteFromWire(input.change);
    return { nonce: c.nonce, token: c.token, value: c.value };
  })();
  const next = afterPayment(
    { notes: input.notes.map(noteFromWire) }, input.spent as Hex, BigInt(input.amount), change,
    input.createdIn === null ? undefined : input.createdIn as Hex);
  return next.notes.map(noteToWire);
}

const servedFromWire = (events: readonly EventOnTheWire[]): ServedEvent[] => events.map((e) => ({
  transactionHash: e.transactionHash,
  details: {
    tag: e.details.tag,
    ...(e.details.commitment === undefined ? {} : { commitment: e.details.commitment }),
    ...(e.details.contract === undefined ? {} : { contract: e.details.contract }),
    ...(e.details.mtIndex === undefined || !DIGITS.test(e.details.mtIndex) ? {} : { mtIndex: BigInt(e.details.mtIndex) }),
  },
}));

/** What a payment's own events say: it landed as built, the chain has not answered yet, or it is not as built. */
export type PaymentConfirmation =
  | { readonly state: 'landed'; readonly createdIn: string }
  | { readonly state: 'not-yet' }
  | { readonly state: 'not-as-built'; readonly why: string };

/**
 * **WHETHER THE CHAIN HOLDS THIS PAYMENT, READ OFF THIS PAYMENT'S OWN EVENTS.**
 *
 * Two payments out of one note for one amount make the same change coin, so
 * the vault's note set cannot tell which of them landed. The transaction's own
 * events can: every one must be this transaction's, one output must be a
 * person's, and the change - when there is one - must be an output of this
 * transaction, owned by this vault. The hash answered is the one the change is
 * recorded under.
 *
 * **THREE ANSWERS, BECAUSE THEY NEED THREE ACTS.** No events yet, or an indexer
 * that cannot say yet, is `not-yet`, and the caller asks again. Events that are
 * there and are not this payment as it was built are `not-as-built`, and asking
 * again will not change them.
 */
export async function confirmPayment(input: {
  readonly vault: string;
  readonly transactionHash: string;
  readonly change: NoteOnTheWire | null;
  readonly events: readonly EventOnTheWire[];
}): Promise<PaymentConfirmation> {
  const vault = input.vault.toLowerCase();
  const transaction = { hash: input.transactionHash as Hex };
  const served = servedFromWire(input.events);
  if (served.length === 0) return { state: 'not-yet' };
  try {
    const hash = theTransactionTheseEventsAreFrom(served, transaction);
    if (served.some((e) => e.transactionHash.toLowerCase().replace(/^0x/u, '') !== hash)) {
      return { state: 'not-as-built', why: 'the events read for this payment are not all its own' };
    }
    if (!served.some((e) => e.details.tag === 'zswapOutput' && e.details.contract === undefined)) {
      return { state: 'not-as-built', why: 'the transaction under this payment\'s name paid nobody' };
    }
    if (input.change === null) return { state: 'landed', createdIn: hash };
    const change = noteFromWire(input.change);
    const commitment = await vaultNoteCommitment(change, vault as Hex);
    const { createdIn } = establishCreatingTransaction(served, { vault: vault as Hex, commitment, transaction });
    return { state: 'landed', createdIn };
  } catch (cause) {
    if ((cause as Error)?.name === 'NoteIndexUnreadable') return { state: 'not-yet' };
    return { state: 'not-as-built', why: (cause as Error)?.message ?? String(cause) };
  }
}

/**
 * **ONE PRIVATE PAYMENT OUT OF THE VAULT, BUILT AND PROVED HERE.**
 *
 * `order` and `payment` are what the service rebuilt from the run the company
 * approved; `note` is the one this device chose from its own pool, and `events`
 * are the chain's events for the transaction that created it, which is where
 * its place in the commitment tree is read - now, for this payment, and never
 * from a number written down earlier. `chain` is one block's view of the vault,
 * the commitment tree and the account the vault asks; the account's answer is
 * computed here against that same block.
 *
 * The payee's two keys come out of one decode of their address, so the coin
 * key the circuit pays and the key their wallet reads the payment with cannot
 * be paired wrongly, and an address for another network is refused.
 */
export async function buildPayout(
  deps: VaultBuilderDeps,
  input: {
    readonly vault: string;
    readonly account: string;
    readonly order: Omit<PrivatePaymentOrderOnTheWire, 'payments'>;
    readonly payment: PrivatePaymentOnTheWire;
    readonly note: NoteOnTheWire;
    readonly events: readonly EventOnTheWire[];
    readonly chain: PayoutChain;
  },
): Promise<{ proven: Uint8Array; spent: string; change: NoteOnTheWire | null }> {
  const vault = input.vault.toLowerCase();
  const account = input.account.toLowerCase();
  const { order, payment } = input;
  if (!HEX64.test(vault) || !HEX64.test(account) || order.vault.toLowerCase() !== vault) {
    throw new Error('this payment is not for this vault and this company\'s account, so nothing was built.');
  }
  for (const h of [order.proposal, order.salt, order.root, payment.token, payment.blinding, payment.nonce]) {
    if (!HEX64.test(h)) throw new Error('this payment\'s round is not described in full, so nothing was built.');
  }
  for (const d of [order.payees, order.opensAt, order.closesAt, payment.amount]) {
    if (!DIGITS.test(d)) throw new Error('this payment\'s round is not described in full, so nothing was built.');
  }
  if (deps.compiledWith === undefined) {
    throw new Error('this device was not given the vault in the form a payment is built with, so nothing was built.');
  }
  const payee = payeeAddress(payment.payee, deps.network as NetworkName);
  const amount = BigInt(payment.amount);
  if (amount <= 0n) throw new Error('a payment of nothing is not made, so nothing was built.');
  const chosen = noteFromWire(input.note);
  if (chosen.token !== payment.token || chosen.value < amount) {
    throw new Error('the note chosen does not cover this payment, so nothing was built.');
  }
  /*
   * **THE INDEX IS READ FROM THE CHAIN'S EVENTS NOW, BY THE ONE FUNCTION EVERY
   * SPEND READS IT BY.** A note with no recorded transaction, events that are
   * not that transaction's, or events that do not show this note created for
   * this vault, each stop here with a sentence and before a proof.
   */
  const served = servedFromWire(input.events);
  const index = await indexForSpend(vault as Hex, chosen, {
    eventsOf: async (tx) => {
      if (!('hash' in tx) || tx.hash !== chosen.createdIn) {
        throw new Error('the chain\'s events handed over are not for the transaction that created this note.');
      }
      return served;
    },
  });
  /* ONE NOTE, WITH THE INDEX JUST READ: the witness can hand the circuit this note or refuse. */
  const notes = withIndexRead({ notes: [chosen] }, chosen.nonce, index);
  const pending: { spending?: Hex } = {};
  const compiled = deps.compiledWith(witnessesOver(() => notes, pending));

  const L = deps.ledger;
  const accountState = deps.runtimeState.deserialize(input.chain.accountState);
  const blockHash = input.chain.blockHash;
  const keys = throwawayKeys(deps);
  const built = await deps.contracts.createUnprovenCallTxFromInitialStates(deps.zkConfig, {
    compiledContract: compiled,
    circuitId: 'payout',
    contractAddress: vault,
    coinPublicKey: keys.coinPublicKey,
    initialContractState: deps.runtimeState.deserialize(input.chain.vaultState),
    initialZswapChainState: L.ZswapChainState.deserialize(input.chain.zswapState),
    ledgerParameters: L.LedgerParameters.deserialize(input.chain.parameters),
    args: [
      fromHex(order.proposal), fromHex(order.root), BigInt(order.payees),
      BigInt(order.opensAt), BigInt(order.closesAt), fromHex(order.salt),
      fromHex(payee.coinPublicKey), fromHex(payment.token), amount,
      fromHex(payment.blinding), fromHex(payment.nonce), pathFromWire(payment.path),
    ],
    /* The payee's wallet reads the payment with this key; it came out of the same decode as the coin key. */
    additionalCoinEncPublicKeyMappings: new Map([[payee.coinPublicKey, payee.encryptionPublicKey]]),
  }, keys.encryptionPublicKey, {
    blockHash,
    /* The account's state as the same block saw it, and nothing else: no other contract is asked. */
    publicDataProvider: {
      queryContractState: async (address: unknown, at?: { blockHash?: string }) =>
        (String(address).toLowerCase() === account && at?.blockHash === blockHash ? accountState : null),
    },
  });
  if (pending.spending !== chosen.nonce) {
    throw new Error('the vault did not spend the note this device chose, so nothing was sent and the pool is unchanged.');
  }
  const kept = changeCoinOf(built.private.nextZswapLocalState, vault as Hex);
  const proven = await deps.prove(built.private.unprovenTx, 'payout');
  return {
    proven: proven.serialize(),
    spent: chosen.nonce,
    change: kept === undefined ? null : { nonce: kept.nonce, token: kept.token, value: kept.value.toString() },
  };
}
