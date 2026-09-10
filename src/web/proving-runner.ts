/**
 * The thing the job queue actually runs, on the thread that is not painting the
 * page.
 *
 * ── WHAT IS HERE AND WHAT IS DELIBERATELY NOT ────────────────────────────
 *
 * A job has four steps and they do not cost the same thing:
 *
 *     build      pure. Reaches no chain, spends nothing.
 *     PROVE      pure. Reaches no chain, spends nothing. 140 seconds.
 *     balance    books coins. Effectful, and it expires.
 *     SUBMIT     effectful. Past this line the chain may know.
 *
 * **THIS FILE DOES THE SECOND ONE AND REFUSES THE LAST TWO BY NAME.** Not as a
 * placeholder: nothing in this product is wired to pay a fee. The one place
 * that would supply a customer wallet and a fee payer sets its capability to
 * nothing on purpose, with the reason written beside it, so a runner here that
 * appeared to balance and submit would be describing a deployment that does not
 * exist.
 *
 * The refusal is the honest version and it costs nothing later: the day a
 * deployment has a wallet, the balance and submission arrive through the same
 * `JobRunner` interface the queue already calls, and nothing above this file
 * changes.
 *
 * ── AND THE PREIMAGE IS NEVER WRITTEN DOWN ───────────────────────────────
 *
 * An unproven transaction IS the proof preimage, and the proof preimage IS the
 * private input - the balance, the amount, the signer's secret key. The job
 * record is persisted; therefore the job record must not carry one. So a job
 * names WHERE its preimage can be had and this runner fetches it for the length
 * of one proof. The bytes live in memory, are handed to the prover, and are
 * dropped.
 *
 * **WHAT THAT LEAVES OPEN, SAID PLAINLY RATHER THAN IMPLIED: something has to
 * build that unproven transaction, and building it needs the signer's own
 * private state.** In this product today that state is held where the server is,
 * not where the browser is - so the preimage a browser proves is one it was
 * handed. Proving it on the device is what stops it reaching a proving service;
 * it is not yet what stops it existing anywhere but the device. The step that
 * closes that is a private-state provider in the browser, and it is not this
 * round's.
 */
import { NothingWasSent, type Job, type JobRunner } from '../core/jobs.js';
import type { KeyMaterialSource } from '../midnight/wasm-proving.js';

/**
 * Where one job's unproven transaction comes from, and what circuit it is for.
 *
 * Both are needed and neither is guessable: the prover is told which circuit to
 * look up keys for, and a transaction with the wrong circuit named produces a
 * key lookup for something the transaction does not contain.
 */
export interface Preimage {
  readonly circuit: string;
  readonly unprovenTransaction: Uint8Array;
}

export interface ProvingCapability {
  /**
   * The material to prove, for one job. Called at the start of the proof and
   * the result is never stored.
   */
  preimageFor(job: Job): Promise<Preimage>;
  /** The public artefacts. Public by construction - see `key-material.ts`. */
  keyMaterial: KeyMaterialSource;
  /**
   * Reads and writes the transaction's wire form.
   *
   * **ASYNC, AND THE LAZINESS IS THE POINT RATHER THAN THE SHAPE.** The module
   * behind this is thirteen megabytes of WebAssembly. A page that opens with no
   * approval outstanding must not load it, and a worker that starts only to
   * find an empty queue must not either - so nothing here is reached until a
   * job actually needs proving.
   *
   * Injected rather than imported for a second reason: this module is
   * typechecked and driven where that package is not loaded at all, including
   * in the page, where it is banned by name for having left the application
   * blank in every real browser for four rounds.
   */
  transactionCodec(): Promise<{
    deserializeUnproven(raw: Uint8Array): unknown;
    serializeProven(tx: unknown): Uint8Array;
  }>;
  /** Builds the prover. Async and lazy for the same reason. */
  proofProvider(source: KeyMaterialSource): Promise<{
    proveTx(tx: unknown, config?: unknown): Promise<unknown>;
  }>;
}

/**
 * Why this runner cannot finish a job, in the product's own words.
 *
 * **IT NAMES THE STATE THAT WOULD RESOLVE IT AND NOT A FILE TO EDIT.** Whoever
 * meets this is a person waiting on an approval, and the useful sentence is
 * what is missing from this deployment rather than where the code for it lives.
 */
export const NOTHING_PAYS_FEES =
  'this device can prove an approval but cannot send it: no wallet has been set up to pay the ' +
  'network fee. The proof itself is finished and costs nothing to make again, so nothing has ' +
  'been lost and nothing has been sent.';

/**
 * A runner that proves and says plainly that it cannot do the rest.
 *
 * The proof is real: the contract's own compiled circuit, the proving key this
 * repository builds, and the prover running in this process with no proving
 * service anywhere in the path.
 */
export const provingOnlyRunner = (capability: ProvingCapability): JobRunner => {
  /*
   * Built once and shared. Constructing the prover instantiates a WebAssembly
   * module and reads nothing job-specific, so building one per job would pay
   * that cost on every approval for no gain.
   */
  let prover: Promise<{ proveTx(tx: unknown, config?: unknown): Promise<unknown> }> | null = null;

  return {
    async prove(job: Job): Promise<{ proof: unknown }> {
      const { circuit, unprovenTransaction } = await capability.preimageFor(job);
      if (!prover) prover = capability.proofProvider(capability.keyMaterial);

      const codec = await capability.transactionCodec();
      const tx = codec.deserializeUnproven(unprovenTransaction);
      const provenTx = await (await prover).proveTx(tx, { circuitId: circuit });
      /*
       * The proof is returned rather than stored, and the queue holds it in
       * memory for the length of one job. A proof is large and reproducible, so
       * persisting it trades a recomputation this device can always redo for
       * storage on every device that ever approves anything.
       */
      return { proof: { circuit, provenTx } };
    },

    async submit(): Promise<{ txRef: string }> {
      /*
       * **MARKED, AND THE MARK IS THE WHOLE OF WHY THIS IS NOT A PLAIN
       * `Error`.** A thrown submission is otherwise recorded as *sent, outcome
       * unknown*, which is correct for anything that reached a network call and
       * wrong here: this refuses before there is a call to make. Unmarked, the
       * queue asks the chain, finds nothing able to answer, and finishes by
       * telling a person the transaction may have settled and they should check
       * the account - about a payment that never existed.
       *
       * **THAT EXACT SENTENCE WAS PRODUCED BY A REAL RUN OF THIS RUNNER BEFORE
       * THE MARK EXISTED**, which is how it was found.
       */
      throw new NothingWasSent(NOTHING_PAYS_FEES);
    },

    /*
     * **NO `recover`, AND ITS ABSENCE IS CORRECT RATHER THAN UNFINISHED.** A
     * recovery answers *did this land on chain*. Nothing this runner does
     * reaches a chain, so there is no landing to ask about - and the queue's
     * own behaviour with no `recover` is exactly right for that: it stops and
     * says a person should look, which is the only honest answer a device that
     * cannot submit can give about something it never submitted.
     */
  };
};
