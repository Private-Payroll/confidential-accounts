import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { recordsPublicKeyOf, signDirectoryEntry, signRecordsKey, type DirectoryEntryStatement, type RecordsKeyStatement } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { newSigningKeypair, newSymmetricKey, randomBytes, seal, sign, toHex, type Hex, type Sealed } from '../core/crypto.js';
import { keyCheckOf, sealedPrevious, sealedSeed, wrapsFor } from '../core/company-key.js';
import { directoryWithItsRecordsHere, leaversStatementIn, passedOverSaid, type RecordsHeldHere } from 'vaults-web-shared/vault-page-doors.js';
import { directoryEntry, recordKeyOf, WITNESSED_AS } from './record-manifest.js';
import { DIRECTORY } from './records-held.js';
import { directoryReplaysInMemory, type DirectoryReplaysKept } from 'vaults-web-shared/tree-kept-here.js';
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
import { signSeatInvitation, type SeatInvitationTerms, type SignedSeatInvitation } from '../core/invitation.js';
import { createHash } from 'node:crypto';

const sha = (text: string): Hex => createHash('sha256').update(text).digest('hex') as Hex;

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
const asMember = (leafOf: LeafOf = leafOfTheContract) => asAMember(proofsOpenedWith(CO, [VIEWING]), leafOf, FOUNDING);

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

/** The founding seat's filing key, which invites every other seat here: drawn once so every invitation is the same seat's. */
const FOUNDER = newSigningKeypair();
/** The invitation the founding seat signs for `person`, naming `leaf` where a case says so. */
const invitationFor = (person: string, over: Partial<SeatInvitationTerms> = {}, by: Hex = FOUNDER.secret): SignedSeatInvitation => signSeatInvitation({
  company: CO, invitation: sha(`an invitation for ${person}`), person, name: person, role: 'admin', ...over,
}, by);
/**
 * An entry as a seat's own device makes it, sealed under `viewingKey` and signed by the filing key `signingSecret`,
 * carrying the invitation the founding seat signed for its person unless a case gives another, or none (`null`).
 */
const entryFor = (o: {
  person: string; committeeKey: { tag: string; value: string }; statement: DirectoryEntryStatement; opening: SeatOpening; signingSecret: Hex; viewingKey?: Hex;
  invited?: SignedSeatInvitation | null;
}): DirectoryEntry => {
  const invited = o.invited === undefined ? invitationFor(o.person, { leaf: o.statement.seat as Hex }) : o.invited;
  return directoryEntryMade({
    company: CO, person: o.person, committeeKey: o.committeeKey, signed: o.statement, opening: o.opening, signingSecret: o.signingSecret, viewingKey: o.viewingKey ?? VIEWING,
    ...(invited === null ? {} : { invited }),
  });
};

interface Seat {
  person: string; seat: string; signing: { secret: Hex; publicKey: Hex }; entry: DirectoryEntry; committeeKey: { tag: string; value: string };
  opening: SeatOpening; statement: DirectoryEntryStatement;
  /** The records-key statement the seat's own wallet signs for the records key its entry wraps to, as its roster entry carries it. */
  records: RecordsKeyStatement;
}
/** Every seat's own records-key statement, by seat: what a retirement of it carries unless a case says otherwise. */
const RECORDS = new Map<string, RecordsKeyStatement>();
/** `person`'s seat, held by the wallet made from `n`, at the leaf made from `leaf`: another leaf for the same wallet is that wallet seated again. */
const seatOf = (person: string, n: number, label: CompanyLabel = LABEL, leaf = n): Seat => {
  const identity = identityFromSecret(new Uint8Array(32).fill(n));
  /* The founding seat files with the key every invitation here is signed by; every other seat is invited by it. */
  const signing = person === 'ada' && n === 1 ? FOUNDER : newSigningKeypair();
  const committeeKey = committeeKeyFor(identity, label) as { tag: string; value: string };
  /* The seat as a seating device makes it: its leaf commits to this wallet key, and its opening shows that. */
  const { seat, opening } = seatOpenedFor(committeeKey, leaf);
  const statement = signDirectoryEntry(identity, label, ACCOUNT, new Uint8Array(32).fill(n + 100), signing.publicKey, seat);
  const records = signRecordsKey(identity, label, ACCOUNT, new Uint8Array(32).fill(n + 100), seat);
  if (label === LABEL) RECORDS.set(seat, records);
  /* The founding seat is invited by nobody. */
  return { person, seat, signing, committeeKey, opening, statement, records, entry: entryFor({ person, committeeKey, statement, opening, signingSecret: signing.secret, ...(signing === FOUNDER ? { invited: null } : {}) }) };
};
const ADA = seatOf('ada', 1);
/** The seat the account's deploy seated, as a member's device's wallet reads it: Ada's, the only entry believed uninvited. */
const FOUNDING: string = ADA.seat;
const BO = seatOf('bo', 2);
const CY = seatOf('cy', 3);
/** Mal's wallet signs an entry for `seat` with her own filing key, carrying `opening`. */
const malFor = (mal: Seat, seat: string, opening: SeatOpening): DirectoryEntry => entryFor({
  person: 'mal', committeeKey: mal.committeeKey, opening, signingSecret: mal.signing.secret,
  statement: signDirectoryEntry(identityFromSecret(new Uint8Array(32).fill(7)), LABEL, ACCOUNT, new Uint8Array(32).fill(107), mal.signing.publicKey, seat),
});
const chainOf = (seats: readonly Seat[], approvals = 1, extra: readonly Seat[] = [], seatBar = approvals): ChainHolders => ({
  seats: { committee: [...seats, ...extra].map((s) => s.committeeKey), threshold: seats.length, seats: seats.map((s) => s.seat) },
  approvals, seatBar,
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
/** A quorum's change as `signers` sign it, exactly as given. */
const signedAsIs = (dir: Directory, change: object, signers: readonly Seat[], version = dir.version + 1): DirectoryFiling => {
  const unsigned = { ...change, signatures: [] } as unknown as DirectoryChange;
  const message = directoryChangeMessage(CO, version, unsigned);
  return { company: CO, version, change: { ...unsigned, signatures: signers.map((s) => ({ publicKey: s.signing.publicKey, signature: sign(message, s.signing.secret) })) } as DirectoryChange };
};
type Retirement = Omit<Extract<DirectoryChange, { kind: 'retire' }>, 'signatures' | 'statement'> & { statement?: RecordsKeyStatement };
/**
 * A quorum's change signed by `signers`. A retirement given no statement carries its leaving seat's own; a seat no case
 * made carries one in its shape that Ada's wallet signed for it, which only the service, judging shape alone, files.
 */
const quorum = (dir: Directory, change: Retirement | Omit<Extract<DirectoryChange, { kind: 'role' }>, 'signatures'>, signers: readonly Seat[], version = dir.version + 1): DirectoryFiling =>
  signedAsIs(dir, change.kind !== 'retire' || change.statement !== undefined ? change : {
    ...change,
    statement: RECORDS.get(change.seat) ?? signRecordsKey(identityFromSecret(new Uint8Array(32).fill(1)), LABEL, ACCOUNT, new Uint8Array(32).fill(101), change.seat),
  }, signers, version);

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
  const now = { approvals: 2, seatBar: 2, seats: everyone.map((s) => s.seat) };
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

describe('A SEAT GOES TO THE PERSON A SEAT OF THE COMPANY INVITED: EVERY ENTRY BUT THE FOUNDING SEAT\'S CARRIES ITS INVITATION', () => {
  const DEE = seatOf('dee', 4);
  /** The invitation for Dee, naming her seat, as the founding seat or `by` signs it, with any term a case changes. */
  const forDee = (over: Partial<SeatInvitationTerms> = {}, by?: Hex) => invitationFor('dee', { leaf: DEE.seat as Hex, ...over }, by);
  /** Dee's entry, carrying `invited` as given (`null`: none). */
  const deesWith = (invited: SignedSeatInvitation | null) => entryFor({ ...DEE, person: 'dee', signingSecret: DEE.signing.secret, invited });
  /** What a member's device makes of Dee's entry filed after Ada's and Bo's, and of every filing before it. */
  const judged = (dees: DirectoryEntry, before: DirectoryFiling[] = [claim(ADA, 1), claim(BO, 2)]) => {
    const replayed = directoryReplayed(CO, [...before, claimOf(dees, before.length + 1)], LABEL, ACCOUNT);
    return replayed.refused.get(before.length + 1) ?? 'applied';
  };

  it('the founding seat is believed with no invitation, and an invited seat with the one its inviter signed', () => {
    /* RED WHEN: the seat the account's deploy seated needs an invitation nobody could have signed, so no company could start. */
    expect(directoryReplayed(CO, [claim(ADA, 1)], LABEL, ACCOUNT).refused.size).toBe(0);
    /* RED WHEN: an entry carrying the invitation a held seat signed for its person is refused. */
    expect(judged(DEE.entry)).toBe('applied');
    expect(judged(deesWith(forDee({}, BO.signing.secret)))).toBe('applied');
  });

  it('an entry with no invitation is not believed, unless it is the founding seat\'s', () => {
    /* RED WHEN: a seat other than the founding one is believed without an invitation a seat of the company signed for it. */
    expect(judged(deesWith(null))).toBe('not-invited');
    /* RED WHEN: an invitation for another company, or one changed after its seat signed it, stands in for this company's. */
    expect(judged(deesWith(forDee({ company: 'acc_elsewhere' })))).toBe('not-invited');
    const signed = forDee();
    expect(judged(deesWith({ ...signed, terms: { ...signed.terms, role: 'viewer' } }))).toBe('not-invited');
  });

  it('a member\'s device given no founding seat believes no entry, the founding seat\'s own included', () => {
    const noFounding = replayedWith(CO, [claim(ADA, 1), claim(BO, 2)], LABEL, ACCOUNT, asAMember(proofsOpenedWith(CO, [VIEWING]), leafOfTheContract, null));
    /* RED WHEN: a judge that knows no founding seat takes some seat for it, and believes an entry no seat invited. */
    expect([noFounding.refused.get(1), noFounding.refused.get(2)]).toEqual(['not-invited', 'inviter-not-seated']);
    expect(noFounding.dir.seats).toEqual([]);
  });

  it('an entry whose invitation names another person is not believed', () => {
    /* RED WHEN: Dee files her entry under the invitation a seat signed for somebody else. */
    expect(judged(deesWith(invitationFor('eli', { leaf: DEE.seat as Hex })))).toBe('invited-someone-else');
  });

  it('an entry whose invitation was signed by a key the directory holds no seat for, or by a retired seat, is not believed', () => {
    /* RED WHEN: an invitation signed by a key that holds no seat in the directory seats anybody. */
    expect(judged(deesWith(forDee({}, newSigningKeypair().secret)))).toBe('inviter-not-seated');
    /* RED WHEN: a seat signs an invitation the directory believes before the inviting seat's own entry is in it. */
    expect(judged(deesWith(forDee({}, BO.signing.secret)), [claim(ADA, 1)])).toBe('inviter-not-seated');
    /* RED WHEN: a seat the company retired still seats people with invitations it signs. */
    const both = believedDirectory(CO, [claim(ADA, 1), claim(BO, 2)], LABEL, ACCOUNT);
    const retireBo = quorum(both, { kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 1 }, [ADA]);
    expect(directoryReplayed(CO, [claim(ADA, 1), claim(BO, 2), retireBo], LABEL, ACCOUNT).refused.size).toBe(0);
    expect(judged(deesWith(forDee({}, BO.signing.secret)), [claim(ADA, 1), claim(BO, 2), retireBo])).toBe('inviter-not-seated');
  });

  it('an entry under a re-issued invitation is believed only as exactly the invitation it replaces, signed by a seat the directory holds', () => {
    const both = believedDirectory(CO, [claim(ADA, 1), claim(BO, 2)], LABEL, ACCOUNT);
    const retireBo = quorum(both, { kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 1 }, [ADA]);
    const afterBoLeft = [claim(ADA, 1), claim(BO, 2), retireBo];
    /* Dee's seat was proposed under Bo's invitation; Bo has left since, so it seats her no longer. */
    const bos = forDee({}, BO.signing.secret);
    expect(judged(deesWith(bos), afterBoLeft)).toBe('inviter-not-seated');
    const replacing = (o: SignedSeatInvitation) => ({ invitation: o.terms.invitation, signedBy: o.signedBy, signature: o.signature });
    /* Re-issued by the founding seat, for the same person, name, role and seat: believed. */
    expect(judged(deesWith(forDee({ invitation: sha('a re-issue for dee'), replaces: replacing(bos) })), afterBoLeft)).toBe('applied');
    /* RED WHEN: a re-issue gives the seat another role than the invitation it replaces, and the directory enters it at that role. */
    expect(judged(deesWith(forDee({ invitation: sha('a re-issue for dee'), role: 'viewer', replaces: replacing(bos) })), afterBoLeft)).toBe('not-the-invitation-it-replaces');
    /* RED WHEN: a re-issue names as replaced an invitation no seat of this company signed. */
    const strangers = forDee({}, newSigningKeypair().secret);
    expect(judged(deesWith(forDee({ invitation: sha('a re-issue for dee'), replaces: replacing(strangers) })), afterBoLeft)).toBe('not-the-invitation-it-replaces');
  });

  it('an entry whose invitation was signed by a seat whose role may not file a proposal is not believed', () => {
    const both = believedDirectory(CO, [claim(ADA, 1), claim(BO, 2)], LABEL, ACCOUNT);
    const boAViewer = quorum(both, { kind: 'role', seat: BO.seat, role: 'viewer', threshold: 1 }, [ADA]);
    expect(directoryReplayed(CO, [claim(ADA, 1), claim(BO, 2), boAViewer], LABEL, ACCOUNT).refused.size).toBe(0);
    /* RED WHEN: a viewer's seat seats somebody with an invitation it signs: only a seat whose role may file a proposal invites. */
    expect(judged(deesWith(forDee({}, BO.signing.secret)), [claim(ADA, 1), claim(BO, 2), boAViewer])).toBe('inviter-may-not-invite');
    /* The same invitation, signed by a seat whose role may file a proposal, is believed. */
    expect(judged(deesWith(forDee({}, BO.signing.secret)))).toBe('applied');
  });

  it('a seated member cannot enter their own seat under another invitee\'s person and link invitation', () => {
    /* Cy holds the viewing key, so he can read the invitation a link carried for Dee, which names no seat. */
    const deesLink = forDee({ leaf: undefined });
    const cyAsDee = entryFor({ ...CY, person: 'dee', signingSecret: CY.signing.secret, invited: deesLink });
    /* RED WHEN: an invitation that names no seat seats whichever seat files it, so Cy's seat is entered as Dee's. */
    expect(judged(cyAsDee)).toBe('invited-another-leaf');
    /* And Dee's own invitation, naming her seat, does not seat his. */
    expect(judged(entryFor({ ...CY, person: 'dee', signingSecret: CY.signing.secret, invited: forDee() }))).toBe('invited-another-leaf');
  });

  it('a seat is entered with the role its invitation gives, and the founding seat with none', () => {
    const replayed = directoryReplayed(CO, [claim(ADA, 1), claim(BO, 2), claimOf(deesWith(forDee({ role: 'viewer' })), 3)], LABEL, ACCOUNT);
    /* RED WHEN: an invited viewer is entered with no role, which files what an admin files. */
    expect(replayed.dir.seats.map((x) => [x.person, x.role])).toEqual([['ada', null], ['bo', 'admin'], ['dee', 'viewer']]);
  });

  it('an entry is believed only for the leaf its invitation names', () => {
    /* RED WHEN: a seat added from a code is entered at another leaf than the one its code carried. */
    expect(judged(deesWith(forDee({ leaf: CY.seat as Hex })))).toBe('invited-another-leaf');
    expect(judged(deesWith(forDee()))).toBe('applied');
  });
});

describe('AN ENTRY, AS A MEMBER\'S DEVICE BELIEVES IT: ITS PROOF OPENED, ITS WALLET\'S SIGNATURE CHECKED, AND ITS OPENING PROVING ITS KEY FOR ITS SEAT', () => {
  const chain = chainOf([ADA, BO]);
  const believed = (...filings: DirectoryFiling[]) => believedDirectory(CO, filings, LABEL, ACCOUNT).seats.map((x) => x.seat);

  it('a seat\'s entry is believed by the wallet key its leaf was made for, and holds that key and its opening', () => {
    const dir = believedDirectory(CO, [claim(ADA, 1)], LABEL, ACCOUNT, { approvals: 1, seatBar: 1, seats: [ADA.seat] });
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

  it('A DEVICE BELIEVES A RETIREMENT ONLY AT THE CHAIN\'S THRESHOLD NOW, SIGNED BY SEATS SEATED NOW OR THE LEAVER ITSELF, AND THEN UP TO ITS BOUNDARY', () => {
    const claims = [claim(ADA, 1), claim(BO, 2), claim(CY, 3)];
    const three = withAll([ADA, BO, CY]);
    /* Bo signs his own retirement, at a threshold of one, naming a boundary far ahead. */
    const selfSigned = quorum(three, { kind: 'retire', seat: BO.seat, filedUpTo: { [POOL]: 99 }, threshold: 1 }, [BO]);
    const now = { approvals: 2, seatBar: 2, seats: [ADA.seat, CY.seat] };
    const left = chainOf([ADA, CY], 2, [BO]).seats;
    const replayed = believedDirectory(CO, [...claims, selfSigned], LABEL, ACCOUNT, now);
    /* RED WHEN: a device believes a change at the threshold it names rather than the account's threshold now. */
    expect(replayed.seats.find((x) => x.seat === BO.seat)!.retired).toBeNull();
    expect(filingRefusalOf(replayed, left, BO.signing.publicKey, 'pool', POOL, 50)).toBe('seat-not-seated');
    /* RED WHEN: a change signed by a seat seated now, but at a lower threshold than the account's now, is believed. */
    const lowered = quorum(three, { kind: 'retire', seat: BO.seat, filedUpTo: { [POOL]: 99 }, threshold: 1 }, [ADA]);
    expect(believedDirectory(CO, [...claims, lowered], LABEL, ACCOUNT, now).seats.find((x) => x.seat === BO.seat)!.retired).toBeNull();
    /* RED WHEN: a change counted at the chain's threshold counts a seat that has left and that the change is not about. */
    const demoteCy = quorum(three, { kind: 'role', seat: CY.seat, role: 'viewer', threshold: 2 }, [ADA, BO]);
    expect(believedDirectory(CO, [...claims, demoteCy], LABEL, ACCOUNT, now).seats.find((x) => x.seat === CY.seat)!.role).toBe('admin');
    /* RED WHEN: the leaving seat's own signature on its retirement is not counted because the chain has already removed it. */
    const withBo = quorum(three, { kind: 'retire', seat: BO.seat, filedUpTo: { [POOL]: 99 }, threshold: 2 }, [ADA, BO]);
    expect(believedDirectory(CO, [...claims, withBo], LABEL, ACCOUNT, now).seats.find((x) => x.seat === BO.seat)!.retired).toEqual({ [POOL]: 99 });
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
    const left = believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, { approvals: 2, seatBar: 2, seats: [ADA.seat, CY.seat] });
    expect(left.seats.find((x) => x.seat === CY.seat)!.role).toBe('admin');
    /* An entry the server made up: Eve's wallet signs for Dan's seat, which the chain holds, with her own seat's opening. */
    const EVE = seatOf('eve', 9);
    const DAN = seatOf('dan', 8);
    const madeUp = entryFor({
      person: 'eve', committeeKey: EVE.committeeKey, opening: EVE.opening, signingSecret: EVE.signing.secret,
      statement: signDirectoryEntry(identityFromSecret(new Uint8Array(32).fill(9)), LABEL, ACCOUNT, new Uint8Array(32).fill(109), EVE.signing.publicKey, DAN.seat),
    });
    const withMadeUp: DirectoryFiling[] = [...claims, { company: CO, version: 4, change: { kind: 'claim', entry: madeUp } }];
    const demoteBy = (filings: readonly DirectoryFiling[]) => quorum(believedDirectory(CO, filings, LABEL, ACCOUNT), { kind: 'role', seat: ADA.seat, role: 'viewer', threshold: 1 }, [EVE]);
    const everyone = { approvals: 1, seatBar: 1, seats: [ADA.seat, BO.seat, CY.seat, DAN.seat, EVE.seat] };
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
    const now = { approvals: 2, seatBar: 2, seats: [ADA.seat, CY.seat] };
    const then = { approvals: 2, seatBar: 2, seats: [ADA.seat, BO.seat, CY.seat] };
    /* RED WHEN: a change the anchor holds is counted against who holds the account now - Bo, who signed it, has left. */
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, now, (v) => (v === 4 ? then : undefined))
      .seats.find((x) => x.seat === CY.seat)!.role).toBe('viewer');
    /* RED WHEN: a change anchored with nobody known to hold the account then is believed on the account now, or on anything. */
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, then, (v) => (v === 4 ? null : undefined))
      .seats.find((x) => x.seat === CY.seat)!.role).toBe('admin');
    /* RED WHEN: a claim a batch the fold cannot read may first name (null: not known) is believed on the account now. */
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, then, () => null).seats).toEqual([]);
  });

  it('AN ANCHORED CHANGE IS COUNTED AGAINST THE SEATS ITS BATCH NAMED, AND AN ANCHORED CLAIM BELIEVED BY ITS OPENING', () => {
    const claims = [claim(ADA, 1), claim(BO, 2), claim(CY, 3)];
    const three = withAll([ADA, BO, CY]);
    const promote = quorum(three, { kind: 'role', seat: CY.seat, role: 'viewer', threshold: 2 }, [ADA, BO]);
    /* Bo's seat is in the signer tree the batch named. */
    const anchored = { approvals: 2, seatBar: 2, seats: [ADA.seat, BO.seat, CY.seat] };
    const asAnchored = (v: number) => (v <= 4 ? anchored : undefined);
    /* RED WHEN: an anchored change's quorum is not counted over the seats its batch named: Bo's signature would not count, and the promotion is lost. */
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, undefined, asAnchored)
      .seats.find((x) => x.seat === CY.seat)!.role).toBe('viewer');
    /* RED WHEN: an anchored change counts a seat the signer tree its batch named did not hold. */
    const withoutBo = (v: number) => (v <= 3 ? anchored : v === 4 ? { ...anchored, seats: [ADA.seat, CY.seat] } : undefined);
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, undefined, withoutBo)
      .seats.find((x) => x.seat === CY.seat)!.role).toBe('admin');
    /* RED WHEN: an anchored change's floor of approvals is the account's now: the threshold rose to 3 after it was anchored at 2. */
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, { approvals: 3, seatBar: 3, seats: [ADA.seat, BO.seat, CY.seat] }, asAnchored)
      .seats.find((x) => x.seat === CY.seat)!.role).toBe('viewer');
    /* RED WHEN: an anchored change is not held to the approvals the account required as it was anchored: signed for 2, anchored at 3. */
    const atThree = (v: number) => (v <= 3 ? anchored : v === 4 ? { ...anchored, approvals: 3, seatBar: 3 } : undefined);
    expect(believedDirectory(CO, [...claims, promote], LABEL, ACCOUNT, undefined, atThree)
      .seats.find((x) => x.seat === CY.seat)!.role).toBe('admin');
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

describe('A DEMOTION OR A RETIREMENT IS HELD TO THE SEAT BAR: THE HIGHER OF THE THRESHOLD AND THE APPROVALS A POLICY CHANGE NEEDS', () => {
  /* Three seats at a threshold of two, the account storing a policy bar of three: a change of who is seated needs three. */
  const claims = [claim(ADA, 1), claim(BO, 2), claim(CY, 3)];
  const three = withAll([ADA, BO, CY], 2);
  const atTheBar: AccountHeld = { approvals: 2, seatBar: 3, seats: [ADA.seat, BO.seat, CY.seat] };
  const chain = chainOf([ADA, BO, CY], 2, [], 3);
  const demoteCy = { kind: 'role' as const, seat: CY.seat, role: 'viewer' as const, threshold: 2 };
  const retireCy = { kind: 'retire' as const, seat: CY.seat, filedUpTo: {}, threshold: 2 };
  /** What becomes of a change filed as version 4: judged against the account now, as the anchor holds it, on the chain's read, and at the service. */
  const now = (f: DirectoryFiling, held: AccountHeld = atTheBar) => directoryReplayed(CO, [...claims, f], LABEL, ACCOUNT, held).refused.get(4);
  const anchored = (f: DirectoryFiling, held: AccountHeld = atTheBar) =>
    directoryReplayed(CO, [...claims, f], LABEL, ACCOUNT, undefined, (v) => (v === 4 ? held : undefined)).refused.get(4);
  const onChain = (f: DirectoryFiling, read: ChainHolders = chain) => refusal(() => applyFiling(three, f, { label: LABEL, account: ACCOUNT, chain: read }));
  const atService = (f: DirectoryFiling, read: ChainHolders = chain) => refusal(() => atTheServer(three, f, { label: LABEL, account: ACCOUNT, chain: read }));

  it('AT THE ACCOUNT\'S THRESHOLD, BELOW A HIGHER POLICY BAR, NEITHER IS MADE: NOW, AS ANCHORED, ON THE CHAIN\'S READ, OR AT THE SERVICE', () => {
    for (const change of [demoteCy, retireCy]) {
      const f = quorum(three, change, [ADA, BO]);
      /* RED WHEN: a device judging against the account now holds a demotion or retirement to the threshold alone, below the stored policy bar. */
      expect(now(f)).toBe('threshold-not-the-chains');
      /* RED WHEN: a device judging an anchored version holds it to the threshold its header names, not the seat bar of the block it landed in. */
      expect(anchored(f)).toBe('threshold-not-the-chains');
      /* RED WHEN: a change judged on the chain's read is held to the threshold alone. */
      expect(onChain(f)).toBe('threshold-not-the-chains');
      /* RED WHEN: the service files a demotion or retirement signed below the seat bar its own read of the chain gives. */
      expect(atService(f)).toBe('threshold-not-the-chains');
    }
    /* At the seat bar, signed by that many seats, the demotion is made on every branch, and the service files it. */
    const atThree = quorum(three, { ...demoteCy, threshold: 3 }, [ADA, BO, CY]);
    expect([now(atThree), anchored(atThree), onChain(atThree), atService(atThree)]).toEqual([undefined, undefined, 'applied', 'applied']);
    /* A signed threshold above the seat bar is believed, as the chain counts any approvals at or above its bar. */
    expect(atService(quorum(three, { ...demoteCy, threshold: 3 }, [ADA]), chainOf([ADA, BO, CY], 2))).toBe('applied');
  });

  it('THE QUORUM IS COUNTED AGAINST THE SEAT BAR', () => {
    const f = quorum(three, { ...demoteCy, threshold: 3 }, [ADA, BO]);
    /* RED WHEN: a demotion signed by as many seats as the account's threshold is made where the seat bar is higher. */
    expect([now(f), anchored(f), onChain(f)]).toEqual(['below-quorum', 'below-quorum', 'below-quorum']);
  });

  it('NONE LEAVES FEWER SEATED SIGNERS THAN THE SEAT BAR: ON THE CHAIN\'S READ, AS ANCHORED, OR NOW', () => {
    const f = quorum(three, { ...retireCy, threshold: 3 }, [ADA, BO, CY]);
    /* RED WHEN: a device judging against the account now lets a retirement leave two seated under a seat bar of three. */
    expect(now(f)).toBe('leaves-too-few-signers');
    /* RED WHEN: a device judging an anchored retirement lets it leave fewer seated than the seat bar of the block it landed in. */
    expect(anchored(f)).toBe('leaves-too-few-signers');
    /* RED WHEN: a retirement judged on the chain's read leaves fewer seated than the seat bar. */
    expect(onChain(f)).toBe('leaves-too-few-signers');
    /* At the account's threshold alone, with no policy bar above it, each branch refuses the same. */
    const two: AccountHeld = { approvals: 2, seatBar: 2, seats: [ADA.seat, BO.seat] };
    const pair = withAll([ADA, BO], 2);
    const retireBo = quorum(pair, { kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 2 }, [ADA, BO]);
    const of = (held?: AccountHeld, asAnchored?: (v: number) => AccountHeld | undefined) =>
      directoryReplayed(CO, [claim(ADA, 1), claim(BO, 2), retireBo], LABEL, ACCOUNT, held, asAnchored).refused.get(3);
    /* RED WHEN: a device judging against the account now lets a retirement leave fewer seated than its threshold. */
    expect(of(two)).toBe('leaves-too-few-signers');
    /* RED WHEN: a device judging an anchored retirement lets it leave fewer seated than the threshold its batch was anchored at. */
    expect(of(undefined, (v) => (v === 3 ? two : undefined))).toBe('leaves-too-few-signers');
    expect(refusal(() => applyFiling(pair, retireBo, { label: LABEL, account: ACCOUNT, chain: chainOf([ADA, BO], 2) }))).toBe('leaves-too-few-signers');
    /*
     * Signed at three, judged where the seat bar is two and two stay: the chain removes the seat at its bar, so the
     * directory retires it too.
     */
    const atThreeOverTwo = quorum(three, { ...retireCy, threshold: 3 }, [ADA, BO, CY]);
    const barOfTwo: AccountHeld = { approvals: 2, seatBar: 2, seats: [ADA.seat, BO.seat, CY.seat] };
    /* RED WHEN: who stays is counted against the threshold the change was signed at rather than the seat bar, refusing a retirement the chain accepts. */
    expect(now(atThreeOverTwo, barOfTwo)).toBeUndefined();
    expect(anchored(atThreeOverTwo, barOfTwo)).toBeUndefined();
    expect(onChain(atThreeOverTwo, chainOf([ADA, BO, CY], 2))).toBe('applied');
    /*
     * Who stays is counted over the seats each branch reads, never the directory's own: Cy is believed in the directory
     * and off the account already, so retiring Bo would leave Ada alone under a seat bar of two.
     */
    const offTheChain: AccountHeld = { approvals: 2, seatBar: 2, seats: [ADA.seat, BO.seat] };
    const boOut = quorum(three, { kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 2 }, [ADA, BO]);
    /* RED WHEN: a device judging against the account now counts who stays over the directory's seats, not the account's now. */
    expect(now(boOut, offTheChain)).toBe('leaves-too-few-signers');
    /* RED WHEN: a device judging an anchored retirement counts who stays over the directory's seats, not those its batch named. */
    expect(anchored(boOut, offTheChain)).toBe('leaves-too-few-signers');
    /* RED WHEN: a retirement judged on the chain's read counts who stays over the directory's seats, not the chain's. */
    expect(onChain(boOut, chainOf([ADA, BO], 2, [CY]))).toBe('leaves-too-few-signers');
  });

  it('A READ OF THE ACCOUNT WITHOUT ITS SEAT BAR IS REFUSED, NEVER TAKEN AS NO BAR', () => {
    const f = quorum(three, demoteCy, [ADA, BO]);
    const { seatBar: _now, ...noBar } = atTheBar;
    const { seatBar: _chain, ...chainWithNoBar } = chain;
    const refused = /without the approvals a change of who is seated needs/;
    /* RED WHEN: a device judging against the account now takes a read with no seat bar as satisfied. */
    expect(() => now(f, noBar as AccountHeld)).toThrow(refused);
    /* RED WHEN: a device judging an anchored version takes a head with no seat bar as satisfied. */
    expect(() => anchored(f, noBar as AccountHeld)).toThrow(refused);
    /* RED WHEN: a change judged on, or filed by the service against, a chain read with no seat bar is taken as satisfied. */
    expect(() => onChain(f, chainWithNoBar as ChainHolders)).toThrow(refused);
    expect(() => atService(f, chainWithNoBar as ChainHolders)).toThrow(refused);
  });
});

describe('TO THE SIGNERS, A SEAT WHOSE WALLET KEY IS ON THE COMMITTEE IS A SIGNER LIKE ANY OTHER', () => {
  /* Every seat here has its wallet key on the account's committee as the chain holds it: each is a super admin there. */
  const committee = [ADA.committeeKey, BO.committeeKey, CY.committeeKey];
  const held = (approvals: number): ChainHolders => ({
    seats: { committee: committee.map((k) => ({ ...k })), threshold: 2, seats: [ADA.seat, BO.seat, CY.seat] }, approvals, seatBar: approvals,
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
    const now: AccountHeld = { approvals: 2, seatBar: 2, seats: [ADA.seat, BO.seat, CY.seat] };
    const replayed = directoryReplayed(CO, [claim(ADA, 1), claim(BO, 2), claim(CY, 3), demoteBo, retireCy], LABEL, ACCOUNT, now);
    expect([...replayed.refused]).toEqual([]);
    expect(replayed.dir.seats.map((x) => [x.person, x.role, x.retired])).toEqual([['ada', null, null], ['bo', 'viewer', null], ['cy', 'admin', {}]]);
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
  const both = { approvals: 1, seatBar: 1, seats: [ADA.seat, BO.seat] };
  /** A quorum's change signed by `signers` for `version`, filed at `version`, or filed again at `filedAt` under those signatures. */
  const signedFor = (version: number, change: Parameters<typeof quorum>[1], signers: readonly Seat[] = [ADA], filedAt?: number): DirectoryFiling => {
    const f = quorum({ ...emptyDirectory(CO), version: version - 1 }, change, signers, version);
    return filedAt === undefined ? f : { ...f, version: filedAt, signedAt: version };
  };
  const boApprover = { kind: 'role', seat: BO.seat, role: 'approver', threshold: 1 } as const;
  /** The replay of `filings`, versions in `passed` passed over by the company's records, against `now`. */
  const replay = (filings: readonly DirectoryFiling[], passed: readonly number[] = [], now: AccountHeld = both) =>
    directoryReplayed(CO, filings, LABEL, ACCOUNT, now, (v) => (passed.includes(v) ? null : undefined));
  const roleOf = (r: ReturnType<typeof replay>, s: Seat) => r.dir.seats.find((x) => x.seat === s.seat)?.role;

  it('A ROLE PASSED OVER, FILED AGAIN AS A NEW VERSION CARRYING THE VERSION ITS SIGNATURES WERE MADE FOR, IS APPLIED', () => {
    const r = replay([claim(ADA, 1), claim(BO, 2), signedFor(3, boApprover), signedFor(3, boApprover, [ADA], 4)], [3]);
    /* RED WHEN: the signatures of a change filed again are checked against the version it is filed at, or a change filed again is never believed. */
    expect(roleOf(r, BO)).toBe('approver');
    expect(r.refused.get(4)).toBeUndefined();
  });

  it('A DEMOTION LOST TO THE SERVICE IS FILED AGAIN WITH ITS ORIGINAL SIGNATURES, AND NOBODY SIGNS AGAIN', () => {
    const atTwo = { ...both, approvals: 2, seatBar: 2 };
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

  it('NOT YET ANCHORED, A CHANGE FILED AGAIN IS SIGNED AGAINST AT LEAST THE SEAT BAR NOW, AS THE SERVICE FILES IT; ANCHORED, AS ANY VERSION', () => {
    const two = { kind: 'role', seat: BO.seat, role: 'approver', threshold: 2 } as const;
    const filings = [claim(ADA, 1), claim(BO, 2), signedFor(3, two, [ADA, BO]), signedFor(3, two, [ADA, BO], 4)];
    /* RED WHEN: a change filed again signed by more seats than the seat bar now is refused, so a lost change is never made again. */
    expect(replay(filings, [3]).refused.get(4)).toBeUndefined();
    /* RED WHEN: a change filed again is held to the account's threshold alone, below the policy bar the account stores above it. */
    expect(replay(filings, [3], { ...both, seatBar: 3 }).refused.get(4)).toBe('threshold-not-the-chains');
    /* RED WHEN: an anchored change filed again is judged by the chain now - a later change of the account undoing it on every device. */
    const held = { approvals: 1, seatBar: 1, seats: [ADA.seat, BO.seat] };
    const anchored = directoryReplayed(CO, filings, LABEL, ACCOUNT, { ...both, seats: [ADA.seat] }, (v) => (v === 3 ? null : v === 4 ? held : undefined));
    expect(anchored.refused.get(4)).toBeUndefined();
    expect(anchored.dir.seats.find((x) => x.seat === BO.seat)?.role).toBe('approver');
  });

  describe('ON A DEVICE: WHAT IT FILES AGAIN, IN WHAT ORDER, AND WHAT IT HOLDS BACK', () => {
    const committee = [ADA.committeeKey, BO.committeeKey, CY.committeeKey];
    const adaAdmin = { kind: 'role', seat: ADA.seat, role: 'admin', threshold: 1 } as const;
    /** A device's read of `filings`, the company's records having anchored versions 1 and `last` and passed over those between. */
    const readOf = (filings: readonly DirectoryFiling[], last: number, leaves = leavesOfTheContract, founding: string | null = FOUNDING) => {
      const atAnchor = { approvals: 1, seatBar: 1, seats: [ADA.seat, CY.seat] };
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
        holders: async () => ({ account: ACCOUNT, seats: [ADA.seat, BO.seat, CY.seat], committee, approvals: 1, seatBar: 1, ...(founding === null ? {} : { founding }) }) as never,
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

    it('A DEVICE WHOSE WALLET NAMES NO FOUNDING SEAT BELIEVES NO ENTRY AT ALL', async () => {
      /* RED WHEN: with no founding seat read off the account, the first seat or the first entry is taken for it, so an uninvited entry is believed. */
      expect((await readOf([claim(ADA, 1), claim(BO, 2)], 2, leavesOfTheContract, null)).dir.seats).toEqual([]);
    });

    it('A CHANGE OF THE COMPANY\'S KEY PASSED OVER IS NOT OFFERED TO BE FILED AGAIN, WHILE THE RETIREMENT PASSED OVER WITH IT IS', async () => {
      const retireBo = { kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 1 } as const;
      const key = newSymmetricKey();
      const rotate = signedAsIs({ ...emptyDirectory(CO), version: 3 }, {
        kind: 'rotate', epoch: 1, keyCheck: keyCheckOf(CO, 1, key), after: 3,
        wraps: wrapsFor(key, [ADA].map((x) => ({ seat: x.seat, wrappingKey: x.statement.wrappingKey as Hex }))),
        previous: sealedPrevious(key, VIEWING), seed: { epoch: 1, sealed: sealedSeed(key, toHex(randomBytes(32))) }, waiting: [],
      }, [ADA], 4);
      /* Versions 2 to 4 - Bo's entry, his retirement and the change of key after it - are passed over by the records. */
      const filings = [claim(ADA, 1), claim(BO, 2), signedFor(3, retireBo, [ADA]), rotate, claim(CY, 5)];
      const here = await readOf(filings, 5);
      /* RED WHEN: a change of key passed over is offered to be filed again under its old signatures. */
      expect(here.notApplied?.map((n) => [n.signedAt, n.change.kind])).toEqual([[3, 'retire']]);
      expect(here.refiled!(here.notApplied!).filed.every((f) => f.change.kind !== 'rotate')).toBe(true);
      /* RED WHEN: a change of key passed over is said to be filed again. */
      const said = passedOverSaid(here)!;
      expect(said).toMatch(/versions 2, 3, 4 of its directory/u);
      expect(said).toMatch(/the change signed for version 3 is filed again/u);
      expect(said).not.toMatch(/version 3, 4 is filed again/u);
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
    const adaAlone = { approvals: 1, seatBar: 1, seats: [ADA.seat] };
    /* RED WHEN: a role is filed again for a seat the account no longer holds on chain. */
    expect(replay(filings, [3], adaAlone).refused.get(4)).toBe('not-as-the-chain-holds');
    const retireBo = { kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 1 } as const;
    const retiring = [claim(ADA, 1), claim(BO, 2), signedFor(3, retireBo), signedFor(3, retireBo, [ADA], 4)];
    /* RED WHEN: a retirement filed again is refused while its seat is still on the chain, which may remove the seat after it. */
    expect(replay(retiring, [3]).refused.get(4)).toBeUndefined();
    expect(replay(retiring, [3]).dir.seats.find((x) => x.seat === BO.seat)?.retired).toEqual({});
    /* RED WHEN: a retirement of a seat the chain no longer holds is refused. */
    expect(replay(retiring, [3], adaAlone).dir.seats.find((x) => x.seat === BO.seat)?.retired).toEqual({});
    /* RED WHEN: a retirement filed again, its seat on the chain or off it, is counted at the account's threshold below a higher policy bar. */
    expect(replay(retiring, [3], { ...both, seatBar: 2 }).refused.get(4)).toBe('threshold-not-the-chains');
    expect(replay(retiring, [3], { ...adaAlone, seatBar: 2 }).refused.get(4)).toBe('threshold-not-the-chains');
  });

  it('A RETIREMENT FILED AGAIN AFTER THE CHAIN REMOVED ITS SEAT COUNTS THE LEAVER\'S OWN SIGNATURE, AND NO OTHER SEAT OFF THE CHAIN', () => {
    /* Three seats at a seat bar of two; Bo and Cy approved Cy's removal and signed her retirement, and the chain removed her first. */
    const DAN = seatOf('dan', 8);
    const retireCy = { kind: 'retire', seat: CY.seat, filedUpTo: {}, threshold: 2 } as const;
    const claims = [claim(ADA, 1), claim(BO, 2), claim(CY, 3), claim(DAN, 4)];
    const afterRemoval: AccountHeld = { approvals: 2, seatBar: 2, seats: [ADA.seat, BO.seat] };
    const kept = [...claims, signedFor(5, retireCy, [BO, CY]), signedFor(5, retireCy, [BO, CY], 6)];
    const retiredOf = (r: ReturnType<typeof replay>) => r.dir.seats.find((x) => x.seat === CY.seat)?.retired;
    /* RED WHEN: the leaver's own signature on its retirement is not counted once the chain has removed its seat, so the kept retirement is below quorum for good. */
    expect(replay(kept, [5], afterRemoval).refused.get(6)).toBeUndefined();
    expect(retiredOf(replay(kept, [5], afterRemoval))).toEqual({});
    /* RED WHEN: the leaver's signature is not counted for a retirement anchored after the chain removed its seat. */
    const anchoredAfter = directoryReplayed(CO, kept, LABEL, ACCOUNT, afterRemoval, (v) => (v === 5 ? null : v === 6 ? afterRemoval : undefined));
    expect(anchoredAfter.refused.get(6)).toBeUndefined();
    expect(retiredOf(anchoredAfter)).toEqual({});
    /* RED WHEN: a seat off the chain that the change is not about counts towards its quorum. */
    const byDan = [...claims, signedFor(5, retireCy, [BO, DAN]), signedFor(5, retireCy, [BO, DAN], 6)];
    expect(replay(byDan, [5], afterRemoval).refused.get(6)).toBe('below-quorum');
  });
});

describe('A RETIRED SEAT GIVES UP ITS PERSON, WALLET AND RECORDS KEY, KEEPS ITS FILING KEY, AND ITS RETIREMENT KEEPS ITS OWN RECORDS-KEY STATEMENT', () => {
  /* Three seats at a seat bar of two; Bo leaves, with the last version of the pool he filed, version 3. */
  const POOL = vaultRecordKey('ab'.repeat(32), 'pool');
  const all = chainOf([ADA, BO, CY], 2);
  const three = withAll([ADA, BO, CY], 2);
  const retireBo = { kind: 'retire', seat: BO.seat, filedUpTo: { [POOL]: 3 }, threshold: 2 } as const;
  const boRetired = applyFiling(three, quorum(three, retireBo, [ADA, CY]), { label: LABEL, account: ACCOUNT, chain: all });
  /* Bo's own wallet at a new leaf, and Bo with a new wallet: who left, seated again. */
  const BO_AGAIN = seatOf('bo', 2, LABEL, 22);
  const BO_NEW_WALLET = seatOf('bo', 12);
  const claimOn = (dir: Directory, s: Seat | DirectoryEntry, seat = 'seat' in s ? s.seat : s.statement.seat) =>
    refusal(() => applyFiling(dir, claimOf('entry' in s ? s.entry : s, dir.version + 1), {
      label: LABEL, account: ACCOUNT, chain: { ...all, seats: { ...all.seats, seats: [ADA.seat, CY.seat, seat] } },
    }));
  /** An entry for a new leaf of `n`'s wallet, naming the records key made from `records` and the filing key `filing`. */
  const enteredWith = (n: number, leaf: number, records: number, filing: { secret: Hex; publicKey: Hex }): DirectoryEntry => {
    const identity = identityFromSecret(new Uint8Array(32).fill(n));
    const committeeKey = committeeKeyFor(identity, LABEL) as { tag: string; value: string };
    const { seat, opening } = seatOpenedFor(committeeKey, leaf);
    return entryFor({
      person: 'bo', committeeKey, opening, signingSecret: filing.secret,
      statement: signDirectoryEntry(identity, LABEL, ACCOUNT, new Uint8Array(32).fill(records), filing.publicKey, seat),
    });
  };
  const attested = (...seats: Seat[]) => seats.map((s) => ({ committeeKey: s.committeeKey, statement: s.records }));

  it('THE PERSON WHO LEFT IS SEATED AGAIN UNDER A NEW LEAF, WITH ANOTHER WALLET OR THE SAME ONE', () => {
    /* The control: while Bo holds his seat, neither claim is believed. */
    expect(claimOn(three, BO_NEW_WALLET)).toBe('person-has-a-seat');
    expect(claimOn(three, BO_AGAIN)).toBe('key-taken');
    /* RED WHEN: a retired seat still holds its person, so who left can never be seated again. */
    expect(claimOn(boRetired, BO_NEW_WALLET)).toBe('applied');
    /* RED WHEN: a retired seat still holds its records key: another wallet naming the same records key is refused. */
    expect(claimOn(boRetired, enteredWith(13, 23, 102, newSigningKeypair()))).toBe('applied');
    /* RED WHEN: a retired seat still holds its wallet or its records key, so the same wallet can never be seated again. */
    expect(claimOn(boRetired, BO_AGAIN)).toBe('applied');
    const again = applyFiling(boRetired, claim(BO_AGAIN, 5), { label: LABEL, account: ACCOUNT, chain: chainOf([ADA, CY, BO_AGAIN], 2, [BO]) });
    expect(again.seats.find((x) => x.seat === BO_AGAIN.seat)).toMatchObject({ person: 'bo', committeeKey: BO.committeeKey, retired: null });
    /* RED WHEN: seating the person again takes away the old seat's retirement, or judges the new seat's filings by the old seat's boundary. */
    expect(again.seats.find((x) => x.seat === BO.seat)!.retired).toEqual({ [POOL]: 3 });
    const now = chainOf([ADA, CY, BO_AGAIN], 2).seats;
    expect(filingRefusalOf(again, now, BO_AGAIN.signing.publicKey, 'pool', POOL, 4)).toBeNull();
    expect(filingRefusalOf(again, now, BO.signing.publicKey, 'pool', POOL, 4)).toBe('past-its-boundary');
  });

  it('A RETIRED SEAT KEEPS ITS FILING KEY: A NEW CLAIM REUSING IT IS REFUSED', () => {
    /* Bo's own wallet at a new leaf, filing under the key his retired seat filed under. */
    const reused = enteredWith(2, 24, 102, BO.signing);
    /* RED WHEN: a retired seat's filing key is released, so a new seat's versions would be judged as the retired seat's. */
    expect(claimOn(boRetired, reused)).toBe('key-taken');
  });

  it('A RETIRED SEAT KEEPS ITS LEAF: A CLAIM ON IT IS REFUSED, AND NO CHANGE NAMES IT AGAIN', () => {
    /* Bo's own wallet claims the very leaf it is leaving, under a new filing key, before the chain has removed it. */
    const filing = newSigningKeypair();
    const sameLeaf = entryFor({
      person: 'bo', committeeKey: BO.committeeKey, opening: BO.opening, signingSecret: filing.secret,
      statement: signDirectoryEntry(identityFromSecret(new Uint8Array(32).fill(2)), LABEL, ACCOUNT, new Uint8Array(32).fill(102), filing.publicKey, BO.seat),
    });
    /* RED WHEN: a retired seat's leaf is released, so the leaver's wallet enters it again and files past its boundary as a seat not retired. */
    expect(refusal(() => applyFiling(boRetired, claimOf(sameLeaf, 5), { label: LABEL, account: ACCOUNT, chain: all }))).toBe('seat-taken');
    const replayed = directoryReplayed(CO, [claim(ADA, 1), claim(BO, 2), claim(CY, 3), quorum(three, retireBo, [ADA, CY]), claimOf(sameLeaf, 5)], LABEL, ACCOUNT);
    expect(replayed.refused.get(5)).toBe('seat-taken');
    expect(replayed.dir.seats.filter((x) => x.seat === BO.seat).map((x) => [x.signingKey, x.retired])).toEqual([[BO.signing.publicKey, { [POOL]: 3 }]]);
    /* The control: a change naming the retired leaf is refused, as one about a retired seat. */
    expect(refusal(() => applyFiling(boRetired, quorum(boRetired, { kind: 'role', seat: BO.seat, role: 'viewer', threshold: 2 }, [ADA, CY]), { label: LABEL, account: ACCOUNT, chain: all })))
      .toBe('seat-retired');
  });

  it('A RETIRED SEAT\'S VERSIONS INSIDE ITS BOUNDARY STAY BELIEVED ONCE THE ROSTER DROPS IT, BY THE STATEMENT ITS RETIREMENT CARRIES', () => {
    /* The roster's next version has dropped Bo: it holds only Ada's and Cy's statements. */
    /* RED WHEN: a retired seat is judged by the roster's statements, which no longer hold its own, so its versions inside its boundary are refused. */
    expect([...seatsWithAnotherRecordsKey(boRetired, LABEL, ACCOUNT, attested(ADA, CY))]).toEqual([]);
    /* RED WHEN: while the roster and the retirement both hold a statement for the leaver, the roster's is read and not the retirement's. */
    const otherKey = signRecordsKey(identityFromSecret(new Uint8Array(32).fill(2)), LABEL, ACCOUNT, new Uint8Array(32).fill(55), BO.seat);
    expect([...seatsWithAnotherRecordsKey(boRetired, LABEL, ACCOUNT, [...attested(ADA, CY), { committeeKey: BO.committeeKey, statement: otherKey }])]).toEqual([]);
    /* RED WHEN: a retirement carrying a stale statement the leaver's own wallet once signed, naming another records key than its entry, is believed. */
    expect(refusal(() => applyFiling(three, quorum(three, { ...retireBo, statement: otherKey }, [ADA, CY]), { label: LABEL, account: ACCOUNT, chain: all })))
      .toBe('statement-not-the-leavers');
    /* RED WHEN: a retired seat whose kept statement names another records key than its entry is believed for its versions. */
    const otherKeyKept = { ...boRetired, seats: boRetired.seats.map((x) => (x.seat === BO.seat ? { ...x, retiredStatement: otherKey } : x)) };
    expect([...seatsWithAnotherRecordsKey(otherKeyKept, LABEL, ACCOUNT, attested(ADA, BO, CY))]).toEqual([BO.seat]);
    const left = chainOf([ADA, CY], 2, [BO]).seats;
    /* RED WHEN: a version inside the boundary is refused once the chain has removed the seat. */
    expect(filingRefusalOf(boRetired, left, BO.signing.publicKey, 'pool', POOL, 3)).toBeNull();
    /* RED WHEN: a version past the boundary is believed. */
    expect(filingRefusalOf(boRetired, left, BO.signing.publicKey, 'pool', POOL, 4)).toBe('past-its-boundary');
  });

  it('A RETIREMENT WITH NO STATEMENT RETIRES THE SEAT, AND NOTHING IT FILED IS BELIEVED; ONE THAT CARRIES ANOTHER\'S IS REFUSED', () => {
    const { statement: _none, ...bare } = quorum(three, retireBo, [ADA, CY]).change as Extract<DirectoryChange, { kind: 'retire' }>;
    const without = signedAsIs(three, { ...bare, signatures: undefined }, [ADA, CY]);
    /* RED WHEN: a retirement carrying no statement keeps its seat from being retired, on a device or at the service. */
    const retired = applyFiling(three, without, { label: LABEL, account: ACCOUNT, chain: all });
    expect(retired.seats.find((x) => x.seat === BO.seat)!.retired).toEqual({ [POOL]: 3 });
    expect(refusal(() => atTheServer(three, without, { label: LABEL, account: ACCOUNT, chain: all }))).toBe('applied');
    /* RED WHEN: a seat retired with no statement has its versions inside the boundary believed. */
    expect(retired.seats.find((x) => x.seat === BO.seat)!.retiredStatement).toBeUndefined();
    expect([...seatsWithAnotherRecordsKey(retired, LABEL, ACCOUNT, attested(ADA, BO, CY))]).toEqual([BO.seat]);
    /* RED WHEN: a seat whose entry never proved a wallet key cannot be retired. */
    const unproved = { ...three, seats: three.seats.map((x) => (x.seat === BO.seat ? { ...x, committeeKey: undefined } : x)) };
    expect(refusal(() => applyFiling(unproved, without, { label: LABEL, account: ACCOUNT, chain: all }))).toBe('applied');
    /* The control: a statement carried by such a seat's retirement is still held to a wallet its entry proved, and there is none. */
    expect(refusal(() => applyFiling(unproved, quorum(three, retireBo, [ADA, CY]), { label: LABEL, account: ACCOUNT, chain: all })))
      .toBe('statement-not-the-leavers');
    /* RED WHEN: a statement for another seat is carried by a retirement, on a device or at the service. */
    const forCy = quorum(three, { ...retireBo, statement: CY.records }, [ADA, CY]);
    expect(refusal(() => applyFiling(three, forCy, { label: LABEL, account: ACCOUNT, chain: all }))).toBe('statement-not-the-leavers');
    expect(refusal(() => atTheServer(three, forCy, { label: LABEL, account: ACCOUNT, chain: all }))).toBe('statement-not-the-leavers');
    /* Ada's wallet signs a statement for Bo's seat, naming Bo's records key. */
    const notBos = quorum(three, { ...retireBo, statement: signRecordsKey(identityFromSecret(new Uint8Array(32).fill(1)), LABEL, ACCOUNT, new Uint8Array(32).fill(102), BO.seat) }, [ADA, CY]);
    /* RED WHEN: a statement not signed by the leaving seat's own wallet is believed on a device. */
    expect(refusal(() => applyFiling(three, notBos, { label: LABEL, account: ACCOUNT, chain: all }))).toBe('statement-not-the-leavers');
    /* The service holds no seat's wallet key and checks the shape alone; a device judges whose wallet signed it. */
    expect(refusal(() => atTheServer(three, notBos, { label: LABEL, account: ACCOUNT, chain: all }))).toBe('applied');
    /* RED WHEN: the leaver's own statement is not kept with its retirement. */
    expect(boRetired.seats.find((x) => x.seat === BO.seat)!.retiredStatement).toEqual(BO.records);
  });

  it('THE STATEMENT A RETIREMENT CARRIES IS TAKEN FROM THE ROSTER AS THE LEAVER\'S OWN WALLET SIGNED IT', () => {
    const bo = three.seats.find((x) => x.seat === BO.seat)!;
    const taken = leaversStatementIn(attested(ADA, BO, CY), bo, LABEL, ACCOUNT);
    /* RED WHEN: the statement taken is not the one the leaver's own wallet signed for its seat. */
    expect(taken).toEqual(BO.records);
    expect(applyFiling(three, quorum(three, { ...retireBo, statement: taken! }, [ADA, CY]), { label: LABEL, account: ACCOUNT, chain: all })
      .seats.find((x) => x.seat === BO.seat)!.retiredStatement).toEqual(BO.records);
    /* RED WHEN: a statement another wallet signed for the seat, or one naming another records key, is taken for the retirement. */
    const notBos = signRecordsKey(identityFromSecret(new Uint8Array(32).fill(1)), LABEL, ACCOUNT, new Uint8Array(32).fill(102), BO.seat);
    expect(leaversStatementIn([...attested(ADA, CY), { committeeKey: BO.committeeKey, statement: notBos }], bo, LABEL, ACCOUNT)).toBeNull();
    const otherKey = signRecordsKey(identityFromSecret(new Uint8Array(32).fill(2)), LABEL, ACCOUNT, new Uint8Array(32).fill(55), BO.seat);
    expect(leaversStatementIn([...attested(ADA, BO, CY), { committeeKey: BO.committeeKey, statement: otherKey }], bo, LABEL, ACCOUNT)).toBeNull();
    /* RED WHEN: a seat already retired is given a statement for a second retirement. */
    expect(leaversStatementIn(attested(ADA, BO, CY), boRetired.seats.find((x) => x.seat === BO.seat)!, LABEL, ACCOUNT)).toBeNull();
  });

  it('A SEAT RETIRED BUT STILL ON THE CHAIN IS NOT COUNTED AS STAYING', () => {
    /* Cy is retired and the chain has not removed her yet; Bo's retirement would leave Ada alone, below the bar of two. */
    const retireCy = { kind: 'retire', seat: CY.seat, filedUpTo: {}, threshold: 2 } as const;
    const cyRetired = applyFiling(three, quorum(three, retireCy, [ADA, BO]), { label: LABEL, account: ACCOUNT, chain: all });
    const boOut = quorum(cyRetired, retireBo, [ADA, BO]);
    /* RED WHEN: a seat the directory retired, still on the chain, counts as staying, so a second retirement leaves fewer than the bar. */
    expect(refusal(() => applyFiling(cyRetired, boOut, { label: LABEL, account: ACCOUNT, chain: all }))).toBe('leaves-too-few-signers');
    const filings = [claim(ADA, 1), claim(BO, 2), claim(CY, 3), quorum(three, retireCy, [ADA, BO]), boOut];
    const held: AccountHeld = { approvals: 2, seatBar: 2, seats: [ADA.seat, BO.seat, CY.seat] };
    expect(directoryReplayed(CO, filings, LABEL, ACCOUNT, held).refused.get(5)).toBe('leaves-too-few-signers');
    expect(directoryReplayed(CO, filings, LABEL, ACCOUNT, undefined, () => held).refused.get(5)).toBe('leaves-too-few-signers');
    /* The control: with a fourth seat staying, the same retirement is made. */
    const DAN = seatOf('dan', 8);
    const withDan = chainOf([ADA, BO, CY, DAN], 2);
    const four = applyFiling(three, claim(DAN, 4), { label: LABEL, account: ACCOUNT, chain: withDan });
    const cyOut = applyFiling(four, quorum(four, retireCy, [ADA, BO]), { label: LABEL, account: ACCOUNT, chain: withDan });
    expect(applyFiling(cyOut, quorum(cyOut, retireBo, [ADA, BO]), { label: LABEL, account: ACCOUNT, chain: withDan })
      .seats.find((x) => x.seat === BO.seat)!.retired).toEqual({ [POOL]: 3 });
  });
});

describe('A CHANGE OF THE COMPANY\'S KEY: FILED BY ONE SEAT AFTER A RETIREMENT, AND BELIEVED ONLY AS THE DIRECTORY SHOWS IT WHOLE', () => {
  const three = withAll([ADA, BO, CY]);
  const everyone = chainOf([ADA, BO, CY]);
  /* Cy retired at version 4 by Ada at the bar of one, and taken off the chain. */
  const retired = applyFiling(three, quorum(three, { kind: 'retire', seat: CY.seat, filedUpTo: {}, threshold: 1 }, [ADA]), { label: LABEL, account: ACCOUNT, chain: everyone });
  const stayed = chainOf([ADA, BO]);
  const onDevice = (chain: ChainHolders | null = stayed) => ({ label: LABEL, account: ACCOUNT, chain });
  /** A change of key as a staying seat's device makes it: wrapped to `seats`, after `after`, with a new seed unless a case gives another. */
  const rotation = (dir: Directory, o: {
    epoch?: number; after?: number; seats?: readonly Seat[]; by?: Seat; key?: Hex; previous?: Hex;
    seed?: { epoch: number; sealed: Sealed } | null; repairs?: number; replaces?: number | string; waiting?: readonly Hex[];
  } = {}, version = dir.version + 1): DirectoryFiling => {
    const epoch = o.epoch ?? ((dir.rotations ?? []).slice(-1)[0]?.epoch ?? 0) + 1;
    const key = o.key ?? newSymmetricKey();
    const seats = o.seats ?? [ADA, BO];
    const seed = o.seed === null ? undefined : o.seed ?? { epoch, sealed: sealedSeed(key, toHex(randomBytes(32))) };
    return signedAsIs(dir, {
      kind: 'rotate', epoch, keyCheck: keyCheckOf(CO, epoch, key), after: o.after ?? 4,
      wraps: wrapsFor(key, seats.map((x) => ({ seat: x.seat, wrappingKey: x.statement.wrappingKey as Hex }))),
      previous: sealedPrevious(key, o.previous ?? VIEWING), waiting: o.waiting ?? [],
      ...(seed === undefined ? {} : { seed }), ...(o.repairs === undefined ? {} : { repairs: o.repairs }),
      ...(o.replaces === undefined ? {} : { replaces: o.replaces }),
    }, [o.by ?? ADA], version);
  };

  it('a change of key after a retirement is believed, at the next epoch, recording the retirement it follows', () => {
    expect(retired.seats.find((x) => x.seat === CY.seat)!.retiredAt).toBe(4);
    const r = rotation(retired);
    const after = applyFiling(retired, r, onDevice());
    expect(after.version).toBe(5);
    expect(after.rotations?.map((x) => [x.version, x.epoch, x.after, x.keyCheck])).toEqual([[5, 1, 4, (r.change as { keyCheck: Hex }).keyCheck]]);
    /* Replayed from every filing against the account now, the same change of key is believed. */
    const filings = [claim(ADA, 1), claim(BO, 2), claim(CY, 3), quorum(three, { kind: 'retire', seat: CY.seat, filedUpTo: {}, threshold: 1 }, [ADA]), r];
    const replayed = directoryReplayed(CO, filings, LABEL, ACCOUNT, { approvals: 1, seatBar: 1, seats: [ADA.seat, BO.seat] });
    expect(replayed.refused.size).toBe(0);
    expect(replayed.dir.rotations?.map((x) => x.epoch)).toEqual([1]);
    /* RED WHEN: the epoch step is unchecked, so a change of key can skip an epoch or name one already used. */
    expect(refusal(() => applyFiling(retired, rotation(retired, { epoch: 2 }), onDevice()))).toBe('not-the-next-epoch');
    expect(refusal(() => applyFiling(after, rotation(after, { epoch: 1, after: 4 }), onDevice()))).toBe('not-the-next-epoch');
    /* RED WHEN: `after` is unchecked, so a change of key names a retirement other than the newest. */
    expect(refusal(() => applyFiling(retired, rotation(retired, { after: 3 }), onDevice()))).toBe('no-retirement-since');
    /* RED WHEN: the wrap set is unchecked: a change of key leaving out a staying seat, wrapping the retired one, or one seat twice. */
    expect(refusal(() => applyFiling(retired, rotation(retired, { seats: [ADA] }), onDevice()))).toBe('wraps-not-the-seats');
    expect(refusal(() => applyFiling(retired, rotation(retired, { seats: [ADA, BO, CY] }), onDevice()))).toBe('wraps-not-the-seats');
    expect(refusal(() => applyFiling(retired, rotation(retired, { seats: [ADA, ADA] }), onDevice()))).toBe('wraps-not-the-seats');
  });

  it('a change of key filed by a retired seat, a viewer, a seat off the chain, a stranger, or with no retirement since the key last changed, is not believed', () => {
    /* RED WHEN: a retired seat may change the key it was removed from. */
    expect(refusal(() => applyFiling(retired, rotation(retired, { by: CY }), onDevice(everyone)))).toBe('seat-retired');
    /* RED WHEN: a seat the account no longer holds changes the key. */
    expect(refusal(() => applyFiling(retired, rotation(retired, { by: BO }), onDevice(chainOf([ADA]))))).toBe('filer-not-seated');
    expect(refusal(() => applyFiling(retired, rotation(retired, { by: BO }), { label: LABEL, account: ACCOUNT, chain: null, now: { approvals: 1, seatBar: 1, seats: [ADA.seat] } }))).toBe('filer-not-seated');
    /* RED WHEN: a key the directory holds no seat for changes the key. */
    expect(refusal(() => applyFiling(retired, rotation(retired, { by: seatOf('mal', 7) }), onDevice()))).toBe('filer-not-seated');
    /* Bo made a viewer at version 4, then Cy retired at version 5. */
    const boViewer = applyFiling(three, quorum(three, { kind: 'role', seat: BO.seat, role: 'viewer', threshold: 1 }, [ADA]), onDevice(everyone));
    const cyOut = applyFiling(boViewer, quorum(boViewer, { kind: 'retire', seat: CY.seat, filedUpTo: {}, threshold: 1 }, [ADA]), onDevice(everyone));
    /* RED WHEN: a seat whose role may not file a proposal changes the key. */
    expect(refusal(() => applyFiling(cyOut, rotation(cyOut, { by: BO, after: 5 }), onDevice()))).toBe('filer-may-not-rotate');
    expect(applyFiling(cyOut, rotation(cyOut, { by: ADA, after: 5 }), onDevice()).rotations).toHaveLength(1);
    /* RED WHEN: the key changes with no retirement filed since it last changed, or with none at all. */
    const once = applyFiling(retired, rotation(retired), onDevice());
    expect(refusal(() => applyFiling(once, rotation(once, { after: 4 }), onDevice()))).toBe('no-retirement-since');
    expect(refusal(() => applyFiling(three, rotation(three, { seats: [ADA, BO, CY], after: 3 }), onDevice(everyone)))).toBe('no-retirement-since');
  });

  it('a change of key carries one seed of its own epoch, 32 bytes, not a copy of an earlier one, and names each waiting answer once', () => {
    const key = newSymmetricKey();
    /* RED WHEN: a seed sealed for another epoch is taken for this one. */
    expect(refusal(() => applyFiling(retired, rotation(retired, { key, seed: { epoch: 2, sealed: sealedSeed(key, toHex(randomBytes(32))) } }), onDevice()))).toBe('seed-not-its-own');
    /* RED WHEN: a seed of another length is taken, which would weaken every payment made with it. */
    expect(refusal(() => applyFiling(retired, rotation(retired, { key, seed: { epoch: 1, sealed: seal(toHex(randomBytes(16)), key) } }), onDevice()))).toBe('seed-not-its-own');
    /* RED WHEN: a change of key that is no repair carries no new seed. */
    expect(refusal(() => applyFiling(retired, rotation(retired, { seed: null }), onDevice()))).toBe('seed-not-its-own');
    /* Bo retired too, at version 6; the key changes a second time, for Ada alone. */
    const r1 = rotation(retired);
    const once = applyFiling(retired, r1, onDevice());
    const boOut = applyFiling(once, quorum(once, { kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 1 }, [ADA]), onDevice());
    const earlier = (r1.change as { seed: { epoch: number; sealed: Sealed } }).seed;
    /* RED WHEN: a change of key may carry the seed an earlier one did, so two epochs pay from one seed. */
    expect(refusal(() => applyFiling(boOut, rotation(boOut, { seats: [ADA], after: 6, seed: { epoch: 2, sealed: earlier.sealed } }), onDevice(chainOf([ADA]))))).toBe('seed-not-its-own');
    expect(applyFiling(boOut, rotation(boOut, { seats: [ADA], after: 6 }), onDevice(chainOf([ADA]))).rotations?.map((x) => x.epoch)).toEqual([1, 2]);
    /* RED WHEN: the waiting answers are unchecked: one named twice, or one that is no digest. */
    const d = 'd1'.repeat(32) as Hex;
    expect(refusal(() => applyFiling(retired, rotation(retired, { waiting: [d, d] }), onDevice()))).toBe('not-a-change');
    expect(refusal(() => applyFiling(retired, rotation(retired, { waiting: ['zz' as Hex] }), onDevice()))).toBe('not-a-change');
    expect(applyFiling(retired, rotation(retired, { waiting: [d, 'd2'.repeat(32) as Hex] }), onDevice()).rotations).toHaveLength(1);
  });

  it('a repair of the newest key is believed with no new retirement and no seed, and a repair of any other is not', () => {
    const k1 = newSymmetricKey();
    const once = applyFiling(retired, rotation(retired, { key: k1 }), onDevice());
    /* RED WHEN: a repair is held to the retirement rule, so a key whose copies did not open can never be replaced. */
    const repaired = applyFiling(once, rotation(once, { repairs: 1, seed: null, previous: k1 }), onDevice());
    expect(repaired.rotations?.map((x) => [x.epoch, x.repairs ?? null, x.after])).toEqual([[1, null, 4], [2, 1, 4]]);
    /* RED WHEN: a repair may carry a new seed, or name a key other than the newest. */
    expect(refusal(() => applyFiling(once, rotation(once, { repairs: 1, previous: k1 }), onDevice()))).toBe('not-a-repair');
    expect(refusal(() => applyFiling(repaired, rotation(repaired, { repairs: 1, seed: null }), onDevice()))).toBe('not-a-repair');
    expect(refusal(() => applyFiling(retired, rotation(retired, { repairs: 1, seed: null }), onDevice()))).toBe('not-a-repair');
    /* RED WHEN: a repair may follow another retirement than the key it repairs. */
    expect(refusal(() => applyFiling(once, rotation(once, { repairs: 1, seed: null, after: 3 }), onDevice()))).toBe('no-retirement-since');
    /* Bo retired at version 6, after the key last changed: his leaving waits for a change of key with a new seed. */
    const boRetire = quorum(once, { kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 1 }, [ADA]);
    const boOut = applyFiling(once, boRetire, onDevice());
    const repairNow = rotation(boOut, { repairs: 1, seed: null, previous: k1, seats: [ADA] });
    /* RED WHEN: a repair is believed while a retirement waits for its change of key, so the leaver keeps the newest seed. */
    expect(refusal(() => applyFiling(boOut, repairNow, onDevice(chainOf([ADA]))))).toBe('no-retirement-since');
    /* Replayed with the repair refused at 7, the change of key Bo's leaving needs is still believed at 8. */
    const r1 = rotation(retired, { key: k1 }, 5);
    const filings = [claim(ADA, 1), claim(BO, 2), claim(CY, 3), quorum(three, { kind: 'retire', seat: CY.seat, filedUpTo: {}, threshold: 1 }, [ADA]), r1,
      boRetire, repairNow, rotation(boOut, { seats: [ADA], after: 6 }, 8)];
    const replayed = directoryReplayed(CO, filings, LABEL, ACCOUNT, { approvals: 1, seatBar: 1, seats: [ADA.seat] });
    expect(replayed.refused.get(7)).toBe('no-retirement-since');
    expect(replayed.refused.has(8)).toBe(false);
    expect(replayed.dir.rotations?.map((x) => [x.version, x.epoch, x.after, x.seed === undefined ? 'no seed' : 'seed'])).toEqual([[5, 1, 4, 'seed'], [8, 2, 6, 'seed']]);
    /* A repair is still wrapped to exactly the seats not retired. */
    expect(refusal(() => applyFiling(once, rotation(once, { repairs: 1, seed: null, seats: [ADA] }), onDevice()))).toBe('wraps-not-the-seats');
  });

  it('a change of key that replaces an older key than the newest is believed only once every newer change\'s filer is retired and off the chain', () => {
    const k1 = newSymmetricKey();
    /* Bo changed the key at version 5, then was retired at version 6. */
    const byBo = applyFiling(retired, rotation(retired, { by: BO, key: k1 }), onDevice());
    const retireBo = quorum(byBo, { kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 1 }, [ADA]);
    const boOut = applyFiling(byBo, retireBo, onDevice());
    const fromZero = rotation(boOut, { seats: [ADA], after: 6, replaces: 0 });
    /* RED WHEN: a seat that does not hold the newest key cannot change the key once the seat that changed it is removed. */
    const after = applyFiling(boOut, fromZero, onDevice(chainOf([ADA])));
    expect(after.rotations?.map((x) => [x.epoch, x.replaces ?? null, x.by])).toEqual([[1, null, BO.seat], [2, 0, ADA.seat]]);
    /* RED WHEN: it is believed while the account still holds the seat that made the change it passes over. */
    expect(refusal(() => applyFiling(boOut, fromZero, onDevice(stayed)))).toBe('replaces-a-change-still-held');
    expect(refusal(() => applyFiling(boOut, fromZero, { label: LABEL, account: ACCOUNT, chain: null, now: { approvals: 1, seatBar: 1, seats: [ADA.seat, BO.seat] } }))).toBe('replaces-a-change-still-held');
    /* RED WHEN: it is believed when the change it passes over was made by a seat that stays. */
    const byAda = applyFiling(retired, rotation(retired, { key: k1 }), onDevice());
    const boOutAfterAda = applyFiling(byAda, quorum(byAda, { kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 1 }, [ADA]), onDevice());
    expect(refusal(() => applyFiling(boOutAfterAda, rotation(boOutAfterAda, { seats: [ADA], after: 6, replaces: 0 }), onDevice(chainOf([ADA]))))).toBe('replaces-a-change-still-held');
    /* Dan seated too; Cy retired at 5; Bo changed the key at 6; Dan retired at 7; Bo is off the chain and never retired. */
    const DAN = seatOf('dan', 8);
    const all4 = chainOf([ADA, BO, CY, DAN]);
    const four = applyFiling(three, claim(DAN, 4), { label: LABEL, account: ACCOUNT, chain: all4 });
    const cyOut4 = applyFiling(four, quorum(four, { kind: 'retire', seat: CY.seat, filedUpTo: {}, threshold: 1 }, [ADA]), onDevice(all4));
    const boChanged = applyFiling(cyOut4, rotation(cyOut4, { by: BO, seats: [ADA, BO, DAN], after: 5 }), onDevice(chainOf([ADA, BO, DAN])));
    const danOut = applyFiling(boChanged, quorum(boChanged, { kind: 'retire', seat: DAN.seat, filedUpTo: {}, threshold: 1 }, [ADA]), onDevice(chainOf([ADA, BO, DAN])));
    /* RED WHEN: it is believed when the change it passes over was filed by a seat off the chain whose retirement the directory never took. */
    expect(refusal(() => applyFiling(danOut, rotation(danOut, { seats: [ADA, BO], after: 7, replaces: 0 }), onDevice(chainOf([ADA]))))).toBe('replaces-a-change-still-held');
    /* RED WHEN: it may name the newest key, a key not yet made, or be a repair: each is a looser form than the one ruled. */
    expect(refusal(() => applyFiling(boOut, rotation(boOut, { seats: [ADA], after: 6, replaces: 1 }), onDevice(chainOf([ADA]))))).toBe('not-the-next-epoch');
    expect(refusal(() => applyFiling(boOut, rotation(boOut, { seats: [ADA], after: 6, replaces: 2 }), onDevice(chainOf([ADA]))))).toBe('not-the-next-epoch');
    expect(refusal(() => applyFiling(boOut, rotation(boOut, { seats: [ADA], after: 6, replaces: 0, repairs: 1, seed: null }), onDevice(chainOf([ADA]))))).toBe('not-the-next-epoch');
    /* RED WHEN: a replaced epoch that is no whole number from 0 is taken. */
    expect(refusal(() => applyFiling(boOut, rotation(boOut, { seats: [ADA], after: 6, replaces: -1 }), onDevice(chainOf([ADA]))))).toBe('not-a-change');
    expect(refusal(() => applyFiling(boOut, rotation(boOut, { seats: [ADA], after: 6, replaces: '0' }), onDevice(chainOf([ADA]))))).toBe('not-a-change');
    /* RED WHEN: it skips the other rules of a change of key: it still follows a retirement, and carries a new seed. */
    expect(refusal(() => applyFiling(boOut, rotation(boOut, { seats: [ADA], after: 4, replaces: 0 }), onDevice(chainOf([ADA]))))).toBe('no-retirement-since');
    expect(refusal(() => applyFiling(boOut, rotation(boOut, { seats: [ADA], after: 6, replaces: 0, seed: null }), onDevice(chainOf([ADA]))))).toBe('seed-not-its-own');
    /* Replayed from every filing as each version was anchored (Bo held until version 7), the change from epoch 0 is believed at 7. */
    const filings = [claim(ADA, 1), claim(BO, 2), claim(CY, 3), quorum(three, { kind: 'retire', seat: CY.seat, filedUpTo: {}, threshold: 1 }, [ADA]),
      rotation(retired, { by: BO, key: k1 }, 5), retireBo, fromZero];
    const replayed = directoryReplayed(CO, filings, LABEL, ACCOUNT, undefined,
      (v: number) => ({ approvals: 1, seatBar: 1, seats: v < 7 ? [ADA.seat, BO.seat] : [ADA.seat] }));
    expect([...replayed.refused]).toEqual([]);
    expect(replayed.dir.rotations?.map((x) => [x.version, x.epoch, x.replaces ?? null])).toEqual([[5, 1, null], [7, 2, 0]]);
  });

  it('a change of key is never filed again under the signatures of an earlier version', () => {
    const r = rotation(retired, {}, 5);
    const again: DirectoryFiling = { ...r, version: 6, signedAt: 5 };
    /* RED WHEN: a change of key passed over may be filed again under its old signatures. */
    expect(refusal(() => applyFiling({ ...retired, version: 5 }, again, onDevice()))).toBe('not-a-change');
    expect(refusal(() => atTheServer({ ...retired, version: 5 }, again, onDevice()))).toBe('not-a-change');
  });

  it('a seat sealed under a later company key is believed from the list of keys this device holds', () => {
    const later = newSymmetricKey();
    const DEE = seatOf('dee', 9);
    const deesLater = entryFor({ person: 'dee', committeeKey: DEE.committeeKey, statement: DEE.statement, opening: DEE.opening, signingSecret: DEE.signing.secret, viewingKey: later });
    const filings = [claim(ADA, 1), claim(BO, 2), claimOf(deesLater, 3)];
    const both = asAMember(proofsOpenedWith(CO, [VIEWING, later]), leafOfTheContract, FOUNDING);
    /* RED WHEN: only the first key is tried, so a seat seated after the key changed is never believed. */
    expect(believedWith(CO, filings, LABEL, ACCOUNT, both).seats.map((x) => x.person)).toEqual(['ada', 'bo', 'dee']);
    /* Holding the earlier key alone, the device cannot open it. */
    expect(replayedWith(CO, filings, LABEL, ACCOUNT, asMember()).refused.get(3)).toBe('entry-not-opened');
  });
});

describe('A DEVICE THAT READS THE DIRECTORY AGAIN REPLAYS ONLY WHAT FOLLOWS THE NEWEST VERSION ANCHORED', () => {
  const atAnchor = { approvals: 1, seatBar: 1, seats: [ADA.seat, BO.seat] };
  const holders = { seats: [ADA.seat, BO.seat], approvals: 1, signerRoot: '00'.repeat(32) as Hex, signers: [ADA.seat as Hex, BO.seat as Hex] };
  const retireBo = (version: number) => quorum({ ...emptyDirectory(CO), version: version - 1 }, { kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 1 }, [ADA], version);
  /* A change of the company's key that skips an epoch: filed, and refused by every device. */
  const skippedEpoch = (version: number) => {
    const key = newSymmetricKey();
    return signedAsIs({ ...emptyDirectory(CO), version: version - 1 }, {
      kind: 'rotate', epoch: 2, keyCheck: keyCheckOf(CO, 2, key), after: 3,
      wraps: wrapsFor(key, [ADA].map((x) => ({ seat: x.seat, wrappingKey: x.statement.wrappingKey as Hex }))),
      previous: sealedPrevious(key, VIEWING), seed: { epoch: 2, sealed: sealedSeed(key, toHex(randomBytes(32))) }, waiting: [],
    }, [ADA], version);
  };
  const FILINGS = [claim(ADA, 1), claim(BO, 2), retireBo(3), skippedEpoch(4), claim(CY, 5)];
  /** A device's read of `filings`, the company's records anchoring versions 1 to `anchored` as `anchors` names them. */
  const readWith = (
    filings: readonly DirectoryFiling[], anchored: number, kept?: DirectoryReplaysKept,
    o: {
      anchors?: readonly DirectoryFiling[]; given?: (d: unknown) => void; heldAt?: (v: number) => AccountHeld;
      leaves?: typeof leavesOfTheContract; founding?: string | null; viewingKey?: Hex;
    } = {},
  ) => {
    const anchors = o.anchors ?? filings;
    const leaf = (v: number) => ({ version: v, digest: directoryEntry(anchors[v - 1]!).digest, filedBy: ADA.signing.publicKey, batch: 0, dirVersion: v });
    const versions = Array.from({ length: anchored }, (_, i) => i + 1);
    const records = {
      head: '11'.repeat(32), reached: GENESIS, stopped: null, asked: { records: new Set<string>(), kinds: new Set<string>() },
      history: new Map([[recordKeyOf(DIRECTORY), versions.map(leaf)]]), notYetAnchored: [],
      directory: new Map(versions.map((v) => [v, { digest: leaf(v).digest, batch: 0, held: holders }])),
      held: (v: number) => (v <= anchored ? o.heldAt?.(v) ?? atAnchor : undefined),
    } as unknown as RecordsHeldHere;
    return directoryWithItsRecordsHere({
      accountId: CO, label: LABEL, viewingKey: o.viewingKey ?? VIEWING, filings: async () => filings, attested: async () => [], leaves: o.leaves ?? leavesOfTheContract,
      anchored: async (d: unknown) => { o.given?.(d); return records; },
      holders: async () => ({ account: ACCOUNT, seats: [ADA.seat, BO.seat, CY.seat], committee: [ADA.committeeKey, BO.committeeKey, CY.committeeKey], approvals: 1, seatBar: 1, ...(o.founding === null ? {} : { founding: o.founding ?? FOUNDING }) }) as never,
      ...(kept === undefined ? {} : { kept }),
    } as never);
  };
  /** A store that keeps nothing: every read replays from version 1, as a full replay. */
  const keepsNothing: DirectoryReplaysKept = { longest: () => null, keep: () => {} };
  /** What a read answers: the directory, what it refused, what it would file again, and the directory at each version. */
  const answers = (here: Awaited<ReturnType<typeof readWith>>) => ({
    dir: here.dir, refusedAt: [...here.refusedAt!], notApplied: here.notApplied, refiledRefused: here.refiledRefused,
    anchoredAgain: [...here.anchoredAgain!], passedOver: here.passedOver,
    refiled: here.refiled!(here.notApplied!).filed,
    at: Array.from({ length: here.dir.version + 2 }, (_, v) => here.at(v)),
    atAsServed: Array.from({ length: here.dir.version + 1 }, (_, v) => here.at(v, () => undefined)?.dir),
  });

  it('A READ GOING ON FROM WHAT IT KEPT ANSWERS AS A FULL REPLAY, A REFUSED CHANGE OF THE KEY AMONG THE VERSIONS KEPT', async () => {
    const full = answers(await readWith(FILINGS, 4, keepsNothing));
    expect(full.refusedAt).toContain(4);
    expect(full.dir.seats.find((x) => x.seat === BO.seat)?.retired).not.toBeNull();
    const kept = directoryReplaysInMemory();
    let found = 0;
    const counted: DirectoryReplaysKept = { longest: (c, j, m) => { const k = kept.longest(c, j, m); if (k !== null) found += 1; return k; }, keep: kept.keep };
    await readWith(FILINGS, 4, counted);
    const before = found;
    const again = answers(await readWith(FILINGS, 4, counted));
    /* RED WHEN: a read never looks for a replay it kept, so every read replays the whole directory again. */
    expect(found).toBeGreaterThan(before);
    /* RED WHEN: a replay kept loses what it refused, applied or passed over, so a read going on from it answers otherwise. */
    expect(again).toEqual(full);
  });

  it('A READ REPLAYS NOTHING AT OR BELOW THE NEWEST VERSION ANCHORED THAT IT KEPT, AND APPLIES EVERY FILING ABOVE IT', async () => {
    const kept = directoryReplaysInMemory();
    await readWith(FILINGS, 4, kept);
    /* A mark only a kept replay carries: a seat no filing names, put in every replay kept. */
    const marked = { seat: 'ab'.repeat(32), person: 'kept', signingKey: 'cd'.repeat(32) as Hex, wrappingKey: 'ef'.repeat(32) as Hex, role: null, retired: null };
    const marking: DirectoryReplaysKept = {
      longest: (c, j, m) => {
        const k = kept.longest(c, j, m);
        return k === null ? null : { ...k, state: { ...k.state, dir: { ...k.state.dir, seats: [...k.state.dir.seats, marked] } } };
      },
      keep: () => {},
    };
    let given: { dir: Directory } | undefined;
    const here = await readWith(FILINGS, 4, marking, { given: (d) => { given = d as { dir: Directory }; } });
    /* RED WHEN: a filing at or below the newest version anchored is replayed again although a replay of it was kept. */
    expect(here.dir.seats.map((x) => x.seat)).toContain(marked.seat);
    /* RED WHEN: the directory as served, before the records are read, is replayed again although nothing in it changed. */
    expect(given!.dir.seats.map((x) => x.seat)).toContain(marked.seat);
    /* RED WHEN: a filing above the newest version anchored is answered from the kept replay instead of applied. */
    expect(here.dir.seats.map((x) => x.seat)).toContain(CY.seat);
    expect(here.dir.version).toBe(5);
  });

  it('A DIRECTORY SERVED WITH OTHER BYTES AT A VERSION KEPT IS NEVER ANSWERED FROM WHAT WAS KEPT', async () => {
    const kept = directoryReplaysInMemory();
    await readWith(FILINGS, 4, kept);
    /* Version 3 makes Bo an approver instead of retiring him, and the records anchor those bytes; every entry is the same. */
    const boApprover = quorum({ ...emptyDirectory(CO), version: 2 }, { kind: 'role', seat: BO.seat, role: 'approver', threshold: 1 }, [ADA], 3);
    const other = [FILINGS[0]!, FILINGS[1]!, boApprover, ...FILINGS.slice(3)];
    const full = answers(await readWith(other, 4, keepsNothing));
    expect(full.dir.seats.find((x) => x.seat === BO.seat)).toMatchObject({ role: 'approver', retired: null });
    /* RED WHEN: a replay kept is gone on from for a version served with other bytes, so the directory holds a change nobody filed. */
    expect(answers(await readWith(other, 4, kept))).toEqual(full);
  });

  it('A VERSION ANCHORED UNDER OTHER HOLDERS IS NEVER ANSWERED FROM A REPLAY KEPT UNDER THE FIRST', async () => {
    const kept = directoryReplaysInMemory();
    await readWith(FILINGS, 4, kept);
    /* From version 3 the records name an account needing two approvals: Ada alone could not retire Bo. */
    const two = { o: { heldAt: (v: number) => (v >= 3 ? { approvals: 2, seatBar: 2, seats: [ADA.seat, BO.seat] } : atAnchor) } };
    const full = answers(await readWith(FILINGS, 4, keepsNothing, two.o));
    expect(full.refusedAt).toContain(3);
    /* RED WHEN: who held the account as each version was anchored is left out of what a kept replay is matched by. */
    expect(answers(await readWith(FILINGS, 4, kept, two.o))).toEqual(full);
    /* Versions 3 and 4 not anchored: judged against the chain now, never as a kept replay judged them as anchored. */
    expect(answers(await readWith(FILINGS, 2, kept))).toEqual(answers(await readWith(FILINGS, 2, keepsNothing)));
  });

  it('A JUDGE GIVEN OTHER LEAVES, OTHER KEYS OR NO FOUNDING SEAT IS NEVER ANSWERED FROM A REPLAY KEPT UNDER THE FIRST', async () => {
    const kept = directoryReplaysInMemory();
    await readWith(FILINGS, 4, kept);
    /* The worker says Bo's opening makes Ada's leaf. */
    const crossed = async (os: readonly SeatOpening[]) => os.map((o) => (o.publicKey === BO.opening.publicKey ? ADA.seat : leafOfTheContract(o)));
    /* RED WHEN: the leaf this device worked out for an entry's opening is left out of what a kept replay is matched by. */
    expect(answers(await readWith(FILINGS, 4, kept, { leaves: crossed }))).toEqual(answers(await readWith(FILINGS, 4, keepsNothing, { leaves: crossed })));
    /* RED WHEN: the founding seat the wallet read is left out of what a kept replay is matched by, so an uninvited entry is believed. */
    expect((await readWith(FILINGS, 4, kept, { founding: null })).dir.seats).toEqual([]);
    /* RED WHEN: the keys this device opens entries with are left out of what a kept replay is matched by. */
    expect((await readWith(FILINGS, 4, kept, { viewingKey: '6f'.repeat(32) as Hex })).dir.seats).toEqual([]);
  });

  it('AT EVERY VERSION, A READ GOING ON FROM WHAT IT KEPT ANSWERS AS THE DIRECTORY REPLAYED FROM VERSION 1', async () => {
    const kept = directoryReplaysInMemory();
    const heldAt = (v: number) => (v >= 3 ? { approvals: 2, seatBar: 2, seats: [ADA.seat, BO.seat] } : atAnchor);
    await readWith(FILINGS, 4, kept, { heldAt });
    const here = await readWith(FILINGS, 4, kept, { heldAt });
    const now = { approvals: 1, seatBar: 1, seats: [ADA.seat, BO.seat, CY.seat] };
    const asAnchored = (v: number) => (v <= 4 ? heldAt(v) : undefined);
    /* RED WHEN: a read answers otherwise than the directory replayed from version 1 against who held the account as each was anchored. */
    expect(here.dir).toEqual(believedDirectory(CO, FILINGS, LABEL, ACCOUNT, now, asAnchored));
    for (let v = 0; v <= FILINGS.length; v += 1) {
      /* RED WHEN: the directory at an earlier version is not the first `v` filings replayed, or is answered for another version. */
      expect(here.at(v)?.dir, `version ${v}`).toEqual(believedDirectory(CO, FILINGS.slice(0, v), LABEL, ACCOUNT, now, asAnchored));
      /* RED WHEN: the directory at a version judged against the chain now is answered as judged against the records, or the other way. */
      expect(here.at(v, () => undefined)?.dir, `version ${v} as served`).toEqual(believedDirectory(CO, FILINGS.slice(0, v), LABEL, ACCOUNT, now));
      expect(here.at(v)?.digests).toEqual(FILINGS.slice(0, v).map((f) => directoryEntry(f).digest));
    }
    expect(here.at(FILINGS.length + 1)).toBeNull();
    expect(here.at(-1)).toBeNull();
  });

  it('A DIRECTORY SERVED SHORT OF A VERSION THE RECORDS ANCHOR STILL THROWS AFTER A READ OF IT WAS KEPT', async () => {
    const kept = directoryReplaysInMemory();
    await readWith(FILINGS, 4, kept);
    /* RED WHEN: a read answers from a replay kept of the whole directory while the service withholds a version the records anchor. */
    await expect(readWith(FILINGS.slice(0, 3), 4, kept, { anchors: FILINGS })).rejects.toThrow(/served without version 4, which the company's records anchor/u);
    /* RED WHEN: a version served with other bytes than the records anchor is believed from what was kept. */
    await expect(readWith([...FILINGS.slice(0, 3), retireBo(4)], 4, kept, { anchors: FILINGS })).rejects.toThrow(/served with other bytes at version 4/u);
  });
});
