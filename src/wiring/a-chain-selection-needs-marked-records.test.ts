import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryStore } from '../core/store.js';
import { AccountService, openAccount, sealAccount, approvalMessage } from '../core/account.js';
import { PluginService } from '../core/plugins.js';
import { sign } from '../core/crypto.js';
import { openRecord } from '../core/sealed-records.js';
import type { Ledger } from '../core/ledger.js';
import { PayrollService, RecordingInviteDelivery } from '../core/payroll.js';
import { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } from '../core/ledger.js';
import {
  countProvenance, decideList, provenanceOf, refuseSelectionOver,
} from '../core/provenance.js';
import { wiring } from './selection.js';

/**
 * **A LEDGER MAY NOT BE SELECTED OVER RECORDS THAT DO NOT SAY WHO WROTE THEM.**
 *
 * ── WHY THIS FILE IS HERE AND NOT BESIDE THE RULES IT USES ───────────────
 *
 * Its subject is the SELECTION. `provenance.test.ts` drives the rules
 * themselves with values typed into it, which is the right way to pin a rule
 * and says nothing about what this product actually writes. **This file asks
 * the other question: does the thing that is really running produce records
 * the rule can work with?** That is a fact about the selector, so it lives
 * beside the selector, next to the check that no second place chooses an
 * implementation.
 *
 * ── AND IT IS WHAT REPLACES A SENTENCE IN A FAILURE MESSAGE ──────────────
 *
 * Until the page could load the contract's circuits, moving the selection to a
 * chain broke the page outright, and that accident was the only thing standing
 * between a one-line edit and a company being shown settled payroll that had
 * settled nothing. The page was fixed, correctly, and the accident went with
 * it; what was left was a warning written into the text of an unrelated
 * assertion. **A sentence a person reads only when something else fails is not
 * a control.**
 *
 * ── WHAT CHANGED WHEN THE SELECTION ACTUALLY MOVED ──────────────────────
 *
 * This file used to drive every case through whatever `wiring()` returned, on
 * the reasoning that **a selection whose ledger cannot write turns these red at
 * the write** - so it would refuse a chain selection without having to detect
 * one. That was the right design while the selection was a rehearsal and moving
 * it was the accident to guard against.
 *
 * **THE SELECTION HAS MOVED, DELIBERATELY, AND IT CANNOT WRITE.** The product
 * runs against a chain, every write above that ledger refuses by name because
 * no funded wallet is wired to this deployment, and a build that has resolved
 * no deployment cannot even construct one. So the old design would leave this
 * whole file permanently red - which is an alarm that has already gone off and
 * is now just noise over the thing it was protecting.
 *
 * ── SO THE FILE SPLITS ALONG WHAT EACH CASE IS ACTUALLY ABOUT ───────────
 *
 * **CASES ABOUT WHAT THE PRODUCT WRITES NAME THEIR OWN LEDGER OUT LOUD.** They
 * are about `AccountService` and `PayrollService` stamping a record from the
 * ledger that wrote it, and exercising that needs a ledger that CAN write. The
 * simulated one is the test double and this is what a test double is for; a
 * test naming the implementation it drives is the opposite of a hidden second
 * decision, and the check next door walks every non-test module to make sure
 * nothing outside a test does the same.
 *
 * **CASES ABOUT THE SELECTION STILL ASK THE SELECTOR.** Which word is running,
 * whether the selection would be refused over the records on disk, and whether
 * a company would be shown a mixture - none of those needs anything written.
 *
 * **AND ONE NEW CASE HOLDS WHAT THE OLD DESIGN WAS REALLY BUYING:** that the
 * running selection cannot produce an unmarked record, because it cannot
 * produce a record at all. That was implicit in a red file. It is asserted now.
 */

const NETWORK = 'undeployed' as const;

const SIGNERS = [
  { name: 'Ada', role: 'admin' as const },
  { name: 'Blake', role: 'approver' as const },
  { name: 'Cleo', role: 'approver' as const },
];

/**
 * **THE PRODUCT'S OWN WRITE PATHS, DRIVEN OVER THE TEST DOUBLE.**
 *
 * `AccountService` and `PayrollService` are the real ones - they are the
 * subject. The LEDGER is the double, named here rather than taken from the
 * selector, because the running selection cannot write and these cases are
 * about what a write records. **The pair is still built together**: the double's
 * ledger and the double's scheme, never one of each, for the same reason the
 * selector refuses to hand out one of three.
 */
const world = () => {
  const chosen = { name: 'simulated' as const, commitments: SimulatedCommitments };
  const store = new MemoryStore();
  const ledger: Ledger = new SimulatedLedger(chosen.commitments);
  const accounts = new AccountService(store, ledger, chosen.commitments);
  const payroll = new PayrollService(
    store, accounts, new SimulatedProofSystem(), undefined, NETWORK,
    new RecordingInviteDelivery(),
  );
  return { chosen, store, ledger, accounts, payroll };
};

/**
 * **THE SAME PRODUCT, HANDED A LEDGER THAT REPORTS A DIFFERENT WORD.**
 *
 * Without this every assertion of the form *the record carries what the ledger
 * reports* is two live reads of one constant, because exactly one wiring
 * exists: `wiring: 'simulated'` hard-coded into the write path would satisfy
 * all of them. The proxy changes the answer the ledger gives and nothing else,
 * so a write path that asks the ledger follows it and a write path that
 * restates a literal does not.
 *
 * It is a proxy over the real implementation rather than a stub of the
 * interface: a hand-written stub is a second thing to keep in step with the
 * boundary, and the first method somebody adds is one it does not have.
 */
const claiming = (inner: Ledger, word: 'simulated' | 'chain'): Ledger =>
  new Proxy(inner, {
    get(target, prop, recv) {
      if (prop === 'wiring') return word;
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Ledger;

describe('the selection and the ledger say the same word', () => {
  it('THE NAME ON THE SELECTION IS THE NAME THE LEDGER REPORTS FOR ITSELF', () => {
    /*
     * RED WHEN: the two literals drift - the selection is renamed without the
     * ledger, or a ledger is swapped into a set whose name still says the old
     * thing. Watched by renaming the selected set to 'chain'.
     *
     * It matters because a record is marked from the LEDGER and a company's
     * whole list is decided from the SELECTION. Two words for one fact means a
     * product that marks records one way and judges them another.
     */
    const chosen = wiring();
    /*
     * **THE RUNNING SELECTION CANNOT BUILD A LEDGER, SO THE PAIR IS CHECKED
     * WHERE IT IS ASSEMBLED INSTEAD.** `product.test.ts` holds that: the set
     * that reaches a chain is refused unless the word it stamps records with
     * and the word this build is selected as are the same. What is asserted
     * here is the half that is true wherever the selector is loaded.
     */
    expect(chosen.name).toBe('chain');
    expect(() => chosen.createLedger()).toThrow(/has not resolved a deployment/);
  });

  /**
   * **AND THE THING THE OLD DESIGN WAS BUYING, NOW SAID OUT LOUD.**
   *
   * This file used to guard the selection by going red at the write. It cannot
   * any more - the selection has moved and its ledger refuses - so the property
   * underneath is asserted directly: **the running product cannot produce an
   * unmarked record, because it cannot produce a record.**
   *
   * RED WHEN: a selection is made that can write without a deployment. That is
   * the state this whole file exists to refuse, and it is the state a rehearsal
   * ledger put back on the product path would create.
   */
  it('THE RUNNING SELECTION CANNOT WRITE A RECORD AT ALL, MARKED OR NOT', () => {
    expect(() => wiring().createLedger()).toThrow();
    expect(() => wiring().createProofSystem()).toThrow();
  });

  it('the word is one of the two this product can write down', () => {
    // RED WHEN: `name` widens back to a free string and a third spelling appears,
    // which every reader afterwards would classify as `unknown` for ever.
    expect(['simulated', 'chain']).toContain(wiring().name);
  });
});

describe('what the running product writes', () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => { w = world(); });

  it('A COMPANY IS MARKED BY THE LEDGER THAT OPENED IT, ON THE STORED RECORD', async () => {
    /*
     * RED WHEN: `create` stops stamping, or stamps from something other than
     * the ledger. Watched by deleting the `wiring:` line from the record
     * `create` builds.
     *
     * The stored record and not only the opened one: a company's list is
     * decided before any viewing key is supplied, so a marker that lives
     * inside the envelope is a marker the decision cannot read.
     */
    const made = await w.accounts.create('Acme', SIGNERS, 2);
    expect(w.store.getAccount(made.account.id)!.wiring).toBe(w.ledger.wiring);
  });

  it('AND THE MARKER SURVIVES A RE-SEAL, BECAUSE A DROPPED MARKER READS AS NOT KNOWN', async () => {
    /*
     * RED WHEN: `sealAccount` stops copying it. Watched by deleting the
     * `wiring:` line there.
     *
     * The record is rebuilt from an opened account on every roster edit, so a
     * field that is not carried is written once and silently gone by the next
     * write - and the loss is one-way, because nothing can establish
     * afterwards which ledger opened a company.
     *
     * The value is put back independently of the path under test rather than
     * compared against what that path last wrote: comparing two values the
     * same line produced agrees just as happily when the line writes nothing.
     */
    const made = await w.accounts.create('Acme', SIGNERS, 2);
    const stored = w.store.getAccount(made.account.id)!;
    w.store.putAccount({ ...stored, wiring: 'chain' });

    const reopened = openAccount(w.store.getAccount(made.account.id)!, made.viewingKey);
    const resealed = sealAccount(reopened, made.viewingKey, []);
    expect(resealed.wiring).toBe('chain');
  });

  it('A PAYROLL RUN CARRIES ITS OWN MARKER AND NOT ITS COMPANY\'S', async () => {
    /*
     * RED WHEN: `putRun` stops stamping, or reads the account's marker instead
     * of the ledger's. Watched both ways - deleting the line, and replacing it
     * with the account record's value.
     *
     * A company outlives a change of ledger and a run cannot: a run that was
     * never raised against a chain cannot be re-raised against one without
     * becoming a different run. So reading a company's marker in a run's place
     * would vouch for payslips on the strength of when the company was opened.
     */
    const made = await w.accounts.create('Acme', SIGNERS, 2);
    w.payroll.hireDirect(made.account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, made.viewingKey);

    /*
     * **THE COMPANY'S MARKER IS BLANKED BEFORE THE RUN IS DRAWN UP**, and that
     * ordering is the whole assertion. Blanking it afterwards proves nothing:
     * the run has already been written and nothing would rewrite it, so a
     * `putRun` that copied its company's marker would pass just as happily.
     * Blanked first, only a run that asks the LEDGER still carries a word.
     */
    w.store.putAccount({ ...w.store.getAccount(made.account.id)!, wiring: null });
    const { run } = await w.payroll.createRunFromRoster(made.account.id, '2026-08', made.viewingKey);

    expect(w.store.getAccount(made.account.id)!.wiring).toBeNull();
    expect(w.store.getRun(run.id)!.wiring).toBe(w.ledger.wiring);
  });

  it('the store records which ledgers have written to it, and only what it saw', async () => {
    /*
     * RED WHEN: the envelope is filled in from the running selection rather
     * than from the records that arrived - watched by stamping every write -
     * or when an unmarked write adds an entry, which would turn a silence into
     * a claim.
     */
    const made = await w.accounts.create('Acme', SIGNERS, 2);
    expect(w.store.snapshot().writtenBy).toEqual([w.ledger.wiring]);

    w.store.putAccount({ ...w.store.getAccount(made.account.id)!, id: 'acc_older', wiring: null });
    expect(w.store.snapshot().writtenBy).toEqual([w.ledger.wiring]);
  });

  it('AN EMPTY STORE CLAIMS NOTHING, WHICH IS WHAT A FILE WRITTEN BEFORE MARKING LOOKS LIKE', () => {
    // RED WHEN: the empty store is seeded with the running selection, which
    // would make every record in an old file read as this ledger's.
    expect(new MemoryStore().snapshot().writtenBy).toEqual([]);
  });
});

describe('the refusal a selection meets', () => {
  it('RECORDS THIS PRODUCT WRITES TODAY WOULD NOT REFUSE A CHAIN SELECTION', async () => {
    /*
     * **THIS IS THE GATE, AND IT IS THE REASON THE FILE IS NAMED WHAT IT IS.**
     *
     * RED WHEN: any write path on the product's own creation route stops
     * marking. It asks the question the day a selection moves, on the day
     * before: are the records this product is producing right now records a
     * chain selection could be pointed at?
     *
     * Watched red by deleting the `wiring:` line from either `create` or
     * `putRun` - each leaves an unrecorded record in an ordinary company and
     * this refuses on it.
     */
    const w = world();
    const made = await w.accounts.create('Acme', SIGNERS, 2);
    w.payroll.hireDirect(made.account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, made.viewingKey);
    await w.payroll.createRunFromRoster(made.account.id, '2026-08', made.viewingKey);

    const everything = [
      ...w.store.listAccounts(),
      ...w.store.listAccounts().flatMap(a => w.store.listProposals(a.id)),
      ...w.store.listAccounts().flatMap(a => w.store.listRuns(a.id)),
    ];
    expect(everything.length).toBeGreaterThan(1);
    expect(everything.every(r => provenanceOf(r) !== 'unknown')).toBe(true);
    expect(refuseSelectionOver('chain', countProvenance(everything))).toBeNull();
  });

  it('A SINGLE UNRECORDED RECORD REFUSES A CHAIN SELECTION, SO THE GATE ABOVE CAN FAIL', async () => {
    /*
     * The positive control. Without it the case above is satisfied by a store
     * that holds nothing, by a refusal that never fires, and by a counter that
     * counts nothing.
     *
     * RED WHEN: `refuseSelectionOver` stops firing on unrecorded records.
     */
    const w = world();
    const made = await w.accounts.create('Acme', SIGNERS, 2);
    w.store.putAccount({ ...w.store.getAccount(made.account.id)!, wiring: null });

    const counts = countProvenance(w.store.listAccounts());
    expect(counts.unknown).toBe(1);
    expect(refuseSelectionOver('chain', counts)).not.toBeNull();
  });

  it('AND A COMPANY IS NEVER SHOWN AN UNRECORDED RUN BESIDE A CHAIN\'S', async () => {
    /*
     * The property this whole path exists for, driven end to end through the
     * store the product writes rather than through typed literals.
     *
     * RED WHEN: the list rule stops refusing a mixture, or the store stops
     * carrying the markers the rule reads.
     */
    const w = world();
    const made = await w.accounts.create('Acme', SIGNERS, 2);
    w.payroll.hireDirect(made.account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, made.viewingKey);
    const { run } = await w.payroll.createRunFromRoster(made.account.id, '2026-08', made.viewingKey);

    /* One run this product wrote, and one beside it that says nothing about
     * itself - which is exactly the pair a store carried across a change of
     * ledger would hold. */
    w.store.putRun({ ...w.store.getRun(run.id)!, id: 'run_older', wiring: null });
    w.store.putRun({ ...w.store.getRun(run.id)!, id: 'run_onchain', wiring: 'chain' });

    const verdict = decideList(wiring().name, w.store.listRuns(made.account.id));
    expect(verdict.listed).toBe(false);
    if (verdict.listed) throw new Error('unreachable');
    expect(verdict.counts.chain).toBe(1);
    expect(verdict.counts.unknown).toBe(1);
  });
});

describe('the marker follows the ledger, not a literal in the write path', () => {
  /*
   * **WHY THIS BLOCK EXISTS AND WHAT IT COST NOT TO HAVE IT.** Every case
   * above compares a stored marker against `w.ledger.wiring`, and with one
   * wiring in existence both sides are the word `simulated`. Each of those
   * cases can watch a write path stop marking; none of them can watch a write
   * path stop asking. These can.
   */
  const worldClaiming = (word: 'simulated' | 'chain') => {
    /* The double again, and the proxy changes the word it reports and nothing else. */
    const store = new MemoryStore();
    const ledger = claiming(new SimulatedLedger(SimulatedCommitments), word);
    const accounts = new AccountService(store, ledger, SimulatedCommitments);
    const payroll = new PayrollService(
      store, accounts, new SimulatedProofSystem(), undefined, NETWORK,
      new RecordingInviteDelivery(),
    );
    return { store, accounts, payroll };
  };

  it('A COMPANY OPENED BY A LEDGER CALLING ITSELF A CHAIN IS MARKED AS A CHAIN\'S', async () => {
    // RED WHEN: `create` writes the word 'simulated' rather than asking the ledger.
    const w = worldClaiming('chain');
    const made = await w.accounts.create('Acme', SIGNERS, 2);
    expect(w.store.getAccount(made.account.id)!.wiring).toBe('chain');
    expect(w.store.snapshot().writtenBy).toEqual(['chain']);
  });

  it('and a run written under it is marked the same way, from the same source', async () => {
    // RED WHEN: `putRun` writes a literal, or reads the selection rather than the
    // ledger the service was actually handed.
    const w = worldClaiming('chain');
    const made = await w.accounts.create('Acme', SIGNERS, 2);
    w.payroll.hireDirect(made.account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, made.viewingKey);
    const { run } = await w.payroll.createRunFromRoster(made.account.id, '2026-08', made.viewingKey);
    expect(w.store.getRun(run.id)!.wiring).toBe('chain');
  });
});

describe('a record that says nothing goes on saying nothing', () => {
  /**
   * **THE FAILURE THIS BLOCK EXISTS FOR IS THE ONE THAT LOOKS LIKE A REPAIR.**
   *
   * A record already on disk with no marker is the state everything here is
   * built to preserve. Filling it in on the next ordinary write would be a
   * guess written into a durable store, and the reader afterwards cannot tell
   * it was one - and it would happen through ordinary use, one approval at a
   * time, until nothing was left unrecorded for the selection check to refuse.
   */
  it('AN UNMARKED ROUND IS NOT STAMPED BY THE LEDGER THAT APPROVES IT', async () => {
    /*
     * RED WHEN: `putProposal` falls back to the running ledger for a record
     * that already exists - `already?.wiring ?? this.ledger.wiring`, which is
     * what it said before the audit. Watched red on exactly that.
     */
    const w = world();
    const { account, viewingKey, secrets } = await w.accounts.create('Acme', SIGNERS, 2);
    const raised = await w.accounts.propose({
      accountId: account.id, viewingKey, kind: 'transfer', summary: 'x',
      payload: { entries: [{
        id: 'e1', kind: 'transfer', asset: 'GBP', amount: 10_00n,
        counterparty: 'y', memo: '', at: '',
      }] },
      proposedBy: secrets[0].signerId,
    });
    expect(w.store.getProposal(raised.id)!.wiring).toBe(w.ledger.wiring);

    /* The record as a store written before anything recorded a ledger holds it. */
    w.store.putProposal({ ...w.store.getProposal(raised.id)!, wiring: null });

    await w.accounts.approve(
      raised.id, secrets[0].signerId,
      sign(approvalMessage(raised), secrets[0].signingSecret), viewingKey,
    );

    expect(w.store.getProposal(raised.id)!.approvalCount).toBe(1);
    expect(w.store.getProposal(raised.id)!.wiring ?? null).toBeNull();
  });

  it('AND THE MARKER IS NEVER SEALED INSIDE THE ENVELOPE, WHERE THE DECISION CANNOT READ IT', async () => {
    /*
     * RED WHEN: **BOTH** strips are removed - the one that keeps the marker off
     * the opened record and the one that keeps it out of what gets sealed.
     * Measured: either alone leaves this green, and the pair turns it red.
     *
     * That is stated rather than tidied away, because it is the honest shape
     * of the defence: a marker can only reach the envelope by arriving on an
     * opened record AND surviving the seal, so two independent lines have to
     * fail together. **Whoever deletes one of them will see nothing go red**,
     * which is exactly why the sentence naming both is here.
     *
     * Two copies of one fact is two answers the day they differ - and the copy
     * the decision needs is the outside one, because that decision is taken
     * before any viewing key exists.
     */
    const w = world();
    const { account, viewingKey, secrets } = await w.accounts.create('Acme', SIGNERS, 2);
    const raised = await w.accounts.propose({
      accountId: account.id, viewingKey, kind: 'transfer', summary: 'x',
      payload: { entries: [{
        id: 'e1', kind: 'transfer', asset: 'GBP', amount: 10_00n,
        counterparty: 'y', memo: '', at: '',
      }] },
      proposedBy: secrets[0].signerId,
    });
    /*
     * **THE GOVERNANCE ROUND IS APPROVED FIRST, AND THAT STEP IS THE ASSERTION.**
     *
     * The write that raises a round builds its record from a fresh object that
     * never carried a marker, so nothing can leak into the envelope there
     * whatever the sealing line does. The write that could leak is the SECOND
     * one: an approval re-seals a record that was opened from disk, and an
     * opened record is where a marker would arrive from. A version of this
     * case that checked after the raise was green under both halves of the
     * defect removed at once, which is how it was found.
     */
    await w.accounts.approve(
      raised.id, secrets[0].signerId,
      sign(approvalMessage(raised), secrets[0].signingSecret), viewingKey,
    );

    const stored = w.store.getProposal(raised.id)!;
    expect(stored.approvalCount).toBe(1);
    expect(stored.wiring).toBe(w.ledger.wiring);

    /*
     * **OPENED AND LOOKED INSIDE, BECAUSE THE ENVELOPE IS CIPHERTEXT.** An
     * earlier version asserted the sealed body did not contain the text
     * `wiring`. It could not fail - the body is encrypted, so no field name is
     * in it whatever was sealed - and it was green for a reason unrelated to
     * what it claimed.
     */
    const inside = openRecord<Record<string, unknown>>(
      'proposals', account.id, stored.sealed, viewingKey);
    expect(Object.keys(inside)).not.toContain('wiring');
  });

  it('AN UNMARKED RUN IS NOT STAMPED BY THE NEXT WRITE EITHER', async () => {
    /*
     * RED WHEN: `putRun` falls back to the running ledger for a run that is
     * already on disk - the same defect as the case above, in the record
     * class the property is actually about.
     *
     * The write is driven through the private method rather than through
     * raising the run, and that is deliberate rather than a shortcut: raising
     * needs a vault and a settlement window, none of which this case is about,
     * and every one of them is a way for the case to fail for a reason that is
     * not the one it names. The neighbouring roster test reaches a record
     * state the same way and for the same reason.
     */
    const w = world();
    const made = await w.accounts.create('Acme', SIGNERS, 2);
    w.payroll.hireDirect(made.account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, made.viewingKey);
    const { run } = await w.payroll.createRunFromRoster(made.account.id, '2026-08', made.viewingKey);

    w.store.putRun({ ...w.store.getRun(run.id)!, wiring: null });
    const opened = w.payroll.requireRun(run.id, made.viewingKey);
    (w.payroll as unknown as {
      putRun: (r: unknown, k: string) => void;
    }).putRun(opened, made.viewingKey);

    expect(w.store.getRun(run.id)!.wiring ?? null).toBeNull();
  });

  it('REMOVING A SIGNER DOES NOT ERASE WHICH LEDGER RAISED EVERY ROUND', async () => {
    /*
     * RED WHEN: the proposals arm of `rotate` rebuilds a record field by field
     * without carrying the marker - which is what it did, and which no case in
     * this file reached until the audit found it.
     *
     * Removing a signer is an ordinary operation. It rewrites every proposal,
     * every run and the account under a new key, and the proposals arm is the
     * one that lists the fields it keeps instead of spreading the record. A
     * field not listed there is a field deleted, and this one cannot be
     * recovered by anything afterwards.
     */
    const w = world();
    const { account, viewingKey, secrets } = await w.accounts.create('Acme', SIGNERS, 2);
    await w.accounts.propose({
      accountId: account.id, viewingKey, kind: 'transfer', summary: 'x',
      payload: { entries: [{
        id: 'e1', kind: 'transfer', asset: 'GBP', amount: 10_00n,
        counterparty: 'y', memo: '', at: '',
      }] },
      proposedBy: secrets[0].signerId,
    });
    w.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
    await w.payroll.createRunFromRoster(account.id, '2026-08', viewingKey);

    const before = w.store.listProposals(account.id).map(p => p.wiring ?? null);
    expect(before).toEqual([w.ledger.wiring]);

    await w.accounts.rotate(account.id, viewingKey);

    expect(w.store.listProposals(account.id).map(p => p.wiring ?? null)).toEqual(before);
    expect(w.store.listRuns(account.id).every(r => r.wiring === w.ledger.wiring)).toBe(true);
    expect(w.store.getAccount(account.id)!.wiring).toBe(w.ledger.wiring);
  });

  it('AND ROTATION\'S OWN WRITES REACH THE STORE\'S RECORD OF WHO HAS WRITTEN HERE', async () => {
    /*
     * RED WHEN: `commitRotation` writes its four collections straight into the
     * data without observing them - which is what it did.
     *
     * It is the one write path that does not go through the three methods that
     * observe, so a ledger whose records pass only through a rotation would
     * leave no trace of having been here. **The case seeds a round carrying a
     * DIFFERENT ledger's word before rotating**, because a rotation of records
     * this store has already observed changes nothing and would be green
     * either way.
     */
    const w = world();
    const { account, viewingKey, secrets } = await w.accounts.create('Acme', SIGNERS, 2);
    const raised = await w.accounts.propose({
      accountId: account.id, viewingKey, kind: 'transfer', summary: 'x',
      payload: { entries: [{
        id: 'e1', kind: 'transfer', asset: 'GBP', amount: 10_00n,
        counterparty: 'y', memo: '', at: '',
      }] },
      proposedBy: secrets[0].signerId,
    });
    /* A record from the other ledger, as a store carried across a change holds it. */
    w.store.putProposal({ ...w.store.getProposal(raised.id)!, wiring: 'chain' });
    w.store.snapshot().writtenBy.length = 0;

    await w.accounts.rotate(account.id, viewingKey);

    expect(w.store.snapshot().writtenBy).toContain('chain');
  });
});

describe('the other doors a belief comes through', () => {
  it('A PLUG-IN\'S LIST OF RUNS CARRIES THE WORD AND REFUSES A MIXTURE', async () => {
    /*
     * RED WHEN: `readRuns` goes back to mapping the store rows straight out.
     * A company's bookkeeping reads this, `status` is the field that says a
     * run settled, and nothing here is looked at by a person.
     */
    const w = world();
    const plugins = new PluginService(w.store, w.accounts);
    const made = await w.accounts.create('Acme', SIGNERS, 2);
    w.payroll.hireDirect(made.account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, made.viewingKey);
    const { run } = await w.payroll.createRunFromRoster(made.account.id, '2026-08', made.viewingKey);

    const install = plugins.install({
      accountId: made.account.id, pluginId: 'moneygram-payout',
      scopes: ['runs:read'], allowance: null, installedBy: made.secrets[0].signerId,
    });
    expect(plugins.readRuns(install.token).map(r => r.provenance)).toEqual([w.ledger.wiring]);

    w.store.putRun({ ...w.store.getRun(run.id)!, id: 'run_onchain', wiring: 'chain' });
    expect(() => plugins.readRuns(install.token))
      .toThrow(/not all written against the same ledger/);
  });

  it('A PAYSLIP CARRIES THE WORD, BECAUSE A PAYSLIP IS A LIST OF ONE', async () => {
    /*
     * RED WHEN: `employeeView` stops carrying it.
     *
     * The rule that protects a company works by refusing a mixture, and a
     * payslip is one record - so that rule can never fire here, and the person
     * reading it has no second record, no other channel and no reason to doubt
     * a date. This is the strongest belief this product creates in anybody.
     */
    const w = world();
    const made = await w.accounts.create('Acme', SIGNERS, 2);
    const hired = w.payroll.hireDirect(made.account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, made.viewingKey);
    const { run } = await w.payroll.createRunFromRoster(made.account.id, '2026-08', made.viewingKey);

    const view = w.payroll.employeeView(
      run.id, hired.employee.id, hired.secret.wrappingSecret);
    expect(view.wiring).toBe(w.ledger.wiring);
  });
});
