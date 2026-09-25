/**
 * **WHICH VAULT KEY BELONGS TO WHICH SIGNER IS SAID BY THE SEALED ROSTER ALONE.**
 *
 * The service writes a signer's vault keys into that signer's own roster entry,
 * only when they are signed with that entry's signing key, and keeps outside the
 * roster nothing but an index with nobody's name on it. Driven through the
 * account service over a store file, with the simulated ledger under it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimulatedLedger } from './ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { FileStore } from './store-file.js';
import { AccountService, NoSeatToGiveKeysFor, VaultKeysAlreadyGiven, VaultKeysNotYours } from './account.js';
import { newSigningKeypair } from './crypto.js';
import { rosterVaultKeys, signVaultKeys, vaultKeyIndexOf } from './vault-keys.js';
import type { Hex } from './crypto.js';

const key = (n: number) => ({ tag: 'schnorr', value: n.toString(16).padStart(2, '0').repeat(32) });
const hex = (n: number) => n.toString(16).padStart(2, '0').repeat(32) as Hex;

let path: string;
let store: FileStore;
let accounts: AccountService;
let company: string;
let viewingKey: Hex;
let ada: { signerId: string; signingSecret: Hex };
let bo: { signerId: string; signingSecret: Hex };

beforeEach(async () => {
  path = join(mkdtempSync(join(tmpdir(), 'mn-roster-keys-')), 'db.json');
  store = new FileStore(path);
  accounts = new AccountService(store, new SimulatedLedger(MidnightCommitments), MidnightCommitments);
  const created = await accounts.create('Rostered', [
    /* Names with a space in them: no account id or key can contain one, so "not in the index" cannot pass by chance. */
    { name: 'Ada Lovelace', role: 'admin', userId: 'usr_ada' },
    { name: 'Bo Diddley', role: 'approver', userId: 'usr_bo' },
  ], 2);
  company = created.account.id;
  viewingKey = created.viewingKey;
  ada = created.secrets[0]!;
  bo = created.secrets[1]!;
});

const signed = (who: { signerId: string; signingSecret: Hex }, n: number, by = who) =>
  signVaultKeys(company, who.signerId, { committeeKey: key(n), recordsKey: hex(n + 0x10) }, by.signingSecret);

describe('A SIGNER\'S VAULT KEYS LIVE IN THEIR OWN ROSTER ENTRY', () => {
  it('ARE WRITTEN INTO THE SEALED ROSTER, SIGNED BY THEIR OWN SEAT, AND READ BACK AS THEIRS BY ANY DEVICE THAT OPENS IT', () => {
    expect(accounts.giveVaultKeys(company, viewingKey, 'usr_ada', signed(ada, 1))).toBe('given');
    expect(accounts.giveVaultKeys(company, viewingKey, 'usr_ada', signed(ada, 1))).toBe('already-given');
    const roster = rosterVaultKeys(accounts.open(company, viewingKey));
    /* RED WHEN: the keys are not written into the giver's own entry, or are read back as anybody's. */
    expect(roster.find((r) => r.signerId === ada.signerId)!.keys).toEqual({ committeeKey: key(1), recordsKey: hex(0x11) });
    expect(roster.find((r) => r.signerId === bo.signerId)!.keys).toBeNull();
  });

  it('NOBODY CAN PUT A KEY IN ANOTHER SIGNER\'S NAME: keys signed by any other seat are refused, and the roster is untouched', () => {
    /* Ada, who can reach the route, gives keys for her own sign-in signed with Bo's seat, and for Bo's signed with hers. */
    expect(() => accounts.giveVaultKeys(company, viewingKey, 'usr_ada', signed(ada, 1, bo))).toThrow(VaultKeysNotYours);
    /* RED WHEN: a key is written into a roster entry without that entry's own signature. */
    expect(() => accounts.giveVaultKeys(company, viewingKey, 'usr_bo', signed(bo, 7, ada))).toThrow(VaultKeysNotYours);
    expect(rosterVaultKeys(accounts.open(company, viewingKey)).every((r) => r.keys === null)).toBe(true);
    /* And a different set from the same seat, once given, is refused and the first is kept. */
    accounts.giveVaultKeys(company, viewingKey, 'usr_bo', signed(bo, 2));
    expect(() => accounts.giveVaultKeys(company, viewingKey, 'usr_bo', signed(bo, 3))).toThrow(VaultKeysAlreadyGiven);
    expect(rosterVaultKeys(accounts.open(company, viewingKey)).find((r) => r.signerId === bo.signerId)!.keys!.committeeKey)
      .toEqual(key(2));
  });

  it('A PERSON WITH NO SEAT - A STRANGER, OR ONE STILL WAITING FOR ACCESS - HAS NO KEYS TO GIVE', () => {
    expect(() => accounts.giveVaultKeys(company, viewingKey, 'usr_carol', signed(ada, 1))).toThrow(NoSeatToGiveKeysFor);
    /* Cleo has accepted her invitation and is not seated yet: her roster entry is not hers to write into. */
    const raw = accounts.inviteSigner(company, 'Cleo', 'cleo@example.test', 'approver');
    const cleoKeys = newSigningKeypair();
    const pending = accounts.acceptSignerInvite(raw.token, 'usr_cleo', cleoKeys.publicKey, hex(0x61), hex(0x62));
    /* RED WHEN: a person waiting for a seat can write keys the page would then count as a signer's. */
    expect(() => accounts.giveVaultKeys(company, viewingKey, 'usr_cleo',
      signed({ signerId: pending.id, signingSecret: cleoKeys.secret }, 5))).toThrow(NoSeatToGiveKeysFor);
  });
});

describe('THE SERVICE\'S STORE NO LONGER SAYS WHICH PERSON HOLDS WHICH COMMITTEE KEY', () => {
  it('OUTSIDE THE SEALED ROSTER, A COMMITTEE KEY APPEARS ONLY IN AN INDEX WITH NOBODY\'S NAME ON IT', () => {
    accounts.giveVaultKeys(company, viewingKey, 'usr_ada', signed(ada, 0x42));
    accounts.giveVaultKeys(company, viewingKey, 'usr_bo', signed(bo, 0x17));
    const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>;
    const index = written.vaultKeyIndex![company] as Record<string, unknown>;
    /* Sorted by value, so the order says nothing about who gave which. */
    expect(index.committeeKeys).toEqual([key(0x17), key(0x42)]);
    expect(index.readers).toEqual([hex(0x27), hex(0x52)]);
    /* RED WHEN: the index carries a person, a seat or a name - or keeps the order the keys were given in. */
    const said = JSON.stringify(index);
    for (const who of ['usr_ada', 'usr_bo', ada.signerId, bo.signerId, 'Ada Lovelace', 'Bo Diddley']) expect(said).not.toContain(who);
    /* RED WHEN: any other field of the store carries a committee key - the old per-person record did. */
    for (const [field, value] of Object.entries(written)) {
      if (field === 'vaultKeyIndex') continue;
      expect(JSON.stringify(value), field).not.toContain(key(0x42).value);
      expect(JSON.stringify(value), field).not.toContain(key(0x17).value);
    }
    expect(written.vaultKeys).toBeUndefined();
  });

  it('THE INDEX IS MADE AGAIN FROM THE ROSTER ON EVERY ROSTER WRITE, so it names nobody the roster does not', async () => {
    accounts.giveVaultKeys(company, viewingKey, 'usr_ada', signed(ada, 1));
    expect(store.getVaultKeyIndex(company)).toEqual(vaultKeyIndexOf(accounts.open(company, viewingKey)));
    expect(store.getVaultKeyIndex(company)!.signerCount).toBe(2);
    expect(store.getVaultKeyIndex(company)!.committeeKeys).toEqual([key(1)]);
    /* A member's filing key, their roster signing key, is kept for the records' door beside it. */
    expect(store.getFilingKey(company, 'usr_ada')!.filingKey)
      .toBe(accounts.open(company, viewingKey).signers.find((s) => s.id === ada.signerId)!.signingPublicKey.toLowerCase());
  });
});
