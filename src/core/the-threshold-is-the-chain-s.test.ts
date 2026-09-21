import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './store-file.js';
import { SimulatedLedger, SimulatedCommitments } from './ledger.js';
import type { Ledger, LedgerStatus } from './ledger.js';
import { AccountService, openAccount, sealAccount, approvalMessage } from './account.js';
import { sign, newSigningKeypair, newWrappingKeypair } from './crypto.js';
import type { Account } from './types.js';

/**
 * **THE BAR AND THE COUNT BOTH COME FROM THE LEDGER, AND NOT KNOWING IS ITS OWN
 * ANSWER.**
 *
 * Two claims are under test here and they fail in opposite directions, which is
 * why they are in one file:
 *
 * 1. **No amount is small enough to need fewer approvals**, and our own copy of
 *    the threshold cannot lower the bar even when somebody edits it. This is
 *    the deleted auto-approve exception held down: the feature is gone
 *    from the type, so the only way to show the BEHAVIOUR is gone is to drive
 *    the smallest payment the system can express and watch it still need M, and
 *    then to put a lower number in the place the old rule read from and watch
 *    that fail to move anything.
 * 2. **A round we cannot see is not a round without approvals.** Merging those
 *    two is a product that says "waiting for signatures" while the truth is
 *    "we have lost sight of the chain", and it is the failure that would be
 *    invisible in exactly the situation it matters.
 *
 * **These tests can only ever be as good as `SimulatedLedger`,** which runs in
 * this process. They do not show that a chain decided anything. They show that
 * this service asks, that it asks once, and that it has no path left by which
 * a local number can answer instead.
 *
 * ── WHAT THE REWRITE COULD NOT GET BACK. ──
 *
 * This file was moved out whole and its five tests went with it. The deletion
 * took things whose subject was never the account balance, which is the danger
 * in deleting a test: deleting one that was testing something else. Every test
 * below was survivable by dropping ONE `deposit` line, which is what
 * `fundedAccount` did and what `openAccountAt2of3` does instead.
 *
 * **WHAT DOES NOT COME BACK IS THE SECOND WITNESS.** Each test used to end by
 * calling `AccountService.execute` and reading its refusal — *"cannot tell
 * whether this round has reached its threshold"* against *"proposal is open,
 * not approved"*, two different sentences for two different situations.
 * `execute` was deleted, and that sentence now exists nowhere in `src/`. So
 * the distinction is asserted where it is still observable — on the
 * `approvalRound` the service records — and NOT at a refusal, because there is
 * no longer a call that refuses.
 *
 * **THE HONEST COST OF THAT, STATED RATHER THAN LEFT TO BE FOUND:** the outcome
 * is recorded correctly and nothing downstream is yet obliged to act on it.
 * `src/web/App.tsx` renders `p.approvals.length` against
 * `account.policy.threshold` — the two numbers removed from the decision — so a
 * company looking at a screen during a chain outage is still shown "1 of 2" and
 * an enabled Approve button. **That failure stands today at the screen layer,
 * and no test here can reach it.**
 */

/** Ada proposes and approves; Blake and Cleo approve. Threshold 2 of 3. */
const THREE = [
  { name: 'Ada', role: 'admin' as const },
  { name: 'Blake', role: 'approver' as const },
  { name: 'Cleo', role: 'approver' as const },
];

/**
 * A service over a `SimulatedLedger` whose `status()` can be bent.
 *
 * `bend` receives the real ledger and the account id and returns whatever the
 * caller wants `status()` to have answered. Everything else — `open`,
 * `propose`, `approve` — passes through untouched, which is the point: the
 * chain really does hold the approvals, and only our VIEW of it is broken. A
 * stub that also stopped accepting approvals would be testing a different,
 * easier thing.
 *
 * **DELIBERATELY NOT SHARED WITH THE NEAR-TWIN IN
 * `the-guards-cannot-strand-an-account.test.ts`,** which says the same of this
 * one at its own top. Both files are judged by the same deliberate defects,
 * and a shared fixture lets one suite's mutation quietly change the other's
 * setup.
 */
function harness(bend?: (inner: Ledger, accountId: string) => Promise<LedgerStatus | null>) {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-r4-')), 'db.json'));
  const inner: Ledger = new SimulatedLedger(SimulatedCommitments);
  const ledger: Ledger = bend
    ? (new Proxy(inner, {
        get(target, key, recv) {
          if (key === 'status') return (accountId: string) => bend(inner, accountId);
          const v = Reflect.get(target, key, recv);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }) as Ledger)
    : inner;
  const accounts = new AccountService(store, ledger, SimulatedCommitments);
  return { store, accounts };
}

/** Opens, edits and re-seals the way a key holder would. The store has no other door. */
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

const entry = (amount: bigint) => ({
  entries: [{
    id: 'e1', kind: 'transfer', asset: 'GBP', amount,
    counterparty: 'a supplier', memo: '', at: '',
  }],
});

/*
 * **IT WAS `fundedAccount` AND THE FUNDING IS GONE, NOT THE SUBJECT.**
 * It deposited 10,000.00 into the account's own book before returning.
 * No test in this file ever read that balance: the amounts below are what a
 * proposal SAYS it moves, and a proposal says that whether or not anything is
 * there. Renamed rather than left with a name that describes a deposit nobody
 * makes, because a stale helper name is read as a true description of it.
 */
async function openAccountAt2of3(h: ReturnType<typeof harness>) {
  return h.accounts.create('Acme', THREE, 2);
}

describe('a small payment is still a payment', () => {
  it('needs the full threshold at one penny, which is as small as it gets', async () => {
    const h = harness();
    const { account, viewingKey, secrets } = await openAccountAt2of3(h);

    const p = await h.accounts.propose({
      accountId: account.id, viewingKey, kind: 'transfer',
      summary: 'one penny', payload: entry(1n), proposedBy: secrets[0].signerId,
    });
    expect(p.status).toBe('open');

    const one = await h.accounts.approve(
      p.id, secrets[0].signerId, sign(approvalMessage(p), secrets[0].signingSecret), viewingKey);
    /*
     * The old rule made this `approved`. There is no amount that does that any
     * more, and the outcome names the ledger's two numbers rather than a
     * boolean, so a regression cannot hide behind a `true`.
     */
    expect(one.status).toBe('open');
    expect(one.approvalRound).toEqual({ state: 'short', approvals: 1, threshold: 2 });

    const two = await h.accounts.approve(
      p.id, secrets[1].signerId, sign(approvalMessage(p), secrets[1].signingSecret), viewingKey);
    expect(two.status).toBe('approved');
    expect(two.approvalRound).toEqual({ state: 'satisfied', approvals: 2, threshold: 2 });
  });

  it('ignores our own copy of the threshold when somebody lowers it', async () => {
    /*
     * **THE DIRECT TEST OF WHERE THE BAR COMES FROM.**
     *
     * `Policy.threshold` is what `evaluatePolicy` used to compare against, and
     * it is the field an operator could reach. The ledger was opened at 2 and
     * stays at 2; the sealed policy is edited to 1 by somebody holding the
     * viewing key. One approval must still not be enough — and the recorded
     * outcome must report `threshold: 2`, the ledger's, not the 1 sitting in
     * our own record.
     *
     * The `execute` refusal that closed this test is gone with the circuit.
     * What survives is stronger than it looks: `threshold: 2` in the outcome is
     * read straight off the ledger's status by `thresholdFor`, so a service
     * that had started answering from `account.policy` would report `1` here
     * and this line would fail.
     */
    const h = harness();
    const { account, viewingKey, secrets } = await openAccountAt2of3(h);
    editAccount(h, account.id, viewingKey, a => { a.policy.threshold = 1; });

    const p = await h.accounts.propose({
      accountId: account.id, viewingKey, kind: 'transfer',
      summary: 'a modest sum', payload: entry(50_00n), proposedBy: secrets[0].signerId,
    });
    const one = await h.accounts.approve(
      p.id, secrets[0].signerId, sign(approvalMessage(p), secrets[0].signingSecret), viewingKey);

    expect(one.status).toBe('open');
    expect(one.approvalRound).toEqual({ state: 'short', approvals: 1, threshold: 2 });

    /*
     * And the round still reaches `approved` at the LEDGER's two rather than at
     * our record's one, which is the half a lowered copy would have skipped.
     */
    const two = await h.accounts.approve(
      p.id, secrets[1].signerId, sign(approvalMessage(p), secrets[1].signingSecret), viewingKey);
    expect(two.status).toBe('approved');
    expect(two.approvalRound).toEqual({ state: 'satisfied', approvals: 2, threshold: 2 });
  });
});

describe('"we do not know" is not "not enough approvals"', () => {
  /** Drives a round to the ledger's full threshold. Returns the last proposal seen. */
  async function twoApprovals(h: ReturnType<typeof harness>) {
    const { account, viewingKey, secrets } = await openAccountAt2of3(h);
    const p = await h.accounts.propose({
      accountId: account.id, viewingKey, kind: 'transfer',
      summary: 'payroll', payload: entry(1_000_00n), proposedBy: secrets[0].signerId,
    });
    await h.accounts.approve(
      p.id, secrets[0].signerId, sign(approvalMessage(p), secrets[0].signingSecret), viewingKey);
    const last = await h.accounts.approve(
      p.id, secrets[1].signerId, sign(approvalMessage(p), secrets[1].signingSecret), viewingKey);
    return { viewingKey, proposal: last };
  }

  it('says so when the ledger reports no status at all', async () => {
    /*
     * The chain HAS both approvals here — the proxy bends only the read. So the
     * honest answer is not "one of two", it is "we cannot see it", and the
     * product must not round that down to a round still waiting for signatures.
     */
    const h = harness(async () => null);
    const { proposal } = await twoApprovals(h);

    expect(proposal.status).toBe('open');
    expect(proposal.approvalRound).toEqual({ state: 'unknown', why: 'no-status' });
    /* Two signatures held locally, and they still do not make the answer. */
    expect(proposal.approvals).toHaveLength(2);
  });

  it('says so when the ledger answers but does not carry the round', async () => {
    /*
     * The second way to lose sight of a round, and the one that looks like an
     * answer: the node replies, the reply is well formed, and this round is
     * simply not in it. Reading that as "no approvals" is the same lie told by
     * a node that is merely behind.
     */
    const h = harness(async (inner, accountId) => {
      const real = await inner.status(accountId);
      return real && { ...real, openProposals: [] };
    });
    const { proposal } = await twoApprovals(h);

    expect(proposal.status).toBe('open');
    expect(proposal.approvalRound).toEqual({ state: 'unknown', why: 'not-open' });
    expect(proposal.approvals).toHaveLength(2);
  });

  it('does NOT say so when the round is simply short, which is the whole point', async () => {
    /*
     * The negative half. Without this, a service that answered `unknown` to
     * everything would satisfy both tests above.
     *
     * It used to close on the two DIFFERENT refusal sentences `execute` gave —
     * *"cannot tell"* against *"proposal is open, not approved"*. There is no
     * `execute`, so the discrimination is made on the recorded outcome instead:
     * a short round names both of the ledger's numbers, and an unknown one
     * names neither and says which way it lost sight. A merge of the two cases
     * cannot produce both shapes.
     */
    const h = harness();
    const { account, viewingKey, secrets } = await openAccountAt2of3(h);
    const p = await h.accounts.propose({
      accountId: account.id, viewingKey, kind: 'transfer',
      summary: 'payroll', payload: entry(1_000_00n), proposedBy: secrets[0].signerId,
    });
    const one = await h.accounts.approve(
      p.id, secrets[0].signerId, sign(approvalMessage(p), secrets[0].signingSecret), viewingKey);

    expect(one.approvalRound).toEqual({ state: 'short', approvals: 1, threshold: 2 });
    expect(one.approvalRound).not.toHaveProperty('why');
  });
});

/**
 * **THE APPROVAL IS BURNT ON CHAIN BEFORE ANYTHING DURABLE
 * IS WRITTEN, AND A THROW IN BETWEEN LOSES IT.**
 *
 * This file already owns the case where the status read ANSWERS BADLY — `null`,
 * or without the round in it — and in both of those `approve` completes and
 * writes the record with `approvalRound` saying *we could not see*. **The case
 * it never had is the read THROWING**, and that is a different failure with a
 * different victim: `putProposal` is the only durable write in `approve` and it
 * is the last statement, so a rejection anywhere above it discards the approval
 * the chain has already burnt.
 *
 * **WHY THE SIGNER CANNOT SIMPLY TRY AGAIN, WHICH IS THE HALF THAT MAKES IT
 * PERMANENT.** The retry reads the durable record, finds no approval of theirs,
 * passes the guard, and calls `ledger.approve` a second time — where the chain
 * refuses on the nullifier it already holds
 * (`src/core/ledger.ts:1498`, *"you have already approved this proposal"*).
 * **That signer can never record their approval, and no amount of retrying
 * changes it.**
 *
 * **THE FIX IS A REORDER AND NOT A RETRY, AND BOTH HALVES ARE ASSERTED BELOW.**
 * The rule is stated two files over — *"an operation with two halves is one
 * transaction or it refuses"* (`src/core/ledger.ts:1511`) — and the two
 * halves here are *this signature counts* and *this round now stands at N of
 * M*. Only the second needs the chain read. So the first is written the instant
 * the burn returns, and the second is written after, and a throw between them
 * costs the standing rather than the approval.
 *
 * **AND THE STANDING IS RECOVERED RATHER THAN LOST**, by the one trigger that
 * is guaranteed to fire: the signer whose call threw is holding an error and
 * will retry, and their retry now finds their own approval on the record.
 * `approve` reconciles the standing before it refuses them. **That trigger only
 * exists BECAUSE of the reorder** — until the approval was durable, the retry
 * died at the chain and never reached a re-read. The two halves of this fix are
 * one mechanism, which is why they are one test file.
 */
describe('a burnt approval survives a throw between the chain and the record', () => {
  /**
   * A ledger whose `status` throws exactly once, on the call the test arms it
   * for, and works before and after.
   *
   * A throw and not a `null`: `null` is a chain that answered *I do not know*,
   * which this file's other cases already cover and which `approve` handles by
   * recording `unknown`. **A rejection is the node being unreachable, the
   * request timing out, or the provider throwing — the ordinary way a second
   * network call fails**, and it is the shape that reaches `putProposal` by not
   * reaching it.
   */
  function node() {
    const n = { down: false, reads: 0 };
    const bend = async (inner: Ledger, accountId: string) => {
      n.reads += 1;
      if (n.down) throw new Error('the node is unreachable');
      return inner.status(accountId);
    };
    return { n, bend };
  }

  /** Opens 2-of-3 and gets the FIRST approval in cleanly, chain and record. */
  async function oneApprovalIn(h: ReturnType<typeof harness>) {
    const { account, viewingKey, secrets } = await openAccountAt2of3(h);
    const p = await h.accounts.propose({
      accountId: account.id, viewingKey, kind: 'transfer',
      summary: 'payroll', payload: entry(1_000_00n), proposedBy: secrets[0].signerId,
    });
    await h.accounts.approve(
      p.id, secrets[0].signerId, sign(approvalMessage(p), secrets[0].signingSecret), viewingKey);
    return { account, viewingKey, secrets, p };
  }

  const stored = (h: ReturnType<typeof harness>, account: { id: string }, viewingKey: string, id: string) =>
    h.accounts.listProposals(account.id, viewingKey).find(x => x.id === id)!;

  it('keeps the approval when the status read throws, so the retry is not refused for ever', async () => {
    /*
     * The first half in one sequence. Blake's approval is burnt on chain;
     * the read after it throws; `approve` rejects. **The assertion that matters
     * is taken from the STORE afterwards** — a fresh read through
     * `listProposals`, not the object the call was working on, because an
     * in-memory mutation that never reached disk is precisely this defect.
     */
    const { n, bend } = node();
    const h = harness(bend);
    const { viewingKey, secrets, p, account } = await oneApprovalIn(h);

    n.down = true;
    await expect(h.accounts.approve(
      p.id, secrets[1].signerId, sign(approvalMessage(p), secrets[1].signingSecret), viewingKey,
    )).rejects.toThrow(/the node is unreachable/);

    const rec = stored(h, account, viewingKey, p.id);
    expect(rec.approvals.map(a => a.signerId)).toEqual([secrets[0].signerId, secrets[1].signerId]);
    /* The standing is what was lost, and it is honest about not knowing it. */
    expect(rec.status).toBe('open');
  });

  it('recovers the standing on the retry, and still refuses the second approval', async () => {
    /*
     * The second half. Blake retries with the node back. He is refused — he HAS
     * approved, and saying so is correct — **but the refusal is no longer the
     * end of the round.** The reconcile runs first and the record catches up to
     * the two approvals the chain has held all along.
     *
     * **THE MESSAGE IS ANCHORED, AND THE LOOSE FORM IS WHY.** An unanchored
     * `/already approved/` also matches the LEDGER's *"you have already
     * approved this proposal"* (`src/core/ledger.ts:1498`) — which is what the
     * pre-fix code threw, from the chain, having reached it precisely because
     * the record held nothing. So the loose form passed against the defect and
     * the assertion was decorative. `^…$` is what makes it the SERVICE's
     * refusal, reached from a record that now knows.
     */
    const { n, bend } = node();
    const h = harness(bend);
    const { viewingKey, secrets, p, account } = await oneApprovalIn(h);

    n.down = true;
    await expect(h.accounts.approve(
      p.id, secrets[1].signerId, sign(approvalMessage(p), secrets[1].signingSecret), viewingKey,
    )).rejects.toThrow(/the node is unreachable/);

    n.down = false;
    await expect(h.accounts.approve(
      p.id, secrets[1].signerId, sign(approvalMessage(p), secrets[1].signingSecret), viewingKey,
    )).rejects.toThrow(/^already approved$/);

    const rec = stored(h, account, viewingKey, p.id);
    expect(rec.status).toBe('approved');
    expect(rec.approvalRound).toEqual({ state: 'satisfied', approvals: 2, threshold: 2 });
  });

  it('does not swallow the throw when the node is still down on the retry', async () => {
    /*
     * **THE CLAIM THIS PINS IS ONE `approve` MAKES IN ITS OWN WORDS** — *"AND
     * IT DOES NOT SWALLOW A THROW. If the chain is still unreachable this
     * rejects, and the signer is told that rather than told they have already
     * approved"* — and nothing checked it until this case was written: a
     * `try { … } catch { }` around the reconcile left the whole file green.
     *
     * The earlier stub could not reach this at all: it cleared itself inside
     * the throw, so the retry's read always succeeded and **the reconcile's
     * read had never thrown in any test.** A held-down node is what the claim
     * needs.
     *
     * The signer must be told the node is down — the truthful fact, and the
     * ACTIONABLE one — rather than told they have already approved, which is
     * true, useless, and would leave them believing the round is recorded.
     */
    const { n, bend } = node();
    const h = harness(bend);
    const { viewingKey, secrets, p, account } = await oneApprovalIn(h);

    n.down = true;
    await expect(h.accounts.approve(
      p.id, secrets[1].signerId, sign(approvalMessage(p), secrets[1].signingSecret), viewingKey,
    )).rejects.toThrow(/the node is unreachable/);
    await expect(h.accounts.approve(
      p.id, secrets[1].signerId, sign(approvalMessage(p), secrets[1].signingSecret), viewingKey,
    )).rejects.toThrow(/the node is unreachable/);

    /* Still recoverable once the node returns — the round is not wedged. */
    n.down = false;
    await expect(h.accounts.approve(
      p.id, secrets[1].signerId, sign(approvalMessage(p), secrets[1].signingSecret), viewingKey,
    )).rejects.toThrow(/^already approved$/);
    expect(stored(h, account, viewingKey, p.id).status).toBe('approved');
  });

  it('does not reconcile a round that is no longer open, and reads the chain once per approval', async () => {
    /*
     * **THE GATE, BOTH CONJUNCTS, AND A READ COUNT IS WHAT MAKES THEM
     * VISIBLE.** The reconcile is gated on *this signer has already approved*
     * AND *the round still reads open*. Dropping the second conjunct was
     * measured to leave every test green, so nothing held it down — and a
     * reconcile that ran on every call would put a SECOND chain read into every
     * ordinary approval, which is the one-read rule broken quietly.
     *
     * Two approvals, satisfied, so the round is `approved` and not `open`.
     * Blake asks again: he is refused, and the chain is not asked.
     */
    const { n, bend } = node();
    const h = harness(bend);
    const { viewingKey, secrets, p, account } = await oneApprovalIn(h);

    await h.accounts.approve(
      p.id, secrets[1].signerId, sign(approvalMessage(p), secrets[1].signingSecret), viewingKey);
    expect(stored(h, account, viewingKey, p.id).status).toBe('approved');

    /* One read per approval and not one more. Two approvals have happened. */
    expect(n.reads).toBe(2);

    await expect(h.accounts.approve(
      p.id, secrets[1].signerId, sign(approvalMessage(p), secrets[1].signingSecret), viewingKey,
    )).rejects.toThrow(/^already approved$/);
    expect(n.reads).toBe(2);
  });

  it('does not reconcile for a signer who has not approved, and still records them', async () => {
    /*
     * The other conjunct. Cleo has approved nothing, so there is nothing of
     * hers to reconcile: the throw must reach her, and her approval must still
     * land on the record — which is the first case's property arriving through
     * a signer the gate must NOT fire for.
     */
    const { n, bend } = node();
    const h = harness(bend);
    const { viewingKey, secrets, p, account } = await oneApprovalIn(h);

    n.down = true;
    await expect(h.accounts.approve(
      p.id, secrets[2].signerId, sign(approvalMessage(p), secrets[2].signingSecret), viewingKey,
    )).rejects.toThrow(/the node is unreachable/);

    const rec = stored(h, account, viewingKey, p.id);
    expect(rec.approvals.map(a => a.signerId)).toEqual([secrets[0].signerId, secrets[2].signerId]);
    expect(rec.status).toBe('open');
  });
});


/**
 * **AND IT IS THE SHAPE ABOVE WITH THE HALVES THE OTHER WAY ROUND,
 * WHICH IS WHY IT LIVES BESIDE IT.**
 *
 * There the burn lands and the record does not: the chain half is
 * irrecoverable, so the write was moved up against it and a reconcile added
 * whose trigger is the retrying signer.
 *
 * **HERE THE IRRECOVERABLE HALF IS THE OTHER ONE.** A chain round can be raised
 * again for another fee; the record cannot be rebuilt by anybody, because the
 * salt is 32 bytes of fresh randomness held only in that call frame and the
 * payload is sealed under a key that arrived as an argument. So the write goes
 * FIRST, and what may be lost is the CONFIRMATION — which the chain can be
 * asked for, and which `approve` and `cancel` do ask for.
 *
 * **AND THAT RECONCILE COULD NOT HAVE BEEN COPIED**: its trigger is a signer
 * whose nullifier is burnt and who must therefore come back. A proposer who
 * lost the write need never come back, and if they do, `newProposalSalt()`
 * gives them a different id and a second live round.
 */
describe('the record is written before the chain call, so a lost round is never invisible', () => {
  /**
   * A service whose `propose` throws the FIRST time and passes through after
   * that, with a switch for whether the real call is made before the throw.
   *
   * **THE TWO SETTINGS ARE THE TWO REAL FAILURES AND THEY ARE NOT THE SAME
   * ONE.** `landed: false` is a node that refused — nothing on chain, no fee.
   * `landed: true` is a node that accepted and whose answer was lost — the
   * round IS live and this service does not know it. Only the chain can tell
   * them apart, which is exactly why the record cannot decide it locally.
   */
  function proposeThrowing(landed: boolean) {
    const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-c378-')), 'db.json'));
    const inner: Ledger = new SimulatedLedger(SimulatedCommitments);
    let armed = true;
    const ledger: Ledger = new Proxy(inner, {
      get(target, key, recv) {
        if (key === 'propose') {
          return async (...args: unknown[]) => {
            const call = () => (inner.propose as unknown as
              (...a: unknown[]) => Promise<unknown>)(...args);
            if (!armed) return call();
            armed = false;
            if (landed) await call();
            throw new Error('the node did not answer');
          };
        }
        const v = Reflect.get(target, key, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as Ledger;
    return { store, accounts: new AccountService(store, ledger, SimulatedCommitments) };
  }

  it('keeps the proposal when the chain call throws, and says the chain has not confirmed it', async () => {
    /*
     * **THIS IS THE ASSERTION THAT MATTERS.** The write used to come after the
     * call, so this rejection left *a proposal paid for, live on chain, and
     * with no durable record of any kind — the product cannot list it, approve
     * it or cancel it*. Delete the first `putProposal` in `AccountService.raise`
     * and `listProposals` below is empty again.
     */
    const h = proposeThrowing(false);
    const { account, viewingKey, secrets } = await h.accounts.create('Acme', THREE, 2);

    await expect(h.accounts.proposeVaultThresholdChange(
      account.id, viewingKey, 'a1'.repeat(32), 2, secrets[0].signerId,
    )).rejects.toThrow(/did not answer/);

    const kept = h.accounts.listProposals(account.id, viewingKey);
    expect(kept).toHaveLength(1);
    expect(kept[0].status).toBe('open');
    /* The half that keeps it honest: listed, and NOT claimed to be on chain. */
    expect(kept[0].raisedAt).toBeUndefined();
    expect((await h.accounts.ledgerStatus(account.id))!.openProposals).toEqual([]);
  });

  it('and that record can be cancelled, which is what "the product cannot cancel it" was', async () => {
    /*
     * `cancel` asks the chain first and finds nothing, so it does not call
     * `ledger.cancel` — which would refuse, leaving a record nothing could
     * clear. **The round the chain never held is closed at the only layer that
     * holds it.**
     */
    const h = proposeThrowing(false);
    const { account, viewingKey, secrets } = await h.accounts.create('Acme', THREE, 2);
    await expect(h.accounts.proposeVaultThresholdChange(
      account.id, viewingKey, 'a1'.repeat(32), 2, secrets[0].signerId,
    )).rejects.toThrow(/did not answer/);

    const [stranded] = h.accounts.listProposals(account.id, viewingKey);
    const gone = await h.accounts.cancel(stranded.id, viewingKey, secrets[0].signerId);
    expect(gone.status).toBe('cancelled');
  });

  it('CONFIRMS a round the chain did accept when the answer was lost, on the first approval', async () => {
    /*
     * **THE OTHER FAILURE, AND THE ONE A LOCAL DECISION WOULD GET WRONG.** The
     * round is live and unconfirmed. `approve` asks the chain, finds it in
     * `openProposals`, records that, and proceeds — so a lost answer costs a
     * read and nothing else.
     *
     * **THE TRIGGER IS GUARANTEED IN A WAY THE PROPOSER'S RETRY IS NOT**, which
     * is the whole argument for writing first: anybody who intends to USE an
     * unconfirmed round calls `approve` or `cancel`, and there is nothing else
     * that can be done with one.
     */
    const h = proposeThrowing(true);
    const { account, viewingKey, secrets } = await h.accounts.create('Acme', THREE, 2);
    await expect(h.accounts.proposeVaultThresholdChange(
      account.id, viewingKey, 'a1'.repeat(32), 2, secrets[0].signerId,
    )).rejects.toThrow(/did not answer/);

    const [live] = h.accounts.listProposals(account.id, viewingKey);
    expect(live.raisedAt).toBeUndefined();
    expect((await h.accounts.ledgerStatus(account.id))!.openProposals)
      .toEqual([expect.objectContaining({ id: live.chainId })]);

    const approved = await h.accounts.approve(
      live.id, secrets[0].signerId,
      sign(approvalMessage(live), secrets[0].signingSecret), viewingKey);
    expect(approved.raisedAt).toBeTruthy();
    expect(approved.approvals).toHaveLength(1);
  });

  it('REFUSES to cancel when the ledger did not answer, rather than clearing consent on a guess', async () => {
    /*
     * The first draft of `chainHolds` read `status?.openProposals` and returned
     * on a `null`. **`null` IS NOT ABSENCE.** `SimulatedLedger.status` answers
     * `null` for an account it does not hold — after a restart that is EVERY
     * account, and `src/wiring/selection.ts:144` is `SIMULATED` — and
     * `MidnightLedger.status` answers `null` when the address is unknown or the
     * indexer returns nothing.
     *
     * Read as absence, `cancel` took the local-only branch: the record became
     * `cancelled` and its `approvals` were CLEARED, while the chain went on
     * holding the round open with those approvals still counted. **A signer who
     * withdrew would have had no record anywhere that they had.** That injury
     * is reached by an operator action rather than by an attack, and it was a
     * state the old order could not produce — the earlier `cancel` called
     * `ledger.cancel` unconditionally and a chain that did not hold the round
     * refused, leaving the record open and retryable.
     *
     * The distinction this boundary already draws everywhere else: *it is not
     * there* and *we could not find out* are different facts.
     */
    const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-c378-silent-')), 'db.json'));
    const inner: Ledger = new SimulatedLedger(SimulatedCommitments);
    let armed = true;
    let silent = false;
    const ledger: Ledger = new Proxy(inner, {
      get(target, key, recv) {
        if (key === 'status') return async (id: string) => (silent ? null : inner.status(id));
        if (key === 'propose') {
          return async (...args: unknown[]) => {
            await (inner.propose as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
            if (!armed) return { ref: 'r', at: new Date().toISOString() };
            armed = false;
            throw new Error('the node did not answer');
          };
        }
        const v = Reflect.get(target, key, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as Ledger;
    const accounts = new AccountService(store, ledger, SimulatedCommitments);
    const { account, viewingKey, secrets } = await accounts.create('Acme', THREE, 2);

    /* A round that IS on chain and whose confirmation this record never got. */
    await expect(accounts.proposeVaultThresholdChange(
      account.id, viewingKey, 'a1'.repeat(32), 2, secrets[0].signerId,
    )).rejects.toThrow(/did not answer/);
    const [live] = accounts.listProposals(account.id, viewingKey);
    expect(live.raisedAt).toBeUndefined();
    expect((await inner.status(account.id))!.openProposals)
      .toEqual([expect.objectContaining({ id: live.chainId })]);

    /* Now the ledger will not say. The cancel must refuse, and change nothing. */
    silent = true;
    await expect(accounts.cancel(live.id, viewingKey, secrets[0].signerId))
      .rejects.toThrow(/ledger did not answer/);
    const after = accounts.listProposals(account.id, viewingKey).find(p => p.id === live.id)!;
    expect(after.status).toBe('open');

    /* And when it answers again, the same call goes through — so the refusal is
     * about the silence and not about the record. */
    silent = false;
    const gone = await accounts.cancel(live.id, viewingKey, secrets[0].signerId);
    expect(gone.status).toBe('cancelled');
    expect((await inner.status(account.id))!.openProposals).toEqual([]);
  });

  it('a round the chain never held does not displace the APPROVED round for the same change', async () => {
    /*
     * `approvedFor` sorted *newest first: a re-proposal after a failed attempt
     * is the live one*, and that sentence was TRUE precisely because a failed
     * attempt left no record. The new order inverts the premise. A governance
     * digest is a pure function of the change, so the phantom collides with the
     * genuinely approved round for the same change, carries a later
     * `createdAt`, and would be handed to the ledger — pointing an apply door at
     * an id no chain holds, with no screen able to say which row is which.
     *
     * **THIS PARAGRAPH NAMED TWO CALLERS, THE CASE BELOW DRIVES A THIRD, AND
     * THE COUNT IS CORRECTED HERE.** `approvedFor` has FOUR callers —
     * `grantAccess`, `setThreshold`, `setVaultThreshold` and `removeSigner` —
     * and every one is order-dependent. The two this paragraph named are the
     * two with NO product route today; the one it drives, `setVaultThreshold`,
     * has one; and `grantAccess`, which has two, was named by nothing and
     * driven by nothing. **The case beneath this one drives `grantAccess`.**
     *
     * Make `b.createdAt.localeCompare(a.createdAt)` the only sort key again and
     * this case goes red.
     */
    const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-c378-shadow-')), 'db.json'));
    const inner: Ledger = new SimulatedLedger(SimulatedCommitments);
    let refuse = false;
    const ledger: Ledger = new Proxy(inner, {
      get(target, key, recv) {
        if (key === 'propose') {
          return async (...args: unknown[]) => {
            if (refuse) throw new Error('the node did not answer');
            return (inner.propose as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
          };
        }
        const v = Reflect.get(target, key, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as Ledger;
    const accounts = new AccountService(store, ledger, SimulatedCommitments);
    const { account, viewingKey, secrets } = await accounts.create('Acme', THREE, 2);
    const VAULT = 'a1'.repeat(32);

    const real = await accounts.proposeVaultThresholdChange(
      account.id, viewingKey, VAULT, 2, secrets[0].signerId);
    for (const i of [0, 1]) {
      await accounts.approve(
        real.id, secrets[i].signerId,
        sign(approvalMessage(real), secrets[i].signingSecret), viewingKey);
    }
    expect(accounts.listProposals(account.id, viewingKey)
      .find(p => p.id === real.id)!.status).toBe('approved');

    /* The same change again, into a chain that will not take it. */
    refuse = true;
    await expect(accounts.proposeVaultThresholdChange(
      account.id, viewingKey, VAULT, 2, secrets[0].signerId,
    )).rejects.toThrow(/did not answer/);
    refuse = false;

    const both = accounts.listProposals(account.id, viewingKey)
      .filter(p => p.digest === real.digest);
    expect(both).toHaveLength(2);
    const phantom = both.find(p => p.id !== real.id)!;
    expect(phantom.raisedAt).toBeUndefined();
    expect(phantom.createdAt >= real.createdAt).toBe(true);

    /* The apply door must reach the APPROVED round, not the newer phantom. */
    await accounts.setVaultThreshold(account.id, viewingKey, VAULT, 2);
    expect((await accounts.ledgerStatus(account.id))!.vaultThresholds)
      .toEqual([{ vault: VAULT, threshold: 2 }]);
  });

  it('and `grantAccess` reaches the APPROVED round too, not the phantom', async () => {
    /*
     * **THE CALLER WITH TWO PRODUCT ROUTES, AND IT WAS THE ONE NOTHING DROVE.**
     * The case above drives `setVaultThreshold`; the description above
     * it named `setThreshold` and `removeSigner`. `grantAccess` is reachable
     * from `POST /api/accounts/:id/access` and from the standalone client, and
     * it takes `approvedFor(...).chainId` exactly as the other three do
     * (`src/core/account.ts`, `grantAccess`).
     *
     * **AND THE INJURY IS THE SHARPEST OF THE FOUR, WHICH IS WHY IT IS WORTH
     * ITS OWN CASE RATHER THAN A SENTENCE:** handed the phantom's id,
     * `addSigner` is asked to seat a person against a round the chain never
     * held, so the seat is refused and the person cannot be let in — while the
     * genuinely approved round sits in the same list, unusable, because nothing
     * on any screen distinguishes the two rows.
     *
     * The same phantom-collision harness as the case above, and the same
     * mutation makes it red: reduce the sort to `createdAt` alone.
     */
    const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-t332-grant-')), 'db.json'));
    const inner: Ledger = new SimulatedLedger(SimulatedCommitments);
    let refuse = false;
    const ledger: Ledger = new Proxy(inner, {
      get(target, key, recv) {
        if (key === 'propose') {
          return async (...args: unknown[]) => {
            if (refuse) throw new Error('the node did not answer');
            return (inner.propose as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
          };
        }
        const v = Reflect.get(target, key, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as Ledger;
    const accounts = new AccountService(store, ledger, SimulatedCommitments);
    const { account, viewingKey, secrets } = await accounts.create('Acme', THREE, 2);

    /* A fourth seat, invited and accepted but not yet granted: the subject. */
    const invite = accounts.inviteSigner(account.id, 'Dara', 'dara@acme.co', 'approver');
    const sk = newSigningKeypair(); const wk = newWrappingKeypair();
    const pending = accounts.acceptSignerInvite(
      invite.token, null, sk.publicKey, wk.publicKey, 'ab'.repeat(32));
    expect(pending.status).toBe('pending');

    const real = await accounts.proposeSigner(
      account.id, viewingKey, pending.id, secrets[0].signerId);
    for (const i of [0, 1]) {
      await accounts.approve(
        real.id, secrets[i].signerId,
        sign(approvalMessage(real), secrets[i].signingSecret), viewingKey);
    }
    expect(accounts.listProposals(account.id, viewingKey)
      .find(p => p.id === real.id)!.status).toBe('approved');

    /* The same addition again, into a chain that will not take it. */
    refuse = true;
    await expect(accounts.proposeSigner(
      account.id, viewingKey, pending.id, secrets[0].signerId,
    )).rejects.toThrow(/did not answer/);
    refuse = false;

    const both = accounts.listProposals(account.id, viewingKey)
      .filter(p => p.digest === real.digest);
    expect(both).toHaveLength(2);
    const phantom = both.find(p => p.id !== real.id)!;
    expect(phantom.raisedAt).toBeUndefined();
    expect(phantom.createdAt >= real.createdAt).toBe(true);

    /* THE POINT: the seat is granted, which it cannot be against the phantom. */
    const after = await accounts.grantAccess(account.id, viewingKey, pending.id);
    expect(after.signers.find(sg => sg.id === pending.id)!.status).toBe('active');
  });

  it('the ordinary path records the ledger\'s own reference and moment — the positive control', async () => {
    /*
     * Without this the three above would pass against a `raise` that never
     * confirmed anything, and `raisedAt` would be a field nothing ever sets.
     */
    const h = proposeThrowing(false);
    const { account, viewingKey, secrets } = await h.accounts.create('Acme', THREE, 2);
    await expect(h.accounts.proposeVaultThresholdChange(
      account.id, viewingKey, 'a1'.repeat(32), 2, secrets[0].signerId,
    )).rejects.toThrow(/did not answer/);

    const fine = await h.accounts.proposeVaultThresholdChange(
      account.id, viewingKey, 'b2'.repeat(32), 2, secrets[0].signerId);
    expect(fine.raisedAt).toBeTruthy();
    expect(fine.txRef).toBeTruthy();
    expect((await h.accounts.ledgerStatus(account.id))!.openProposals)
      .toEqual([expect.objectContaining({ id: fine.chainId })]);
  });
});
