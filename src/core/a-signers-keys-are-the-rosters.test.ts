/**
 * **WHICH VAULT KEY BELONGS TO WHICH SIGNER IS SAID BY THE SEALED ROSTER ALONE.**
 *
 * A seat's device writes a signer's vault keys into that signer's own roster
 * entry (`rosterWithVaultKeys`), only when they are signed with that entry's
 * signing key, and the only thing kept outside the roster is an index with
 * nobody's name on it. The roster here is the one the account service made,
 * opened as a device opens it; how it is filed is in
 * `src/server/vault-keys-are-offered-and-folded.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { drawCompanyLabel, type CompanyLabel } from 'midnight-identity/profile/company-label';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signRecordsKey } from 'midnight-identity/profile/records-key';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimulatedLedger } from './ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { FileStore } from './store-file.js';
import { AccountService } from './account.js';
import { newSigningKeypair } from './crypto.js';
import {
  NoSeatToGiveKeysFor, RecordsKeyNotSignedForYourSeat, rosterVaultKeys, rosterWithVaultKeys, signVaultKeys, vaultKeyIndexOf,
  VaultKeysAlreadyGiven, VaultKeysNotYours, type SignedVaultKeys,
} from './vault-keys.js';
import type { Account } from './types.js';
import type { Hex } from './crypto.js';

/** The company's account as this service recorded it: the one every statement here is signed for. */
const where = () => store.getAccount(company)!.contractAddress as never;
const key = (n: number) => ({ tag: 'schnorr', value: n.toString(16).padStart(2, '0').repeat(32) });
const hex = (n: number) => n.toString(16).padStart(2, '0').repeat(32) as Hex;

let store: FileStore;
let accounts: AccountService;
let company: string;
let viewingKey: Hex;
let ada: { signerId: string; signingSecret: Hex };
let bo: { signerId: string; signingSecret: Hex };
let label: CompanyLabel;
/** The roster as the devices here last left it. */
let roster: Account;

beforeEach(async () => {
  store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-roster-keys-')), 'db.json'));
  accounts = new AccountService(store, new SimulatedLedger(MidnightCommitments), MidnightCommitments);
  label = drawCompanyLabel();
  const created = await accounts.create('Rostered', [
    /* Names with a space in them: no account id or key can contain one, so "not in the index" cannot pass by chance. */
    { name: 'Ada Lovelace', role: 'admin', userId: 'usr_ada' },
    { name: 'Bo Diddley', role: 'approver', userId: 'usr_bo' },
  ], 2, undefined, label);
  company = created.account.id;
  viewingKey = created.viewingKey;
  ada = created.secrets[0]!;
  bo = created.secrets[1]!;
  roster = accounts.open(company, viewingKey);
});

const signed = (who: { signerId: string; signingSecret: Hex }, n: number, by = who) =>
  signVaultKeys(company, who.signerId, { committeeKey: key(n), recordsKey: hex(n + 0x10) }, by.signingSecret);
/** Gives `keys` for `signerId` on the roster as it stands, and keeps what comes back. */
const give = (signerId: string, keys: SignedVaultKeys): 'given' | 'already-given' => {
  const next = rosterWithVaultKeys(roster, company, label, where(), signerId, keys);
  if (next === 'already-given') return next;
  roster = next;
  return 'given';
};

describe('A SIGNER\'S VAULT KEYS LIVE IN THEIR OWN ROSTER ENTRY', () => {
  it('ARE WRITTEN INTO THE ROSTER, SIGNED BY THEIR OWN SEAT, AND READ BACK AS THEIRS BY ANY DEVICE THAT OPENS IT', () => {
    expect(give(ada.signerId, signed(ada, 1))).toBe('given');
    expect(give(ada.signerId, signed(ada, 1))).toBe('already-given');
    const keys = rosterVaultKeys(roster);
    /* RED WHEN: the keys are not written into the giver's own entry, or are read back as anybody's. */
    expect(keys.find((r) => r.signerId === ada.signerId)!.keys).toEqual({ committeeKey: key(1), recordsKey: hex(0x11), recordsKeyStatement: null, recordsKeySeat: null });
    expect(keys.find((r) => r.signerId === bo.signerId)!.keys).toBeNull();
  });

  describe('A STATEMENT OVER THE RECORDS KEY, GIVEN AGAIN', () => {
    /* Ada's wallet: her committee key for this company, and her records key worked out from the company key it releases. */
    const me = identityFromSecret(new Uint8Array(32).fill(7));
    const companyKey = new Uint8Array(32).fill(0x2a);
    const hers = () => {
      const committeeKey = committeeKeyFor(me, label) as { tag: string; value: string };
      const seat = roster.signers.find((x) => x.id === ada.signerId)!.leafCommitment!.toLowerCase();
      const statement = signRecordsKey(me, label, where(), companyKey, seat);
      const keys = signVaultKeys(company, ada.signerId, { committeeKey, recordsKey: statement.recordsKey as Hex }, ada.signingSecret);
      const withIt = (st: { signature: string; seat: string }) => ({ ...keys, recordsKeyStatement: st.signature as Hex, recordsKeySeat: st.seat as Hex });
      return { keys, seat, statement, withIt };
    };
    const kept = () => rosterVaultKeys(roster).find((r) => r.signerId === ada.signerId)!.keys!;

    it('THE SAME KEYS GIVEN AGAIN WITH THE WALLET\'S STATEMENT ADD IT, A NEWER ONE REPLACES IT, AND NOTHING ELSE CHANGES', () => {
      const h = hers();
      give(ada.signerId, h.keys);
      /* RED WHEN: a statement given with the same keys is dropped, or a set given once refuses it. */
      expect(give(ada.signerId, h.withIt(h.statement))).toBe('given');
      expect(kept()).toEqual({
        committeeKey: h.keys.committeeKey, recordsKey: h.keys.recordsKey, recordsKeyStatement: h.statement.signature, recordsKeySeat: h.seat,
      });
      expect(give(ada.signerId, h.withIt(h.statement))).toBe('already-given');
      /* RED WHEN: the wallet's statement signed again for the seat held now does not replace the one kept. */
      const again = signRecordsKey(me, label, where(), companyKey, h.seat);
      expect(again.signature).not.toBe(h.statement.signature);
      expect(give(ada.signerId, h.withIt(again))).toBe('given');
      expect(kept().recordsKeyStatement).toBe(again.signature);
      /* RED WHEN: a statement opens the door to different keys under the same seat. */
      expect(() => give(ada.signerId, { ...signed(ada, 4), recordsKeyStatement: again.signature as Hex, recordsKeySeat: h.seat as Hex }))
        .toThrow(VaultKeysAlreadyGiven);
      /* RED WHEN: a set given again without a statement wipes the one already kept. */
      expect(give(ada.signerId, h.keys)).toBe('already-given');
      expect(kept().recordsKeyStatement).toBe(again.signature);
    });

    it('A STATEMENT THAT DOES NOT VERIFY IS REFUSED, AND THE ONE KEPT IS KEPT', () => {
      const h = hers();
      give(ada.signerId, h.withIt(h.statement));
      const other = identityFromSecret(new Uint8Array(32).fill(8));
      for (const [why, bad] of [
        /* RED WHEN: a signature that is no signature replaces a good one. */
        ['not a signature over it', { signature: 'ab'.repeat(64), seat: h.seat }],
        /* RED WHEN: a statement signed by any key but the committee key this entry carries replaces it. */
        ['signed by another wallet', signRecordsKey(other, label, where(), companyKey, h.seat)],
        /* RED WHEN: a statement for a seat the roster does not hold for this signer replaces it. */
        ['for another seat', signRecordsKey(me, label, where(), companyKey, '8d'.repeat(32))],
        /* RED WHEN: a statement for another company replaces it. */
        ['for another company', signRecordsKey(me, drawCompanyLabel(), where(), companyKey, h.seat)],
        /* RED WHEN: a statement for another account carrying this company's label replaces it. */
        ['for another account', signRecordsKey(me, label, 'ad'.repeat(32) as never, companyKey, h.seat)],
      ] as const) {
        expect(() => give(ada.signerId, h.withIt(bad)), why).toThrow(RecordsKeyNotSignedForYourSeat);
        expect(kept().recordsKeyStatement, why).toBe(h.statement.signature);
        expect(kept().recordsKeySeat, why).toBe(h.seat);
      }
      /* Said as keys that are not this signer's, so a device answers it as it answers those. */
      expect(new RecordsKeyNotSignedForYourSeat()).toBeInstanceOf(VaultKeysNotYours);
    });

    it('A STATEMENT GIVEN WITH THE FIRST SET OF KEYS IS CHECKED AS ONE GIVEN AGAIN IS: one that does not verify is refused and nothing is kept', () => {
      const h = hers();
      const other = identityFromSecret(new Uint8Array(32).fill(8));
      for (const [why, bad] of [
        /* RED WHEN: a first give keeps a statement that is no signature. */
        ['not a signature over it', { signature: 'ab'.repeat(64), seat: h.seat }],
        /* RED WHEN: a first give keeps a statement signed by another wallet. */
        ['signed by another wallet', signRecordsKey(other, label, where(), companyKey, h.seat)],
        /* RED WHEN: a first give keeps a statement for a seat the roster does not hold for this signer. */
        ['for another seat', signRecordsKey(me, label, where(), companyKey, '8d'.repeat(32))],
      ] as const) {
        expect(() => give(ada.signerId, h.withIt(bad)), why).toThrow(RecordsKeyNotSignedForYourSeat);
        expect(rosterVaultKeys(roster).find((r) => r.signerId === ada.signerId)!.keys, why).toBeNull();
      }
      /* And a first give whose statement does verify keeps it. */
      expect(give(ada.signerId, h.withIt(h.statement))).toBe('given');
      expect(kept().recordsKeyStatement).toBe(h.statement.signature);
    });
  });

  it('NOBODY CAN PUT A KEY IN ANOTHER SIGNER\'S NAME: keys signed by any other seat are refused, and the roster is untouched', () => {
    /* RED WHEN: a key is written into a roster entry without that entry's own signature. */
    expect(() => give(ada.signerId, signed(ada, 1, bo))).toThrow(VaultKeysNotYours);
    expect(() => give(bo.signerId, signed(bo, 7, ada))).toThrow(VaultKeysNotYours);
    expect(rosterVaultKeys(roster).every((r) => r.keys === null)).toBe(true);
    /* And a different set from the same seat, once given, is refused and the first is kept. */
    give(bo.signerId, signed(bo, 2));
    expect(() => give(bo.signerId, signed(bo, 3))).toThrow(VaultKeysAlreadyGiven);
    expect(rosterVaultKeys(roster).find((r) => r.signerId === bo.signerId)!.keys!.committeeKey).toEqual(key(2));
  });

  it('A PERSON WITH NO SEAT - A STRANGER, OR ONE STILL WAITING FOR ACCESS - HAS NO KEYS TO GIVE', () => {
    expect(() => give('sgn_nobody', signed(ada, 1))).toThrow(NoSeatToGiveKeysFor);
    /* Cleo has accepted her invitation and is not seated yet: her roster entry is not hers to write into. */
    const raw = accounts.inviteSigner(company, 'Cleo', 'cleo@example.test', 'approver');
    const cleoKeys = newSigningKeypair();
    const pending = accounts.acceptSignerInvite(raw.token, 'usr_cleo', cleoKeys.publicKey, hex(0x61), hex(0x62));
    roster = accounts.open(company, viewingKey);
    /* RED WHEN: a person waiting for a seat can write keys the page would then count as a signer's. */
    expect(() => give(pending.id, signed({ signerId: pending.id, signingSecret: cleoKeys.secret }, 5))).toThrow(NoSeatToGiveKeysFor);
  });
});

describe('OUTSIDE THE ROSTER, A COMMITTEE KEY APPEARS ONLY IN AN INDEX WITH NOBODY\'S NAME ON IT', () => {
  it('THE INDEX MADE FROM THE ROSTER IS SORTED BY VALUE AND CARRIES NO PERSON, SEAT OR NAME', () => {
    give(ada.signerId, signed(ada, 0x42));
    give(bo.signerId, signed(bo, 0x17));
    const index = vaultKeyIndexOf(roster);
    /* RED WHEN: the index keeps the order the keys were given in, so it says who gave which. */
    expect(index.committeeKeys).toEqual([key(0x17), key(0x42)]);
    expect(index.readers).toEqual([hex(0x27), hex(0x52)]);
    expect(index.signerCount).toBe(2);
    /* RED WHEN: the index carries a person, a seat or a name. */
    const said = JSON.stringify(index);
    for (const who of ['usr_ada', 'usr_bo', ada.signerId, bo.signerId, 'Ada Lovelace', 'Bo Diddley']) expect(said).not.toContain(who);
  });
});
