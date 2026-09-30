/**
 * TODAY'S VAULT CANNOT PAY, AND WHAT MAKES THAT TEMPORARY.
 *
 * The account's old payment step is deleted and today's vault still calls it. So
 * every test that pays out of today's vault is parked
 * (`until-the-vault-pays-with-a-receipt.ts`), and the tree's own tooling records
 * that one call as a call to a deleted circuit, under the same rule. Neither may
 * outlive the vault's rebuild.
 *
 * This file holds both to the vault's own source: while the vault calls the
 * deleted step, both stand, and a real payout through it is refused; the moment
 * the vault calls `recordPaymentFromVault` instead, the first test goes red and
 * says what to remove.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createCircuitContext, createConstructorContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { describe, expect, it } from 'vitest';

import { Contract as Vault, pureCircuits as vaultCircuits } from '../managed-vault/contract/index.js';
import { Contract as Account, pureCircuits } from '../managed/contract/index.js';
import { witnesses } from '../src/witnesses.js';
import { AccountSimulator, change, privateStateFor, payoutTreeOf } from './simulator.js';
import { PARKED_UNTIL_THE_VAULT_PAYS_WITH_A_RECEIPT } from './until-the-vault-pays-with-a-receipt.js';
import { fromHex, toHex } from '../../src/core/crypto.js';

const VAULT_SOURCE = readFileSync(join(import.meta.dirname, '..', 'src', 'Vault.compact'), 'utf8');
const A = privateStateFor(1);
const B = privateStateFor(2);
const NOW = 1_800_000_000;
const BLOCK = '0'.repeat(64);
const bytes = (n: number) => new Uint8Array(32).fill(n);

describe("today's vault still calls the deleted payment step", () => {
  it('THE RATCHET: while the vault calls recordPayment the parked tests and the edge-list exception stand, and not a day longer', () => {
    const callsDeleted = /account\.recordPayment\(/.test(VAULT_SOURCE);
    const callsNew = /account\.recordPaymentFromVault\(/.test(VAULT_SOURCE);
    /*
     * RED WHEN the vault is rebuilt to pay through the receipt. Then: switch every
     * `itPaysOutOfTodaysVault` back to `it` and remove
     * `until-the-vault-pays-with-a-receipt.ts`; switch every
     * mutation parked with them back on; remove the edge list's one allowed
     * missing callee, which its own test holds to the same source; and delete this file.
     */
    expect(callsDeleted && !callsNew,
      'the vault no longer calls the deleted step: switch the parked vault tests back on').toBe(true);
    expect(PARKED_UNTIL_THE_VAULT_PAYS_WITH_A_RECEIPT).toBe(true);
    /* And the account really has no such circuit. */
    expect(Object.keys(new Account(witnesses as never).impureCircuits)).not.toContain('recordPayment');
  });

  it("and a real payout through today's vault, of an approved run, is refused", async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(NOW);
    const priv = { coin: { nonce: bytes(0x77), color: bytes(0x9b), value: 5_000n, mt_index: 0n } };
    const vault: any = new (Vault as any)({
      noteToSpend: (ctx: { privateState: typeof priv }) => [ctx.privateState, ctx.privateState.coin],
    });
    const vaultAddr = String(sampleContractAddress());
    const init = await vault.initialState(
      createConstructorContext({}, BLOCK),
      { bytes: Uint8Array.from(Buffer.from(String(sim.address), 'hex')) });
    let vaultState = init.currentContractState;
    const dep = await vault.impureCircuits.deposit(
      createCircuitContext('deposit' as never, vaultAddr as never, BLOCK, vaultState, priv),
      { nonce: bytes(0x77), color: bytes(0x9b), value: 5_000n });
    vaultState = dep.context.callContext.currentQueryContext.state;

    const vaultBytes = Uint8Array.from(Buffer.from(vaultAddr, 'hex'));
    await sim.adoptVault(vaultBytes, [A, B]);
    const details = vaultCircuits.payoutDetails(bytes(0x0a), bytes(0x9b), 250n, bytes(0x40));
    const tree = payoutTreeOf([{ details: toHex(details), nonce: toHex(bytes(0xc1)) }]);
    const from = BigInt(NOW - 3_600);
    const until = BigInt(NOW + 3_600);
    const c = change(0n, 11);
    await sim.as(sim.applying(A, c)).proposeRun({ root: fromHex(tree.root), payees: tree.payees, from, until, vault: vaultBytes });
    const id = sim.proposalId(pureCircuits.runPayload(fromHex(tree.root), tree.payees, from, until, 0n), c.salt, vaultBytes);
    await sim.as(sim.applying(A, c)).approve(id);
    await sim.as(sim.applying(B, c)).approve(id);

    /*
     * Today's vault takes the payee's path in the shape the account's old step took,
     * a merkle path, and the account's run root is now a sum tree's. The vault never
     * reaches the account with it: the callee it names is gone, which is what this pins.
     */
    const todaysPathShape = {
      leaf: pureCircuits.payoutLeaf(details, bytes(0xc1)),
      path: Array.from({ length: 16 }, () => ({ sibling: { field: 0n }, goes_left: true })),
    };
    const provider = {
      getContractState: async (_b: string, address: unknown) =>
        String(address) === String(sim.address) ? sim.contractStateForCall : undefined,
    };
    /* RED WHEN today's vault can pay again, which is when the parked tests come back. */
    await expect(vault.impureCircuits.payout(
      createCircuitContext('payout' as never, vaultAddr as never, BLOCK, vaultState, priv,
        provider as never, undefined, undefined, NOW, BLOCK),
      id, fromHex(tree.root), tree.payees, from, until, c.salt,
      bytes(0x0a), bytes(0x9b), 250n, bytes(0x40), bytes(0xc1), todaysPathShape)).rejects.toThrow(/Expected 'recordPayment' for callee/);
    /* Nothing was recorded for the person. */
    expect(sim.ledger.movements.size()).toBe(0n);
  });
});
