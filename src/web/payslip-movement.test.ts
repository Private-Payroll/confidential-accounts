import { describe, expect, it } from 'vitest';
import { buildRun, paidMovementOfLeaf } from '../midnight/payout-tree.js';
import { vaultDetails } from '../testing/vault-details.js';
import { payeeFor, unshieldedPayeeFor } from '../testing/payees.js';
import { toHex } from '../core/crypto.js';
import { contractCircuits, movementOfPayslip } from './payslip-movement.js';

/**
 * **THE DEVICE BUILDS THE SAME VALUE THE RUN'S OWN TREE DOES, WITH THE
 * CONTRACTS' OWN CIRCUITS, LOADED THE WAY THE WORKER LOADS THEM.**
 *
 * The run is built by the product's own `buildRun` from a seed; the device side
 * is handed only what a payee holds - the address, the token, the amount, and
 * its own nonce and blinding - and must arrive at the value the account records
 * for that payee's leaf.
 */
const seeds = [{ epoch: 0, seed: '5e'.repeat(32) }];
const identity = { accountId: 'acc_1', runId: 'run_1', epoch: 0 };
const TOKEN = 'ab'.repeat(32);
const facts = [1, 2, 3].map((i) => ({
  payee: payeeFor(toHex(new Uint8Array(32).fill(i)), 'undeployed'), token: TOKEN, amount: BigInt(i * 1_000),
}));

describe('what the payee\'s device looks for is what the account records', () => {
  it('EVERY PAYEE\'S VALUE, BUILT FROM WHAT THAT PAYEE HOLDS, IS THE VALUE OF THEIR OWN LEAF', async () => {
    const run = buildRun(seeds, identity, facts, vaultDetails);
    /* The worker's own loader: the vault's and the account's compiled contracts, loaded side by side. */
    const circuits = await contractCircuits();
    facts.forEach((f, i) => {
      const args = run.payeeArgs(i);
      const built = movementOfPayslip(circuits, {
        paidTo: f.payee.bech32, token: TOKEN, amount: f.amount.toString(), nonce: args.nonce, blinding: args.blinding,
      });
      /*
       * RED WHEN any step is not the contract's own: the unshielded details
       * circuit in place of the shielded one, a leaf hashed any other way, or
       * the recipient taken as anything but the address's coin key.
       */
      expect(built).toBe(paidMovementOfLeaf(run.tree.leaves[i]!));
    });
  });

  it('A COLLEAGUE\'S SECRETS, OR ANOTHER ADDRESS, BUILD A VALUE THAT IS NOBODY\'S', async () => {
    const run = buildRun(seeds, identity, facts, vaultDetails);
    const circuits = await contractCircuits();
    const all = new Set(run.tree.leaves.map(paidMovementOfLeaf));
    const eli = run.payeeArgs(1);
    /* Dana's address with Eli's nonce and blinding. RED WHEN the address is not bound into the value. */
    expect(all.has(movementOfPayslip(circuits, {
      paidTo: facts[0]!.payee.bech32, token: TOKEN, amount: facts[1]!.amount.toString(), nonce: eli.nonce, blinding: eli.blinding,
    }))).toBe(false);
  });

  it('A MAINNET ADDRESS, WHICH NAMES NO NETWORK, BUILDS THE SAME VALUE AS ITS OWN LEAF', async () => {
    const onMainnet = [{ ...facts[0]!, payee: payeeFor(toHex(new Uint8Array(32).fill(1)), 'mainnet') }];
    const run = buildRun(seeds, identity, onMainnet, vaultDetails);
    const args = run.payeeArgs(0);
    /*
     * A CONTROL, NOT A GUARD: the platform's parse answers a symbol for a mainnet
     * address, and passing that symbol straight on happens to decode too, so
     * this stays green either way. RED WHEN a mainnet address stops building
     * its own value at all, which a network check that refused the symbol
     * without mapping it would do.
     */
    expect(movementOfPayslip(await contractCircuits(), {
      paidTo: onMainnet[0]!.payee.bech32, token: TOKEN, amount: onMainnet[0]!.amount.toString(),
      nonce: args.nonce, blinding: args.blinding,
    })).toBe(paidMovementOfLeaf(run.tree.leaves[0]!));
  });

  it('A PUBLIC PAYEE\'S VALUE, BUILT FROM WHAT THEY HOLD, IS THE VALUE OF THEIR OWN PUBLIC LEAF', async () => {
    /* A run paying one person publicly and one privately, from the SAME thirty-two bytes. */
    const bytes = toHex(new Uint8Array(32).fill(9));
    const mixed = [
      { payee: unshieldedPayeeFor(bytes, 'undeployed'), token: TOKEN, amount: 4_000n },
      { payee: payeeFor(bytes, 'undeployed'), token: TOKEN, amount: 4_000n },
    ];
    const run = buildRun(seeds, identity, mixed, vaultDetails);
    const circuits = await contractCircuits();
    mixed.forEach((f, i) => {
      const args = run.payeeArgs(i);
      /*
       * RED WHEN the device builds every value with the shielded details
       * circuit, or reads the kind from anything but the address: the public
       * payee's value is then not their leaf's.
       */
      expect(movementOfPayslip(circuits, {
        paidTo: f.payee.bech32, token: TOKEN, amount: f.amount.toString(), nonce: args.nonce, blinding: args.blinding,
      }), f.payee.kind).toBe(paidMovementOfLeaf(run.tree.leaves[i]!));
    });
  });

  it('AN ADDRESS THAT DOES NOT DECODE IS REFUSED, NOT GUESSED AT', async () => {
    const circuits = await contractCircuits();
    for (const paidTo of ['', 'mn_addr_undeployed1qqqq', 'nonsense']) {
      /* RED WHEN something that does not decode builds a value anyway. */
      expect(() => movementOfPayslip(circuits, {
        paidTo, token: TOKEN, amount: '1', nonce: '01'.repeat(32), blinding: '02'.repeat(32),
      }), paidTo).toThrow();
    }
  });
});
