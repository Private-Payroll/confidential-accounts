import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signDirectoryEntry, signRecordsKey } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { newSigningKeypair } from '../../../src/core/crypto.js';
import { MemorySealedPoolStore, type SealedPoolStore } from '../../../src/midnight/vault-pool.js';
import { openNonceSecrets, recordsKeypairFrom, startNonceSecret } from '../../../src/midnight/company-nonce-secret.js';
import type { DirectoryFiling } from '../../../src/midnight/seat-directory.js';
import { directoryHere, giveEachVaultSecretHere, type DirectoryHere, type DirectoryHereDeps } from './vault-page-doors.js';
import { recordsReaderOf, type DeviceSigner } from './deposit-on-device.js';

/*
 * A NEW SIGNER IS GIVEN EACH VAULT'S NONCE SECRET FROM A SIGNER'S OWN DEVICE.
 * Two signers' wallets sign their entries and records keys for one company;
 * the directory, the chain's read and the records are held in memory, and the
 * copies are made and opened with the real record code.
 */
const LABEL = `co_${'c1'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'c0'.repeat(32) as AccountAddress;
const CO = 'acc_given';
const VAULTS = ['ab'.repeat(32), 'cd'.repeat(32)];

const signer = (n: number) => {
  const identity = identityFromSecret(new Uint8Array(32).fill(n));
  const companyKey = new Uint8Array(32).fill(n + 100);
  const seat = n.toString(16).padStart(2, '0').repeat(32);
  const committeeKey = committeeKeyFor(identity, LABEL) as { tag: string; value: string };
  const statement = signDirectoryEntry(identity, LABEL, ACCOUNT, companyKey, newSigningKeypair().publicKey, seat);
  return {
    seat, companyKey, committeeKey,
    claim: (version: number): DirectoryFiling => ({ company: CO, version, change: { kind: 'claim', entry: { person: `p${n}`, committeeKey, statement } } }),
    attested: { committeeKey, statement: signRecordsKey(identity, LABEL, ACCOUNT, companyKey, seat) },
    device: { signerId: `s${n}`, wrappingSecret: '00'.repeat(32), companyKey } as DeviceSigner,
  };
};
const ADA = signer(1);
const CAROL = signer(3);

/** A company with both entries filed, both seats held and both wallets on the committee, unless the test says otherwise. */
const company = (o: { filings?: DirectoryFiling[]; seats?: string[]; attested?: (typeof ADA.attested)[] } = {}) => {
  const stores = new Map<string, SealedPoolStore>();
  const records = (record: string) => stores.get(record) ?? stores.set(record, new MemorySealedPoolStore()).get(record)!;
  const deps: DirectoryHereDeps = {
    accountId: CO, label: LABEL,
    filings: async () => o.filings ?? [ADA.claim(1), CAROL.claim(2)],
    holders: async () => ({ account: ACCOUNT, approvals: 1, threshold: 1, adoptedVaults: VAULTS, seats: o.seats ?? [ADA.seat, CAROL.seat], committee: [ADA.committeeKey, CAROL.committeeKey] }),
    attested: async () => o.attested ?? [ADA.attested, CAROL.attested],
  };
  const directory = (): Promise<DirectoryHere> => directoryHere(deps);
  return { records, directory };
};
const started = async (c: ReturnType<typeof company>) => {
  for (const v of VAULTS) await c.records('nonce-secret').put(v, startNonceSecret(v, [recordsReaderOf(ADA.companyKey)]));
};

describe('a new signer is given each vault\'s nonce secret', () => {
  /* RED WHEN: the new signer cannot open a vault's secret with their own records key after it is given, the secret changes, or a signer who had it loses it. */
  it('every vault, sealed to the records key the new signer\'s own directory entry names, the secret unchanged', async () => {
    const c = company();
    await started(c);
    const was = await Promise.all(VAULTS.map(async (v) => openNonceSecrets((await c.records('nonce-secret').get(v))!, v, recordsKeypairFrom(ADA.companyKey)).secrets));
    const done = await giveEachVaultSecretHere({ vaultIds: VAULTS, me: ADA.device, seat: CAROL.seat, directory: c.directory, records: c.records });
    expect(done).toEqual({ given: VAULTS, had: [] });
    for (const [i, v] of VAULTS.entries()) {
      const rec = (await c.records('nonce-secret').get(v))!;
      expect(openNonceSecrets(rec, v, recordsKeypairFrom(CAROL.companyKey)).secrets).toEqual(was[i]);
      expect(openNonceSecrets(rec, v, recordsKeypairFrom(ADA.companyKey)).secrets).toEqual(was[i]);
    }
    /* RED WHEN: a vault whose secret the new signer can already open is filed again. */
    expect(await giveEachVaultSecretHere({ vaultIds: VAULTS, me: ADA.device, seat: CAROL.seat, directory: c.directory, records: c.records })).toEqual({ given: [], had: VAULTS });
    expect((await c.records('nonce-secret').versions(VAULTS[0]!)).length).toBe(2);
  });

  /* RED WHEN: a copy is given to a seat whose entry is not filed, not held by the account now, or names a records key its own wallet did not attest - a key the roster or the server chose. */
  it('gives nothing to a seat this device does not believe, and files nothing', async () => {
    const cases = [
      ['no entry', company({ filings: [ADA.claim(1)] }), /no entry in the company's directory/],
      ['not seated now', company({ seats: [ADA.seat] }), /account no longer holds/],
      ['records key not attested', company({ attested: [ADA.attested] }), /has not attested the records key/],
    ] as const;
    for (const [what, c, why] of cases) {
      await started(c);
      await expect(giveEachVaultSecretHere({ vaultIds: VAULTS, me: ADA.device, seat: CAROL.seat, directory: c.directory, records: c.records }), what).rejects.toThrow(why);
      for (const v of VAULTS) expect((await c.records('nonce-secret').versions(v)).length, what).toBe(1);
    }
  });

  /* RED WHEN: a vault with no secret filed is passed over silently, so the new signer is told they hold every secret. */
  it('refuses a vault with no secret filed', async () => {
    const c = company();
    await giveEachVaultSecretHere({ vaultIds: [], me: ADA.device, seat: CAROL.seat, directory: c.directory, records: c.records });
    await expect(giveEachVaultSecretHere({ vaultIds: VAULTS, me: ADA.device, seat: CAROL.seat, directory: c.directory, records: c.records })).rejects.toThrow(/no nonce secret filed/);
  });
});
