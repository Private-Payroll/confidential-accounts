import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { seatBarOf, signDirectoryEntry, signRecordsKey } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { newSigningKeypair } from '../../../src/core/crypto.js';
import { MemorySealedPoolStore, type SealedPoolStore } from '../../../src/midnight/vault-pool.js';
import { openNonceSecrets, recordsKeypairFrom, startNonceSecret } from '../../../src/midnight/company-nonce-secret.js';
import { directoryEntryMade, type DirectoryFiling } from '../../../src/midnight/seat-directory.js';
import { invitationIdOf, newInvitationToken } from '../../../src/core/invitation.js';
import type { Hex } from '../../../src/core/crypto.js';
import { directoryHere, type DirectoryHere, type DirectoryHereDeps } from './vault-page-doors.js';
import { giveEachVaultSecretHere } from './vault-secret-given.js';
import { anchoredEntering } from '../../../src/testing/record-tree-double.js';
import { leavesOfTheContract, seatOpenedFor } from '../../../src/testing/directory-seats.js';
import { recordsReaderOf, type DeviceSigner } from './deposit-on-device.js';
import { invitedAsRaised, proposalIdentityOfTheContract, invitedSeatsOfTheTestChain } from '../../../src/testing/invitation-approved.js';

/*
 * A NEW SIGNER IS GIVEN EACH VAULT'S NONCE SECRET FROM A SIGNER'S OWN DEVICE.
 * Two signers' wallets sign their entries and records keys for one company;
 * the directory, the chain's read and the records are held in memory, and the
 * copies are made and opened with the real record code.
 */
const LABEL = `co_${'c1'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'c0'.repeat(32) as AccountAddress;
const CO = 'acc_given';
/** The company's viewing key, which a member's device holds and opens every entry's proof with. */
const VIEWING = '5e'.repeat(32) as Hex;
const VAULTS = ['ab'.repeat(32), 'cd'.repeat(32)];

/** A seat; every seat but the founding one carries the invitation the seat `invitedBy` signed for its person. */
const signer = (n: number, invitedBy?: { readonly filingSecret: Hex }) => {
  const identity = identityFromSecret(new Uint8Array(32).fill(n));
  const companyKey = new Uint8Array(32).fill(n + 100);
  const committeeKey = committeeKeyFor(identity, LABEL) as { tag: string; value: string };
  /* The seat as a seating device makes it: its leaf commits to this wallet key, and its opening shows that. */
  const { seat, opening } = seatOpenedFor(committeeKey, n);
  const filing = newSigningKeypair();
  const statement = signDirectoryEntry(identity, LABEL, ACCOUNT, companyKey, filing.publicKey, seat);
  const entry = directoryEntryMade({
    company: CO, person: `p${n}`, committeeKey, signed: statement, opening, signingSecret: filing.secret, viewingKey: VIEWING,
    ...(invitedBy === undefined ? {} : { invited: invitedAsRaised({
      company: CO, invitation: invitationIdOf(newInvitationToken()), person: `p${n}`, name: `p${n}`, role: 'admin', leaf: seat as Hex,
    }, invitedBy.filingSecret) }),
  });
  return {
    filingSecret: filing.secret,
    seat, companyKey, committeeKey,
    claim: (version: number): DirectoryFiling => ({ company: CO, version, change: { kind: 'claim', entry } }),
    attested: { committeeKey, statement: signRecordsKey(identity, LABEL, ACCOUNT, companyKey, seat) },
    device: { signerId: `s${n}`, wrappingSecret: '00'.repeat(32), companyKey } as DeviceSigner,
  };
};
const ADA = signer(1);
const CAROL = signer(3, ADA);
const DAN = signer(4, ADA);

/** A company with every entry filed, every seat held and every wallet on the committee, unless the test says otherwise. */
const company = (o: { filings?: DirectoryFiling[]; seats?: string[]; attested?: (typeof ADA.attested)[] } = {}) => {
  const stores = new Map<string, SealedPoolStore>();
  const records = (record: string) => stores.get(record) ?? stores.set(record, new MemorySealedPoolStore()).get(record)!;
  const deps: DirectoryHereDeps = {
    accountId: CO, label: LABEL, viewingKey: VIEWING,
    filings: async () => o.filings ?? [ADA.claim(1), CAROL.claim(2), DAN.claim(3)],
    holders: async () => ({ account: ACCOUNT, approvals: 1, vaultThresholds: [], policyBar: null, seatBar: seatBarOf(1, null), threshold: 1, adoptedVaults: VAULTS, founding: ADA.seat, foundingCommittee: [ADA.committeeKey], seats: o.seats ?? [ADA.seat, CAROL.seat, DAN.seat], committee: [ADA.committeeKey, CAROL.committeeKey, DAN.committeeKey] }),
    attested: async () => o.attested ?? [ADA.attested, CAROL.attested, DAN.attested],
    /* Nothing here reads a record through the anchor: the company's records hold no entry. */
    anchored: anchoredEntering(CO),
    leaves: leavesOfTheContract, proposalIdentity: proposalIdentityOfTheContract, invitedSeats: invitedSeatsOfTheTestChain,
  };
  const directory = (): Promise<DirectoryHere> => directoryHere(deps);
  /* Every version filed, per vault, so a test counts the puts. */
  const puts: string[] = [];
  const counted = (record: string) => {
    const store = records(record);
    return Object.assign(Object.create(store), { put: async (v: string, rec: never) => { puts.push(v); return store.put(v, rec); } }) as SealedPoolStore;
  };
  return { records: counted, directory, puts };
};
const started = async (c: ReturnType<typeof company>) => {
  for (const v of VAULTS) await c.records('nonce-secret').put(v, startNonceSecret(v, [recordsReaderOf(ADA.companyKey)]));
};

const opens = async (c: ReturnType<typeof company>, who: typeof ADA, v: string) =>
  openNonceSecrets((await c.records('nonce-secret').get(v))!, v, recordsKeypairFrom(who.companyKey)).secrets;

describe('a new signer is given each vault\'s nonce secret', () => {
  /* RED WHEN: a signer lacking a copy cannot open a vault's secret with their own records key after it is given, the secret changes, or a signer who had it loses it. */
  it('every vault, sealed to the records key each new signer\'s own directory entry names, the secret unchanged', async () => {
    const c = company();
    await started(c);
    const was = await Promise.all(VAULTS.map((v) => opens(c, ADA, v)));
    const done = await giveEachVaultSecretHere({ vaultIds: VAULTS, me: ADA.device, seats: [CAROL.seat], directory: c.directory, records: c.records });
    expect(done).toEqual({ given: VAULTS, had: [], skipped: [] });
    for (const [i, v] of VAULTS.entries()) {
      expect(await opens(c, CAROL, v)).toEqual(was[i]);
      expect(await opens(c, ADA, v)).toEqual(was[i]);
    }
    /* RED WHEN: a vault whose secret every seat named can already open is filed again. */
    expect(await giveEachVaultSecretHere({ vaultIds: VAULTS, me: ADA.device, seats: [CAROL.seat], directory: c.directory, records: c.records })).toEqual({ given: [], had: VAULTS, skipped: [] });
    expect((await c.records('nonce-secret').versions(VAULTS[0]!)).length).toBe(2);
  });

  /* RED WHEN: two signers lacking a vault's secret are given it in two versions, one per signer, instead of one version that admits both. */
  it('files one version per vault for every seat that lacks it, found by the chain\'s spelling of its seat', async () => {
    const c = company();
    await started(c);
    const was = await Promise.all(VAULTS.map((v) => opens(c, ADA, v)));
    c.puts.length = 0;
    const done = await giveEachVaultSecretHere({ vaultIds: VAULTS, me: ADA.device, seats: [CAROL.seat.toUpperCase(), DAN.seat], directory: c.directory, records: c.records });
    expect(done).toEqual({ given: VAULTS, had: [], skipped: [] });
    expect(c.puts).toEqual(VAULTS);
    for (const [i, v] of VAULTS.entries()) {
      expect((await c.records('nonce-secret').versions(v)).length).toBe(2);
      expect(await opens(c, CAROL, v)).toEqual(was[i]);
      expect(await opens(c, DAN, v)).toEqual(was[i]);
      /* RED WHEN: a signer who already held the vault's secret loses it when the others are admitted. */
      expect(await opens(c, ADA, v)).toEqual(was[i]);
    }
  });

  /* RED WHEN: a copy is given to a seat whose entry is not filed, not held by the account now, or names a records key its own wallet did not attest - a key the roster or the server chose - or such a seat stops the others from being given theirs. */
  it('gives nothing to a seat this device does not believe, names it and why, and still gives every other seat its copy', async () => {
    const cases = [
      ['no entry', company({ filings: [ADA.claim(1), DAN.claim(2)] }), /no entry in the company's directory/],
      ['not seated now', company({ seats: [ADA.seat, DAN.seat] }), /account no longer holds/],
      ['records key not attested', company({ attested: [ADA.attested, DAN.attested] }), /has not attested the records key/],
    ] as const;
    for (const [what, c, why] of cases) {
      await started(c);
      const done = await giveEachVaultSecretHere({ vaultIds: VAULTS, me: ADA.device, seats: [CAROL.seat, DAN.seat], directory: c.directory, records: c.records });
      expect(done.skipped.map((s) => s.seat), what).toEqual([CAROL.seat]);
      expect(done.skipped[0]!.why, what).toMatch(why);
      expect(done.given, what).toEqual(VAULTS);
      for (const v of VAULTS) {
        expect((await c.records('nonce-secret').versions(v)).length, what).toBe(2);
        await expect(opens(c, CAROL, v), what).rejects.toThrow();
        expect(await opens(c, DAN, v), what).toEqual(await opens(c, ADA, v));
      }
    }
  });

  /* RED WHEN: a vault with no secret filed is passed over silently, so the new signer is told they hold every secret. */
  it('refuses a vault with no secret filed', async () => {
    const c = company();
    await giveEachVaultSecretHere({ vaultIds: [], me: ADA.device, seats: [CAROL.seat], directory: c.directory, records: c.records });
    await expect(giveEachVaultSecretHere({ vaultIds: VAULTS, me: ADA.device, seats: [CAROL.seat], directory: c.directory, records: c.records })).rejects.toThrow(/no nonce secret filed/);
  });
});
