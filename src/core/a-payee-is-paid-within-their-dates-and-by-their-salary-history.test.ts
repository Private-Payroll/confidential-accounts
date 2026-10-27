/**
 * A payee on either list is paid only for the days of a period that lie between their start date and their end or
 * leaving date, and a run pays an employee the salary line in force on the period's last day. A salary or
 * classification line may not take effect inside a month a run has already been raised for, and an end or leaving
 * date may not leave out a month that has. A record filed before the history was kept is read as one line.
 */
import { describe, it, expect } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { signJoinCode } from 'midnight-identity/profile/join-code';
import {
  classificationOn, daysOfPeriod, madeByRefusal, outsideTheirDates, payableDaysIn, payableDaysOrWhy, payLineFor, payLinesOf, periodsPastDraft,
  personChanged, personVersionsRefusal, whyNotPayable,
} from './person-record.js';
import { amountOnTheRun } from './run-drawing.js';
import { payeeFor } from '../testing/payees.js';
import { theNetwork } from '../midnight/network.js';
import type { RosterEmployee } from './types.js';

const LABEL = `co_${'a7'.repeat(32)}`;
const SLIP = 'cd'.repeat(32);
const ADDRESS = payeeFor('31'.repeat(32), theNetwork());
const CODE = signJoinCode(identityFromSecret(new Uint8Array(32).fill(31)), LABEL as never, 'emp_00000000000000000031',
  { kind: 'payee', address: ADDRESS.bech32, payslipKey: SLIP });
const SEAT = 'ab'.repeat(32);
const AT = '2026-10-20T09:00:00Z';

/** An employee whose record is payable at what their own wallet signed, hired on 3 Oct 2026. */
const person = (over: Partial<RosterEmployee> = {}): RosterEmployee => ({
  id: 'emp_00000000000000000031', accountId: 'acc_x', name: 'Payee 31', email: null, title: 'Engineer', asset: 'TEST' as never,
  baseAmount: 500000n, startDate: '2026-10-03', status: 'active', wrappingPublicKey: SLIP, handedOverBy: CODE.committeeKey.value,
  admittedBy: 'ada', admittedAt: AT, selfRaised: false, address: ADDRESS as never, payeeCode: CODE, ...over,
});

describe('A PERIOD\'S DAYS', () => {
  it('run from the first to the last calendar day of the month, leap years included', () => {
    expect(daysOfPeriod('2026-02')).toEqual({ first: '2026-02-01', last: '2026-02-28' });
    expect(daysOfPeriod('2028-2')).toEqual({ first: '2028-02-01', last: '2028-02-29' });
    expect(daysOfPeriod('2026-12')).toEqual({ first: '2026-12-01', last: '2026-12-31' });
  });
});

describe('THE DAYS OF A PERIOD A PAYEE IS PAYABLE FOR', () => {
  it('are the whole month for somebody employed all of it', () => {
    expect(payableDaysIn({ startDate: '2026-01-15' }, '2026-11')).toEqual({ first: '2026-11-01', last: '2026-11-30' });
  });

  it('start on their start date in the month they start, and stop on the earlier of their end and leaving dates', () => {
    /* RED WHEN: the month a person starts in is paid from its first day, or not at all. */
    expect(payableDaysIn({ startDate: '2026-10-03' }, '2026-10')).toEqual({ first: '2026-10-03', last: '2026-10-31' });
    /* RED WHEN: the later of an end and a leaving date is the one paid to. */
    expect(payableDaysIn({ startDate: '2026-01-01', endDate: '2026-12-20', leavingDate: '2026-12-10' }, '2026-12'))
      .toEqual({ first: '2026-12-01', last: '2026-12-10' });
    expect(payableDaysIn({ startDate: '2026-12-05', endDate: '2026-12-05' }, '2026-12')).toEqual({ first: '2026-12-05', last: '2026-12-05' });
  });

  it('are none before the start date or after the end or leaving date', () => {
    /* RED WHEN: a person is payable for a month that ends before they start. */
    expect(payableDaysIn({ startDate: '2026-11-01' }, '2026-10')).toBeNull();
    /* RED WHEN: a person is payable for a month that starts after they leave. */
    expect(payableDaysIn({ startDate: '2026-01-01', leavingDate: '2026-09-30' }, '2026-10')).toBeNull();
    expect(payableDaysIn({ startDate: '2026-01-01', endDate: '2026-09-30' }, '2026-10')).toBeNull();
  });

  it('are refused for a record whose dates are not calendar dates, or which ends before it starts', () => {
    expect(() => payableDaysIn({ startDate: '2026-10' }, '2026-10')).toThrow(/start date is not a calendar date/u);
    expect(() => payableDaysIn({ startDate: '2026-10-01', leavingDate: '2026-09-01' }, '2026-10')).toThrow(/leaving date is before their start date/u);
  });
});

describe('THE ONE PAYABLE CHECK, DATED BY THE PERIOD', () => {
  it('says why somebody is outside their dates, and nothing for somebody inside them', () => {
    expect(outsideTheirDates({ startDate: '2026-11-04' }, '2026-10')).toMatch(/start on 2026-11-04, after 2026-10/u);
    expect(outsideTheirDates({ startDate: '2026-01-01', leavingDate: '2026-09-15' }, '2026-10')).toMatch(/leaving date is 2026-09-15, before 2026-10/u);
    expect(outsideTheirDates({ startDate: '2026-01-01', endDate: '2026-09-15' }, '2026-10')).toMatch(/end date is 2026-09-15, before 2026-10/u);
    expect(outsideTheirDates({ startDate: '2026-10-31' }, '2026-10')).toBeNull();
    /* RED WHEN: the days a payee is payable for are given without why there are none. */
    expect(payableDaysOrWhy({ startDate: '2026-10-31' }, '2026-10')).toEqual({ days: { first: '2026-10-31', last: '2026-10-31' } });
    expect(payableDaysOrWhy({ startDate: '2026-11-04' }, '2026-10')).toEqual({ days: null, why: 'they start on 2026-11-04, after 2026-10' });
    expect(payableDaysOrWhy({ startDate: '2026-1-4' }, '2026-10')).toEqual({ days: null, why: 'their record\'s start date is not a calendar date' });
  });

  it('refuses a payable person for a period outside their dates, and only when asked about a period', () => {
    expect(whyNotPayable(person(), LABEL)).toBeNull();
    expect(whyNotPayable(person(), LABEL, '2026-10')).toBeNull();
    /* RED WHEN: the payable check takes no account of the period's dates. */
    expect(whyNotPayable(person(), LABEL, '2026-09')).toMatch(/after 2026-09/u);
    expect(whyNotPayable(person({ leavingDate: '2026-10-31' }), LABEL, '2026-11')).toMatch(/before 2026-11/u);
  });
});

describe('THE SALARY HISTORY', () => {
  it('reads a record filed before it was kept as one line: its pay from its start date', () => {
    const old = person();
    expect(payLinesOf(old)).toEqual([{ amount: 500000n, from: '2026-10-03', madeBy: null, madeAt: null }]);
    expect(amountOnTheRun(old, '2026-10')).toBe(500000n);
  });

  it('pays each period the line whose from-date is the latest on or before the period\'s last day', () => {
    const p = person({
      pay: [
        { amount: 500000n, from: '2026-10-03', madeBy: SEAT, madeAt: AT },
        { amount: 600000n, from: '2026-12-15', madeBy: SEAT, madeAt: AT },
        { amount: 700000n, from: '2027-02-01', madeBy: SEAT, madeAt: AT },
      ],
    });
    expect(amountOnTheRun(p, '2026-11')).toBe(500000n);
    /* RED WHEN: a line taking effect inside a month is not the one that month is paid. */
    expect(amountOnTheRun(p, '2026-12')).toBe(600000n);
    expect(amountOnTheRun(p, '2027-01')).toBe(600000n);
    /* RED WHEN: a run pays the hire amount after the salary changed. */
    expect(amountOnTheRun(p, '2027-02')).toBe(700000n);
    expect(payLineFor(p, '2027-03')!.amount).toBe(700000n);
  });

  it('pays a line added later for the same day over the one before it', () => {
    const p = person({ pay: [{ amount: 500000n, from: '2026-11-01', madeBy: SEAT, madeAt: AT }, { amount: 510000n, from: '2026-11-01', madeBy: SEAT, madeAt: AT }] });
    expect(amountOnTheRun(p, '2026-11')).toBe(510000n);
  });

  it('refuses a run for a period before any line takes effect', () => {
    expect(() => amountOnTheRun(person({ pay: [{ amount: 1n, from: '2026-12-01', madeBy: SEAT, madeAt: AT }] }), '2026-11')).toThrow(/no salary in force/u);
  });

  it('reads the classification in force on a day', () => {
    const p = person({ classifications: [
      { classification: 'full-time', from: '2026-10-03', madeBy: SEAT, madeAt: AT },
      { classification: 'part-time', from: '2027-01-01', madeBy: SEAT, madeAt: AT },
    ] });
    expect(classificationOn(p, '2026-10-02')).toBeNull();
    expect(classificationOn(p, '2026-12-31')).toBe('full-time');
    expect(classificationOn(p, '2027-01-01')).toBe('part-time');
  });
});

describe('A CHANGE TO A PERSON', () => {
  const pastDraft = periodsPastDraft([
    { period: '2026-10', status: 'settled' }, { period: '2026-11', status: 'proposed' }, { period: '2026-12', status: 'draft' },
  ]);
  const stamp = { madeBy: SEAT, madeAt: AT };

  it('counts only the months whose runs went past draft', () => {
    expect(pastDraft).toEqual(['2026-10', '2026-11']);
  });

  it('adds a salary line from the month after the latest raised one, signed and dated', () => {
    const next = personChanged(person(), { pay: { amount: 650000n, from: '2026-12-01' } }, pastDraft, stamp);
    expect(payLinesOf(next)).toEqual([
      { amount: 500000n, from: '2026-10-03', madeBy: null, madeAt: null },
      { amount: 650000n, from: '2026-12-01', madeBy: SEAT, madeAt: AT },
    ]);
    expect(next.baseAmount).toBe(500000n);
    expect(next).toMatchObject({ madeBy: SEAT, madeAt: AT });
  });

  it('RED WHEN: a salary or classification line takes effect inside a month a run has been raised for', () => {
    expect(() => personChanged(person(), { pay: { amount: 650000n, from: '2026-11-30' } }, pastDraft, stamp)).toThrow(/2026-12-01 or later/u);
    expect(() => personChanged(person(), { classification: { classification: 'part-time', from: '2026-11-01' } }, pastDraft, stamp))
      .toThrow(/2026-12-01 or later/u);
    expect(personChanged(person(), { classification: { classification: 'part-time', from: '2026-12-01' } }, pastDraft, stamp).classifications)
      .toEqual([{ classification: 'part-time', from: '2026-12-01', madeBy: SEAT, madeAt: AT }]);
  });

  it('lets a leaving date fall inside the latest raised month, and refuses one that leaves it out', () => {
    expect(personChanged(person(), { leavingDate: '2026-11-15' }, pastDraft, stamp).leavingDate).toBe('2026-11-15');
    /* RED WHEN: a leaving date leaves out a month a run has already been raised for. */
    expect(() => personChanged(person(), { leavingDate: '2026-10-31' }, pastDraft, stamp)).toThrow(/2026-11/u);
    expect(() => personChanged(person(), { endDate: '2026-10-31' }, pastDraft, stamp)).toThrow(/2026-11/u);
    /* Taking an end date away leaves nobody out. */
    expect(personChanged(person({ endDate: '2026-12-31' }), { endDate: null }, pastDraft, stamp).endDate).toBeNull();
  });

  it('refuses a date that is not a calendar date, a leaving date before the start, and a salary of nothing', () => {
    expect(() => personChanged(person(), { leavingDate: '2027-1-1' }, [], stamp)).toThrow(/calendar date/u);
    expect(() => personChanged(person(), { leavingDate: '2026-10-01' }, [], stamp)).toThrow(/before their start date/u);
    expect(() => personChanged(person(), { pay: { amount: 0n, from: '2027-01-01' } }, [], stamp)).toThrow(/above nothing/u);
    expect(() => personChanged(person(), {}, [], stamp)).toThrow(/changes nothing/u);
  });

  it('is believed only when the signer the version names is the seat that filed it', () => {
    /* RED WHEN: a version that names no maker and no moment is believed. */
    expect(madeByRefusal(person(), SEAT)).toMatch(/does not name the seat that made it/u);
    expect(madeByRefusal(person({ madeBy: SEAT }), SEAT)).toMatch(/UTC moment/u);
    expect(madeByRefusal(person({ madeBy: SEAT, madeAt: AT }), SEAT)).toBeNull();
    /* RED WHEN: a version naming one signer and filed by another is believed. */
    expect(madeByRefusal(person({ madeBy: SEAT, madeAt: AT }), 'ef'.repeat(32))).toMatch(/not the seat that filed it/u);
    expect(madeByRefusal(person({ madeBy: SEAT, madeAt: '2026-10-20 09:00' }), SEAT)).toMatch(/UTC moment/u);
  });
});

describe('A PERSON\'S HISTORY ACROSS THEIR VERSIONS', () => {
  const OTHER_SEAT = 'ef'.repeat(32);
  const v1 = person({ pay: [{ amount: 500000n, from: '2026-10-03', madeBy: SEAT, madeAt: AT }], madeBy: SEAT, madeAt: AT });
  const later = '2026-11-02T09:00:00Z';
  const v2 = personChanged(v1, { pay: { amount: 600000n, from: '2027-01-01' } }, [], { madeBy: SEAT, madeAt: later });

  it('is believed when each version only adds lines, each made by that version\'s filer at its moment', () => {
    expect(personVersionsRefusal([{ person: v1, filer: SEAT }, { person: v2, filer: SEAT }])).toBeNull();
    /* A record from before the history was kept, then its first change. */
    const old = person({ madeBy: SEAT, madeAt: AT });
    const changed = personChanged(old, { pay: { amount: 1n, from: '2027-01-01' } }, [], { madeBy: SEAT, madeAt: later });
    expect(personVersionsRefusal([{ person: old, filer: SEAT }, { person: changed, filer: SEAT }])).toBeNull();
  });

  it('RED WHEN: a version rewrites, drops or reorders an earlier salary or classification line', () => {
    const rewritten = { ...v2, pay: [{ ...v2.pay![0]!, amount: 900000n }, v2.pay![1]!] };
    expect(personVersionsRefusal([{ person: v1, filer: SEAT }, { person: rewritten, filer: SEAT }])).toMatch(/version 2 .* earlier salary lines/u);
    expect(personVersionsRefusal([{ person: v1, filer: SEAT }, { person: { ...v2, pay: [v2.pay![1]!] }, filer: SEAT }])).toMatch(/earlier salary lines/u);
    const withClass = { ...v1, classifications: [{ classification: 'full-time' as const, from: '2026-10-03', madeBy: SEAT, madeAt: AT }] };
    expect(personVersionsRefusal([{ person: withClass, filer: SEAT }, { person: { ...v2, classifications: [] }, filer: SEAT }])).toMatch(/earlier classification lines/u);
  });

  it('RED WHEN: a new line names another signer or another moment than the version that adds it', () => {
    const forged = { ...v2, pay: [v2.pay![0]!, { ...v2.pay![1]!, madeBy: OTHER_SEAT }] };
    expect(personVersionsRefusal([{ person: v1, filer: SEAT }, { person: forged, filer: SEAT }])).toMatch(/line it adds names another signer or moment/u);
    const backdated = { ...v2, pay: [v2.pay![0]!, { ...v2.pay![1]!, madeAt: '2020-01-01T00:00:00Z' }] };
    expect(personVersionsRefusal([{ person: v1, filer: SEAT }, { person: backdated, filer: SEAT }])).toMatch(/line it adds names another signer or moment/u);
  });

  it('RED WHEN: a version changes the start date or the amount they were hired at', () => {
    expect(personVersionsRefusal([{ person: v1, filer: SEAT }, { person: { ...v2, startDate: '2026-09-01' }, filer: SEAT }])).toMatch(/start date or the amount they were hired at/u);
    expect(personVersionsRefusal([{ person: v1, filer: SEAT }, { person: { ...v2, baseAmount: 1n }, filer: SEAT }])).toMatch(/start date or the amount they were hired at/u);
  });
});
