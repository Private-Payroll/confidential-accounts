/**
 * Real ledger 9 transactions with no contract calls and no coins, for tests that pass a transaction through the
 * service's providers, which read it from its bytes. An empty transaction needs no proof, so the stand-in prover
 * here refuses if it is ever asked for one. Each `n` gives a transaction with other bytes.
 */
import { CostModel, Intent, Transaction } from '@midnightntwrk/ledger-v9';

const NO_PROOF_NEEDED = {
  check: async () => { throw new Error('an empty transaction asked for a proof'); },
  prove: async () => { throw new Error('an empty transaction asked for a proof'); },
  lookupKey: async () => undefined,
};

/** A proven, unbound empty transaction: what a device hands the service to balance. */
export const provenUnbound = async (n: number) =>
  Transaction.fromParts('undeployed', undefined, undefined, Intent.new(new Date(Date.UTC(2030, 0, 1, 0, 0, n))))
    .prove(NO_PROOF_NEEDED, CostModel.initialCostModel());

/** The same transaction bound: what a balance answers with once it is finalised. */
export const finalisedEmpty = async (n: number) => (await provenUnbound(n)).bind();
