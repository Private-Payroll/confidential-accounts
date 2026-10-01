/**
 * **ONE RUN PAYS ONE LEDGER TOKEN, IN ONE FORM, AND ITS ROOT IS THE ROOT THE
 * VAULT'S ACCOUNT CHECKS FOR THAT TOKEN.**
 *
 * The account checks each payment with `sumPathRoot(leaf, amount, path, asset)`
 * against the approved root, where `asset` is what the vault hands it: the
 * spent coin's colour for a private payment, the token it sends for a public
 * one. Both are the token itself. So the product commits a run's root to the
 * token, and a run whose payments name more than one token, or more than one
 * form, is refused before anything is built.
 */
import { describe, it, expect } from 'vitest';
import { pureCircuits } from '../../contracts/managed/contract/index.js';
import { buildRun, buildRetryRun, rootOfPayments, runAssetOf, type PaymentFacts } from './payout-tree.js';
import { NIGHT, NO_ASSET, TEST_SETTLEMENT_ASSET, assetIdBytes } from '../core/assets.js';
import { fromHex, toHex, type Hex } from '../core/crypto.js';
import { payeeFor, unshieldedPayeeFor, payFor } from '../testing/payees.js';
import { vaultDetails } from '../testing/vault-details.js';
import { TEST_TOKEN } from '../testing/assets.js';

const NET = 'undeployed' as const;
const seeds = [{ epoch: 0, seed: '6e'.repeat(32) as Hex }];
const identity = { accountId: 'acc_1', runId: 'run_1', epoch: 0 };

const privately = (token: string): PaymentFacts[] => [
  { payee: payeeFor('a1'.repeat(32), NET), token, amount: 250n },
  { payee: payeeFor('a2'.repeat(32), NET), token, amount: 90n },
  { payee: payeeFor('a3'.repeat(32), NET), token, amount: 7n },
];
const publicly = (token: string): PaymentFacts[] => [
  { payee: unshieldedPayeeFor('b1'.repeat(32), NET), token, amount: 400n },
  { payee: unshieldedPayeeFor('b2'.repeat(32), NET), token, amount: 1n },
];

/** The root the account's own circuit reaches from one payee's leaf, amount and path, in the token the vault hands it. */
const accountChecks = (leaf: Hex, amount: bigint, path: ReadonlyArray<{ sibling: bigint; siblingSum: bigint; goesLeft: boolean }>, moved: string) =>
  toHex(pureCircuits.sumPathRoot(fromHex(leaf), amount, [...path], fromHex(moved)));

describe('THE ROOT A PRODUCT-BUILT RUN COMMITS TO IS THE ROOT THE ACCOUNT CHECKS FOR THE TOKEN MOVED', () => {
  it.each([
    ['a private run, which the vault pays from a coin of that colour', privately],
    ['a public run, which the vault pays by sending that token', publicly],
  ])('%s', (_what, facts) => {
    const run = buildRun(seeds, identity, facts(TEST_TOKEN), vaultDetails, payFor(facts(TEST_TOKEN)), TEST_TOKEN);
    /* RED WHEN the run's root commits to anything but the token itself, such as a padded name. */
    expect(run.tree.asset).toBe(TEST_TOKEN);
    expect(runAssetOf(TEST_TOKEN)).toBe(toHex(assetIdBytes(TEST_TOKEN)));
    for (let i = 0; i < run.facts.length; i++) {
      const args = run.payeeArgs(i);
      /* RED WHEN the account, handed the token the vault moves, would reach a different root from the one approved. */
      expect(accountChecks(args.leaf, args.amount, args.path, args.token)).toBe(run.tree.root);
      /* And a leaf whose token differs from the token actually moved reaches another root, which the account refuses. */
      expect(accountChecks(args.leaf, args.amount, args.path, TEST_SETTLEMENT_ASSET)).not.toBe(run.tree.root);
    }
    /* The product's own reading of a run's root agrees, over the leaves its records hold. */
    expect(rootOfPayments(run.tree.leaves, run.facts, TEST_TOKEN)).toBe(run.tree.root);
  });
});

describe('A RUN MIXING TOKENS OR FORMS IS REFUSED, BY NAME, BEFORE ANYTHING IS BUILT', () => {
  it('REFUSES a run whose payments are in two tokens', () => {
    const mixed = [...privately(TEST_SETTLEMENT_ASSET).slice(0, 1), ...privately(NIGHT).slice(1)];
    /* RED WHEN a run may hold payments in more than one token. */
    expect(() => buildRun(seeds, identity, mixed, vaultDetails, payFor(mixed), TEST_SETTLEMENT_ASSET))
      .toThrow(/^Payment 2 is in NIGHT and this run pays tUSD\. A run pays one token\. Create a separate run for NIGHT\. Nothing was created\.$/);
    expect(() => rootOfPayments(['00'.repeat(32), '00'.repeat(32), '00'.repeat(32)], mixed, TEST_SETTLEMENT_ASSET))
      .toThrow(/^Payment 2 is in NIGHT and this run pays tUSD\./);
  });

  it('REFUSES a run whose payments are all in a token other than the one it pays', () => {
    const facts = privately(NIGHT);
    /* RED WHEN the run's token is not compared with its payments' token. */
    expect(() => buildRun(seeds, identity, facts, vaultDetails, payFor(facts), TEST_SETTLEMENT_ASSET))
      .toThrow(/^Payment 1 is in NIGHT and this run pays tUSD\./);
  });

  it('REFUSES a run whose payees are private and public', () => {
    const mixed = [...privately(TEST_TOKEN).slice(0, 2), ...publicly(TEST_TOKEN).slice(0, 1)];
    /* RED WHEN one run may hold both forms. */
    expect(() => buildRun(seeds, identity, mixed, vaultDetails, payFor(mixed), TEST_TOKEN))
      .toThrow(/^This run has both private and public payments \(payment 1 is private, payment 3 is public\)\. A run pays one token, one way\. Create one run for the private payments and one for the public payments\. Each is approved on its own\. Nothing was created\.$/);
    expect(() => rootOfPayments(['00'.repeat(32), '00'.repeat(32), '00'.repeat(32)], mixed, TEST_TOKEN))
      .toThrow(/^This run has both private and public payments/);
  });

  it('REFUSES a run that names no asset, and a retry stays the run it retries', () => {
    const facts = privately(TEST_TOKEN);
    /* RED WHEN the marker for no asset may be a run's token. */
    expect(() => buildRun(seeds, identity, facts, vaultDetails, payFor(facts), NO_ASSET))
      .toThrow(/a run has to name the token it pays in, and this one names no asset/);
    const run = buildRun(seeds, identity, facts, vaultDetails, payFor(facts), TEST_TOKEN);
    const retry = buildRetryRun(run, [2, 0]);
    expect(retry.tree.asset).toBe(TEST_TOKEN);
    expect(retry.facts.every(f => f.payee.kind === 'shielded' && f.token === TEST_TOKEN)).toBe(true);
  });
});
