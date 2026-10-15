import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { recordsPublicKeyOf, signDirectoryEntry, signRecordsKey, type DirectoryEntryStatement } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { newSigningKeypair, seal, sign, type Hex } from '../core/crypto.js';
import { directoryWithItsRecordsHere, passedOverSaid, type RecordsHeldHere } from 'vaults-web-shared/vault-page-doors.js';
import { directoryEntry, recordKeyOf, WITNESSED_AS } from './record-manifest.js';
import { DIRECTORY } from './records-held.js';
import { GENESIS } from './record-tree.js';
import {
  applyFiling as applyWith, asAMember, AT_THE_SERVER, believedDirectory as believedWith, directoryChangeMessage, directoryEntryMade,
  directoryReplayed as replayedWith, DirectoryRefused, emptyDirectory, entryFilingMessage, filerSeatIn, filerSeatOf, filingRefusalOf, MAY_FILE, proofsOpenedWith,
  actingSeatOf, mayFile, signerSeatOf,
  seatsWithAnotherRecordsKey, vaultRecordKey,
  type AccountHeld, type ChainHolders, type Directory, type DirectoryChange, type DirectoryEntry, type DirectoryFiling,
} from './seat-directory.js';
import { leafOfTheContract, leavesOfTheContract, seatOpenedFor } from '../testing/directory-seats.js';
import type { LeafOf, SeatOpening } from '../core/seat-opening.js';

/*
 * A company's seat directory: what the server keeps and what a member's device believes.
 * Every entry here is signed by a real wallet's committee key, as the wallet signs
 * one, sealed under the company's roster key and signed by its seat's filing key;
 * every quorum's change by real seat keys.
 */
const CO = 'acc_dir';
const LABEL = `co_${'c1'.repeat(32)}` as CompanyLabel;
/** The company's account, as every wallet here reads it and signs for it. */
const ACCOUNT = 'ac'.repeat(32) as AccountAddress;
/** The company's viewing key, which a member's device holds and the server never does. */
const VIEWING = '5e'.repeat(32) as Hex;
/** A member's device: every entry's proof opened with the viewing key, its opening checked against the account's own compiled `signerLeaf`. */
const asMember = (leafOf: LeafOf = leafOfTheContract) => asAMember(proofsOpenedWith(CO, VIEWING), leafOf);

/* Every filing here is applied, and every replay made, as a member's device judges it, unless a case says the server does. */
const applyFiling = (dir: Directory, filing: DirectoryFiling, ctx: Omit<Parameters<typeof applyWith>[2], 'judge'> & { judge?: Parameters<typeof applyWith>[2]['judge'] }): Directory =>
  applyWith(dir, filing, { judge: asMember(), ...ctx });
const atTheServer = (dir: Directory, filing: DirectoryFiling, ctx: Omit<Parameters<typeof applyWith>[2], 'judge'>): Directory =>
  applyWith(dir, filing, { ...ctx, judge: AT_THE_SERVER });
const believedDirectory = (
  company: string, filings: readonly DirectoryFiling[], label: CompanyLabel, account: AccountAddress,
  now?: AccountHeld, asAnchored?: (version: number) => AccountHeld | null | undefined,
): Directory => believedWith(company, filings, label, account, asMember(), now, asAnchored);
const directoryReplayed = (
  company: string, filings: readonly DirectoryFiling[], label: CompanyLabel, account: AccountAddress,
  now?: AccountHeld, asAnchored?: (version: number) => AccountHeld | null | undefined,
) => replayedWith(company, filings, label, account, asMember(), now, asAnchored);

/** An entry as a seat's own device makes it, sealed under `viewingKey` and signed by the filing key `signingSecret`. */
const entryFor = (o: {
  person: string; committeeKey: { tag: string; value: string }; statement: DirectoryEntryStatement; opening: SeatOpening; signingSecret: Hex; viewingKey?: Hex;
}): DirectoryEntry => directoryEntryMade({
  company: CO, person: o.person, committeeKey: o.committeeKey, signed: o.statement, opening: o.opening, signingSecret: o.signingSecret, viewingKey: o.viewingKey ?? VIEWING,
});

interface Seat {
  person: string; seat: string; signing: { secret: Hex; publicKey: Hex }; entry: DirectoryEntry; committeeKey: { tag: string; value: string };
  opening: SeatOpening; statement: DirectoryEntryStatement;
}
const seatOf = (person: string, n: number, label: CompanyLabel = LABEL): Seat => {
  const identity = identityFromSecret(new Uint8Array(32).fill(n));
  const signing = newSigningKeypair();
  const committeeKey = committeeKeyFor(identity, label) as { tag: string; value: string };
  /* The seat as a seating device makes it: its leaf commits to this wallet key, and its opening shows that. */
  const { seat, opening } = seatOpenedFor(committeeKey, n);
  const statement = signDirectoryEntry(identity, label, ACCOUNT, new Uint8Array(32).fill(n + 100), signing.publicKey, seat);
  return { person, seat, signing, committeeKey, opening, statement, entry: entryFor({ person, committeeKey, statement, opening, signingSecret: signing.secret }) };
};
const ADA = seatOf('ada', 1);
const BO = seatOf('bo', 2);
const CY = seatOf('cy', 3);
/** Mal's wallet signs an entry for `seat` with her own filing key, carrying `opening`. */
const malFor = (mal: Seat, seat: string, opening: SeatOpening): DirectoryEntry => entryFor({
  person: 'mal', committeeKey: mal.committeeKey, opening, signingSecret: mal.signing.secret,
  statement: signDirectoryEntry(identityFromSecret(new Uint8Array(32).fill(7)), LABEL, ACCOUNT, new Uint8Array(32).fill(107), mal.signing.publicKey, seat),
});
const chainOf = (seats: readonly Seat[], approvals = 1, extra: readonly Seat[] = []): ChainHolders => ({
  seats: { committee: [...seats, ...extra].map((s) => s.committeeKey), threshold: seats.length, seats: seats.map((s) => s.seat) },
  approvals,
});
const claim = (s: Seat, version: number): DirectoryFiling => ({ company: CO, version, change: { kind: 'claim', entry: s.entry } });
const claimOf = (entry: DirectoryEntry, version: number): DirectoryFiling => ({ company: CO, version, change: { kind: 'claim', entry } });
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

describe('AN ENTRY, AS THE SERVER KEEPS IT: IN ITS SHAPE, SIGNED BY ITS FILING KEY, FOR A SEAT THE CHAIN HOLDS - AND NOTHING OPENED', () => {
  const chain = chainOf([ADA, BO]);
  const server = (dir: Directory, f: DirectoryFiling, person = 'ada', members = ['ada', 'bo', 'cy', 'mal']) =>
    refusal(() => atTheServer(dir, f, { label: LABEL, account: ACCOUNT, chain, who: who(person, members) }));

  it('an entry for a seat seated now, by the person it names, is kept, and the server holds neither its wallet key nor its opening', () => {
    const dir = atTheServer(emptyDirectory(CO), claim(ADA, 1), { label: LABEL, account: ACCOUNT, chain, who: who('ada') });
    expect(dir.seats.map((s) => [s.person, s.seat, s.signingKey, s.role])).toEqual([['ada', ADA.seat, ADA.signing.publicKey, null]]);
    /* RED WHEN: the server's directory holds a seat's wallet key or opening, so the server would learn them. */
    expect(dir.seats.map((s) => [s.committeeKey, s.opening])).toEqual([[undefined, undefined]]);
    /* RED WHEN: an entry carries its wallet key, the wallet's signature or its opening where the server can read them. */
    const filed = JSON.stringify(ADA.entry);
    expect(filed).not.toContain(ADA.committeeKey.value);
    expect(filed).not.toContain(ADA.opening.blinding);
    expect(filed).not.toContain(ADA.statement.signature);
  });

  it('keeps an entry whose sealed proof it cannot open, and one whose proof proves nothing: the server opens nothing', () => {
    /* RED WHEN: the server needs an entry's proof opened to keep it - sealed under a key it does not hold, or under none. */
    const sealedElsewhere = entryFor({ ...ADA, person: 'ada', signingSecret: ADA.signing.secret, viewingKey: '6e'.repeat(32) as Hex });
    expect(server(emptyDirectory(CO), claimOf(sealedElsewhere, 1))).toBe('applied');
    const unsigned = { person: 'ada', statement: sealedElsewhere.statement, proof: seal('{}', '77'.repeat(32)) };
    const opensNothing = { ...unsigned, signature: sign(entryFilingMessage(CO, unsigned), ADA.signing.secret) };
    expect(server(emptyDirectory(CO), claimOf(opensNothing, 1))).toBe('applied');
    /* RED WHEN: the server judges whose wallet key a seat holds: Mal's entry for Ada's seat is kept, first come; a member's device refuses it. */
    const MAL = seatOf('mal', 7);
    expect(server(emptyDirectory(CO), claimOf(malFor(MAL, ADA.seat, ADA.opening), 1), 'mal')).toBe('applied');
  });

  it('REFUSES an entry that carries a seat\'s wallet key, its wallet\'s signature or its opening in the open', () => {
    const { proof: _proof, ...rest } = ADA.entry;
    /* RED WHEN: an entry is kept with anything beside its statement, proof, filing signature and person - a wallet key or an opening in the open. */
    expect(server(emptyDirectory(CO), claimOf({ ...ADA.entry, committeeKey: ADA.committeeKey } as never, 1))).toBe('not-a-change');
    expect(server(emptyDirectory(CO), claimOf({ ...ADA.entry, opening: ADA.opening } as never, 1))).toBe('not-a-change');
    expect(server(emptyDirectory(CO), claimOf({ ...ADA.entry, statement: { ...ADA.entry.statement, signature: ADA.statement.signature } } as never, 1))).toBe('not-a-change');
    expect(server(emptyDirectory(CO), claimOf(rest as never, 1))).toBe('not-a-change');
  });

  it('REFUSES an entry not signed by the filing key it names, and one for another account', () => {
    /* RED WHEN: an entry is kept that its own filing key did not sign: anyone could enter a seat under another seat's key. */
    const otherKey = { ...ADA.entry, signature: BO.entry.signature };
    expect(server(emptyDirectory(CO), claimOf(otherKey, 1))).toBe('entry-not-filed-by-its-key');
    const swapped = { ...ADA.entry, proof: BO.entry.proof };
    expect(server(emptyDirectory(CO), claimOf(swapped, 1))).toBe('entry-not-filed-by-its-key');
    /* RED WHEN: an entry naming another account is kept for this company. */
    const identity = identityFromSecret(new Uint8Array(32).fill(1));
    const forElsewhere = entryFor({ ...ADA, person: 'ada', signingSecret: ADA.signing.secret,
      statement: signDirectoryEntry(identity, LABEL, 'ad'.repeat(32) as AccountAddress, new Uint8Array(32).fill(101), ADA.signing.publicKey, ADA.seat) });
    expect(server(emptyDirectory(CO), claimOf(forElsewhere, 1))).toBe('entry-not-for-this-account');
  });

  it('REFUSES an entry for a seat the account does not hold now', () => {
    /* RED WHEN: the seat is not checked against the seats the chain holds now. */
    expect(refusal(() => atTheServer(emptyDirectory(CO), claim(CY, 1), { label: LABEL, account: ACCOUNT, chain: chainOf([ADA, BO], 1, [CY]), who: who('cy') }))).toBe('seat-not-seated');
  });

  it('KEEPS every claim on a seat - a second for one seat, one key or one person - and refuses an entry filed by somebody else', () => {
    const dir = atTheServer(emptyDirectory(CO), claim(ADA, 1), { label: LABEL, account: ACCOUNT, chain, who: who('ada') });
    /* RED WHEN: the server picks between claims on a seat, so whoever files first can keep the true holder out. */
    const sameSeat = seatOf('bo', 1);
    expect(server(dir, claimOf({ ...sameSeat.entry }, 2), 'bo')).toBe('applied');
    /* RED WHEN: the server refuses a claim for a filing key another claim names: only a member's device picks between them. */
    const identity = identityFromSecret(new Uint8Array(32).fill(2));
    const boSameKey = entryFor({ person: 'bo', committeeKey: BO.committeeKey, opening: BO.opening, signingSecret: ADA.signing.secret,
      statement: signDirectoryEntry(identity, LABEL, ACCOUNT, new Uint8Array(32).fill(102), ADA.signing.publicKey, BO.seat) });
    expect(server(dir, claimOf(boSameKey, 2), 'bo')).toBe('applied');
    /* RED WHEN: the server refuses a claim for a records key another claim names. */
    const fresh = newSigningKeypair();
    const boSameWrapping = entryFor({ person: 'bo', committeeKey: BO.committeeKey, opening: BO.opening, signingSecret: fresh.secret,
      statement: signDirectoryEntry(identity, LABEL, ACCOUNT, new Uint8Array(32).fill(101), fresh.publicKey, BO.seat) });
    expect(server(dir, claimOf(boSameWrapping, 2), 'bo')).toBe('applied');
    /* RED WHEN: a seat's filing key is its own records key. */
    const records = new Uint8Array(32).fill(102);
    const boOneKey = { ...BO.entry, statement: { ...BO.entry.statement, signingKey: recordsPublicKeyOf(records), wrappingKey: recordsPublicKeyOf(records) } };
    expect(server(dir, claimOf(boOneKey, 2), 'bo')).toBe('not-a-change');
    /* RED WHEN: the server refuses a person's second claim. */
    const boAsAda = entryFor({ ...BO, person: 'ada', signingSecret: BO.signing.secret });
    expect(server(dir, claimOf(boAsAda, 2), 'ada')).toBe('applied');
    /* RED WHEN: one signed-in person can file the entry of another. */
    expect(server(dir, claim(BO, 2), 'ada')).toBe('not-your-entry');
    /* RED WHEN: somebody who is not a member can enter a seat. */
    expect(server(dir, claim(BO, 2), 'bo', ['ada'])).toBe('not-a-member');
  });

  it('REFUSES a version that is not the next, and a filing for another company', () => {
    /* RED WHEN: a version is filed out of order. */
    expect(server(emptyDirectory(CO), claim(ADA, 2))).toBe('not-the-next-version');
    /* RED WHEN: a filing names one company and is filed in another's directory. */
    expect(refusal(() => atTheServer(emptyDirectory('acc_other'), claim(ADA, 1), { label: LABEL, account: ACCOUNT, chain, who: who('ada') }))).toBe('not-this-company');
  });
});

describe('EVERY CLAIM ON A SEAT IS KEPT; A MEMBER\'S DEVICE BELIEVES THE FIRST WHOSE PROOF PROVES, SO NO MEMBER AND NO SERVER CAN KEEP A TRUE SEAT OUT', () => {
  const MAL = seatOf('mal', 7);
  const members = ['ada', 'bo', 'cy', 'mal'];
  const everyone = [ADA, BO, CY, MAL];
  const chain = chainOf(everyone, 2);
  const now = { approvals: 2, seats: everyone.map((s) => s.seat) };
  /* Mal claims every other seat first, each with that seat's own opening; then the true holders file, then Mal her own. */
  const squats = [ADA, BO, CY].map((s, i) => claimOf(malFor(MAL, s.seat, s.opening), i + 1));
  const claims = [...squats, claim(ADA, 4), claim(BO, 5), claim(CY, 6), claim(MAL, 7)];
  const atServer = (filings: readonly DirectoryFiling[]) => filings.reduce((d, f) => {
    const person = f.change.kind === 'claim' ? f.change.entry.person : 'mal';
    return atTheServer(d, f, { label: LABEL, account: ACCOUNT, chain, who: who(person, members) });
  }, emptyDirectory(CO));

  it('a member\'s claims on every seat, filed before the true holders\', and a retirement signed by that member alone, still leave each true seat believed on a member\'s device', () => {
    const kept = atServer(claims);
    const retireBo = quorum(kept, { kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 2 }, [MAL]);
    /* RED WHEN: the server refuses a true holder's claim because a squatter claimed the seat first, or counts a quorum for the retirement. */
    const after = atServer([...claims, retireBo]);
    expect(after.seats.map((x) => [x.seat, x.person])).toEqual([
      [ADA.seat, 'mal'], [BO.seat, 'mal'], [CY.seat, 'mal'], [ADA.seat, 'ada'], [BO.seat, 'bo'], [CY.seat, 'cy'], [MAL.seat, 'mal'],
    ]);
    const believed = directoryReplayed(CO, [...claims, retireBo], LABEL, ACCOUNT, now);
    /* RED WHEN: a member's device believes a squatter's claim, or believes a seat's second claim over the first that proves. */
    expect(believed.dir.seats.map((x) => [x.seat, x.person, x.signingKey, x.retired])).toEqual([
      [ADA.seat, 'ada', ADA.signing.publicKey, null], [BO.seat, 'bo', BO.signing.publicKey, null],
      [CY.seat, 'cy', CY.signing.publicKey, null], [MAL.seat, 'mal', MAL.signing.publicKey, null],
    ]);
    /* RED WHEN: a member's device counts one member's lone signature as a quorum of two. */
    expect(believed.refused.get(8)).toBe('below-quorum');
    expect([1, 2, 3].map((v) => believed.refused.get(v))).toEqual(['key-not-in-its-leaf', 'key-not-in-its-leaf', 'key-not-in-its-leaf']);
  });

  it('the server keeps a role or retirement change without counting a quorum, and refuses a threshold that is not the chain\'s now, a bad signature, a bad shape and a wrong version', () => {
    const kept = atServer(claims);
    const server = (f: DirectoryFiling) => refusal(() => atTheServer(kept, f, { label: LABEL, account: ACCOUNT, chain, who: who('mal', members) }));
    const stranger = seatOf('eve', 9);
    /* RED WHEN: the server counts a quorum: one signature, by a key with no claim, on a seat with no claim of its own. */
    expect(server(quorum(kept, { kind: 'role', seat: BO.seat, role: 'viewer', threshold: 2 }, [stranger]))).toBe('applied');
    expect(server(quorum(kept, { kind: 'retire', seat: 'ee'.repeat(32), filedUpTo: {}, threshold: 2 }, [MAL]))).toBe('applied');
    /* RED WHEN: the server keeps a change signed against a number of approvals that is not the account's now. */
    expect(server(quorum(kept, { kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 1 }, [MAL]))).toBe('threshold-not-the-chains');
    /* RED WHEN: the server keeps a change one of whose signatures does not verify. */
    const good = quorum(kept, { kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 2 }, [MAL, ADA]);
    const sigs = (good.change as { readonly signatures: readonly { publicKey: Hex; signature: Hex }[] }).signatures;
    const broken = { ...good, change: { ...good.change, signatures: [sigs[0], { ...sigs[1]!, publicKey: BO.signing.publicKey }] } } as DirectoryFiling;
    expect(server(broken)).toBe('not-signed');
    /* RED WHEN: the server keeps a change out of its shape. */
    expect(server(quorum(kept, { kind: 'role', seat: BO.seat, role: 'owner' as never, threshold: 2 }, [MAL]))).toBe('not-a-change');
    expect(server(quorum(kept, { kind: 'retire', seat: BO.seat, filedUpTo: { k: -1 }, threshold: 2 }, [MAL]))).toBe('not-a-change');
    expect(server({ ...good, change: { ...good.change, signatures: 'none' } } as never)).toBe('not-a-change');
    /* RED WHEN: the server keeps a change at a version that is not the next. */
    expect(server({ ...good, version: kept.version + 2 })).toBe('not-the-next-version');
  });

  it('the server reads no retirement: whether a seat files is the chain\'s read alone', () => {
    const kept = atServer([claim(ADA, 1), claim(BO, 2)]);
    const retired = atTheServer(kept, quorum(kept, { kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 2 }, [ADA, BO]),
      { label: LABEL, account: ACCOUNT, chain, who: who('ada', members) });
    /* RED WHEN: the server stops a seat the chain still holds because its directory names a retirement. */
    expect(typeof filerSeatOf(retired, chain.seats, 'bo', BO.signing.publicKey)).toBe('object');
    expect(typeof signerSeatOf(retired, chain.seats, BO.signing.publicKey)).toBe('object');
    expect(typeof filerSeatIn(retired, BO.signing.publicKey)).toBe('object');
    expect(filerSeatOf(retired, chainOf([ADA], 2, [BO]).seats, 'bo', BO.signing.publicKey)).toBe('seat-not-seated');
  });

  it('a lookup by person alone no longer picks a seat when the person filed under two filing keys', () => {
    /* Bo claims a seat the chain later stops holding, then enters his own seat again under a new filing key. */
    const gone = seatOpenedFor(BO.committeeKey, 61);
    const fresh = newSigningKeypair();
    const bosWallet = identityFromSecret(new Uint8Array(32).fill(2));
    const elsewhere = entryFor({ person: 'bo', committeeKey: BO.committeeKey, opening: gone.opening, signingSecret: BO.signing.secret,
      statement: signDirectoryEntry(bosWallet, LABEL, ACCOUNT, new Uint8Array(32).fill(161), BO.signing.publicKey, gone.seat) });
    const again = entryFor({ person: 'bo', committeeKey: BO.committeeKey, opening: BO.opening, signingSecret: fresh.secret,
      statement: signDirectoryEntry(bosWallet, LABEL, ACCOUNT, new Uint8Array(32).fill(162), fresh.publicKey, BO.seat) });
    const held = chainOf([ADA, BO], 2);
    const then = { ...held, seats: { ...held.seats, seats: [...held.seats.seats, gone.seat] } };
    const kept = [claimOf(elsewhere, 1), claim(BO, 2), claimOf(again, 3)].reduce(
      (d, f) => atTheServer(d, f, { label: LABEL, account: ACCOUNT, chain: then, who: who('bo') }), emptyDirectory(CO));
    /* RED WHEN: the person's first claim is taken for them, so their filing under the key their seat holds now is refused. */
    expect(filerSeatOf(kept, held.seats, 'bo', BO.signing.publicKey)).toMatchObject({ seat: BO.seat, signingKey: BO.signing.publicKey });
    expect(filerSeatOf(kept, held.seats, 'bo', fresh.publicKey)).toMatchObject({ seat: BO.seat, signingKey: fresh.publicKey });
    expect(signerSeatOf(kept, held.seats, BO.signing.publicKey)).toMatchObject({ seat: BO.seat });
    /* RED WHEN: a filing key is taken for a person who did not file it. */
    expect(filerSeatOf(kept, held.seats, 'ada', fresh.publicKey)).toBe('no-entry');
  });
});

describe('AN ENTRY, AS A MEMBER\'S DEVICE BELIEVES IT: ITS PROOF OPENED, ITS WALLET\'S SIGNATURE CHECKED, AND ITS OPENING PROVING ITS KEY FOR ITS SEAT', () => {
  const chain = chainOf([ADA, BO]);
  const believed = (...filings: DirectoryFiling[]) => believedDirectory(CO, filings, LABEL, ACCOUNT).seats.map((x) => x.seat);

  it('a seat\'s entry is believed by the wallet key its leaf was made for, and holds that key and its opening', () => {
    const dir = believedDirectory(CO, [claim(ADA, 1)], LABEL, ACCOUNT, { approvals: 1, seats: [ADA.seat] });
    /* RED WHEN: a device believes a seat's entry by anything but its opening, or keeps no key for it. */
    expect(dir.seats.map((x) => [x.seat, x.committeeKey?.value, x.opening?.blinding])).toEqual([[ADA.seat, ADA.committeeKey.value, ADA.opening.blinding]]);
  });

  it('LEAVES OUT an entry the server made up, or one its wallet signed for another label or account', () => {
    /* RED WHEN: an entry is believed without its statement verifying against its wallet key: a fresh filing key for Ada's seat. */
    const fresh = newSigningKeypair();
    const forged = entryFor({ ...ADA, person: 'ada', signingSecret: fresh.secret, statement: { ...ADA.statement, signingKey: fresh.publicKey } });
    expect(believed(claimOf(forged, 1))).toEqual([]);
    expect(refusal(() => applyFiling(emptyDirectory(CO), claimOf(forged, 1), { label: LABEL, account: ACCOUNT, chain: null }))).toBe('entry-not-signed');
    /* RED WHEN: a statement signed for another company's label is taken for this one. */
    const elsewhere = seatOf('ada', 1, `co_${'d2'.repeat(32)}` as CompanyLabel);
    expect(refusal(() => applyFiling(emptyDirectory(CO), claim(elsewhere, 1), { label: LABEL, account: ACCOUNT, chain: null }))).toBe('entry-not-signed');
    /* RED WHEN: an entry is believed for an account its wallet did not sign for, its statement relabelled to this one. */
    const identity = identityFromSecret(new Uint8Array(32).fill(1));
    const signedElsewhere = signDirectoryEntry(identity, LABEL, 'ad'.repeat(32) as AccountAddress, new Uint8Array(32).fill(101), ADA.signing.publicKey, ADA.seat);
    const relabelled = entryFor({ ...ADA, person: 'ada', signingSecret: ADA.signing.secret, statement: { ...signedElsewhere, account: ACCOUNT } });
    expect(refusal(() => applyFiling(emptyDirectory(CO), claimOf(relabelled, 1), { label: LABEL, account: ACCOUNT, chain: null }))).toBe('entry-not-signed');
  });

  it('LEAVES OUT an entry whose proof is not sealed under the company\'s key as this device holds it', () => {
    const sealedElsewhere = entryFor({ ...ADA, person: 'ada', signingSecret: ADA.signing.secret, viewingKey: '6e'.repeat(32) as Hex });
    /* RED WHEN: a device believes an entry whose proof it could not open. */
    expect(refusal(() => applyFiling(emptyDirectory(CO), claimOf(sealedElsewhere, 1), { label: LABEL, account: ACCOUNT, chain: null }))).toBe('entry-not-opened');
    expect(believed(claimOf(sealedElsewhere, 1))).toEqual([]);
  });

  it('LEAVES OUT an entry whose wallet key is on the committee but is not the one its seat\'s leaf was made for', () => {
    /* Mal's wallet key is on the committee; her wallet signs an entry for Ada's seat, kept by the server first. */
    const MAL = seatOf('mal', 7);
    const device = (entry: DirectoryEntry) => refusal(() => applyFiling(emptyDirectory(CO), claimOf(entry, 1),
      { label: LABEL, account: ACCOUNT, chain: chainOf([ADA, BO], 1, [MAL]), who: who('mal', ['ada', 'bo', 'mal']) }));
    /* RED WHEN: a key on the committee but not in its seat's leaf is believed, carrying the seat's own opening. */
    expect(device(malFor(MAL, ADA.seat, ADA.opening))).toBe('key-not-in-its-leaf');
    /*
     * RED WHEN: an opening naming Mal's key, whose blinding is not the hash of that key under its salt, is believed: its
     * public key, blinding and scope are Ada's, so its leaf is her seat and only the blinding check stands between them.
     */
    const named = { ...ADA.opening, walletKey: { tag: 'schnorr', value: MAL.committeeKey.value } };
    expect(leafOfTheContract(named)).toBe(ADA.seat);
    expect(device(malFor(MAL, ADA.seat, named))).toBe('key-not-in-its-leaf');
    /* RED WHEN: a device believes it, replaying the same filing - and so a squatter the server kept first takes the seat. */
    expect(believed(claimOf(malFor(MAL, ADA.seat, ADA.opening), 1), claim(ADA, 2))).toEqual([ADA.seat]);
  });

  it('LEAVES OUT every entry where nothing worked out the leaf its opening makes', () => {
    /* RED WHEN: an entry is believed with no leaf to check its opening against. */
    expect(believedWith(CO, [claim(ADA, 1)], LABEL, ACCOUNT, asMember(() => null)).seats).toEqual([]);
  });

  it('LEAVES OUT a second entry under one wallet key, though each opening proves its own seat', () => {
    /* RED WHEN: one wallet enters two seats, each made for its key, so its key stands for two signers. */
    const adasWallet = identityFromSecret(new Uint8Array(32).fill(1));
    const adasSecond = seatOpenedFor(ADA.committeeKey, 51);
    const fresh = newSigningKeypair();
    const boByAda = entryFor({ person: 'bo', committeeKey: ADA.committeeKey, opening: adasSecond.opening, signingSecret: fresh.secret,
      statement: signDirectoryEntry(adasWallet, LABEL, ACCOUNT, new Uint8Array(32).fill(150), fresh.publicKey, adasSecond.seat) });
    const dir = applyFiling(emptyDirectory(CO), claim(ADA, 1), { label: LABEL, account: ACCOUNT, chain: null });
    expect(refusal(() => applyFiling(dir, claimOf(boByAda, 2), { label: LABEL, account: ACCOUNT, chain: null }))).toBe('key-taken');
    /* The server, which holds no wallet key, keeps it; the device does not believe it. */
    const kept = atTheServer(emptyDirectory(CO), claim(ADA, 1), { label: LABEL, account: ACCOUNT, chain: { ...chain, seats: { ...chain.seats, seats: [...chain.seats.seats, adasSecond.seat] } }, who: who('ada') });
    expect(refusal(() => atTheServer(kept, claimOf(boByAda, 2), { label: LABEL, account: ACCOUNT, chain: { ...chain, seats: { ...chain.seats, seats: [...chain.seats.seats, adasSecond.seat] } }, who: who('bo') }))).toBe('applied');
  });
});

describe('A CHANGE TO THE DIRECTORY IS SIGNED BY AS MANY SEATS AS THE CHAIN\'S THRESHOLD', () => {
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

describe('WHICH FILINGS A MEMBER\'S DEVICE BELIEVES: BY A SEAT IT BELIEVES, WHOSE ROLE MAY FILE THEM, HELD BY THE ACCOUNT NOW', () => {
  const dir = withAll([ADA, BO]);
  const seated = chainOf([ADA, BO]).seats;
  const POOL = vaultRecordKey('ab'.repeat(32), 'pool');

  it('a seat seated now, on the committee, with a role that files it: believed', () => {
    expect(filingRefusalOf(dir, seated, ADA.signing.publicKey, 'pool', POOL, 7)).toBeNull();
  });

  it('REFUSES a key with no entry, a seat that has left, and a role that may not file it; a seat whose key is on no committee files', () => {
    /* RED WHEN: a filing by a key no entry names is believed. */
    expect(filingRefusalOf(dir, seated, newSigningKeypair().publicKey, 'pool', POOL, 1)).toBe('no-entry');
    /* RED WHEN: a version signed by a seat the account no longer holds is believed, with no retirement naming it. */
    const left = chainOf([ADA], 1, [BO]).seats;
    expect(filingRefusalOf(dir, left, BO.signing.publicKey, 'pool', POOL, 1)).toBe('seat-not-seated');
    /* RED WHEN: a signer whose wallet key is not on the committee is refused: the committee holds only the super admins' keys. */
    expect(filingRefusalOf(dir, { ...seated, committee: [ADA.committeeKey] }, BO.signing.publicKey, 'pool', POOL, 1)).toBeNull();
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
    const now = { approvals: 2, seats: [ADA.seat, CY.seat] };
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

  it('A REPLAYED CHANGE COUNTS ONLY SEATS SEATED NOW WHOSE ENTRY\'S OPENING PROVES ITS KEY', () => {
    const claims = [claim(ADA, 1), claim(BO, 2), claim(CY, 3)];
    const three = withAll([ADA, BO, CY]);
    /* RED WHEN: a promotion is believed though one of its signers has left and the rest are below the threshold now. */
    const promote = quorum(three, { kind: 'role', seat: CY.seat, role: 'viewer', threshold: 2 }, [ADA, BO]);
    const left = believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, { approvals: 2, seats: [ADA.seat, CY.seat] });
    expect(left.seats.find((x) => x.seat === CY.seat)!.role).toBeNull();
    /* An entry the server made up: Eve's wallet signs for Dan's seat, which the chain holds, with her own seat's opening. */
    const EVE = seatOf('eve', 9);
    const DAN = seatOf('dan', 8);
    const madeUp = entryFor({
      person: 'eve', committeeKey: EVE.committeeKey, opening: EVE.opening, signingSecret: EVE.signing.secret,
      statement: signDirectoryEntry(identityFromSecret(new Uint8Array(32).fill(9)), LABEL, ACCOUNT, new Uint8Array(32).fill(109), EVE.signing.publicKey, DAN.seat),
    });
    const withMadeUp: DirectoryFiling[] = [...claims, { company: CO, version: 4, change: { kind: 'claim', entry: madeUp } }];
    const demoteBy = (filings: readonly DirectoryFiling[]) => quorum(believedDirectory(CO, filings, LABEL, ACCOUNT), { kind: 'role', seat: ADA.seat, role: 'viewer', threshold: 1 }, [EVE]);
    const everyone = { approvals: 1, seats: [ADA.seat, BO.seat, CY.seat, DAN.seat, EVE.seat] };
    const replayed = believedDirectory(CO, [...withMadeUp, demoteBy(withMadeUp)], LABEL, ACCOUNT, everyone);
    /* RED WHEN: a change signed by an entry whose opening does not make its seat's leaf counts toward its quorum. */
    expect(replayed.seats.find((x) => x.seat === ADA.seat)!.role).toBeNull();
    /* The control: Eve's own seat, which her opening proves: the same change is believed. */
    const withEve = [...claims, claim(EVE, 4)];
    const own = believedDirectory(CO, [...withEve, demoteBy(withEve)], LABEL, ACCOUNT, everyone);
    /* RED WHEN: a signer whose opening proves their seat is not counted. */
    expect(own.seats.find((x) => x.seat === ADA.seat)!.role).toBe('viewer');
  });

  it('A CHANGE THE ANCHOR HOLDS IS COUNTED AGAINST WHO HELD THE ACCOUNT AS IT WAS ANCHORED; ONE ANCHORED WITH NOBODY KNOWN TO HOLD IT IS NOT BELIEVED', () => {
    const claims = [claim(ADA, 1), claim(BO, 2), claim(CY, 3)];
    const three = withAll([ADA, BO, CY]);
    const promote = quorum(three, { kind: 'role', seat: CY.seat, role: 'viewer', threshold: 2 }, [ADA, BO]);
    const now = { approvals: 2, seats: [ADA.seat, CY.seat] };
    const then = { approvals: 2, seats: [ADA.seat, BO.seat, CY.seat] };
    /* RED WHEN: a change the anchor holds is counted against who holds the account now - Bo, who signed it, has left. */
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, now, (v) => (v === 4 ? then : undefined))
      .seats.find((x) => x.seat === CY.seat)!.role).toBe('viewer');
    /* RED WHEN: a change anchored with nobody known to hold the account then is believed on the account now, or on anything. */
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, then, (v) => (v === 4 ? null : undefined))
      .seats.find((x) => x.seat === CY.seat)!.role).toBeNull();
    /* RED WHEN: a claim a batch the fold cannot read may first name (null: not known) is believed on the account now. */
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, then, () => null).seats).toEqual([]);
  });

  it('AN ANCHORED CHANGE IS COUNTED AGAINST THE SEATS ITS BATCH NAMED, AND AN ANCHORED CLAIM BELIEVED BY ITS OPENING', () => {
    const claims = [claim(ADA, 1), claim(BO, 2), claim(CY, 3)];
    const three = withAll([ADA, BO, CY]);
    const promote = quorum(three, { kind: 'role', seat: CY.seat, role: 'viewer', threshold: 2 }, [ADA, BO]);
    /* Bo's seat is in the signer tree the batch named. */
    const anchored = { approvals: 2, seats: [ADA.seat, BO.seat, CY.seat] };
    const asAnchored = (v: number) => (v <= 4 ? anchored : undefined);
    /* RED WHEN: an anchored change's quorum is not counted over the seats its batch named: Bo's signature would not count, and the promotion is lost. */
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, undefined, asAnchored)
      .seats.find((x) => x.seat === CY.seat)!.role).toBe('viewer');
    /* RED WHEN: an anchored change counts a seat the signer tree its batch named did not hold. */
    const withoutBo = (v: number) => (v <= 3 ? anchored : v === 4 ? { ...anchored, seats: [ADA.seat, CY.seat] } : undefined);
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, undefined, withoutBo)
      .seats.find((x) => x.seat === CY.seat)!.role).toBeNull();
    /* RED WHEN: an anchored change's floor of approvals is the account's now: the threshold rose to 3 after it was anchored at 2. */
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, { approvals: 3, seats: [ADA.seat, BO.seat, CY.seat] }, asAnchored)
      .seats.find((x) => x.seat === CY.seat)!.role).toBe('viewer');
    /* RED WHEN: an anchored change is not held to the approvals the account required as it was anchored: signed for 2, anchored at 3. */
    const atThree = (v: number) => (v <= 3 ? anchored : v === 4 ? { ...anchored, approvals: 3 } : undefined);
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, undefined, atThree)
      .seats.find((x) => x.seat === CY.seat)!.role).toBeNull();
    /* RED WHEN: an anchored claim is refused though its opening proves its seat. */
    expect(believedDirectory(CO, claims, LABEL, ACCOUNT, undefined, asAnchored).seats.map((x) => x.seat)).toEqual([ADA.seat, BO.seat, CY.seat]);
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

describe('WHO MAY FILE, ON THE SERVER: A SEAT THE ACCOUNT HOLDS NOW, AND NO ROLE JUDGED', () => {
  const dir = withAll([ADA, BO]);
  /** The chain read now: both seats' committee keys listed and both seats held. */
  const both = { committee: [ADA.committeeKey, BO.committeeKey], threshold: 2, seats: [ADA.seat, BO.seat] };
  it('only the signed-in person\'s own seat key, while the chain holds its seat, whatever the directory says of a retirement', () => {
    expect(typeof filerSeatOf(dir, both, 'ada', ADA.signing.publicKey)).toBe('object');
    /* RED WHEN: a filing signed by one person is accepted in another's session. */
    expect(filerSeatOf(dir, both, 'ada', BO.signing.publicKey)).toBe('no-entry');
    /* RED WHEN: a person with no entry may file. */
    expect(filerSeatOf(dir, both, 'cy', CY.signing.publicKey)).toBe('no-entry');
    const retired = { ...dir, seats: dir.seats.map((s) => (s.person === 'bo' ? { ...s, retired: {} } : s)) };
    /* RED WHEN: the server stops a seat the chain holds because its directory names a retirement. */
    expect(typeof filerSeatOf(retired, both, 'bo', BO.signing.publicKey)).toBe('object');
  });

  it('judges no role: a limited seat files and relays at the server; a member\'s device judges the role', () => {
    const viewer = { ...dir, seats: dir.seats.map((s) => (s.person === 'bo' ? { ...s, role: 'viewer' as const } : s)) };
    /* RED WHEN: the server refuses a seat's filing, its anchoring or its relay for its role. */
    expect(typeof filerSeatOf(viewer, both, 'bo', BO.signing.publicKey)).toBe('object');
    expect(typeof signerSeatOf(viewer, both, BO.signing.publicKey)).toBe('object');
    expect(typeof filerSeatIn(viewer, BO.signing.publicKey)).toBe('object');
    expect(typeof actingSeatOf(viewer, both, 'bo', BO.signing.publicKey)).toBe('object');
    /* RED WHEN: a member's device stops judging the role: the limited seat's run is not believed there. */
    expect(filingRefusalOf(viewer, both, BO.signing.publicKey, 'run', 'k', 1)).toBe('role-may-not-file');
  });

  it('only while the chain holds its seat now, whatever keys the committee lists - the rule a device reads by', () => {
    const notListed = { ...both, committee: [ADA.committeeKey] };
    const notHeld = { ...both, seats: [ADA.seat] };
    /* RED WHEN: the server refuses a filing by a seated signer whose wallet key is on no committee. */
    expect(typeof filerSeatOf(dir, notListed, 'bo', BO.signing.publicKey)).toBe('object');
    /* RED WHEN: the server keeps a filing by a seat the account no longer holds. */
    expect(filerSeatOf(dir, notHeld, 'bo', BO.signing.publicKey)).toBe('seat-not-seated');
    /* RED WHEN: a company with no account on a chain the server can read lets a seat file. */
    expect(filerSeatOf(dir, null, 'ada', ADA.signing.publicKey)).toBe('no-account');
    /* One rule: for a seat whose role may file, the server says of the filer what a device says of the filing. */
    for (const chain of [both, notListed, notHeld]) {
      for (const seat of [ADA, BO]) {
        const server = filerSeatOf(dir, chain, seat.person, seat.signing.publicKey);
        expect(typeof server === 'string' ? server : null).toBe(filingRefusalOf(dir, chain, seat.signing.publicKey, 'pool', 'k', 1));
      }
    }
  });
});

describe('A DEMOTION OR A RETIREMENT IS AN ORDINARY CHANGE, COUNTED OVER EVERY SEATED SIGNER', () => {
  it('AT AS MANY APPROVALS AS SEATS, A DEMOTION WITHOUT THE DEMOTED SEAT\'S OWN APPROVAL IS REFUSED; WITH IT, IT IS MADE', () => {
    const chain = chainOf([ADA, BO], 2);
    const two = withAll([ADA, BO], 2);
    const demoteBo = { kind: 'role' as const, seat: BO.seat, role: 'viewer' as const, threshold: 2 };
    /* RED WHEN: the other seats alone reach a demotion where the chain needs every seat, the demoted one too. */
    expect(refusal(() => applyFiling(two, quorum(two, demoteBo, [ADA]), { label: LABEL, account: ACCOUNT, chain }))).toBe('below-quorum');
    /* RED WHEN: the demoted seat's own approval does not count toward its demotion. */
    expect(applyFiling(two, quorum(two, demoteBo, [ADA, BO]), { label: LABEL, account: ACCOUNT, chain }).seats.find((x) => x.seat === BO.seat)!.role).toBe('viewer');
  });

  it('A LONE SEAT DOES NOT RETIRE ITSELF, AND NO RETIREMENT LEAVES FEWER SEATED SIGNERS THAN THE THRESHOLD, AS THE CHAIN REFUSES BOTH', () => {
    const alone = withAll([ADA], 1);
    const retireAda = { kind: 'retire' as const, seat: ADA.seat, filedUpTo: {}, threshold: 1 };
    /* RED WHEN: the directory retires the last seated signer, which the chain never removes. */
    expect(refusal(() => applyFiling(alone, quorum(alone, retireAda, [ADA]), { label: LABEL, account: ACCOUNT, chain: chainOf([ADA], 1) }))).toBe('leaves-too-few-signers');
    expect(believedDirectory(CO, [claim(ADA, 1), quorum(alone, retireAda, [ADA])], LABEL, ACCOUNT).seats[0]!.retired).toBeNull();
    const three = withAll([ADA, BO, CY], 3);
    const retireCy = { kind: 'retire' as const, seat: CY.seat, filedUpTo: {}, threshold: 3 };
    /* RED WHEN: a retirement leaves two seated signers under a threshold of three. */
    expect(refusal(() => applyFiling(three, quorum(three, retireCy, [ADA, BO, CY]), { label: LABEL, account: ACCOUNT, chain: chainOf([ADA, BO, CY], 3) }))).toBe('leaves-too-few-signers');
    const atTwo = withAll([ADA, BO, CY], 2);
    expect(applyFiling(atTwo, quorum(atTwo, { ...retireCy, threshold: 2 }, [ADA, CY]), { label: LABEL, account: ACCOUNT, chain: chainOf([ADA, BO, CY], 2) })
      .seats.find((x) => x.seat === CY.seat)!.retired).toEqual({});
    /* RED WHEN: a change counted against no approvals at all is filed. */
    expect(refusal(() => applyFiling(alone, quorum(alone, { ...retireAda, threshold: 0 }, [ADA]), { label: LABEL, account: ACCOUNT, chain: null }))).toBe('not-a-change');
  });
});

describe('TO THE SIGNERS, A SEAT WHOSE WALLET KEY IS ON THE COMMITTEE IS A SIGNER LIKE ANY OTHER', () => {
  /* Every seat here has its wallet key on the account's committee as the chain holds it: each is a super admin there. */
  const committee = [ADA.committeeKey, BO.committeeKey, CY.committeeKey];
  const held = (approvals: number): ChainHolders => ({
    seats: { committee: committee.map((k) => ({ ...k })), threshold: 2, seats: [ADA.seat, BO.seat, CY.seat] }, approvals,
  });

  it('a demotion and a retirement of a seat whose key is on the committee are made, and the committee stays as the chain holds it', () => {
    const chain = held(2);
    const before = JSON.stringify(chain);
    const three = withAll([ADA, BO, CY], 2);
    const demoteBo = quorum(three, { kind: 'role', seat: BO.seat, role: 'viewer', threshold: 2 }, [ADA, CY]);
    /* RED WHEN: the signers' change of a seat's role is refused, or held back, because the seat's key is on the committee. */
    const demoted = applyFiling(three, demoteBo, { label: LABEL, account: ACCOUNT, chain });
    expect(demoted.seats.find((x) => x.seat === BO.seat)!.role).toBe('viewer');
    const retireCy = quorum(demoted, { kind: 'retire', seat: CY.seat, filedUpTo: {}, threshold: 2 }, [ADA, BO]);
    /* RED WHEN: the signers' retirement of a seat is refused because the seat's key is on the committee. */
    const retired = applyFiling(demoted, retireCy, { label: LABEL, account: ACCOUNT, chain });
    expect(retired.seats.find((x) => x.seat === CY.seat)!.retired).toEqual({});
    /* The same changes, replayed on a member's device against the chain now, are believed. */
    const now: AccountHeld = { approvals: 2, seats: [ADA.seat, BO.seat, CY.seat] };
    const replayed = directoryReplayed(CO, [claim(ADA, 1), claim(BO, 2), claim(CY, 3), demoteBo, retireCy], LABEL, ACCOUNT, now);
    expect([...replayed.refused]).toEqual([]);
    expect(replayed.dir.seats.map((x) => [x.person, x.role, x.retired])).toEqual([['ada', null, null], ['bo', 'viewer', null], ['cy', null, {}]]);
    /* What the signers changed is their own seats: the committee is the chain's, and nothing here holds or moves it. */
    expect(JSON.stringify(chain)).toBe(before);
    expect(Object.keys(retired).sort()).toEqual(['company', 'seats', 'version']);
  });

  it('a seat whose key is on the committee, with the signer role viewer, files no run and anchors nothing', () => {
    const dir = withAll([ADA, BO]);
    const viewer = { ...dir, seats: dir.seats.map((s) => (s.seat === BO.seat ? { ...s, role: 'viewer' as const } : s)) };
    const bo = viewer.seats.find((s) => s.seat === BO.seat)!;
    /* Its entry's opening proved the very key the committee holds. */
    expect(bo.committeeKey?.value).toBe(BO.committeeKey.value.toLowerCase());
    /* RED WHEN: what a seat may file reads the super admin role, or its key on the committee, beside its signer role. */
    expect(filingRefusalOf(viewer, held(1).seats, BO.signing.publicKey, 'run', 'k', 1)).toBe('role-may-not-file');
    expect(mayFile(bo)).toEqual([]);
    /* RED WHEN: a seat whose signer role files nothing may still anchor the company's records. */
    expect(mayFile(bo)).not.toContain(WITNESSED_AS);
  });
});

describe('A QUORUM\'S CHANGE PASSED OVER IS FILED AGAIN UNDER ITS OWN SIGNATURES, AND BELIEVED ONLY AS THE CHAIN AND THE CHANGES AFTER IT ALLOW', () => {
  /* Who holds the account now, as a device's own wallet reads it: Ada and Bo, one approval. */
  const both = { approvals: 1, seats: [ADA.seat, BO.seat] };
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

  it('A DEMOTION LOST TO THE SERVICE IS FILED AGAIN WITH ITS ORIGINAL SIGNATURES, AND NOBODY SIGNS AGAIN', () => {
    const atTwo = { ...both, approvals: 2 };
    const demoteAda = { kind: 'role', seat: ADA.seat, role: 'viewer', threshold: 2 } as const;
    const lost = signedFor(3, demoteAda, [ADA, BO]);
    const again = { ...lost, version: 4, signedAt: 3 };
    const r = replay([claim(ADA, 1), claim(BO, 2), lost, again], [3], atTwo);
    /* RED WHEN: a demotion filed again under the signatures it was first filed with is refused, or needs a new one. */
    expect(r.refused.get(4)).toBeUndefined();
    expect(roleOf(r, ADA)).toBe('viewer');
    expect(again.change).toBe(lost.change);
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
    const withCy = { ...both, seats: [...both.seats, CY.seat] };
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
    const held = { approvals: 1, seats: [ADA.seat, BO.seat] };
    const anchored = directoryReplayed(CO, filings, LABEL, ACCOUNT, { ...both, seats: [ADA.seat] }, (v) => (v === 3 ? null : v === 4 ? held : undefined));
    expect(anchored.refused.get(4)).toBeUndefined();
    expect(anchored.dir.seats.find((x) => x.seat === BO.seat)?.role).toBe('approver');
  });

  describe('ON A DEVICE: WHAT IT FILES AGAIN, IN WHAT ORDER, AND WHAT IT HOLDS BACK', () => {
    const committee = [ADA.committeeKey, BO.committeeKey, CY.committeeKey];
    const adaAdmin = { kind: 'role', seat: ADA.seat, role: 'admin', threshold: 1 } as const;
    /** A device's read of `filings`, the company's records having anchored versions 1 and `last` and passed over those between. */
    const readOf = (filings: readonly DirectoryFiling[], last: number, leaves = leavesOfTheContract) => {
      const atAnchor = { approvals: 1, seats: [ADA.seat, CY.seat] };
      const leaf = (v: number) => ({ version: v, digest: directoryEntry(filings[v - 1]!).digest, filedBy: ADA.signing.publicKey, batch: v === 1 ? 0 : 1, dirVersion: v });
      const holders = { seats: [ADA.seat, CY.seat], approvals: 1, signerRoot: '00'.repeat(32) as Hex, signers: [ADA.seat as Hex, CY.seat as Hex] };
      const records = {
        head: '11'.repeat(32), reached: GENESIS, stopped: null, asked: { records: new Set<string>(), kinds: new Set<string>() },
        history: new Map([[recordKeyOf(DIRECTORY), [leaf(1), leaf(last)]]]), notYetAnchored: [],
        directory: new Map([1, last].map((v) => [v, { digest: leaf(v).digest, batch: leaf(v).batch, held: holders }])),
        held: (v: number) => (v === 1 || v === last ? atAnchor : v < last ? null : undefined),
      } as unknown as RecordsHeldHere;
      return directoryWithItsRecordsHere({
        accountId: CO, label: LABEL, viewingKey: VIEWING, filings: async () => filings, attested: async () => [], anchored: async () => records, leaves,
        holders: async () => ({ account: ACCOUNT, seats: [ADA.seat, BO.seat, CY.seat], committee, approvals: 1 }) as never,
      } as never);
    };
    it('AN ENTRY IS BELIEVED ONLY AS THIS DEVICE\'S VAULT WORKER WORKED OUT ITS OPENING\'S LEAF', async () => {
      const filings = [claim(ADA, 1), claim(BO, 2)];
      expect((await readOf(filings, 2)).dir.seats.map((x) => x.seat)).toEqual([ADA.seat, BO.seat]);
      /* The worker says Bo's opening makes Ada's leaf. RED WHEN: the replay believes an entry the worker's leaf does not match. */
      const crossed = async (os: readonly SeatOpening[]) => os.map((o) => (o.publicKey === BO.opening.publicKey ? ADA.seat : leafOfTheContract(o)));
      expect((await readOf(filings, 2, crossed)).dir.seats.map((x) => x.seat)).toEqual([ADA.seat]);
      /* RED WHEN: a worker answer that leaves an opening out is read as if it had answered for each. */
      await expect(readOf(filings, 2, async (os) => os.slice(1).map(leafOfTheContract))).rejects.toThrow(/could not work out the leaves/u);
    });

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
    const adaAlone = { approvals: 1, seats: [ADA.seat] };
    /* RED WHEN: a role is filed again for a seat the account no longer holds on chain. */
    expect(replay(filings, [3], adaAlone).refused.get(4)).toBe('not-as-the-chain-holds');
    const retireBo = { kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 1 } as const;
    const retiring = [claim(ADA, 1), claim(BO, 2), signedFor(3, retireBo), signedFor(3, retireBo, [ADA], 4)];
    /* RED WHEN: a retirement is filed again for a seat the account still holds on chain. */
    expect(replay(retiring, [3]).refused.get(4)).toBe('not-as-the-chain-holds');
    /* RED WHEN: the rule is turned round - a retirement of a seat the chain no longer holds is refused. */
    expect(replay(retiring, [3], adaAlone).dir.seats.find((x) => x.seat === BO.seat)?.retired).toEqual({});
  });
});
