/**
 * **A COMPANY BETWEEN ITS DEPLOY AND ITS SECOND CREATION STEP HOLDS ONLY THE FIRST STEP'S CIRCUITS.**
 *
 * A company is created in two steps (`src/midnight/deferral.ts`): the deploy installs the first step's circuits and
 * one maintenance update inserts the second's. Until that update lands the chain refuses a call to a second-step
 * circuit, because the account has no verifier key for it. The simulator keys the account the same way, so a call
 * made before the second step lands is refused here too: one made on the account directly, and one a vault makes
 * into it. Once the step lands, the same calls go through.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createCircuitContext, createConstructorContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { Contract as Vault } from '../managed-vault/contract/index.js';
import { AccountSimulator, privateStateFor } from './simulator.js';
import { carryTheAccount, startTheVault, TEST_VAULT_SECRET } from './start-a-vault.js';
import { ACCOUNT_KEYS, keysOnDisk } from './keys-on-disk.js';
import { FIRST_STEP_CIRCUITS, SECOND_STEP_CIRCUITS } from '../../src/midnight/deferral.js';

/* A vault's call into its account binds to the account's verifier keys, read from this build's own keys folder. */
const ACCOUNT_KEYS_ON_DISK = keysOnDisk([ACCOUNT_KEYS]).ok;

const NOW = 1_800_000_000;
const BLOCK = '0'.repeat(64);
const A = privateStateFor(1);
const B = privateStateFor(2);
/* The vault's witnesses: its secret, and no note, since nothing here spends one. */
const vaultWitnesses = {
  noteToSpend: () => { throw new Error('nothing here spends a note'); },
  nonceSecret: (ctx: { privateState: unknown }) => [ctx.privateState, TEST_VAULT_SECRET],
};
const NOT_LANDED = /holdRun is not installed on this account: the creation step that adds it has not landed/;

describe.skipIf(!ACCOUNT_KEYS_ON_DISK)('a company before its second creation step lands [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  let sim: AccountSimulator;
  let vault: Vault<Record<string, never>>;
  let vaultAddr: string;
  let vaultState: unknown;

  /** Starts a vault on the account, raising its first secret with `seed`'s salt, its calls into the account made with the account as it stands. */
  const startAVault = (seed: number) => startTheVault({
    sim, vault: Uint8Array.from(Buffer.from(vaultAddr, 'hex')), approvers: [A, B], now: NOW, seed,
    call: async (circuit, ...a) => {
      const r = await (vault.impureCircuits as unknown as Record<string, (...x: unknown[]) => Promise<{ context: any }>>)[circuit]!(
        createCircuitContext({
          circuitId: circuit as never,
          contractAddress: vaultAddr as never,
          coinPublicKeyOrZswapState: BLOCK,
          contractState: vaultState as never,
          privateState: {} as never,
          crossContract: sim.crossContract(),
          time: NOW,
          parentBlockHash: BLOCK,
        }), ...a);
      vaultState = r.context.callContext.currentQueryContext.state;
      carryTheAccount(sim, r.context);
    },
  });

  beforeEach(async () => {
    sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(NOW);
    vault = new Vault<Record<string, never>>(vaultWitnesses as never);
    vaultAddr = sampleContractAddress() as unknown as string;
    const init = await vault.initialState(
      createConstructorContext({} as never, BLOCK),
      { bytes: Uint8Array.from(Buffer.from(String(sim.address), 'hex')) } as never);
    vaultState = init.currentContractState;
  });

  it('the circuits used below are in the steps they are tested in', () => {
    expect(SECOND_STEP_CIRCUITS as readonly string[]).toContain('holdRun');
    expect(SECOND_STEP_CIRCUITS as readonly string[]).toContain('approveVaultChange');
    expect(FIRST_STEP_CIRCUITS as readonly string[]).toContain('propose');
    expect(FIRST_STEP_CIRCUITS as readonly string[]).toContain('proposeCompanyChange');
  });

  it('RED WHEN: a circuit of the second step can be called on the account before that step lands', async () => {
    sim.beforeSecondStep();
    await expect(sim.holdRun(new Uint8Array(32).fill(7))).rejects.toThrow(NOT_LANDED);
    /* The first step's circuits are installed: the account still governs itself, and raises a change to itself
     * through either raise. */
    await expect(sim.propose(new Uint8Array(32).fill(8))).resolves.toBeDefined();
    await expect(sim.proposeCompanyChange(new Uint8Array(32).fill(9))).resolves.toBeDefined();
    sim.secondStepLands();
    /* Installed now, the call reaches the circuit, which refuses it for its own reason. */
    await expect(sim.holdRun(new Uint8Array(32).fill(7))).rejects.toThrow(/there is no open proposal with that id/);
  });

  it('RED WHEN: a vault\'s call into a second-step circuit of the account goes through before that step lands', async () => {
    sim.beforeSecondStep();
    /* Adopting the vault and raising its first secret are first-step calls; the vault's own call then reaches
     * `approveVaultChange`, which only the second step installs. */
    await expect(startAVault(297)).rejects.toThrow(/to 'approveVaultChange' at .* its operation carries no verifier key/);
    expect(sim.ledger.vaults.member(Uint8Array.from(Buffer.from(vaultAddr, 'hex')))).toBe(true);
    sim.secondStepLands();
    /* A fresh salt: the first secret's run is still open from the refused attempt. */
    await expect(startAVault(501)).resolves.toBeDefined();
  });
});
