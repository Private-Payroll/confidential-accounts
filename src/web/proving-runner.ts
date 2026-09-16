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
 * **THIS FILE PROVES, THEN HANDS THE PROVEN TRANSACTION TO THE SERVICE.** The
 * device has no wallet and pays no fee. The service balances the company's
 * side, has the fee payer add the fee and submit, or refuses - and its answer
 * says whether anything was sent, which is what this runner passes on to the
 * queue. What leaves the device is the proven transaction, which is what
 * reaches the chain anyway; the preimage never does.
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
 * closes that is a private-state provider in the browser.
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
 * Hands a proven transaction to the service and answers its reference.
 *
 * **IT MUST SAY WHICH FAILURES SENT NOTHING.** A failure marked as nothing sent
 * is final for the queue; any other is an outcome nobody knows yet, because the
 * service may have submitted before the answer was lost.
 */
export type SendProven = (job: Job, proven: Uint8Array) => Promise<{ txRef: string }>;

/**
 * A runner that proves on this device and sends through the service.
 *
 * The proof is real: the contract's own compiled circuit, the proving key this
 * repository builds, and the prover running in this process with no proving
 * service anywhere in the path.
 */
export const provingRunner = (capability: ProvingCapability, send: SendProven): JobRunner => {
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

    async submit(job: Job, proof: unknown): Promise<{ txRef: string }> {
      const provenTx = (proof as { provenTx?: unknown } | null | undefined)?.provenTx;
      if (provenTx === undefined || provenTx === null) {
        /*
         * **MARKED, BECAUSE NOTHING LEFT THIS DEVICE.** A proof that is not in
         * hand - a tab reopened after the proof was made, which the queue does
         * not keep - is proved again rather than reported as possibly sent.
         */
        throw new NothingWasSent(
          'this approval has no finished proof on this device to send, so nothing was sent. '
          + 'It will be proved again.');
      }
      const codec = await capability.transactionCodec();
      return send(job, codec.serializeProven(provenTx));
    },

    /*
     * **NO `recover` YET, AND WHAT THAT COSTS IS SAID HERE.** A recovery
     * answers *did this land on chain*. Without one, a submission whose answer
     * was lost stops the job and says a person should look - which is the
     * honest answer about something that may have been sent, and the one the
     * queue gives on its own.
     */
  };
};
