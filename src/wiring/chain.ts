/**
 * THE BOUNDARY, IMPLEMENTED AGAINST THE REAL CHAIN.
 *
 * This module holds the second implementation set: the Midnight ledger, the
 * Midnight proof server, and the commitment scheme computed by the contract's
 * own circuits. It is the first place outside a test where those three are
 * constructed together.
 *
 * ── IT IS A SEPARATE MODULE, AND THAT IS NOT ORGANISATION ────────────────
 *
 * The selector next door is loaded by the browser page. Everything in here
 * reaches the contract's generated code, which reaches a WebAssembly runtime,
 * and a page that loads that runtime does not start at all. So this file exists
 * so that the selector can name a chain implementation set without CONTAINING
 * one: nothing here may ever be imported by a module the page also loads.
 * `src/web/no-wasm-in-the-page.test.ts` is what notices if that changes.
 *
 * ── WHAT THIS SET CAN AND CANNOT DO TODAY, STATED RATHER THAN DISCOVERED ─
 *
 * **IT READS THE CHAIN AND IT DOES NOT WRITE TO IT.** Reading needs an indexer.
 * Writing needs a wallet that holds funds, and this deployment has none: the
 * only wallets that exist in this repository belong to operator scripts, which
 * hold their own keys and are run by a person at a terminal. A server does not
 * have one and must not quietly acquire one.
 *
 * **SO THE WRITES REFUSE, BY NAME, AND THEY REFUSE EARLY.** That is the whole
 * of `ChainLedger` below, and the reason it is a wrapper rather than a comment
 * is worth writing down, because the obvious alternative is actively dangerous:
 *
 *   Handing the product a Midnight ledger whose providers have no wallet does
 *   NOT fail at the point of payment. `propose` and `proposeRun` stage a
 *   proposal salt into the device's private state store BEFORE the transaction
 *   is built, and the ledger says so itself where it does it. The transaction
 *   then dies for want of a wallet — and the device is left holding a salt for
 *   a round that was never raised. The next governance change recomputes an
 *   already-approved round's identity from that salt, gets a different one, and
 *   refuses about the wrong thing. **An approved round becomes unapplicable
 *   from that device, permanently, and nothing anywhere says why.**
 *
 * A refusal above the staging step costs a sentence. A refusal below it costs a
 * round that reached its threshold and can never be settled.
 */
import {
  MidnightLedger, MidnightProofSystem,
  type MidnightConfig, type FeeSponsor,
} from '../midnight/ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { FileSealedStateStore } from '../midnight/sealed-store.js';
import { midnightProviders } from '../midnight/providers.js';
import type {
  Ledger, LedgerAddress, LedgerStatus, LedgerRecord, PaymentsAmong,
  AccountOpening, SealedStateAt, TxRef, SignerRef,
} from '../core/ledger.js';
import type { Hex } from '../core/crypto.js';
import type { Deployment } from './deployment.js';

/**
 * Why a write cannot happen here. One sentence, one place, and it names the
 * state that would resolve it rather than a thing to run: an operator reading
 * it can tell the difference between "this is broken" and "this deployment was
 * built to watch."
 */
const NO_WALLET =
  'this deployment can read the chain and cannot write to it: no funded wallet is '
  + 'wired to it, so there is nothing to pay the transaction with. Reading an account, '
  + 'its balances and its open rounds works; raising, approving, cancelling and '
  + 'changing signers or thresholds need a wallet this deployment does not have.';

/**
 * **A REJECTED PROMISE, NEVER A SYNCHRONOUS THROW.** Every method that uses
 * this is declared to return one, and a caller that writes `.catch(...)` on a
 * method that throws before it returns does not catch anything — the exception
 * comes out of the call rather than out of the promise. A refusal that escapes
 * the caller's error handling is a refusal the product cannot report.
 */
const refuseWrite = (what: string): Promise<never> =>
  Promise.reject(new Error(`${what} needs to write to the chain, and ${NO_WALLET}`));

/**
 * For the things that are NOT writes and still cannot be done here. Kept apart
 * from `refuseWrite` because an operator whose private state store will not
 * open should not be told the cause is a missing wallet: a refusal that names
 * the wrong cause sends somebody to fix the wrong thing.
 */
const refuseUnwired = (what: string, why: string): Promise<never> =>
  Promise.reject(new Error(`${what} is not available on this deployment: ${why}`));

/**
 * **THE SPEND-AUTHORITY SEAT, LEFT EMPTY ON PURPOSE AND NOT LEFT NULL.**
 *
 * The ledger takes a fee sponsor and, as this is written, never calls it —
 * sponsorship is assembled one layer down, among the providers. A construction
 * site that passes `null` therefore works by accident and would become a crash
 * at the moment somebody gives the parameter a reader, which is the moment a
 * transaction is already being paid for.
 *
 * This object is what goes in that seat instead. It satisfies the interface and
 * every member refuses, so the seat is filled by something that cannot silently
 * do the wrong thing, and the day the parameter acquires a reader this
 * deployment says so in words rather than dereferencing nothing.
 */
const NO_SPONSOR: FeeSponsor = {
  addFeeAndFinalise: async () => refuseWrite('paying a transaction fee'),
  submit: async () => refuseWrite('submitting a transaction'),
  capacity: async () => refuseUnwired(
    'the fee sponsor\'s remaining capacity',
    'no sponsor wallet is wired to this deployment, so there is no balance to report'),
};

/**
 * The chain ledger the product is handed.
 *
 * **READS ARE DELEGATED WHOLE AND NOTHING HERE REPAIRS AN ANSWER.** That is
 * the property this class holds for `status`, and it is worth being exact
 * about, because the boundary underneath is less exact than it should be:
 *
 *   `Ledger.status` is documented as answering `null` *when the account is not
 *   on this ledger*. The Midnight implementation answers `null` for that, AND
 *   for a contract the indexer has no state for. An indexer that cannot be
 *   reached at all does not answer `null` — it rejects, which is the loud and
 *   correct outcome.
 *
 * So the two meanings are not separated at this boundary, and this wrapper
 * cannot separate them: it has no information the ledger has not got. **What it
 * can do, and does, is never turn an unanswered read into an answer** — a
 * repaired `null` becomes an empty status, and an empty status read as truth
 * lets a caller close a record the chain still holds. The one caller that
 * matters reads `null` as *could not ask* today; that is its safety, not this
 * one's, and it is why nothing here helpfully fills the gap.
 *
 * Writes refuse above the ledger, never inside it, for the reason at the head
 * of this file.
 */
export class ChainLedger implements Ledger {
  constructor(private readonly inner: MidnightLedger, private readonly deployment: Deployment) {}

  /* ---- reads: the chain answers, and nothing here repairs the answer ---- */

  address(accountId: string): Promise<LedgerAddress | null> {
    return this.inner.address(accountId);
  }

  status(accountId: string): Promise<LedgerStatus | null> {
    return this.inner.status(accountId);
  }

  paidAmong(accountId: string, leaves: Hex[]): Promise<PaymentsAmong | null> {
    return this.inner.paidAmong(accountId, leaves);
  }

  fetch(accountId: string, keyEpoch: number): Promise<LedgerRecord | null> {
    return this.inner.fetch(accountId, keyEpoch);
  }

  /**
   * Delegated, and the ground is narrower than it first looks: resealing READS
   * the chain — it resolves the address and the contract state before it files
   * anything — but it WRITES only to this deployment's own blob storage. It
   * stages no private state and builds no transaction, so it is safe here.
   * Refusing it would stop an account being read back at all, which is a loss
   * with no safety bought.
   */
  reseal(accountId: string, next: SealedStateAt): Promise<void> {
    return this.inner.reseal(accountId, next);
  }

  /**
   * **WHAT IS RUNNING, AND ONLY WHAT IS RUNNING.** The ledger underneath
   * describes itself as sponsoring fees, which is a claim about a component
   * this deployment has not got. This sentence is the one an operator reads on
   * the health route and at boot, so it says the narrower true thing.
   */
  describe(): string {
    return `Midnight ${this.deployment.network} via ${this.deployment.indexerUrl}, read-only `
      + '(no wallet is wired, so nothing can be written to the chain)';
  }

  /* ---- writes: refused here, above everything that stages anything ---- */

  open(_accountId: string, _opening: AccountOpening): Promise<TxRef> {
    return refuseWrite('opening an account');
  }

  propose(
    ..._args: Parameters<Ledger['propose']>
  ): Promise<TxRef> {
    return refuseWrite('raising a round');
  }

  proposeRun(
    ..._args: Parameters<Ledger['proposeRun']>
  ): ReturnType<Ledger['proposeRun']> {
    return refuseWrite('raising a payroll round');
  }

  approve(_accountId: string, _proposalId: Hex, _by: SignerRef): Promise<TxRef> {
    return refuseWrite('approving a round');
  }

  cancel(_accountId: string, _proposalId: Hex, _by: SignerRef): Promise<TxRef> {
    return refuseWrite('cancelling a round');
  }

  addSigner(
    _accountId: string, _leaf: Hex, _proposalId: Hex | null, _by: SignerRef,
  ): Promise<TxRef> {
    return refuseWrite('adding a signer');
  }

  removeSigner(
    _accountId: string, _removedLeaf: Hex, _proposalId: Hex, _by: SignerRef,
  ): Promise<TxRef> {
    return refuseWrite('removing a signer');
  }

  setThreshold(..._args: Parameters<Ledger['setThreshold']>): Promise<TxRef> {
    return refuseWrite('changing the approval threshold');
  }

  setVaultThreshold(..._args: Parameters<Ledger['setVaultThreshold']>): Promise<TxRef> {
    return refuseWrite('changing a vault\'s approval threshold');
  }
}

/**
 * The rule by itself, so it can be pinned without a ledger, an indexer or a
 * network. Everything that can refuse here takes plain values.
 */
export function agreedAddress(
  accountId: string, answered: string | null, d: Deployment,
): string | null {
  if (answered !== null && answered !== d.contractAddress) {
    throw new Error(
      `account "${accountId}" is recorded against contract ${answered}, and this `
      + `deployment was built against ${d.contractAddress} on ${d.network}. One of `
      + 'the two is out of date, and reading either would answer about a contract '
      + 'this deployment was not meant to be talking to.');
  }
  return answered;
}

/** The configuration the ledger takes, derived from the deployment and nowhere else. */
export const configFor = (d: Deployment): MidnightConfig => ({
  indexerUrl: d.indexerUrl,
  indexerWsUrl: d.indexerWsUrl,
  proverUrl: d.proverUrl,
  nodeUrl: d.nodeUrl,
  zkConfigPath: d.zkConfigPath,
  networkId: d.network,
  privateStateId: d.privateStateId,
});

/**
 * Build the chain ledger.
 *
 * `addressOf` is the one input this module does not own: an account id becomes
 * an address by asking whatever recorded it, and that is the product's store
 * rather than this file's business. It is a parameter for the same reason the
 * commitment scheme is not defaulted — the alternative is this file inventing a
 * second answer to a question the product already answers.
 */
export function chainLedger(
  d: Deployment,
  addressOf: (accountId: string) => Promise<string | null>,
): ChainLedger {
  const cfg = configFor(d);
  /*
   * **THE RECORDED ADDRESS IS CHECKED AGAINST THE ONE THE PRODUCT ANSWERS
   * WITH, AND THIS IS THE WHOLE REASON THE RECORD IS READ AT ALL.**
   *
   * Without this the deployment record's address would be validated on the way
   * past and then thrown away: every read would resolve its contract from the
   * product's own row, and the record would be decoration. Two things write
   * those rows at different times — a deploy, and whatever restored the store —
   * so they can drift, and when they do nothing goes wrong loudly. The reads
   * simply start answering about a different contract.
   *
   * A disagreement is refused rather than resolved in either direction,
   * because there is no safe way to pick: one of the two is stale and this
   * layer cannot know which.
   */
  const checkedAddressOf = async (accountId: string): Promise<string | null> =>
    agreedAddress(accountId, await addressOf(accountId), d);
  const inner = new MidnightLedger(
    cfg,
    NO_SPONSOR,
    new FileSealedStateStore(d.sealedStateRoot),
    checkedAddressOf,
    /*
     * A thunk, which is what the ledger asks for: the providers are built on
     * first use, so constructing this set needs no node, no indexer and no
     * proof server to be reachable. A deployment that cannot reach its chain
     * still starts, and says so when something is asked of it.
     */
    /*
     * **NO BLANKET CAST ON THIS OBJECT.** Every field below is supplied and
     * individually assignable, so a cast over the whole bundle buys nothing and
     * costs the one check that would notice the SDK's bundle changing shape.
     * The one unsatisfiable field is cast on its own, so the compiler still
     * reads the other five.
     */
    () => midnightProviders({
      config: cfg,
      /* No customer wallet exists on a server. Only a write would use it. */
      customer: undefined as never,
      sponsor: NO_SPONSOR,
      artifactsPath: d.zkConfigPath,
      privateStateId: d.privateStateId,
      /*
       * Reached only on a path that writes, because only a write needs the
       * private state store unlocked. It refuses with its own cause rather than
       * the wallet's, so that if it is ever reached from somewhere else the
       * sentence is still true.
       */
      storagePassword: async () => refuseUnwired(
        'the private state store',
        'no key is wired to unlock it, and this deployment writes nothing that would need it'),
    }),
    /*
     * The compiled contract is what a WRITE proves against, and this set does
     * not write. It is left absent rather than half-built: a partially
     * constructed compiled contract is a thing that looks ready.
     */
    undefined,
  );
  return new ChainLedger(inner, d);
}

/** The set, whole. Assembled only by the selector next door. */
export function chainWiring(
  d: Deployment,
  addressOf: (accountId: string) => Promise<string | null>,
) {
  return {
    name: 'chain',
    commitments: MidnightCommitments,
    createLedger: () => chainLedger(d, addressOf),
    createProofSystem: () => new MidnightProofSystem(configFor(d)),
  };
}
