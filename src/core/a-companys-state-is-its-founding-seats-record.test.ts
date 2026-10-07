/**
 * **A COMPANY MADE ON ITS FOUNDING SIGNER'S DEVICE KEEPS ITS STATE ONLY AS THE
 * RECORD THAT SIGNER'S SEAT SIGNED**, and the service reads its own copy from
 * that record. A record not signed by that seat, for another company, or not
 * the first version at the founding epoch is not the company's first state.
 */
import { describe, expect, it } from 'vitest';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { foundTheCompanyHere } from './company-founding.js';
import { AccountService } from './account.js';
import { MemoryStore } from './store.js';
import { newSigningKeypair, newWrappingKeypair, unwrapKey, type Hex } from './crypto.js';
import {
  foundingStateRefusal, openStateRecord, signedFoundingState, stateRecordId,
} from './founding-state.js';
import { signCompanyFiling, type SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { MidnightCommitments } from '../midnight/commitments.js';

const LABEL = `co_${'3d'.repeat(32)}` as CompanyLabel;

const founded = () => {
  const signing = newSigningKeypair();
  const wrapping = newWrappingKeypair();
  const f = foundTheCompanyHere({
    name: 'Acme Ltd', signer: { name: 'Priya', role: 'admin' }, userId: 'usr_founder', label: LABEL,
    seat: { signingPublicKey: signing.publicKey, wrappingPublicKey: wrapping.publicKey, leaf: '4e'.repeat(32) },
    signingSecret: signing.secret,
  });
  const viewingKey = unwrapKey(f.account.wrappedKeys[0]!, wrapping.secret) as Hex;
  return { f, signing, viewingKey };
};

const resigned = (rec: SealedCompanyRecord, edit: Partial<SealedCompanyRecord>, secret: Hex): SealedCompanyRecord => {
  const { filedBy: _was, ...unsigned } = rec;
  return signCompanyFiling({ ...unsigned, ...edit }, secret);
};

describe('THE FIRST STATE, AS ITS FOUNDING SEAT SIGNED IT', () => {
  it('IS THE FIRST VERSION AT THE FOUNDING EPOCH, FOR THIS COMPANY, SIGNED BY THE FOUNDING SEAT', () => {
    const { f, signing } = founded();
    /* RED WHEN: the record a founding device makes is not one its own check believes. */
    expect(foundingStateRefusal(f.state, f.account.id, f.seat.signingPublicKey)).toBeNull();
    expect([f.state.kind, f.state.id, f.state.version, f.state.keyEpoch, f.state.wrapped]).toEqual(['state', stateRecordId(0), 1, 0, []]);
    const cases: Array<[string, unknown, string]> = [
      /* RED WHEN: a state signed by any seat other than the founding one is believed. */
      ['another seat signed it', resigned(f.state, {}, newSigningKeypair().secret), 'signed by a seat other than the founding signer'],
      /* RED WHEN: a state whose sealed bytes changed after signing is believed. */
      ['its bytes changed', { ...f.state, sealed: { ...f.state.sealed, body: `${f.state.sealed.body}00` } }, 'not signed, or its signature does not cover it'],
      /* RED WHEN: an unsigned state is believed. */
      ['unsigned', { ...f.state, filedBy: undefined }, 'not signed'],
      /* RED WHEN: a later version is taken for the first. */
      ['a later version', resigned(f.state, { version: 2 }, signing.secret), 'not the first version'],
      /* RED WHEN: a state for another company is taken for this one's. */
      ['another company', resigned(f.state, { company: 'acc_other' }, signing.secret), 'another company'],
      /* RED WHEN: a state wrapped to readers is taken for the one sealed under the viewing key. */
      ['wrapped to a reader', resigned(f.state, { wrapped: [{ reader: 'aa'.repeat(32) } as never] }, signing.secret), 'carries no wrapped keys'],
      /* RED WHEN: a first state sealed at a later key epoch, filed under the founding state's name, is taken for the company's first. */
      ['sealed at a later epoch', resigned(f.state, { keyEpoch: 1 }, signing.secret), 'not sealed at the epoch a company is founded at'],
    ];
    for (const [why, rec, says] of cases) {
      expect(foundingStateRefusal(rec, f.account.id, f.seat.signingPublicKey), why).toContain(says);
    }
  });

  it('IS SIGNED ONLY BY THE SEAT\'S OWN SECRET, AND ONLY AT THE FOUNDING EPOCH', () => {
    const { signing } = founded();
    /* RED WHEN: a state sealed at a later epoch is signed as a company's first. */
    expect(() => signedFoundingState('acc_x', { keyEpoch: 1, sealed: { iv: '00'.repeat(12), tag: '', body: '00' } }, signing.secret))
      .toThrow(/founded at key epoch 0/);
    /* RED WHEN: a company is made with a seat key its secret does not make, so its state is signed by nobody it names. */
    expect(() => foundTheCompanyHere({
      name: 'Acme Ltd', signer: { name: 'Priya', role: 'admin' }, userId: 'usr_founder', label: LABEL,
      seat: { signingPublicKey: newSigningKeypair().publicKey, wrappingPublicKey: newWrappingKeypair().publicKey, leaf: '4e'.repeat(32) },
      signingSecret: signing.secret,
    })).toThrow(/is not the one its secret makes/);
  });

  it('THE SERVICE READS ITS OWN COPY OF THE STATE FROM THAT RECORD, AND ASKS THE LEDGER FOR NONE', async () => {
    const { f, viewingKey } = founded();
    const store = new MemoryStore();
    store.putAccount({ ...f.account, wiring: 'midnight' } as never);
    const asked: string[] = [];
    const ledger = { wiring: 'midnight', fetch: async () => { asked.push('fetch'); return null; } } as never;
    const records = { get: async (c: string, k: string, i: string) => (c === f.state.company && k === 'state' && i === f.state.id ? f.state : null) };
    const accounts = new AccountService(store, ledger, MidnightCommitments, undefined, undefined, records);
    const opened = openStateRecord(f.state, viewingKey);
    /* RED WHEN: the service reads the state from anywhere but the record, or reads other seeds or another key than it holds. */
    expect(await accounts.payoutSeedsOf(f.account.id, viewingKey)).toEqual(opened.blinding.payoutSeeds);
    expect(await accounts.payRecordKeyOf(f.account.id, viewingKey)).toBe(opened.blinding.payRecordKey);
    expect(asked).toEqual([]);
    /* RED WHEN: a key that does not open the record is told anything but that it does not. */
    await expect(accounts.payoutSeedsOf(f.account.id, 'ab'.repeat(32) as Hex)).rejects.toThrow(/viewing key cannot open this account/);
  });
});
