/**
 * **A WRITE THAT WOULD PUT A SIGNER'S OWN MATERIAL, OR A FORGED MEMBERSHIP
 * PATH, INTO A STORE IS REFUSED, AND THE REFUSAL IS WATCHED FIRING.**
 *
 * -- WHAT IS BEING PINNED --------------------------------------------------
 *
 * The record a governed call runs against carries a signer's secret key, their
 * blinding factor and their scope. After a transaction that succeeds entirely,
 * the SDK writes that record back into whatever store the call was configured
 * against. A store handed the record unchanged therefore acquires a signing key
 * on the first successful call, after the money has moved and the screen has
 * said so, with nothing anywhere going red.
 *
 * The same record also carries the two fields that make a witness answer with a
 * membership path it was handed rather than one it found. Those are nobody's
 * secret, and a stored one is a signer who cannot prove they are one: the tree
 * accepts only its current root, so a path that outlives the tree turns every
 * later call into "you are not a signer on this account".
 *
 * So the property is: **what reaches a store is the account's half and nothing
 * else.** These cases are what turns that from a sentence into a red build.
 *
 * -- THE CASES THAT MATTER ARE THE NEGATIVE ONES ---------------------------
 *
 * A test that only asserted the dropping of some named fields would pass
 * against a function that dropped those and kept a sixth nobody listed, and
 * against a record that never had them. So every case below is driven from a
 * REAL record - the same one the contract tests build a device from - and the
 * kept set is asserted exactly, so a field added to the record is a red case
 * asking which half it belongs to rather than a field that quietly rides along
 * into a store.
 */
import { describe, expect, it } from 'vitest';

import { privateStateFor } from '../../contracts/test/simulator.js';
import type { AccountPrivateState } from '../../contracts/src/witnesses.js';
import {
  NEVER_PERSISTED_FIELDS,
  SIGNER_ONLY_FIELDS,
  neverPersistedFieldsIn,
  persistableAccountHalf,
  refuseToPersistWhatMustNotBeStored,
  signerSecretsIn,
} from './what-a-device-may-persist.js';

/** A real device record, not a shape written here to match the assertion. */
const deviceRecord = (): AccountPrivateState => privateStateFor(1);

/**
 * A stand-in for the one line the SDK runs after a settled call: something that
 * writes what it is handed.
 *
 * Deliberately the least clever thing that can be written - a map and a `set` -
 * because what is under test is what arrives at it, not what it does. It is not
 * a provider, it implements no interface, and nothing outside this file reaches
 * it.
 */
const aStoreThatWritesWhatItIsGiven = () => {
  const written = new Map<string, unknown>();
  return {
    written,
    set(key: string, value: unknown) { written.set(key, value); },
  };
};

describe('what a device may write down', () => {
  it('the signer material named is exactly the three that are one person\'s', () => {
    expect(Object.keys(SIGNER_ONLY_FIELDS).sort()).toEqual(['blinding', 'scope', 'secretKey'].sort());
  });

  /**
   * **THE TWO PATH SEAMS ARE ON THE LIST, AND THIS IS THE CASE THAT SAYS SO.**
   * They are not secrets, they are refused for a different reason, and the
   * reason is carried beside them rather than left to be rediscovered.
   */
  it('and the full list adds the two that forge a membership path, with the reason', () => {
    expect(Object.keys(NEVER_PERSISTED_FIELDS).sort())
      .toEqual(['blinding', 'pinAnyLeaf', 'pinnedPath', 'scope', 'secretKey']);
    expect(NEVER_PERSISTED_FIELDS.pinnedPath).toMatch(/signer tree moves/);
    expect(NEVER_PERSISTED_FIELDS.secretKey).toMatch(/lives only in their keyring/);
  });

  /**
   * **THE KEPT SET IS ASSERTED EXACTLY, WHICH IS THE RATCHET.**
   *
   * A record that grows a field lands here rather than in a store: this case
   * goes red, and whoever added it has to say whether it is the account's or
   * something a device may only hold in memory. The alternative - asserting
   * only that the known ones are gone - lets the next one through on the day it
   * is added.
   */
  it('keeps the account half and nothing else, from a real record', () => {
    const kept = persistableAccountHalf(deviceRecord());
    expect(Object.keys(kept).sort(),
      'the record a device holds has changed shape. Say which half the new field belongs to: '
      + "the account's, which is staged before a call and has to survive a proof, or the kind "
      + 'that must not have a second copy in the store a call writes back to')
      .toEqual(['assetBlinding', 'assetId', 'changeAmount', 'changeBatchDigest', 'proposalSalt']);
  });

  it('leaves the record it was given untouched, because the call is still reading it', () => {
    const record = deviceRecord();
    persistableAccountHalf(record);
    expect(signerSecretsIn(record)).toEqual(['secretKey', 'blinding', 'scope']);
    expect(neverPersistedFieldsIn(record))
      .toEqual(['secretKey', 'blinding', 'scope', 'pinnedPath', 'pinAnyLeaf']);
  });

  /**
   * **PRESENCE AND NOT TRUTHINESS, AND THE DISTINCTION WAS MEASURED RATHER
   * THAN ASSUMED.**
   *
   * A thirty-two byte array of zeroes is TRUTHY, so a truthiness check catches
   * that one anyway - the first version of this case claimed otherwise and a
   * mutation run showed it staying green. What a truthiness check genuinely
   * walks past is a field that is PRESENT AND EMPTY: a zero-length key, or a
   * key spread in from a record where it was optional and undefined. Both are
   * records that carry the field, and a store handed one is a store that has
   * been handed a signer's field to write.
   *
   * **AND IT IS WHY `pinnedPath: null` COUNTS.** A device record that has never
   * pinned anything carries the field with a null in it, and a truthiness check
   * would report that record as carrying nothing to worry about - which is true
   * of the value and false of the field.
   */
  it('names an empty secret key, which a truthiness check would walk past', () => {
    expect(signerSecretsIn({ secretKey: new Uint8Array(0) })).toEqual(['secretKey']);
  });

  it('names a scope that is present and undefined, for the same reason', () => {
    expect(signerSecretsIn({ proposalSalt: new Uint8Array(32), scope: undefined }))
      .toEqual(['scope']);
  });

  it('names a pinnedPath that is present and null', () => {
    expect(neverPersistedFieldsIn({ proposalSalt: new Uint8Array(32), pinnedPath: null }))
      .toEqual(['pinnedPath']);
  });

  it('names all three secrets on a real record, zero-filled or not', () => {
    expect(signerSecretsIn({ ...deviceRecord(), scope: new Uint8Array(32) }))
      .toEqual(['secretKey', 'blinding', 'scope']);
  });

  /* ---------------- the negative controls, watched going red ---------------- */

  /**
   * **A WRITE OF THE WHOLE RECORD IS REFUSED, AND THE REFUSAL NAMES EVERYTHING
   * IT CARRIES.** This is the shape the SDK's own write-back has, and it is the
   * one that must not be quiet.
   */
  it('REFUSES a set that would write the record unchanged, naming every field it carries', () => {
    const store = aStoreThatWritesWhatItIsGiven();
    const record = deviceRecord();

    expect(() => {
      refuseToPersistWhatMustNotBeStored(record, 'the private state store');
      store.set('account:1', record);
    }).toThrow(/secretKey .*blinding .*scope .*pinnedPath .*pinAnyLeaf/);

    expect(store.written.size, 'the refusal fired and the write happened anyway').toBe(0);
  });

  it.each(['secretKey', 'blinding', 'scope', 'pinnedPath', 'pinAnyLeaf'] as const)(
    'REFUSES a set carrying only %s, so dropping four of the five is not enough',
    (field) => {
      const store = aStoreThatWritesWhatItIsGiven();
      const record = { proposalSalt: new Uint8Array(32), [field]: new Uint8Array(32) };

      expect(() => {
        refuseToPersistWhatMustNotBeStored(record, 'the private state store');
        store.set('account:1', record);
      }).toThrow(new RegExp(`\\b${field}\\b`));

      expect(store.written.size).toBe(0);
    },
  );

  it('says why, not only what, so the next reader does not move one back', () => {
    expect(() => refuseToPersistWhatMustNotBeStored({ pinnedPath: null }, 'the store'))
      .toThrow(/pinnedPath \(a membership path that stops verifying when the signer tree moves\)/);
  });

  /**
   * **AND THE OTHER DIRECTION, WHICH IS WHAT MAKES THE CASES ABOVE WORTH
   * HAVING.** A refusal that fired on everything would pass every case above
   * and stop the product working. The account half goes through, and what lands
   * in the store is asserted to be the account half rather than asserted to be
   * non-empty.
   */
  it('lets the account half through, and what lands in the store carries none of the five', () => {
    const store = aStoreThatWritesWhatItIsGiven();
    const toWrite = persistableAccountHalf(deviceRecord());

    refuseToPersistWhatMustNotBeStored(toWrite, 'the private state store');
    store.set('account:1', toWrite);

    expect(store.written.size).toBe(1);
    expect(neverPersistedFieldsIn(store.written.get('account:1'))).toEqual([]);
    expect((store.written.get('account:1') as any).proposalSalt).toEqual(deviceRecord().proposalSalt);
  });

  it('says nothing about a record that never carried any of them', () => {
    expect(neverPersistedFieldsIn({ proposalSalt: new Uint8Array(32) })).toEqual([]);
    expect(() => refuseToPersistWhatMustNotBeStored({ proposalSalt: new Uint8Array(32) }, 'anything'))
      .not.toThrow();
  });
});
