/**
 * **A COMPANY VAULT'S TRANSACTIONS, BUILT AND PROVED ON THE SIGNER'S OWN
 * DEVICE.**
 *
 *   1. the vault's deploy, pinned to the company's account and held for one
 *      block by a temporary key made here;
 *   2. the handover of that vault to the company's committee, signed by that
 *      temporary key and by nothing else;
 *   3. a deposit of one coin the device has already chosen and recorded, or a
 *      public deposit of one public token and one amount, which makes no coin;
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
 * output is the vault's, a public deposit only asks for the public money the
 * depositor's wallet then adds, and a payment out spends the vault's note into
 * the payee's coin and the vault's change. The two public keys the call builder asks
 * for are made from randomness nobody keeps. Besides the transactions, the page
 * is handed the vault's temporary key, which it keeps until the handover has
 * landed and never sends anywhere; the note a payment spends and the pool after
 * it, which it files only sealed; and a payment's confirmed hash.
 */
import { committeeReplacement, whyOneKeyCouldActAlone, type Committee } from '../../../src/midnight/vault-committee.js';
import { VAULT_CIRCUITS } from '../../../src/midnight/vault-contract.js';
import { heldStateFromTheStart, type HeldStateDeps } from '../../../src/midnight/held-from-the-start.js';
import { CREATION_STEPS, overTheCeiling } from '../../../src/midnight/deferral.js';
import { buildCreationInsert } from 'midnight-identity/profile/contract-keys';
import { companyLabelBytes, readCompanyLabel } from 'midnight-identity/profile/company-label';
import type { Hex } from '../../../src/core/crypto.js';
import {
  afterPayment, noteToSpend, paymentsFitAnswer, withIndexRead, witnessesOver, type Note, type PaymentsFitAnswer,
} from '../../../src/midnight/vault-notes.js';
import { changeCoinOf, type VaultCoin } from '../../../src/midnight/vault-coins.js';
import {
  establishCreatingTransaction, indexForSpend, theTransactionTheseEventsAreFrom, vaultNoteCommitment,
  type ServedEvent,
} from '../../../src/midnight/note-index.js';
import { payeeAddress, unshieldedPayeeAddress } from '../../../src/midnight/payee-address.js';
import type { NetworkName } from '../../../src/midnight/network.js';
import { pathFromWire, type PrivatePaymentOnTheWire, type PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import { noFurtherNote } from '../../../src/midnight/vault-step-notes.js';

/** How long an intent this builder makes may wait to land: thirty minutes from when it is built. */
const INTENT_LIFETIME_MS = 30 * 60_000;

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
  const ttl = new Date((deps.now ?? Date.now)() + INTENT_LIFETIME_MS);
  const unproven = L.Transaction.fromParts(deps.network, undefined, undefined, L.Intent.new(ttl).addMaintenanceUpdate(update));
  const proven = await deps.prove(unproven);
  return { proven: proven.serialize() };
}

/* ----------------------------------------------- contracts held from their first transaction */

/** What a deploy held from its first transaction answers with: its address, its bytes, and what it writes. */
interface HeldDeploy {
  readonly address: string;
  readonly proven: Uint8Array;
  /** What the ledger's own cost function says it writes, at the ledger's starting parameters. */
  readonly bytesWritten: number;
}

/**
 * **A CONTRACT DEPLOYED ALREADY HELD BY THE KEYS GIVEN, FROM ITS FIRST
 * TRANSACTION**: the one state assembly the service reads it back with
 * (`held-from-the-start.ts`), put in a deploy and proved (a deploy has no
 * circuit, so proving asks the prover nothing).
 */
async function deployHeldFromTheStart(
  deps: HeldStateDeps & Pick<VaultBuilderDeps, 'prove' | 'network' | 'now'>,
  input: Parameters<typeof heldStateFromTheStart>[1],
): Promise<HeldDeploy> {
  const L = deps.ledger;
  const deploy = new L.ContractDeploy(await heldStateFromTheStart(deps, input));
  const ttl = new Date((deps.now ?? Date.now)() + INTENT_LIFETIME_MS);
  const tx = L.Transaction.fromParts(deps.network, undefined, undefined, L.Intent.new(ttl).addDeploy(deploy));
  const bytesWritten = Number(tx.cost(L.LedgerParameters.initialParameters()).bytesWritten);
  const proven = await deps.prove(tx);
  return { address: String(deploy.address).toLowerCase(), proven: proven.serialize(), bytesWritten };
}

/**
 * **A COMPANY'S VAULT, DEPLOYED HELD BY THE COMPANY'S COMMITTEE AT THE
 * COMPANY'S THRESHOLD FROM ITS FIRST TRANSACTION**, pinned to the company's
 * account. No key outside the committee ever holds it, so there is nothing to
 * hand over and nothing to forget. Refused before anything is built for a
 * committee one of whose keys could change it alone.
 */
export async function buildVaultBornHeld(
  deps: VaultBuilderDeps, input: { readonly account: string; readonly holders: Committee },
): Promise<HeldDeploy> {
  const account = input.account.toLowerCase();
  if (!HEX64.test(account)) throw new Error('a vault is pinned to its company\'s account address, and this is not one.');
  const alone = whyOneKeyCouldActAlone(input.holders);
  if (alone !== null) throw new Error(`no vault was built: ${alone}.`);
  const built = await deployHeldFromTheStart(deps, {
    compiled: deps.compiled, zkConfig: deps.zkConfig, args: [{ bytes: fromHex(account) }], circuits: VAULT_CIRCUITS,
    holders: { committee: input.holders.committee.map((k) => ({ tag: k.tag, value: k.value.toLowerCase() })), threshold: input.holders.threshold },
  });
  const tooBig = overTheCeiling(built.bytesWritten, 'the vault\'s deploy');
  if (tooBig !== null) throw new Error(tooBig);
  return built;
}

/**
 * **A COMPANY'S ACCOUNT, DEPLOYED HELD BY ITS FOUNDING SIGNER'S OWN COMMITTEE
 * KEY FROM ITS FIRST TRANSACTION**, at a threshold of one: the key the
 * founding signer's wallet gave for the label it drew. The deploy carries the
 * first step's circuits; the rest are inserted by the one update that key
 * signs (`finishedCreation`).
 */
export async function buildAccountDeploy(
  deps: Parameters<typeof deployHeldFromTheStart>[0] & { readonly accountCompiled: unknown; readonly accountKeys: unknown },
  input: { readonly foundingLeaf: string; readonly label: string; readonly foundingKey: SigningKeyLike },
): Promise<HeldDeploy> {
  const leaf = input.foundingLeaf.toLowerCase();
  if (!HEX64.test(leaf)) throw new Error('the founding signer\'s seat is not one, so no account was built.');
  const label = readCompanyLabel(input.label);
  if (label === null) throw new Error('that is not a company\'s label, so no account was built.');
  const built = await deployHeldFromTheStart(deps, {
    compiled: deps.accountCompiled, zkConfig: deps.accountKeys,
    args: [fromHex(leaf), companyLabelBytes(label)],
    circuits: CREATION_STEPS.first,
    holders: { committee: [{ tag: input.foundingKey.tag, value: input.foundingKey.value.toLowerCase() }], threshold: 1 },
  });
  const tooBig = overTheCeiling(built.bytesWritten, 'the account\'s deploy');
  if (tooBig !== null) throw new Error(tooBig);
  return built;
}

/**
 * **THE SECOND STEP OF A COMPANY'S CREATION, SIGNED BY ITS FOUNDING SIGNER'S
 * WALLET.** The insert is built by the one builder the wallet built what it
 * signed with, from the same keys, so the signature verifies over exactly this.
 */
export async function finishedCreation(
  deps: Pick<VaultBuilderDeps, 'ledger' | 'prove' | 'network' | 'now'>,
  input: { readonly account: string; readonly keys: ReadonlyMap<string, Uint8Array>; readonly signature: SigningKeyLike },
): Promise<{ proven: Uint8Array; bytesWritten: number }> {
  const L = deps.ledger;
  const { update } = buildCreationInsert(L, {
    address: input.account.toLowerCase(), counter: 0n, onChain: CREATION_STEPS.first, keys: input.keys, steps: CREATION_STEPS,
  });
  const signed = (update as any).addSignature(0n, { tag: input.signature.tag, value: input.signature.value });
  const ttl = new Date((deps.now ?? Date.now)() + INTENT_LIFETIME_MS);
  const tx = L.Transaction.fromParts(deps.network, undefined, undefined, L.Intent.new(ttl).addMaintenanceUpdate(signed));
  const bytesWritten = Number(tx.cost(L.LedgerParameters.initialParameters()).bytesWritten);
  const tooBig = overTheCeiling(bytesWritten, 'the second step of the account\'s creation');
  if (tooBig !== null) throw new Error(tooBig);
  const proven = await deps.prove(tx);
  return { proven: proven.serialize(), bytesWritten };
}

/**
 * **A COMPANY'S CREATION, CARRIED AGAIN IN FRESH TRANSACTIONS.** Each
 * transaction lives thirty minutes; one that ran out before it landed can never
 * land. This carries the same deploy - its state and its nonce, so the same
 * account - and the same signed second step - the founding signer's signature
 * over the same update, which names no time - each in a new transaction that
 * lives another thirty minutes. Nothing is made again and nobody is asked to
 * sign again. Refused unless each is exactly one deploy, or exactly one update,
 * and the update is for the account the deploy creates.
 */
export async function creationCarriedAgain(
  deps: Pick<VaultBuilderDeps, 'ledger' | 'prove' | 'network' | 'now'>,
  input: { readonly deploy: Uint8Array; readonly insert: Uint8Array },
): Promise<{ account: string; deploy: Uint8Array; insert: Uint8Array }> {
  const L = deps.ledger;
  const onlyAction = (bytes: Uint8Array, what: string): any => {
    let tx: any;
    try {
      tx = L.Transaction.deserialize('signature', 'proof', 'pre-binding', bytes);
    } catch {
      throw new Error(`${what} is not a transaction this device can read, so nothing was carried again.`);
    }
    const intents = tx.intents instanceof Map ? [...tx.intents.values()] : [];
    const actions = intents.length === 1 ? intents[0].actions : null;
    if (!Array.isArray(actions) || actions.length !== 1 || tx.guaranteedOffer || tx.fallibleOffer) {
      throw new Error(`${what} does more than one thing, so nothing was carried again.`);
    }
    return actions[0];
  };
  const deploy = onlyAction(input.deploy, 'the deploy');
  if (deploy.initialState === undefined || deploy.address === undefined || deploy.entryPoint !== undefined) {
    throw new Error('the deploy does something other than deploy a contract, so nothing was carried again.');
  }
  const update = onlyAction(input.insert, 'the second step');
  if (typeof update.dataToSign === 'undefined' || update.signatures === undefined) {
    throw new Error('the second step is not an update of a contract, so nothing was carried again.');
  }
  const account = String(deploy.address).toLowerCase();
  if (String(update.address).toLowerCase() !== account) {
    throw new Error('the second step is for another account than the deploy creates, so nothing was carried again.');
  }
  const ttl = new Date((deps.now ?? Date.now)() + INTENT_LIFETIME_MS);
  const deployTx = L.Transaction.fromParts(deps.network, undefined, undefined, L.Intent.new(ttl).addDeploy(deploy));
  const insertTx = L.Transaction.fromParts(deps.network, undefined, undefined, L.Intent.new(ttl).addMaintenanceUpdate(update));
  return {
    account,
    deploy: (await deps.prove(deployTx)).serialize(),
    insert: (await deps.prove(insertTx)).serialize(),
  };
}

/**
 * THE DEPOSIT. `coin` is the one the device chose and recorded before this was
 * asked; `state` is the vault's state as the chain served it; `parameters` are
 * the ledger parameters the chain holds now, serialized, and the deposit is
 * built with those and with no others.
 */
export async function buildDeposit(
  deps: VaultBuilderDeps,
  input: {
    readonly vault: string;
    readonly coin: { readonly nonce: string; readonly token: string; readonly value: bigint };
    readonly state: Uint8Array;
    readonly parameters: Uint8Array;
  },
): Promise<{ proven: Uint8Array }> {
  const { nonce, token, value } = input.coin;
  if (!HEX64.test(nonce) || !HEX64.test(token) || value <= 0n) {
    throw new Error('this is not a coin a deposit can be made with, so nothing was built.');
  }
  if (!(input.parameters instanceof Uint8Array) || input.parameters.length === 0) {
    throw new Error('the chain\'s current ledger parameters were not handed over, so nothing was built or sent. '
      + 'Read them from the vault\'s payout state and pass them as the deposit\'s parameters.');
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
    /* The parameters the chain holds now, read by the page; never the ledger's starting ones. */
    ledgerParameters: L.LedgerParameters.deserialize(input.parameters),
    args: [{ nonce: fromHex(nonce), color: fromHex(token), value }],
  }, keys.encryptionPublicKey);
  const proven = await deps.prove(built.private.unprovenTx, 'deposit');
  return { proven: proven.serialize() };
}

/**
 * **THE PUBLIC DEPOSIT.** One public token and one amount into the vault's
 * public balance, through the vault's public deposit. No coin is made and no
 * nonce or note exists: the chain adds the amount to what the vault holds
 * publicly, and anyone can read it. `state` and `parameters` are as for the
 * private deposit.
 *
 * **WHAT IS BUILT IS READ BACK BEFORE IT IS PROVED.** It must be exactly one
 * call, to this vault's public deposit, asking for exactly this token and this
 * amount and for nothing else - no coin, no other token, nothing paid out and
 * no other contract called - or nothing is proved and nothing leaves here.
 */
export async function buildPublicDeposit(
  deps: VaultBuilderDeps,
  input: {
    readonly vault: string;
    readonly token: string;
    readonly amount: bigint;
    readonly state: Uint8Array;
    readonly parameters: Uint8Array;
  },
): Promise<{ proven: Uint8Array }> {
  const vault = String(input.vault).toLowerCase();
  if (!HEX64.test(vault) || !HEX64.test(input.token) || typeof input.amount !== 'bigint' || input.amount <= 0n
    || input.amount >= (1n << 128n)) {
    throw new Error('this is not a public deposit a vault can take, so nothing was built. No money moved. Reload the page and try again; if it happens again, the service needs attention.');
  }
  if (!(input.parameters instanceof Uint8Array) || input.parameters.length === 0) {
    throw new Error('the chain\'s current ledger parameters were not handed over, so nothing was built or sent. No money moved. Reload the page and try again; if it happens again, the service needs attention.');
  }
  const keys = throwawayKeys(deps);
  const L = deps.ledger;
  const built = await deps.contracts.createUnprovenCallTxFromInitialStates(deps.zkConfig, {
    compiledContract: deps.compiled,
    circuitId: 'depositUnshielded',
    contractAddress: vault,
    coinPublicKey: keys.coinPublicKey,
    initialContractState: deps.runtimeState.deserialize(input.state),
    /* A public deposit touches no private coin, so the builder is given no commitment tree to read. */
    initialZswapChainState: new L.ZswapChainState(),
    ledgerParameters: L.LedgerParameters.deserialize(input.parameters),
    args: [fromHex(input.token), input.amount],
  }, keys.encryptionPublicKey);
  const unproven = built.private.unprovenTx;
  const refused = whyNotOnlyThisPublicDeposit(unproven, { vault, token: input.token, amount: input.amount });
  if (refused !== null) throw new Error(`${refused} Nothing was built. No money moved. Reload the page and try again; if it happens again, the service needs attention.`);
  const proven = await deps.prove(unproven, 'depositUnshielded');
  return { proven: proven.serialize() };
}

/**
 * `null` only for a transaction that is one call, to this vault's public
 * deposit, asking for exactly `amount` of `token` and for nothing else.
 * Exported so the check can be driven without building anything.
 */
export function whyNotOnlyThisPublicDeposit(
  tx: unknown, expect: { readonly vault: string; readonly token: string; readonly amount: bigint },
): string | null {
  const t = tx as {
    intents?: unknown; guaranteedOffer?: unknown; fallibleOffer?: unknown;
  } | null;
  if (!(t?.intents instanceof Map) || t.intents.size !== 1) return 'this is not one call to the vault.';
  if (t.guaranteedOffer !== undefined && t.guaranteedOffer !== null) return 'this would move private money as well.';
  if (t.fallibleOffer !== undefined && t.fallibleOffer !== null
    && !(t.fallibleOffer instanceof Map && t.fallibleOffer.size === 0)) return 'this would move private money as well.';
  const intent = [...t.intents.values()][0] as {
    actions?: unknown; guaranteedUnshieldedOffer?: unknown; fallibleUnshieldedOffer?: unknown;
  } | null;
  if (!intent || !Array.isArray(intent.actions) || intent.actions.length !== 1) return 'this is not one call to the vault.';
  if ((intent.guaranteedUnshieldedOffer ?? null) !== null || (intent.fallibleUnshieldedOffer ?? null) !== null) {
    return 'this already moves public money of its own.';
  }
  const call = intent.actions[0] as {
    address?: unknown; entryPoint?: unknown; guaranteedTranscript?: { effects?: unknown }; fallibleTranscript?: { effects?: unknown };
  } | null;
  const name = call?.entryPoint instanceof Uint8Array ? new TextDecoder().decode(call.entryPoint) : String(call?.entryPoint);
  if (String(call?.address).toLowerCase() !== expect.vault.toLowerCase() || name !== 'depositUnshielded') {
    return 'this does not call this vault\'s public deposit.';
  }
  const asked = new Map<string, bigint>();
  for (const transcript of [call?.guaranteedTranscript, call?.fallibleTranscript]) {
    if (transcript === undefined || transcript === null) continue;
    const e = transcript.effects as Record<string, unknown> | undefined;
    if (e === undefined || e === null) return 'what this call asks for could not be read.';
    for (const k of ['claimedNullifiers', 'claimedShieldedReceives', 'claimedShieldedSpends', 'claimedContractCalls']) {
      if (!Array.isArray(e[k]) || (e[k] as unknown[]).length !== 0) return 'this call asks for more than public money.';
    }
    for (const k of ['shieldedMints', 'unshieldedMints', 'unshieldedOutputs', 'claimedUnshieldedSpends']) {
      if (!(e[k] instanceof Map) || (e[k] as Map<unknown, unknown>).size !== 0) return 'this call asks for more than public money.';
    }
    if (!(e.unshieldedInputs instanceof Map)) return 'what this call asks for could not be read.';
    for (const [type, value] of e.unshieldedInputs as Map<{ tag?: unknown; raw?: unknown }, unknown>) {
      if (type?.tag !== 'unshielded' || typeof value !== 'bigint') return 'this call asks for money that is not a public token.';
      const k = String(type.raw).toLowerCase();
      asked.set(k, (asked.get(k) ?? 0n) + value);
    }
  }
  if (asked.size !== 1 || asked.get(expect.token.toLowerCase()) !== expect.amount) {
    return 'this call does not ask for exactly the token and amount of this deposit.';
  }
  return null;
}

export { hex as hexOfBytes };

/* ------------------------------------------------------------ a payment out */

/**
 * **THE RUN A PAYMENT IS MADE UNDER, AS THE VAULT HANDS IT TO THE ACCOUNT.** The
 * account checks the payee's leaf against the run's root in the token the vault
 * actually sends, so the run's asset is that token here. A round that carries
 * no bar of its own needs none beyond its vault's.
 */
const runOf = (
  order: Omit<PrivatePaymentOrderOnTheWire, 'payments'>, payment: PrivatePaymentOnTheWire,
) => {
  const required = (order as { required?: unknown }).required;
  return {
    proposal: fromHex(order.proposal), runVault: fromHex(order.vault.toLowerCase()), root: fromHex(order.root),
    payees: BigInt(order.payees), opensAt: BigInt(order.opensAt), closesAt: BigInt(order.closesAt),
    required: typeof required === 'string' && DIGITS.test(required) ? BigInt(required) : 0n,
    salt: fromHex(order.salt), nonce: fromHex(payment.nonce), asset: fromHex(payment.token),
    path: pathFromWire(payment.path),
  };
};

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
 * **WHETHER THESE NOTES CAN MAKE THESE PAYMENTS, ONE AT A TIME**, by the one
 * walk every such question is answered by, through the same choice of note a
 * payment makes. Answers `fits`, or `does-not-fit` naming the first payment
 * that cannot be made; a payment it cannot read is refused, because that is a
 * failure to ask and not an answer about the notes. It reads the notes it is
 * handed and nothing else.
 */
export function paymentsFitNotes(input: {
  readonly notes: readonly NoteOnTheWire[];
  readonly payments: ReadonlyArray<{ readonly token: string; readonly amount: string }>;
}): PaymentsFitAnswer {
  const payments = input.payments.map((p) => {
    if (!HEX64.test(p.token) || !DIGITS.test(p.amount)) {
      throw new Error('a payment names no token or amount a note could cover, so the notes were not walked.');
    }
    return { token: p.token as Hex, amount: BigInt(p.amount) };
  });
  return paymentsFitAnswer({ notes: input.notes.map(noteFromWire) }, payments);
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

/**
 * **ONE PUBLIC PAYMENT OUT OF THE VAULT, BUILT AND PROVED HERE.**
 *
 * The vault's public payout: no note is chosen or spent, no change comes back
 * and no key travels with it, because a public payment is sent to the payee's
 * public address where their wallet finds it by looking. The account's
 * approval, the window and the once-only record are asked by the same call the
 * private payout makes, from inside the vault.
 *
 * **ONLY A PUBLIC PAYMENT, IN BOTH HALVES.** The leg must name it public, and
 * its address must decode as a public one; a private address is refused by the
 * decode, so a private payee can never be sent public money here.
 */
export async function buildPublicPayout(
  deps: VaultBuilderDeps,
  input: {
    readonly vault: string;
    readonly account: string;
    readonly order: Omit<PrivatePaymentOrderOnTheWire, 'payments'>;
    readonly payment: PrivatePaymentOnTheWire;
    readonly chain: PayoutChain;
  },
): Promise<{ proven: Uint8Array }> {
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
  if (payment.kind !== 'unshielded') {
    throw new Error('this payment is not a public one, so it is not built as one. Nothing was built.');
  }
  const payee = unshieldedPayeeAddress(payment.payee, deps.network as NetworkName);
  const amount = BigInt(payment.amount);
  if (amount <= 0n) throw new Error('a payment of nothing is not made, so nothing was built.');

  /* No note is handed in: the public payout spends none, and asking for one fails by name. */
  const pending: { spending?: Hex } = {};
  const compiled = deps.compiledWith(witnessesOver(() => ({ notes: [] }), pending));
  const L = deps.ledger;
  const accountState = deps.runtimeState.deserialize(input.chain.accountState);
  const blockHash = input.chain.blockHash;
  const keys = throwawayKeys(deps);
  const built = await deps.contracts.createUnprovenCallTxFromInitialStates(deps.zkConfig, {
    compiledContract: compiled,
    circuitId: 'payoutUnshielded',
    contractAddress: vault,
    coinPublicKey: keys.coinPublicKey,
    initialContractState: deps.runtimeState.deserialize(input.chain.vaultState),
    initialZswapChainState: L.ZswapChainState.deserialize(input.chain.zswapState),
    ledgerParameters: L.LedgerParameters.deserialize(input.chain.parameters),
    args: [
      runOf(order, payment),
      /* The payee's public address in the recipient position, and nothing that could be a coin key. */
      fromHex(payee.userAddress), fromHex(payment.token), amount, fromHex(payment.blinding),
    ],
  }, keys.encryptionPublicKey, {
    blockHash,
    publicDataProvider: {
      queryContractState: async (address: unknown, at?: { blockHash?: string }) =>
        (String(address).toLowerCase() === account && at?.blockHash === blockHash ? accountState : null),
    },
  });
  if (pending.spending !== undefined) {
    throw new Error('the vault asked to spend a note for a public payment, so it was not sent. Nothing was sent.');
  }
  const proven = await deps.prove(built.private.unprovenTx, 'payoutUnshielded');
  return { proven: proven.serialize() };
}

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
    /**
     * The vault's current nonce secret, opened on this device from the
     * company's record of it: the vault names the payee's coin and the change
     * with it, and checks it against the commitment it holds.
     */
    readonly secret: string;
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
  /* A payment the leg names as public is never built through the private payout, whatever its address reads as. */
  if (payment.kind !== 'shielded') {
    throw new Error('this payment is not a private one, so it is not built as one. Nothing was built.');
  }
  if (typeof input.secret !== 'string' || !HEX64.test(input.secret)) {
    throw new Error('this device has not opened the vault\'s nonce secret, which a private payment out is made with, '
      + 'so nothing was built.');
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
  const secret = fromHex(input.secret);
  const compiled = deps.compiledWith({
    ...witnessesOver(() => notes, pending),
    /* The vault's secret, for this one call; the vault refuses one that is not the secret it holds. */
    nonceSecret: (ctx: unknown) => [ctx, secret],
  } as ReturnType<typeof witnessesOver>);

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
      runOf(order, payment),
      fromHex(payee.coinPublicKey), fromHex(payment.token), amount, fromHex(payment.blinding),
      /* The one note chosen above and no other: the further place the payment takes is left unused. */
      noFurtherNote(),
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

/* ------------------------------------------------------------ starting a vault */

/**
 * **THE FIRST SECRET RUN AS IT CROSSES BETWEEN THE PAGE AND THIS WORKER**: every
 * number as decimal digits and every value as hex. It is made in this worker
 * from the secret the page opened (`vault-start.ts`), and the page hands it back
 * unchanged for each step it builds.
 */
export interface SecretRunOnTheWire {
  readonly vault: string;
  readonly previous: string;
  readonly commitment: string;
  readonly copiesRoot: string;
  readonly count: string;
  readonly edge: ReadonlyArray<{ readonly sibling: string; readonly goesLeft: boolean }>;
  readonly details: string;
  readonly nonce: string;
  readonly salt: string;
  readonly asset: string;
  readonly root: string;
  readonly payees: string;
  readonly path: ReadonlyArray<{ readonly sibling: string; readonly siblingSum: string; readonly goesLeft: boolean }>;
  readonly copies: ReadonlyArray<{
    readonly reader: string;
    readonly parts: readonly string[];
    readonly path: ReadonlyArray<{ readonly sibling: string; readonly goesLeft: boolean }>;
  }>;
}

const digitsOf = (what: string, d: unknown): bigint => {
  if (typeof d !== 'string' || !DIGITS.test(d)) throw new Error(`the secret run's ${what} is not a whole number, so nothing was built.`);
  return BigInt(d);
};
const hex32Of = (what: string, h: unknown): Uint8Array => {
  if (typeof h !== 'string' || !HEX64.test(h)) throw new Error(`the secret run's ${what} is not thirty-two bytes, so nothing was built.`);
  return fromHex(h);
};

/**
 * **THE VAULT'S FIRST NONCE SECRET SET, UNDER THE RUN ITS SIGNERS APPROVED.** The
 * vault asks the account's `approveVaultChange` inside the same call, against
 * the account's state as the same block saw it, and the account refuses unless
 * the run is open, approved at the vault's bar, and holds this change as its one
 * leaf. No coin moves; the vault mints the account one change receipt.
 */
export async function buildSetNonceSecret(
  deps: VaultBuilderDeps,
  input: {
    readonly vault: string;
    readonly account: string;
    readonly run: SecretRunOnTheWire;
    /** The secret the run sets, which the vault takes only from a device that holds it. */
    readonly secret: string;
    readonly proposal: string;
    readonly opensAt: string;
    readonly closesAt: string;
    readonly chain: PayoutChain;
  },
): Promise<{ proven: Uint8Array }> {
  const vault = String(input.vault).toLowerCase();
  const account = String(input.account).toLowerCase();
  const r = input.run;
  if (!Array.isArray(r?.edge) || r.edge.length !== 10) {
    throw new Error('this secret run does not show where its copies end, so nothing was built. Read the vault\'s start again to get a complete run.');
  }
  if (!HEX64.test(vault) || !HEX64.test(account) || String(r?.vault).toLowerCase() !== vault) {
    throw new Error('this secret is not for this vault and this company\'s account, so nothing was built.');
  }
  const run = {
    proposal: hex32Of('identity', input.proposal), runVault: fromHex(vault), root: hex32Of('root', r.root),
    payees: digitsOf('number of leaves', r.payees), opensAt: digitsOf('opening', input.opensAt),
    closesAt: digitsOf('close', input.closesAt), required: 0n, salt: hex32Of('salt', r.salt),
    nonce: hex32Of('nonce', r.nonce), asset: hex32Of('asset', r.asset),
    path: r.path.map((s) => ({ sibling: digitsOf('path', s.sibling), siblingSum: digitsOf('path', s.siblingSum), goesLeft: s.goesLeft === true })),
  };
  const L = deps.ledger;
  const accountState = deps.runtimeState.deserialize(input.chain.accountState);
  const blockHash = input.chain.blockHash;
  const keys = throwawayKeys(deps);
  const built = await deps.contracts.createUnprovenCallTxFromInitialStates(deps.zkConfig, {
    compiledContract: deps.compiled,
    circuitId: 'setNonceSecret',
    contractAddress: vault,
    coinPublicKey: keys.coinPublicKey,
    initialContractState: deps.runtimeState.deserialize(input.chain.vaultState),
    initialZswapChainState: L.ZswapChainState.deserialize(input.chain.zswapState),
    ledgerParameters: L.LedgerParameters.deserialize(input.chain.parameters),
    args: [
      run, hex32Of('previous secret', r.previous), hex32Of('commitment', r.commitment),
      hex32Of('root of copies', r.copiesRoot), digitsOf('number of copies', r.count),
      r.edge.map((s) => ({ sibling: digitsOf('path', s.sibling), goesLeft: s.goesLeft === true })),
      /* A first secret replaces none, so there is no earlier secret to carry. */
      hex32Of('secret', input.secret), new Uint8Array(32),
    ],
  }, keys.encryptionPublicKey, {
    blockHash,
    publicDataProvider: {
      queryContractState: async (address: unknown, at?: { blockHash?: string }) =>
        (String(address).toLowerCase() === account && at?.blockHash === blockHash ? accountState : null),
    },
  });
  const proven = await deps.prove(built.private.unprovenTx, 'setNonceSecret');
  return { proven: proven.serialize() };
}

/**
 * **ONE SIGNER'S SEALED COPY OF THE SECRET, WRITTEN INTO THE VAULT** against the
 * root of copies its signers approved. Anyone may write one; only a copy under
 * that root is taken, and each place in the tree once.
 */
export async function buildWriteSecretCopy(
  deps: VaultBuilderDeps,
  input: {
    readonly vault: string;
    readonly run: SecretRunOnTheWire;
    /** Which copy of the run, by its place in the tree. */
    readonly place: number;
    readonly state: Uint8Array;
    readonly parameters: Uint8Array;
  },
): Promise<{ proven: Uint8Array }> {
  const vault = String(input.vault).toLowerCase();
  const copy = input.run?.copies?.[input.place];
  if (!HEX64.test(vault) || String(input.run?.vault).toLowerCase() !== vault || copy === undefined) {
    throw new Error('this sealed copy is not one of this vault\'s secret run, so nothing was built.');
  }
  if (!Array.isArray(copy.parts) || copy.parts.length !== 4) {
    throw new Error('a sealed copy is four parts, and this is not, so nothing was built.');
  }
  if (!(input.parameters instanceof Uint8Array) || input.parameters.length === 0) {
    throw new Error('the chain\'s current ledger parameters were not handed over, so nothing was built or sent.');
  }
  const L = deps.ledger;
  const keys = throwawayKeys(deps);
  const built = await deps.contracts.createUnprovenCallTxFromInitialStates(deps.zkConfig, {
    compiledContract: deps.compiled,
    circuitId: 'writeSecretCopy',
    contractAddress: vault,
    coinPublicKey: keys.coinPublicKey,
    initialContractState: deps.runtimeState.deserialize(input.state),
    initialZswapChainState: new L.ZswapChainState(),
    ledgerParameters: L.LedgerParameters.deserialize(input.parameters),
    args: [
      hex32Of('commitment', input.run.commitment), hex32Of('reader key', copy.reader),
      copy.parts.map((p) => hex32Of('sealed copy', p)),
      copy.path.map((s) => ({ sibling: digitsOf('path', s.sibling), goesLeft: s.goesLeft === true })),
    ],
  }, keys.encryptionPublicKey);
  const proven = await deps.prove(built.private.unprovenTx, 'writeSecretCopy');
  return { proven: proven.serialize() };
}
