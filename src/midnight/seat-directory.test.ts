import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { recordsPublicKeyOf, signDirectoryEntry, signRecordsKey } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { newSigningKeypair, sign, type Hex } from '../core/crypto.js';
import {
  applyFiling, believedDirectory, directoryChangeMessage, DirectoryRefused, emptyDirectory, filerSeatOf, filingRefusalOf,
  MAY_FILE, seatsWithAnotherRecordsKey, vaultRecordKey,
  type ChainHolders, type Directory, type DirectoryChange, type DirectoryEntry, type DirectoryFiling,
} from './seat-directory.js';

/*
 * A company's seat directory: what the server files and what a device believes.
 * Every entry here is signed by a real wallet's committee key, as the wallet signs
 * one; every quorum's change by real seat keys.
 */
const CO = 'acc_dir';
const LABEL = `co_${'c1'.repeat(32)}` as CompanyLabel;
/** The company's account, as every wallet here reads it and signs for it. */
const ACCOUNT = 'ac'.repeat(32) as AccountAddress;

interface Seat { person: string; seat: string; signing: { secret: Hex; publicKey: Hex }; entry: DirectoryEntry; committeeKey: { tag: string; value: string } }
const seatOf = (person: string, n: number, label: CompanyLabel = LABEL): Seat => {
  const identity = identityFromSecret(new Uint8Array(32).fill(n));
  const signing = newSigningKeypair();
  const seat = n.toString(16).padStart(2, '0').repeat(32);
  const committeeKey = committeeKeyFor(identity, label) as { tag: string; value: string };
  const statement = signDirectoryEntry(identity, label, ACCOUNT, new Uint8Array(32).fill(n + 100), signing.publicKey, seat);
  return { person, seat, signing, committeeKey, entry: { person, committeeKey, statement } };
};
const ADA = seatOf('ada', 1);
const BO = seatOf('bo', 2);
const CY = seatOf('cy', 3);
const chainOf = (seats: readonly Seat[], approvals = 1, extra: readonly Seat[] = []): ChainHolders => ({
  seats: { committee: [...seats, ...extra].map((s) => s.committeeKey), threshold: seats.length, seats: seats.map((s) => s.seat) },
  approvals,
});
const claim = (s: Seat, version: number): DirectoryFiling => ({ company: CO, version, change: { kind: 'claim', entry: s.entry } });
const who = (person: string, members = ['ada', 'bo', 'cy']) => ({ person, members });
const refusal = (f: () => unknown): string => {
  try { f(); } catch (e) { if (e instanceof DirectoryRefused) return e.code; throw e; }
  return 'applied';
};
const withAll = (seats: readonly Seat[], approvals = 1): Directory => seats.reduce(
  (d, s, i) => applyFiling(d, claim(s, i + 1), { label: LABEL, account: ACCOUNT, chain: chainOf(seats, approvals), who: who(s.person) }),
  emptyDirectory(CO));
const quorum = (dir: Directory, change: Omit<Extract<DirectoryChange, { kind: 'retire' }>, 'signatures'> | Omit<Extract<DirectoryChange, { kind: 'role' }>, 'signatures'>, signers: readonly Seat[], version = dir.version + 1): DirectoryFiling => {
  const unsigned = { ...change, signatures: [] } as DirectoryChange;
  const message = directoryChangeMessage(CO, version, unsigned);
  return { company: CO, version, change: { ...unsigned, signatures: signers.map((s) => ({ publicKey: s.signing.publicKey, signature: sign(message, s.signing.secret) })) } as DirectoryChange };
};

describe('AN ENTRY, AS THE SERVER FILES IT: SIGNED BY THE SEAT\'S OWN WALLET, FOR A SEAT THE CHAIN HOLDS', () => {
  const chain = chainOf([ADA, BO]);
  it('an entry its own wallet signed, for a seat seated now, by the person it names, is filed', () => {
    const dir = applyFiling(emptyDirectory(CO), claim(ADA, 1), { label: LABEL, account: ACCOUNT, chain, who: who('ada') });
    expect(dir.seats.map((s) => [s.person, s.seat, s.signingKey, s.role])).toEqual([['ada', ADA.seat, ADA.signing.publicKey, null]]);
  });

  it('REFUSES an entry the server made up: its signature is not the seat wallet\'s', () => {
    /* RED WHEN: an entry is filed without its statement verifying against its committee key. */
    const forged: DirectoryEntry = { ...ADA.entry, statement: { ...ADA.entry.statement, signingKey: newSigningKeypair().publicKey } };
    expect(refusal(() => applyFiling(emptyDirectory(CO), { ...claim(ADA, 1), change: { kind: 'claim', entry: forged } }, { label: LABEL, account: ACCOUNT, chain, who: who('ada') }))).toBe('entry-not-signed');
    /* RED WHEN: a statement signed for another company's label is taken for this one. */
    const elsewhere = seatOf('ada', 1, `co_${'d2'.repeat(32)}` as CompanyLabel);
    expect(refusal(() => applyFiling(emptyDirectory(CO), claim({ ...ADA, entry: elsewhere.entry }, 1), { label: LABEL, account: ACCOUNT, chain: chainOf([ADA, BO], 1, [elsewhere]), who: who('ada') }))).toBe('entry-not-signed');
  });

  it('REFUSES an entry its own wallet signed for another account carrying the same label', () => {
    const identity = identityFromSecret(new Uint8Array(32).fill(1));
    const forElsewhere: DirectoryEntry = { ...ADA.entry, statement: signDirectoryEntry(identity, LABEL, 'ad'.repeat(32) as AccountAddress, new Uint8Array(32).fill(101), ADA.signing.publicKey, ADA.seat) };
    /* RED WHEN: an entry signed for one account is filed, or believed, for another that carries the label. */
    expect(refusal(() => applyFiling(emptyDirectory(CO), { ...claim(ADA, 1), change: { kind: 'claim', entry: forElsewhere } }, { label: LABEL, account: ACCOUNT, chain, who: who('ada') }))).toBe('entry-not-signed');
    expect(believedDirectory(CO, [{ ...claim(ADA, 1), change: { kind: 'claim', entry: forElsewhere } }], LABEL, ACCOUNT).seats).toEqual([]);
    /* RED WHEN: an entry is believed for an account its statement does not name, even with the signature over that one. */
    const relabelled: DirectoryEntry = { ...forElsewhere, statement: { ...forElsewhere.statement, account: ACCOUNT } };
    expect(refusal(() => applyFiling(emptyDirectory(CO), { ...claim(ADA, 1), change: { kind: 'claim', entry: relabelled } }, { label: LABEL, account: ACCOUNT, chain, who: who('ada') }))).toBe('entry-not-signed');
  });

  it('REFUSES a company with no committee of its signers on the chain, and a key the committee does not list', () => {
    /* RED WHEN: an entry is filed for a company whose account is still held by another key. */
    const temporary: ChainHolders = { seats: { committee: [{ tag: 'schnorr', value: '77'.repeat(32) }], threshold: 1, seats: [ADA.seat] }, approvals: 1 };
    expect(refusal(() => applyFiling(emptyDirectory(CO), claim(ADA, 1), { label: LABEL, account: ACCOUNT, chain: temporary, who: who('ada') }))).toBe('not-on-the-committee');
  });

  it('REFUSES an entry for a seat the account does not hold now', () => {
    /* RED WHEN: the seat is not checked against the seats the chain holds now. */
    expect(refusal(() => applyFiling(emptyDirectory(CO), claim(CY, 1), { label: LABEL, account: ACCOUNT, chain: chainOf([ADA, BO], 1, [CY]), who: who('cy') }))).toBe('seat-not-seated');
  });

  it('REFUSES a second entry for one seat, for one key, or for one person, and an entry filed by somebody else', () => {
    const dir = applyFiling(emptyDirectory(CO), claim(ADA, 1), { label: LABEL, account: ACCOUNT, chain, who: who('ada') });
    /* RED WHEN: a seat can be entered twice. */
    const sameSeat = seatOf('bo', 1);
    expect(refusal(() => applyFiling(dir, claim({ ...sameSeat, entry: { ...sameSeat.entry, person: 'bo' } }, 2), { label: LABEL, account: ACCOUNT, chain: chainOf([ADA, BO]), who: who('bo') }))).toBe('seat-taken');
    /* RED WHEN: one filing key can stand for two seats. */
    const identity = identityFromSecret(new Uint8Array(32).fill(2));
    const boSameKey: DirectoryEntry = { person: 'bo', committeeKey: BO.committeeKey, statement: signDirectoryEntry(identity, LABEL, ACCOUNT, new Uint8Array(32).fill(102), ADA.signing.publicKey, BO.seat) };
    expect(refusal(() => applyFiling(dir, { company: CO, version: 2, change: { kind: 'claim', entry: boSameKey } }, { label: LABEL, account: ACCOUNT, chain, who: who('bo') }))).toBe('key-taken');
    /* RED WHEN: one records key can stand for two seats, so what is wrapped to one opens for the other. */
    const boSameWrapping: DirectoryEntry = { person: 'bo', committeeKey: BO.committeeKey, statement: signDirectoryEntry(identity, LABEL, ACCOUNT, new Uint8Array(32).fill(101), newSigningKeypair().publicKey, BO.seat) };
    expect(refusal(() => applyFiling(dir, { company: CO, version: 2, change: { kind: 'claim', entry: boSameWrapping } }, { label: LABEL, account: ACCOUNT, chain, who: who('bo') }))).toBe('key-taken');
    /* RED WHEN: a seat's filing key is its own records key. */
    const boOneKey: DirectoryEntry = { person: 'bo', committeeKey: BO.committeeKey, statement: signDirectoryEntry(identity, LABEL, ACCOUNT, new Uint8Array(32).fill(102), recordsPublicKeyOf(new Uint8Array(32).fill(102)), BO.seat) };
    expect(refusal(() => applyFiling(dir, { company: CO, version: 2, change: { kind: 'claim', entry: boOneKey } }, { label: LABEL, account: ACCOUNT, chain, who: who('bo') }))).toBe('key-taken');
    /* RED WHEN: one wallet signs entries for two seats, so its committee key stands for two signers. */
    const adasWallet = identityFromSecret(new Uint8Array(32).fill(1));
    const boByAda: DirectoryEntry = { person: 'bo', committeeKey: ADA.committeeKey, statement: signDirectoryEntry(adasWallet, LABEL, ACCOUNT, new Uint8Array(32).fill(150), newSigningKeypair().publicKey, BO.seat) };
    expect(refusal(() => applyFiling(dir, { company: CO, version: 2, change: { kind: 'claim', entry: boByAda } }, { label: LABEL, account: ACCOUNT, chain, who: who('bo') }))).toBe('key-taken');
    /* RED WHEN: a person may hold two entries. */
    expect(refusal(() => applyFiling(dir, claim({ ...BO, entry: { ...BO.entry, person: 'ada' } }, 2), { label: LABEL, account: ACCOUNT, chain, who: who('ada') }))).toBe('person-has-a-seat');
    /* RED WHEN: one signed-in person can file the entry of another. */
    expect(refusal(() => applyFiling(dir, claim(BO, 2), { label: LABEL, account: ACCOUNT, chain, who: who('ada') }))).toBe('not-your-entry');
    /* RED WHEN: somebody who is not a member can enter a seat. */
    expect(refusal(() => applyFiling(dir, claim(BO, 2), { label: LABEL, account: ACCOUNT, chain, who: who('bo', ['ada']) }))).toBe('not-a-member');
  });

  it('REFUSES a version that is not the next, and a filing for another company', () => {
    /* RED WHEN: a version is filed out of order. */
    expect(refusal(() => applyFiling(emptyDirectory(CO), claim(ADA, 2), { label: LABEL, account: ACCOUNT, chain, who: who('ada') }))).toBe('not-the-next-version');
    /* RED WHEN: a filing names one company and is filed in another's directory. */
    expect(refusal(() => applyFiling(emptyDirectory('acc_other'), claim(ADA, 1), { label: LABEL, account: ACCOUNT, chain, who: who('ada') }))).toBe('not-this-company');
  });
});

describe('A CHANGE TO THE DIRECTORY IS SIGNED BY AS MANY SEATS AS THE CHAIN\'S THRESHOLD (CHECK Q)', () => {
  const chain = chainOf([ADA, BO, CY], 2);
  const dir = withAll([ADA, BO, CY], 2);
  const toViewer = { kind: 'role' as const, seat: CY.seat, role: 'viewer' as const, threshold: 2 };

  it('two seats seated now, against the chain\'s threshold of two: the change is made', () => {
    const after = applyFiling(dir, quorum(dir, toViewer, [ADA, BO]), { label: LABEL, account: ACCOUNT, chain });
    expect(after.seats.find((s) => s.seat === CY.seat)!.role).toBe('viewer');
  });

  it('REFUSES one signature, the same seat twice, a stranger\'s key, a retired seat, a bad signature, and the store\'s threshold in place of the chain\'s', () => {
    /* RED WHEN: one seat is a quorum of two. */
    expect(refusal(() => applyFiling(dir, quorum(dir, toViewer, [ADA]), { label: LABEL, account: ACCOUNT, chain }))).toBe('below-quorum');
    /* RED WHEN: one seat signing twice counts as two. */
    expect(refusal(() => applyFiling(dir, quorum(dir, toViewer, [ADA, ADA]), { label: LABEL, account: ACCOUNT, chain }))).toBe('twice-by-one-seat');
    /* RED WHEN: a key with no entry counts toward the quorum. */
    const stranger = seatOf('eve', 9);
    expect(refusal(() => applyFiling(dir, quorum(dir, toViewer, [ADA, stranger]), { label: LABEL, account: ACCOUNT, chain }))).toBe('below-quorum');
    /* RED WHEN: a seat the account no longer holds counts toward the quorum. */
    expect(refusal(() => applyFiling(dir, quorum(dir, toViewer, [ADA, BO]), { label: LABEL, account: ACCOUNT, chain: chainOf([ADA, CY], 2, [BO]) }))).toBe('below-quorum');
    const retired = applyFiling(dir, quorum(dir, { kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 2 }, [ADA, CY]), { label: LABEL, account: ACCOUNT, chain });
    /* RED WHEN: a retired seat counts toward the quorum. */
    expect(refusal(() => applyFiling(retired, quorum(retired, toViewer, [ADA, BO]), { label: LABEL, account: ACCOUNT, chain }))).toBe('below-quorum');
    /* RED WHEN: a signature that does not verify is ignored rather than refused. */
    const bad = quorum(dir, toViewer, [ADA, BO]);
    const broken = { ...bad, change: { ...bad.change, signatures: (bad.change as { readonly signatures: readonly { publicKey: Hex; signature: Hex }[] }).signatures.map((s, i) => (i === 0 ? { ...s, signature: s.signature.replace(/^./u, (c) => (c === '0' ? '1' : '0')) } : s)) } } as DirectoryFiling;
    expect(refusal(() => applyFiling(dir, broken, { label: LABEL, account: ACCOUNT, chain }))).toBe('not-signed');
    /* RED WHEN: two entries under one wallet's committee key count as two signers toward a quorum. */
    const twin = { ...dir, seats: dir.seats.map((x) => (x.seat === BO.seat ? { ...x, committeeKey: ADA.committeeKey } : x)) };
    expect(refusal(() => applyFiling(twin, quorum(twin, toViewer, [ADA, BO]), { label: LABEL, account: ACCOUNT, chain }))).toBe('below-quorum');
    /* RED WHEN: a change signed against a lower number than the chain requires is filed. */
    expect(refusal(() => applyFiling(dir, quorum(dir, { ...toViewer, threshold: 1 }, [ADA]), { label: LABEL, account: ACCOUNT, chain }))).toBe('threshold-not-the-chains');
  });
});

describe('WHAT A DEVICE BELIEVES (CHECK S, ON THE DEVICE)', () => {
  const dir = withAll([ADA, BO]);
  const seated = chainOf([ADA, BO]).seats;
  const POOL = vaultRecordKey('ab'.repeat(32), 'pool');

  it('a seat seated now, on the committee, with a role that files it: believed', () => {
    expect(filingRefusalOf(dir, seated, ADA.signing.publicKey, 'pool', POOL, 7)).toBeNull();
  });

  it('REFUSES a key with no entry, a seat that has left, a key no longer on the committee, and a role that may not file it', () => {
    /* RED WHEN: a filing by a key no entry names is believed. */
    expect(filingRefusalOf(dir, seated, newSigningKeypair().publicKey, 'pool', POOL, 1)).toBe('no-entry');
    /* RED WHEN: a version signed by a seat the account no longer holds is believed, with no retirement naming it. */
    const left = chainOf([ADA], 1, [BO]).seats;
    expect(filingRefusalOf(dir, left, BO.signing.publicKey, 'pool', POOL, 1)).toBe('seat-not-seated');
    /* RED WHEN: an entry whose committee key the chain no longer lists is believed. */
    expect(filingRefusalOf(dir, { ...seated, committee: [ADA.committeeKey] }, BO.signing.publicKey, 'pool', POOL, 1)).toBe('not-on-the-committee');
    /* RED WHEN: a limited seat's filing is believed. */
    const limited = { ...dir, seats: dir.seats.map((s) => (s.seat === BO.seat ? { ...s, role: 'viewer' as const } : s)) };
    expect(filingRefusalOf(limited, seated, BO.signing.publicKey, 'pool', POOL, 1)).toBe('role-may-not-file');
    expect(MAY_FILE.approver).not.toContain('run');
  });

  it('a retired seat is believed up to the last version its quorum-signed retirement names, and refused after it', () => {
    const retiredDir = { ...dir, seats: dir.seats.map((s) => (s.seat === BO.seat ? { ...s, retired: { [POOL]: 3 } } : s)) };
    const left = chainOf([ADA], 1, [BO]).seats;
    /* RED WHEN: a retired seat's version within its boundary is refused. */
    expect(filingRefusalOf(retiredDir, left, BO.signing.publicKey, 'pool', POOL, 3)).toBeNull();
    /* RED WHEN: a retired seat's version after its boundary, or of a record the boundary does not name, is believed. */
    expect(filingRefusalOf(retiredDir, left, BO.signing.publicKey, 'pool', POOL, 4)).toBe('past-its-boundary');
    expect(filingRefusalOf(retiredDir, left, BO.signing.publicKey, 'nonce-secret', vaultRecordKey('ab'.repeat(32), 'nonce-secret'), 1)).toBe('past-its-boundary');
  });

  it('A DEVICE BELIEVES A RETIREMENT ONLY AT THE CHAIN\'S THRESHOLD NOW, SIGNED BY SEATS SEATED NOW, AND THEN UP TO ITS BOUNDARY', () => {
    const claims = [claim(ADA, 1), claim(BO, 2), claim(CY, 3)];
    const three = withAll([ADA, BO, CY]);
    /* Bo signs his own retirement, at a threshold of one, naming a boundary far ahead. */
    const selfSigned = quorum(three, { kind: 'retire', seat: BO.seat, filedUpTo: { [POOL]: 99 }, threshold: 1 }, [BO]);
    const now = { approvals: 2, seats: [ADA.seat, CY.seat], committee: [ADA, BO, CY].map((x) => x.committeeKey) };
    const left = chainOf([ADA, CY], 2, [BO]).seats;
    const replayed = believedDirectory(CO, [...claims, selfSigned], LABEL, ACCOUNT, now);
    /* RED WHEN: a device believes a change at the threshold it names rather than the account's threshold now. */
    expect(replayed.seats.find((x) => x.seat === BO.seat)!.retired).toBeNull();
    expect(filingRefusalOf(replayed, left, BO.signing.publicKey, 'pool', POOL, 50)).toBe('seat-not-seated');
    /* RED WHEN: a change signed by a seat seated now, but at a lower threshold than the account's now, is believed. */
    const lowered = quorum(three, { kind: 'retire', seat: BO.seat, filedUpTo: { [POOL]: 99 }, threshold: 1 }, [ADA]);
    expect(believedDirectory(CO, [...claims, lowered], LABEL, ACCOUNT, now).seats.find((x) => x.seat === BO.seat)!.retired).toBeNull();
    /* RED WHEN: a change counted at the chain's threshold counts a seat that has left. */
    const withBo = quorum(three, { kind: 'retire', seat: BO.seat, filedUpTo: { [POOL]: 99 }, threshold: 2 }, [ADA, BO]);
    expect(believedDirectory(CO, [...claims, withBo], LABEL, ACCOUNT, now).seats.find((x) => x.seat === BO.seat)!.retired).toBeNull();
    /* Signed by two seats seated now at the chain's threshold, the retirement is believed, and its boundary holds. */
    const signed = quorum(three, { kind: 'retire', seat: BO.seat, filedUpTo: { [POOL]: 3 }, threshold: 2 }, [ADA, CY]);
    const retired = believedDirectory(CO, [...claims, signed], LABEL, ACCOUNT, now);
    /* RED WHEN: the boundary a quorum signed is not the one kept. */
    expect(filingRefusalOf(retired, left, BO.signing.publicKey, 'pool', POOL, 3)).toBeNull();
    expect(filingRefusalOf(retired, left, BO.signing.publicKey, 'pool', POOL, 4)).toBe('past-its-boundary');
  });

  it('A REPLAYED CHANGE COUNTS ONLY SEATS SEATED NOW WHOSE COMMITTEE KEY THE CHAIN LISTS NOW', () => {
    const claims = [claim(ADA, 1), claim(BO, 2), claim(CY, 3)];
    const three = withAll([ADA, BO, CY]);
    const committee = [ADA, BO, CY].map((x) => x.committeeKey);
    /* RED WHEN: a promotion is believed though one of its signers has left and the rest are below the threshold now. */
    const promote = quorum(three, { kind: 'role', seat: CY.seat, role: 'viewer', threshold: 2 }, [ADA, BO]);
    const left = believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, { approvals: 2, seats: [ADA.seat, CY.seat], committee });
    expect(left.seats.find((x) => x.seat === CY.seat)!.role).toBeNull();
    /* An entry the server made up for a seat it seats itself, with a committee key the chain does not list. */
    const EVE = seatOf('eve', 9);
    const withEve = [...claims, claim(EVE, 4)];
    const eveDir = believedDirectory(CO, withEve, LABEL, ACCOUNT);
    const demote = quorum(eveDir, { kind: 'role', seat: ADA.seat, role: 'viewer', threshold: 1 }, [EVE]);
    const replayed = believedDirectory(CO, [...withEve, demote], LABEL, ACCOUNT, { approvals: 1, seats: [ADA.seat, BO.seat, CY.seat, EVE.seat], committee });
    /* RED WHEN: a change signed by an entry whose committee key the chain does not list counts toward its quorum. */
    expect(replayed.seats.find((x) => x.seat === ADA.seat)!.role).toBeNull();
    /* The control: with that key on the committee the chain lists, the same change is believed. */
    const listed = believedDirectory(CO, [...withEve, demote], LABEL, ACCOUNT, { approvals: 1, seats: [ADA.seat, BO.seat, CY.seat, EVE.seat], committee: [...committee, EVE.committeeKey] });
    expect(listed.seats.find((x) => x.seat === ADA.seat)!.role).toBe('viewer');
  });

  it('A DEVICE REPLAYING THE DIRECTORY LEAVES OUT AN ENTRY THE SERVER ADDED WITHOUT A VALID WALLET SIGNATURE', () => {
    const forged: DirectoryEntry = { ...BO.entry, statement: { ...BO.entry.statement, signingKey: newSigningKeypair().publicKey } };
    const filings: DirectoryFiling[] = [claim(ADA, 1), { company: CO, version: 2, change: { kind: 'claim', entry: forged } }, claim(BO, 3)];
    const believed = believedDirectory(CO, filings, LABEL, ACCOUNT);
    /* RED WHEN: the replay believes the server's entry, so the forged key could file records a device believes. */
    expect(believed.seats.map((s) => s.signingKey)).toEqual([ADA.signing.publicKey, BO.signing.publicKey]);
    /* RED WHEN: a gap in the versions served is replayed past. */
    expect(refusal(() => believedDirectory(CO, [claim(ADA, 1), claim(BO, 3)], LABEL, ACCOUNT))).toBe('not-the-next-version');
  });

  it('A SEAT WHOSE ENTRY NAMES ANOTHER WRAPPING KEY THAN THE RECORDS KEY ITS OWN WALLET ATTESTED IS REFUSED', () => {
    const identity = identityFromSecret(new Uint8Array(32).fill(1));
    const same = { committeeKey: ADA.committeeKey, statement: signRecordsKey(identity, LABEL, ACCOUNT, new Uint8Array(32).fill(101), ADA.seat) };
    const other = { committeeKey: ADA.committeeKey, statement: signRecordsKey(identity, LABEL, ACCOUNT, new Uint8Array(32).fill(55), ADA.seat) };
    const bos = { committeeKey: BO.committeeKey, statement: signRecordsKey(identityFromSecret(new Uint8Array(32).fill(2)), LABEL, ACCOUNT, new Uint8Array(32).fill(102), BO.seat) };
    expect([...seatsWithAnotherRecordsKey(dir, LABEL, ACCOUNT, [same, bos])]).toEqual([]);
    /* RED WHEN: a wrapping key the seat's wallet did not attest as its records key is believed. */
    expect([...seatsWithAnotherRecordsKey(dir, LABEL, ACCOUNT, [other, bos])]).toEqual([ADA.seat]);
    /* RED WHEN: a statement naming the entry's key outweighs another of the seat's own naming a different one. */
    expect([...seatsWithAnotherRecordsKey(dir, LABEL, ACCOUNT, [same, other, bos])]).toEqual([ADA.seat]);
    /* RED WHEN: a statement that does not verify counts: Ada is then left with none, and is refused. */
    expect([...seatsWithAnotherRecordsKey(dir, LABEL, ACCOUNT, [{ ...same, statement: { ...same.statement, signature: '00'.repeat(64) } }, bos])]).toEqual([ADA.seat]);
  });

  it('A RECORDS-KEY STATEMENT FOR ANOTHER ACCOUNT CARRYING THIS LABEL DECIDES NOTHING HERE', () => {
    const identity = identityFromSecret(new Uint8Array(32).fill(1));
    const elsewhere = { committeeKey: ADA.committeeKey, statement: signRecordsKey(identity, LABEL, 'ad'.repeat(32) as AccountAddress, new Uint8Array(32).fill(101), ADA.seat) };
    const bos = { committeeKey: BO.committeeKey, statement: signRecordsKey(identityFromSecret(new Uint8Array(32).fill(2)), LABEL, ACCOUNT, new Uint8Array(32).fill(102), BO.seat) };
    /* RED WHEN: a statement Ada's wallet signed for another account is taken as hers on this one. */
    expect([...seatsWithAnotherRecordsKey(dir, LABEL, ACCOUNT, [elsewhere, bos])]).toEqual([ADA.seat]);
    /* The control: the same statement, checked for the account it was signed for, counts. */
    expect([...seatsWithAnotherRecordsKey(dir, LABEL, 'ad'.repeat(32) as AccountAddress, [elsewhere])]).not.toContain(ADA.seat);
  });

  it('EVERY SEAT IS CHECKED: ONE WITH NO STATEMENT, OR ONE ONLY UNDER ANOTHER KEY THAN SIGNED ITS ENTRY, IS REFUSED', () => {
    const same = { committeeKey: ADA.committeeKey, statement: signRecordsKey(identityFromSecret(new Uint8Array(32).fill(1)), LABEL, ACCOUNT, new Uint8Array(32).fill(101), ADA.seat) };
    /* RED WHEN: a seat with no records-key statement is believed. */
    expect([...seatsWithAnotherRecordsKey(dir, LABEL, ACCOUNT, [same])]).toEqual([BO.seat]);
    expect([...seatsWithAnotherRecordsKey(dir, LABEL, ACCOUNT, [])]).toEqual([ADA.seat, BO.seat]);
    /* RED WHEN: a statement the service made under a committee key it derives is taken as the seat's own. */
    const derived = identityFromSecret(new Uint8Array(32).fill(0x55));
    const notBos = { committeeKey: committeeKeyFor(derived, LABEL) as { tag: string; value: string }, statement: signRecordsKey(derived, LABEL, ACCOUNT, new Uint8Array(32).fill(102), BO.seat) };
    expect([...seatsWithAnotherRecordsKey(dir, LABEL, ACCOUNT, [same, notBos])]).toEqual([BO.seat]);
    /* RED WHEN: a statement made for one seat counts for another: Bo's own wallet, naming his records key, but for Ada's seat. */
    const bosForAdasSeat = { committeeKey: BO.committeeKey, statement: signRecordsKey(identityFromSecret(new Uint8Array(32).fill(2)), LABEL, ACCOUNT, new Uint8Array(32).fill(102), ADA.seat) };
    expect([...seatsWithAnotherRecordsKey(dir, LABEL, ACCOUNT, [same, bosForAdasSeat])]).toEqual([BO.seat]);
  });
});

describe('WHO MAY FILE, ON THE SERVER (CHECK S)', () => {
  const dir = withAll([ADA, BO]);
  it('only the signed-in person\'s own seat key, for a kind its role files, and never a retired seat', () => {
    expect(typeof filerSeatOf(dir, 'ada', ADA.signing.publicKey, 'run')).toBe('object');
    /* RED WHEN: a filing signed by one person is accepted in another's session. */
    expect(filerSeatOf(dir, 'ada', BO.signing.publicKey, 'pool')).toBe('no-entry');
    /* RED WHEN: a person with no entry may file. */
    expect(filerSeatOf(dir, 'cy', CY.signing.publicKey, 'pool')).toBe('no-entry');
    const roles = { ...dir, seats: dir.seats.map((s) => (s.person === 'bo' ? { ...s, role: 'approver' as const } : s)) };
    /* RED WHEN: a role files a kind it may not. */
    expect(filerSeatOf(roles, 'bo', BO.signing.publicKey, 'run')).toBe('role-may-not-file');
    const retired = { ...dir, seats: dir.seats.map((s) => (s.person === 'bo' ? { ...s, retired: {} } : s)) };
    /* RED WHEN: a retired seat may file again. */
    expect(filerSeatOf(retired, 'bo', BO.signing.publicKey, 'pool')).toBe('past-its-boundary');
  });
});
