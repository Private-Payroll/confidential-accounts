/**
 * A vault's spending policy as one of the company's records: sealed to each
 * signer, opened only as the record it is filed as, and taken only when its
 * opening makes the commitment asked for. The contract's own commitment is
 * stood in for by a function named below; the real one is driven in
 * `contracts/test/a-spending-policy-is-set-from-a-device.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { newWrappingKeypair, type Hex } from '../core/crypto.js';
import {
  openSpendingPolicy, policyOpeningFor, policyOpeningFromWire, sealSpendingPolicy, type PolicyOpeningOnTheWire,
} from './spending-policy-record.js';

const ada = newWrappingKeypair();
const blake = newWrappingKeypair();
const SIGNERS = [{ id: 'ada', wrappingPublicKey: ada.publicKey }, { id: 'blake', wrappingPublicKey: blake.publicKey }];
const ID = 'a1'.repeat(32);
const VAULT = 'fa'.repeat(32);
const ASSET = 'ce'.repeat(32);
const OPENING: PolicyOpeningOnTheWire = {
  terms: {
    bands: [{ ceiling: '10', approvals: '1' }, { ceiling: '20', approvals: '2' }, { ceiling: '30', approvals: '2' }, { ceiling: '40', approvals: '2' }],
    periodLimit: '100', periodStart: '0', periodLength: '60',
  },
  blinding: 'b0'.repeat(32),
};
const sealed = (version: number, opening = OPENING, id = ID) => sealSpendingPolicy({
  company: 'acme', id, version, keyEpoch: 0, secrets: { vault: VAULT, asset: ASSET, opening }, signers: SIGNERS,
});
/* A stand-in for the contract's commitment: the opening's limit and blinding, which is all these tests tell apart. */
const commitmentOf = (o: PolicyOpeningOnTheWire): Hex => `${o.terms.periodLimit}:${o.blinding}`;

describe('A VAULT\'S SPENDING POLICY, KEPT AS A RECORD OF THE COMPANY\'S', () => {
  it('EVERY SIGNER IT IS SEALED TO OPENS IT, AND NOBODY ELSE', () => {
    const rec = sealed(1);
    expect(openSpendingPolicy(rec, { signerId: 'blake', wrappingSecret: blake.secret }).secrets.opening).toEqual(OPENING);
    /* RED WHEN: a signer the record was not sealed to can open it. */
    expect(() => openSpendingPolicy(rec, { signerId: 'cleo', wrappingSecret: newWrappingKeypair().secret }))
      .toThrow(/was not sealed to you/u);
  });

  it('A VERSION FILED UNDER ANOTHER RECORD OR ANOTHER VERSION THAN IT WAS SEALED AS DOES NOT OPEN', () => {
    const me = { signerId: 'ada', wrappingSecret: ada.secret };
    /* RED WHEN: the record's id sealed inside it is not checked - a policy filed for one vault opens as another's. */
    expect(() => openSpendingPolicy({ ...sealed(1, OPENING, 'b2'.repeat(32)), id: ID }, me)).toThrow(/another record or another version/u);
    /* RED WHEN: the version sealed inside it is not checked - an old policy is served as the newest. */
    expect(() => openSpendingPolicy({ ...sealed(1), version: 2 }, me)).toThrow(/another record or another version/u);
  });

  it('ONLY THE VERSION THAT MAKES THE COMMITMENT ASKED FOR IS TAKEN, AND NONE IS GUESSED', async () => {
    const me = { signerId: 'ada', wrappingSecret: ada.secret };
    const other = { ...OPENING, terms: { ...OPENING.terms, periodLimit: '1' } };
    const versions = [sealed(1), sealed(2, other)];
    const want = { vault: VAULT, asset: ASSET, commitment: commitmentOf(OPENING) };
    expect((await policyOpeningFor(versions, me, want, commitmentOf)).version).toBe(1);
    /* RED WHEN: a version for another vault is taken because its commitment matches. */
    await expect(policyOpeningFor(versions, me, { ...want, vault: '0f'.repeat(32) }, commitmentOf)).rejects.toThrow(/None of the company's records/u);
    await expect(policyOpeningFor([sealed(2, other)], me, want, commitmentOf)).rejects.toThrow(/None of the company's records/u);
  });

  it('A POLICY THE CONTRACT COULD NOT OPEN IS REFUSED BEFORE IT IS SEALED', () => {
    /* RED WHEN: a policy with three bands is sealed - the contract's Vector<4, Band> could never open it. */
    expect(() => sealed(1, { ...OPENING, terms: { ...OPENING.terms, bands: OPENING.terms.bands.slice(0, 3) } })).toThrow(/exactly 4 bands/u);
    /* RED WHEN: periods of no length are sealed - no run could ever be charged to one. */
    expect(() => policyOpeningFromWire({ ...OPENING, terms: { ...OPENING.terms, periodLength: '0' } })).toThrow(/at least one second/u);
    expect(() => policyOpeningFromWire({ ...OPENING, blinding: 'zz' })).toThrow(/thirty-two bytes/u);
  });
});
