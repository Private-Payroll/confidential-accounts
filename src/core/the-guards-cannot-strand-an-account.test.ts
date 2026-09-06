import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './store-file.js';
import { SimulatedLedger, SimulatedCommitments } from './ledger.js';
import type { Ledger, LedgerStatus } from './ledger.js';
import { AccountService, openAccount, sealAccount } from './account.js';
import type { Account } from './types.js';

/**
 * **X19 — THE GUARDS AGAINST STRANDING AN ACCOUNT STOP TRUSTING OUR OWN
 * NUMBER, AND A GUARD THAT CANNOT READ THE CHAIN REFUSES.**
 *
 * Three sites, one class. `departing()` and the multi-removal guard refuse a
 * removal that would leave too few signers; `proposeThresholdChange` refuses a
 * threshold above the seats. All three compared against `account.policy.threshold`
 * and a count of our own roster — OUR COPIES of two numbers the contract owns.
 *
 * **THE DANGEROUS DIRECTION IS DRIFT BELOW THE CHAIN'S VALUE.** Our copy saying
 * 2 where the contract says 3 makes the guard permit a removal leaving two
 * signers where three are required, and from that moment every proposal on the
 * account is unapprovable and the money in it is unspendable by anybody.
 * **Nothing goes wrong when the signer is removed.** It goes wrong the next time
 * somebody tries to approve something, which may be a month later.
 *
 * Two claims are under test, and they fail in opposite directions, which is why
 * they are in one file:
 *
 * 1. **The numbers come off `LedgerStatus`.** Each test below puts a DIFFERENT
 *    value in our stored copy from the one the ledger holds, and requires the
 *    outcome to follow the ledger's. Both directions appear: a refusal our copy
 *    would not have made, and a permission our copy would have refused.
 * 2. **"We do not know" must not become "go ahead".** `R4` established that a
 *    status we cannot read is a third outcome; in an approval, not knowing means
 *    not proceeding. **In a guard the conservative direction is the opposite
 *    one** — a guard that permits a removal because it could not reach the chain
 *    has failed in exactly the direction that strands the account. All three
 *    refuse, each naming which silence it hit, and none of those refusals is
 *    phrased like the one that says the account WOULD be stranded.
 *
 * **These tests can only be as good as `SimulatedLedger`,** which runs in this
 * process. They do not show that a chain refused anything. They show that these
 * three guards ask, that they ask once per decision, and that no local number is
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
 * `scripts/mutate-authority.mjs`, which breaks the product and requires named
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
 * This is how our copy is made to disagree with the chain WITHOUT touching the
 * chain: the ledger goes on holding what it was opened with, and the sealed
 * record — the only thing an operator can reach — says something else. It is
 * precisely the authority `C121` describes, and the drift `C177` is about.
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

describe('X19: the bar and the seats are the ledger\'s, and our copy cannot move either', () => {
  it('refuses a removal our stale copy of the threshold would have allowed', async () => {
    /*
     * **SITE 1 — `departing()`.** The ledger is opened at 3 of 3 and stays
     * there. Our sealed copy is edited to 2, which is drift in the dangerous
     * direction and the whole of `C177`.
     *
     * Removing Cleo leaves two signers. Against the contract's 3 that is a
     * stranded account; against our 2 it reads as exactly enough. The refusal
     * has to follow the contract, and it has to name both numbers, because a
     * refusal quoting only "3" will be read against a screen rendering our 2.
     */
    const h = harness();
    const c = await h.accounts.create('Northwind Ltd', THREE, 3);
    editAccount(h, c.account.id, c.viewingKey, a => { a.policy.threshold = 2; });

    /*
     * THE REFUSAL ITSELF IS THE FIRST ASSERTION, and that is not stylistic. A
     * guard that stops refusing does not produce a wrong message, it produces
     * no message at all, so an assertion reading the message of an error that
     * was never thrown fails with a type complaint about `undefined` rather
     * than with the sentence "this resolved instead of rejecting". The
     * mutation's own death is easier to read this way.
     */
    const attempt = h.accounts.proposeRemoval(
      c.account.id, c.viewingKey, c.secrets[2].signerId, c.secrets[0].signerId);
    await expect(attempt).rejects.toThrow(/would leave 2 signers against a threshold of 3/);

    const err = await attempt.catch((e: Error) => e) as Error;
    expect(err.message).toMatch(/could never approve anything again/);
    expect(err.message).toMatch(/our stored copy of the threshold says 2/);

    /* And nothing was opened: a round that can never settle collects no signatures. */
    expect((await h.accounts.ledgerStatus(c.account.id))!.openProposals).toEqual([]);
    expect(h.accounts.open(c.account.id, c.viewingKey).signers).toHaveLength(3);
  });

  it('refuses a rotation our stale copy of the threshold would have allowed', async () => {
    /*
     * **SITE 2 — the multi-removal guard, whose own comment already said this
     * plainly.** Same drift, one layer over: excluding Cleo from a rotation
     * leaves two people holding the new key against the contract's 3.
     *
     * The excluded signer's SEAT is not freed — a rotation changes the locks
     * and touches no leaf — so the chain's seat count cannot rescue the roster
     * here, and the smaller of the two counts is the one that decides.
     */
    const h = harness();
    const c = await h.accounts.create('Northwind Ltd', THREE, 3);
    editAccount(h, c.account.id, c.viewingKey, a => { a.policy.threshold = 2; });

    const attempt = h.accounts.rotate(c.account.id, c.viewingKey, [c.secrets[2].signerId]);
    await expect(attempt).rejects.toThrow(/would leave 2 active of a threshold of 3/);

    const err = await attempt.catch((e: Error) => e) as Error;
    expect(err.message).toMatch(/our stored copy of the threshold says 2/);
    /* Nothing moved: the old key still opens the account at the old epoch. */
    expect(h.accounts.require(c.account.id).keyEpoch).toBe(0);
    expect(h.accounts.open(c.account.id, c.viewingKey).name).toBe('Northwind Ltd');
  });

  it('refuses a threshold above the seats the LEDGER holds, not the rows we hold', async () => {
    /*
     * **SITE 3 — the mirror image, and the one that gets forgotten.** It guards
     * the other side of the same invariant: the threshold may not exceed the
     * seated count. Its `seated` figure was ours too.
     *
     * A fourth row is put in the roster whose seat the tree does not hold —
     * which is the drift this direction produces, and is survivable in exactly
     * one direction: believing in a signer the contract will not accept makes
     * this guard PERMIT a threshold of 4 on an account with three seats, and an
     * account whose threshold exceeds its seats can never reach it again.
     */
    const h = harness();
    const c = await h.accounts.create('Northwind Ltd', THREE, 2);
    editAccount(h, c.account.id, c.viewingKey, a => {
      a.signers.push({ ...a.signers[0], id: 'sgn_ghost', name: 'A seat the tree does not hold' });
    });

    const attempt = h.accounts.proposeThresholdChange(
      c.account.id, c.viewingKey, 4, c.secrets[0].signerId);
    await expect(attempt).rejects.toThrow(/cannot exceed the 3 signers the ledger holds seats for/);

    const err = await attempt.catch((e: Error) => e) as Error;
    expect(err.message).toMatch(/our roster holds 4 active signers/);
    expect((await h.accounts.ledgerStatus(c.account.id))!.openProposals).toEqual([]);
  });

  it('allows the change our stale copy would have called a no-op', async () => {
    /*
     * **THE SAME SITE, THE OTHER DIRECTION, AND THE SECOND READ OF OUR COPY IN
     * THAT METHOD.** `docs/how-money-can-be-lost.md` names `:867` — the
     * "already that number" check — as the third site where the round's own
     * heading names the seated count above it. Both were ours; both are the
     * ledger's now, and this is the one that shows the second.
     *
     * The contract is at 3 and our copy says 2. Lowering the threshold to 2 is
     * a real change that a stale copy calls "already 2" and refuses — a round
     * the company is entitled to raise, blocked by a number we alone hold.
     */
    const h = harness();
    const c = await h.accounts.create('Northwind Ltd', THREE, 3);
    editAccount(h, c.account.id, c.viewingKey, a => { a.policy.threshold = 2; });

    const p = await h.accounts.proposeThresholdChange(
      c.account.id, c.viewingKey, 2, c.secrets[0].signerId);

    expect(p.kind).toBe('set-threshold');
    expect(p.status).toBe('open');
    expect((await h.accounts.ledgerStatus(c.account.id))!.openProposals).toHaveLength(1);
  });

  it('does NOT refuse when the ledger agrees, which is what makes the rest mean anything', async () => {
    /*
     * The negative control. Without it every test above passes against a guard
     * that refuses everything, and "conservative" would have become "broken".
     * One account, all three sites, nothing bent and nothing edited.
     */
    const h = harness();
    const c = await h.accounts.create('Northwind Ltd', THREE, 2);

    const removal = await h.accounts.proposeRemoval(
      c.account.id, c.viewingKey, c.secrets[2].signerId, c.secrets[0].signerId);
    expect(removal.status).toBe('open');

    const raise = await h.accounts.proposeThresholdChange(
      c.account.id, c.viewingKey, 3, c.secrets[0].signerId);
    expect(raise.kind).toBe('set-threshold');

    const rotated = await h.accounts.rotate(c.account.id, c.viewingKey);
    expect(rotated.keyEpoch).toBe(1);
  });
});

describe('X19: a guard that cannot read the chain refuses, and says which silence it hit', () => {
  it('refuses a removal when the boundary throws, without saying the account would be stranded', async () => {
    /*
     * **SITE 1, AND THE REASON THE MESSAGES ARE DIFFERENT.** The ledger here
     * holds three signers and a threshold of 2, so the removal is perfectly
     * safe — and we cannot see that, which is not the same fact as the removal
     * being unsafe. Merging them gives a person a refusal saying the account
     * would be stranded when the truth is that the indexer is down: they would
     * go and lower the threshold, which is the one action that makes the real
     * risk worse.
     */
    let broken = true;
    const h = harness(real => {
      if (broken) throw new Error('indexer unreachable');
      return real;
    });
    const c = await h.accounts.create('Northwind Ltd', THREE, 2);

    const attempt = h.accounts.proposeRemoval(
      c.account.id, c.viewingKey, c.secrets[2].signerId, c.secrets[0].signerId);
    await expect(attempt).rejects.toThrow(/refusing to remove Cleo as a signer/);

    const err = await attempt.catch((e: Error) => e) as Error;
    expect(err.message)
      .toMatch(/cannot read the account's threshold and seat count from the ledger \(unreadable\)/);
    /* The two refusals are told apart by this line, and only by this line. */
    expect(err.message).not.toMatch(/could never approve anything again/);

    broken = false;
    expect((await h.accounts.ledgerStatus(c.account.id))!.openProposals).toEqual([]);
    expect(h.accounts.open(c.account.id, c.viewingKey).signers).toHaveLength(3);
  });

  it('refuses a rotation when the boundary has never heard of the account', async () => {
    /*
     * **SITE 2, AND A DIFFERENT SILENCE.** `null` is not "no signers": an
     * account the boundary cannot find and an account with nobody in it are
     * different facts, and the first is our ignorance. `R4` drew that line for
     * approvals; this is the same line drawn for the guard.
     */
    let broken = true;
    const h = harness(real => (broken ? null : real));
    const c = await h.accounts.create('Northwind Ltd', THREE, 2);

    const attempt = h.accounts.rotate(c.account.id, c.viewingKey, [c.secrets[2].signerId]);
    await expect(attempt)
      .rejects.toThrow(/refusing to change the locks on this account without 1 of its signers/);

    const err = await attempt.catch((e: Error) => e) as Error;
    expect(err.message)
      .toMatch(/cannot read the account's threshold and seat count from the ledger \(no-status\)/);
    expect(err.message).not.toMatch(/could never approve anything again/);

    broken = false;
    expect(h.accounts.require(c.account.id).keyEpoch).toBe(0);
  });

  it('still changes the locks when nobody is dropped and the ledger is unreachable', async () => {
    /*
     * **THE EXEMPTION, PINNED, BECAUSE IT IS THE ONE PLACE WHERE REFUSING WOULD
     * HAVE BEEN THE UNSAFE ANSWER.**
     *
     * `removeSigner` performs the removal on chain, drops the roster row, and
     * then rotates with `exclude` empty — and that rotation is what takes the
     * departing signer's ability to READ. A guard on it would let an
     * unreachable indexer refuse the second half of a removal whose first half
     * has settled, leaving somebody out of the tree and still holding a working
     * viewing key. Dropping nobody changes no survivor count and no rule, so
     * there is nothing there to be conservative about.
     *
     * The same harness refuses the removal above, at the site that does guard
     * something. Both facts are the round, and they are only consistent because
     * "guard" means the operation that removes somebody.
     */
    const h = harness(() => { throw new Error('indexer unreachable'); });
    const c = await h.accounts.create('Northwind Ltd', THREE, 2);

    const rotated = await h.accounts.rotate(c.account.id, c.viewingKey);

    expect(rotated.keyEpoch).toBe(1);
    /* Every signer can still reach the new key from their own wrapping secret. */
    for (const s of c.secrets) {
      expect(h.accounts.recoverViewingKey(c.account.id, s.signerId, s.wrappingSecret))
        .toBe(rotated.viewingKey);
    }
  });

  it('refuses a threshold round when the boundary answers without the numbers in it', async () => {
    /*
     * **SITE 3, AND THE SILENCE THAT DOES NOT LOOK LIKE ONE.** A status object
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
    const c = await h.accounts.create('Northwind Ltd', THREE, 2);

    const attempt = h.accounts.proposeThresholdChange(
      c.account.id, c.viewingKey, 3, c.secrets[0].signerId);
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
