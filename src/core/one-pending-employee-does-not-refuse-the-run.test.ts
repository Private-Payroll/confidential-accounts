/**
 * **ONE PENDING EMPLOYEE MUST NOT REFUSE THE WHOLE PAYROLL RUN.** Why should
 * an employee who has been sent an invite and is pending be able to freeze the
 * entire payroll?
 *
 * ── WHAT EACH ASSERTION HERE IS FOR ─────────────────────────────────────────
 *
 * Three things changed and each has to be able to fail on its own:
 *
 *   1  the pending set is computed over THE PEOPLE THE RUN IS TRYING TO PAY,
 *      behind the `employeeIds` filter rather than in front of it
 *   2  the refusal is a CONFIRMATION and its default is still REFUSE — it names
 *      who would be left out and which of the two things is wrong with each,
 *      and an admin may proceed only by naming them back
 *   3  the skip is RECORDED, through `run-skips.ts`, so somebody unpaid at the
 *      end of the month is a decision with a name on it rather than a gap
 *
 * **THE TWO THIS FILE WAS WRITTEN FOR ARE `6` AND `7` IN THE CORPUS OF
 * DELIBERATE DEFECTS** — the run helping itself to an acknowledgement nobody
 * gave, and the two pending reasons collapsing into one. Each `it` below cites
 * its corpus entry by NUMBER AND BY BINDING, because a number alone drifts
 * silently: the first draft of this file cited `1` and `2` for defects that
 * are `6` and `7`, and the mistake was caught. A run that silently drops
 * people while the suite stays green is the exact shape this project has paid
 * for before.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './store-file.js';
import { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } from './ledger.js';
import { AccountService } from './account.js';
import { PayrollService, RecordingInviteDelivery } from './payroll.js';
import { newWrappingKeypair } from './crypto.js';
import { payeeAddressFromKeys } from '../midnight/payee-address.js';
import { sealHandover, type SealedHandover } from './invite-handover.js';
import {
  registerFor, skippedIndices, skipReasonFor,
} from '../midnight/run-skips.js';
import type { DataStore } from './store.js';
import type { Hex } from './crypto.js';
import type { PayeeAddress } from '../midnight/payee-address.js';
import { registryWithTestPrivateForms } from '../testing/assets.js';

const THREE_SIGNERS = [
  { name: 'Ada', role: 'admin' as const },
  { name: 'Blake', role: 'approver' as const },
  { name: 'Cleo', role: 'approver' as const },
];

function harness() {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-s101-')), 'db.json'));
  const ledger = new SimulatedLedger(SimulatedCommitments);
  const proofs = new SimulatedProofSystem();
  const accounts = new AccountService(store, ledger, SimulatedCommitments);
  const invites = new RecordingInviteDelivery();
  /* GBP given a private token of its own, so a person can be hired in it. */
  const payroll = new PayrollService(
    store, accounts, proofs, registryWithTestPrivateForms(), 'undeployed', invites);
  return { store, accounts, payroll, invites };
}

/** The invitee's own device seals the handover; a test has to seal too. */
const handedOver = (
  h: { store: DataStore },
  token: string,
  parts: { wrappingPublicKey: Hex; address: PayeeAddress },
): SealedHandover => {
  const invite = h.store.getInvite(token);
  if (!invite) throw new Error(`no invite for ${token} — the test is wrong, not the code`);
  const account = h.store.getAccount(invite.accountId);
  if (!account) throw new Error('no account for that invite');
  return sealHandover(
    {
      wrappingPublicKey: parts.wrappingPublicKey,
      address: parts.address.bech32,
      confirmation: null,
    },
    account.inboxPublicKey);
};

const someAddress = (byte: string) => payeeAddressFromKeys(
  { coinPublicKey: byte.repeat(32), encryptionPublicKey: byte.repeat(32) }, 'undeployed');

describe('one pending employee does not refuse the whole run', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  /** Ada and Ben are payable; Nina has an open invitation; Otto has handed over. */
  const company = async () => {
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const ada = h.payroll.hireDirect(account.id, {
      name: 'Ada Paid', email: 'ada@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey).employee;
    const ben = h.payroll.hireDirect(account.id, {
      name: 'Ben Paid', email: 'ben@a.co', title: 'Eng', asset: 'GBP', baseAmount: 200_00n,
    }, viewingKey).employee;
    /* WAITING ON THEM: invited, nothing handed over, drop box empty. */
    const nina = h.payroll.invite(account.id, {
      name: 'Nina Nothing', email: 'nina@a.co', title: 'Eng', asset: 'GBP', baseAmount: 300_00n,
    }, viewingKey, 'usr_operator').employee;
    /* WAITING ON US: handed over, drop box full, nobody has admitted them. */
    const otto = h.payroll.invite(account.id, {
      name: 'Otto Over', email: 'otto@a.co', title: 'Eng', asset: 'GBP', baseAmount: 400_00n,
    }, viewingKey, 'usr_operator').employee;
    const token = h.invites.tokenFor('otto@a.co');
    h.payroll.acceptInvite(token, handedOver(h, token, {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: someAddress('41'),
    }));
    return { account, viewingKey, ada, ben, nina, otto };
  };

  const ack = (ids: string[], over: Partial<{ by: string; reason: string }> = {}) => ({
    employeeIds: ids, by: 'Ada (admin)', reason: 'they join next month', ...over,
  });

  /*
   * ── 1. THE CHECK IS BEHIND THE FILTER ─────────────────────────────────────
   *
   * RED IF: the pending set goes back to being computed over `all` instead of
   * over `asked`, or if the `employeeIds` filter moves back below it. Both are
   * the same defect and this is the assertion that names it.
   */
  it('PAYS FIVE PEOPLE AN ADMIN NAMED, THOUGH A SIXTH UNNAMED PERSON IS PENDING', async () => {
    const { account, viewingKey, ada, ben } = await company();

    const { run } = await h.payroll.createRunFromRoster(
      account.id, '2026-07', viewingKey, [ada.id, ben.id]);

    expect(run.employees.map(e => e.name).sort()).toEqual(['Ada Paid', 'Ben Paid']);
    /* NOTHING WAS SKIPPED, because nobody the run was drawn over was pending.
     * An empty register here would be a decision against nobody. */
    expect(run.skips).toBeUndefined();
  });

  /*
   * ── 2. THE DEFAULT REFUSES ────────────────────────────────────────────────
   *
   * RED IF: `if (!skipPending) throw` is deleted, or the acknowledgement is
   * defaulted to anything — corpus mutation **6**, THE DEFAULT IS REFUSE. Also
   * red under **1**, THE RUN NOTICES A PENDING PERSON AT ALL, which removes the
   * question rather than the answer.
   */
  it('REFUSES A RUN THAT WOULD LEAVE SOMEBODY OUT WHEN NOBODY HAS CONFIRMED IT', async () => {
    const { account, viewingKey } = await company();
    await expect(h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey))
      .rejects.toThrow(/payroll cannot run without leaving somebody out/);
  });

  /*
   * ── 3. THE TWO REASONS STAY TWO ───────────────────────────────────────────
   *
   * RED IF: the two groups are described in the same words — corpus mutation
   * **7**, THE TWO PENDING STATES STAY TWO IN THE REFUSAL. The record's half of
   * the same split is watched by the case further down and by corpus mutation
   * **4**; **either half can break while the other stays perfect**, which is
   * why there are two mutations and two assertions.
   */
  it('NAMES WHICH OF THE TWO THINGS IS WRONG WITH EACH PERSON, NEVER ONE WORD FOR BOTH', async () => {
    const { account, viewingKey } = await company();
    await expect(h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey))
      .rejects.toThrow(
        /Nina Nothing has not set up yet[\s\S]*Otto Over is waiting to be admitted by an admin/);
  });

  /*
   * ── 4. AND 5. THE ACKNOWLEDGEMENT IS ABOUT THESE PEOPLE ───────────────────
   *
   * RED IF: either name comparison is deleted — corpus mutations **3** (the
   * acknowledgement becomes a flag) and **5** (a confirmation is spent on a run
   * it was not given for). They are different failures: the first is somebody
   * dropped unread, the second is agreement about a payroll that is not this
   * one.
   */
  it('REFUSES AN ACKNOWLEDGEMENT THAT LEAVES ONE OF THE SKIPPED PEOPLE UNNAMED', async () => {
    const { account, viewingKey, nina } = await company();
    await expect(h.payroll.createRunFromRoster(
      account.id, '2026-07', viewingKey, undefined, ack([nina.id])))
      .rejects.toThrow(/this run would also leave out Otto Over/);
  });

  it('REFUSES AN ACKNOWLEDGEMENT NAMING SOMEBODY THIS RUN IS NOT LEAVING OUT', async () => {
    const { account, viewingKey, ada, nina, otto } = await company();
    await expect(h.payroll.createRunFromRoster(
      account.id, '2026-07', viewingKey, undefined, ack([nina.id, otto.id, ada.id])))
      .rejects.toThrow(/is not being left out by this run/);
  });

  /*
   * ── 6. AND 7. THE RUN GOES AHEAD, AND THE SKIP IS ON IT ───────────────────
   *
   * RED IF: the acknowledged path stops paying the rest, or the record stops
   * being written, or it stops surviving the seal, or the two pending states
   * collapse in the record — corpus mutation **4** — or the stored reason is
   * composed with anything, corpus mutation **8**.
   */
  it('PAYS EVERYBODY ELSE ONCE AN ADMIN CONFIRMS, AND WRITES DOWN WHO WAS LEFT OUT', async () => {
    const { account, viewingKey, nina, otto } = await company();

    const { run } = await h.payroll.createRunFromRoster(
      account.id, '2026-07', viewingKey, undefined, ack([nina.id, otto.id]));

    expect(run.employees.map(e => e.name).sort()).toEqual(['Ada Paid', 'Ben Paid']);

    /* READ BACK THROUGH THE STORE, so this is about the sealed record and not
     * about the object that was returned. */
    const reopened = h.payroll.requireRun(run.id, viewingKey);
    const skips = reopened.skips;
    if (!skips) throw new Error('the run recorded no skip at all');
    expect(skips.people.map(p => p.name)).toEqual(['Nina Nothing', 'Otto Over']);

    /*
     * **THROUGH `run-skips.ts`'s OWN READERS, NOT BY LOOKING AT THE FIELDS.**
     * A record only this test can read is not a record. `registerFor` is the
     * function a reporting caller has to get past, so it is the one asked here.
     */
    const register = registerFor(skips.decisions, run.id, skips.people.length);
    expect(skippedIndices(register)).toEqual([0, 1]);

    const forNina = skipReasonFor(register, 0);
    const forOtto = skipReasonFor(register, 1);
    expect(forNina?.by).toBe('Ada (admin)');
    expect(forOtto?.by).toBe('Ada (admin)');
    /*
     * **THE TWO REASONS ARE STILL TWO IN THE RECORD, AND THIS IS THE SECOND
     * PLACE THAT IS PINNED.** The refusal sentence is one; a mutation could
     * leave the sentence alone and collapse the record, and the report a person
     * reads a month later is the record.
     */
    expect(skips.people.map(p => p.waiting)).toEqual(['them', 'us']);

    /*
     * **THE REASON IS THE OPERATOR'S WORDS AND NOTHING ELSE, AND THAT IS LOAD
     * BEARING RATHER THAN TIDY.** An earlier draft composed the reason with
     * which of the two states applied — and the composition is never blank, so
     * `decide`'s refusal of a blank reason could not fire and the two
     * assertions below this one went green over a check that was not being
     * made. **The two facts are kept apart so that both can fail.**
     */
    expect(forNina?.reason).toBe('they join next month');
    expect(forOtto?.reason).toBe('they join next month');
  });

  /*
   * ── 8. AND 9. AN UNSIGNED SKIP PRODUCES NO PAYROLL ────────────────────────
   *
   * RED IF: `recordSkips` stops going through `decide`, or is called after the
   * run is stored. `run-skips.ts` owns both rules and neither is restated in
   * `payroll.ts`; these assertions are what says the call still reaches them.
   *
   * **AND EACH OF THESE IS TWO ASSERTIONS, WHICH IS WHY THE SECOND ONE IS
   * HERE.** `rejects.toThrow` says a refusal happened; `listRuns(...)` says
   * NOTHING WAS WRITTEN. Measured under corpus mutation `8`, which pads the
   * stored reason so `decide`'s blank-reason refusal can no longer fire: the
   * throw assertion and the no-run assertion both go red, because with the
   * guard silent the run is created. **I had predicted this case would go green
   * under that mutation and it does not** — the prediction is recorded in the
   * corpus entry, wrong, because the half of this case that survives a disabled
   * guard is the half that checks the store.
   */
  it('MAKES NO RUN AT ALL WHEN THE CONFIRMATION HAS NOBODY\'S NAME ON IT', async () => {
    const { account, viewingKey, nina, otto } = await company();
    await expect(h.payroll.createRunFromRoster(
      account.id, '2026-07', viewingKey, undefined, ack([nina.id, otto.id], { by: '  ' })))
      .rejects.toThrow(/attributable to somebody/);
    expect(h.store.listRuns(account.id)).toHaveLength(0);
  });

  it('AND NONE WHEN IT CARRIES NO REASON', async () => {
    const { account, viewingKey, nina, otto } = await company();
    await expect(h.payroll.createRunFromRoster(
      account.id, '2026-07', viewingKey, undefined, ack([nina.id, otto.id], { reason: '   ' })))
      .rejects.toThrow(/a blank reason is not a record/);
    expect(h.store.listRuns(account.id)).toHaveLength(0);
  });

  /*
   * ── 10. THE EMPTY RUN ─────────────────────────────────────────────────────
   */
  it('REFUSES WHEN CONFIRMING THE SKIPS WOULD LEAVE NOBODY TO PAY', async () => {
    const { account, viewingKey, nina, otto } = await company();
    await expect(h.payroll.createRunFromRoster(
      account.id, '2026-07', viewingKey, [nina.id, otto.id], ack([nina.id, otto.id])))
      .rejects.toThrow(/there is nobody left to pay/);
  });

  /*
   * ── 11. THE LIMIT THAT REMAINS, PINNED RATHER THAN DESCRIBED ──────────────
   *
   * The two registers are not joined, and this says so in a way that fails if
   * somebody quietly assumes otherwise. The run's register is indexed over
   * PEOPLE WITH NO LEAF and identified by the run's id; `runStatus`'s is
   * indexed over a leg's payout leaves and identified by the proposal id it
   * was raised under. **Handing one to the other is REFUSED and not misread**,
   * which is the property that makes leaving them unjoined safe.
   */
  it('IS REFUSED BY THE REPORTING READER RATHER THAN MISREAD AS A LEG\'S SKIPS', async () => {
    /*
     * **ONE PERSON SKIPPED AND TWO PAID, ON PURPOSE.**
     *
     * The first draft of this case skipped two and paid two, and that quietly
     * cost this case its point: `registerFor(decisions, run.id, 2)` then
     * RETURNS the register, because the count it compares happens to match. The
     * count guard was being exercised against the literal `5`, a number no
     * caller would ever pass, while the number a real leg-reporting caller
     * WOULD pass — `inputs.leaves.length` — was quietly accepted. **The
     * assertion looked like it covered the confusion in its own title and did
     * not.** Making the two counts differ is what turns it into a live refusal.
     */
    const { account, viewingKey, ada, ben, nina } = await company();
    const { run } = await h.payroll.createRunFromRoster(
      account.id, '2026-07', viewingKey, [ada.id, ben.id, nina.id], ack([nina.id]));
    const skips = h.payroll.requireRun(run.id, viewingKey).skips!;
    expect(run.employees).toHaveLength(2);
    expect(skips.people).toHaveLength(1);

    /*
     * **THE COUNT A REAL CALLER WOULD SUPPLY.** `runStatus` passes
     * `inputs.leaves.length` — one leaf per payee — so this is the number that
     * arrives, and it is not the number of people who were skipped.
     */
    expect(() => registerFor(skips.decisions, run.id, run.employees.length))
      .toThrow(/those skips are for a run of 1, and this run has 2/);

    /*
     * **AND THE IDENTITY, WHICH IS THE GUARD THAT HOLDS WHEN THE COUNTS DO
     * HAPPEN TO MATCH** — a run that pays two and skips two is an ordinary
     * shape, and then this comparison is the only thing standing between a
     * report and the wrong register. `registerFor` asks it first.
     */
    expect(() => registerFor(skips.decisions, 'prp_a_proposal_id', skips.people.length))
      .toThrow(/those skips are for run/);
  });
});
