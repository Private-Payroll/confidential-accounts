import { beforeEach, describe, expect, it } from 'vitest';
import { EMAIL, FAMILY_NAME, GIVEN_NAME, REGISTRY, registryOf } from './attributes.js';
import { define } from './definition.js';
import {
  ProfileError, changed, editValue, emptyProfile, forgetValue, grantTo, heldAbout,
  isExpired, recordDisclosure, recordIssued, relabel, selfAssert,
} from './model.js';
import type { Profile, Recipient, SignedBytes } from './model.js';

const NOW = 1_755_000_000_000;
const recipient: Recipient = {
  origin: 'https://payroll-a.example', name: 'Payroll A', rdns: 'example.payroll-a',
};

/*
 * A `signed` FOR THE FIXTURES IN THIS FILE, AND IT IS NOT EVIDENCE.
 *
 * `recordDisclosure` now demands the exact bytes that were signed (§5.5). The
 * tests below are about the HISTORY's behaviour — that it appends, that editing
 * a value does not rewrite it, that removing one leaves it — and none of them is
 * about the bytes. **So this is a syntactically valid record and a real
 * signature of nothing**, named to say so rather than dressed up as one.
 *
 * The real thing is checked in `disclosure.test.ts`, against entries built by
 * `mint` from a real key: the bytes decode, the signature verifies over them,
 * and what comes out equals the fields stored beside them.
 */
const notARealSignature = (): SignedBytes => ({
  bytes: 'AAAA',
  signature: '00'.repeat(64),
  verifyingKey: '00'.repeat(32),
  scheme: 'schnorr',
});

let profile: Profile;
beforeEach(() => { profile = emptyProfile(NOW); });

const withName = (p: Profile, name: string, label = ''): Profile =>
  selfAssert(p, REGISTRY, GIVEN_NAME, name, label, NOW);

describe('provenance is in the model, not beside it', () => {
  it('a self-asserted value says so and names no issuer', () => {
    const p = withName(profile, 'Sarah');
    expect(p.held[0]!.asserted).toEqual({ by: 'self', formerly: null });
  });

  it('an issued record must carry a date, or it is not evidence', () => {
    const registry = registryOf([...REGISTRY.all, define({
      name: 'a-checked-thing',
      version: 1,
      source: 'stated',
      validate: { of: 'text', minLength: 1, maxLength: 40 },
      selfAssertable: false,
      acceptedIssuers: ['an-issuer'],
      multiple: false,
      sensitivity: 'sensitive',
      render: { label: 'A checked thing', hint: '', abbreviate: 'none' },
      provable: [],
    })]);
    expect(() => recordIssued(
      profile, registry, 'a-checked-thing', { of: 'value', value: 'yes' }, '',
      {
        by: 'issuer', issuer: 'an-issuer', signature: 'ff',
        issuedAt: Number.NaN, expiresAt: null, reachableAt: null,
      }, NOW)).toThrow(ProfileError);
  });

  it('a null expiry means THE ISSUER SET NONE, and is not the same as expired', () => {
    const asserted = {
      by: 'issuer' as const, issuer: 'x', signature: 'f',
      issuedAt: NOW, expiresAt: null, reachableAt: null,
    };
    expect(isExpired(asserted, NOW + 10_000_000)).toBe(false);
    expect(isExpired({ ...asserted, expiresAt: NOW + 1 }, NOW + 2)).toBe(true);
    expect(isExpired({ by: 'self', formerly: null }, NOW)).toBe(false);
  });
});

describe('§3.2c — a claim is not a value, and the model cannot flatten it', () => {
  const registry = registryOf([...REGISTRY.all, define({
    name: 'date-of-birth',
    version: 1,
    source: 'stated',
    validate: { of: 'date' },
    selfAssertable: false,
    acceptedIssuers: 'any',
    multiple: false,
    sensitivity: 'sensitive',
    render: { label: 'Date of birth', hint: '', abbreviate: 'none' },
    provable: ['over-18'],
  })]);

  it('the wallet holds a PREDICATE about an attribute it has no value for', () => {
    const p = recordIssued(
      profile, registry, 'date-of-birth',
      { of: 'predicate', predicate: 'over-18', result: true }, '',
      {
        by: 'issuer', issuer: 'an-issuer', signature: 'ab',
        issuedAt: NOW, expiresAt: NOW + 86_400_000, reachableAt: 'https://issuer.example',
      }, NOW);
    const held = p.held[0]!;
    expect(held.about).toBe('date-of-birth');
    expect(held.says).toEqual({ of: 'predicate', predicate: 'over-18', result: true });
    /* THE POINT: there is no `value` field to have invented. */
    expect('value' in held.says).toBe(false);
    /* And no date of birth was written down anywhere. */
    expect(JSON.stringify(p)).not.toContain('1990');
  });

  it('a predicate is NOT checked against the attribute\'s rule, because there is no text', () => {
    /* `date-of-birth` is a date rule. `over-18: true` is not a date and must
     * not be pushed through a date check to be stored. */
    expect(() => recordIssued(
      profile, registry, 'date-of-birth',
      { of: 'predicate', predicate: 'over-18', result: true }, '',
      {
        by: 'issuer', issuer: 'i', signature: 'ab', issuedAt: NOW,
        expiresAt: null, reachableAt: null,
      }, NOW)).not.toThrow();
  });

  it('an issued VALUE is still checked against the rule', () => {
    expect(() => recordIssued(
      profile, registry, 'date-of-birth', { of: 'value', value: 'the nineties' }, '',
      {
        by: 'issuer', issuer: 'i', signature: 'ab', issuedAt: NOW,
        expiresAt: null, reachableAt: null,
      }, NOW)).toThrow(ProfileError);
  });

  it('an issued record records where to ask again — decision 4 needs it', () => {
    const p = recordIssued(
      profile, registry, 'date-of-birth',
      { of: 'predicate', predicate: 'over-18', result: true }, '',
      {
        by: 'issuer', issuer: 'i', signature: 'ab', issuedAt: NOW,
        expiresAt: null, reachableAt: 'https://issuer.example/again',
      }, NOW);
    expect(p.held[0]!.asserted).toMatchObject({ reachableAt: 'https://issuer.example/again' });
  });

  it('AN ISSUER NOT ON THE ENTRY\'S LIST IS REFUSED BY NAME', () => {
    /* The survivor this closes: the `null` case was tested and the LIST case
     * was not, so deleting the membership check left the suite green while any
     * issuer on earth could vouch for anything. */
    const registry = registryOf([...REGISTRY.all, define({
      name: 'checked-by-one-service',
      version: 1,
      source: 'stated',
      validate: { of: 'text', minLength: 1, maxLength: 40 },
      selfAssertable: false,
      acceptedIssuers: ['a-checking-service'],
      multiple: false,
      sensitivity: 'sensitive',
      render: { label: 'Checked by one service', hint: '', abbreviate: 'none' },
      provable: [],
    })]);
    const from = (issuer: string): Profile => recordIssued(
      profile, registry, 'checked-by-one-service', { of: 'value', value: 'ok' }, '',
      {
        by: 'issuer', issuer, signature: 'ab', issuedAt: NOW,
        expiresAt: null, reachableAt: null,
      }, NOW);
    expect(() => from('a-checking-service')).not.toThrow();
    for (const stranger of ['someone-else', 'a-checking-service.evil', '']) {
      try {
        from(stranger);
        throw new Error(`should have refused ${stranger}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ProfileError);
        expect((e as ProfileError).code).toBe('issuer-not-accepted');
      }
    }
  });

  it('nothing may be issued about an attribute whose acceptedIssuers is null', () => {
    expect(() => recordIssued(
      profile, REGISTRY, GIVEN_NAME, { of: 'value', value: 'Sarah' }, '',
      {
        by: 'issuer', issuer: 'i', signature: 'ab', issuedAt: NOW,
        expiresAt: null, reachableAt: null,
      }, NOW)).toThrow(ProfileError);
  });
});

describe('§3.2b — a person edits their own values freely', () => {
  it('typing a new name replaces the old one and versions nothing', () => {
    const p = withName(profile, 'Sarah');
    const after = editValue(p, REGISTRY, p.held[0]!.id, 'Sara', NOW + 1);
    expect(after.held).toHaveLength(1);
    expect(after.held[0]!.says).toEqual({ of: 'value', value: 'Sara' });
    expect(after.held[0]!.asserted).toEqual({ by: 'self', formerly: null });
  });

  it('EDITING AN ISSUED VALUE DROPS IT TO SELF-ASSERTED, naming what it was', () => {
    const registry = registryOf([...REGISTRY.all, define({
      name: 'a-checked-name',
      version: 1,
      source: 'stated',
      validate: { of: 'text', minLength: 1, maxLength: 40 },
      selfAssertable: true,
      acceptedIssuers: 'any',
      multiple: false,
      sensitivity: 'ordinary',
      render: { label: 'A checked name', hint: '', abbreviate: 'none' },
      provable: [],
    })]);
    const p = recordIssued(
      profile, registry, 'a-checked-name', { of: 'value', value: 'Sarah Jones' }, '',
      {
        by: 'issuer', issuer: 'a-registrar', signature: 'cd', issuedAt: NOW - 1000,
        expiresAt: null, reachableAt: null,
      }, NOW);
    const after = editValue(p, registry, p.held[0]!.id, 'Sarah Smith', NOW + 1);
    expect(after.held[0]!.asserted).toEqual({
      by: 'self', formerly: { issuer: 'a-registrar', issuedAt: NOW - 1000 },
    });
  });

  it('a CLAIM cannot be edited at all — there is no text in it to change', () => {
    const registry = registryOf([...REGISTRY.all, define({
      name: 'a-proved-thing',
      version: 1,
      source: 'stated',
      validate: { of: 'date' },
      selfAssertable: false,
      acceptedIssuers: 'any',
      multiple: false,
      sensitivity: 'sensitive',
      render: { label: 'A proved thing', hint: '', abbreviate: 'none' },
      provable: ['over-18'],
    })]);
    const p = recordIssued(
      profile, registry, 'a-proved-thing',
      { of: 'predicate', predicate: 'over-18', result: true }, '',
      {
        by: 'issuer', issuer: 'i', signature: 'ab', issuedAt: NOW,
        expiresAt: null, reachableAt: null,
      }, NOW);
    expect(() => editValue(p, registry, p.held[0]!.id, 'false', NOW + 1))
      .toThrow(/cannot be edited/u);
  });

  it('a label is not a fact and changing it never touches provenance', () => {
    const p = withName(profile, 'Sarah', 'legal');
    const after = relabel(p, p.held[0]!.id, 'trading', NOW + 1);
    expect(after.held[0]!.label).toBe('trading');
    expect(after.held[0]!.asserted).toEqual(p.held[0]!.asserted);
  });

  it('an attribute that allows several values holds several', () => {
    let p = selfAssert(profile, REGISTRY, EMAIL, 'a@work.example', 'work', NOW);
    p = selfAssert(p, REGISTRY, EMAIL, 'b@home.example', 'personal', NOW);
    expect(heldAbout(p, EMAIL)).toHaveLength(2);
  });

  it('an attribute that allows one refuses a second, by name', () => {
    const registry = registryOf([define({
      name: 'one-only',
      version: 1,
      source: 'stated',
      validate: { of: 'text', minLength: 1, maxLength: 10 },
      selfAssertable: true,
      acceptedIssuers: null,
      multiple: false,
      sensitivity: 'ordinary',
      render: { label: 'One only', hint: '', abbreviate: 'none' },
      provable: [],
    })]);
    const p = selfAssert(profile, registry, 'one-only', 'a', '', NOW);
    expect(() => selfAssert(p, registry, 'one-only', 'b', '', NOW)).toThrow(ProfileError);
  });

  it('an attribute this vocabulary does not know is refused, never invented', () => {
    expect(() => selfAssert(profile, REGISTRY, 'national-insurance-number', 'x', '', NOW))
      .toThrow(ProfileError);
  });

  it('a value is recorded under the definition VERSION it was stored by', () => {
    const p = withName(profile, 'Sarah');
    expect(p.held[0]!.definitionVersion).toBe(1);
  });
});

describe('a grant names VALUES, and a disclosure records CONTENT', () => {
  it('a grant refuses an id nothing holds', () => {
    expect(() => grantTo(profile, recipient, 3, ['nope'], NOW)).toThrow(ProfileError);
  });

  it('THE HISTORY DOES NOT CHANGE WHEN THE VALUE DOES', () => {
    let p = withName(profile, 'Sarah');
    const id = p.held[0]!.id;
    p = grantTo(p, recipient, 3, [id], NOW);
    p = recordDisclosure(p, recipient, 3, {
      at: NOW,
      /* `recordDisclosure` demands the kind, the same way the design made it
       * demand the bytes. These fixtures are about the HISTORY's behaviour and
       * every one of them is the kind that already existed. */
      kind: 'disclosure' as const,
      nonce: 'n1',
      sent: [{
        id, about: GIVEN_NAME, says: { of: 'value', value: 'Sarah' },
        asserted: { by: 'self', formerly: null },
      }],
      declined: [],
      signed: notARealSignature(),
    }, NOW);
    p = editValue(p, REGISTRY, id, 'Sara', NOW + 1);
    /* What they were told is still what they were told. */
    expect(p.grants[0]!.disclosures[0]!.sent[0]!.says).toEqual({ of: 'value', value: 'Sarah' });
    expect(p.held[0]!.says).toEqual({ of: 'value', value: 'Sara' });
  });

  it('and the wallet can NAME the gap without implying it can close it', () => {
    let p = withName(profile, 'Sarah');
    const id = p.held[0]!.id;
    p = recordDisclosure(p, recipient, 3, {
      at: NOW,
      /* `recordDisclosure` demands the kind, the same way the design made it
       * demand the bytes. These fixtures are about the HISTORY's behaviour and
       * every one of them is the kind that already existed. */
      kind: 'disclosure' as const,
      nonce: 'n1',
      sent: [{
        id, about: GIVEN_NAME, says: { of: 'value', value: 'Sarah' },
        asserted: { by: 'self', formerly: null },
      }],
      declined: [],
      signed: notARealSignature(),
    }, NOW);
    expect(changed(p)).toHaveLength(0);
    p = editValue(p, REGISTRY, id, 'Sara', NOW + 1);
    const stale = changed(p);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({
      about: GIVEN_NAME,
      theyHold: { of: 'value', value: 'Sarah' },
      itNowSays: { of: 'value', value: 'Sara' },
      recipient,
    });
  });

  it('removing a value leaves the history and drops it from every grant', () => {
    let p = withName(profile, 'Sarah');
    const id = p.held[0]!.id;
    p = grantTo(p, recipient, 3, [id], NOW);
    p = recordDisclosure(p, recipient, 3, {
      at: NOW,
      /* `recordDisclosure` demands the kind, the same way the design made it
       * demand the bytes. These fixtures are about the HISTORY's behaviour and
       * every one of them is the kind that already existed. */
      kind: 'disclosure' as const,
      nonce: 'n1',
      sent: [{
        id, about: GIVEN_NAME, says: { of: 'value', value: 'Sarah' },
        asserted: { by: 'self', formerly: null },
      }],
      declined: [],
      signed: notARealSignature(),
    }, NOW);
    p = forgetValue(p, id, NOW + 1);
    expect(p.held).toHaveLength(0);
    expect(p.grants[0]!.values).toHaveLength(0);
    expect(p.grants[0]!.disclosures[0]!.sent).toHaveLength(1);
    expect(changed(p)[0]).toMatchObject({ itNowSays: null });
  });

  it('the disclosure history is APPEND-ONLY', () => {
    let p = withName(profile, 'Sarah');
    const entry = {
      at: NOW,
      /* `recordDisclosure` demands the kind, the same way the design made it
       * demand the bytes. These fixtures are about the HISTORY's behaviour and
       * every one of them is the kind that already existed. */
      kind: 'disclosure' as const,
      nonce: 'n1',
      sent: [],
      declined: [FAMILY_NAME],
      signed: notARealSignature(),
    };
    p = recordDisclosure(p, recipient, 3, entry, NOW);
    p = recordDisclosure(p, recipient, 3, { ...entry, nonce: 'n2', at: NOW + 5 }, NOW + 5);
    expect(p.grants[0]!.disclosures.map((d) => d.nonce)).toEqual(['n1', 'n2']);
  });

  it('one grant per recipient PER SUBWALLET — the same company on two slots is two', () => {
    let p = withName(profile, 'Sarah');
    const id = p.held[0]!.id;
    p = grantTo(p, recipient, 3, [id], NOW);
    p = grantTo(p, recipient, 4, [id], NOW);
    expect(p.grants).toHaveLength(2);
    p = grantTo(p, recipient, 3, [], NOW + 1);
    expect(p.grants).toHaveLength(2);
    expect(p.grants[0]!.values).toHaveLength(0);
  });
});
