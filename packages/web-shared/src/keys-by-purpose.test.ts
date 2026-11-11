/**
 * **EVERY RECORD OPENS WITH THE KEY ITS READER HOLDS FOR ITS PURPOSE.** A holder of the company key opens every
 * purpose; a holder given the roster alone opens the signers and the seats' proofs and is refused the company's people,
 * which are sealed under their own purpose, apart from the payroll runs. The purposes a read grant names for each
 * reader role come from one place.
 */
import { describe, expect, it } from 'vitest';
import { keysByPurpose } from './keys-by-purpose.js';
import { purposeWrapsHeldFrom } from './purpose-wraps.js';
import { grantEntryOf, purposeWrapsFor, readerIdOf } from '../../../src/midnight/grants-record.js';
import { recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { newSigningKeypair, signingPublicKeyOf, wrapKey, type Hex } from '../../../src/core/crypto.js';
import { keyForThePurpose, openRecord, purposeKey, PURPOSES, type PurposeKeys } from '../../../src/core/sealed-records.js';
import { openPerson, PERSON_PURPOSE, sealPerson } from '../../../src/core/person-record.js';
import { openRoster, sealRoster } from '../../../src/core/roster-record.js';
import { openSeatProof, sealSeatProof } from '../../../src/core/seat-opening.js';
import { proofsOpenedWith } from '../../../src/midnight/seat-directory.js';
import { SEALED_UNDER_PURPOSE } from '../../../src/midnight/sealed-record-wire.js';
import { grantPurposes, READER_ROLES, SIGNER_ROLES } from '../../../src/core/roles.js';
import { seatOpenedFor } from '../../../src/testing/directory-seats.js';
import type { RosterEmployee } from '../../../src/core/types.js';

const CO = 'acme';
const KEY = '33'.repeat(32) as Hex;
const KEYS = { epoch: 0, newest: 0, key: KEY, keyAt: () => KEY, sealing: () => ({ key: KEY, epoch: 0 }) };
const SEAT = newSigningKeypair().secret;

/** A holder given only the roster's key of the company, as a read grant would hand it over. */
const rosterAlone: PurposeKeys = { keyFor: (purpose, company) => (purpose === 'roster' ? purposeKey(KEY, company, 'roster') : null) };

const bo: RosterEmployee = {
  id: 'emp_0123456789abcdef0123', accountId: CO, name: 'Bo', email: null, title: 'Designer', asset: 'NIGHT', baseAmount: 1n,
  startDate: '2026-02-01', status: 'active', invitedAddress: null, address: null, wrappingPublicKey: null, handedOverBy: null,
  payeeCode: null, admittedBy: null, admittedAt: null, madeBy: signingPublicKeyOf(SEAT), madeAt: '2026-09-01T00:00:00Z',
} as never;
const person = sealPerson(bo, 1, 0, KEY);
const roster = sealRoster(CO, { name: 'Acme', signers: [] }, 1, 0, KEY);

describe('a record opened with the key its reader holds for its purpose', () => {
  /* RED WHEN: a person is sealed under the payroll runs' key, so a reader of the runs reads every person too. */
  it('seals a person under the people key, apart from the payroll runs', () => {
    expect(PERSON_PURPOSE).toBe('people');
    expect(openRecord<{ name: string }>('people', CO, person.sealed, KEY).name).toBe('Bo');
    expect(() => openRecord('payroll', CO, person.sealed, KEY)).toThrow(/will not open/u);
  });

  /* RED WHEN: a holder of the company key reads its people or its roster any other way than through its keys by purpose. */
  it('opens the people and the roster for a holder of the company key', () => {
    const held = keysByPurpose(KEYS);
    expect(openPerson(person, held.at(0)).name).toBe('Bo');
    expect(openRoster(roster, held.at(0)).name).toBe('Acme');
    expect(held.everyEpoch()).toHaveLength(1);
  });

  /* RED WHEN: a holder given the roster alone is refused the roster, or reads the company's people. */
  it('opens the roster for a holder of the roster key alone and refuses it the people', () => {
    expect(openRoster(roster, rosterAlone).name).toBe('Acme');
    expect(() => openPerson(person, rosterAlone)).toThrow(/holds no key for the "people" records/u);
  });

  /* RED WHEN: the one check cannot open a seat's proof for a holder of the roster key alone. */
  it('opens a seat\'s proof in the one check for a holder of the roster key alone', () => {
    const wallet = { tag: 'schnorr', value: 'cd'.repeat(32) } as const;
    const { opening } = seatOpenedFor(wallet, 1);
    const proof = { committeeKey: wallet, signature: 'ab'.repeat(64), opening };
    const sealed = sealSeatProof(CO, proof, KEY);
    expect(openSeatProof(CO, sealed, rosterAlone)?.signature).toBe('ab'.repeat(64));
    expect(proofsOpenedWith(CO, [rosterAlone])({ proof: sealed } as never)?.signature).toBe('ab'.repeat(64));
    const peopleAlone: PurposeKeys = { keyFor: (p, c) => (p === 'people' ? purposeKey(KEY, c, 'people') : null) };
    expect(openSeatProof(CO, sealed, peopleAlone)).toBeNull();
  });
});

describe('a reader holding the purpose keys its grant wraps to it', () => {
  const reader = recordsKeypairFrom(new Uint8Array(32).fill(4));
  const entry = grantEntryOf({ recipient: reader.publicKey, person: 'rhea', role: 'limited' });
  const grants = {
    sequence: 1, entries: [entry], signatures: [],
    wraps: purposeWrapsFor([entry], (_epoch, purpose) => purposeKey(KEY, CO, purpose), 0),
  };
  const held = purposeWrapsHeldFrom(CO, grants, { recipient: reader.publicKey, wrappingSecret: reader.secret })!;

  /* RED WHEN: the seam does not answer a reader's purpose keys, so a reader with its wraps alone reads nothing. */
  it('opens the roster through the seam, and is refused the people, another company and any epoch it holds no wrap of', () => {
    expect(openRoster(roster, keysByPurpose(held).at(0)).name).toBe('Acme');
    expect(keysByPurpose(held).at(undefined).keyFor('roster', CO)).toBe(purposeKey(KEY, CO, 'roster'));
    expect(() => openPerson(person, keysByPurpose(held).at(0))).toThrow(/holds no key for the "people" records/u);
    expect(keysByPurpose(held).at(0).keyFor('roster', 'another')).toBeNull();
    expect(keysByPurpose(held).at(1).keyFor('roster', CO)).toBeNull();
  });

  it('names a wrap that does not open with the reader\'s key where its key is asked for, and keeps every wrap that opens', () => {
    const someoneElse = recordsKeypairFrom(new Uint8Array(32).fill(9));
    const wraps = grants.wraps[readerIdOf(reader.publicKey)]!.map((w) => (w.purpose === 'roster' ? { ...w, wrap: wrapKey(purposeKey(KEY, CO, 'roster'), someoneElse.publicKey) } : w));
    const bad = purposeWrapsHeldFrom(CO, { ...grants, wraps: { [readerIdOf(reader.publicKey)]: wraps } }, { recipient: reader.publicKey, wrappingSecret: reader.secret })!;
    /* RED WHEN: a wrap that does not open is dropped without a word, so the reader is told only that no grant names the purpose. */
    expect(bad.unopened).toEqual([{ epoch: 0, purpose: 'roster' }]);
    expect(() => keyForThePurpose(keysByPurpose(bad).at(0), CO, 'roster')).toThrow(/wrap this device a key for the "roster" records .* does not open with this device's key/u);
    /* RED WHEN: one wrap that does not open costs the reader the purposes whose wraps do. */
    expect(keysByPurpose(bad).at(0).keyFor('policy', CO)).toBe(purposeKey(KEY, CO, 'policy'));
    expect(() => keyForThePurpose(keysByPurpose(bad).at(0), CO, 'people')).toThrow(/holds no key for the "people" records/u);
  });

  /* RED WHEN: a reader's keys answer the one fallback for people sealed under payroll, which only the company key may. */
  it('answers no former key', () => {
    expect(keysByPurpose(held).at(0).formerKeyFor).toBeUndefined();
    expect(keysByPurpose(held).everyEpoch().every((k) => k.formerKeyFor === undefined)).toBe(true);
  });
});

describe('the purposes, held once', () => {
  /* RED WHEN: a record kind is sealed under a purpose the one list does not name. */
  it('names every purpose the wire seals a kind under from the one list', () => {
    for (const purpose of Object.values(SEALED_UNDER_PURPOSE)) {
      if (purpose !== 'viewing') expect(PURPOSES).toContain(purpose);
    }
    expect(SEALED_UNDER_PURPOSE.person).toBe('people');
  });
});

describe('what a read grant names for each reader role', () => {
  /* RED WHEN: an accountant is not given the people, the runs, the signers, the policies and the proposals' summaries, or is given more. */
  it('gives an accountant the people, the runs, the signers, the policies and each proposal\'s summary', () => {
    expect([...grantPurposes('accountant')].sort()).toEqual(['payroll', 'people', 'policy', 'proposals', 'roster']);
  });

  /* RED WHEN: a limited seat is given the people or the runs. */
  it('gives a limited seat the signers, the policies and each proposal\'s summary, and never the people or the runs', () => {
    expect([...grantPurposes('limited')].sort()).toEqual(['policy', 'proposals', 'roster']);
  });

  /* RED WHEN: a signer role, which holds the company key, is given a read grant as if it were a reader. */
  it('refuses to make a read grant for a signer role', () => {
    for (const role of SIGNER_ROLES) expect(() => grantPurposes(role as never)).toThrow(/not a reader role/u);
    for (const role of READER_ROLES) expect(grantPurposes(role).every((p) => PURPOSES.includes(p))).toBe(true);
  });
});
