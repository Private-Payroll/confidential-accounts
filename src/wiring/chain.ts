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

import { type ContractBook } from './account-contract.js';
import { refusalForCapability, type WriteCapability } from './write-capability.js';

/**
 * **THE SPEND-AUTHORITY SEAT, LEFT EMPTY UNLESS THIS DEPLOYMENT WAS GIVEN ONE,
 * AND NEVER LEFT NULL.**
 *
 * A construction site that passes `null` works by accident and becomes a crash
 * at the moment somebody gives the parameter a reader - which is the moment a
 * transaction is already being paid for.
 *
 * This object is what goes in that seat instead when there is nobody to pay. It
 * satisfies the interface and every member refuses, so the seat is filled by
 * something that cannot silently do the wrong thing, and the day the parameter
 * acquires a reader this deployment says so in words rather than dereferencing
 * nothing.
 */
const noSponsor = (refusal: string): FeeSponsor => ({
  addFeeAndFinalise: async () => Promise.reject(new Error(refusal)),
  submit: async () => Promise.reject(new Error(refusal)),
  /*
   * **THE ONE MEMBER THAT SUCCEEDS ON A DEPLOYMENT THAT CANNOT PAY, AND IT IS
   * NOT AN INCONSISTENCY.** A release says *let go of what a balance booked*.
   * Nothing here has balanced anything - every other member refuses - so there
   * is nothing booked and the honest answer is that it is already released.
   * Refusing instead would put a second error in front of whoever is handling
   * the first one, on the cleanup path, which is exactly where an error is
   * least useful.
   */
  release: async () => {},
  capacity: async () => Promise.reject(new Error(
    'the fee sponsor\'s remaining capacity is not available on this deployment: '
    + 'nothing is wired to pay fees, so there is no balance to report')),
});

/**
 * For the things that are NOT writes and still cannot be done here. Kept apart
 * from a write refusal because an operator whose private state store will not
 * open should not be told the cause is a missing wallet: a refusal that names
 * the wrong cause sends somebody to fix the wrong thing.
 */
const refuseUnwired = (what: string, why: string): Promise<never> =>
  Promise.reject(new Error(`${what} is not available on this deployment: ${why}`));

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
 * lets a caller close a record the chain still holds.
 *
 * **WRITES REFUSE HERE, ABOVE THE LEDGER, WHENEVER THIS DEPLOYMENT WAS NOT
 * GIVEN WHAT WRITING NEEDS** - and when it was, they are delegated whole, the
 * same way reads are. The refusal is one sentence built in one place from what
 * is actually missing, so a deployment short of one piece says which piece
 * rather than reciting a general apology.
 */
export class ChainLedger implements Ledger {
  /**
   * Taken from the ledger this wraps rather than restated.
   *
   * The value a record is stamped with must be the one the ledger underneath
   * would have used. Two literals here would be two things to keep in step, and
   * the one that went stale would be the one nobody reads.
   */
  get wiring() { return this.inner.wiring; }

  /**
   * The sentence, computed once at construction rather than per call.
   *
   * **NULL MEANS THIS DEPLOYMENT CAN WRITE**, and it is the only thing any
   * write method below consults. There is deliberately no second way to ask -
   * a method that checked some other field could disagree with this one, and
   * the disagreement would be a write that got through.
   */
  private readonly cannotWrite: string | null;

  constructor(
    private readonly inner: MidnightLedger,
    private readonly deployment: Deployment,
    capability?: WriteCapability,
  ) {
    this.cannotWrite = refusalForCapability(capability);
  }

  /**
   * **A REJECTED PROMISE, NEVER A SYNCHRONOUS THROW.** Every method that uses
   * this is declared to return one, and a caller that writes `.catch(...)` on a
   * method that throws before it returns does not catch anything — the exception
   * comes out of the call rather than out of the promise. A refusal that escapes
   * the caller's error handling is a refusal the product cannot report.
   */
  private refuse(what: string): Promise<never> {
    return Promise.reject(new Error(`${what} needs to write to the chain, and ${this.cannotWrite}`));
  }

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
   * describes itself as sponsoring fees, which on a deployment with nobody to
   * pay is a claim about a component it has not got. This sentence is the one
   * an operator reads on the health route and at boot, so it says the narrower
   * true thing in both directions.
   */
  describe(): string {
    return `Midnight ${this.deployment.network} via ${this.deployment.indexerUrl}, `
      + (this.cannotWrite === null
        ? 'reading and writing (a wallet is wired, so this deployment can open companies '
          + 'and raise rounds)'
        : 'read-only (no wallet is wired, so nothing can be written to the chain)');
  }

  /* ---- writes: refused above everything that stages anything, or delegated whole ---- */

  open(accountId: string, opening: AccountOpening): Promise<TxRef> {
    return this.cannotWrite ? this.refuse('opening an account')
      : this.inner.open(accountId, opening);
  }

  propose(...args: Parameters<Ledger['propose']>): Promise<TxRef> {
    return this.cannotWrite ? this.refuse('raising a round')
      : this.inner.propose(...args);
  }

  proposeRun(...args: Parameters<Ledger['proposeRun']>): ReturnType<Ledger['proposeRun']> {
    return this.cannotWrite ? this.refuse('raising a payroll round')
      : this.inner.proposeRun(...args);
  }

  approve(accountId: string, proposalId: Hex, by: SignerRef): Promise<TxRef> {
    return this.cannotWrite ? this.refuse('approving a round')
      : this.inner.approve(accountId, proposalId, by);
  }

  cancel(accountId: string, proposalId: Hex, by: SignerRef): Promise<TxRef> {
    return this.cannotWrite ? this.refuse('cancelling a round')
      : this.inner.cancel(accountId, proposalId, by);
  }

  addSigner(accountId: string, leaf: Hex, proposalId: Hex | null, by: SignerRef): Promise<TxRef> {
    return this.cannotWrite ? this.refuse('adding a signer')
      : this.inner.addSigner(accountId, leaf, proposalId, by);
  }

  removeSigner(accountId: string, removedLeaf: Hex, proposalId: Hex, by: SignerRef): Promise<TxRef> {
    return this.cannotWrite ? this.refuse('removing a signer')
      : this.inner.removeSigner(accountId, removedLeaf, proposalId, by);
  }

  setThreshold(...args: Parameters<Ledger['setThreshold']>): Promise<TxRef> {
    return this.cannotWrite ? this.refuse('changing the approval threshold')
      : this.inner.setThreshold(...args);
  }

  setVaultThreshold(...args: Parameters<Ledger['setVaultThreshold']>): Promise<TxRef> {
    return this.cannotWrite ? this.refuse('changing a vault\'s approval threshold')
      : this.inner.setVaultThreshold(...args);
  }
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
 * **`book` IS THE ONE INPUT THIS MODULE DOES NOT OWN.** An account id becomes an
 * address by asking whatever recorded it, and that is the product's store rather
 * than this file's business. It is a parameter for the same reason the
 * commitment scheme is not defaulted — the alternative is this file inventing a
 * second answer to a question the product already answers.
 *
 * **THE BOOK HAS TWO HALVES AND BOTH ARE NEEDED, WHICH IS THE DEFECT THIS
 * SIGNATURE CLOSES.** It used to take the reading half alone. Opening an account
 * assigns an address that exists nowhere until the deploy returns; the ledger
 * hands it over the instant it has one, and the product then asks the ledger for
 * the account's address, which asks the book. With no writing half the ledger had
 * nowhere to hand it, so the account would be filed with no address — **the
 * deploy would have succeeded and the company would have been unreadable ever
 * after.**
 */
export function chainLedger(
  d: Deployment,
  book: ContractBook,
  capability?: WriteCapability,
): ChainLedger {
  const cfg = configFor(d);
  const refusal = refusalForCapability(capability);
  const nobodyPays = noSponsor(
    refusal ?? 'nothing is wired to pay fees on this deployment');
  const inner = new MidnightLedger(
    cfg,
    capability?.sponsor ?? nobodyPays,
    new FileSealedStateStore(d.sealedStateRoot),
    book.lookUp,
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
      /*
       * Only a write uses this. On a deployment built to watch there is nobody
       * to be, and the cast says so rather than a stub pretending otherwise:
       * every write refuses above this line, so nothing can reach it.
       */
      customer: capability?.customer ?? (undefined as never),
      sponsor: capability?.sponsor ?? nobodyPays,
      artifactsPath: d.zkConfigPath,
      privateStateId: d.privateStateId,
      /*
       * Reached only on a path that writes, because only a write needs the
       * private state store unlocked. It refuses with its own cause rather than
       * the wallet's, so that if it is ever reached from somewhere else the
       * sentence is still true.
       */
      storagePassword: capability?.storagePassword ?? (async () => refuseUnwired(
        'the private state store',
        'no key is wired to unlock it, and this deployment writes nothing that would need it')),
    }),
    /*
     * The compiled contract is what a WRITE proves against. A deployment that
     * cannot write leaves it absent rather than half-built: a partially
     * constructed compiled contract is a thing that looks ready.
     */
    capability?.compiled,
    /*
     * **THE DEPLOYMENT BAG, AND ITS ABSENCE WAS THE THIRD INDEPENDENT REASON
     * NOTHING COULD BE OPENED HERE.** Even a fully funded deployment would have
     * refused at the first line of opening an account, because this argument was
     * not passed at all — and it carries the two things opening needs that no
     * other operation does: somewhere to hand the assigned address, and the
     * choice of who may maintain the contract afterwards.
     */
    capability && {
      register: book.record,
      maintenanceAuthority: capability.maintenanceAuthority,
    },
  );
  return new ChainLedger(inner, d, capability);
}

/** The set, whole. Assembled only by the selector next door. */
export function chainWiring(
  d: Deployment,
  book: ContractBook,
  capability?: WriteCapability,
) {
  return {
    name: 'chain',
    commitments: MidnightCommitments,
    createLedger: () => chainLedger(d, book, capability),
    createProofSystem: () => new MidnightProofSystem(configFor(d)),
  };
}
