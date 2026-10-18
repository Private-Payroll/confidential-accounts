import { describe, it, expect } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './store-file.js';
import { SimulatedLedger, SimulatedCommitments } from './ledger.js';
import type { Ledger, LedgerStatus } from './ledger.js';
import { AccountService, openAccount, sealAccount } from './account.js';
import type { Account } from './types.js';

/** The value, or a failure that says one was missing: an index that finds nothing is a broken test, not a value to carry on with. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value here, and there was none');
  return value;
}

/**
 * **THE GUARDS AGAINST STRANDING AN ACCOUNT DECIDE FROM THE CHAIN'S NUMBERS,
 * AND A GUARD THAT CANNOT READ THE CHAIN REFUSES.**
 *
 * One site in this service: `proposeThresholdChange` refuses a threshold above
 * the seats, measured against the threshold and the seated count the ledger
 * holds, never against the stored record. A removal and the change of the
 * company's key that follows it are the devices'; the chain refuses a removal
 * that would leave too few signers when it is carried out.
 *
 * **THE DANGEROUS DIRECTION IS A NUMBER BELOW THE CONTRACT'S.** A threshold
 * written into the stored record by anyone who holds the key is not read: were
 * it read, a stored 2 against the contract's 3 would make the guard permit a
 * removal leaving two signers where three are required, and from that moment
 * every proposal on the account is unapprovable and the money in it is
 * unspendable by anybody. **Nothing goes wrong when the signer is removed.** It
 * goes wrong the next time somebody tries to approve something, which may be a
 * month later.
 *
 * Two claims are under test, and they fail in opposite directions, which is why
 * they are in one file:
 *
 * 1. **The numbers come off `LedgerStatus`.** Each test below writes a DIFFERENT
 *    value into the stored record from the one the ledger holds, and requires
 *    the outcome to follow the ledger's. Both directions appear: a refusal the
 *    stored record would not have made, and a permission it would have refused.
 * 2. **"We do not know" must not become "go ahead".** A status we cannot read
 *    is a third outcome; in an approval, not knowing means not proceeding.
 *    **In a guard the conservative direction is the opposite one** — a guard
 *    that permits a change because it could not reach the chain has failed in
 *    exactly the direction that strands the account. The guard refuses, naming
 *    which silence it hit, and that refusal is not phrased like the one that
 *    says the account WOULD be stranded.
 *
 * **These tests can only be as good as `SimulatedLedger`,** which runs in this
 * process. They do not show that a chain refused anything. They show that the
 * guard asks, that it asks once per decision, and that no local number is
 * left that could answer instead.
 */

/** Ada, Blake and Cleo. The threshold varies per test and is the point of most of them. */
const THREE = [
  { name: 'Ada', role: 'admin' as const },
  { name: 'Blake', role: 'approver' as const },
  { name: 'Cleo', role: 'approver' as const },
];

/**
 * A service over a real `SimulatedLedger` whose `status()` can be bent.
 *
 * `bend` receives the real status and returns whatever the caller wants the
 * boundary to have answered — or throws, which is a third thing a real indexer
 * does and a stub returning `null` cannot express. Everything else passes
 * through untouched, so the chain really does hold the signers and the
 * threshold; only our VIEW of it is broken.
 *
 * **A NEAR-TWIN OF THE HARNESS IN `the-threshold-is-the-chain-s.test.ts`, AND
 * DELIBERATELY NOT SHARED WITH IT.** Both files are judged by
 * the same deliberate defects, which break the product and require named
 * tests in each to die alone. A fixture common to both is a place where one
 * suite's mutation can change the other suite's setup, which is the one kind of
 * coupling a mutation harness cannot see.
 */
type Bend = (real: LedgerStatus | null) => LedgerStatus | null;

function harness(bend?: Bend) {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-x19-')), 'db.json'));
  const inner: Ledger = new SimulatedLedger(SimulatedCommitments);
  const ledger: Ledger = bend
    ? (new Proxy(inner, {
        get(target, key, recv) {
          if (key === 'status') {
            return async (accountId: string) => bend(await inner.status(accountId));
          }
          const v = Reflect.get(target, key, recv);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }) as Ledger)
    : inner;
  return { store, accounts: new AccountService(store, ledger, SimulatedCommitments) };
}

/**
 * Opens, edits and re-seals the account the way a key holder would.
 *
 * This is how the stored record is made to disagree with the chain WITHOUT
 * touching the chain: the ledger goes on holding what it was opened with, and
 * the sealed record — the only thing an operator can reach — says something
 * else. It is precisely the authority a key holder has, and the disagreement
 * under test here.
 */
function editAccount(
  h: ReturnType<typeof harness>,
  accountId: string,
  viewingKey: string,
  edit: (a: Account) => void,
) {
  const rec = h.accounts.require(accountId);
  const account = openAccount(rec, viewingKey);
  edit(account);
  h.store.putAccount(sealAccount(account, viewingKey, rec.pendingSigners, rec.keyEpoch));
}

describe('the bar and the seats are the ledger\'s, whatever the stored record says', () => {
  it('refuses a threshold above the seats the LEDGER holds, not the rows we hold', async () => {
    /*
     * **The threshold may not exceed the seated count**, the other side of the
     * invariant a removal is held to on the chain. Its `seated` figure was ours
     * too.
     *
     * A fourth row is put in the roster whose seat the tree does not hold —
     * which is the drift this direction produces, and is survivable in exactly
     * one direction: believing in a signer the contract will not accept makes
     * this guard PERMIT a threshold of 4 on an account with three seats, and an
     * account whose threshold exceeds its seats can never reach it again.
     */
    const h = harness();
    const c = await h.accounts.create('Northwind Ltd', THREE, 2, undefined, drawCompanyLabel());
    editAccount(h, c.account.id, c.viewingKey, a => {
      a.signers.push({ ...present(a.signers[0]), id: 'sgn_ghost', name: 'A seat the tree does not hold' });
    });

    const attempt = h.accounts.proposeThresholdChange(
      c.account.id, c.viewingKey, 4, present(c.secrets[0]).signerId);
    await expect(attempt).rejects.toThrow(/cannot exceed the 3 signers the ledger holds seats for/);

    const err = await attempt.catch((e: Error) => e) as Error;
    expect(err.message).toMatch(/our roster holds 4 active signers/);
    expect((await h.accounts.ledgerStatus(c.account.id))!.openProposals).toEqual([]);
  });

  it('allows lowering the threshold to a number the stored record already names', async () => {
    /*
     * **THE SAME SITE, THE OTHER DIRECTION: THE "ALREADY THAT NUMBER" CHECK.**
     * The seated count and that check both read the ledger.
     *
     * The contract is at 3 and the stored record says 2. Lowering the threshold
     * to 2 is a real change that a check reading the stored record would call
     * "already 2" and refuse — a proposal the company is entitled to raise,
     * blocked by a number the ledger does not hold.
     */
    const h = harness();
    const c = await h.accounts.create('Northwind Ltd', THREE, 3, undefined, drawCompanyLabel());
    editAccount(h, c.account.id, c.viewingKey, a => { (a.policy as unknown as { threshold: number }).threshold = 2; });

    const p = await h.accounts.proposeThresholdChange(
      c.account.id, c.viewingKey, 2, present(c.secrets[0]).signerId);

    expect(p.kind).toBe('set-threshold');
    expect(p.status).toBe('open');
    expect((await h.accounts.ledgerStatus(c.account.id))!.openProposals).toHaveLength(1);
  });

  it('does NOT refuse when the ledger agrees, which is what makes the rest mean anything', async () => {
    /*
     * The negative control. Without it every test above passes against a guard
     * that refuses everything, and "conservative" would have become "broken".
     * One account, nothing bent and nothing edited.
     */
    const h = harness();
    const c = await h.accounts.create('Northwind Ltd', THREE, 2, undefined, drawCompanyLabel());

    const raise = await h.accounts.proposeThresholdChange(
      c.account.id, c.viewingKey, 3, present(c.secrets[0]).signerId);
    expect(raise.kind).toBe('set-threshold');
  });
});

describe('a guard that cannot read the chain refuses, and says which silence it hit', () => {
  it('refuses a threshold round when the boundary answers without the numbers in it', async () => {
    /*
     * **THE SILENCE THAT DOES NOT LOOK LIKE ONE.** A status object
     * arrives, and the field the guard needs is not in it. `LedgerStatus.threshold`
     * is typed `number` so this cannot happen inside this repository; it is what
     * a real indexer response missing a field decodes to, and `undefined` in the
     * comparison is not an error but `false` — the permissive answer. The type
     * cannot catch it because the type is already a lie by then, so the reducer
     * has to.
     */
    let broken = true;
    const h = harness(real =>
      broken && real ? { ...real, threshold: undefined as unknown as number } : real);
    const c = await h.accounts.create('Northwind Ltd', THREE, 2, undefined, drawCompanyLabel());

    const attempt = h.accounts.proposeThresholdChange(
      c.account.id, c.viewingKey, 3, present(c.secrets[0]).signerId);
    await expect(attempt)
      .rejects.toThrow(/refusing to open a round to change this account's threshold to 3/);

    const err = await attempt.catch((e: Error) => e) as Error;
    expect(err.message)
      .toMatch(/cannot read the account's threshold and seat count from the ledger \(incomplete\)/);
    expect(err.message).not.toMatch(/cannot exceed/);

    broken = false;
    expect((await h.accounts.ledgerStatus(c.account.id))!.openProposals).toEqual([]);
  });
});
