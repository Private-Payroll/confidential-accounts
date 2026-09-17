import { describe, it, expect } from 'vitest';
import { buildPayoutTree, buildRun } from './payout-tree.js';
import { assemblePrivatePayments, pathFromWire, pathToWire } from './private-payment-wire.js';
import { payeeFor, unshieldedPayeeFor } from '../testing/payees.js';
import { vaultDetails } from '../testing/vault-details.js';
import type { Hex } from '../core/crypto.js';

/*
 * A payee's merkle path crosses from the service to the device's builder as the
 * runtime's own aligned value, and comes back as exactly the path the tree gave.
 */
const leaf = (n: number) => ({ details: n.toString(16).padStart(2, '0').repeat(32), nonce: (n + 1).toString(16).padStart(2, '0').repeat(32) }) as never;

describe('A PAYEE\'S PATH ON THE WIRE', () => {
  it('comes back as the path the payout tree gave, for every payee', () => {
    /* RED WHEN: either direction drops or reorders a value - the rebuilt path then differs from the tree's. */
    const tree = buildPayoutTree([leaf(1), leaf(3), leaf(5)]);
    for (const i of [0, 1, 2]) {
      const wire = pathToWire(tree.pathFor(i));
      expect(wire.every((h) => /^([0-9a-f]{2})*$/u.test(h))).toBe(true);
      expect(pathFromWire(JSON.parse(JSON.stringify(wire)))).toEqual(tree.pathFor(i));
    }
    expect(pathToWire(tree.pathFor(0))).not.toEqual(pathToWire(tree.pathFor(1)));
  });

  it('REFUSES A PATH THAT IS NOT BYTE STRINGS, OR CARRIES MORE THAN ONE PATH', () => {
    const wire = pathToWire(buildPayoutTree([leaf(1)]).pathFor(0));
    /* RED WHEN: the trailing-values check is removed - a longer list would be read as its first path. */
    expect(() => pathFromWire([...wire, ...wire])).toThrow(/more than one path/);
    expect(() => pathFromWire([...wire.slice(0, -1), 'zz'])).toThrow(/not a list of byte strings/);
    expect(() => pathFromWire('00' as never)).toThrow(/not a list of byte strings/);
    expect(() => pathFromWire(wire.slice(0, 3))).toThrow();
  });
});

describe('ONE APPROVED LEG\'S PAYMENTS, AS THE SERVICE HANDS THEM TO A DEVICE', () => {
  const NET = 'undeployed' as const;
  const TOKEN = 'ab'.repeat(32) as Hex;
  const seeds = [{ epoch: 0, seed: '5e'.repeat(32) as Hex }];
  const identity = { accountId: 'acc_1', runId: 'run_1', epoch: 0 };
  const facts = [
    { payee: payeeFor('a1'.repeat(32), NET), token: TOKEN, amount: 250n },
    { payee: payeeFor('a2'.repeat(32), NET), token: TOKEN, amount: 90n },
  ];
  const built = buildRun(seeds, identity, facts, vaultDetails);
  const window = { from: 100n, until: 200n };
  /* A stand-in for the contract's identity: a function of exactly the values it folds, so any change shows. */
  const idFrom = (leaves: Hex[], w: { from: bigint; until: bigint }) =>
    `id:${leaves.join('')}:${w.from}:${w.until}` as Hex;
  const input = (over: Record<string, unknown> = {}) => ({
    order: {
      asset: 'TESTUSD', vault: 'fa'.repeat(32) as Hex, proposal: idFrom(built.tree.leaves, window),
      salt: '5a'.repeat(32) as Hex, root: built.tree.root, payees: built.tree.payees, opensAt: 100n, closesAt: 200n,
    },
    leaves: built.tree.leaves, window, idFrom, built, facts,
    paid: new Set([built.tree.leaves[1]!]) as ReadonlySet<string> | null,
    ...over,
  });

  it('hands over every person\'s own values, as the rebuilt run gives them, and who the account already records paid', () => {
    const out = assemblePrivatePayments(input());
    if ('refusal' in out) throw new Error(out.refusal);
    expect(out.order).toMatchObject({
      asset: 'TESTUSD', vault: 'fa'.repeat(32), salt: '5a'.repeat(32), root: built.tree.root,
      payees: '2', opensAt: '100', closesAt: '200',
    });
    expect(out.order.payments).toHaveLength(2);
    for (const i of [0, 1]) {
      const args = built.payeeArgs(i);
      const p = out.order.payments[i]!;
      /* RED WHEN: a person's values are taken from another position, or their address from anywhere but their own fact. */
      expect(p).toMatchObject({
        index: i, payee: facts[i]!.payee.bech32, token: TOKEN, amount: String(facts[i]!.amount),
        blinding: args.blinding, nonce: args.nonce, leaf: args.leaf,
      });
      expect(pathFromWire(p.path)).toEqual(args.path);
    }
    /* RED WHEN: `paid` is read for the wrong leaf. */
    expect(out.order.payments.map((p) => p.paid)).toEqual([false, true]);
    /* A deployment that cannot say is not reported as nobody paid. */
    const unknown = assemblePrivatePayments(input({ paid: null }));
    expect('order' in unknown && unknown.order.payments.map((p) => p.paid)).toEqual([null, null]);
  });

  it('REFUSES A REBUILD WHOSE LEAVES, ROOT, COUNT OR IDENTITY ARE NOT WHAT THE SIGNERS APPROVED', () => {
    const refused = /not the ones its signers approved/;
    const other = buildRun(seeds, { ...identity, runId: 'run_2' }, facts, vaultDetails);
    /* RED WHEN: any one of the four comparisons is dropped. */
    expect(assemblePrivatePayments(input({ leaves: other.tree.leaves }))).toEqual({ refusal: expect.stringMatching(refused) });
    expect(assemblePrivatePayments(input({ leaves: built.tree.leaves.slice(0, 1) }))).toEqual({ refusal: expect.stringMatching(refused) });
    expect(assemblePrivatePayments(input({ order: { ...input().order, root: other.tree.root } }))).toEqual({ refusal: expect.stringMatching(refused) });
    expect(assemblePrivatePayments(input({ order: { ...input().order, payees: 3n } }))).toEqual({ refusal: expect.stringMatching(refused) });
    expect(assemblePrivatePayments(input({ order: { ...input().order, proposal: 'ff'.repeat(32) } }))).toEqual({ refusal: expect.stringMatching(refused) });
    expect(assemblePrivatePayments(input({ window: { from: 100n, until: 201n } }))).toEqual({ refusal: expect.stringMatching(refused) });
    expect(assemblePrivatePayments(input({ facts: facts.slice(0, 1) }))).toEqual({ refusal: expect.stringMatching(refused) });
  });

  it('REFUSES A LEG THAT NAMES A PUBLIC ADDRESS, EVEN ONE THE SIGNERS APPROVED', () => {
    /* RED WHEN: the kind check is removed - a person would be offered a payment the private circuit cannot make. */
    const publicFacts = [facts[0]!, { payee: unshieldedPayeeFor('c3'.repeat(32), NET), token: TOKEN, amount: 90n }];
    const mixed = buildRun(seeds, identity, publicFacts, vaultDetails);
    const out = assemblePrivatePayments(input({
      built: mixed, facts: publicFacts, leaves: mixed.tree.leaves,
      order: { ...input().order, root: mixed.tree.root, proposal: idFrom(mixed.tree.leaves, window) },
    }));
    expect(out).toEqual({ refusal: expect.stringMatching(/names a public address/) });
  });
});
