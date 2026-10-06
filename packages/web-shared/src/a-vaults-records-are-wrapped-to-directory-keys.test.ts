import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signDirectoryEntry, signRecordsKey } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { newSigningKeypair, newWrappingKeypair, toHex } from '../../../src/core/crypto.js';
import { MemorySealedPoolStore, SealedNotePool } from '../../../src/midnight/vault-pool.js';
import { recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import type { DirectoryFiling } from '../../../src/midnight/seat-directory.js';
import { deviceSignerFrom, directoryHere, readersIn } from './vault-page-doors.js';

/*
 * A VAULT'S POOL AND JOURNALS ARE WRAPPED TO THE RECORDS KEY IN EACH SIGNER'S
 * OWN DIRECTORY ENTRY, UNDER THEIR SEAT. Signers' wallets sign their entries and
 * records keys; the directory and the chain's read are held in memory, and the
 * pool is sealed and opened with the real record code.
 */
const LABEL = `co_${'c1'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'c0'.repeat(32) as AccountAddress;
const CO = 'acc_wrapped';
const VAULT = 'ab'.repeat(32);

const signer = (n: number) => {
  const identity = identityFromSecret(new Uint8Array(32).fill(n));
  const companyKey = new Uint8Array(32).fill(n + 100);
  const seat = n.toString(16).padStart(2, '0').repeat(32);
  const committeeKey = committeeKeyFor(identity, LABEL) as { tag: string; value: string };
  const statement = signDirectoryEntry(identity, LABEL, ACCOUNT, companyKey, newSigningKeypair().publicKey, seat);
  return {
    seat, committeeKey, statement,
    claim: (version: number): DirectoryFiling => ({ company: CO, version, change: { kind: 'claim', entry: { person: `p${n}`, committeeKey, statement } } }),
    attested: { committeeKey, statement: signRecordsKey(identity, LABEL, ACCOUNT, companyKey, seat) },
    device: deviceSignerFrom(seat, toHex(companyKey)),
  };
};
const ADA = signer(1);
const BO = signer(2);
const CY = signer(3);

const directory = (o: { seats?: string[]; committee?: (typeof ADA.committeeKey)[]; attested?: (typeof ADA.attested)[] } = {}) => () => directoryHere({
  accountId: CO, label: LABEL,
  filings: async () => [ADA.claim(1), BO.claim(2), CY.claim(3)],
  holders: async () => ({
    account: ACCOUNT, approvals: 1, threshold: 1, adoptedVaults: [VAULT],
    seats: o.seats ?? [ADA.seat, BO.seat, CY.seat], committee: o.committee ?? [ADA.committeeKey, BO.committeeKey, CY.committeeKey],
  }),
  attested: async () => o.attested ?? [ADA.attested, BO.attested, CY.attested],
});

describe('who a vault\'s records are wrapped to', () => {
  /* RED WHEN: a reader is named by the roster's id or wrapping key rather than the seat and records key the signer's own wallet signed into their entry. */
  it('every seat this device believes, under its seat, to the records key its entry names', async () => {
    expect(await readersIn(directory()).signers()).toEqual([ADA, BO, CY].map((s) => ({ id: s.seat, wrappingPublicKey: s.statement.wrappingKey })));
    /* The records key an entry names is the one the signer's released company key gives: the key their device opens with. */
    for (const s of [ADA, BO, CY]) expect(s.statement.wrappingKey).toBe(recordsKeypairFrom(s.device.companyKey).publicKey);
  });

  /* RED WHEN: a copy is wrapped to a seat the account no longer holds, whose wallet the committee no longer lists, or whose entry names a records key its own wallet did not attest. */
  it('leaves out a seat not held now, one whose wallet is off the committee, and one whose records key is not attested', async () => {
    const without = async (o: Parameters<typeof directory>[0]) => (await readersIn(directory(o)).signers()).map((r) => r.id);
    expect(await without({ seats: [ADA.seat, BO.seat] })).toEqual([ADA.seat, BO.seat]);
    expect(await without({ committee: [ADA.committeeKey, CY.committeeKey] })).toEqual([ADA.seat, CY.seat]);
    expect(await without({ attested: [ADA.attested, BO.attested] })).toEqual([ADA.seat, BO.seat]);
  });

  /* RED WHEN: a pool one signer's device writes cannot be opened by another signer's device with the records key its wallet released, or opens with a roster wrapping secret. */
  it('a pool written on one signer\'s device opens on another\'s with its own records key, and with no roster key', async () => {
    const store = new MemorySealedPoolStore();
    const notes = [{ nonce: '01'.repeat(32), token: 'c1'.repeat(32), value: 5n }] as never;
    const readers = readersIn(directory());
    await new SealedNotePool(store, ADA.device, readers.signers).create(VAULT, { notes });
    expect((await new SealedNotePool(store, BO.device, readers.signers).load(VAULT)).notes).toEqual(notes);
    await expect(new SealedNotePool(store, { signerId: BO.seat, wrappingSecret: newWrappingKeypair().secret }, readers.signers).load(VAULT)).rejects.toThrow();
  });
});
