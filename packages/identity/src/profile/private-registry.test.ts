import { describe, expect, it } from 'vitest';
import { identityFromSecret } from '../keys/derivation.js';
import { companyLabelOf } from './company-label.js';
import {
  ENTRY_BYTES, entrySealingKey, neverZero, openEntry, registryKey, RegistryEntryError, sealEntry, tagAt, type RegistryEntry,
} from './private-registry.js';

const person = identityFromSecret(new Uint8Array(32).fill(7));
const other = identityFromSecret(new Uint8Array(32).fill(8));
const LABEL = companyLabelOf(new Uint8Array(32).fill(0xc1));
const entry: RegistryEntry = {
  label: LABEL, account: 'a1'.repeat(32), n: 3, scope: 'b2'.repeat(32),
  rights: { mayRaise: true, mayApprove: false, mayHold: true, everyVault: false, vaults: ['d4'.repeat(32), 'e5'.repeat(32)] },
};

describe('A SIGNER SEAT\'S ENTRY IN A PRIVATE REGISTRY', () => {
  it('is sealed to exactly the registry\'s value size and opens to what was sealed', () => {
    const sealed = sealEntry(person, 'preprod', 0, entry);
    /* RED WHEN: the sealed value is not the contract's Bytes<288>. */
    expect(sealed.length).toBe(ENTRY_BYTES);
    /* RED WHEN: any field is lost or changed on the way through the seal. */
    expect(openEntry(person, 'preprod', 0, sealed)).toEqual(entry);
    const plain: RegistryEntry = { label: LABEL, account: 'a1'.repeat(32), n: 0, scope: 'b2'.repeat(32) };
    /* RED WHEN: a seat with no rights record opens as one with rights. */
    expect(openEntry(person, 'preprod', 5, sealEntry(person, 'preprod', 5, plain))).toEqual(plain);
  });

  it('opens under no other words', () => {
    /* RED WHEN: another person's words open this person's entry. */
    expect(openEntry(other, 'preprod', 0, sealEntry(person, 'preprod', 0, entry))).toBeNull();
    expect(entrySealingKey(person, 'preprod')).not.toEqual(entrySealingKey(other, 'preprod'));
  });

  it('does not open once moved to another tag or read on another network', () => {
    const sealed = sealEntry(person, 'preprod', 0, entry);
    /* RED WHEN: the tag is not bound into the seal, so a value copied to another tag opens there. */
    expect(openEntry(person, 'preprod', 1, sealed)).toBeNull();
    /* RED WHEN: the network is not bound into the seal. */
    expect(openEntry(person, 'mainnet', 0, sealed)).toBeNull();
  });

  it('refuses a value with any byte changed', () => {
    const sealed = sealEntry(person, 'preprod', 2, entry);
    /* RED WHEN: a changed byte anywhere, iv, body or tag, still opens. */
    for (const at of [0, 11, 12, 100, ENTRY_BYTES - 1]) {
      const changed = new Uint8Array(sealed);
      changed[at] = changed[at]! ^ 1;
      expect(openEntry(person, 'preprod', 2, changed), `byte ${at}`).toBeNull();
    }
    /* RED WHEN: a value of another length is read as an entry. */
    expect(openEntry(person, 'preprod', 2, sealed.slice(1))).toBeNull();
  });

  it('gives each network its own tags and keys, and each index its own tag', () => {
    /* RED WHEN: the network is not part of the tag, so one network's entries are found on another. */
    expect(tagAt(person, 'preprod', 0)).not.toBe(tagAt(person, 'mainnet', 0));
    expect(registryKey(person, 'preprod')).not.toEqual(registryKey(person, 'mainnet'));
    /* RED WHEN: two indexes give one tag. */
    expect(new Set([0, 1, 2, 3].map((i) => tagAt(person, 'preprod', i))).size).toBe(4);
    /* RED WHEN: a tag is not the same every time from the same words. */
    expect(tagAt(person, 'preprod', 7)).toBe(tagAt(identityFromSecret(new Uint8Array(32).fill(7)), 'preprod', 7));
    expect(tagAt(person, 'preprod', 0)).toMatch(/^[0-9a-f]{64}$/u);
    expect(tagAt(person, 'preprod', 0)).not.toBe(tagAt(other, 'preprod', 0));
  });

  it('never makes the all-zero tag the registry refuses', () => {
    /* RED WHEN: a derivation that came out all zero is used as it is. */
    expect(neverZero(new Uint8Array(32)).some((b) => b !== 0)).toBe(true);
    const some = new Uint8Array(32).fill(3);
    expect(neverZero(some)).toBe(some);
  });

  it('refuses to seal what is not a seat\'s entry', () => {
    /* RED WHEN: an account that is not 32 bytes is sealed. */
    expect(() => sealEntry(person, 'preprod', 0, { ...entry, account: 'a1' })).toThrow(RegistryEntryError);
    /* RED WHEN: rights naming more vaults than a seat's rights hold are sealed. */
    expect(() => sealEntry(person, 'preprod', 0, { ...entry, rights: { ...entry.rights!, vaults: Array(5).fill('d4'.repeat(32)) } }))
      .toThrow(RegistryEntryError);
    /* RED WHEN: a negative index makes a tag. */
    expect(() => tagAt(person, 'preprod', -1)).toThrow(RegistryEntryError);
  });
});
