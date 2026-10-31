import { describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { fromHex, randomBytes, seal, signingPublicKeyOf, toHex, unseal, wrapKey } from '../../../src/core/crypto.js';
import { inboxPublicKey } from '../../../src/core/sealed-records.js';
import {
  counterOf, creationIn, KeyringDidNotOpen, metadataFrom, metadataOf, openKeyring, sealKeyring, seatsOf, tidiedWith, servedKeysOpenedFrom,
  withCreation, withNewSeat, withoutCreation, withPaidBy, withPayeeJoinKept, withPendingSeat, type Keyring, type PendingSeat, type SavedCreation, type ServedKeys,
} from './keyring-blob.js';

/*
 * **SAVED KEYS COUNT THEIR OWN WRITES, INSIDE THE SEAL.** The service can hand back an older copy and its version
 * is outside the seal, so the count a reader trusts is the one sealed with the keys. And the parts of the keys that
 * open nothing can be listed without a single secret beside them.
 */

const KEY = toHex(randomBytes(32));
const OTHER = toHex(randomBytes(32));
const HEX = (b: string) => b.repeat(32);

const aSeat = () => ({
  signerId: 'sig_1', signingSecret: HEX('11'), wrappingSecret: HEX('22'), blinding: HEX('33'), scope: HEX('44'),
  opening: { secret: HEX('55') } as never,
});
const aCreation = (accountId: string): SavedCreation => ({
  accountId, person: 'usr_a', label: `co_${'a'.repeat(64)}` as never, foundingKey: { tag: 'schnorr', value: HEX('ab') },
  request: {
    name: 'Acme Ltd', signers: [{ name: 'Priya', role: 'admin' }], threshold: 1, companyLabel: `co_${'a'.repeat(64)}` as never,
    foundingKey: { tag: 'schnorr', value: HEX('ab') },
    founding: {
      seat: { signerId: 'sig_1', signingPublicKey: HEX('61'), wrappingPublicKey: HEX('62'), leaf: HEX('63') },
      account: { id: accountId } as never, roster: { kind: 'roster' } as never, state: { kind: 'state' } as never,
    },
  },
  made: true, deploy: null, signed: null, recorded: false,
});
const aKeyring = (): Keyring => ({
  accounts: { acc_A: aSeat() },
  pendingSeats: { [HEX('71')]: { accountId: 'acc_B', signingPublicKey: HEX('71'), signingSecret: HEX('72'), wrappingSecret: HEX('73'), blinding: HEX('74'), scope: HEX('75') } },
  paidBy: [`co_${'b'.repeat(64)}`],
  creations: { acc_A: aCreation('acc_A') },
  directoryEntriesOwed: {
    acc_A: {
      person: 'usr_a', company: `co_${'a'.repeat(64)}` as never,
      signed: { committeeKey: { tag: 'schnorr', value: HEX('81') }, entry: { account: 'acc_A' } as never },
      opening: { secret: HEX('82') } as never,
    },
  },
});

/** Every key at any depth of a value. */
const keysIn = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.flatMap(keysIn);
  if (typeof v !== 'object' || v === null) return [];
  return Object.entries(v).flatMap(([k, x]) => [k, ...keysIn(x)]);
};

describe('saved keys count their writes inside the seal', () => {
  it('each write is sealed one on from the keys it was made from, and opens to what was written', () => {
    const first = sealKeyring(aKeyring(), KEY);
    /* RED WHEN: a write carries no count, or not one more than the keys it was made from. */
    expect(first.written.counter).toBe(1);
    const opened = openKeyring(first.sealed, KEY);
    expect(counterOf(opened)).toBe(1);
    expect(opened.accounts).toEqual(aKeyring().accounts);
    const second = sealKeyring({ ...opened, paidBy: [] }, KEY);
    expect(counterOf(openKeyring(second.sealed, KEY))).toBe(2);
    /* RED WHEN: the count is kept outside the sealed text, where the service could change it. */
    expect(JSON.parse(unseal(second.sealed, KEY)).counter).toBe(2);
  });

  it('saved keys written before writes were counted read as count 0, and their first write is 1', () => {
    const older = seal(JSON.stringify({ accounts: {} }), KEY);
    /* RED WHEN: keys with no count are refused, or read as anything but 0. */
    expect(counterOf(openKeyring(older, KEY))).toBe(0);
    expect(sealKeyring(openKeyring(older, KEY), KEY).written.counter).toBe(1);
  });

  it('a count that is not a whole number from 0, keys another key sealed, and text that is not a keyring are refused', () => {
    /* RED WHEN: a guessed count lets an older copy pass for a newer one. */
    for (const counter of [-1, 1.5, '3', null]) {
      expect(() => openKeyring(seal(JSON.stringify({ accounts: {}, counter }), KEY), KEY), String(counter)).toThrow(KeyringDidNotOpen);
    }
    /* RED WHEN: keys sealed under another person's or another wallet's key are read. */
    expect(() => openKeyring(seal(JSON.stringify({ accounts: {} }), OTHER), KEY)).toThrow(KeyringDidNotOpen);
    for (const text of ['[]', '"x"', '{"accounts":[]}', '{}']) {
      expect(() => openKeyring(seal(text, KEY), KEY), text).toThrow(KeyringDidNotOpen);
    }
  });

  it('what devices once believed of a roster is not written again', () => {
    const { written } = sealKeyring({ ...aKeyring(), rostersBelieved: {} } as Keyring, KEY);
    /* RED WHEN: a field no longer kept is sealed into the saved keys again. */
    expect(written).not.toHaveProperty('rostersBelieved');
  });
});

describe('the parts of saved keys that open nothing', () => {
  it('lists the creations, the companies that pay, the owed entries and the sealed seats, with no secret anywhere in them', () => {
    const meta = metadataOf({ ...aKeyring(), counter: 5 });
    expect(meta.counter).toBe(5);
    expect(Object.keys(meta.creations)).toEqual(['acc_A']);
    expect(meta.creations['acc_A']!.request.founding.seat.leaf).toBe(HEX('63'));
    expect(meta.paidBy).toEqual([`co_${'b'.repeat(64)}`]);
    expect(meta.pendingSeats).toEqual([{ accountId: 'acc_B', signingPublicKey: HEX('71') }]);
    expect(meta.directoryEntriesOwed['acc_A']!.person).toBe('usr_a');
    /* RED WHEN: a seat's secret, blinding, scope or opening reaches what a page may list. */
    const names = keysIn(meta);
    for (const secret of ['accounts', 'signingSecret', 'wrappingSecret', 'blinding', 'scope', 'opening', 'secret', 'salt']) {
      expect(names, secret).not.toContain(secret);
    }
    /* RED WHEN: no secret value appears under some other name. */
    const text = JSON.stringify(meta);
    for (const value of [HEX('11'), HEX('22'), HEX('33'), HEX('44'), HEX('55'), HEX('72'), HEX('73'), HEX('74'), HEX('82')]) {
      expect(text.includes(value), value).toBe(false);
    }
  });

  it('a field added to a creation later stays out until it is listed as one that may be shown', () => {
    const k = aKeyring();
    const withMore = { ...k, creations: { acc_A: { ...aCreation('acc_A'), seatSecret: HEX('99') } as SavedCreation } };
    /* RED WHEN: what may be shown is made by removing what may not, so a new field is shown unread. */
    expect(JSON.stringify(metadataOf(withMore))).not.toContain(HEX('99'));
  });

  it('a field added at any depth of a creation or an owed entry stays out, and what may be shown still is', () => {
    const EXTRA = HEX('5e');
    /** The same value with an `extra` field added to every object at every depth, arrays included. */
    const withExtra = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(withExtra);
      if (typeof v !== 'object' || v === null) return v;
      return { ...Object.fromEntries(Object.entries(v).map(([key, x]) => [key, withExtra(x)])), extra: EXTRA };
    };
    const sealed = { iv: HEX('01').slice(0, 24), tag: '', body: HEX('02') };
    const record = (kind: string) => ({
      company: 'acc_A', kind, id: `${kind}_1`, version: 1, keyEpoch: 0, sealed,
      wrapped: [{ signerId: 'sig_1', wrapped: { ...sealed, ephemeral: HEX('03') } }],
      facts: { status: 'active' }, filedBy: { publicKey: HEX('05'), signature: HEX('06') },
    });
    const creation = {
      ...aCreation('acc_A'),
      request: {
        ...aCreation('acc_A').request,
        founding: {
          seat: { signerId: 'sig_1', signingPublicKey: HEX('61'), wrappingPublicKey: HEX('62'), leaf: HEX('63') },
          account: {
            id: 'acc_A', createdAt: 'now', keyEpoch: 0, signerCount: 1, memberUserIds: ['usr_a'],
            pendingSigners: [{ id: 'ps_1', userId: null, createdAt: 'now', sealed: { ...sealed, ephemeral: HEX('07') } }],
            wrappedKeys: [{ ...sealed, signerId: 'sig_1', ephemeral: HEX('08') }], inboxPublicKey: HEX('09'),
            sealedRoster: sealed, sealedPolicy: sealed, contractAddress: null, companyLabel: null,
          },
          roster: record('roster'), state: record('state'),
        },
      },
      deploy: { account: HEX('c0'), tx: 'REVQ', insert: [{ circuit: 'payout', key: 'S0VZ' }], builtAt: 1 },
      signed: { tx: 'U0lH', signature: { tag: 'schnorr', value: HEX('0a') }, builtAt: 2 },
    };
    const owed = {
      person: 'usr_a', company: `co_${'a'.repeat(64)}`,
      signed: { committeeKey: { tag: 'schnorr', value: HEX('81') }, entry: { account: 'acc_A', signingKey: HEX('0b'), wrappingKey: HEX('0c'), seat: HEX('0d'), signature: HEX('0e') } },
      invited: {
        terms: { company: 'acc_A', invitation: HEX('0f'), person: 'usr_a', name: 'Priya', role: 'admin', leaf: HEX('10'), replaces: { invitation: HEX('11'), signedBy: HEX('12'), signature: HEX('13') } },
        signedBy: HEX('14'), signature: HEX('15'),
      },
    };
    const k = { accounts: {}, creations: { acc_A: withExtra(creation) }, directoryEntriesOwed: { acc_A: withExtra(owed) } } as unknown as Keyring;
    const meta = metadataOf(k);
    /* RED WHEN: a field inside a creation's account, roster, state, deploy or second step, or inside an owed entry's
     * signed entry or invitation, reaches what a page may list unread. */
    expect(JSON.stringify(meta)).not.toContain(EXTRA);
    expect(keysIn(meta)).not.toContain('extra');
    /* RED WHEN: filtering drops what a page lists and acts on. */
    expect(meta.creations['acc_A']).toEqual(creation);
    expect(meta.directoryEntriesOwed['acc_A']).toEqual(owed);
  });
});

describe('what an action changes in saved keys', () => {
  it('keeps, reads and drops a creation, and holds a new seat but never writes over one', () => {
    const k: Keyring = { accounts: {} };
    const kept = withCreation(k, aCreation('acc_C'));
    expect(creationIn(kept, 'acc_C')?.accountId).toBe('acc_C');
    expect(creationIn(withCreation(k, { ...aCreation('acc_C'), setAside: true }), 'acc_C')).toBeUndefined();
    expect(creationIn(withoutCreation(kept, 'acc_C'), 'acc_C')).toBeUndefined();
    const seated = withNewSeat(k, 'acc_C', aSeat());
    expect(seated.accounts['acc_C']?.signingSecret).toBe(HEX('11'));
    /* RED WHEN: a seat is written over the only copy of another seat's secrets for the same company. */
    expect(() => withNewSeat(seated, 'acc_C', { ...aSeat(), signingSecret: HEX('99') })).toThrow();
  });

  it('keeps a seat before its leaf is published under its signing public key, again without change, and never over another', () => {
    const pending: PendingSeat = {
      accountId: 'acc_C', signingPublicKey: signingPublicKeyOf(HEX('11')).toUpperCase() as never, signingSecret: HEX('11'),
      wrappingSecret: HEX('22'), blinding: HEX('33'), scope: HEX('44'), seat: 2,
    };
    const k: Keyring = { accounts: {} };
    const kept = withPendingSeat(k, pending);
    const key = signingPublicKeyOf(HEX('11')).toLowerCase();
    expect(kept.pendingSeats).toEqual({ [key]: pending });
    /* RED WHEN: the same seat kept again is refused or changes the saved keys. */
    expect(withPendingSeat(kept, pending)).toBe(kept);
    /* RED WHEN: another seat is written over a seat kept under the same key, the only copy of a leaf maybe published. */
    expect(() => withPendingSeat(kept, { ...pending, blinding: HEX('99') })).toThrow(/not written over/u);
  });

  it('lists a company that pays this person once, beside every company listed before, and lists nothing that is not a company', () => {
    const A = `co_${'a'.repeat(64)}`;
    const B = `co_${'b'.repeat(64)}`;
    const k: Keyring = { accounts: {}, paidBy: [A, 'kept as it was'] };
    const listed = withPaidBy(k, B as never);
    /* RED WHEN: listing a company drops or reorders one listed before. */
    expect(listed.paidBy).toEqual([A, 'kept as it was', B]);
    /* RED WHEN: a company already listed is listed twice, or listing it again writes new saved keys. */
    expect(withPaidBy(listed, B as never)).toBe(listed);
    expect(withPaidBy({ accounts: {} }, A as never).paidBy).toEqual([A]);
    /* RED WHEN: something that is not a company's label is listed as a company that pays you. */
    expect(() => withPaidBy(k, 'acc_1' as never)).toThrow(/not a company/u);
  });

  it('keeps a join as a payee under its invitation, again without change, never over another, and never for the page', () => {
    const A = `co_${'a'.repeat(64)}`;
    const kept = withPayeeJoinKept({ accounts: {} }, 'inv_1', { company: A, address: 'mn_shield-addr_one' });
    expect(kept.payeeJoinsKept).toEqual({ inv_1: { company: A, address: 'mn_shield-addr_one' } });
    /* RED WHEN: the same join kept again is refused or changes the saved keys. */
    expect(withPayeeJoinKept(kept, 'inv_1', { company: A, address: 'mn_shield-addr_one' })).toBe(kept);
    /* RED WHEN: another join is written over one kept under the same invitation, whose code may have been handed over. */
    expect(() => withPayeeJoinKept(kept, 'inv_1', { company: A, address: 'mn_shield-addr_two' })).toThrow(/not written over/u);
    /* RED WHEN: the address a join was paid at reaches what the page is shown of the saved keys. */
    expect(JSON.stringify(metadataOf(kept))).not.toContain('mn_shield-addr_one');
  });
});

describe('WHAT A WALLET READS FROM SAVED KEYS FOR A PAGE HOLDS NO SECRET', () => {
  const wrappingPublic = toHex(x25519.getPublicKey(fromHex(HEX('22'))));
  const viewingKey = toHex(randomBytes(32));
  const served = (over: Partial<ServedKeys> = {}): ServedKeys => ({
    accountId: 'acc_A', inboxPublicKey: inboxPublicKey(viewingKey, 'acc_A'),
    wrappedKeys: [{ signerId: 'sig_1', ...wrapKey(viewingKey, wrappingPublic) }], ...over,
  });

  it('gives each seat\'s public halves and scope, and none of its secrets', () => {
    const seats = seatsOf(aKeyring());
    expect(seats).toEqual({ acc_A: { signerId: 'sig_1', signingPublicKey: signingPublicKeyOf(HEX('11')).toLowerCase(), wrappingPublicKey: wrappingPublic, scope: HEX('44') } });
    /* RED WHEN: a seat's signing secret, wrapping secret or blinding is in what a page is given. */
    for (const secret of [HEX('11'), HEX('22'), HEX('33'), HEX('55')]) expect(JSON.stringify(seats)).not.toContain(secret);
  });

  it('opens a company\'s viewing key only when it makes the company\'s inbox public key', () => {
    expect(servedKeysOpenedFrom(aKeyring(), [served()])).toEqual({ acc_A: viewingKey });
    /* RED WHEN: anything else wrapped to the seat is opened for the page: here a key whose inbox key the page made up. */
    const other = toHex(randomBytes(32));
    expect(servedKeysOpenedFrom(aKeyring(), [served({ wrappedKeys: [{ signerId: 'sig_1', ...wrapKey(other, wrappingPublic) }] })])).toEqual({});
    /* RED WHEN: a key is opened for a company this keyring holds no seat on, or for another seat's copy. */
    expect(servedKeysOpenedFrom(aKeyring(), [served({ accountId: 'acc_Z' })])).toEqual({});
    expect(servedKeysOpenedFrom(aKeyring(), [served({ wrappedKeys: [{ ...served().wrappedKeys[0]!, signerId: 'sig_2' }] })])).toEqual({});
  });

  it('makes a page\'s asked changes to creations only where the saved keys agree, touching no seat', () => {
    const k = { ...aKeyring(), creations: { acc_A: aCreation('acc_A'), acc_S: { ...aCreation('acc_S'), signed: { tx: 'x', signature: { tag: 'schnorr', value: HEX('aa') } } } } };
    /* RED WHEN: a creation with nothing signed for it is not dropped as asked. */
    expect(tidiedWith(k, [{ record: 'acc_A', what: 'forget' }]).creations?.['acc_A']).toBeUndefined();
    /* RED WHEN: a creation something was signed for is dropped, so a deploy that may still land is forgotten. */
    expect(tidiedWith(k, [{ record: 'acc_S', what: 'forget' }])).toBe(k);
    /* RED WHEN: setting one aside drops any of it, or a seat. */
    const aside = tidiedWith(k, [{ record: 'acc_S', what: 'aside' }]);
    expect(aside.creations?.['acc_S']).toEqual({ ...k.creations.acc_S, setAside: true });
    expect(aside.accounts).toEqual(k.accounts);
    expect(tidiedWith(k, [{ record: 'acc_none', what: 'aside' }])).toBe(k);
  });

  it('is read again on the page through the same allow-list, whatever a wallet answered', () => {
    const answered = { ...metadataOf(aKeyring()), accounts: { acc_A: aSeat() }, creations: { acc_A: { ...aCreation('acc_A'), signingSecret: HEX('11') } } };
    const read = metadataFrom(answered);
    /* RED WHEN: a field the allow-list does not name, a seat's secret say, reaches the page's memory. */
    expect(JSON.stringify(read)).not.toContain(HEX('11'));
    expect(read.creations['acc_A']?.label).toBe(aCreation('acc_A').label);
  });
});
