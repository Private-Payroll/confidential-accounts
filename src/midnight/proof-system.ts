/**
 * The proof system the core's ledger interface names, for a company on Midnight. None of the three circuits it
 * names exists in the contracts, so `prove` refuses each, and `verify` refuses because verification happens on
 * the chain.
 */
import type { ProofSystem, Circuit } from '../core/ledger.js';
import type { Hex } from '../core/crypto.js';
import type { MidnightConfig } from './ledger.js';

/* ------------------------------------------------------------------ *
 * proofs
 * ------------------------------------------------------------------ */

/**
 * Maps our three logical circuits onto Compact circuits. NONE OF THEM MAP NOW.
 *
 * The contract has no circuit for any of them, so naming one here would claim a route that does not exist.
 * All three are `null`, and none is stubbed with something that returns true.
 *
 * `MidnightProofSystem.prove` throws for each.
 * What the PRODUCT calls solvency attestation runs on a different proof system
 * entirely (`src/core/payroll.ts`), which this map does not reach.
 */
const CIRCUIT_MAP: Record<Circuit, string | null> = {
  'balance-at-least': null,
  'payroll-total': null,
  'payment-record': null,
};

export class MidnightProofSystem implements ProofSystem {
  constructor(private cfg: MidnightConfig) {}

  async prove(circuit: Circuit, _publicInputs: Record<string, unknown>, _witness: unknown): Promise<Hex> {
    const target = CIRCUIT_MAP[circuit];
    if (!target) throw new Error(`no Compact circuit for "${circuit}" yet`);
    throw new Error('not implemented: requires the proof server at ' + this.cfg.proverUrl);
  }

  async verify(_circuit: Circuit, _publicInputs: Record<string, unknown>, _proof: Hex): Promise<boolean> {
    throw new Error('not implemented: verification happens on chain');
  }

  describe(): string {
    return `Midnight proof server at ${this.cfg.proverUrl}`;
  }
}
