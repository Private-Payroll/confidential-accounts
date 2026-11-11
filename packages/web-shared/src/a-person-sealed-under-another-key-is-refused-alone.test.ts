/**
 * **A PERSON IS READ UNDER THE PEOPLE KEY, OR UNDER THE PAYROLL KEY THEIR RECORD WAS SEALED UNDER BEFORE.** A holder of
 * the company key reads a person sealed under the payroll key before people had their own, and the next filing of that
 * person seals them under the people key. A holder given purposes alone never reads a person through the payroll key.
 * A record that opens under neither is refused alone, named with why, and everybody else is still read.
 */
import { describe, expect, it, vi } from 'vitest';
import { readPeopleHere } from './people-read-here.js';
import { setStatusHere } from './people-on-device.js';
import { newSigningKeypair, signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import { openRecord, purposeKey, sealRecord, type PurposeKeys } from '../../../src/core/sealed-records.js';
import { openPerson, sealPerson } from '../../../src/core/person-record.js';
import { fromCompanyWire, signCompanyFiling, toCompanyWire, type CompanyWireVersion } from '../../../src/midnight/sealed-record-wire.js';
import type { RosterEmployee } from '../../../src/core/types.js';

/* The company's records believe every filing here, and this seat may file people, so a read turns only on whether each record opens. */
vi.mock('./vault-page-doors.js', async (real) => ({
  ...(await real<typeof import('./vault-page-doors.js')>()),
  judgeIn: () => () => null,
  namedHere: () => [],
}));
vi.mock('./may-file-here.js', () => ({ mayFileHere: async () => null }));

const CO = 'c1';
const KEY = '44'.repeat(32) as Hex;
const KEYS = { epoch: 0, newest: 0, key: KEY, keyAt: () => KEY, sealing: () => ({ key: KEY, epoch: 0 }) };
const SEAT = newSigningKeypair().secret;
const someone = (id: string, name: string): RosterEmployee => ({
  id, accountId: CO, name, email: null, title: 'Designer', asset: 'NIGHT', baseAmount: 1n, startDate: '2026-02-01',
  status: 'pending', invitedAddress: null, address: null, wrappingPublicKey: null, handedOverBy: null, payeeCode: null,
  admittedBy: null, admittedAt: null, madeBy: signingPublicKeyOf(SEAT), madeAt: '2026-09-01T00:00:00Z',
}) as never;

const ana = someone('emp_00000000000000000001', 'Ana');
const bo = someone('emp_00000000000000000002', 'Bo');
const cy = someone('emp_00000000000000000003', 'Cy');
const { id: _b, accountId: _bc, status: _bs, ...boSecrets } = bo;
const { id: _c, accountId: _cc, status: _cs, ...cySecrets } = cy;
const anaFiled = toCompanyWire(signCompanyFiling(sealPerson(ana, 1, 0, KEY), SEAT));
const boUnderThePayrollKey = signCompanyFiling({ ...sealPerson(bo, 1, 0, KEY), sealed: sealRecord('payroll', CO, boSecrets, KEY) }, SEAT);
const cyUnderTheVendorsKey = toCompanyWire(signCompanyFiling({ ...sealPerson(cy, 1, 0, KEY), sealed: sealRecord('vendors', CO, cySecrets, KEY) }, SEAT));

const posted: CompanyWireVersion[] = [];
const device = (people: readonly unknown[]) => ({
  company: { id: CO, label: 'acme', viewingKey: KEYS, keyEpoch: 0 }, network: 'stagenet', claimRefusal: async () => null,
  signingSecret: SEAT, signedInAs: 'usr_1', directory: async () => ({}), entered: { enter: async () => undefined },
  send: async (path: string, init?: { body?: string }) => {
    if (path.endsWith('/people')) return { status: 200, body: { people: people.map((filed) => ({ filed, handedOver: false })) } };
    if (path.endsWith('/status')) { posted.push(JSON.parse(init!.body!).person); return { status: 201, body: {} }; }
    return { status: 404, body: {} };
  },
}) as never;

const only = (purpose: 'roster' | 'payroll'): PurposeKeys => ({ keyFor: (p, c) => (p === purpose ? purposeKey(KEY, c, p) : null) });

describe('a person sealed under the payroll key before people had their own', () => {
  /* RED WHEN: a person sealed under the payroll key before is never believed, so the company's payroll stops for good. */
  it('is read by a holder of the company key, and filed again under the people key', async () => {
    const read = await readPeopleHere(device([anaFiled, toCompanyWire(boUnderThePayrollKey)]));
    expect(read.people.map((p) => p.person.name)).toEqual(['Ana', 'Bo']);
    expect(read.refused).toEqual([]);
    const here = read.people.find((p) => p.person.id === bo.id)!;
    posted.length = 0;
    await setStatusHere(device([]), here, 'leaver');
    /* RED WHEN: a person read through the payroll key is filed again under it, so their record never moves to the people key. */
    const refiled = fromCompanyWire(posted[0]!, { company: CO, kind: 'person', id: bo.id }).sealed;
    expect(openRecord<{ name: string }>('people', CO, refiled.sealed, { keyFor: (p, c) => (p === 'people' ? purposeKey(KEY, c, p) : null) }).name).toBe('Bo');
    expect(() => openRecord('payroll', CO, refiled.sealed, KEY)).toThrow(/will not open/u);
  });

  /* RED WHEN: a holder given the payroll runs or the roster by a grant reads a person through the payroll key. */
  it('is never read by a holder given purposes alone', () => {
    expect(() => openPerson(boUnderThePayrollKey, only('payroll'))).toThrow(/holds no key for the "people" records/u);
    expect(() => openPerson(boUnderThePayrollKey, only('roster'))).toThrow(/holds no key for the "people" records/u);
  });
});

describe('a person whose record opens under neither the people key nor the payroll key', () => {
  /* RED WHEN: a person sealed under another key stops the whole read, or is read as no person and left out unnamed. */
  it('is refused alone, named with why, and everybody else is still read', async () => {
    const read = await readPeopleHere(device([anaFiled, cyUnderTheVendorsKey]));
    expect(read.people.map((p) => p.person.name)).toEqual(['Ana']);
    expect(read.notBelieved).toEqual([cy.id]);
    expect(read.refused?.map((r) => r.id)).toEqual([cy.id]);
    expect(read.refused?.[0]?.why).toMatch(/"people" record .* will not open/u);
  });
});
