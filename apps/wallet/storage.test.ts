import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { newSecret } from 'midnight-identity/keys/derivation';
import { fingerprintOf, splitSecret } from 'midnight-identity/recovery/pieces';
import type { PieceSet, Placement } from 'midnight-identity/recovery/pieces';
import { toBase64Url } from 'midnight-identity/passkey/bytes';
import {
  StorageError, allPasskeys, arrivalOf, creationOf, forgetEverything, forgetPasskey,
  loadSecret, loadSecuredSetup, loadSubwallets, savePasskey, saveArrival, saveCreation,
  saveSecret, saveSecuredSetup, saveSubwalletName, saveWalletName, securedSetupOnRecord,
  walletNameOf, walletNameOnRecord, walletOfCredential,
} from './storage.js';
import type { SecuredSetup } from './storage.js';
import type { Passkey } from 'midnight-identity/passkey/verify';
import { ORIGINAL_SLOT, forgetOpenWallet, heldWallets, openWallet } from './wallets-held.js';

/*
 * THE RECORD THAT SWITCHES OFF §7.7's NOTICE, UNDER ATTACK — TWO WAYS —
 * AND THE CRYPTO HALF OF THE FILE, EXECUTED.
 *
 * The home screen shows the green tick whenever `loadSecuredSetup` returns a
 * record, so every acceptance here is a claim of "your money is safe". These
 * tests feed it the records an interrupted write, a hand edit, an older
 * version of this app, or a DIFFERENT ACCOUNT's history could leave behind,
 * and the required answer is null — which puts the notice back up.
 *
 * localStorage is a ten-line stand-in (Node has none); IndexedDB is
 * `fake-indexeddb`, which faithfully round-trips a non-extractable CryptoKey,
 * so `sealingKey`, the seal and the unseal all actually run.
 */

const SECURED_KEY = 'midnight-identity:secured';
const KEYRING_KEY = 'midnight-identity:keyring';
const PASSKEYS_KEY = 'midnight-identity:passkeys';

const backing = new Map<string, string>();

beforeEach(() => {
  backing.clear();
  /* `length` and `key` are new here, and they are not decoration:
   * `wallets-held.ts` finds a wallet by its KEY NAMES when the directory
   * record is missing or damaged, which is the net under a lost index. A
   * stand-in without them would leave that net untested. */
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, String(value)); },
    removeItem: (key: string) => { backing.delete(key); },
    get length() { return backing.size; },
    key: (index: number) => [...backing.keys()][index] ?? null,
  };
  /* The open compartment is per WINDOW, so it is module state, so it survives
   * a test. Every test here starts with nothing open. */
  forgetOpenWallet();
  /* A fresh, working IndexedDB per test. Tests for a blocked or wiped one
   * replace or delete this themselves. */
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
});

const PLACEMENTS: readonly Placement[] = [
  { label: 'My Google account', holder: 'google:me' },
  { label: 'Printed card', holder: 'paper' },
  { label: 'Old laptop', holder: 'device:old' },
];

/** A record as the securing flow will write it: a real cut, proved, through the only writer. */
const VERIFICATION: Readonly<Record<string, number | 'never' | null>> = {
  'google:me': 1_000, paper: null, 'device:old': 'never',
};

async function writtenRecord(forSecret = newSecret()): Promise<{
  forSecret: Uint8Array; set: PieceSet; raw: string;
}> {
  const set = await splitSecret(forSecret, PLACEMENTS, 2);
  await saveSecuredSetup(forSecret, set, VERIFICATION);
  return { forSecret, set, raw: backing.get(SECURED_KEY) as string };
}

describe('saveSecuredSetup — rebuiltAt is evidence, not caller data', () => {
  it('writes only after actually rebuilding, and stamps its own clock', async () => {
    const before = Date.now();
    const { forSecret } = await writtenRecord();
    const after = Date.now();
    const setup = loadSecuredSetup(forSecret);
    expect(setup).not.toBeNull();
    expect(setup?.threshold).toBe(2);
    expect(setup?.pieces).toHaveLength(3);
    /* There is no argument to lie with: the date is this function's clock,
     * taken after the proof ran. */
    expect(setup?.rebuiltAt).toBeGreaterThanOrEqual(before);
    expect(setup?.rebuiltAt).toBeLessThanOrEqual(after);
  });

  it('carries per-piece freshness only where given, null otherwise', async () => {
    const { forSecret } = await writtenRecord();
    const pieces = loadSecuredSetup(forSecret)?.pieces ?? [];
    expect(pieces.find((p) => p.holder === 'google:me')?.lastVerified).toBe(1_000);
    expect(pieces.find((p) => p.holder === 'paper')?.lastVerified).toBeNull();
    /* A checkable home that has not been checked is 'never', not null. */
    expect(pieces.find((p) => p.holder === 'device:old')?.lastVerified).toBe('never');
  });

  it("refuses to write a record for a set that does not recover the secret", async () => {
    const secret = newSecret();
    const foreignSet = await splitSecret(newSecret(), PLACEMENTS, 2);
    await expect(saveSecuredSetup(secret, foreignSet, VERIFICATION)).rejects.toThrow();
    expect(backing.has(SECURED_KEY)).toBe(false);
  });

  it('the serialised record contains NO share bytes', async () => {
    /* The writer receives a real PieceSet, shares and all; what it writes is
     * metadata only. Check every encoding a leak would plausibly take. */
    const { set, raw } = await writtenRecord();
    expect(raw).not.toContain('"bytes"');
    for (const piece of set.pieces) {
      expect(raw).not.toContain(toBase64Url(piece.bytes));
      expect(raw).not.toContain(Buffer.from(piece.bytes).toString('base64'));
      expect(raw).not.toContain(Buffer.from(piece.bytes).toString('hex'));
      expect(raw).not.toContain(JSON.stringify(Array.from(piece.bytes)));
    }
    /* And not the set id either — a re-cut set is identified by it. */
    expect(raw).not.toContain(set.setId);
  });
});

describe('loadSecuredSetup — a record nothing checks must not decide the tick', () => {
  it('returns null when nothing is stored', () => {
    expect(loadSecuredSetup(newSecret())).toBeNull();
  });

  /* The exact record the defect was found on: {threshold: 5, pieces: []} rendered
   * "Any 5 of these 0 pieces put this account back" under a green tick. */
  it('refuses the bad record: a threshold with no pieces', async () => {
    const { forSecret, raw } = await writtenRecord();
    const record = JSON.parse(raw) as SecuredSetup;
    backing.set(SECURED_KEY, JSON.stringify({ ...record, threshold: 5, pieces: [] }));
    expect(loadSecuredSetup(forSecret)).toBeNull();
  });

  /*
   * THE PLAN RULES ARE checkPlan's — the same ones that refuse a set at
   * cutting time. A looser second copy here accepted all three of these.
   */
  it('refuses what checkPlan refuses: threshold one, a single piece, one holder twice', async () => {
    const { forSecret, raw } = await writtenRecord();
    const record = JSON.parse(raw) as SecuredSetup;
    const own = (pieces: unknown, threshold: number): void => {
      backing.set(SECURED_KEY, JSON.stringify({ ...record, pieces, threshold }));
      expect(loadSecuredSetup(forSecret)).toBeNull();
    };
    /* "any 1 of these 1 pieces" — copies, not a threshold. */
    own([{ label: 'Only place', holder: 'google:me', lastVerified: null }], 1);
    /* a 2-of-2 where both pieces sit behind the same Google account. */
    own([
      { label: 'Drive A', holder: 'google:me', lastVerified: null },
      { label: 'Drive B', holder: 'google:me', lastVerified: null },
    ], 2);
    /* a 2-of-3 with two pieces in one holder — one of them is decoration. */
    own([
      { label: 'Drive A', holder: 'google:me', lastVerified: null },
      { label: 'Drive B', holder: 'google:me', lastVerified: null },
      { label: 'Paper', holder: 'paper', lastVerified: null },
    ], 2);
  });

  it.each([0, -1, 1.5, '2', null, undefined, Number.NaN, 4])(
    'refuses threshold %j', async (threshold) => {
      const { forSecret, raw } = await writtenRecord();
      const record = JSON.parse(raw) as unknown as Record<string, unknown>;
      backing.set(SECURED_KEY, JSON.stringify({ ...record, threshold }));
      expect(loadSecuredSetup(forSecret)).toBeNull();
    });

  it.each(['yesterday', null, undefined, Number.NaN])(
    'refuses rebuiltAt %j — the tick states a dated fact, §7.12', async (rebuiltAt) => {
      const { forSecret, raw } = await writtenRecord();
      const record = JSON.parse(raw) as unknown as Record<string, unknown>;
      backing.set(SECURED_KEY, JSON.stringify({ ...record, rebuiltAt }));
      expect(loadSecuredSetup(forSecret)).toBeNull();
    });

  /* `pieces` itself replaced by things that are not a list of pieces. Without
   * these guards the home screen throws inside render — a blank page. */
  it.each([7, null, { length: 3 }, [null], ['garbage'], [{ label: 'x' }], [{ label: '  ', holder: 'paper', lastVerified: null }], [{ label: 'x', holder: 'paper', lastVerified: 'never' }]])(
    'refuses pieces %j', async (pieces) => {
      const { forSecret, raw } = await writtenRecord();
      const record = JSON.parse(raw) as unknown as Record<string, unknown>;
      backing.set(SECURED_KEY, JSON.stringify({ ...record, pieces, threshold: 2 }));
      expect(loadSecuredSetup(forSecret)).toBeNull();
    });

  it.each(['not json {{{', '42', '"secured"', 'null', '[]'])(
    'refuses stored garbage %j rather than throwing', (raw) => {
      backing.set(SECURED_KEY, raw);
      expect(loadSecuredSetup(newSecret())).toBeNull();
    });
});

describe('loadSecuredSetup — the record names its account', () => {
  it('refuses a record cut from a different secret', async () => {
    /* The story: secure account A, start over, create account B — the
     * stale record must not become B's proof of backup. */
    const { raw } = await writtenRecord();
    backing.set(SECURED_KEY, raw);
    expect(loadSecuredSetup(newSecret())).toBeNull();
  });

  it('refuses a record whose fingerprint was stripped or forged', async () => {
    const { forSecret, raw } = await writtenRecord();
    const record = JSON.parse(raw) as unknown as Record<string, unknown>;
    const stripped = { ...record };
    delete stripped['fingerprint'];
    backing.set(SECURED_KEY, JSON.stringify(stripped));
    expect(loadSecuredSetup(forSecret)).toBeNull();
    backing.set(SECURED_KEY, JSON.stringify({
      ...record, fingerprint: toBase64Url(fingerprintOf(newSecret())),
    }));
    expect(loadSecuredSetup(forSecret)).toBeNull();
  });

  it('reader and writer do not share a blind spot', async () => {
    /* If `fingerprintOf` collapsed to a constant, writer and reader would
     * agree and this would be green and wrong. Two secrets must fingerprint
     * differently. */
    expect(toBase64Url(fingerprintOf(newSecret())))
      .not.toBe(toBase64Url(fingerprintOf(newSecret())));
  });

  it('securedSetupOnRecord returns the map without the fingerprint check', async () => {
    await writtenRecord();
    /* No secret supplied, no claim made: this is the broken-storage screen's
     * read, where the secret cannot be unlocked to check. Shape and plan are
     * still validated. */
    expect(securedSetupOnRecord(ORIGINAL_SLOT)).not.toBeNull();
    backing.set(SECURED_KEY, JSON.stringify({ threshold: 5, pieces: [] }));
    expect(securedSetupOnRecord(ORIGINAL_SLOT)).toBeNull();
  });
});

describe('loadSecret — every way storage fails is a named state', () => {
  it('returns null when nothing is stored', async () => {
    await expect(loadSecret(ORIGINAL_SLOT)).resolves.toBeNull();
  });

  it('round-trips a secret through the real seal and unseal', async () => {
    const secret = newSecret();
    await saveSecret(secret);
    const back = await loadSecret(ORIGINAL_SLOT);
    expect(back && toBase64Url(back)).toBe(toBase64Url(secret));
  });

  it.each([
    'not json at all',
    '{"sealed": 7, "iv": "AAAA"}',
    '{"iv": "AAAA"}',
    '"just a string"',
  ])('throws StorageError(record-damaged) for stored %j', async (raw) => {
    backing.set(KEYRING_KEY, raw);
    const failure = await loadSecret(ORIGINAL_SLOT).then(() => null, (e: unknown) => e);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as StorageError).code).toBe('record-damaged');
    /* The message is what the person reads on the broken screen — it must
     * exist and say what to do, but NOTHING may branch on its wording. */
    expect((failure as StorageError).message.length).toBeGreaterThan(20);
  });

  it('throws StorageError(sealed-copy-unopenable) when the sealing key is gone', async () => {
    await saveSecret(newSecret());
    /* The cleared-profile story: the ciphertext survives in localStorage, the
     * key kept in IndexedDB does not. */
    (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
    const failure = await loadSecret(ORIGINAL_SLOT).then(() => null, (e: unknown) => e);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as StorageError).code).toBe('sealed-copy-unopenable');
  });

  it('throws StorageError(sealed-copy-unopenable) when IndexedDB is blocked outright', async () => {
    await saveSecret(newSecret());
    /* A Firefox private window, some iOS and enterprise profiles: the API
     * itself refuses. This used to escape as a DOMException and miss the
     * branch — the third of three failures. */
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    const failure = await loadSecret(ORIGINAL_SLOT).then(() => null, (e: unknown) => e);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as StorageError).code).toBe('sealed-copy-unopenable');
  });
});

/* ---- passkeys: damage is a state, and no read rewrites the store ---- */

const passkeyFixture = (credentialId: string): Passkey => ({
  credentialId,
  personHandle: 'person-1',
  publicKeySpki: new Uint8Array([1, 2, 3]),
  algorithm: -7,
  signCount: 0,
  provenBySignIn: false,
  rpId: 'localhost',
  syncsToACloud: false,
  backedUpNow: false,
  transports: [],
});

describe('allPasskeys — a damaged record is record-damaged, never an empty list', () => {
  it('returns [] only for a record that does not exist', () => {
    expect(allPasskeys(ORIGINAL_SLOT)).toEqual([]);
  });

  it('round-trips what savePasskey wrote', () => {
    savePasskey(passkeyFixture('cred-a'), ORIGINAL_SLOT);
    savePasskey(passkeyFixture('cred-b'), ORIGINAL_SLOT);
    const kept = allPasskeys(ORIGINAL_SLOT);
    expect(kept.map((p) => p.credentialId)).toEqual(['cred-a', 'cred-b']);
    expect(kept[0]?.publicKeySpki).toEqual(new Uint8Array([1, 2, 3]));
  });

  it.each([
    'not json',
    '{"a": 1}',
    '42',
    JSON.stringify([{ credentialId: 'ok', personHandle: 'p', publicKeySpki: 'AAAA' }, null]),
    JSON.stringify([{ credentialId: 'no-key', personHandle: 'p' }]),
    JSON.stringify([{ credentialId: 'bad-b64', personHandle: 'p', publicKeySpki: '!!not-base64url!!' }]),
  ])('throws StorageError(record-damaged) for stored %j', (raw) => {
    backing.set(PASSKEYS_KEY, raw);
    const failure = ((): unknown => {
      try {
        allPasskeys(ORIGINAL_SLOT);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as StorageError).code).toBe('record-damaged');
  });

  it('no write path rewrites a damaged store — partial damage stays recoverable', () => {
    const damaged = JSON.stringify([
      { credentialId: 'healthy', personHandle: 'p', publicKeySpki: 'AAAA', transports: [] },
      { credentialId: 'torn' },
    ]);
    backing.set(PASSKEYS_KEY, damaged);
    /* The old behaviour: read skips 'torn', the next save writes the store
     * from what it read, and the damaged entry is gone for good. Now the
     * save throws first and the bytes stay exactly as they were. */
    expect(() => savePasskey(passkeyFixture('cred-new'), ORIGINAL_SLOT)).toThrow(StorageError);
    expect(backing.get(PASSKEYS_KEY)).toBe(damaged);
    expect(() => forgetPasskey('healthy', ORIGINAL_SLOT)).toThrow(StorageError);
    expect(backing.get(PASSKEYS_KEY)).toBe(damaged);
  });

  it('forgetPasskey removes exactly one record from a healthy store', () => {
    savePasskey(passkeyFixture('a'), ORIGINAL_SLOT);
    savePasskey(passkeyFixture('b'), ORIGINAL_SLOT);
    forgetPasskey('a', ORIGINAL_SLOT);
    const kept = allPasskeys(ORIGINAL_SLOT);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.credentialId).toBe('b');
    forgetPasskey('b', ORIGINAL_SLOT);
    expect(backing.has(PASSKEYS_KEY)).toBe(false);
  });
});

describe('StorageError — the contract the session branches on', () => {
  it('is an Error with a code, and the check is instanceof, never text', () => {
    const error: unknown = new StorageError('sealed-copy-unopenable', 'reworded freely');
    expect(error instanceof StorageError).toBe(true);
    expect(error instanceof Error).toBe(true);
    expect((error as StorageError).code).toBe('sealed-copy-unopenable');
    expect((error as StorageError).name).toBe('StorageError');
  });
});

describe('saveSecuredSetup — what was on record is kept, never erased', () => {
  it('a re-cut keeps the replaced set, and chains keep everything', async () => {
    const secret = newSecret();
    await writtenRecord(secret);
    const first = securedSetupOnRecord(ORIGINAL_SLOT);
    expect(first?.superseded).toHaveLength(0);

    /* Re-cut the SAME account with a different plan. */
    const secondSet = await splitSecret(secret, [
      { label: 'New cloud', holder: 'cloud-two' },
      { label: 'New paper', holder: 'paper-two' },
    ], 2);
    await saveSecuredSetup(secret, secondSet, { 'cloud-two': 'never', 'paper-two': null });
    const second = loadSecuredSetup(secret);
    expect(second?.superseded).toHaveLength(1);
    expect(second?.superseded[0]?.pieces.map((p) => p.holder))
      .toEqual(['google:me', 'paper', 'device:old']);
    expect(second?.superseded[0]?.supersededAt).toBeGreaterThan(0);

    /* And a third cut carries both forward. */
    const thirdSet = await splitSecret(secret, PLACEMENTS, 2);
    await saveSecuredSetup(secret, thirdSet, VERIFICATION);
    expect(loadSecuredSetup(secret)?.superseded).toHaveLength(2);
  });

  /*
   * MANY WALLETS REPLACES THIS TEST'S PREMISE, AND THE REPLACEMENT IS STRONGER.
   *
   * It used to read: another account's map must survive being OVERWRITTEN, by
   * being carried into `superseded`. That was the best available answer while
   * every wallet shared one record. **Now it is not overwritten at all** — it
   * is a different record, in a different compartment — so the assertion moves
   * from "preserved inside the replacement" to "never touched".
   *
   * THE RULE IS NOT WEAKENED: the re-cut test above still pins `superseded` for the
   * case the rule was written about, which is one wallet replacing its OWN
   * plan while the old pieces are still out there.
   */
  it("ANOTHER WALLET'S map is not touched — it is not the same record", async () => {
    const other = newSecret();
    const otherSlot = await saveSecret(other);
    await writtenRecord(other);
    const otherMap = loadSecuredSetup(other);
    expect(otherMap?.pieces).toHaveLength(3);

    /* A second wallet lands. It gets a compartment of its own. */
    const mine = newSecret();
    const mySlot = await saveSecret(mine);
    expect(mySlot).not.toBe(otherSlot);
    await saveSecuredSetup(mine, await splitSecret(mine, PLACEMENTS, 2), VERIFICATION);

    /* Nothing was replaced, so there is nothing superseded. */
    expect(loadSecuredSetup(mine)?.superseded).toHaveLength(0);
    expect(loadSecuredSetup(mine)?.fingerprint).toBe(toBase64Url(fingerprintOf(mine)));

    /* And the first wallet's map is exactly what it was. */
    openWallet(otherSlot);
    const after = loadSecuredSetup(other);
    expect(after).toEqual(otherMap);
    expect(after?.fingerprint).toBe(toBase64Url(fingerprintOf(other)));
  });

  it('refuses a record whose superseded entries are garbage', async () => {
    const { forSecret, raw } = await writtenRecord();
    const record = JSON.parse(raw) as unknown as Record<string, unknown>;
    for (const superseded of [7, [{}], [{ fingerprint: 'x', threshold: 9, pieces: [], rebuiltAt: 1, supersededAt: 1 }]]) {
      backing.set(SECURED_KEY, JSON.stringify({ ...record, superseded }));
      expect(loadSecuredSetup(forSecret)).toBeNull();
    }
    /* Absent entirely — a record written before that rule — reads as none. */
    delete record['superseded'];
    backing.set(SECURED_KEY, JSON.stringify(record));
    expect(loadSecuredSetup(forSecret)?.superseded).toEqual([]);
  });
});

describe('saveSecuredSetup — the writer refuses to guess verifiability', () => {
  it('throws, and writes nothing, when a holder has no verification state', async () => {
    const secret = newSecret();
    const set = await splitSecret(secret, PLACEMENTS, 2);
    await expect(saveSecuredSetup(secret, set, { 'google:me': 'never', paper: null }))
      .rejects.toThrow(/no verification state/);
    expect(backing.has(SECURED_KEY)).toBe(false);
  });

  it("refuses a stored lastVerified that is neither a time, 'never', nor null", async () => {
    const { forSecret, raw } = await writtenRecord();
    const record = JSON.parse(raw) as SecuredSetup;
    const pieces = record.pieces.map((p, i) => (i === 0 ? { ...p, lastVerified: 'soon' } : p));
    backing.set(SECURED_KEY, JSON.stringify({ ...record, pieces }));
    expect(loadSecuredSetup(forSecret)).toBeNull();
  });
});

describe('the partial flag — §7.15: a recovery map is honest about its edges', () => {
  it('defaults to complete: the wizard writes false, and records from before parse as false', async () => {
    const { forSecret, raw } = await writtenRecord();
    expect(loadSecuredSetup(forSecret)?.partial).toBe(false);
    /* A record written before the field existed — strip it. */
    const record = JSON.parse(raw) as Record<string, unknown>;
    delete record['partial'];
    backing.set(SECURED_KEY, JSON.stringify(record));
    expect(loadSecuredSetup(forSecret)?.partial).toBe(false);
  });

  it('round-trips true when the writer says so', async () => {
    const secret = newSecret();
    const set = await splitSecret(secret, PLACEMENTS, 2);
    await saveSecuredSetup(secret, set, VERIFICATION, { partial: true });
    expect(loadSecuredSetup(secret)?.partial).toBe(true);
  });
});

/*
 * ────────────────────────────────────────────────────────────────────────────
 * ONE TEST PER RECORD KIND: WALLET B NEVER APPEARS OVER WALLET A.
 *
 * THE RULE, generalised: *"no record of wallet B
 * may ever be shown over wallet A."* `loadSubwallets`' fingerprint check is
 * what that rule was modelled on, and it is now true for a second reason as
 * well as the first — the records are not even in the same compartment.
 *
 * **BOTH REASONS ARE ASSERTED SEPARATELY, DELIBERATELY.** Each test lands two
 * real wallets (so the compartments are real), then asks for B's record with
 * A's secret (so the fingerprint check is exercised too). A round that
 * deleted that check would leave the first half of every test green.
 * ────────────────────────────────────────────────────────────────────────────
 */
describe('THE RULE — no record of wallet B is ever shown over wallet A', () => {
  async function twoWallets(): Promise<{
    a: Uint8Array; b: Uint8Array; aSlot: string; bSlot: string;
  }> {
    const b = newSecret();
    const bSlot = await saveSecret(b);
    const a = newSecret();
    const aSlot = await saveSecret(a);
    expect(aSlot).not.toBe(bSlot);
    expect(heldWallets()).toHaveLength(2);
    return { a, b, aSlot, bSlot };
  }

  it('KEYRING — each compartment unseals to its own secret, and only its own', async () => {
    const { a, b, aSlot, bSlot } = await twoWallets();
    expect([...(await loadSecret(aSlot))!]).toEqual([...a]);
    expect([...(await loadSecret(bSlot))!]).toEqual([...b]);
    /* The sealed copies are different records under different keys. */
    expect(await loadSecret(aSlot)).not.toEqual(await loadSecret(bSlot));
  });

  it('WALLET NAME — B\u2019s name is not shown over A, checked or unchecked', async () => {
    const { a, b, aSlot, bSlot } = await twoWallets();
    openWallet(bSlot);
    saveWalletName(b, 'Company');
    openWallet(aSlot);
    saveWalletName(a, 'Rent money');
    expect(walletNameOf(a)).toBe('Rent money');
    /* The unchecked reader — the locked screen's — names the compartment it
     * is given, and the screen gives it the open one. Named here rather than
     * defaulted: a change removed the default, and in a test about TWO wallets
     * `ORIGINAL_SLOT` would name B, which is the mistake being pinned. */
    expect(walletNameOnRecord(aSlot)).toBe('Rent money');
    expect(walletNameOnRecord(bSlot)).toBe('Company');
    /* And B\u2019s secret cannot read A\u2019s record: the check, still doing its job. */
    expect(walletNameOf(b)).toBeNull();
  });

  it('SUBWALLET NAMES — B\u2019s labels never dress A\u2019s accounts', async () => {
    const { a, b, aSlot, bSlot } = await twoWallets();
    openWallet(bSlot);
    saveSubwalletName(b, 3, 'Savings');
    openWallet(aSlot);
    expect(loadSubwallets(a).names).toEqual({});
    saveSubwalletName(a, 3, 'Payroll');
    expect(loadSubwallets(a).names['3']).toBe('Payroll');
    openWallet(bSlot);
    expect(loadSubwallets(b).names['3']).toBe('Savings');
  });

  it('SECURED SETUP — the tick over A is never switched on by B\u2019s map', async () => {
    const { a, b, aSlot, bSlot } = await twoWallets();
    openWallet(bSlot);
    await saveSecuredSetup(b, await splitSecret(b, PLACEMENTS, 2), VERIFICATION);
    expect(loadSecuredSetup(b)).not.toBeNull();
    openWallet(aSlot);
    /* The notice must still be up over A: no record, and none borrowed. */
    expect(loadSecuredSetup(a)).toBeNull();
    expect(securedSetupOnRecord(aSlot)).toBeNull();
    /* The unchecked reader is scoped too — its use is one compartment. */
    expect(securedSetupOnRecord(bSlot)).not.toBeNull();
  });

  it('ARRIVAL — B\u2019s pairing date is not A\u2019s history', async () => {
    const { a, b, aSlot, bSlot } = await twoWallets();
    openWallet(bSlot);
    saveArrival(b);
    expect(arrivalOf(b)).not.toBeNull();
    openWallet(aSlot);
    expect(arrivalOf(a)).toBeNull();
  });

  it('CREATION — B\u2019s birthday is not A\u2019s', async () => {
    const { a, b, aSlot, bSlot } = await twoWallets();
    openWallet(bSlot);
    saveCreation(b);
    expect(creationOf(b)).not.toBeNull();
    openWallet(aSlot);
    expect(creationOf(a)).toBeNull();
  });

  it('PASSKEYS — a credential opens the wallet it was made for, and no other', async () => {
    const { aSlot, bSlot } = await twoWallets();
    savePasskey(passkeyFixture('cred-for-b'), bSlot);
    savePasskey(passkeyFixture('cred-for-a'), aSlot);

    expect(allPasskeys(aSlot).map((k) => k.credentialId)).toEqual(['cred-for-a']);
    expect(allPasskeys(bSlot).map((k) => k.credentialId)).toEqual(['cred-for-b']);

    /* THE RESOLUTION THE UNLOCK SCREEN NEEDS: the browser offers every
     * credential for this origin, and the wallet has to say which one this
     * opens. */
    expect(walletOfCredential('cred-for-b')?.walletId).toBe(bSlot);
    expect(walletOfCredential('cred-for-a')?.walletId).toBe(aSlot);
    /* AND THE STATE ALREADY SEEN IN THE WILD: a credential a password manager
     * still offers, with nothing behind it here. A null, for the caller to
     * turn into a sentence — never a wrong wallet. */
    expect(walletOfCredential('cred-from-a-cleared-browser')).toBeNull();
  });

  it('BALANCE CHECKPOINTS — the cache is per wallet, so a switch is not a cold sync',
    async () => {
      const { aSlot, bSlot } = await twoWallets();
      const { loadWalletCheckpoint, saveWalletCheckpoint } = await import('./storage.js');
      /* The compartment is NAMED at every call. It defaulted to
       * `openWalletId()` when this test was written, which is why the
       * `openWallet` calls below it looked load-bearing; they are not, and
       * the test is sharper for saying which compartment it means. */
      await saveWalletCheckpoint('coin-key-b', 0,
        { serialized: 'B-STATE', night: 7n, asOf: 1_000 }, bSlot);
      await saveWalletCheckpoint('coin-key-a', 0,
        { serialized: 'A-STATE', night: 3n, asOf: 2_000 }, aSlot);

      expect((await loadWalletCheckpoint('coin-key-a', 0, aSlot))?.serialized).toBe('A-STATE');
      /* B\u2019s entry for the SAME account number survived A writing one. */
      expect((await loadWalletCheckpoint('coin-key-b', 0, bSlot))?.serialized).toBe('B-STATE');
      /* And a checkpoint is still refused for a wallet whose coin key it does
       * not name — the check that was there before this change. */
      expect(await loadWalletCheckpoint('coin-key-b', 0, aSlot)).toBeNull();
    });
});

/*
 * ────────────────────────────────────────────────────────────────────────────
 * THE BROWSER THAT ALREADY HAS A WALLET. NOTHING MOVES.
 *
 * The third `Done means`: *"An existing single-wallet browser opens
 * unchanged, with every record intact."* It is answered by not migrating: the
 * compartment named by the empty string IS the fixed keys, so a browser that
 * predates this change is already in it.
 *
 * These tests seed the FIXED KEY STRINGS, exactly as a machine upgrading into
 * this change would have them, and then use the ordinary readers. If a future
 * round ever moves the original compartment's keys, every one of these goes
 * red — which is the point of writing the literal strings here rather than
 * calling `keyFor`.
 * ────────────────────────────────────────────────────────────────────────────
 */
describe('a browser that predates many wallets', () => {
  it('opens its wallet, with its passkeys, name, labels and map intact', async () => {
    /* Sealed the old way: same call, same key, because the key has not moved. */
    const secret = newSecret();
    await saveSecret(secret);
    saveWalletName(secret, 'My wallet');
    saveSubwalletName(secret, 2, 'Rent');
    savePasskey(passkeyFixture('old-credential'), ORIGINAL_SLOT);
    await saveSecuredSetup(secret, await splitSecret(secret, PLACEMENTS, 2), VERIFICATION);

    /* Every record is at the string it was at before. */
    expect(backing.get(KEYRING_KEY)).toBeDefined();
    expect(backing.get(PASSKEYS_KEY)).toBeDefined();
    expect(backing.get(SECURED_KEY)).toBeDefined();
    expect(backing.get('midnight-identity:wallet-name')).toBeDefined();
    expect(backing.get('midnight-identity:subwallets')).toBeDefined();

    /* Now forget the index entirely — the state of a browser that upgraded
     * without ever writing one, and also the state of a damaged one. */
    backing.delete('midnight-identity:wallets');
    forgetOpenWallet();

    /* The wallet is still found, still in the original compartment, and every
     * reader still answers. */
    expect(heldWallets().map((w) => w.id)).toEqual([ORIGINAL_SLOT]);
    expect([...(await loadSecret(ORIGINAL_SLOT))!]).toEqual([...secret]);
    expect(walletNameOf(secret)).toBe('My wallet');
    expect(loadSubwallets(secret).names['2']).toBe('Rent');
    expect(allPasskeys(ORIGINAL_SLOT).map((k) => k.credentialId)).toEqual(['old-credential']);
    expect(loadSecuredSetup(secret)?.pieces).toHaveLength(3);
    expect(walletOfCredential('old-credential')?.walletId).toBe(ORIGINAL_SLOT);
  });

  it('the first wallet on a virgin browser lands in the original compartment', async () => {
    const secret = newSecret();
    expect(await saveSecret(secret)).toBe(ORIGINAL_SLOT);
    expect(backing.get(KEYRING_KEY)).toBeDefined();
  });

  it('a second wallet lands BESIDE it — the first is still openable afterwards', async () => {
    const first = newSecret();
    const firstSlot = await saveSecret(first);
    const before = backing.get(KEYRING_KEY);

    const second = newSecret();
    const secondSlot = await saveSecret(second);
    expect(secondSlot).not.toBe(firstSlot);

    /* THE ASSERTION THE WHOLE ROUND IS FOR: the first wallet\u2019s sealed copy
     * is byte-for-byte what it was, and it still opens to the first secret. */
    expect(backing.get(KEYRING_KEY)).toBe(before);
    expect([...(await loadSecret(firstSlot))!]).toEqual([...first]);
    expect([...(await loadSecret(secondSlot))!]).toEqual([...second]);
  });

  it('re-landing the SAME wallet lands on itself rather than twice in the list', async () => {
    const secret = newSecret();
    const slot = await saveSecret(secret);
    saveWalletName(secret, 'My wallet');
    /* A recovery or a pairing of a wallet this browser already holds. */
    expect(await saveSecret(secret)).toBe(slot);
    expect(heldWallets()).toHaveLength(1);
    expect(walletNameOf(secret)).toBe('My wallet');
  });

  it('a landing with no keyring in the compartment replaces the leftovers — startFresh',
    async () => {
      /* `passkey-no-account`: credentials and a stale name, nothing behind
       * them. A compartment with no keyring is a shelf, not a wallet. */
      const gone = newSecret();
      saveWalletName(gone, 'The wallet that went');
      savePasskey(passkeyFixture('stale-credential'), ORIGINAL_SLOT);

      const fresh = newSecret();
      expect(await saveSecret(fresh)).toBe(ORIGINAL_SLOT);
      saveWalletName(fresh, '');
      expect(heldWallets()).toHaveLength(1);
      /* The name that would otherwise have sat over the new wallet's money. */
      expect(walletNameOnRecord(ORIGINAL_SLOT)).toBeNull();
      expect(walletNameOf(gone)).toBeNull();
    });

  it('removing a wallet takes its records and its place in the list, and no other\u2019s',
    async () => {
      const keep = newSecret();
      const keepSlot = await saveSecret(keep);
      saveWalletName(keep, 'Keep me');
      const drop = newSecret();
      const dropSlot = await saveSecret(drop);
      saveWalletName(drop, 'Drop me');
      await saveSecuredSetup(drop, await splitSecret(drop, PLACEMENTS, 2), VERIFICATION);

      forgetEverything(dropSlot);

      expect(heldWallets().map((w) => w.id)).toEqual([keepSlot]);
      expect(await loadSecret(dropSlot)).toBeNull();
      expect(securedSetupOnRecord(dropSlot)).toBeNull();
      openWallet(keepSlot);
      expect(walletNameOf(keep)).toBe('Keep me');
      expect([...(await loadSecret(keepSlot))!]).toEqual([...keep]);
    });
});
