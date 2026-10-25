import { beforeEach, describe, expect, it } from 'vitest';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { keyringKeyFor } from 'midnight-identity/profile/unlock';
import { seal, toHex, unseal } from '../../../../src/core/crypto.js';
import {
  counterOf, sealedDigestOf, sealKeyring, withCreation, withNewSeat, withoutCreation, type Keyring,
} from '../../../../packages/web-shared/src/keyring-blob.js';
import { forgetOpenWallet } from '../accounts/wallets-held.js';
import { keyringMarkOf, raiseKeyringMark } from '../accounts/storage.js';
import { keyringMarksFor, openHeldKeyring, SavedKeysRefused, SeatChangeRefused, type KeyringMark, type KeyringMarks } from './held-keyring.js';
import { keyringSealKeyFor } from './seal-key.js';

/*
 * **THE WALLET OPENS A PERSON'S SAVED KEYS, CHANGES THEM AND SEALS THEM AGAIN, AND AN OLDER COPY IS REFUSED.** The
 * page carries the sealed copy the service gave it; this wallet derives the key, remembers the highest count of
 * writes it has opened or seen kept, and opens nothing older.
 */

const PAGE = 'https://app.payroll.example';
const ASK = { requester: { origin: PAGE, name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a' };
const secret = newSecret();
const identity = identityFromSecret(secret);
const KEY = toHex(keyringSealKeyFor(identity, ASK));
const SEAT = { signerId: 'sig_1', signingSecret: '11'.repeat(32), wrappingSecret: '22'.repeat(32), blinding: '33'.repeat(32), scope: '44'.repeat(32) };

const marksInMemory = (): KeyringMarks & { readonly seen: Map<string, KeyringMark>; count(p: string): number | undefined } => {
  const seen = new Map<string, KeyringMark>();
  return {
    seen,
    count: (p) => seen.get(p)?.counter,
    markOf: (p) => seen.get(p) ?? null,
    raise: (p, m) => { if ((seen.get(p)?.counter ?? -1) < m.counter) seen.set(p, m); },
  };
};
/** A mark as this wallet would have kept it on opening `sealed`. */
const markFor = (sealed: ReturnType<typeof seal>, counter: number): KeyringMark => ({ counter, digest: sealedDigestOf(sealed), under: 2 });
/** Saved keys as the page writes them: sealed by the same format, `count` writes on. */
const writtenByThePage = (k: Keyring, count: number) => sealKeyring({ ...k, counter: count - 1 }, KEY).sealed;
const opening = (sealed: ReturnType<typeof seal> | null, marks: KeyringMarks, version = 7) =>
  openHeldKeyring({ identity, ask: ASK, handedIn: { sealed, version }, marks });
const refusedWith = (f: () => unknown): string => {
  try { f(); } catch (e) { if (e instanceof SavedKeysRefused) return e.why; throw e; }
  return 'opened';
};

describe('the wallet opens saved keys, changes them and seals them again', () => {
  it('opens what the page sealed, seals the change one write on over the version handed in, and counts it once kept', () => {
    const marks = marksInMemory();
    const held = opening(writtenByThePage({ accounts: {} }, 3), marks);
    /* RED WHEN: saved keys the page sealed do not open in the wallet with the key it derives for the person. */
    expect(counterOf(held.read())).toBe(3);
    expect(marks.count('usr_a')).toBe(3);
    const again = held.seal((k) => withNewSeat(k, 'acc_A', SEAT));
    /* RED WHEN: the wallet seals a change at a count that is not one on from the keys it opened, or over another version. */
    expect(again.counter).toBe(4);
    expect(again.ifVersion).toBe(7);
    const inside = JSON.parse(unseal(again.sealed, KEY));
    expect(inside.counter).toBe(4);
    expect(inside.accounts.acc_A.signingSecret).toBe(SEAT.signingSecret);
    /* RED WHEN: sealed keys are counted as the newest before the page says the service kept them. */
    expect(marks.count('usr_a')).toBe(3);
    again.kept(8);
    expect(marks.count('usr_a')).toBe(4);
    expect(held.read().accounts['acc_A']?.signingSecret).toBe(SEAT.signingSecret);
    /* RED WHEN: the next write goes over the version handed in rather than the one the service now holds. */
    expect(held.seal((k) => k).ifVersion).toBe(8);
  });

  it('seals one on from what it holds, whatever count the change it is handed carries', () => {
    const held = opening(writtenByThePage({ accounts: {} }, 5), marksInMemory());
    /* RED WHEN: a change built from fresh saved keys is sealed at a count below what this wallet has seen, so it is refused later as older. */
    expect(held.seal(() => ({ accounts: {} })).counter).toBe(6);
  });

  it('seals no second copy while one waits to be kept, and can seal again once the page says it was not kept', () => {
    const held = opening(writtenByThePage({ accounts: {} }, 1), marksInMemory());
    const first = held.seal((k) => k);
    /* RED WHEN: two copies sealed at the same count can both go to the page. */
    expect(() => held.seal((k) => k)).toThrow();
    first.notKept();
    expect(held.seal((k) => k).counter).toBe(2);
  });

  it('lets go of the key and the keys when the action ends', () => {
    const held = opening(writtenByThePage({ accounts: { acc_A: SEAT } }, 1), marksInMemory());
    held.letGo();
    /* RED WHEN: saved keys can still be read or sealed after the action that opened them has ended. */
    expect(() => held.read()).toThrow();
    expect(() => held.seal(() => ({ accounts: {} }))).toThrow();
  });

  it('gives the parts that open nothing, without the seats', () => {
    const held = opening(writtenByThePage({ accounts: { acc_A: SEAT }, paidBy: ['x'] }, 2), marksInMemory());
    /* RED WHEN: what a page may list carries a seat's secrets. */
    expect(JSON.stringify(held.metadata())).not.toContain(SEAT.signingSecret);
    expect(held.metadata()).toMatchObject({ counter: 2, paidBy: ['x'] });
  });
});

describe('an older copy is refused', () => {
  it('refuses a copy whose count is below the highest this wallet has seen, and opens one at or above it', () => {
    const marks = marksInMemory();
    marks.raise('usr_a', { counter: 4, digest: 'ab'.repeat(32) });
    /* RED WHEN: an older copy handed back by the page or the service is opened, changed and sealed as the newest. */
    expect(refusedWith(() => opening(writtenByThePage({ accounts: {} }, 3), marks))).toBe('older-keys');
    const atFour = writtenByThePage({ accounts: {} }, 4);
    const sameMarks = marksInMemory();
    sameMarks.raise('usr_a', markFor(atFour, 4));
    expect(refusedWith(() => opening(atFour, sameMarks))).toBe('opened');
    expect(refusedWith(() => opening(writtenByThePage({ accounts: {} }, 9), marks))).toBe('opened');
    expect(marks.count('usr_a')).toBe(9);
  });

  it('refuses no copy at all once it has seen one, and starts empty only where it has seen none', () => {
    const marks = marksInMemory();
    /* RED WHEN: a person with nothing saved cannot have their first keys opened. */
    expect(counterOf(opening(null, marks).read())).toBe(0);
    marks.raise('usr_a', { counter: 2, digest: 'ab'.repeat(32) });
    /* RED WHEN: a page that withholds the saved keys gets new, empty ones sealed over them. */
    expect(refusedWith(() => opening(null, marks))).toBe('older-keys');
  });

  it('opens saved keys written before writes were counted at count 0, but not once it has seen a later write', () => {
    const older = seal(JSON.stringify({ accounts: {} }), KEY);
    const fresh = marksInMemory();
    /* RED WHEN: saved keys written before the count was kept can no longer be opened by a wallet that has seen none. */
    expect(counterOf(opening(older, fresh).read())).toBe(0);
    expect(refusedWith(() => opening(older, fresh))).toBe('opened');
    fresh.raise('usr_a', { counter: 1, digest: 'ab'.repeat(32) });
    /* RED WHEN: uncounted saved keys pass for a copy newer than one this wallet has opened. */
    expect(refusedWith(() => opening(older, fresh))).toBe('older-keys');
  });

  it('refuses saved keys that do not open with this wallet\'s key for the person', () => {
    /* RED WHEN: another person's or another wallet's saved keys are read as this person's. */
    expect(refusedWith(() => openHeldKeyring({
      identity, ask: { ...ASK, person: 'usr_b' }, handedIn: { sealed: writtenByThePage({ accounts: {} }, 1), version: 0 }, marks: marksInMemory(),
    }))).toBe('keys-did-not-open');
    expect(refusedWith(() => opening(seal(JSON.stringify({ accounts: {} }), '00'.repeat(32)), marksInMemory()))).toBe('keys-did-not-open');
  });
});

describe('a refused copy says what resolves it', () => {
  const says = (f: () => unknown): string => {
    try { f(); } catch (e) { if (e instanceof SavedKeysRefused) return e.message; throw e; }
    return '';
  };
  it('names a reload for a page that is behind, and the newest device or a restore when the service holds the older copy', () => {
    const marks = marksInMemory();
    marks.raise('usr_a', { counter: 5, digest: 'ab'.repeat(32) });
    for (const message of [
      says(() => opening(writtenByThePage({ accounts: {} }, 4), marks)),
      says(() => opening(writtenByThePage({ accounts: {} }, 5), marks)),
      says(() => opening(null, marks)),
    ]) {
      /* RED WHEN: the refusal offers only a reload, which cannot help when the service itself holds the older copy. */
      expect(message).toMatch(/reload/iu);
      expect(message).toMatch(/the service holds an older copy/iu);
      expect(message).toMatch(/device where your saved keys were last changed/iu);
      expect(message).toMatch(/restore the newest copy/iu);
    }
  });
});

describe('another copy at the same count is refused', () => {
  it('refuses saved keys at the count it has seen when they are not the copy it saw at that count', () => {
    const marks = marksInMemory();
    const mine = opening(writtenByThePage({ accounts: {} }, 3), marks);
    const again = mine.seal((k) => withNewSeat(k, 'acc_A', SEAT));
    again.kept(8);
    /* A second copy sealed from the same count 3, without the seat: a page or a service could keep both. */
    const without = writtenByThePage({ accounts: {} }, 4);
    /* RED WHEN: a copy at the same count as the one this wallet kept, but not that copy, is opened as the newest. */
    expect(refusedWith(() => opening(without, marks))).toBe('older-keys');
    expect(refusedWith(() => opening(again.sealed as never, marks))).toBe('opened');
  });

  it('the copy first opened at a count stays the one held to, whatever opens after it at that count', () => {
    const marks = marksInMemory();
    const first = writtenByThePage({ accounts: {} }, 2);
    opening(first, marks);
    expect(marks.seen.get('usr_a')).toEqual(markFor(first, 2));
    /* RED WHEN: the copy kept at a count is replaced by a later one at the same count. */
    expect(refusedWith(() => opening(writtenByThePage({ accounts: { acc_B: SEAT } }, 2), marks))).toBe('older-keys');
    expect(marks.seen.get('usr_a')).toEqual(markFor(first, 2));
  });
});

describe('a change seals only what it adds, never a seat it drops or alters', () => {
  const withSeats = (): Keyring => ({
    accounts: { acc_A: SEAT },
    pendingSeats: { ['71'.repeat(32)]: { accountId: 'acc_B', signingPublicKey: '71'.repeat(32), signingSecret: '72'.repeat(32), wrappingSecret: '73'.repeat(32), blinding: '74'.repeat(32), scope: '75'.repeat(32) } },
  });
  const why = (f: () => unknown): string => {
    try { f(); } catch (e) { if (e instanceof SeatChangeRefused) return 'refused'; throw e; }
    return 'sealed';
  };

  it('applies the change to the saved keys it holds now, not to a copy a step read before', () => {
    const held = opening(writtenByThePage(withSeats(), 1), marksInMemory());
    const before = held.read();
    held.seal((k) => withNewSeat(k, 'acc_C', SEAT)).kept(2);
    const later = held.seal((k) => withNewSeat(k, 'acc_D', SEAT));
    /* RED WHEN: a change made after an earlier one was kept loses the earlier one. */
    expect(Object.keys(JSON.parse(unseal(later.sealed, KEY)).accounts).sort()).toEqual(['acc_A', 'acc_C', 'acc_D']);
    expect(Object.keys(before.accounts)).toEqual(['acc_A']);
  });

  it('refuses a change that drops or alters a seat or a seat sealed before its leaf, and seals nothing', () => {
    const held = opening(writtenByThePage(withSeats(), 1), marksInMemory());
    /* RED WHEN: a step can drop a seat's only copy, or rewrite its secrets, and seal the result as the newest. */
    expect(why(() => held.seal((k) => ({ ...k, accounts: {} })))).toBe('refused');
    expect(why(() => held.seal((k) => ({ ...k, accounts: { acc_A: { ...SEAT, blinding: '99'.repeat(32) } } })))).toBe('refused');
    expect(why(() => held.seal((k) => { const { pendingSeats: _gone, ...rest } = k; return rest; }))).toBe('refused');
    expect(why(() => held.seal(() => ({ accounts: { acc_A: SEAT } })))).toBe('refused');
    /* RED WHEN: a refused change leaves the keyring unable to seal what is allowed. */
    expect(why(() => held.seal((k) => withNewSeat(k, 'acc_C', SEAT)))).toBe('sealed');
  });

  it('a change cannot reach the saved keys it was handed and alter them in place', () => {
    const held = opening(writtenByThePage(withSeats(), 1), marksInMemory());
    /* RED WHEN: a change that writes into the keys it is handed alters what the wallet holds without being sealed. */
    expect(why(() => held.seal((k) => { (k.accounts['acc_A'] as { blinding: string }).blinding = '99'.repeat(32); return k; }))).toBe('refused');
    expect(held.read().accounts['acc_A']?.blinding).toBe(SEAT.blinding);
  });

  it('adds the founding seat and keeps, changes or drops a creation, as founding a company does', () => {
    const held = opening(writtenByThePage(withSeats(), 1), marksInMemory());
    const creation = { accountId: 'acc_N', label: 'co_x', foundingKey: { tag: 'schnorr', value: 'ab' }, request: {}, made: false, deploy: null, signed: null, recorded: false } as never;
    const founded = held.seal((k) => withCreation(withNewSeat(k, 'acc_N', SEAT), creation));
    founded.kept(2);
    const inside = JSON.parse(unseal(founded.sealed, KEY));
    /* RED WHEN: the founding seat and its creation cannot be sealed together in one change. */
    expect(Object.keys(inside.accounts).sort()).toEqual(['acc_A', 'acc_N']);
    expect(Object.keys(inside.creations)).toEqual(['acc_N']);
    expect(why(() => held.seal((k) => withoutCreation(k, 'acc_N')))).toBe('sealed');
  });
});

describe('the highest count is kept in the wallet\'s own storage', () => {
  const backing = new Map<string, string>();
  beforeEach(() => {
    backing.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => { backing.set(key, String(value)); },
      removeItem: (key: string) => { backing.delete(key); },
      get length() { return backing.size; },
      key: (index: number) => [...backing.keys()][index] ?? null,
    };
    forgetOpenWallet();
  });

  it('rises and never falls, per person, and is not read for another wallet', () => {
    expect(keyringMarkOf(secret, 'usr_a')).toBeNull();
    raiseKeyringMark(secret, 'usr_a', { counter: 3, digest: '33'.repeat(32) });
    raiseKeyringMark(secret, 'usr_a', { counter: 2, digest: '22'.repeat(32) });
    raiseKeyringMark(secret, 'usr_a', { counter: 3, digest: '99'.repeat(32) });
    raiseKeyringMark(secret, 'usr_b', { counter: 1, digest: '11'.repeat(32) });
    /* RED WHEN: a lower count replaces a higher one, or another copy at the same count replaces the one first seen. */
    expect(keyringMarkOf(secret, 'usr_a')).toEqual({ counter: 3, digest: '33'.repeat(32) });
    expect(keyringMarkOf(secret, 'usr_b')).toEqual({ counter: 1, digest: '11'.repeat(32) });
    /* RED WHEN: one wallet's counts are read for another wallet on the same device. */
    expect(keyringMarkOf(newSecret(), 'usr_a')).toBeNull();
    const marks = keyringMarksFor(secret);
    expect(refusedWith(() => opening(writtenByThePage({ accounts: {} }, 2), marks))).toBe('older-keys');
    expect(refusedWith(() => opening(writtenByThePage({ accounts: {} }, 3), marks))).toBe('older-keys');
  });

  it('keeps the mark of the new key once it is set, and sets it only on the copy it already holds', () => {
    const A = '33'.repeat(32);
    raiseKeyringMark(secret, 'usr_a', { counter: 3, digest: A });
    raiseKeyringMark(secret, 'usr_a', { counter: 3, digest: '99'.repeat(32), under: 2 });
    /* RED WHEN: another copy at the same count is marked as sealed under the new key. */
    expect(keyringMarkOf(secret, 'usr_a')).toEqual({ counter: 3, digest: A });
    raiseKeyringMark(secret, 'usr_a', { counter: 3, digest: A, under: 2 });
    /* RED WHEN: the copy already held, sealed again under the new key at the same count, does not set the mark. */
    expect(keyringMarkOf(secret, 'usr_a')).toEqual({ counter: 3, digest: A, under: 2 });
    raiseKeyringMark(secret, 'usr_a', { counter: 4, digest: '44'.repeat(32) });
    /* RED WHEN: a later count without the mark takes it away, which would let the old key open a copy again. */
    expect(keyringMarkOf(secret, 'usr_a')).toEqual({ counter: 4, digest: '44'.repeat(32), under: 2 });
  });
});

describe('the saved keys move to a key no page had, once, and the old key opens no copy after', () => {
  const OLD = toHex(keyringKeyFor(identity, ASK));
  const underTheOld = (count: number) => sealKeyring({ accounts: { acc_A: SEAT }, counter: count - 1 }, OLD).sealed;

  it('opens a copy sealed under the old key on a device that has seen none under the new, and seals it under the new', () => {
    const m = marksInMemory();
    const held = opening(underTheOld(3), m);
    expect(held.underTheOldKey).toBe(true);
    const again = held.seal((k) => k);
    /* RED WHEN: a copy is sealed again under the old key, which pages were once given. */
    expect(() => unseal(again.sealed, OLD)).toThrow();
    const inside = JSON.parse(unseal(again.sealed, KEY));
    /* RED WHEN: moving the saved keys drops, changes or makes again any seat. */
    expect(inside.accounts).toEqual({ acc_A: SEAT });
    expect(inside.counter).toBe(4);
    again.kept(8);
    expect(m.seen.get('usr_a')).toMatchObject({ counter: 4, under: 2 });
    expect(held.underTheOldKey).toBe(false);
  });

  it('refuses a copy under the old key once this device has opened one under the new', () => {
    const m = marksInMemory();
    const newer = writtenByThePage({ accounts: { acc_A: SEAT } }, 5);
    opening(newer, m);
    expect(m.seen.get('usr_a')?.under).toBe(2);
    /* RED WHEN: a page that kept the old key has a copy it sealed, at any count, taken as the newest. */
    expect(refusedWith(() => opening(underTheOld(9), m))).toBe('older-keys');
    /* RED WHEN: the refusal for a device that already moved to the new key is not the one that says the copy is an older one. */
    expect(() => opening(underTheOld(9), m)).toThrow(/before this device moved them to the key no page holds, so they are an older copy/);
  });

  it('opens under the old key again only the copy this device last opened that way, never a later one', () => {
    const m = marksInMemory();
    const first = underTheOld(3);
    opening(first, m).letGo();
    /* The same copy, handed in again (a retry), still opens. */
    expect(opening(first, m).underTheOldKey).toBe(true);
    /* RED WHEN: a later copy under the old key, which whoever kept that key could have sealed, is taken as the newest. */
    expect(refusedWith(() => opening(underTheOld(7), m))).toBe('older-keys');
    expect(m.seen.get('usr_a')).toMatchObject({ counter: 3 });
  });

  it('never seals under the old key, nor gives either key out', () => {
    const held = opening(writtenByThePage({ accounts: { acc_A: SEAT } }, 1), marksInMemory());
    const again = held.seal((k) => k);
    expect(() => unseal(again.sealed, OLD)).toThrow();
    expect(JSON.stringify(again)).not.toContain(KEY);
    expect(JSON.stringify(again)).not.toContain(OLD);
  });
});
