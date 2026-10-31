import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { addressFor } from 'midnight-identity';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { intentShapeOf, routeOf, type ActIntent } from 'midnight-identity/profile/request';
import { registryWithTestPrivateForms, TEST_TOKEN } from '../../../../src/testing/assets.js';
import { formatAmount } from '../../../../src/core/assets.js';
import { StepRefused, type StepContext } from './definition.js';

/*
 * Admitting a person or a vendor and changing their record, in the wallet. The wallet reads the company with its own
 * seat, finds the person as this device believes them, holds the page's words to their record, and asks the shared
 * device code to admit or change them, between the upkeep's two steps. The device code itself is tested on its own;
 * here it stands in, so each test says what the wallet hands it and what the wallet refuses before it is asked.
 */

const t = vi.hoisted(() => ({
  calls: [] as string[],
  people: null as null | (() => Promise<unknown>),
  vendors: null as null | (() => Promise<unknown>),
  asked: [] as any[][],
  pastDraft: [] as any[][],
  admit: null as null | ((...a: any[]) => Promise<unknown>),
  raised: ['2026-10'] as string[],
  failEntries: 0,
  enters: 0,
  order: [] as string[],
  called: [] as string[],
}));
vi.mock('../../../../packages/web-shared/src/record-entered-here.js', async (real) => {
  const actual = await real<typeof import('../../../../packages/web-shared/src/record-entered-here.js')>();
  return {
    ...actual,
    recordsEnteredFor: () => ({
      enter: async () => {
        t.enters += 1;
        t.calls.push('enter');
        if (t.failEntries > 0) { t.failEntries -= 1; throw new actual.FiledNotEntered('the service did not take the entry'); }
      },
    }),
  };
});
vi.mock('../../../../packages/web-shared/src/people-on-device.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/people-on-device.js')>()),
  readPeopleHere: async () => { t.calls.push('read-people'); return t.people!(); },
  admitHere: async (...a: any[]) => { t.calls.push('admit'); t.asked.push(a); return t.admit === null ? {} : t.admit(...a); },
  changePersonHere: async (...a: any[]) => { t.calls.push('change'); t.asked.push(a); return t.admit === null ? {} : t.admit(...a); },
  setStatusHere: async (...a: any[]) => { t.calls.push('status'); t.asked.push(a); return {}; },
}));
vi.mock('../../../../packages/web-shared/src/vendors-on-device.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/vendors-on-device.js')>()),
  readVendorsHere: async () => { t.calls.push('read-vendors'); return t.vendors!(); },
  admitVendorHere: async (...a: any[]) => { t.calls.push('admit-vendor'); t.asked.push(a); return t.admit === null ? {} : t.admit(...a); },
  changeVendorHere: async (...a: any[]) => { t.calls.push('change-vendor'); t.asked.push(a); return {}; },
}));
vi.mock('../../../../packages/web-shared/src/run-rebuilt-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/run-rebuilt-here.js')>()),
  periodsPastDraftHere: async (...a: any[]) => { t.pastDraft.push(a); return t.raised; },
}));
vi.mock('./upkeep.js', async (real) => {
  const actual = await real<typeof import('./upkeep.js')>();
  return {
    ...actual,
    upkeepSteps: (company: { reach: (c: unknown) => Promise<unknown>; renew: () => void }) => ({
      first: { title: { key: 'act.upkeep.step.first' }, run: async (c: unknown) => { t.calls.push('upkeep-first'); await company.reach(c); company.renew(); } },
      last: { title: { key: 'act.upkeep.step.last' }, run: async (c: unknown) => { t.calls.push('upkeep-last'); await company.reach(c); } },
    }),
  };
});

const { admitPersonAction, ADMIT_PERSON_STATE } = await import('./admit-person.js');
const { changePersonAction } = await import('./change-person.js');
const { PersonNotChanged } = await import('../../../../packages/web-shared/src/people-on-device.js');

const NET = 'undeployed' as const;
const identity = identityFromSecret(newSecret());
const SHIELDED = addressFor(identityFromSecret(new Uint8Array(32).fill(4)).moneyAt(0).zswap, NET).bech32;
const UNSHIELDED = 'mn_addr_undeployed1' + 'q'.repeat(58);
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const FINGERPRINT = 'ABCD-EFGH-JKLM-NPQR';
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const SOURCES = {
  'admit-person': readFileSync(new URL('./admit-person.ts', import.meta.url), 'utf8'),
  'change-person': readFileSync(new URL('./change-person.ts', import.meta.url), 'utf8'),
};
const BASE = { record: 'acc_1', company: LABEL, account: ACCOUNT };
const intent = (name: string, fields: Record<string, string | undefined>): ActIntent => ({
  name, fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Record<string, string>,
}) as ActIntent;

const ADA = { id: 'emp_ada', name: 'Ada Lovelace', status: 'pending', asset: TEST_TOKEN, invitedAddress: null as string | null, startDate: '2026-01-01' };
const ACME = { id: 'ven_acme', name: 'Acme Printing', status: 'active', payeeCode: null, invitedAddress: UNSHIELDED as string | null, startDate: '2026-01-01' };
const peopleWith = (o: { people?: unknown[]; notPayable?: unknown[]; notBelieved?: string[] } = {}) => async () => ({
  people: o.people ?? [{ person: ADA, version: 1, handedOver: true }], notPayable: o.notPayable ?? [], notBelieved: o.notBelieved ?? [],
});
const vendorsWith = (o: { vendors?: unknown[]; notPayable?: unknown[]; notBelieved?: string[] } = {}) => async () => ({
  vendors: o.vendors ?? [{ vendor: ACME, version: 1 }], notPayable: o.notPayable ?? [], notBelieved: o.notBelieved ?? [],
});

const KEYS = { epoch: 0, key: '11'.repeat(32), newest: 0, keyAt: () => '11'.repeat(32), sealing: () => ({ key: '11'.repeat(32), epoch: 0 }) };
const reachOf = () => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, seat: { signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: 'ab'.repeat(32) },
  leaf: 'aa'.repeat(32), companyKey: '11'.repeat(32), stepTo: () => {},
  api: async (path: string, init?: RequestInit) => { t.called.push(`${init?.method ?? 'GET'} ${path}`); return []; },
  send: async () => ({ status: 404, body: {} }),
  judges: { directoryHereFor: () => async () => ({ dir: { seats: [] }, leafOf: () => null, records: { history: new Map() } }) },
  sealed: {}, companyKeys: KEYS,
  roster: async () => ({ id: 'acc_1', name: 'Acme Ltd', signers: [] }),
  builder: { roundsOnChain: async () => ({}) },
  chain: { indexer: {} },
});
const ctxOf = (i: ActIntent, person: string | null = 'usr_a') => {
  const told: Array<Record<string, unknown>> = [];
  const ctx = {
    intent: i, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person,
    held: { identity, account: 0 }, at: { step: 3, steps: 4 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a person is admitted and changed through calls, never a relay'); },
    call: async (method: string, path: string) => { t.called.push(`${method} ${path}`); return { status: 404, body: {} }; }, tell: (x: Record<string, unknown>) => { told.push(x); },
    show: () => {}, keyring: { open: () => ({ read: () => ({ accounts: {} }) }), keep: async () => {} },
  } as unknown as StepContext;
  return { ctx, told };
};
const IDENTITY = { runPayload: () => new Uint8Array(32), proposalIdOf: () => new Uint8Array(32) };
const admitReach = () => ({ chain: () => ({}) as never, builder: () => ({}) as never, network: NET, assets: registryWithTestPrivateForms(), reachFor: async () => reachOf() as never });
const changeReach = () => ({ ...admitReach(), now: () => 1_800_000_000_000, roundIdentity: async () => IDENTITY });
const run = async (a: { steps(i: ActIntent): readonly { run(c: StepContext): Promise<void> }[] }, i: ActIntent, ctx: StepContext): Promise<void> => {
  for (const step of a.steps(i)) await step.run(ctx);
};
const refusedWith = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(StepRefused);
  return (e as StepRefused).words.key;
};
const ADMIT_ADA = { ...BASE, kind: 'employee', person: 'emp_ada', personName: 'Ada Lovelace', fingerprint: FINGERPRINT };
const ADMIT_ACME = { ...BASE, kind: 'vendor', person: 'ven_acme', personName: 'Acme Printing' };
const CHANGE_ADA = { ...BASE, kind: 'employee', person: 'emp_ada', personName: 'Ada Lovelace' };
const CHANGE_ACME = { ...BASE, kind: 'vendor', person: 'ven_acme', personName: 'Acme Printing' };

beforeEach(() => {
  t.calls.length = 0;
  t.asked.length = 0;
  t.pastDraft.length = 0;
  t.called.length = 0;
  t.people = peopleWith();
  t.vendors = vendorsWith();
  t.admit = null;
  t.raised = ['2026-10'];
  t.failEntries = 0;
  t.enters = 0;
});

describe('A PERSON OR A VENDOR IS ADMITTED IN THE WALLET, ON THE FINGERPRINT THEY READ OUT OR ON THEIR SIGNED CLAIM', () => {
  it('an employee invited by link is admitted on the fingerprint read out, with this wallet\'s seat, between the upkeep\'s two steps', async () => {
    const { ctx, told } = ctxOf(intent('admit-person', ADMIT_ADA));
    await run(admitPersonAction(admitReach()), intent('admit-person', ADMIT_ADA), ctx);
    expect(t.calls).toEqual(['upkeep-first', 'read-people', 'admit', 'upkeep-last']);
    const [d, here, readOut] = t.asked[0]!;
    /* RED WHEN: the person admitted is not the one the page named, or the fingerprint checked is not the one read out. */
    expect(here.person.id).toBe('emp_ada');
    expect(readOut).toBe(FINGERPRINT);
    /* RED WHEN: the record is filed with anything but this wallet's own seat and the company's keys it opened. */
    expect(d.signingSecret).toBe('01'.repeat(32));
    expect(d.company).toMatchObject({ id: 'acc_1', label: LABEL, account: ACCOUNT, name: 'Acme Ltd' });
    expect(Object.values(d.company)).toContain(KEYS);
    expect(d.signedInAs).toBe('usr_a');
    expect(told).toContainEqual({ state: ADMIT_PERSON_STATE.admitted });
  });

  it('a vendor added at a public address is admitted on their signed claim, with nothing read out', async () => {
    const { ctx, told } = ctxOf(intent('admit-person', ADMIT_ACME));
    await run(admitPersonAction(admitReach()), intent('admit-person', ADMIT_ACME), ctx);
    expect(t.calls).toEqual(['upkeep-first', 'read-vendors', 'admit-vendor', 'upkeep-last']);
    expect(t.asked[0]![1].vendor.id).toBe('ven_acme');
    expect(t.asked[0]![2]).toBe('');
    expect(told).toContainEqual({ state: ADMIT_PERSON_STATE.admitted });
  });

  it('a person added at a private address is admitted on the fingerprint, and one already admitted is told so and not filed again', async () => {
    t.people = peopleWith({ people: [{ person: { ...ADA, invitedAddress: SHIELDED }, version: 1, handedOver: true }] });
    await run(admitPersonAction(admitReach()), intent('admit-person', ADMIT_ADA), ctxOf(intent('admit-person', ADMIT_ADA)).ctx);
    expect(t.calls).toContain('admit');
    t.calls.length = 0;
    t.people = peopleWith({ people: [{ person: { ...ADA, status: 'active' }, version: 2, handedOver: false }] });
    const { ctx, told } = ctxOf(intent('admit-person', ADMIT_ADA));
    await run(admitPersonAction(admitReach()), intent('admit-person', ADMIT_ADA), ctx);
    /* RED WHEN: a person already admitted is filed a second time when the press is repeated. */
    expect(t.calls).not.toContain('admit');
    expect(told).toContainEqual({ state: ADMIT_PERSON_STATE.alreadyAdmitted });
  });

  it('RED WHEN: a person checked by fingerprint is admitted with none read out, or one admitted by their claim is shown a fingerprint nothing checks', async () => {
    const none = { ...ADMIT_ADA, fingerprint: undefined };
    expect(await refusedWith(run(admitPersonAction(admitReach()), intent('admit-person', none), ctxOf(intent('admit-person', none)).ctx))).toBe('act.admit-person.why.no-fingerprint');
    const shown = { ...ADMIT_ACME, fingerprint: FINGERPRINT };
    expect(await refusedWith(run(admitPersonAction(admitReach()), intent('admit-person', shown), ctxOf(intent('admit-person', shown)).ctx))).toBe('act.admit-person.why.fingerprint-not-checked');
    expect(t.calls).not.toContain('admit');
    expect(t.calls).not.toContain('admit-vendor');
  });

  it('RED WHEN: the page names a person by another name than their record, or as the other kind, and they are admitted', async () => {
    const renamed = { ...ADMIT_ADA, personName: 'Grace Hopper' };
    expect(await refusedWith(run(admitPersonAction(admitReach()), intent('admit-person', renamed), ctxOf(intent('admit-person', renamed)).ctx))).toBe('act.admit-person.why.not-as-shown');
    const asVendor = { ...ADMIT_ADA, kind: 'vendor', fingerprint: undefined };
    expect(await refusedWith(run(admitPersonAction(admitReach()), intent('admit-person', asVendor), ctxOf(intent('admit-person', asVendor)).ctx))).toBe('act.admit-person.why.not-found');
    expect(t.calls.filter((c) => c.startsWith('admit'))).toEqual([]);
  });

  it('RED WHEN: a person no seat this device believes filed is admitted, or one is admitted with nobody signed in', async () => {
    t.people = peopleWith({ people: [], notBelieved: ['emp_ada'] });
    expect(await refusedWith(run(admitPersonAction(admitReach()), intent('admit-person', ADMIT_ADA), ctxOf(intent('admit-person', ADMIT_ADA)).ctx))).toBe('act.admit-person.why.not-believed');
    t.people = peopleWith();
    expect(await refusedWith(run(admitPersonAction(admitReach()), intent('admit-person', ADMIT_ADA), ctxOf(intent('admit-person', ADMIT_ADA), null).ctx))).toBe('act.admit-person.why.no-person');
    expect(t.calls).not.toContain('admit');
  });

  it('RED WHEN: a vendor no seat this device believes filed is admitted', async () => {
    t.vendors = vendorsWith({ vendors: [], notBelieved: ['ven_acme'] });
    expect(await refusedWith(run(admitPersonAction(admitReach()), intent('admit-person', ADMIT_ACME), ctxOf(intent('admit-person', ADMIT_ACME)).ctx))).toBe('act.admit-person.why.not-believed');
    expect(t.calls).not.toContain('admit-vendor');
  });

  it('a vendor already admitted is told so and not filed again', async () => {
    t.vendors = vendorsWith({ vendors: [{ vendor: { ...ACME, payeeCode: 'pay_acme' }, version: 2 }] });
    const { ctx, told } = ctxOf(intent('admit-person', ADMIT_ACME));
    await run(admitPersonAction(admitReach()), intent('admit-person', ADMIT_ACME), ctx);
    /* RED WHEN: a vendor already admitted is filed a second time when the press is repeated. */
    expect(t.calls).not.toContain('admit-vendor');
    expect(told).toContainEqual({ state: ADMIT_PERSON_STATE.alreadyAdmitted });
    expect(told).not.toContainEqual({ state: ADMIT_PERSON_STATE.admitted });
  });

  it('a fingerprint that is not a fingerprint is refused before anything is read, and one that is, or none, is not', async () => {
    const a = admitPersonAction(admitReach());
    const READ_OUT = 'ABCD-EFGH-JKMN-PQRS-TVWX';
    const checked = (fields: Record<string, string | undefined>) => a.check(intent('admit-person', fields), { identity } as never);
    /* RED WHEN: a malformed fingerprint reaches the admission, to be told as a fingerprint that did not match. */
    expect(await checked({ ...ADMIT_ADA, fingerprint: 'ABCD' })).toEqual({ key: 'act.admit-person.why.not-a-fingerprint' });
    expect(await checked({ ...ADMIT_ADA, fingerprint: 'not a fingerprint at all' })).toEqual({ key: 'act.admit-person.why.not-a-fingerprint' });
    expect(await checked({ ...ADMIT_ADA, fingerprint: READ_OUT })).toBeNull();
    expect(await checked({ ...ADMIT_ADA, fingerprint: 'abcd efgh jkmn pqrs tvwx' })).toBeNull();
    expect(await checked({ ...ADMIT_ADA, fingerprint: undefined })).toBeNull();
    expect(t.calls).toEqual([]);
  });

  it('a refusal of the shared code is said with its reason, and nothing is told as admitted', async () => {
    t.admit = async () => { throw new PersonNotChanged('the fingerprint this person read out is not the fingerprint of the code that arrived.'); };
    const { ctx, told } = ctxOf(intent('admit-person', ADMIT_ADA));
    const e = await run(admitPersonAction(admitReach()), intent('admit-person', ADMIT_ADA), ctx).then(() => null, (x: unknown) => x);
    expect((e as StepRefused).words).toMatchObject({ key: 'act.admit-person.why.not-admitted' });
    expect(String((e as StepRefused).words.values?.['says'])).toMatch(/fingerprint/u);
    expect(told).toEqual([]);
  });
});

describe('A PERSON\'S OR A VENDOR\'S RECORD IS CHANGED IN THE WALLET, NEVER IN A MONTH ALREADY RAISED', () => {
  it('pay, classification, end and leaving dates are changed with the months raised read for the employees\' runs', async () => {
    const i = intent('change-person', { ...CHANGE_ADA, payAmount: '6000', asset: TEST_TOKEN, payFrom: '2026-11-01', classification: 'part-time', classificationFrom: '2026-11-01', endDate: '2027-06-30', leavingDate: '2027-06-30' });
    const { ctx, told } = ctxOf(i);
    await run(changePersonAction(changeReach()), i, ctx);
    expect(t.calls).toEqual(['upkeep-first', 'read-people', 'change', 'upkeep-last']);
    const [d, here, change, pastDraft] = t.asked[0]!;
    expect(d.signingSecret).toBe('01'.repeat(32));
    expect(here.person.id).toBe('emp_ada');
    expect(change).toEqual({
      pay: { amount: 6000n, from: '2026-11-01' }, classification: { classification: 'part-time', from: '2026-11-01' }, endDate: '2027-06-30', leavingDate: '2027-06-30',
    });
    /* RED WHEN: a change is checked against no months raised, or against the vendors' runs, so a raised month is paid differently. */
    expect(await pastDraft()).toEqual(['2026-10']);
    const [records, accountId, keys, , list] = t.pastDraft[0]!;
    expect([accountId, keys, list]).toEqual(['acc_1', KEYS, 'employees']);
    /* RED WHEN: the months raised are read with a run identity that throws, so any company with a payroll proposal cannot change anyone. */
    expect(records.roundIdentity).toBe(IDENTITY);
    expect(told).toContainEqual({ state: 'changed' });
  });

  it('a cleared end date is asked as cleared, and a leaver is made through their status with their leaving date', async () => {
    const cleared = intent('change-person', { ...CHANGE_ADA, clear: 'endDate' });
    await run(changePersonAction(changeReach()), cleared, ctxOf(cleared).ctx);
    expect(t.asked[0]![2]).toEqual({ endDate: null });
    const leaver = intent('change-person', { ...CHANGE_ADA, status: 'leaver', leavingDate: '2026-12-15' });
    t.people = peopleWith({ people: [], notPayable: [{ here: { person: { ...ADA, status: 'active' }, version: 3, handedOver: false }, why: 'their claim is refused' }] });
    await run(changePersonAction(changeReach()), leaver, ctxOf(leaver).ctx);
    /* RED WHEN: a person the device will not pay cannot be made a leaver, the only way out for them. */
    expect(t.calls.filter((c) => c === 'status')).toEqual(['status']);
    const [, here, status, leaving] = t.asked[1]!;
    expect([here.version, status, leaving.leavingDate]).toEqual([3, 'leaver', '2026-12-15']);
    expect(await leaving.pastDraft()).toEqual(['2026-10']);
  });

  it('vendor terms, end date and status are changed with the months raised read for the vendors\' runs', async () => {
    t.raised = [];
    const i = intent('change-person', { ...CHANGE_ACME, terms: 'monthly', termsAsset: TEST_TOKEN, termsAmount: '900', endDate: '2027-01-31', status: 'leaver' });
    await run(changePersonAction(changeReach()), i, ctxOf(i).ctx);
    expect(t.calls).toEqual(['upkeep-first', 'read-vendors', 'change-vendor', 'upkeep-last']);
    expect(t.asked[0]![2]).toEqual({ terms: { kind: 'monthly', asset: TEST_TOKEN, amount: 900n }, endDate: '2027-01-31', status: 'leaver' });
    t.pastDraft.length = 0;
    await t.asked[0]![3]();
    /* RED WHEN: a vendor's end date is checked against the employees' runs, so a raised vendor month is cut short. */
    expect(t.pastDraft[0]![4]).toBe('vendors');
  });

  it('RED WHEN: a change reaches a month a run has already been raised for: a vendor\'s terms, a date inside or before it, or a date taken off from it', async () => {
    const refused = async (base: Record<string, string>, f: Record<string, string>): Promise<string> => {
      const i = intent('change-person', { ...base, ...f });
      return refusedWith(run(changePersonAction(changeReach()), i, ctxOf(i).ctx));
    };
    expect(await refused(CHANGE_ACME, { terms: 'one-off' })).toBe('act.change-person.why.terms-raised');
    expect(await refused(CHANGE_ACME, { endDate: '2026-10-15' })).toBe('act.change-person.why.date-raised');
    expect(await refused(CHANGE_ADA, { endDate: '2026-10-15' })).toBe('act.change-person.why.date-raised');
    expect(await refused(CHANGE_ADA, { status: 'leaver', leavingDate: '2026-10-31' })).toBe('act.change-person.why.date-raised');
    t.people = peopleWith({ people: [{ person: { ...ADA, status: 'active', endDate: '2026-10-20' }, version: 2, handedOver: false }] });
    expect(await refused(CHANGE_ADA, { clear: 'endDate' })).toBe('act.change-person.why.date-raised');
    expect(await refused(CHANGE_ADA, { endDate: '2027-03-01' })).toBe('act.change-person.why.date-raised');
    expect(t.calls.filter((c) => c === 'change' || c === 'status' || c === 'change-vendor')).toEqual([]);
    t.people = peopleWith({ people: [{ person: { ...ADA, status: 'active', endDate: '2027-02-28' }, version: 2, handedOver: false }] });
    const later = intent('change-person', { ...CHANGE_ADA, clear: 'endDate' });
    await run(changePersonAction(changeReach()), later, ctxOf(later).ctx);
    expect(t.calls).toContain('change');
  });

  it('RED WHEN: a pay change is half given or at zero, or a vendor\'s terms are asked without a kind or a monthly amount above zero, and it is handed to be filed', async () => {
    const PAY = { payAmount: '6000', asset: TEST_TOKEN, payFrom: '2026-11-01' };
    const MONTHLY = { terms: 'monthly', termsAsset: TEST_TOKEN, termsAmount: '900' };
    const table: Array<[string, Record<string, string>, string]> = [
      ['an employee\'s pay with no asset', { ...CHANGE_ADA, ...PAY, asset: undefined as never }, 'pay-incomplete'],
      ['an employee\'s pay with no start day', { ...CHANGE_ADA, ...PAY, payFrom: undefined as never }, 'pay-incomplete'],
      ['an employee\'s pay with an asset and a day and no amount', { ...CHANGE_ADA, ...PAY, payAmount: undefined as never }, 'pay-incomplete'],
      ['an employee\'s pay of zero', { ...CHANGE_ADA, ...PAY, payAmount: '0' }, 'no-pay'],
      ['an employee\'s pay below zero', { ...CHANGE_ADA, ...PAY, payAmount: '-1' }, 'no-pay'],
      ['a vendor\'s monthly amount of zero', { ...CHANGE_ACME, ...MONTHLY, termsAmount: '0' }, 'no-pay'],
      ['a vendor\'s monthly amount below zero', { ...CHANGE_ACME, ...MONTHLY, termsAmount: '-1' }, 'no-pay'],
      ['a vendor\'s monthly terms with no amount', { ...CHANGE_ACME, ...MONTHLY, termsAmount: undefined as never }, 'no-pay'],
      ['a vendor\'s terms asked as neither one-off nor monthly', { ...CHANGE_ACME, terms: 'weekly' }, 'not-terms'],
      ['a vendor\'s terms asset with no kind', { ...CHANGE_ACME, termsAsset: TEST_TOKEN }, 'not-terms'],
      ['a vendor\'s terms amount with no kind', { ...CHANGE_ACME, termsAmount: '900' }, 'not-terms'],
    ];
    for (const [what, fields, key] of table) {
      const i = intent('change-person', fields);
      expect(await refusedWith(run(changePersonAction(changeReach()), i, ctxOf(i).ctx)), what).toBe(`act.change-person.why.${key}`);
    }
    expect(t.calls.filter((c) => c === 'change' || c === 'status' || c === 'change-vendor')).toEqual([]);
  });

  it('the window shows a new salary and a vendor\'s monthly terms in the currency\'s own units and symbol, never a bare count and an id', async () => {
    const asset = registryWithTestPrivateForms().require(TEST_TOKEN);
    const pay = await changePersonAction(changeReach()).shown(intent('change-person', { ...CHANGE_ADA, payAmount: '6000', asset: TEST_TOKEN, payFrom: '2026-11-01' }));
    const terms = await changePersonAction(changeReach()).shown(intent('change-person', { ...CHANGE_ACME, terms: 'monthly', termsAsset: TEST_TOKEN, termsAmount: '900' }));
    /* RED WHEN: the approver sets a salary or a vendor's terms reading only a count of the smallest unit and a currency's hex id. */
    expect(pay.find((l) => l.key === 'act.change-person.shown.pay')?.values).toMatchObject({ shown: formatAmount(6000n, asset), symbol: asset.symbol, from: '2026-11-01' });
    expect(terms.find((l) => l.key === 'act.change-person.shown.terms-monthly')?.values).toMatchObject({ shown: formatAmount(900n, asset), symbol: asset.symbol });
    for (const k of ['act.change-person.shown.pay', 'act.change-person.shown.terms-monthly']) expect(WORDS[k]).toMatch(/\{shown\} \{symbol\}/u);
  });

  it('RED WHEN: one act changes a person\'s status and their details together, or asks nothing at all', async () => {
    for (const f of [{ status: 'leaver', payAmount: '1', asset: TEST_TOKEN, payFrom: '2026-11-01' }, { status: 'active', leavingDate: '2026-12-01' }, { status: 'leaver', clear: 'endDate' }]) {
      const i = intent('change-person', { ...CHANGE_ADA, ...f });
      expect(await refusedWith(run(changePersonAction(changeReach()), i, ctxOf(i).ctx))).toBe('act.change-person.why.status-and-details');
    }
    const none = intent('change-person', CHANGE_ADA);
    expect(await refusedWith(run(changePersonAction(changeReach()), none, ctxOf(none).ctx))).toBe('act.change-person.why.nothing');
    const both = intent('change-person', { ...CHANGE_ADA, endDate: '2027-01-01', clear: 'endDate' });
    expect(await refusedWith(run(changePersonAction(changeReach()), both, ctxOf(both).ctx))).toBe('act.change-person.why.cleared-and-given');
    expect(t.calls.filter((c) => c === 'change' || c === 'status')).toEqual([]);
  });

  it('RED WHEN: the page shows another name, kind or currency than the record holds, and the record is changed', async () => {
    for (const [f, key] of [
      [{ personName: 'Grace Hopper', endDate: '2027-01-01' }, 'not-as-shown'],
      [{ payAmount: '6000', asset: '77'.repeat(32), payFrom: '2026-11-01' }, 'not-as-shown'],
      [{ kind: 'vendor', endDate: '2027-01-01' }, 'not-found'],
    ] as const) {
      const i = intent('change-person', { ...CHANGE_ADA, ...f });
      expect(await refusedWith(run(changePersonAction(changeReach()), i, ctxOf(i).ctx))).toBe(`act.change-person.why.${key}`);
    }
    t.people = peopleWith({ people: [], notBelieved: ['emp_ada'] });
    const i = intent('change-person', { ...CHANGE_ADA, endDate: '2027-01-01' });
    expect(await refusedWith(run(changePersonAction(changeReach()), i, ctxOf(i).ctx))).toBe('act.change-person.why.not-believed');
    expect(t.calls.filter((c) => c === 'change' || c === 'change-vendor')).toEqual([]);
  });

  it('RED WHEN: a field of the other kind is taken, so the window shows a change nothing makes', async () => {
    for (const [base, f] of [[CHANGE_ADA, { terms: 'one-off' }], [CHANGE_ACME, { payAmount: '1', asset: TEST_TOKEN, payFrom: '2026-11-01' }], [CHANGE_ACME, { leavingDate: '2027-01-01' }], [CHANGE_ACME, { clear: 'leavingDate' }]] as const) {
      const i = intent('change-person', { ...base, ...f });
      expect(await refusedWith(run(changePersonAction(changeReach()), i, ctxOf(i).ctx))).toBe('act.change-person.why.not-for-this-kind');
    }
  });
});

describe('A RECORD FILED IN THE WALLET IS NAMED IN THE COMPANY\'S RECORDS BEFORE THE ACT SAYS IT IS DONE', () => {
  const filing = async (d: any) => { await d.entered.enter([{ store: 'company', kind: 'person', id: 'emp_ada' }]); return {}; };

  it('an entry the service did not take at first is sent again, and the person is told admitted once it is taken', async () => {
    t.admit = filing;
    t.failEntries = 2;
    const { ctx, told } = ctxOf(intent('admit-person', ADMIT_ADA));
    await run(admitPersonAction(admitReach()), intent('admit-person', ADMIT_ADA), ctx);
    /* RED WHEN: an entry the service refused once is left unsent, so no device believes the admitted record. */
    expect(t.enters).toBe(3);
    expect(told).toContainEqual({ state: ADMIT_PERSON_STATE.admitted });
  });

  it('RED WHEN: an entry the service never takes is told as done, or the refusal tells the person to do again what cannot be done again', async () => {
    for (const [name, a, i] of [
      ['admit-person', admitPersonAction(admitReach()), intent('admit-person', ADMIT_ADA)],
      ['change-person', changePersonAction(changeReach()), intent('change-person', { ...CHANGE_ADA, endDate: '2027-06-30' })],
    ] as const) {
      t.calls.length = 0;
      t.admit = filing;
      t.failEntries = 99;
      const { ctx, told } = ctxOf(i);
      const e = await run(a as never, i, ctx).then(() => null, (x: unknown) => x);
      expect((e as StepRefused).words.key).toBe(`act.${name}.why.filed-not-entered`);
      expect(told.filter((x) => 'state' in x)).toEqual([]);
      /* RED WHEN: the entry is not tried again after the act's own anchor, which sends this seat's kept entries again. */
      expect(t.calls.lastIndexOf('enter')).toBeGreaterThan(t.calls.indexOf('upkeep-last'));
      expect(WORDS[`act.${name}.why.filed-not-entered`]).not.toMatch(/do it again|press .* again|try again/iu);
    }
  });
});

describe('EACH ACTION CALLS ONLY THE ROUTES ITS INTENT LISTS, AND HAS ITS WORDS', () => {
  it('the windows say the upkeep is told back and may send transactions, what the months-raised check refuses, and where the withdrawal is read from', () => {
    /* RED WHEN: a window promises more than the act does, or less than it sends. */
    for (const name of ['admit-person', 'change-person']) {
      expect(WORDS[`act.${name}.shown.nothing-else`]).not.toMatch(/only whether/u);
      expect(WORDS[`act.${name}.shown.nothing-else`]).toMatch(/anchored/u);
      expect(WORDS[`act.${name}.shown.nothing-else`]).toMatch(/transaction/u);
    }
    expect(WORDS['act.change-person.shown.raised']).toMatch(/terms/u);
    expect(WORDS['act.change-person.shown.raised']).toMatch(/taken off/u);
    expect(WORDS['act.change-person.check.raised']).toMatch(/terms/u);
    expect(WORDS['act.admit-person.shown.checks']).toMatch(/as the service reports it/u);
  });

  it('every route the admit and change actions called themselves is one their intent lists', async () => {
    const admit = intentShapeOf('admit-person')!;
    const change = intentShapeOf('change-person')!;
    const routesOf = async (shape: typeof admit, a: Parameters<typeof run>[0], i: ActIntent): Promise<string[]> => {
      t.called.length = 0;
      t.pastDraft.length = 0;
      await run(a, i, ctxOf(i).ctx);
      /* The months-raised reader the change hands the shared code is the action's own: it reads the runs and the proposals itself. */
      if (t.pastDraft.length > 0) {
        await t.pastDraft[0]![0].runs();
        await t.pastDraft[0]![0].proposals();
      }
      return t.called.slice().map((c) => { expect(routeOf(shape, c.split(' ')[0]!, c.split(' ')[1]!), c).not.toBeNull(); return c; });
    };
    await routesOf(admit, admitPersonAction(admitReach()), intent('admit-person', ADMIT_ADA));
    const changed = [
      ...await routesOf(change, changePersonAction(changeReach()), intent('change-person', { ...CHANGE_ADA, endDate: '2027-06-30' })),
      ...await routesOf(change, changePersonAction(changeReach()), intent('change-person', { ...CHANGE_ACME, endDate: '2027-01-31' })),
    ];
    /* RED WHEN: the change action reads the runs or the proposals from a route its intent does not list, which the wallet refuses only when it runs. */
    expect(changed).toContain('GET /api/accounts/acc_1/runs');
    expect(changed.some((c) => c.endsWith('/proposals'))).toBe(true);
  });

  it('the routes each intent lists are the ones the device code uses, neither sends a transaction, and every stop and line has its words', async () => {
    const admit = intentShapeOf('admit-person')!;
    const change = intentShapeOf('change-person')!;
    for (const [shape, m, p] of [
      [admit, 'GET', '/api/employees/emp_ada/handover'], [admit, 'POST', '/api/employees/emp_ada/admit'], [admit, 'GET', '/api/accounts/acc_1/invites'],
      [admit, 'GET', '/api/accounts/acc_1/vendors/ven_acme/handover'], [admit, 'POST', '/api/accounts/acc_1/vendors/ven_acme/admit'],
      [admit, 'GET', '/api/accounts/acc_1/people'], [admit, 'GET', '/api/accounts/acc_1/records/person/emp_ada/1'],
      [change, 'POST', '/api/people/emp_ada/status'], [change, 'POST', '/api/people/emp_ada/details'], [change, 'GET', '/api/accounts/acc_1/runs'],
      [change, 'PUT', '/api/accounts/acc_1/records/vendor/ven_acme/2'], [change, 'GET', '/api/accounts/acc_1/proposals'],
    ] as const) {
      expect(routeOf(shape, m, p), `${m} ${p}`).not.toBeNull();
    }
    /* RED WHEN: admitting or changing a person may hand a transaction to the chain or raise a proposal. */
    for (const shape of [admit, change]) {
      expect((shape.calls ?? []).filter((c) => c.sends === true && !c.path.endsWith('/proven'))).toEqual([]);
      expect(routeOf(shape, 'POST', '/api/accounts/acc_1/proposals')).toBeNull();
    }
    expect(routeOf(admit, 'POST', '/api/people/emp_ada/details')).toBeNull();
    const keys = new Set<string>();
    for (const [name, a, i] of [
      ['admit-person', admitPersonAction(admitReach()), [intent('admit-person', ADMIT_ADA), intent('admit-person', ADMIT_ACME)]],
      ['change-person', changePersonAction(changeReach()), [
        intent('change-person', { ...CHANGE_ADA, payAmount: '6000', asset: TEST_TOKEN, payFrom: '2026-11-01', classification: 'part-time', classificationFrom: '2026-11-01', endDate: '2027-06-30', leavingDate: '2027-06-30' }),
        intent('change-person', { ...CHANGE_ADA, status: 'leaver', clear: 'endDate,leavingDate' }),
        intent('change-person', { ...CHANGE_ACME, terms: 'monthly', termsAsset: TEST_TOKEN, termsAmount: '900', status: 'active' }),
        intent('change-person', { ...CHANGE_ACME, terms: 'one-off' }),
      ]],
    ] as const) {
      keys.add(`act.${name}.headline`);
      for (const c of a.checks) if (c.key.startsWith(`act.${name}`)) keys.add(c.key);
      for (const x of i) for (const line of await a.shown(x)) if (line.key.startsWith(`act.${name}`)) keys.add(line.key);
      for (const m of SOURCES[name].matchAll(/why\('([a-z-]+)'/gu)) keys.add(`act.${name}.why.${m[1]}`);
      for (const m of SOURCES[name].matchAll(/key: 'act\.[a-z-]+\.([a-z.-]+)'/gu)) keys.add(`act.${name}.${m[1]}`);
      for (const k of ['not-a-company', 'no-saved-keys', 'no-seat', 'seat-not-held', 'not-on-chain', 'roster-not-opened']) keys.add(`act.${name}.why.${k}`);
    }
    /* RED WHEN: a stop or a line of either window has no words, and the person is shown a key. */
    expect([...keys].filter((k) => WORDS[k] === undefined)).toEqual([]);
  });
});
