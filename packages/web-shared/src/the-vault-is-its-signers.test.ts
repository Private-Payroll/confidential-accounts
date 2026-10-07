import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signDirectoryEntry, signRecordsKey, type AccountHoldersRead, type RecordsKeyStatement } from 'midnight-identity/profile/records-key';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { theVaultAsItsSignersHoldIt, VaultNotTheCompanys, type VaultAsTheWalletRead } from './vault-operation.js';
import { fileTheChainsSecretAsTheNewest } from './deposit-on-device.js';
import { FilingNotBelieved, HttpSealedPoolStore, type WireSend } from './http-sealed-pool-store.js';
import { directoryJudge } from './vault-page-doors.js';
import { MemorySealedPoolStore, SealedNotePool, type SealedPool } from '../../../src/midnight/vault-pool.js';
import { toWire, type WireRecord } from '../../../src/midnight/sealed-record-wire.js';
import { newSigningKeypair, newWrappingKeypair, sign, type Hex } from '../../../src/core/crypto.js';
import { openNonceSecrets, recordsKeypairFrom, startNonceSecret, startNonceSecretAgain } from '../../../src/midnight/company-nonce-secret.js';
import { directoryChangeMessage, vaultRecordKey, type DirectoryChange, type DirectoryFiling } from '../../../src/midnight/seat-directory.js';

/*
 * A VAULT IS ONE ITS COMPANY'S SIGNERS HOLD AS THE CHAIN SHOWS IT, AND WHAT A
 * DEVICE BUILDS FROM ITS RECORDS IS WHAT THE CHAIN NAMES. The wallet's read and
 * the vault worker are stood in; the records route is a store in memory behind
 * the page's own store, and the directory is real entries signed by real
 * wallets' committee keys.
 */
const VAULT = 'ab'.repeat(32) as Hex;
const CO = 'acc_signers';
const LABEL = `co_${'c1'.repeat(32)}` as CompanyLabel;
/** The company's account, as each signer's wallet reads it and signs for it. */
const ACCOUNT = 'ac'.repeat(32) as never;

describe('THE VAULT IS ONE ITS COMPANY\'S ACCOUNT ADOPTED, AS THE SIGNER\'S OWN WALLET READS THE CHAIN', () => {
  const holders = { committee: [{ tag: 'schnorr', value: '11'.repeat(32) }], threshold: 2, seats: ['4a'.repeat(32)], approvals: 1, adoptedVaults: [VAULT as string], founding: '4a'.repeat(32), foundingCommittee: [{ tag: 'schnorr', value: '11'.repeat(32) }] };
  const read: VaultAsTheWalletRead = { holders };
  const doors = (over: { read?: () => Promise<VaultAsTheWalletRead> } = {}) => ({ onChain: over.read ?? (async () => read) });

  it('a vault the account adopted is the company\'s, and the step goes on with who holds the account as the wallet read it', async () => {
    expect(await theVaultAsItsSignersHoldIt(doors(), VAULT)).toEqual(holders);
  });

  it('REFUSES A VAULT THE ACCOUNT HAS NOT ADOPTED, WHATEVER THE SERVICE\'S ROWS SAY, AND NO READ AT ALL', async () => {
    const unadopted = doors({ read: async () => ({ holders: { ...holders, adoptedVaults: [] } }) });
    /* RED WHEN: a deposit or a payment is made into a vault the account itself never adopted. */
    await expect(theVaultAsItsSignersHoldIt(unadopted, VAULT)).rejects.toThrow(/not one your company's account has adopted/);
    await expect(theVaultAsItsSignersHoldIt(unadopted, VAULT)).rejects.toBeInstanceOf(VaultNotTheCompanys);
    /* RED WHEN: a step goes on with no read of the chain by the person's own wallet. */
    await expect(theVaultAsItsSignersHoldIt(doors({ read: async () => { throw new Error('the wallet did not answer'); } }), VAULT))
      .rejects.toThrow(/your wallet could not say who holds this vault's company/);
  });
});

/* ------------------------------------------------------------------ the records, believed and filed again */

interface Signer { person: string; seat: string; signing: { secret: Hex; publicKey: Hex }; committeeKey: { tag: string; value: string }; companyKey: Uint8Array }
const signerOf = (person: string, n: number): Signer => {
  const identity = identityFromSecret(new Uint8Array(32).fill(n));
  const companyKey = new Uint8Array(32).fill(n + 100);
  return { person, seat: n.toString(16).padStart(2, '0').repeat(32), signing: newSigningKeypair(), committeeKey: committeeKeyFor(identity, LABEL) as never, companyKey };
};
const ADA = signerOf('ada', 1);
const BO = signerOf('bo', 2);
const filings: DirectoryFiling[] = [ADA, BO].map((s, i) => {
  const identity = identityFromSecret(new Uint8Array(32).fill(i + 1));
  return {
    company: CO, version: i + 1,
    change: { kind: 'claim', entry: { person: s.person, committeeKey: s.committeeKey, statement: signDirectoryEntry(identity, LABEL, ACCOUNT, s.companyKey, s.signing.publicKey, s.seat) } },
  };
});
const seatsNow = (...seated: Signer[]): AccountHoldersRead => ({ committee: [ADA, BO].map((s) => s.committeeKey), threshold: 2, seats: seated.map((s) => s.seat), approvals: 1, adoptedVaults: [], founding: ADA.seat, foundingCommittee: [ADA.committeeKey], account: ACCOUNT });
/** The records route, in memory, as the page's store reaches it. */
const routeOver = (kept: Map<WireRecord, MemorySealedPoolStore>): WireSend => async (path, init) => {
  const m = path.match(/\/api\/vaults\/([0-9a-f]{64})\/records\/([a-z-]+)(?:\/(versions|\d+))?$/u)!;
  const [vault, record, tail] = [m[1]!, m[2] as WireRecord, m[3]];
  const store = kept.get(record) ?? kept.set(record, new MemorySealedPoolStore()).get(record)!;
  if (init.method === 'PUT') {
    const w = JSON.parse(init.body!);
    await store.put(vault, JSON.parse(w.body));
    return { status: 201, body: { filed: true, record, version: w.version, digest: w.digest } };
  }
  if (tail === 'versions') return { status: 200, body: { record, versions: (await store.versions(vault)).map((v) => toWire(record, v.sealed)) } };
  const r = await store.get(vault);
  return { status: 200, body: { record, filed: r && toWire(record, r) } };
};
type Attested = { committeeKey: { tag: string; value: string }; statement: RecordsKeyStatement };
/** A seat's own records-key statement, signed by its wallet for the key its directory entry names, as the roster carries it. */
const attestedBy = (s: Signer, n: number): Attested =>
  ({ committeeKey: s.committeeKey, statement: signRecordsKey(identityFromSecret(new Uint8Array(32).fill(n)), LABEL, ACCOUNT, s.companyKey, s.seat) });
const everySeatAttested: Attested[] = [attestedBy(ADA, 1), attestedBy(BO, 2)];
const deviceOf = (who: Signer, kept: Map<WireRecord, MemorySealedPoolStore>, seated: () => AccountHoldersRead, reads: { n: number }, attested: Attested[] = everySeatAttested, served: readonly DirectoryFiling[] = filings) =>
  (record: WireRecord) => new HttpSealedPoolStore(record, routeOver(kept), who.signing.secret, directoryJudge({
    accountId: CO, label: LABEL, filings: async () => served, attested: async () => attested,
    holders: async () => { reads.n += 1; return seated(); },
  }));
const recordsReader = (s: Signer) => ({ publicKey: recordsKeypairFrom(s.companyKey).publicKey });
const newestSecret = (rec: SealedPool, s: Signer) => {
  const o = openNonceSecrets(rec, VAULT, recordsKeypairFrom(s.companyKey));
  return o.secrets[o.secrets.length - 1]!;
};

describe('AN ENTRY FOR A SEAT NO LONGER SEATED IS REFUSED, ON THE BALANCE READ AND ON A PAYMENT, WITH A FRESH READ EACH TIME', () => {
  it('a pool filed by a seat seated now is read; the same pool, once that seat has left, is refused', async () => {
    const kept = new Map<WireRecord, MemorySealedPoolStore>();
    const wrapping = newWrappingKeypair();
    const signers = async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }];
    let seated = seatsNow(ADA, BO);
    const reads = { n: 0 };
    await new SealedNotePool(deviceOf(BO, kept, () => seated, reads)('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers).create(VAULT, { notes: [] });
    const balance = new SealedNotePool(deviceOf(ADA, kept, () => seated, reads)('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers);
    expect((await balance.load(VAULT)).notes).toEqual([]);
    seated = seatsNow(ADA);
    /* RED WHEN: the balance read believes a pool filed by a seat the account no longer holds. */
    await expect(balance.load(VAULT)).rejects.toThrow(/no longer holds, and no retirement names it/);
    /* RED WHEN: a payment's read of the vault's secret believes a version filed by a seat that has left. */
    const secrets = new Map<WireRecord, MemorySealedPoolStore>([['nonce-secret', new MemorySealedPoolStore()]]);
    await deviceOf(BO, secrets, () => seatsNow(ADA, BO), reads)('nonce-secret').put(VAULT, startNonceSecret(VAULT, [recordsReader(ADA)]));
    await expect(deviceOf(ADA, secrets, () => seated, reads)('nonce-secret').get(VAULT)).rejects.toBeInstanceOf(FilingNotBelieved);
    /* RED WHEN: who holds the company is read once and kept, rather than asked for every read. */
    expect(reads.n).toBeGreaterThanOrEqual(3);
  });
});

describe('A SEAT WHOSE DIRECTORY ENTRY NAMES ANOTHER KEY THAN ITS WALLET ATTESTED IS NOT BELIEVED', () => {
  it('a pool filed by a seat whose own wallet attested another records key is refused on the read', async () => {
    const kept = new Map<WireRecord, MemorySealedPoolStore>();
    const wrapping = newWrappingKeypair();
    const signers = async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }];
    await new SealedNotePool(deviceOf(BO, kept, () => seatsNow(ADA, BO), { n: 0 })('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers).create(VAULT, { notes: [] });
    /* Bo's wallet attested, in the roster this device opened, a records key that is not the one his directory entry names. */
    const bosIdentity = identityFromSecret(new Uint8Array(32).fill(2));
    const otherKey = signRecordsKey(bosIdentity, LABEL, ACCOUNT, new Uint8Array(32).fill(0x77), BO.seat);
    const attested = [attestedBy(ADA, 1), { committeeKey: BO.committeeKey, statement: otherKey }];
    const read = new SealedNotePool(deviceOf(ADA, kept, () => seatsNow(ADA, BO), { n: 0 }, attested)('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers);
    /* RED WHEN: a device believes a seat whose entry names another wrapping key than the records key its own wallet attested. */
    await expect(read.load(VAULT)).rejects.toThrow(/has not attested the records key its directory entry names/);
    /* The control: the same pool, with the statement that names the entry's own key, is read. */
    const same = [attestedBy(ADA, 1), { committeeKey: BO.committeeKey, statement: signRecordsKey(bosIdentity, LABEL, ACCOUNT, BO.companyKey, BO.seat) }];
    expect((await new SealedNotePool(deviceOf(ADA, kept, () => seatsNow(ADA, BO), { n: 0 }, same)('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers).load(VAULT)).notes).toEqual([]);
  });

  it('A SEAT THE ROSTER CARRIES NO STATEMENT FOR, OR ONLY ONE UNDER ANOTHER KEY THAN SIGNED ITS ENTRY, IS REFUSED, NEVER SKIPPED', async () => {
    const kept = new Map<WireRecord, MemorySealedPoolStore>();
    const wrapping = newWrappingKeypair();
    const signers = async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }];
    await new SealedNotePool(deviceOf(BO, kept, () => seatsNow(ADA, BO), { n: 0 })('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers).create(VAULT, { notes: [] });
    const readWith = (attested: Attested[]) => new SealedNotePool(deviceOf(ADA, kept, () => seatsNow(ADA, BO), { n: 0 }, attested)('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers).load(VAULT);
    /* RED WHEN: a seat with no records-key statement is believed: the service left Bo's out of the roster. */
    await expect(readWith([attestedBy(ADA, 1)])).rejects.toThrow(/has not attested the records key its directory entry names/);
    /* RED WHEN: a statement under a key the service derives, not the one that signed Bo's entry, is taken as Bo's. */
    const derived = identityFromSecret(new Uint8Array(32).fill(0x55));
    const notBos = { committeeKey: committeeKeyFor(derived, LABEL) as never, statement: signRecordsKey(derived, LABEL, ACCOUNT, BO.companyKey, BO.seat) };
    await expect(readWith([attestedBy(ADA, 1), notBos])).rejects.toThrow(/has not attested the records key its directory entry names/);
    /* The control: with every seat's own statement, the same pool is read. */
    expect((await readWith(everySeatAttested)).notes).toEqual([]);
  });
});

describe('A RETIREMENT THE SERVER STORED BELOW THE ACCOUNT\'S THRESHOLD NOW DOES NOT KEEP A LEAVER\'S FILINGS BELIEVED', () => {
  it('a leaver\'s pool, inside a boundary one seat signed at a threshold of one where the account needs two, is refused', async () => {
    const unsigned = { kind: 'retire', seat: BO.seat, filedUpTo: { [vaultRecordKey(VAULT, 'pool')]: 99 }, threshold: 1, signatures: [] } as DirectoryChange;
    const message = directoryChangeMessage(CO, 3, unsigned);
    const retire: DirectoryFiling = { company: CO, version: 3, change: { ...unsigned, signatures: [{ publicKey: ADA.signing.publicKey, signature: sign(message, ADA.signing.secret) }] } as DirectoryChange };
    const kept = new Map<WireRecord, MemorySealedPoolStore>();
    const wrapping = newWrappingKeypair();
    const signers = async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }];
    await new SealedNotePool(deviceOf(BO, kept, () => seatsNow(ADA, BO), { n: 0 })('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers).create(VAULT, { notes: [] });
    const leftAtTwo = (): AccountHoldersRead => ({ ...seatsNow(ADA), approvals: 2 });
    const read = new SealedNotePool(deviceOf(ADA, kept, leftAtTwo, { n: 0 }, everySeatAttested, [...filings, retire])('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers);
    /* RED WHEN: the device takes the threshold a stored change names instead of the one the wallet read off the account now. */
    await expect(read.load(VAULT)).rejects.toThrow(/no longer holds/);
    /* The control: at the threshold the change was signed under, the boundary holds and the version is read. */
    const atOne = new SealedNotePool(deviceOf(ADA, kept, () => seatsNow(ADA), { n: 0 }, everySeatAttested, [...filings, retire])('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers);
    expect((await atOne.load(VAULT)).notes).toEqual([]);
  });
});

describe('THE CHAIN WINS: THE RECORDS\' NEWEST SECRET IS MADE THE ONE THE VAULT\'S COMMITMENT NAMES', () => {
  const me = (s: Signer) => ({ signerId: s.person, wrappingSecret: newWrappingKeypair().secret, companyKey: s.companyKey });

  it('A LEAVER\'S VERSION THE CHAIN VOUCHES FOR IS FILED AGAIN BY A SEATED DEVICE, AND THEN READ', async () => {
    const kept = new Map<WireRecord, MemorySealedPoolStore>();
    /* Bo filed the vault's secret, wrapped to both, and has since left. */
    await deviceOf(BO, kept, () => seatsNow(ADA, BO), { n: 0 })('nonce-secret').put(VAULT, startNonceSecret(VAULT, [recordsReader(ADA), recordsReader(BO)]));
    const theChains = newestSecret((await kept.get('nonce-secret')!.get(VAULT))!, ADA);
    const adas = deviceOf(ADA, kept, () => seatsNow(ADA), { n: 0 });
    await expect(adas('nonce-secret').get(VAULT)).rejects.toBeInstanceOf(FilingNotBelieved);
    const found = await fileTheChainsSecretAsTheNewest({ vault: VAULT, me: me(ADA), records: adas, secretIsTheVaults: (s) => s === theChains });
    /* RED WHEN: content the chain vouches for is left refused, or filed again by anybody but this device's own seat. */
    expect(found).toBe('filed-again');
    const read = (await adas('nonce-secret').get(VAULT))!;
    expect(read.version).toBe(2);
    expect(read.filedBy?.publicKey).toBe(ADA.signing.publicKey);
    expect(newestSecret(read, ADA)).toBe(theChains);
  });

  it('ONE THE CHAIN CANNOT VOUCH FOR STAYS REFUSED, AND NOTHING IS FILED', async () => {
    const kept = new Map<WireRecord, MemorySealedPoolStore>();
    await deviceOf(BO, kept, () => seatsNow(ADA, BO), { n: 0 })('nonce-secret').put(VAULT, startNonceSecret(VAULT, [recordsReader(ADA), recordsReader(BO)]));
    const adas = deviceOf(ADA, kept, () => seatsNow(ADA), { n: 0 });
    /* RED WHEN: a version the chain does not name is filed again, so a device builds from it. */
    expect(await fileTheChainsSecretAsTheNewest({ vault: VAULT, me: me(ADA), records: adas, secretIsTheVaults: () => false })).toBe('none-names-it');
    expect((await kept.get('nonce-secret')!.versions(VAULT)).length).toBe(1);
    await expect(adas('nonce-secret').get(VAULT)).rejects.toBeInstanceOf(FilingNotBelieved);
  });

  it('WHEN THE RECORDS\' NEWEST IS NOT THE SECRET THE CHAIN HOLDS, THE VERSION THE CHAIN NAMES IS FILED AGAIN AS THE NEWEST', async () => {
    const kept = new Map<WireRecord, MemorySealedPoolStore>();
    const adas = deviceOf(ADA, kept, () => seatsNow(ADA, BO), { n: 0 });
    /* Version 1 is the secret the chain holds; a fresh one was filed after it as version 2 and never set. */
    const first = startNonceSecret(VAULT, [recordsReader(ADA), recordsReader(BO)]);
    await adas('nonce-secret').put(VAULT, first);
    await adas('nonce-secret').put(VAULT, startNonceSecretAgain(first, VAULT, [recordsReader(ADA), recordsReader(BO)]));
    const theChains = newestSecret(first, ADA);
    expect(newestSecret((await adas('nonce-secret').get(VAULT))!, ADA)).not.toBe(theChains);
    /* RED WHEN: the records' newest is left disagreeing with the chain, so every deposit and payment refuses. */
    expect(await fileTheChainsSecretAsTheNewest({ vault: VAULT, me: me(ADA), records: adas, secretIsTheVaults: (s) => s === theChains })).toBe('filed-again');
    const newest = (await adas('nonce-secret').get(VAULT))!;
    expect([newest.version, newestSecret(newest, ADA)]).toEqual([3, theChains]);
    /* And once it agrees, nothing more is filed. */
    expect(await fileTheChainsSecretAsTheNewest({ vault: VAULT, me: me(ADA), records: adas, secretIsTheVaults: (s) => s === theChains })).toBe('the-newest');
    expect((await kept.get('nonce-secret')!.versions(VAULT)).length).toBe(3);
    /* RED WHEN: a re-filed version drops a signer the version the chain names was wrapped to. */
    expect(newestSecret(newest, BO)).toBe(theChains);
  });
});
