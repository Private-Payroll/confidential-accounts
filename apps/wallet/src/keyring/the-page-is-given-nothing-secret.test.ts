import { describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { keyringHolderFor, keyringKeyFor } from 'midnight-identity/profile/unlock';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import type { KeyringRequest } from 'midnight-identity/profile/request';
import { fromHex, randomBytes, toHex, wrapKey } from '../../../../src/core/crypto.js';
import { inboxPublicKey } from '../../../../src/core/sealed-records.js';
import { openKeyring, sealedDigestOf, sealKeyring, type Keyring, type SavedCreation } from '../../../../packages/web-shared/src/keyring-blob.js';
import { foundTheCompanyInTheWallet } from './found-company.js';
import { SavedKeysRefused, type KeyringMark, type KeyringMarks } from './held-keyring.js';
import { keysReadForThePage } from './read-for-the-page.js';
import { keyringSealKeyFor } from './seal-key.js';

/*
 * **WHAT THE PAGE IS GIVEN OF THE PERSON'S SAVED KEYS IS NOTHING SECRET.** The wallet opens the saved keys the page
 * handed in and answers with each seat's public halves and scope, each company's viewing key it opened and believed,
 * the parts that open nothing and its own public name for the person; the creation changes the page asked for come
 * back sealed again, only where the saved keys agree. Nothing that signs, opens the saved keys or proves is in it.
 */
const PAGE = 'https://app.payroll.example';
const secret = newSecret();
const identity = identityFromSecret(secret);
const SEAT = { signerId: 'sig_1', signingSecret: '11'.repeat(32), wrappingSecret: '22'.repeat(32), blinding: '33'.repeat(32), scope: '44'.repeat(32) };
const VIEWING = toHex(randomBytes(32));
const ask = (over: Partial<KeyringRequest> = {}): KeyringRequest => ({
  schema: 'midnight-identity/disclosure-request/v1', kind: 'keyring', requester: { origin: PAGE, name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'x', nonce: 'k1', expiresAt: Date.now() + 600_000, person: 'usr_a', signedInAs: null, company: null, account: null, drawLabel: false,
  ...over,
} as KeyringRequest);
const KEY = toHex(keyringSealKeyFor(identity, ask()));
const marks = (): KeyringMarks => {
  const seen = new Map<string, KeyringMark>();
  return { markOf: (p) => seen.get(p) ?? null, raise: (p, m) => { seen.set(p, m); } };
};
const creation = (accountId: string, signed: boolean): SavedCreation => ({
  accountId, person: 'usr_a', label: drawCompanyLabel(), foundingKey: { tag: 'schnorr', value: 'ab'.repeat(32) },
  request: { name: 'Acme Ltd', signers: [{ name: 'Priya', role: 'admin' }], threshold: 1 } as never,
  made: true, deploy: null, signed: signed ? { tx: 'x', signature: { tag: 'schnorr', value: 'aa'.repeat(64) } } : null, recorded: false,
});
const held = (): Keyring => ({ accounts: { acc_A: SEAT }, creations: { acc_U: creation('acc_U', false), acc_S: creation('acc_S', true) } });
const handedIn = (k: Keyring) => ({ sealed: sealKeyring(k, KEY).sealed, version: 4 });
const served = () => [{
  accountId: 'acc_A', inboxPublicKey: inboxPublicKey(VIEWING, 'acc_A'),
  wrappedKeys: [{ signerId: 'sig_1', ...wrapKey(VIEWING, toHex(x25519.getPublicKey(fromHex(SEAT.wrappingSecret)))) }],
}];
const secretsOf = (k: Keyring): string[] => Object.values(k.accounts).flatMap((s) => [s.signingSecret, s.wrappingSecret, s.blinding]);

describe('THE PAGE IS GIVEN NOTHING SECRET OF THE SAVED KEYS', () => {
  it('answers with the seat\'s public halves, the believed viewing key, the metadata and its public name, and no secret', () => {
    const read = keysReadForThePage({ identity, request: ask({ keyring: handedIn(held()), served: served() }), marks: marks() })!.read;
    expect(Object.keys(read.seats)).toEqual(['acc_A']);
    expect(read.viewing).toEqual({ acc_A: VIEWING });
    expect(read.holder).toBe(keyringHolderFor(identity, ask()));
    expect(read.resealed).toBeNull();
    const wire = JSON.stringify(read);
    /* RED WHEN: a seat's secret, or the key the saved keys open with, is in what the page is given. */
    for (const s of [...secretsOf(held()), KEY]) expect(wire).not.toContain(s);
  });

  it('makes the creation changes the page asked for only where the saved keys agree, and hands them back sealed', () => {
    const read = keysReadForThePage({
      identity, marks: marks(),
      request: ask({ keyring: handedIn(held()), served: [], tidy: [{ record: 'acc_U', what: 'forget' }, { record: 'acc_S', what: 'forget' }] }),
    })!.read;
    /* RED WHEN: the asked changes are not made, or one is made on a creation something was signed for. */
    const again = openKeyring(read.resealed!.sealed as never, KEY);
    expect(Object.keys(again.creations ?? {})).toEqual(['acc_S']);
    expect(again.accounts).toEqual(held().accounts);
    expect(read.resealed!.ifVersion).toBe(4);
    expect(Object.keys((read.metadata as { creations: object }).creations)).toEqual(['acc_S']);
  });

  it('answers with nothing read when the page handed no saved keys in', () => {
    expect(keysReadForThePage({ identity, request: ask(), marks: marks() })).toBeNull();
  });

  it('a founding\'s answer holds the new company\'s viewing key and seat by their public halves only', async () => {
    const label = drawCompanyLabel();
    const done = await foundTheCompanyInTheWallet({
      identity, label, marks: marks(),
      request: ask({ drawLabel: true, founding: { name: 'Acme Ltd', signer: { name: 'Priya', role: 'admin' } }, keyring: { sealed: null, version: 0 } }),
    });
    const id = done.accountId;
    /* RED WHEN: the page is not given the new company's viewing key, so opening it costs a window. */
    expect(Object.keys(done.read.viewing)).toEqual([id]);
    expect(Object.keys(done.read.seats)).toEqual([id]);
    const kept = openKeyring(done.sealed as never, KEY);
    /* RED WHEN: the new seat's secrets are in what the page is given. */
    for (const s of secretsOf(kept)) expect(JSON.stringify(done.read)).not.toContain(s);
  });
});

describe('SAVED KEYS SEALED UNDER THE OLD KEY COME BACK SEALED UNDER THE NEW ONE', () => {
  it('re-seals a copy under the old key with every seat as it was, though nothing else was asked', () => {
    const OLD = toHex(keyringKeyFor(identity, ask()));
    const handed = { sealed: sealKeyring(held(), OLD).sealed, version: 4 };
    const read = keysReadForThePage({ identity, request: ask({ keyring: handed, served: [] }), marks: marks() })!.read;
    /* RED WHEN: a copy under the key pages were once given is left under it, or comes back changed. */
    expect(read.resealed).not.toBeNull();
    const again = openKeyring(read.resealed!.sealed as never, KEY);
    expect(again.accounts).toEqual(held().accounts);
    expect(() => openKeyring(read.resealed!.sealed as never, OLD)).toThrow();
    expect(read.resealed!.ifVersion).toBe(4);
  });

  it('once the answer with the copy re-sealed has gone, the mark says so and no copy under the old key opens here again', () => {
    const OLD = toHex(keyringKeyFor(identity, ask()));
    const handed = { sealed: sealKeyring(held(), OLD).sealed, version: 4 };
    const m = marks();
    const here = keysReadForThePage({ identity, request: ask({ keyring: handed, served: [] }), marks: m })!;
    /* RED WHEN: the mark is raised before the answer has gone, so an answer the page never had strands the old copy. */
    expect(m.markOf('usr_a')?.under).toBeUndefined();
    here.handedOver();
    /* RED WHEN: the re-seal on this path raises nothing, so this device goes on opening copies under the old key. */
    expect(m.markOf('usr_a')).toEqual({ counter: 2, digest: sealedDigestOf(here.read.resealed!.sealed as never), under: 2 });
    /* RED WHEN: a device that has moved the copy to the new key opens one still under the old key, or refuses it as anything but an older copy. */
    expect(() => keysReadForThePage({ identity, request: ask({ keyring: handed, served: [] }), marks: m })).toThrow(SavedKeysRefused);
    expect(() => keysReadForThePage({ identity, request: ask({ keyring: handed, served: [] }), marks: m })).toThrow(/before this device moved them to the key no page holds, so they are an older copy/);
    /* The copy the page was handed opens, and the mark moves on with it. */
    const kept = { sealed: here.read.resealed!.sealed, version: 5 };
    expect(keysReadForThePage({ identity, request: ask({ keyring: kept as never, served: [] }), marks: m })!.read.resealed).toBeNull();
  });
});
