// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { SEED_ASSETS } from '../../../../src/core/assets.js';
import { ACT_REFUSAL } from './refusals.js';
import { TERMS } from './invite.js';

/*
 * THE PEOPLE PAGE'S WALLET ACTS: what is asked of the wallet to admit a person and to change one, what the page checks before it
 * asks, and what the wallet's stops come to in the page's codes.
 */
const kr = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null, acts: [] as Record<string, string>[], ended: { of: 'done', steps: 1, relayed: 0 } as unknown,
  named: { companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) } as unknown, calls: 0, throws: null as Error | null,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => kr.user,
  forgetLocally: () => {},
  resumeSession: async () => null,
  api: async () => kr.named,
  actOnACompanyInTheWallet: async (intent: Record<string, string>) => {
    kr.calls += 1;
    kr.acts.push(intent);
    if (kr.throws !== null) throw kr.throws;
    return kr.ended;
  },
}));

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  return import('./person-acts.js');
}
const NIGHT = SEED_ASSETS.find((a) => a.symbol === 'NIGHT')!;
const COMPANY = 'acc_Company00001';
const FINGERPRINT = 'ABCD-EFGH-JKMN-PQRS-TVWX';
const ANA = { id: 'emp_ana', name: 'Ana', asset: NIGHT.code };
const stopped = (refused?: string) => ({ of: 'stopped', step: 3, steps: 4, relayed: 0, unconfirmed: 0, why: refused === undefined ? 'relay-refused' : 'check-failed', ...(refused === undefined ? {} : { refused }) });

describe('admitting a person', () => {
  /* RED WHEN: the wallet is asked to admit a person other than the one pressed, or is given a fingerprint in any shape but the one it reads (groups, upper case). */
  it('asks the wallet to admit exactly the person pressed, with the fingerprint read out', async () => {
    const m = await load();
    kr.acts.length = 0; kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'admitted' } };
    expect(await m.admitPerson('u1', COMPANY, { id: 'emp_ana', name: 'Ana', admitBy: 'fingerprint', fingerprint: ` ${FINGERPRINT.toLowerCase().replaceAll('-', ' ')} ` })).toEqual({ of: m.PERSON_ACTED.done, state: 'admitted' });
    expect(kr.acts).toEqual([{
      name: m.PERSON_ACT.admit, record: COMPANY, company: 'label-1', account: 'c0'.repeat(32), kind: 'employee', person: 'emp_ana', personName: 'Ana', fingerprint: FINGERPRINT,
    }]);
  });

  /* RED WHEN: a person admitted on their wallet's signed claim is sent a fingerprint, which the wallet refuses as checked against nothing. */
  it('sends no fingerprint for a person admitted on their wallet\'s signed claim, even if one was typed', async () => {
    const m = await load();
    kr.acts.length = 0; kr.ended = { of: 'done', steps: 4, relayed: 0, outcome: { state: 'already-admitted' } };
    expect(await m.admitPerson('u1', COMPANY, { id: 'emp_bo', name: 'Bo', admitBy: 'claim', fingerprint: FINGERPRINT })).toEqual({ of: 'done', state: 'already-admitted' });
    expect(kr.acts).toEqual([{ name: m.PERSON_ACT.admit, record: COMPANY, company: 'label-1', account: 'c0'.repeat(32), kind: 'employee', person: 'emp_bo', personName: 'Bo' }]);
  });

  /* RED WHEN: a missing or mistyped fingerprint reaches the wallet, which would open a window for nothing, or is not told apart. */
  it('asks the wallet for nothing when the fingerprint is missing or is not one, and says which', async () => {
    const m = await load();
    kr.calls = 0;
    const by = (fingerprint?: string) => m.admitPerson('u1', COMPANY, { id: 'emp_ana', name: 'Ana', admitBy: 'fingerprint', ...(fingerprint === undefined ? {} : { fingerprint }) });
    expect(await by()).toEqual({ of: m.PERSON_ACTED.problem, problem: m.PROBLEM.noFingerprint });
    expect(await by('   ')).toEqual({ of: m.PERSON_ACTED.problem, problem: m.PROBLEM.noFingerprint });
    expect(await by('ABCD-EFGH')).toEqual({ of: m.PERSON_ACTED.problem, problem: m.PROBLEM.badFingerprint });
    expect(await by('ABCD-EFGH-JKMN-PQRS-TVWU')).toEqual({ of: m.PERSON_ACTED.problem, problem: m.PROBLEM.badFingerprint });
    expect(kr.calls).toBe(0);
  });

  /* RED WHEN: the wallet's stop is lost, a stop that may have filed part of the admission is told as nothing done, or another act's key is taken for this one's. */
  it('gives back the wallet\'s reason, and says which stops may have gone part of the way', async () => {
    const m = await load();
    const ask = () => m.admitPerson('u1', COMPANY, { id: 'emp_bo', name: 'Bo', admitBy: 'claim' });
    for (const [refused, why, partial] of [
      ['act.admit-person.why.not-believed', 'not-believed', false], ['act.admit-person.why.not-found', 'not-found', false], ['act.admit-person.why.not-as-shown', 'not-as-shown', false],
      ['act.admit-person.why.no-fingerprint', 'fingerprint-needed', false], ['act.admit-person.why.fingerprint-not-checked', 'fingerprint-not-needed', false],
      ['act.admit-person.why.not-admitted', 'not-admitted', false], ['act.admit-person.why.not-filed', 'not-filed', false], ['act.admit-person.why.no-seat', 'no-seat', false],
      ['act.admit-person.why.seat-not-held', 'seat-not-held', false], ['act.admit-person.why.roster-not-opened', 'roster-not-opened', false],
      ['act.admit-person.why.filed-not-entered', 'filed-not-entered', true], ['act.admit-person.why.filed-not-entered-nor-anchored', 'filed-not-entered-nor-anchored', true],
      ['act.admit-person.why.not-a-person', 'asked-wrongly', false], ['act.admit-person.why.not-a-fingerprint', 'asked-wrongly', false], ['act.admit-person.why.no-person', 'asked-wrongly', false],
      [undefined, 'stopped', true], ['act.admit-person.why.nobody-knows', 'other', true], ['act.change-person.why.no-seat', 'other', true],
    ] as const) {
      kr.ended = stopped(refused);
      expect(await ask(), String(refused)).toEqual({ of: m.PERSON_ACTED.stopped, act: m.PERSON_ACT.admit, why, partial, handedOver: false });
    }
  });
});

describe('changing a person', () => {
  const ask = (m: Awaited<ReturnType<typeof load>>, change: Parameters<Awaited<ReturnType<typeof load>>['changePerson']>[3]) => m.changePerson('u1', COMPANY, ANA, change);
  const base = { name: 'change-person', record: COMPANY, company: 'label-1', account: 'c0'.repeat(32), kind: 'employee', person: 'emp_ana', personName: 'Ana' };

  /* RED WHEN: a new salary is sent in the entered text instead of the token's smallest unit, in another token than the person's own, or without the day it applies from. */
  it('asks for a new salary in the token\'s smallest unit, in the person\'s own token, from the day given', async () => {
    const m = await load();
    kr.acts.length = 0; kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'changed' } };
    expect(await ask(m, { kind: m.CHANGE.pay, amount: '1,250.5'.replace(',', ''), from: '2027-01-01' })).toEqual({ of: m.PERSON_ACTED.done, state: 'changed' });
    expect(kr.acts).toEqual([{ ...base, payAmount: (1250n * 10n ** BigInt(NIGHT.decimals) + 5n * 10n ** BigInt(NIGHT.decimals - 1)).toString(), asset: NIGHT.code.toLowerCase(), payFrom: '2027-01-01' }]);
  });

  /* RED WHEN: an amount that is empty, not a number, nil, too fine for the token, or a day that is not a calendar date reaches the wallet, or is told as the wrong problem. */
  it('asks the wallet for nothing when the amount or the day is wrong, and says which', async () => {
    const m = await load();
    kr.calls = 0;
    const pay = (amount: string, from: string) => ask(m, { kind: m.CHANGE.pay, amount, from });
    const problem = (p: string) => ({ of: m.PERSON_ACTED.problem, problem: p });
    expect(await pay('', '2027-01-01')).toEqual(problem(m.PROBLEM.noAmount));
    expect(await pay('abc', '2027-01-01')).toEqual(problem(m.PROBLEM.badAmount));
    expect(await pay('0', '2027-01-01')).toEqual(problem(m.PROBLEM.zeroAmount));
    expect(await pay(`1.${'1'.repeat(NIGHT.decimals + 1)}`, '2027-01-01')).toEqual(problem(m.PROBLEM.tooManyDecimals));
    expect(await pay('5', '')).toEqual(problem(m.PROBLEM.noDate));
    expect(await pay('5', '2027-02-30')).toEqual(problem(m.PROBLEM.badDate));
    expect(await pay('5', '1 Jan')).toEqual(problem(m.PROBLEM.badDate));
    expect(kr.calls).toBe(0);
  });

  /* RED WHEN: a person whose token this app does not know is changed (the wallet would refuse the currency, after a window opened). */
  it('asks the wallet for nothing when the person\'s token is not one the app knows', async () => {
    const m = await load();
    kr.calls = 0;
    expect(await m.changePerson('u1', COMPANY, { ...ANA, asset: 'f0'.repeat(32) }, { kind: m.CHANGE.pay, amount: '5', from: '2027-01-01' })).toEqual({ of: m.PERSON_ACTED.problem, problem: m.PROBLEM.noAsset });
    expect(kr.calls).toBe(0);
  });

  /* RED WHEN: a classification change names a class that is not full-time or part-time, or leaves out its day, or the wallet is asked about it. */
  it('asks for a classification from a day, and for nothing when either is wrong', async () => {
    const m = await load();
    kr.acts.length = 0; kr.calls = 0; kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'changed' } };
    expect(await ask(m, { kind: m.CHANGE.classification, classification: 'part-time', from: '2027-03-01' })).toMatchObject({ of: 'done' });
    expect(kr.acts).toEqual([{ ...base, classification: 'part-time', classificationFrom: '2027-03-01' }]);
    kr.calls = 0;
    expect(await ask(m, { kind: m.CHANGE.classification, classification: 'contractor', from: '2027-03-01' })).toEqual({ of: 'problem', problem: m.PROBLEM.noClassification });
    expect(await ask(m, { kind: m.CHANGE.classification, classification: 'full-time', from: '' })).toEqual({ of: 'problem', problem: m.PROBLEM.noDate });
    expect(kr.calls).toBe(0);
  });

  /* RED WHEN: an end date or a leaving date is sent as a field when it is to be taken off (the wallet reads a cleared date from `clear`), or taken off by sending an empty one, or a date that is not a calendar date reaches the wallet. */
  it('sets an end date or a leaving date, takes one off by clearing it, and refuses a day that is not one', async () => {
    const m = await load();
    kr.acts.length = 0; kr.calls = 0; kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'changed' } };
    await ask(m, { kind: m.CHANGE.endDate, day: '2027-06-30' });
    await ask(m, { kind: m.CHANGE.endDate, day: null });
    await ask(m, { kind: m.CHANGE.leavingDate, day: '2027-05-31' });
    await ask(m, { kind: m.CHANGE.leavingDate, day: null });
    expect(kr.acts).toEqual([{ ...base, endDate: '2027-06-30' }, { ...base, clear: 'endDate' }, { ...base, leavingDate: '2027-05-31' }, { ...base, clear: 'leavingDate' }]);
    kr.calls = 0;
    expect(await ask(m, { kind: m.CHANGE.endDate, day: '2027-13-01' })).toEqual({ of: 'problem', problem: m.PROBLEM.badDate });
    expect(await ask(m, { kind: m.CHANGE.leavingDate, day: '' })).toEqual({ of: 'problem', problem: m.PROBLEM.noDate });
    expect(kr.calls).toBe(0);
  });

  /* RED WHEN: marking a person as left is sent with other details (the wallet refuses a status with details), sends a leaving date that is empty or not a day, or leaves out a date that was given. */
  it('marks a person as left on its own, with their leaving date when one is given', async () => {
    const m = await load();
    kr.acts.length = 0; kr.calls = 0; kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'changed' } };
    await ask(m, { kind: m.CHANGE.leave, day: '2027-05-31' });
    await ask(m, { kind: m.CHANGE.leave, day: '' });
    expect(kr.acts).toEqual([{ ...base, status: 'leaver', leavingDate: '2027-05-31' }, { ...base, status: 'leaver' }]);
    kr.calls = 0;
    expect(await ask(m, { kind: m.CHANGE.leave, day: '31/05/2027' })).toEqual({ of: 'problem', problem: m.PROBLEM.badDate });
    expect(kr.calls).toBe(0);
  });

  /* RED WHEN: the wallet's stop is lost, a stop that left the record filed is told as nothing done, or a raised month's refusal is not told as its own. */
  it('gives back the wallet\'s reason, and says which stops may have gone part of the way', async () => {
    const m = await load();
    for (const [refused, why, partial] of [
      ['act.change-person.why.date-raised', 'date-raised', false], ['act.change-person.why.not-changed', 'not-changed', false], ['act.change-person.why.not-believed', 'not-believed', false],
      ['act.change-person.why.not-as-shown', 'not-as-shown', false], ['act.change-person.why.no-seat', 'no-seat', false], ['act.change-person.why.not-on-chain', 'not-on-chain', false],
      ['act.change-person.why.filed-not-entered', 'filed-not-entered', true], ['act.change-person.why.filed-not-entered-nor-anchored', 'filed-not-entered-nor-anchored', true],
      ['act.change-person.why.status-and-details', 'asked-wrongly', false], ['act.change-person.why.terms-raised', 'terms-raised', false], ['act.admit-person.why.not-believed', 'other', true], [undefined, 'stopped', true],
    ] as const) {
      kr.ended = stopped(refused);
      expect(await ask(m, { kind: m.CHANGE.endDate, day: null }), String(refused)).toEqual({ of: m.PERSON_ACTED.stopped, act: m.PERSON_ACT.change, why, partial, handedOver: false });
    }
  });
});

describe('admitting a vendor', () => {
  /* RED WHEN: a vendor pressed is admitted as an employee (the wallet looks for an employee by that id and finds none), or is sent a fingerprint when their wallet's claim is the proof. */
  it('asks the wallet to admit the vendor pressed, as a vendor, on a fingerprint or on their claim', async () => {
    const m = await load();
    kr.acts.length = 0; kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'admitted' } };
    expect(await m.admitPerson('u1', COMPANY, { id: 'ven_vee', name: 'Vee', kind: m.PERSON_KIND.vendor, admitBy: 'fingerprint', fingerprint: FINGERPRINT })).toEqual({ of: m.PERSON_ACTED.done, state: 'admitted' });
    expect(await m.admitPerson('u1', COMPANY, { id: 'ven_wes', name: 'Wes', kind: m.PERSON_KIND.vendor, admitBy: 'claim', fingerprint: FINGERPRINT })).toEqual({ of: 'done', state: 'admitted' });
    const base = { name: m.PERSON_ACT.admit, record: COMPANY, company: 'label-1', account: 'c0'.repeat(32), kind: 'vendor' };
    expect(kr.acts).toEqual([{ ...base, person: 'ven_vee', personName: 'Vee', fingerprint: FINGERPRINT }, { ...base, person: 'ven_wes', personName: 'Wes' }]);
  });
});

describe('changing a vendor', () => {
  const VEE = { id: 'ven_vee', name: 'Vee' };
  const ask = (m: Awaited<ReturnType<typeof load>>, change: Parameters<Awaited<ReturnType<typeof load>>['changeVendor']>[3]) => m.changeVendor('u1', COMPANY, VEE, change);
  const base = { name: 'change-person', record: COMPANY, company: 'label-1', account: 'c0'.repeat(32), kind: 'vendor', person: 'ven_vee', personName: 'Vee' };

  /* RED WHEN: monthly terms are sent in the entered text instead of the token's smallest unit, in a token typed as anything but the registry's, or one-off terms carry an amount. */
  it('asks for monthly terms in the token\'s smallest unit, and for one-off terms with no amount', async () => {
    const m = await load();
    kr.acts.length = 0; kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'changed' } };
    expect(await ask(m, { kind: m.VENDOR_CHANGE.terms, terms: TERMS.monthly, asset: NIGHT.code, amount: '2.5' })).toEqual({ of: m.PERSON_ACTED.done, state: 'changed' });
    await ask(m, { kind: m.VENDOR_CHANGE.terms, terms: TERMS.oneOff });
    expect(kr.acts).toEqual([
      { ...base, terms: 'monthly', termsAsset: NIGHT.code.toLowerCase(), termsAmount: (25n * 10n ** BigInt(NIGHT.decimals - 1)).toString() },
      { ...base, terms: 'one-off' },
    ]);
  });

  /* RED WHEN: monthly terms with no amount, a nil or too fine amount, or a token the app does not know reach the wallet, or are told as the wrong problem. */
  it('asks the wallet for nothing when the monthly amount or token is wrong, and says which', async () => {
    const m = await load();
    kr.calls = 0;
    const monthly = (asset: string, amount: string) => ask(m, { kind: m.VENDOR_CHANGE.terms, terms: TERMS.monthly, asset, amount });
    const problem = (p: string) => ({ of: m.PERSON_ACTED.problem, problem: p });
    expect(await monthly(NIGHT.code, '')).toEqual(problem(m.PROBLEM.noAmount));
    expect(await monthly(NIGHT.code, 'abc')).toEqual(problem(m.PROBLEM.badAmount));
    expect(await monthly(NIGHT.code, '0')).toEqual(problem(m.PROBLEM.zeroAmount));
    expect(await monthly(NIGHT.code, `1.${'1'.repeat(NIGHT.decimals + 1)}`)).toEqual(problem(m.PROBLEM.tooManyDecimals));
    expect(await monthly('ff'.repeat(32), '1')).toEqual(problem(m.PROBLEM.noAsset));
    expect(kr.calls).toBe(0);
  });

  /* RED WHEN: an end date is sent as a field when it is to be taken off (the wallet reads a cleared date from `clear`), or a day that is not a calendar date reaches the wallet. */
  it('sets a vendor\'s end date, takes it off by clearing it, and refuses a day that is not one', async () => {
    const m = await load();
    kr.acts.length = 0; kr.calls = 0; kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'changed' } };
    await ask(m, { kind: m.VENDOR_CHANGE.endDate, day: '2026-12-31' });
    await ask(m, { kind: m.VENDOR_CHANGE.endDate, day: null });
    expect(kr.acts).toEqual([{ ...base, endDate: '2026-12-31' }, { ...base, clear: 'endDate' }]);
    kr.calls = 0;
    expect(await ask(m, { kind: m.VENDOR_CHANGE.endDate, day: '' })).toEqual({ of: m.PERSON_ACTED.problem, problem: m.PROBLEM.noDate });
    expect(await ask(m, { kind: m.VENDOR_CHANGE.endDate, day: '2026-02-30' })).toEqual({ of: m.PERSON_ACTED.problem, problem: m.PROBLEM.badDate });
    expect(kr.calls).toBe(0);
  });

  /* RED WHEN: the wallet's refusal to change terms once a month is raised is told as a stop with no reason, or as part-way done. */
  it('tells a refused change of terms, after a month was raised, as its own refusal that went nowhere', async () => {
    const m = await load();
    kr.ended = stopped('act.change-person.why.terms-raised');
    expect(await ask(m, { kind: m.VENDOR_CHANGE.terms, terms: TERMS.oneOff })).toEqual({ of: m.PERSON_ACTED.stopped, act: m.PERSON_ACT.change, why: 'terms-raised', partial: false, handedOver: false });
  });
});

describe('before either act reaches the wallet', () => {
  /* RED WHEN: a person who is not signed in, a company that cannot be read, or a wallet window that closed is told as anything but its own refusal. */
  it('asks the wallet for nothing when nobody is signed in or the company cannot be read, and names a window that closed', async () => {
    const m = await load();
    kr.calls = 0; kr.throws = null;
    const who = { id: 'emp_bo', name: 'Bo', admitBy: 'claim' } as const;
    const change = { kind: m.CHANGE.endDate, day: null } as const;
    kr.user = null;
    expect(await m.admitPerson('u1', COMPANY, who)).toEqual({ of: 'refused', why: ACT_REFUSAL.notSignedIn });
    expect(await m.changePerson('u1', COMPANY, ANA, change)).toEqual({ of: 'refused', why: ACT_REFUSAL.notSignedIn });
    kr.user = { id: 'u1' }; kr.named = {};
    expect(await m.admitPerson('u1', COMPANY, who)).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
    expect(await m.changePerson('u1', COMPANY, ANA, change)).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
    expect(kr.calls).toBe(0);
    kr.named = { companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) };
    kr.throws = new TypeError('fetch failed');
    expect(await m.admitPerson('u1', COMPANY, who)).toEqual({ of: 'refused', why: ACT_REFUSAL.unreachable });
    expect(await m.changePerson('u1', COMPANY, ANA, change)).toEqual({ of: 'refused', why: ACT_REFUSAL.unreachable });
    kr.throws = null;
  });

  /* RED WHEN: a site with no account origin reaches the wallet. */
  it('asks the wallet for nothing on a site not set up for an account', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
    vi.doMock('./session.js', async (real) => ({ ...(await real<typeof import('./session.js')>()), ACCOUNT_ORIGIN: '' }));
    kr.calls = 0;
    const m = await import('./person-acts.js');
    expect(await m.admitPerson('u1', COMPANY, { id: 'emp_bo', name: 'Bo', admitBy: 'claim' })).toEqual({ of: 'refused', why: ACT_REFUSAL.notSetUp });
    expect(await m.changePerson('u1', COMPANY, ANA, { kind: m.CHANGE.endDate, day: null })).toEqual({ of: 'refused', why: ACT_REFUSAL.notSetUp });
    expect(kr.calls).toBe(0);
    vi.doUnmock('./session.js');
  });
});

describe('a stop after the wallet handed over transactions', () => {
  /* RED WHEN: a refusal that follows transactions the wallet handed the page (sent, or not confirmed as sent) is told as one that did nothing, or a refusal that handed over none is told as one that did. */
  it('says a stop handed transactions over when any were sent or left unconfirmed, whatever its reason, and none when none were', async () => {
    const m = await load();
    for (const [relayed, unconfirmed, handedOver] of [[0, 0, false], [1, 0, true], [0, 1, true], [2, 1, true]] as const) {
      kr.ended = { ...stopped('act.admit-person.why.not-found'), relayed, unconfirmed };
      expect(await m.admitPerson('u1', COMPANY, { id: 'emp_bo', name: 'Bo', admitBy: 'claim' }), `admit ${relayed}/${unconfirmed}`)
        .toEqual({ of: m.PERSON_ACTED.stopped, act: m.PERSON_ACT.admit, why: 'not-found', partial: false, handedOver });
      kr.ended = { ...stopped('act.change-person.why.date-raised'), relayed, unconfirmed };
      expect(await m.changePerson('u1', COMPANY, ANA, { kind: m.CHANGE.endDate, day: null }), `change ${relayed}/${unconfirmed}`)
        .toEqual({ of: m.PERSON_ACTED.stopped, act: m.PERSON_ACT.change, why: 'date-raised', partial: false, handedOver });
    }
  });
});
