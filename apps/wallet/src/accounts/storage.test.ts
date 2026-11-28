import { IDBFactory } from 'fake-indexeddb';
import { newSecret } from 'midnight-identity/keys/derivation';
import { fromBase64Url, toBase64Url } from 'midnight-identity/passkey/bytes';
import type { Passkey } from 'midnight-identity/passkey/verify';
import type { PieceSet, Placement } from 'midnight-identity/recovery/pieces';
import { fingerprintOf, splitSecret } from 'midnight-identity/recovery/pieces';
import { beforeEach, describe, expect, it } from 'vitest';

import { snapshotForTest } from '../testing/snapshot.js';
import {
  allPasskeys,
  arrivalOf,
  creationOf,
  forgetEverything,
  forgetPasskey,
  loadSecret,
  loadSecuredSetup,
  loadSubwallets,
  loadWalletCheckpoint,
  openHere,
  saveArrival,
  saveCreation,
  savePasskey,
  saveSecret,
  saveSecuredSetup,
  saveSubwalletName,
  saveWalletCheckpoint,
  saveWalletName,
  sealHere,
  securedSetupOnRecord,
  StorageError,
  walletNameOf,
  walletNameOnRecord,
  walletOfCredential
} from './storage.js';
import { forgetOpenWallet, heldWallets, openWallet, ORIGINAL_SLOT } from './wallets-held.js';

const A_STATE = snapshotForTest({ coinPublicKey: 'coin-key-a' });
const B_STATE = snapshotForTest({ coinPublicKey: 'coin-key-b' });

/* The wallet's stored records, read back after the damage a torn write, a hand edit, an older build or another wallet
 * leaves; the home screen's green tick shows whenever `loadSecuredSetup` returns a record, so each refusal must be null. */

const SECURED_KEY = 'midnight-identity:secured';
const KEYRING_KEY = 'midnight-identity:keyring';
const PASSKEYS_KEY = 'midnight-identity:passkeys';

const backing = new Map<string, string>();

beforeEach(() => {
  backing.clear();
  /* `length` and `key` are needed: `heldWallets` finds a wallet by its key names when the directory record is lost. */
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, String(value));
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
    get length() {
      return backing.size;
    },
    key: (index: number) => [...backing.keys()][index] ?? null
  };
  /* The open compartment is per window, so it is module state that outlives a test. */
  forgetOpenWallet();
  /* A fresh, working IndexedDB per test; the tests of a blocked or wiped one replace it themselves. */
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
});

const PLACEMENTS: readonly Placement[] = [
  { label: 'My Google account', holder: 'google:me' },
  { label: 'Printed card', holder: 'paper' },
  { label: 'Old laptop', holder: 'device:old' }
];

/** A record as the securing flow will write it: a real cut, proved, through the only writer. */
const VERIFICATION: Readonly<Record<string, number | 'never' | null>> = {
  'google:me': 1_000,
  paper: null,
  'device:old': 'never'
};

async function writtenRecord(forSecret = newSecret()): Promise<{
  forSecret: Uint8Array;
  set: PieceSet;
  raw: string;
}> {
  const set = await splitSecret(forSecret, PLACEMENTS, 2);
  await saveSecuredSetup(forSecret, set, VERIFICATION);
  const raw = backing.get(SECURED_KEY);
  if (raw === undefined) throw new Error('the writer stored no record');
  return { forSecret, set, raw };
}

/** A stored record's fields, to be damaged one at a time. */
const fieldsOf = (raw: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('the record is not an object');
  return Object.fromEntries(Object.entries(parsed));
};

/** The StorageError a call fails with; a call that succeeds, or fails any other way, fails the test. */
const storageErrorOf = async (call: () => unknown): Promise<StorageError> => {
  try {
    await call();
  } catch (e) {
    if (e instanceof StorageError) return e;
    throw e;
  }
  throw new Error('the call did not fail');
};

describe('saveSecuredSetup — rebuiltAt is evidence, not caller data', () => {
  it('writes only after actually rebuilding, and stamps its own clock', async () => {
    const before = Date.now();
    const { forSecret } = await writtenRecord();
    const after = Date.now();
    const setup = loadSecuredSetup(forSecret);
    expect(setup).not.toBeNull();
    expect(setup?.threshold).toBe(2);
    expect(setup?.pieces).toHaveLength(3);
    /* No argument can set the date: it is the writer's own clock, read after the proof ran. */
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

  it('refuses to write a record for a set that does not recover the secret', async () => {
    const secret = newSecret();
    const foreignSet = await splitSecret(newSecret(), PLACEMENTS, 2);
    await expect(saveSecuredSetup(secret, foreignSet, VERIFICATION)).rejects.toThrow();
    expect(backing.has(SECURED_KEY)).toBe(false);
  });

  it('the serialised record contains NO share bytes', async () => {
    /* The writer is handed real shares and writes metadata only, so every encoding a leak could take is checked. */
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

  /* RED WHEN: a record of five pieces needed and none listed shows the green tick. */
  it('refuses the bad record: a threshold with no pieces', async () => {
    const { forSecret, raw } = await writtenRecord();
    const record = fieldsOf(raw);
    backing.set(SECURED_KEY, JSON.stringify({ ...record, threshold: 5, pieces: [] }));
    expect(loadSecuredSetup(forSecret)).toBeNull();
  });

  /* The reader holds a record to `checkPlan`, the rules that refuse a set when it is cut. */
  it('refuses what checkPlan refuses: threshold one, a single piece, one holder twice', async () => {
    const { forSecret, raw } = await writtenRecord();
    const record = fieldsOf(raw);
    const own = (pieces: unknown, threshold: number): void => {
      backing.set(SECURED_KEY, JSON.stringify({ ...record, pieces, threshold }));
      expect(loadSecuredSetup(forSecret)).toBeNull();
    };
    /* "any 1 of these 1 pieces" — copies, not a threshold. */
    own([{ label: 'Only place', holder: 'google:me', lastVerified: null }], 1);
    /* a 2-of-2 where both pieces sit behind the same Google account. */
    own(
      [
        { label: 'Drive A', holder: 'google:me', lastVerified: null },
        { label: 'Drive B', holder: 'google:me', lastVerified: null }
      ],
      2
    );
    /* a 2-of-3 with two pieces in one holder — one of them is decoration. */
    own(
      [
        { label: 'Drive A', holder: 'google:me', lastVerified: null },
        { label: 'Drive B', holder: 'google:me', lastVerified: null },
        { label: 'Paper', holder: 'paper', lastVerified: null }
      ],
      2
    );
  });

  it.each([0, -1, 1.5, '2', null, undefined, Number.NaN, 4])('refuses threshold %j', async (threshold) => {
    const { forSecret, raw } = await writtenRecord();
    const record = fieldsOf(raw);
    backing.set(SECURED_KEY, JSON.stringify({ ...record, threshold }));
    expect(loadSecuredSetup(forSecret)).toBeNull();
  });

  it.each(['yesterday', null, undefined, Number.NaN])(
    'refuses rebuiltAt %j — the tick states a dated fact',
    async (rebuiltAt) => {
      const { forSecret, raw } = await writtenRecord();
      const record = fieldsOf(raw);
      backing.set(SECURED_KEY, JSON.stringify({ ...record, rebuiltAt }));
      expect(loadSecuredSetup(forSecret)).toBeNull();
    }
  );

  /* RED WHEN: `pieces` that are not a list of pieces reach the home screen, which then throws while it draws. */
  it.each([
    7,
    null,
    { length: 3 },
    [null],
    ['garbage'],
    [{ label: 'x' }],
    [{ label: '  ', holder: 'paper', lastVerified: null }],
    [{ label: 'x', holder: 'paper', lastVerified: 'never' }]
  ])('refuses pieces %j', async (pieces) => {
    const { forSecret, raw } = await writtenRecord();
    const record = fieldsOf(raw);
    backing.set(SECURED_KEY, JSON.stringify({ ...record, pieces, threshold: 2 }));
    expect(loadSecuredSetup(forSecret)).toBeNull();
  });

  it.each(['not json {{{', '42', '"secured"', 'null', '[]'])(
    'refuses stored garbage %j rather than throwing',
    (raw) => {
      backing.set(SECURED_KEY, raw);
      expect(loadSecuredSetup(newSecret())).toBeNull();
    }
  );
});

describe('loadSecuredSetup — the record names its account', () => {
  it('refuses a record cut from a different secret', async () => {
    /* Secure account A, start over, create account B: A's record must not become B's proof of backup. */
    const { raw } = await writtenRecord();
    backing.set(SECURED_KEY, raw);
    expect(loadSecuredSetup(newSecret())).toBeNull();
  });

  it('refuses a record whose fingerprint was stripped or forged', async () => {
    const { forSecret, raw } = await writtenRecord();
    const record = fieldsOf(raw);
    const stripped = { ...record };
    delete stripped['fingerprint'];
    backing.set(SECURED_KEY, JSON.stringify(stripped));
    expect(loadSecuredSetup(forSecret)).toBeNull();
    backing.set(
      SECURED_KEY,
      JSON.stringify({
        ...record,
        fingerprint: toBase64Url(fingerprintOf(newSecret()))
      })
    );
    expect(loadSecuredSetup(forSecret)).toBeNull();
  });

  it('reader and writer do not share a blind spot', async () => {
    /* A `fingerprintOf` that returned a constant would let writer and reader agree on every secret. */
    expect(toBase64Url(fingerprintOf(newSecret()))).not.toBe(toBase64Url(fingerprintOf(newSecret())));
  });

  it('securedSetupOnRecord returns the map without the fingerprint check', async () => {
    await writtenRecord();
    /* The broken-storage screen's read, where the secret cannot be unlocked: shape and plan are still checked. */
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

  it.each(['not json at all', '{"sealed": 7, "iv": "AAAA"}', '{"iv": "AAAA"}', '"just a string"'])(
    'throws StorageError(record-damaged) for stored %j',
    async (raw) => {
      backing.set(KEYRING_KEY, raw);
      const failure = await storageErrorOf(() => loadSecret(ORIGINAL_SLOT));
      expect(failure.code).toBe('record-damaged');
      /* The person reads the message on the broken screen, so it must say what to do; nothing branches on its words. */
      expect(failure.message.length).toBeGreaterThan(20);
    }
  );

  it('throws StorageError(sealed-copy-unopenable) when the sealing key is gone', async () => {
    await saveSecret(newSecret());
    /* A cleared profile: the sealed copy survives in localStorage, the key kept in IndexedDB does not. */
    (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
    expect((await storageErrorOf(() => loadSecret(ORIGINAL_SLOT))).code).toBe('sealed-copy-unopenable');
  });

  it('throws StorageError(sealed-copy-unopenable) when IndexedDB is blocked outright', async () => {
    await saveSecret(newSecret());
    /* A Firefox private window and some iOS and managed profiles refuse IndexedDB outright. */
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    expect((await storageErrorOf(() => loadSecret(ORIGINAL_SLOT))).code).toBe('sealed-copy-unopenable');
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
  transports: []
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
    JSON.stringify([{ credentialId: 'bad-b64', personHandle: 'p', publicKeySpki: '!!not-base64url!!' }])
  ])('throws StorageError(record-damaged) for stored %j', async (raw) => {
    backing.set(PASSKEYS_KEY, raw);
    expect((await storageErrorOf(() => allPasskeys(ORIGINAL_SLOT))).code).toBe('record-damaged');
  });

  it('no write path rewrites a damaged store — partial damage stays recoverable', () => {
    const damaged = JSON.stringify([
      { credentialId: 'healthy', personHandle: 'p', publicKeySpki: 'AAAA', transports: [] },
      { credentialId: 'torn' }
    ]);
    backing.set(PASSKEYS_KEY, damaged);
    /* RED WHEN: a save rewrites the store from a read that skipped the torn entry, losing it for good. */
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

describe('StorageError — the contract its callers branch on', () => {
  it('is an Error with a code, and the check is instanceof, never text', () => {
    const error: unknown = new StorageError('sealed-copy-unopenable', 'reworded freely');
    expect(error instanceof Error).toBe(true);
    if (!(error instanceof StorageError)) throw new Error('a StorageError is not an instance of StorageError');
    expect(error.code).toBe('sealed-copy-unopenable');
    expect(error.name).toBe('StorageError');
  });
});

describe('saveSecuredSetup — what was on record is kept, never erased', () => {
  it('a re-cut keeps the replaced set, and chains keep everything', async () => {
    const secret = newSecret();
    await writtenRecord(secret);
    const first = securedSetupOnRecord(ORIGINAL_SLOT);
    expect(first?.superseded).toHaveLength(0);

    /* Re-cut the SAME account with a different plan. */
    const secondSet = await splitSecret(
      secret,
      [
        { label: 'New cloud', holder: 'cloud-two' },
        { label: 'New paper', holder: 'paper-two' }
      ],
      2
    );
    await saveSecuredSetup(secret, secondSet, { 'cloud-two': 'never', 'paper-two': null });
    const second = loadSecuredSetup(secret);
    expect(second?.superseded).toHaveLength(1);
    expect(second?.superseded[0]?.pieces.map((p) => p.holder)).toEqual(['google:me', 'paper', 'device:old']);
    expect(second?.superseded[0]?.supersededAt).toBeGreaterThan(0);

    /* And a third cut carries both forward. */
    const thirdSet = await splitSecret(secret, PLACEMENTS, 2);
    await saveSecuredSetup(secret, thirdSet, VERIFICATION);
    expect(loadSecuredSetup(secret)?.superseded).toHaveLength(2);
  });

  /* Another wallet's map is a different record in a different compartment, so it is never touched; a wallet that
   * replaces its own plan keeps the old one in `superseded`, as the re-cut test above holds. */
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
    const record = fieldsOf(raw);
    for (const superseded of [
      7,
      [{}],
      [{ fingerprint: 'x', threshold: 9, pieces: [], rebuiltAt: 1, supersededAt: 1 }]
    ]) {
      backing.set(SECURED_KEY, JSON.stringify({ ...record, superseded }));
      expect(loadSecuredSetup(forSecret)).toBeNull();
    }
    /* A record with no `superseded` field reads as having none. */
    delete record['superseded'];
    backing.set(SECURED_KEY, JSON.stringify(record));
    expect(loadSecuredSetup(forSecret)?.superseded).toEqual([]);
  });
});

describe('saveSecuredSetup — the writer refuses to guess verifiability', () => {
  it('throws, and writes nothing, when a holder has no verification state', async () => {
    const secret = newSecret();
    const set = await splitSecret(secret, PLACEMENTS, 2);
    await expect(saveSecuredSetup(secret, set, { 'google:me': 'never', paper: null })).rejects.toThrow(
      /no verification state/
    );
    expect(backing.has(SECURED_KEY)).toBe(false);
  });

  it("refuses a stored lastVerified that is neither a time, 'never', nor null", async () => {
    const { forSecret, raw } = await writtenRecord();
    const record = fieldsOf(raw);
    const kept = record['pieces'];
    if (!Array.isArray(kept)) throw new Error('the record lists no pieces');
    const pieces = kept.map((p: unknown, i) => (i === 0 && typeof p === 'object' ? { ...p, lastVerified: 'soon' } : p));
    backing.set(SECURED_KEY, JSON.stringify({ ...record, pieces }));
    expect(loadSecuredSetup(forSecret)).toBeNull();
  });
});

describe('the partial flag — a recovery map is honest about its edges', () => {
  it('defaults to complete: the wizard writes false, and records from before parse as false', async () => {
    const { forSecret, raw } = await writtenRecord();
    expect(loadSecuredSetup(forSecret)?.partial).toBe(false);
    /* A record with no `partial` field. */
    const record = fieldsOf(raw);
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

/* One test per kind of record: each lands two real wallets, so the compartments are real, and asks for B's record
 * with A's secret, so the fingerprint check is held too and removing it turns these red. */
describe('THE RULE — no record of wallet B is ever shown over wallet A', () => {
  async function twoWallets(): Promise<{
    a: Uint8Array;
    b: Uint8Array;
    aSlot: string;
    bSlot: string;
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
    /* The locked screen's unchecked reader names the compartment it is given; with two wallets the first slot is B. */
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

    /* The browser offers every credential for this origin, and the unlock screen must say which wallet each opens. */
    expect(walletOfCredential('cred-for-b')?.walletId).toBe(bSlot);
    expect(walletOfCredential('cred-for-a')?.walletId).toBe(aSlot);
    /* A credential a password manager still offers with nothing behind it here is null, never a wrong wallet. */
    expect(walletOfCredential('cred-from-a-cleared-browser')).toBeNull();
  });

  it("A RECORD KEPT BESIDE THE SECRET IS SEALED UNDER THAT WALLET'S OWN KEY, OPENS ONLY THERE, AND LEAVES THE SECRET'S SEAL AS IT WAS", async () => {
    const { aSlot, bSlot, a } = await twoWallets();
    const kept = await sealHere('{"vault":"the record"}', aSlot);
    /* RED WHEN: the record is kept in the open. */
    expect(JSON.stringify(kept)).not.toContain('the record');
    /* RED WHEN: it does not open under the wallet that sealed it, or opens under another wallet's key. */
    expect(await openHere(kept, aSlot)).toBe('{"vault":"the record"}');
    expect(await openHere(kept, bSlot)).toBeNull();
    const tampered = fromBase64Url(kept.sealed).map((byte, i) => (i === 0 ? byte ^ 1 : byte));
    expect(await openHere({ ...kept, sealed: toBase64Url(tampered) }, aSlot)).toBeNull();
    /* RED WHEN: sealing beside it changes the key the secret is sealed and opened with. */
    expect([...(await loadSecret(aSlot))!]).toEqual([...a]);
  });

  it('BALANCE CHECKPOINTS — THE STORE KEEPS NO SNAPSHOT HOLDING ANYTHING IN FLIGHT, AND NONE IT CANNOT READ', async () => {
    const { aSlot } = await twoWallets();
    for (const [why, serialized] of [
      ['a coin set aside', snapshotForTest({ inFlight: 'spend' })],
      ['a coin expected', snapshotForTest({ inFlight: 'output' })],
      ['unreadable', 'not a snapshot']
    ] as const) {
      /* RED WHEN: whichever writer asks, the store keeps a snapshot whose set-aside coins every restore would keep set aside for good. */
      expect(await saveWalletCheckpoint('coin-key-a', 0, { serialized, night: 3n, asOf: 2_000 }, aSlot), why).toBe(
        false
      );
      expect(await loadWalletCheckpoint('coin-key-a', 0, aSlot), why).toBeNull();
    }
    expect(await saveWalletCheckpoint('coin-key-a', 0, { serialized: A_STATE, night: 3n, asOf: 2_000 }, aSlot)).toBe(
      true
    );
  });

  it('BALANCE CHECKPOINTS — the cache is per wallet, so a switch is not a cold sync', async () => {
    const { aSlot, bSlot } = await twoWallets();
    /* Every call names its compartment, so no call leans on which wallet is open. */
    await saveWalletCheckpoint('coin-key-b', 0, { serialized: B_STATE, night: 7n, asOf: 1_000 }, bSlot);
    await saveWalletCheckpoint('coin-key-a', 0, { serialized: A_STATE, night: 3n, asOf: 2_000 }, aSlot);

    expect((await loadWalletCheckpoint('coin-key-a', 0, aSlot))?.serialized).toBe(A_STATE);
    /* B\u2019s entry for the SAME account number survived A writing one. */
    expect((await loadWalletCheckpoint('coin-key-b', 0, bSlot))?.serialized).toBe(B_STATE);
    /* A checkpoint is refused for a wallet whose coin key it does not name. */
    expect(await loadWalletCheckpoint('coin-key-b', 0, aSlot)).toBeNull();
  });
});

/* A browser that held one wallet before many could be held opens unchanged: its compartment is the fixed key names,
 * written here as literal strings rather than through `keyFor`, so moving them turns these red. */
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

    /* No index at all: a browser that never wrote one, or one whose index was damaged. */
    backing.delete('midnight-identity:wallets');
    forgetOpenWallet();

    /* The wallet is still found in the original compartment, and every reader still answers. */
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

    /* RED WHEN: a second wallet changes a byte of the first wallet's sealed copy, or it no longer opens. */
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

  it('a landing with no keyring in the compartment replaces the leftovers — startFresh', async () => {
    /* Credentials and a stale name with no keyring behind them: the compartment holds no wallet. */
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

  it('removing a wallet takes its records and its place in the list, and no other\u2019s', async () => {
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
