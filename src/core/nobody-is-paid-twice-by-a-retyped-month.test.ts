/**
 * **A MONTH TYPED A SECOND WAY IS NOT A SECOND PAYROLL.**
 *
 * A payroll raise can fail after the network already holds the transaction, so
 * what a person is left holding is an error, and what a person holding an error
 * does is start it again by hand. Starting it again by hand means typing the
 * month again, and a month can be typed more than one way: `2026-08 ` with a
 * trailing space, `2026-8` without the leading zero. Neither is an attack.
 *
 * **EVERY GUARD IN THIS PRODUCT AGAINST PAYING SOMEBODY TWICE SELECTED THE RUNS
 * IT COMPARES AGAINST BY STRING EQUALITY ON THAT TYPING.** A retype was
 * therefore a different payroll to all of them: a second run was drawn for it,
 * raised beside the first, and because each run derives its own payment secrets
 * nothing on chain connected the two. Both settle. Everybody is paid twice.
 *
 * This file holds two things, and the second is the one that matters:
 *
 *   - a period is read as a MONTH at the point it enters, and a string that
 *     names no month is refused there rather than compared later
 *   - the refusal that stands between a restart and a second set of payments
 *     compares the MONTH two runs name, so it is reached whichever way either
 *     of them was typed
 *
 * **AND A CONTROL FOR THE SECOND, BECAUSE IT IS THE HALF THAT CAN BE OVERDONE.**
 * A payroll pays the same roster the same amounts every month, so the people
 * and the content of next month's run are identical to this one's, and the
 * month is the only thing that tells them apart. A guard that stopped asking
 * which month a run is for would refuse next month's payroll for everybody paid
 * in this one, which is worse than the hazard. The last case here is that run,
 * raised while this month's round is still live, and it is expected to go
 * through.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AccountService } from './account.js';
import { PayrollService, canonicalPeriod } from './payroll.js';
import { SimulatedLedger, SimulatedProofSystem } from './ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { runMaterialFor } from '../midnight/run-material.js';
import { vaultDetails } from '../testing/vault-details.js';
import { registryWithTestPrivateForms, aVaultHolding } from '../testing/assets.js';
import { FileStore } from './store-file.js';
import { toHex, type Hex } from './crypto.js';

const PAYROLL_VAULT = new Uint8Array(32).fill(0xa1);
const NOW = 1_800_000_000;
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);
const AUGUST = '2026-08';

/** A company with `people` on the roster, over a simulated chain. */
async function aCompany(people: number) {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-retype-')), 'db.json'));
  const ledger = new SimulatedLedger(MidnightCommitments);
  const registry = registryWithTestPrivateForms();
  const accounts = new AccountService(store, ledger, MidnightCommitments, registry, aVaultHolding());
  const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), registry);
  const created = await accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
  const viewingKey = created.viewingKey;
  for (let i = 0; i < people; i++) {
    payroll.hireDirect(created.account.id, {
      name: `Payee ${i}`, email: `p${i}@a.co`, title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
  }
  const account = created.account.id;
  const by = created.secrets[0]!.signerId;
  /** Material the way a product route builds it: from whatever the run's record says. */
  const materialFor = async (runId: string) => {
    const i = await payroll.runMaterialInputs(runId, viewingKey);
    return runMaterialFor({
      accountId: i.accountId, runId: i.runId, seeds: i.seeds, facts: i.facts,
      opensAt: OPENS, closesAt: CLOSES, vault: toHex(PAYROLL_VAULT), detailsOf: vaultDetails,
      ...(i.epoch !== undefined ? { epoch: i.epoch } : {}),
    });
  };
  const raise = async (runId: string) =>
    payroll.proposeRun(runId, viewingKey, by, await materialFor(runId));
  const openRounds = async () => (await ledger.status(account))!.openProposals.length;
  const specs = () => payroll.listPeople(account, viewingKey)
    .map(e => ({ name: e.name, asset: e.asset, amount: e.baseAmount }));
  return { store, accounts, payroll, ledger, viewingKey, account, by, raise, openRounds, specs };
}

describe('a period is a month, not the text somebody typed', () => {
  it('reads the same month out of every way a person types it', () => {
    /* RED WHEN the surrounding whitespace of a retyped month is compared rather
       than removed, which is the first of the two spellings that paid twice. */
    expect(canonicalPeriod('2026-08 ')).toBe(AUGUST);
    expect(canonicalPeriod(' 2026-08')).toBe(AUGUST);
    expect(canonicalPeriod('\t2026-08\n')).toBe(AUGUST);
    /* RED WHEN a month written without its leading zero is not read as that
       month, which is the second spelling that paid twice. */
    expect(canonicalPeriod('2026-8')).toBe(AUGUST);
    expect(canonicalPeriod(' 2026-8 ')).toBe(AUGUST);
    /* RED WHEN a month already written the one way is changed by being read. */
    expect(canonicalPeriod(AUGUST)).toBe(AUGUST);
    expect(canonicalPeriod('2026-12')).toBe('2026-12');
    expect(canonicalPeriod('2026-01')).toBe('2026-01');
    expect(canonicalPeriod('2026-1')).toBe('2026-01');
  });

  it('refuses a string that names no month, and the refusal says what to write', () => {
    /* RED WHEN a month number outside a year is taken, so that 2026-13 and
       2026-08 are two periods a person can hold runs under at once. */
    for (const notAMonth of ['2026-13', '2026-00', '2026-0', '2026-99']) {
      expect(() => canonicalPeriod(notAMonth)).toThrow(/does not name a pay period/);
    }
    /* RED WHEN anything that is not a year and a month is accepted, each of
       which would be a period of its own to every guard downstream. */
    for (const notAPeriod of ['', '   ', 'August 2026', '2026-08-01', '26-08', '2026', 'x',
      '2026/08', '02026-08', '2026-08x']) {
      expect(() => canonicalPeriod(notAPeriod)).toThrow(/does not name a pay period/);
    }
    /* RED WHEN the refusal stops naming the form that resolves it. A refusal a
       person cannot act on sends them back to retyping. */
    expect(() => canonicalPeriod('August 2026')).toThrow(/2026-08 is August 2026/);
    /* RED WHEN the refusal stops quoting what was actually sent, which is the
       only way a caller can see the space they cannot see. */
    expect(() => canonicalPeriod('Aug-2026')).toThrow(/"Aug-2026"/);
  });
});

describe('the doors: a payroll is not drawn up twice by retyping the month', () => {
  it('the roster door refuses the same month typed either other way', async () => {
    const c = await aCompany(3);
    const august = await c.payroll.createRunFromRoster(c.account, AUGUST, c.viewingKey);
    await c.raise(august.run.id);

    /* RED WHEN the draw-time guard compares the typing: each of these draws a
       second August payroll over the same three people, with its own payment
       secrets, and the account cannot connect the two. */
    await expect(c.payroll.createRunFromRoster(c.account, '2026-08 ', c.viewingKey))
      .rejects.toThrow(/a run for 2026-08 already exists/);
    await expect(c.payroll.createRunFromRoster(c.account, '2026-8', c.viewingKey))
      .rejects.toThrow(/a run for 2026-08 already exists/);
    /* RED WHEN a refusal leaves a second round open anyway. */
    expect(await c.openRounds()).toBe(1);
  });

  it('the ad hoc door refuses it too, and names the run to name back', async () => {
    const c = await aCompany(3);
    const august = await c.payroll.createRunFromRoster(c.account, AUGUST, c.viewingKey);
    await c.raise(august.run.id);

    /* RED WHEN the repeat check compares the typing. This is the one door that
       mints a fresh identifier for people who already have one for the month. */
    await expect(c.payroll.createRun(c.account, '2026-08 ', c.specs(), c.viewingKey))
      .rejects.toThrow(new RegExp(august.run.id));
    await expect(c.payroll.createRun(c.account, '2026-8', c.specs(), c.viewingKey))
      .rejects.toThrow(new RegExp(august.run.id));
  });

  it('the roster door refuses when it is the STORED run that carries the retyping', async () => {
    const c = await aCompany(3);
    /*
     * A run the store already holds under a retyped August. A record written
     * before a period had one spelling reads like this, and it is the record a
     * new draw has to be compared against, so reading only the incoming month
     * would leave exactly the pair this is here to catch.
     */
    const held = await c.payroll.createRunFromRoster(c.account, '2026-09', c.viewingKey);
    c.store.putRun({ ...c.store.getRun(held.run.id)!, period: '2026-08 ', status: 'proposed' });

    /* RED WHEN the draw-time guard takes the stored period as written. */
    await expect(c.payroll.createRunFromRoster(c.account, AUGUST, c.viewingKey))
      .rejects.toThrow(/a run for 2026-08 already exists/);
  });

  it('the ad hoc door refuses when it is the STORED run that carries the retyping', async () => {
    const c = await aCompany(3);
    const held = await c.payroll.createRunFromRoster(c.account, '2026-09', c.viewingKey);
    c.store.putRun({ ...c.store.getRun(held.run.id)!, period: '2026-8' });

    /* RED WHEN the repeat check takes the stored period as written. The run it
       names back is the one a person is told to raise again instead. */
    await expect(c.payroll.createRun(c.account, AUGUST, c.specs(), c.viewingKey))
      .rejects.toThrow(new RegExp(held.run.id));
  });

  it('and the run keeps the month, not the typing, so what is drawn next reads it', async () => {
    const c = await aCompany(2);
    const drawn = await c.payroll.createRunFromRoster(c.account, ' 2026-8 ', c.viewingKey);
    /* RED WHEN the typing is written onto the run. Every later comparison, and
       every screen that renders a month, reads this value. */
    expect(drawn.run.period).toBe(AUGUST);
    expect(c.store.getRun(drawn.run.id)!.period).toBe(AUGUST);

    /*
     * RED WHEN the month is read on the way in from the roster but not where
     * every run this product draws is actually built. The ad hoc door reaches
     * that point without passing the roster door at all, and a run stored under
     * a typing is a run every guard afterwards compares a typing against.
     */
    const other = await aCompany(2);
    const adHoc = await other.payroll.createRun(
      other.account, ' 2026-8 ', other.specs(), other.viewingKey);
    expect(adHoc.run.period).toBe(AUGUST);
    expect(other.store.getRun(adHoc.run.id)!.period).toBe(AUGUST);
  });

  it('refuses a draw for a month whose run is a draft with a round already raised for it',
    async () => {
      const c = await aCompany(3);
      const august = await c.payroll.createRunFromRoster(c.account, AUGUST, c.viewingKey);
      await c.raise(august.run.id);
      /*
       * The state a raise that threw after the network already had it leaves
       * behind: the run is a draft again, and a round for it stands. The
       * draw-time guard above passes over drafts, so this is the refusal that
       * is left, and the period it carries is a retyping.
       */
      c.store.putRun({ ...c.store.getRun(august.run.id)!, period: '2026-08 ', status: 'draft' });

      /* RED WHEN the refusal that reads the ROUNDS compares the typing. Drawing
         this payroll up again gives everybody on it new payment secrets, and
         the round already raised would pay them under the old ones. */
      await expect(c.payroll.createRunFromRoster(c.account, AUGUST, c.viewingKey))
        .rejects.toThrow(/a round has been raised for it/);
      expect(await c.openRounds()).toBe(1);
    });
});

describe('the raise: a run over people a live round already pays is refused', () => {
  it('refuses at the raise a draft that reached the store under a retyped month', async () => {
    const c = await aCompany(3);
    const august = await c.payroll.createRunFromRoster(c.account, AUGUST, c.viewingKey);
    /*
     * A run drawn for another month and moved onto a retyped August, so that no
     * door refused it when it was drawn. This is the shape the raise-time
     * refusal exists for, and the one a door alone cannot reach.
     */
    const moved = await c.payroll.createRunFromRoster(c.account, '2026-09', c.viewingKey);
    c.store.putRun({ ...c.store.getRun(moved.run.id)!, period: '2026-08 ' });
    await c.raise(august.run.id);

    /* RED WHEN the raise-time refusal selects the runs it compares against by
       the typing. Without it this second run is raised, both rounds stand over
       the same three people, and nothing on chain refuses either payment. */
    await expect(c.raise(moved.run.id))
      .rejects.toThrow(new RegExp(`run ${august.run.id} has already been raised`));
    /* RED WHEN the refusal leaves a second round open anyway. */
    expect(await c.openRounds()).toBe(1);
  });

  it('and refuses it for a month spelled without its zero', async () => {
    const c = await aCompany(3);
    const august = await c.payroll.createRunFromRoster(c.account, AUGUST, c.viewingKey);
    const moved = await c.payroll.createRunFromRoster(c.account, '2026-09', c.viewingKey);
    c.store.putRun({ ...c.store.getRun(moved.run.id)!, period: '2026-8' });
    await c.raise(august.run.id);

    /* RED WHEN the raise-time refusal reads only the incoming run's period and
       takes the stored one as written. Both sides are a typing here. */
    await expect(c.raise(moved.run.id))
      .rejects.toThrow(new RegExp(`run ${august.run.id} has already been raised`));
    expect(await c.openRounds()).toBe(1);
  });

  it('a stored period that names no month still matches itself', async () => {
    const c = await aCompany(3);
    const first = await c.payroll.createRunFromRoster(c.account, AUGUST, c.viewingKey);
    const second = await c.payroll.createRunFromRoster(c.account, '2026-09', c.viewingKey);
    /* Two runs a store holds under a period this product would not accept now. */
    c.store.putRun({ ...c.store.getRun(first.run.id)!, period: 'Q3' });
    c.store.putRun({ ...c.store.getRun(second.run.id)!, period: 'Q3' });
    await c.raise(first.run.id);

    /* RED WHEN a period that cannot be read as a month stops matching an equal
       one, which would let two records already in a store be raised over the
       same people without a word. */
    await expect(c.raise(second.run.id))
      .rejects.toThrow(new RegExp(`run ${first.run.id} has already been raised`));
    expect(await c.openRounds()).toBe(1);
  });

  it('and two stored periods that name no month are not each other', async () => {
    const c = await aCompany(3);
    const one = await c.payroll.createRunFromRoster(c.account, AUGUST, c.viewingKey);
    const other = await c.payroll.createRunFromRoster(c.account, '2026-09', c.viewingKey);
    c.store.putRun({ ...c.store.getRun(one.run.id)!, period: 'Q3' });
    c.store.putRun({ ...c.store.getRun(other.run.id)!, period: 'Q4' });
    await c.raise(one.run.id);

    /* RED WHEN a period that cannot be read as a month is treated as matching
       every other one that cannot either. That refuses nothing this product can
       pay for, and a guard that refuses ordinary payroll gets turned off. */
    await c.raise(other.run.id);
    expect(await c.openRounds()).toBe(2);
  });
});

describe('and the control: normal payroll is not what this refuses', () => {
  it('next month over the same people is raised while this month\'s round is still live',
    async () => {
      const c = await aCompany(3);
      const august = await c.payroll.createRunFromRoster(c.account, AUGUST, c.viewingKey);
      await c.raise(august.run.id);
      /*
       * The state that makes this case worth anything: August's round has been
       * raised and nothing has taken it out of the set the refusal compares
       * against. A run is raised and approved and stops, so that set only grows.
       */
      const rounds = c.accounts.payrollRoundsOf(c.account, c.viewingKey);
      expect(rounds.filter(r => r.runId === august.run.id && Boolean(r.raisedAt))).toHaveLength(1);

      const september = await c.payroll.createRunFromRoster(c.account, '2026-09', c.viewingKey);
      /*
       * RED WHEN the raise-time refusal stops asking which month a run is for
       * and compares only the people. These are the same three people and the
       * same amounts as August, because that is what a monthly payroll is, so
       * a people-only comparison refuses this and the company cannot pay
       * anybody again for as long as an August round stands.
       */
      await c.raise(september.run.id);
      expect(await c.openRounds()).toBe(2);
    });

  it('and a month typed the long way is the same month, not a way around the refusal', async () => {
    const c = await aCompany(3);
    const august = await c.payroll.createRunFromRoster(c.account, AUGUST, c.viewingKey);
    await c.raise(august.run.id);
    const september = await c.payroll.createRunFromRoster(c.account, '2026-9', c.viewingKey);
    /* RED WHEN reading a month changes which month it is: September typed
       without its zero must be September and not a second August. */
    expect(september.run.period).toBe('2026-09');
    await c.raise(september.run.id);
    expect(await c.openRounds()).toBe(2);
  });
});

describe('both builds hand the period to the same reader', () => {
  /*
   * **A TEXT CHECK, SAID PLAINLY AS ONE.** The served routes are exercised over
   * the wire elsewhere; the browser-only build has no exported handler and
   * nothing in this repository evaluates its entry point, so what it passes to
   * the service cannot be reached by running it. What is checked here is that
   * neither door hands the service a period it has not read, and it cannot see
   * a door that reads it and then passes something else.
   */
  const sourceOf = (path: string) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

  it('the served routes and the browser-only build both read the month first', () => {
    const served = sourceOf('../server/index.ts');
    const alone = sourceOf('../standalone/main.tsx');
    /*
     * Every mention of the period the request carried, and what stands
     * immediately in front of it. RED WHEN a door reads one of them somewhere
     * and hands another one straight on, which is the shape a second route
     * added later would have.
     */
    const unread = (src: string, field: string): string[] =>
      [...src.matchAll(new RegExp(`.{0,32}${field.replace('.', '\\.')}`, 'g'))]
        .map(m => m[0]).filter(m => !m.includes('canonicalPeriod('));
    expect(unread(served, 'b.period')).toEqual([]);
    expect(unread(alone, 'body.period')).toEqual([]);
    /* RED WHEN a door stops reading it at all, so that nothing above has
       anything to be true about: a door that never mentions the field passes
       the check above for the wrong reason. */
    expect(served.match(/canonicalPeriod\(/g)).toHaveLength(2);
    expect(alone.match(/canonicalPeriod\(/g)).toHaveLength(1);
    /* RED WHEN a door grows a second copy of the rule instead of calling the
       one the service enforces. */
    for (const src of [served, alone]) {
      expect(src).toMatch(/canonicalPeriod[^\n]*from '\.\.\/core\/payroll\.js'/);
    }
  });
});
