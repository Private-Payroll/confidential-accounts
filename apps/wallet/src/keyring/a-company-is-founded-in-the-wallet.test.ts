import { describe, expect, it } from 'vitest';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { seatKeysFor } from 'midnight-identity/profile/seat-keys';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import type { KeyringRequest } from 'midnight-identity/profile/request';
import { toHex, unwrapKey } from '../../../../src/core/crypto.js';
import { foundingStateRefusal, openStateRecord } from '../../../../src/core/founding-state.js';
import { verifiedCompanyFiler } from '../../../../src/midnight/sealed-record-wire.js';
import { openKeyring, sealKeyring } from '../../../../packages/web-shared/src/keyring-blob.js';
import { foundTheCompanyInTheWallet, NotFoundedHere } from './found-company.js';
import { foundingSeatOf } from './founding-seat.js';
import type { KeyringMark, KeyringMarks } from './held-keyring.js';
import { keyringSealKeyFor } from './seal-key.js';

/*
 * A NEW COMPANY IS FOUNDED IN THE WALLET: the founding seat made from the wallet's words for the label it drew, the
 * founding roster and state signed with it, and the seat and the founding written into the person's saved keys,
 * sealed again under the wallet's key for them. What the page gets back is the founding and the sealed saved keys.
 */
const PAGE = 'https://app.payroll.example';
const secret = newSecret();
const identity = identityFromSecret(secret);
const ask = (over: Partial<KeyringRequest> = {}): KeyringRequest => ({
  schema: 'midnight-identity/disclosure-request/v1', kind: 'keyring', requester: { origin: PAGE, name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'x', nonce: 'k1', expiresAt: Date.now() + 600_000, person: 'usr_a', signedInAs: null, company: null, account: null, drawLabel: true,
  founding: { name: 'Acme Ltd', signer: { name: 'Priya', role: 'admin' } }, keyring: { sealed: null, version: 0 }, ...over,
} as KeyringRequest);
const KEY = toHex(keyringSealKeyFor(identity, ask()));
const marks = (): KeyringMarks & { seen: Map<string, KeyringMark> } => {
  const seen = new Map<string, KeyringMark>();
  return { seen, markOf: (p) => seen.get(p) ?? null, raise: (p, m) => { seen.set(p, m); } };
};

describe('A COMPANY IS FOUNDED IN THE WALLET', () => {
  /* RED WHEN: the seat kept is not seat 0 of the wallet's words for the label, the founding is not signed by it, or the saved keys sealed hold another seat or no founding. */
  it('makes the founding seat from its words, signs the founding with it, and keeps both in the saved keys it seals again', async () => {
    const label = drawCompanyLabel();
    const done = await foundTheCompanyInTheWallet({ identity, request: ask(), label, marks: marks() });
    const words = seatKeysFor(identity, label, 0);
    const seat = await foundingSeatOf(identity, label);
    expect(seat.signingSecret).toBe(toHex(words.signingSecret));
    expect(done.founded.seat).toMatchObject({ signingPublicKey: seat.signingPublicKey, wrappingPublicKey: seat.wrappingPublicKey, leaf: seat.leaf });
    expect(verifiedCompanyFiler(done.founded.roster)).toBe(seat.signingPublicKey);
    expect(foundingStateRefusal(done.founded.state, done.accountId, seat.signingPublicKey)).toBeNull();
    const companyKey = unwrapKey(done.founded.account.wrappedKeys[0] as never, seat.wrappingSecret);
    expect(String(openStateRecord(done.founded.state, companyKey as never).blinding.payRecordKey)).toMatch(/^[0-9a-f]{64}$/u);
    const kept = openKeyring(done.sealed as never, KEY as never);
    expect(kept.accounts[done.accountId]).toMatchObject({ signerId: done.founded.seat.signerId, signingSecret: seat.signingSecret, blinding: seat.blinding });
    expect(kept.creations?.[done.accountId]).toMatchObject({
      label, person: 'usr_a', made: false, deploy: null, signed: null, recorded: false,
      foundingKey: { tag: 'schnorr', value: String(committeeKeyFor(identity, label).value).toLowerCase() },
    });
    expect(done.ifVersion).toBe(0);
  });

  /* RED WHEN: a founding seals over the saved keys handed in instead of beside what they hold, or ignores the version they were handed at. */
  it('writes the new seat beside every seat already kept, one write on, over the version handed in', async () => {
    const held = sealKeyring({ accounts: { acc_old: { signerId: 's', signingSecret: '11'.repeat(32), wrappingSecret: '22'.repeat(32), blinding: '33'.repeat(32), scope: '44'.repeat(32) } }, counter: 4 } as never, KEY as never);
    const done = await foundTheCompanyInTheWallet({
      identity, request: ask({ keyring: { sealed: held.sealed as never, version: 7 } }), label: drawCompanyLabel(), marks: marks(),
    });
    const kept = openKeyring(done.sealed as never, KEY as never);
    expect(Object.keys(kept.accounts).sort()).toEqual(['acc_old', done.accountId].sort());
    /* Sealed once at 5 to be handed in, so the founding is the write after it. */
    expect((kept as { counter?: number }).counter).toBe(6);
    expect(done.ifVersion).toBe(7);
  });

  /* RED WHEN: a company is founded with no name or founding signer the page gave, or with no saved keys to keep its seat in. */
  it('founds nothing when the page did not say what the company is called, or handed no saved keys', async () => {
    const { founding: _f, ...noFounding } = ask();
    const { keyring: _k, ...noKeys } = ask();
    for (const request of [noFounding, noKeys] as KeyringRequest[]) {
      await expect(foundTheCompanyInTheWallet({ identity, request, label: drawCompanyLabel(), marks: marks() })).rejects.toBeInstanceOf(NotFoundedHere);
    }
  });

  /* RED WHEN: saved keys older than ones this device has opened are founded over, which would drop a seat they no longer hold. */
  it('refuses saved keys older than ones this device has opened', async () => {
    const m = marks();
    m.raise('usr_a', { counter: 9, digest: 'ab'.repeat(32) as never });
    const held = sealKeyring({ accounts: {}, counter: 2 } as never, KEY as never);
    await expect(foundTheCompanyInTheWallet({
      identity, request: ask({ keyring: { sealed: held.sealed as never, version: 1 } }), label: drawCompanyLabel(), marks: m,
    })).rejects.toThrow(/older copy/u);
  });
});
