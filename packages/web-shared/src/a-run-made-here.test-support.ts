/**
 * **A PAYROLL RUN AS AN APPROVING DEVICE MAKES IT AGAIN, FOR TESTS OF THE
 * BUILDER THAT ARE ABOUT SOMETHING ELSE.** Three payees, their leaves made with
 * the compiled circuits from a payout seed and a pay-record key, and an account
 * ledger that holds the pay-record key committed, so the honest case of an
 * approval is a real run made again.
 */
import { buildRun, type PaymentFacts } from '../../../src/midnight/payout-tree.js';
import { fromHex, toHex, type Hex } from '../../../src/core/crypto.js';
import { pureCircuits } from '../../../contracts/managed/contract/index.js';
import { paymentEntriesOf } from './payment-entries.js';
import { payeeFor, payFor } from '../../../src/testing/payees.js';
import { vaultDetails } from '../../../src/testing/vault-details.js';
import { TEST_TOKEN, registryWithTestPrivateForms } from '../../../src/testing/assets.js';
import { ledgerTokenOf } from '../../../src/core/assets.js';
import type { AccountLedgerView, RunMadeHere } from './what-this-device-made.js';

/**
 * A run of three, in a window, made the way the approving device makes it,
 * carrying what the person's own wallet read: nobody paid, and the pay-record
 * key committed with `commit` (the account's own circuit unless a test gives
 * its own).
 */
export const aRunMadeHere = (
  window: { opensAt: string; closesAt: string },
  commit: (key: Uint8Array) => Uint8Array = pureCircuits.payKeyCommitmentOf,
) => {
  const facts: PaymentFacts[] = [0, 1, 2].map((i) => ({
    payee: payeeFor(`a${i + 1}`.repeat(32), 'undeployed'),
    token: ledgerTokenOf(TEST_TOKEN, 'shielded', registryWithTestPrivateForms()), amount: BigInt(100 + i),
  }));
  const pay = payFor(facts, { people: ['p1', 'p2', 'p3'] });
  const seeds = [{ epoch: 0, seed: '6e'.repeat(32) as Hex }];
  const identity = { accountId: 'acc_1', runId: 'run_1:leg', epoch: 0 };
  const tree = buildRun(seeds, identity, facts, vaultDetails, pay, TEST_TOKEN).tree;
  let made: RunMadeHere = {
    kind: 'payroll', seeds, payKey: pay.key, identity, facts, records: pay.records,
    asset: TEST_TOKEN, opensAt: window.opensAt, closesAt: window.closesAt, required: '0',
  };
  const asked = paymentEntriesOf(made, pureCircuits.paidOnceOf);
  made = { ...made, wallet: { payKeyCommitment: toHex(commit(fromHex(pay.key))), asked, held: [], openRounds: [], entries: 0 } };
  return { made, root: tree.root, payees: tree.payees };
};

/** A ledger that holds every proposal asked about open, or none, and has paid nobody. */
export const aLedgerHolding = (holds: 'every proposal' | 'none' = 'every proposal'): AccountLedgerView => ({
  openProposals: { member: () => holds === 'every proposal' },
  movements: { member: () => false },
});
