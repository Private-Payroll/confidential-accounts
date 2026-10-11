import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { recordsPublicKeyOf, signDirectoryEntry, signRecordsKey } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { newSigningKeypair, sign, type Hex } from '../core/crypto.js';
import { directoryWithItsRecordsHere, passedOverSaid, type RecordsHeldHere } from 'vaults-web-shared/vault-page-doors.js';
import { directoryEntry, recordKeyOf } from './record-manifest.js';
import { DIRECTORY } from './records-held.js';
import { GENESIS } from './record-tree.js';
import {
  applyFiling, believedDirectory, directoryChangeMessage, directoryReplayed, DirectoryRefused, emptyDirectory, filerSeatOf, filingRefusalOf,
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

  it('A CHANGE THE ANCHOR HOLDS IS COUNTED AGAINST WHO HELD THE ACCOUNT AS IT WAS ANCHORED; ONE ANCHORED WITH NOBODY KNOWN TO HOLD IT IS NOT BELIEVED', () => {
    const claims = [claim(ADA, 1), claim(BO, 2), claim(CY, 3)];
    const three = withAll([ADA, BO, CY]);
    const committee = [ADA, BO, CY].map((x) => x.committeeKey);
    const promote = quorum(three, { kind: 'role', seat: CY.seat, role: 'viewer', threshold: 2 }, [ADA, BO]);
    const now = { approvals: 2, seats: [ADA.seat, CY.seat], committee };
    const then = { approvals: 2, seats: [ADA.seat, BO.seat, CY.seat], committee };
    /* RED WHEN: a change the anchor holds is counted against who holds the account now - Bo, who signed it, has left. */
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, now, (v) => (v === 4 ? then : undefined))
      .seats.find((x) => x.seat === CY.seat)!.role).toBe('viewer');
    /* RED WHEN: a change anchored with nobody known to hold the account then is believed on the account now, or on anything. */
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, then, (v) => (v === 4 ? null : undefined))
      .seats.find((x) => x.seat === CY.seat)!.role).toBeNull();
    /* RED WHEN: a claim a batch the fold cannot read may first name (null: not known) is believed on the account now. */
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, then, () => null).seats).toEqual([]);
  });

  it('AN ANCHORED CHANGE IS COUNTED AGAINST THE SEATS ITS BATCH NAMED, WHATEVER THEIR COMMITTEE KEYS; AN ANCHORED CLAIM AGAINST THE COMMITTEE AT ITS BLOCK', () => {
    const claims = [claim(ADA, 1), claim(BO, 2), claim(CY, 3)];
    const three = withAll([ADA, BO, CY]);
    const promote = quorum(three, { kind: 'role', seat: CY.seat, role: 'viewer', threshold: 2 }, [ADA, BO]);
    const all = [ADA, BO, CY].map((x) => x.committeeKey);
    /* Bo's wallet is no longer on the committee the anchoring block shows, but his seat is in the signer tree the batch named. */
    const anchored = { approvals: 2, seats: [ADA.seat, BO.seat, CY.seat], committee: [ADA.committeeKey, CY.committeeKey] };
    const asAnchored = (v: number) => (v <= 3 ? { ...anchored, committee: all } : v === 4 ? anchored : undefined);
    /* RED WHEN: an anchored change's quorum asks the committee: Bo's signature would not count, and the promotion is lost. */
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, undefined, asAnchored)
      .seats.find((x) => x.seat === CY.seat)!.role).toBe('viewer');
    /* RED WHEN: an anchored change counts a seat the signer tree its batch named did not hold. */
    const withoutBo = (v: number) => (v <= 3 ? { ...anchored, committee: all } : v === 4 ? { ...anchored, seats: [ADA.seat, CY.seat] } : undefined);
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, undefined, withoutBo)
      .seats.find((x) => x.seat === CY.seat)!.role).toBeNull();
    /* RED WHEN: an anchored change's floor of approvals is the account's now: the threshold rose to 3 after it was anchored at 2. */
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, { approvals: 3, seats: [ADA.seat, BO.seat, CY.seat], committee: all }, asAnchored)
      .seats.find((x) => x.seat === CY.seat)!.role).toBe('viewer');
    /* RED WHEN: an anchored change is not held to the approvals the account required as it was anchored: signed for 2, anchored at 3. */
    const atThree = (v: number) => (v <= 3 ? { ...anchored, committee: all } : v === 4 ? { ...anchored, approvals: 3 } : undefined);
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, undefined, atThree)
      .seats.find((x) => x.seat === CY.seat)!.role).toBeNull();
    /* RED WHEN: an anchored claim is believed though its committee key is not on the committee at the block that anchored it. */
    const boOff = (v: number) => (v === 2 ? anchored : { ...anchored, committee: all });
    expect(believedDirectory(CO, claims, LABEL, ACCOUNT, undefined, boOff).seats.map((x) => x.seat)).toEqual([ADA.seat, CY.seat]);
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
  /** The chain read now: both seats' committee keys listed and both seats held. */
  const both = { committee: [ADA.committeeKey, BO.committeeKey], threshold: 2, seats: [ADA.seat, BO.seat] };
  it('only the signed-in person\'s own seat key, for a kind its role files, and never a retired seat', () => {
    expect(typeof filerSeatOf(dir, both, 'ada', ADA.signing.publicKey, 'run')).toBe('object');
    /* RED WHEN: a filing signed by one person is accepted in another's session. */
    expect(filerSeatOf(dir, both, 'ada', BO.signing.publicKey, 'pool')).toBe('no-entry');
    /* RED WHEN: a person with no entry may file. */
    expect(filerSeatOf(dir, both, 'cy', CY.signing.publicKey, 'pool')).toBe('no-entry');
    const roles = { ...dir, seats: dir.seats.map((s) => (s.person === 'bo' ? { ...s, role: 'approver' as const } : s)) };
    /* RED WHEN: a role files a kind it may not. */
    expect(filerSeatOf(roles, both, 'bo', BO.signing.publicKey, 'run')).toBe('role-may-not-file');
    const retired = { ...dir, seats: dir.seats.map((s) => (s.person === 'bo' ? { ...s, retired: {} } : s)) };
    /* RED WHEN: a retired seat may file again. */
    expect(filerSeatOf(retired, both, 'bo', BO.signing.publicKey, 'pool')).toBe('past-its-boundary');
  });

  it('only while the chain lists the seat\'s committee key and holds its seat now - the rule a device reads by', () => {
    const notListed = { ...both, committee: [ADA.committeeKey] };
    const notHeld = { ...both, seats: [ADA.seat] };
    /* RED WHEN: the server keeps a filing by a seat whose committee key the chain no longer lists. */
    expect(filerSeatOf(dir, notListed, 'bo', BO.signing.publicKey, 'pool')).toBe('not-on-the-committee');
    /* RED WHEN: the server keeps a filing by a seat the account no longer holds. */
    expect(filerSeatOf(dir, notHeld, 'bo', BO.signing.publicKey, 'pool')).toBe('seat-not-seated');
    /* RED WHEN: a company with no account on a chain the server can read lets a seat file. */
    expect(filerSeatOf(dir, null, 'ada', ADA.signing.publicKey, 'pool')).toBe('not-on-the-committee');
    /* One rule: the server says of the filer what a device says of the filing. */
    for (const chain of [both, notListed, notHeld]) {
      for (const seat of [ADA, BO]) {
        const server = filerSeatOf(dir, chain, seat.person, seat.signing.publicKey, 'pool');
        expect(typeof server === 'string' ? server : null).toBe(filingRefusalOf(dir, chain, seat.signing.publicKey, 'pool', 'k', 1));
      }
    }
  });
});

describe('A QUORUM\'S CHANGE PASSED OVER IS FILED AGAIN UNDER ITS OWN SIGNATURES, AND BELIEVED ONLY AS THE CHAIN AND THE CHANGES AFTER IT ALLOW', () => {
  /* Who holds the account now, as a device's own wallet reads it: Ada and Bo, one approval. */
  const both = { approvals: 1, seats: [ADA.seat, BO.seat], committee: [ADA.committeeKey, BO.committeeKey] };
  /** A quorum's change signed by `signers` for `version`, filed at `version`, or filed again at `filedAt` under those signatures. */
  const signedFor = (version: number, change: Parameters<typeof quorum>[1], signers: readonly Seat[] = [ADA], filedAt?: number): DirectoryFiling => {
    const f = quorum({ ...emptyDirectory(CO), version: version - 1 }, change, signers, version);
    return filedAt === undefined ? f : { ...f, version: filedAt, signedAt: version };
  };
  const boApprover = { kind: 'role', seat: BO.seat, role: 'approver', threshold: 1 } as const;
  /** The replay of `filings`, versions in `passed` passed over by the company's records, against `now`. */
  const replay = (filings: readonly DirectoryFiling[], passed: readonly number[] = [], now = both) =>
    directoryReplayed(CO, filings, LABEL, ACCOUNT, now, (v) => (passed.includes(v) ? null : undefined));
  const roleOf = (r: ReturnType<typeof replay>, s: Seat) => r.dir.seats.find((x) => x.seat === s.seat)?.role;

  it('A ROLE PASSED OVER, FILED AGAIN AS A NEW VERSION CARRYING THE VERSION ITS SIGNATURES WERE MADE FOR, IS APPLIED', () => {
    const r = replay([claim(ADA, 1), claim(BO, 2), signedFor(3, boApprover), signedFor(3, boApprover, [ADA], 4)], [3]);
    /* RED WHEN: the signatures of a change filed again are checked against the version it is filed at, or a change filed again is never believed. */
    expect(roleOf(r, BO)).toBe('approver');
    expect(r.refused.get(4)).toBeUndefined();
  });

  it('ITS SIGNATURES BIND THE VERSION IT NAMES, AND ONLY A QUORUM\'S CHANGE NAMES ONE', () => {
    /* RED WHEN: a change filed again is believed under signatures made for the version it is filed at, not the one it names. */
    const signedAtFour = { ...signedFor(4, boApprover), signedAt: 3 };
    expect(replay([claim(ADA, 1), claim(BO, 2), signedFor(3, boApprover), signedAtFour], [3]).refused.get(4)).toBe('not-signed');
    /* RED WHEN: an entry may carry the version it was signed for: a seat's own entry names none. */
    expect(replay([claim(ADA, 1), { ...claim(BO, 2), signedAt: 1 }]).refused.get(2)).toBe('not-a-change');
    expect(refusal(() => applyFiling(withAll([ADA]), { ...claim(BO, 2), signedAt: 1 }, { label: LABEL, account: ACCOUNT, chain: chainOf([ADA, BO]), who: who('bo') }))).toBe('not-a-change');
  });

  it('REFUSED, WITH WHY: A VERSION APPLIED AT ITS OWN VERSION', () => {
    /* RED WHEN: a change applied at its own version may be filed again - a second application of one quorum's signatures. */
    expect(replay([claim(ADA, 1), claim(BO, 2), signedFor(3, boApprover), signedFor(3, boApprover, [ADA], 4)]).refused.get(4)).toBe('signed-at-applied');
  });

  it('REFUSED, WITH WHY: A CHANGE ALREADY FILED AGAIN AND APPLIED', () => {
    /* RED WHEN: a change filed again once may be filed again a second time and applied twice. */
    const twice = replay([claim(ADA, 1), claim(BO, 2), signedFor(3, boApprover), signedFor(3, boApprover, [ADA], 4), signedFor(3, boApprover, [ADA], 5)], [3]);
    expect([twice.refused.get(4), twice.refused.get(5)]).toEqual([undefined, 'signed-at-applied']);
  });

  it('REFUSED, WITH WHY: A CHANGE NEITHER PASSED OVER NOR RESTING ON ONE', () => {
    /* Cy's role signed before his entry, refused at its own version; nothing was passed over. */
    const cy = { kind: 'role', seat: CY.seat, role: 'approver', threshold: 1 } as const;
    const withCy = { ...both, seats: [...both.seats, CY.seat], committee: [...both.committee, CY.committeeKey] };
    /* RED WHEN: any change refused at its own version may be filed again - a change refused for its own sake revived later. */
    expect(replay([claim(ADA, 1), signedFor(2, cy), claim(CY, 3), signedFor(2, cy, [ADA], 4)], [], withCy).refused.get(4)).toBe('signed-at-not-passed-over');
  });

  it('A CHANGE RESTING ON A SEAT A PASSED-OVER VERSION CLAIMED IS FILED AGAIN ONCE THAT SEAT\'S ENTRY IS', () => {
    /* Bo's entry (2) passed over; his role (3) anchored, refused for want of his seat; his entry filed again (4); his role filed again (5). */
    const r = replay([claim(ADA, 1), claim(BO, 2), signedFor(3, boApprover), claim(BO, 4), signedFor(3, boApprover, [ADA], 5)], [2]);
    expect(r.refused.get(3)).toBe('no-such-seat');
    /* RED WHEN: only a version itself passed over may be filed again - a change resting on a passed-over entry would be lost for good. */
    expect(roleOf(r, BO)).toBe('approver');
  });

  it('ORDERED PER SEAT: A CHANGE PASSED OVER ONCE MORE IS NEVER REFUSED FOR ANOTHER SEAT\'S CHANGE FILED AGAIN AFTER IT', () => {
    const adaAdmin = { kind: 'role', seat: ADA.seat, role: 'admin', threshold: 1 } as const;
    /* Bo's role (3) and Ada's (4) passed over; filed again (5, 6); the service passes over Bo's again (5) and anchors Ada's (6); Bo's filed a third time (7). */
    const r = replay([claim(ADA, 1), claim(BO, 2), signedFor(3, boApprover), signedFor(4, adaAdmin), signedFor(3, boApprover, [ADA], 5),
      signedFor(4, adaAdmin, [ADA], 6), signedFor(3, boApprover, [ADA], 7)], [3, 4, 5]);
    expect(r.refused.get(6)).toBeUndefined();
    /* RED WHEN: changes filed again are ordered across every seat - Bo's role refused for good as out of order, his seats signing it again. */
    expect(r.refused.get(7)).toBeUndefined();
    expect(roleOf(r, BO)).toBe('approver');
    expect(roleOf(r, ADA)).toBe('admin');
    /* RED WHEN: another seat's change filed again first holds this one back - filed in any order across seats, each is applied. */
    const across = replay([claim(ADA, 1), claim(BO, 2), signedFor(3, boApprover), signedFor(4, adaAdmin), signedFor(4, adaAdmin, [ADA], 5),
      signedFor(3, boApprover, [ADA], 6)], [3, 4]);
    expect([across.refused.get(5), across.refused.get(6), roleOf(across, BO)]).toEqual([undefined, undefined, 'approver']);
  });

  it('ORDERED PER SEAT: ONE SEAT\'S CHANGE SIGNED FOR AN EARLIER VERSION, FILED AGAIN AFTER A LATER ONE TO THAT SEAT, IS REFUSED', () => {
    const boViewer = { kind: 'role', seat: BO.seat, role: 'viewer', threshold: 1 } as const;
    /* Bo's approver role (3) and viewer role (4) both passed over; the later filed again first (5), then the earlier (6). */
    const r = replay([claim(ADA, 1), claim(BO, 2), signedFor(3, boApprover), signedFor(4, boViewer), signedFor(4, boViewer, [ADA], 5),
      signedFor(3, boApprover, [ADA], 6)], [3, 4]);
    expect(r.refused.get(5)).toBeUndefined();
    /* RED WHEN: a change filed again is judged only against changes applied at their own version - one seat's changes filed again in any order. */
    expect(r.refused.get(6)).toBe('reverses-a-later-change');
    expect(roleOf(r, BO)).toBe('viewer');
  });

  it('A CHANGE FILED AGAIN THAT WOULD UNDO A LATER CHANGE TO THE SAME SEAT IS REFUSED', () => {
    const boViewer = { kind: 'role', seat: BO.seat, role: 'viewer', threshold: 1 } as const;
    const r = replay([claim(ADA, 1), claim(BO, 2), signedFor(3, boApprover), signedFor(4, boViewer), signedFor(3, boApprover, [ADA], 5)], [3]);
    /* RED WHEN: a change filed again reverses a change to its seat applied for a later version. */
    expect(r.refused.get(5)).toBe('reverses-a-later-change');
    expect(roleOf(r, BO)).toBe('viewer');
  });

  it('A CHANGE SIGNED BY A SEAT WHOSE OWN ENTRY WAS PASSED OVER RESTS ON IT; ONE PASSED OVER ONLY AFTER IT DOES NOT', () => {
    const adaAdmin = { kind: 'role', seat: ADA.seat, role: 'admin', threshold: 1 } as const;
    /* Bo's entry (2) passed over; Ada's role signed by Bo (3), refused for want of his seat; his entry again (4); the role again (5). */
    const r = replay([claim(ADA, 1), claim(BO, 2), signedFor(3, adaAdmin, [BO]), claim(BO, 4), signedFor(3, adaAdmin, [BO], 5)], [2]);
    expect(r.refused.get(3)).toBe('below-quorum');
    /* RED WHEN: only a change naming a passed-over seat rests on it, not one signed by that seat's key. */
    expect(r.refused.get(5)).toBeUndefined();
    expect(roleOf(r, ADA)).toBe('admin');
    /* RED WHEN: a version passed over after the change is taken as one it rests on. */
    const after = replay([claim(ADA, 1), signedFor(2, adaAdmin, [BO]), claim(BO, 3), claim(BO, 4), signedFor(2, adaAdmin, [BO], 5)], [3]);
    expect(after.refused.get(5)).toBe('signed-at-not-passed-over');
  });

  it('NOT YET ANCHORED, A CHANGE FILED AGAIN IS SIGNED AGAINST THE APPROVALS THE ACCOUNT REQUIRES NOW, AS THE SERVICE FILES IT; ANCHORED, AS ANY VERSION', () => {
    const two = { kind: 'role', seat: BO.seat, role: 'approver', threshold: 2 } as const;
    const filings = [claim(ADA, 1), claim(BO, 2), signedFor(3, two, [ADA, BO]), signedFor(3, two, [ADA, BO], 4)];
    /* RED WHEN: a device files again a change signed against more approvals than the account requires now, which the service refuses for ever. */
    expect(replay(filings, [3]).refused.get(4)).toBe('threshold-not-the-chains');
    /* RED WHEN: an anchored change filed again is judged by the chain now - a later change of the account undoing it on every device. */
    const held = { approvals: 1, seats: [ADA.seat, BO.seat], committee: both.committee };
    const anchored = directoryReplayed(CO, filings, LABEL, ACCOUNT, { ...both, seats: [ADA.seat] }, (v) => (v === 3 ? null : v === 4 ? held : undefined));
    expect(anchored.refused.get(4)).toBeUndefined();
    expect(anchored.dir.seats.find((x) => x.seat === BO.seat)?.role).toBe('approver');
  });

  describe('ON A DEVICE: WHAT IT FILES AGAIN, IN WHAT ORDER, AND WHAT IT HOLDS BACK', () => {
    const committee = [ADA.committeeKey, BO.committeeKey, CY.committeeKey];
    const adaAdmin = { kind: 'role', seat: ADA.seat, role: 'admin', threshold: 1 } as const;
    /** A device's read of `filings`, the company's records having anchored versions 1 and `last` and passed over those between. */
    const readOf = (filings: readonly DirectoryFiling[], last: number) => {
      const atAnchor = { approvals: 1, seats: [ADA.seat, CY.seat], committee: [ADA.committeeKey, CY.committeeKey] };
      const leaf = (v: number) => ({ version: v, digest: directoryEntry(filings[v - 1]!).digest, filedBy: ADA.signing.publicKey, batch: v === 1 ? 0 : 1, dirVersion: v });
      const holders = { seats: [ADA.seat, CY.seat], approvals: 1, signerRoot: '00'.repeat(32) as Hex, signers: [ADA.seat as Hex, CY.seat as Hex] };
      const records = {
        head: '11'.repeat(32), reached: GENESIS, stopped: null, asked: { records: new Set<string>(), kinds: new Set<string>() },
        history: new Map([[recordKeyOf(DIRECTORY), [leaf(1), leaf(last)]]]), notYetAnchored: [],
        directory: new Map([1, last].map((v) => [v, { digest: leaf(v).digest, batch: leaf(v).batch, held: holders }])),
        held: (v: number) => (v === 1 || v === last ? atAnchor : v < last ? null : undefined),
      } as unknown as RecordsHeldHere;
      return directoryWithItsRecordsHere({
        accountId: CO, label: LABEL, filings: async () => filings, attested: async () => [], anchored: async () => records,
        holders: async () => ({ account: ACCOUNT, seats: [ADA.seat, BO.seat, CY.seat], committee, approvals: 1 }) as never,
      } as never);
    };
    for (const [name, signers] of [['naming the seat', [ADA]], ['signed by the seat', [BO]]] as const) {
      it(`ONE RESTING ON A SEAT WHOSE ENTRY WAS PASSED OVER (${name.toUpperCase()}) HOLDS BACK EVERY LATER CHANGE TO ITS OWN SEAT ONLY, AND ONCE THE ENTRY IS FILED AGAIN THEY ARE FILED IN THEIR FIRST ORDER`, async () => {
        const first = name === 'naming the seat' ? boApprover : adaAdmin;
        const sameSeat = name === 'naming the seat' ? { kind: 'role', seat: BO.seat, role: 'viewer', threshold: 1 } as const : { ...adaAdmin, role: 'viewer' } as const;
        const another = { kind: 'role', seat: CY.seat, role: 'approver', threshold: 1 } as const;
        const filings = [claim(ADA, 1), claim(BO, 2), signedFor(3, first, signers), signedFor(4, another, [ADA]), signedFor(5, sameSeat, [ADA]), claim(CY, 6)];
        const here = await readOf(filings, 6);
        expect(here.notApplied?.map((n) => n.signedAt)).toEqual([3, 4, 5]);
        const held = here.refiled!(here.notApplied!);
        /* RED WHEN: a change to its own seat passed over after one that waits for a seat's entry is filed first, the waiting one then undoing it. */
        expect([...held.waiting]).toEqual([3, 5]);
        /* RED WHEN: a change to another seat waits behind it - every seat held back by one seat's missing entry. */
        expect(held.filed.map((f) => [f.version, f.signedAt])).toEqual([[7, 4]]);
        expect(passedOverSaid(here)).toMatch(/the change signed for version 3, 4, 5 is filed again, .* once the entry of the seat it rests on is filed again/u);
        /* Bo's entry filed again (7): all are filed again, oldest first. RED WHEN: they are filed in another order. */
        const again = await readOf([...filings, claim(BO, 7)], 6);
        expect(again.refiled!(again.notApplied!).filed.map((f) => [f.version, f.signedAt])).toEqual([[8, 3], [9, 4], [10, 5]]);
      });
    }
  });

  it('A CHANGE FILED AGAIN IS BELIEVED ONLY WHERE IT AGREES WITH WHO HOLDS THE ACCOUNT ON CHAIN NOW', () => {
    const filings = [claim(ADA, 1), claim(BO, 2), signedFor(3, boApprover), signedFor(3, boApprover, [ADA], 4)];
    const adaAlone = { approvals: 1, seats: [ADA.seat], committee: [ADA.committeeKey] };
    /* RED WHEN: a role is filed again for a seat the account no longer holds on chain. */
    expect(replay(filings, [3], adaAlone).refused.get(4)).toBe('not-as-the-chain-holds');
    const retireBo = { kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 1 } as const;
    const retiring = [claim(ADA, 1), claim(BO, 2), signedFor(3, retireBo), signedFor(3, retireBo, [ADA], 4)];
    /* RED WHEN: a retirement is filed again for a seat the account still holds on chain. */
    expect(replay(retiring, [3]).refused.get(4)).toBe('not-as-the-chain-holds');
    /* RED WHEN: the rule is turned round - a retirement of a seat the chain no longer holds is refused. */
    expect(replay(retiring, [3], { ...adaAlone, committee: both.committee }).dir.seats.find((x) => x.seat === BO.seat)?.retired).toEqual({});
  });
});
