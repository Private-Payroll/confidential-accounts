/**
 * **A COMPANY'S SIGNERS ARE HELD ONCE: ON ITS ACCOUNT RECORD UNTIL A SEAT FILES
 * THE ROSTER RECORD, AND IN THAT RECORD ALONE AFTER.** The store files the
 * roster's next version only, and its first version moves the signers off the
 * account record in the same write; every reader opens the roster record when
 * there is one; and the service's own writes refuse to change the signers once
 * they are a record a seat signs. Driven over a store file, with the simulated
 * ledger under the account service.
 */
import { describe, it, expect } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimulatedLedger } from './ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { FileStore } from './store-file.js';
import { AccountService, openAccount } from './account.js';
import { ROSTER_ID, RosterIsASignedRecord, sealRoster } from './roster-record.js';
import { signCompanyFiling } from '../midnight/sealed-record-wire.js';
import type { Hex } from './crypto.js';

const aCompany = async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mn-roster-record-')), 'db.json');
  const store = new FileStore(path);
  const accounts = new AccountService(store, new SimulatedLedger(MidnightCommitments), MidnightCommitments);
  const created = await accounts.create('Rostered', [
    { name: 'Ada', role: 'admin', userId: 'usr_ada' }, { name: 'Bo', role: 'approver', userId: 'usr_bo' },
  ], 1, undefined, drawCompanyLabel());
  const company = created.account.id;
  const key = created.viewingKey as Hex;
  const ada = created.secrets[0]!.signingSecret as Hex;
  /** The roster as a seat's device files it: Bo renamed, so a reader that opens the account record instead is told apart. */
  const version = (n: number, id = ROSTER_ID) => {
    const now = openAccount(store.getAccount(company)!, key, store.newestRoster(company));
    const rec = sealRoster(company, { name: now.name, signers: now.signers.map((s) => (s.name === 'Bo' ? { ...s, name: 'Bo Two' } : s)) }, n, 0, key);
    return signCompanyFiling({ ...rec, id }, ada);
  };
  return { store, accounts, company, key, version, path };
};

describe('THE SIGNER ROSTER IS ONE SIGNED RECORD', () => {
  it('ITS FIRST VERSION MOVES THE SIGNERS OFF THE ACCOUNT RECORD, IN THE SAME WRITE, AND EVERY READER OPENS IT', async () => {
    const c = await aCompany();
    expect(c.store.getAccount(c.company)!.sealedRoster).toBeDefined();
    expect(c.store.newestRoster(c.company)).toBeNull();
    expect(c.store.fileRoster(c.version(1))).toBeNull();
    /* RED WHEN: the signers stay on the account record beside the roster record - two copies. */
    expect(c.store.getAccount(c.company)!.sealedRoster).toBeUndefined();
    expect(new FileStore(c.path).getAccount(c.company)!.sealedRoster).toBeUndefined();
    /* RED WHEN: a reader opens anything but the roster record once there is one. */
    expect(c.accounts.open(c.company, c.key).signers.map((s) => s.name)).toEqual(['Ada', 'Bo Two']);
    expect(openAccount(c.store.getAccount(c.company)!, c.key, c.store.newestRoster(c.company)).signers.map((s) => s.name)).toEqual(['Ada', 'Bo Two']);
  });

  it('ONLY THE NEXT VERSION IS FILED, AND ONLY UNDER THE ROSTER\'S OWN ID', async () => {
    const c = await aCompany();
    expect(c.store.fileRoster(c.version(1))).toBeNull();
    /* RED WHEN: a version already filed, or one beyond the next, replaces the roster. */
    expect(c.store.fileRoster(c.version(1))).toBe('version-already-filed');
    expect(c.store.fileRoster(c.version(3))).toBe('not-the-next-version');
    /* RED WHEN: a record under another id is filed as the company's roster. */
    expect(c.store.fileRoster(c.version(2, 'others'))).toBe('another-company');
    expect(c.store.rosterVersions(c.company).map((r) => r.version)).toEqual([1]);
    expect(c.store.fileRoster(c.version(2))).toBeNull();
  });

  it('THE SERVICE\'S ONE WRITE OF AN ACCOUNT REFUSES TO CHANGE THE SIGNERS ONCE THEY ARE A RECORD A SEAT SIGNS, AND WRITES NO SECOND COPY', async () => {
    const c = await aCompany();
    expect(c.store.fileRoster(c.version(1))).toBeNull();
    /* The account service's one write of an account record, which every write of it goes through. */
    const save = (account: ReturnType<typeof c.accounts.open>) =>
      (c.accounts as unknown as { save(rec: unknown, account: unknown, key: Hex): void }).save(c.store.getAccount(c.company)!, account, c.key);
    const now = c.accounts.open(c.company, c.key);
    /* RED WHEN: the service writes the signers itself, beside the record the seats sign. */
    expect(() => save({ ...now, signers: now.signers.filter((s) => s.name === 'Ada') })).toThrow(RosterIsASignedRecord);
    expect(c.accounts.open(c.company, c.key).signers.map((s) => s.name)).toEqual(['Ada', 'Bo Two']);
    /* RED WHEN: a write that leaves the signers as the record says puts a copy of them back on the account record. */
    save({ ...now, policy: { ...now.policy, threshold: 2 } });
    expect(c.store.getAccount(c.company)!.sealedRoster).toBeUndefined();
    expect(c.accounts.open(c.company, c.key).policy.threshold).toBe(2);
  });
});
