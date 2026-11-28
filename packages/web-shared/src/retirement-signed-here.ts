/**
 * **THE RETIREMENT OF A LEAVING SIGNER'S SEAT: ITS TERMS, THE SIGNATURES OVER
 * IT, AND ITS FILING IN THE COMPANY'S DIRECTORY.**
 *
 * A retirement keeps exactly the last version of each record the leaving signer
 * filed, as the anchored records held them at a recent head, so what they filed
 * stays readable and nothing they file after it is taken. Signatures are
 * believed only from seats in the directory, over the directory version they
 * are signed for, and the retirement is filed only once enough are gathered.
 */
import { boundaryKeyOfEntry, type ManifestEntryBody } from '../../../src/midnight/record-manifest.js';
import type { RoundOnChain } from './governed-call-builder.js';
import { sign, signingPublicKeyOf, verify, type Hex } from '../../../src/core/crypto.js';
import type { RetirementSignature } from '../../../src/core/types.js';
import type { RetirementTerms } from '../../../src/core/proposal-filing.js';
import { directoryChangeMessage, type DirectorySeat, type SignedChange } from '../../../src/midnight/seat-directory.js';
import { COMPANY_RECORD_KINDS, WIRE_RECORDS } from '../../../src/midnight/sealed-record-wire.js';
import type { RecordsAsked } from '../../../src/midnight/records-held.js';
import { removalBoundaryRefusal } from './spending-policy-here.js';
import { directoryNotYetAnchored, type DirectoryHere } from './vault-page-doors.js';
import { filerHere } from './governed-call-on-device.js';
import type { RemovalDoors } from './signer-removed-on-device.js';

/** The retirement signatures one device keeps for each removal it signed or read. */
export interface RetirementSignaturesKept {
  keep(company: string, proposalId: string, signatures: readonly RetirementSignature[]): Promise<void>;
  all(company: string, proposalId: string): Promise<readonly RetirementSignature[]>;
}

/** A removal's retirement is not yet signed by enough seats for the directory version next now. Nothing was sent to the chain. */
export class RetirementNotYetSigned extends Error {
  constructor(
    readonly signed: number,
    readonly needed: number
  ) {
    super(
      `the retirement of the leaving seat is signed by ${signed} of the ${needed} seats it needs for the company's directory as it ` +
        'stands now, so the removal is not carried out on the chain yet. Nothing was sent. Each signer who approved it opens the ' +
        'removal again on their own device, which signs the retirement again.'
    );
    this.name = 'RetirementNotYetSigned';
  }
}

/** Every record a seat may have filed, asked of the company's records, with every entry not yet anchored. */
export const EVERY_RECORD_ASKED: RecordsAsked = Object.freeze({
  kinds: [
    ...COMPANY_RECORD_KINDS.map((kind) => ({ store: 'company' as const, kind })),
    ...WIRE_RECORDS.map((kind) => ({ store: 'vault' as const, kind })),
    { store: 'run' as const, kind: 'run' },
    { store: 'proposal' as const, kind: 'proposal' }
  ],
  everyPending: true
});

/**
 * **THE LAST VERSION OF EACH RECORD `filer` FILED**, of every kind, as the
 * anchor holds the company's records for this read: the boundary a retirement
 * keeps, past which nothing that seat filed is believed. A version entered and
 * not yet anchored is not counted: it is anchored first (`leaversPendingIn`).
 * Given `atSeq`, the batch the anchored head a removal's raise names left,
 * only the versions anchored at or before it are counted: the boundary signed
 * at the raise is final: what the seat files after it counts toward no
 * approval, is not anchored by a device told of the raise
 * (`AnchorDoors.leaving`), and is believed by no device once the retirement
 * is anchored.
 */
const lastVersionsFiledBy = (here: DirectoryHere, filer: string, atSeq?: number): Record<string, number> => {
  const key = filer.toLowerCase();
  const out: Record<string, number> = {};
  const counted = (store: string, kind: string, id: string, version: number): void => {
    if (store === 'directory') return;
    const at = boundaryKeyOfEntry({ store, kind, id, version, digest: '' } as unknown as ManifestEntryBody);
    out[at] = Math.max(out[at] ?? 0, version);
  };
  for (const [recordKey, versions] of here.records.history) {
    const [store, kind] = recordKey.split(':', 2) as [string, string];
    const id = recordKey.slice(store.length + kind.length + 2);
    for (const v of versions)
      if (v.filedBy.toLowerCase() === key && (atSeq === undefined || v.batch <= atSeq))
        counted(store, kind, id, v.version);
  }
  return out;
};

/** How many versions `filer` entered that the anchor does not hold yet, as this read sees them. */
export const leaversPendingIn = (here: DirectoryHere, filer: string): number =>
  here.records.notYetAnchored.filter(
    (e) => e.store !== 'directory' && e.filedBy.publicKey.toLowerCase() === filer.toLowerCase()
  ).length;

/** Whether two boundaries name the same records at the same versions, no more and no fewer. */
const sameBoundary = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};

/** A removal's retirement as the directory holds it, signatures aside. */
const retirementOf = (leaf: string, terms: RetirementTerms) => ({
  kind: 'retire' as const,
  seat: leaf,
  filedUpTo: { ...terms.filedUpTo },
  ...(terms.statement === undefined ? {} : { statement: { ...terms.statement } }),
  threshold: terms.threshold
});

/** The text every seat signs for a removal's retirement at directory version `version`. */
const retirementMessage = (company: string, version: number, leaf: string, terms: RetirementTerms): string =>
  directoryChangeMessage(company, version, { ...retirementOf(leaf, terms), signatures: [] } as SignedChange);

const sameStatement = (a: RetirementTerms['statement'], b: RetirementTerms['statement']): boolean =>
  a === undefined
    ? b === undefined
    : b !== undefined &&
      a.recordsKey.toLowerCase() === b.recordsKey.toLowerCase() &&
      a.seat.toLowerCase() === b.seat.toLowerCase() &&
      a.signature.toLowerCase() === b.signature.toLowerCase();

/**
 * The retirement terms this device would raise for `seat` now: its last versions as the anchored head this read reached
 * holds them, that head, its statement where one counts, the seat bar.
 */
export const retirementTermsHere = async (
  doors: RemovalDoors,
  here: DirectoryHere,
  seat: DirectorySeat
): Promise<RetirementTerms> => {
  const statement = await doors.leaversStatement(seat);
  return {
    filedUpTo: lastVersionsFiledBy(here, seat.signingKey),
    atHead: here.records.reached.head,
    threshold: here.holders.seatBar,
    ...(statement === null
      ? {}
      : { statement: { recordsKey: statement.recordsKey, seat: statement.seat, signature: statement.signature } })
  };
};

/**
 * **WHY THIS DEVICE WILL NOT RAISE, APPROVE OR CARRY OUT THIS REMOVAL, OR NULL.**
 * Read from the company's records and the chain as the person's own wallet
 * reads them now, never from the service:
 * - a removal of another seat is in flight - its retirement in the directory,
 *   its seat still on the chain - so two removals never leave the company
 *   short of the approvals a change of who is seated needs;
 * - a seat the directory holds an entry for is removed only with its
 *   retirement, and a leaf it holds none for only without one;
 * - the retirement is signed at least at the seat bar now;
 * - where this device's roster holds the leaving seat's own statement, the
 *   retirement carries exactly that statement, so the records it filed stay
 *   readable to the signers who stay;
 * - the retirement keeps every spending policy version the leaving seat filed
 *   (`removalBoundaryRefusal`).
 * Before a raise (`raised` false) the boundary is judged over everything the
 * leaving seat filed, and a version of theirs not yet anchored holds the raise
 * until it is. At an approval or the carrying out it is judged over what was
 * anchored at the head the raise names (`RetirementTerms.atHead`), which this
 * device must have checked itself: the boundary signed at the raise is final,
 * and what the leaving seat anchors after that head - before the raise lands
 * or after - voids nothing. That head must also be recent at the raise
 * (`anchoredHeadHere`, against `raise`, the proposal as the chain holds it).
 */
export const removalRefusalHere = async (
  doors: RemovalDoors,
  here: DirectoryHere,
  leaf: string,
  terms: RetirementTerms | undefined,
  raised = false,
  raise?: RaiseRead
): Promise<string | null> => {
  const inFlight = here.dir.seats.find(
    (x) => x.seat !== leaf && x.retired !== null && here.holders.seats.includes(x.seat)
  );
  if (inFlight !== undefined) {
    return (
      "another signer's removal is under way: their seat is retired in the company's directory and the chain still holds it. " +
      'Finish that removal first, then this one'
    );
  }
  const seat = here.dir.seats.find((x) => x.seat === leaf);
  if (seat === undefined) {
    return terms === undefined
      ? null
      : "this removal carries a retirement for a seat the company's directory holds no entry for";
  }
  if (seat.retired !== null) return null;
  if (terms === undefined)
    return "this removal carries no retirement for a seat the company's directory holds an entry for";
  if (terms.threshold < here.holders.seatBar) {
    return `its retirement is signed at ${terms.threshold} approvals, below the ${here.holders.seatBar} a change of who is seated needs now`;
  }
  const statement = await doors.leaversStatement(seat);
  if (statement !== null && !sameStatement(terms.statement, statement)) {
    return (
      "its retirement leaves out, or changes, the records-key statement the leaving signer's own wallet signed, so what they " +
      'filed could not be read once they leave'
    );
  }
  if (!raised && leaversPendingIn(here, seat.signingKey) > 0) {
    return (
      "the leaving signer has filed versions the company's records do not anchor yet, and a retirement is judged only over " +
      'what is anchored. Open the company on the device of a seat that may anchor, which anchors them, then try again'
    );
  }
  const atSeq = raised ? anchoredHeadHere(here, terms, raise) : undefined;
  if (typeof atSeq === 'string') return atSeq;
  if (!sameBoundary(terms.filedUpTo, lastVersionsFiledBy(here, seat.signingKey, atSeq))) {
    return (
      'its retirement does not keep exactly the last version of each record the leaving signer filed, as the anchored records ' +
      'held them at the head the removal was raised over: a boundary below one would leave it unread, and one above would let ' +
      'them file after they leave. Withdraw this removal and raise it again'
    );
  }
  return removalBoundaryRefusal(
    here,
    seat.signingKey,
    terms.filedUpTo,
    atSeq === undefined ? undefined : (batch) => batch <= atSeq
  );
};

/**
 * **HOW OLD THE HEAD A REMOVAL'S RAISE NAMES MAY BE, IN BLOCK TIME, IN
 * MILLISECONDS.** A raise naming a head older than the newest that landed at
 * least this long before the raise's own block is refused, so a raiser cannot
 * pick an old head whose boundary leaves out what the leaving seat filed since.
 */
export const RECENT_HEAD_WINDOW = 10 * 60 * 1000;

/** The proposal a removal's raise made, as the account's history at the wallet's indexer holds it; `no-history` where this page reads none. */
export type RaiseRead = RoundOnChain | 'no-history' | undefined;

/** Why how recent a raise's head is cannot be judged here, each saying what resolves it. */
const RECENT_HEAD_UNJUDGED = {
  raiseNotRead:
    'its raise was not read from the indexer your wallet names, so how recent the head it names is cannot be judged. ' +
    'Read the chain again in a moment, then try again',
  noHistory:
    "this page cannot read the account's history at the indexer your wallet names, so how recent the head its raise " +
    'names is cannot be judged. Reload the page to get the current version, then try again',
  checkedShort:
    "this device has not checked the company's records as far as the newest head that landed ten minutes or more " +
    'before its raise, so how recent the head it names is cannot be judged here. Open the company again on this device so it ' +
    'checks its records further, or approve from a device that has'
} as const;

/**
 * The batch the anchored head a removal's raise names (`RetirementTerms.atHead`) left, as this device checked the
 * company's records itself; or why it cannot be judged, in words that say what resolves it. The head must not be older
 * than the newest head that landed `RECENT_HEAD_WINDOW` or more before the block the raise landed in. Both times are
 * the blocks' own, read from the history of the account at the wallet's indexer, never from the service: the raise's
 * from `raise` (`roundsOnChain`), the heads' from `newestLandedBy`. A raise not read there, a page that reads no
 * history, and a reference head this device did not check each refuse with what resolves them (`RECENT_HEAD_UNJUDGED`);
 * a raise the indexer gave no block time for is raised again.
 */
const anchoredHeadHere = (here: DirectoryHere, terms: RetirementTerms, raise: RaiseRead): number | string => {
  if (terms.atHead === undefined) {
    return (
      'its retirement does not name the anchored head its boundary was taken at, so what the leaving signer had filed by then ' +
      'cannot be said. Withdraw this removal and raise it again'
    );
  }
  const seq = here.records.seqOfHead?.(terms.atHead) ?? null;
  if (seq === null) {
    return (
      "its retirement names an anchored head this device has not checked in the company's records, so its boundary cannot be " +
      "judged here. Check the company's records on this device from its first header, or approve from a device that has; " +
      "a head the company's records never held is refused on every device"
    );
  }
  if (raise === 'no-history') return RECENT_HEAD_UNJUDGED.noHistory;
  const at = raise?.raisedAt;
  if (at === undefined) return RECENT_HEAD_UNJUDGED.raiseNotRead;
  if (!Number.isSafeInteger(at) || at <= 0) {
    return (
      'the indexer your wallet names gave no time for the block its raise landed in, so how recent the head it names is ' +
      'cannot be judged. The signer who raised it withdraws it and raises this removal again'
    );
  }
  const newest = here.records.newestLandedBy?.(at - RECENT_HEAD_WINDOW) ?? 'unread';
  if (newest === 'unread') return RECENT_HEAD_UNJUDGED.checkedShort;
  if (newest !== 'none' && seq < newest.seq) {
    return (
      `its retirement names an anchored head older than one the company's records held ${RECENT_HEAD_WINDOW / 60_000} minutes ` +
      'or more before the raise landed, so its boundary could leave out what the leaving signer filed since. The signer who ' +
      'raised it withdraws it and raises this removal again'
    );
  }
  return seq;
};

/** This seat's signature over the retirement at the directory version next now, or none where this seat does not sign. */
export const retirementSignedHere = (
  doors: RemovalDoors,
  here: DirectoryHere,
  leaf: string,
  terms: RetirementTerms
): RetirementSignature | undefined => {
  const mine = signingPublicKeyOf(doors.material.signingSecret as Hex);
  if (!here.dir.seats.some((x) => x.signingKey === mine && x.retired === null)) return undefined;
  const signedFor = here.dir.version + 1;
  return {
    signedFor,
    publicKey: mine,
    signature: sign(retirementMessage(doors.accountId, signedFor, leaf, terms), doors.material.signingSecret as Hex)
  };
};

/** The removal's proposal as the service keeps it: the retirement signatures each approving seat sent beside it. */
const signaturesServed = async (doors: RemovalDoors, proposalId: string): Promise<readonly RetirementSignature[]> => {
  const served = (await doors.service.sealedProposals?.(doors.accountId)) ?? [];
  return served.find((p) => p.id === proposalId && p.accountId === doors.accountId)?.retirementSignatures ?? [];
};

/**
 * **THE SIGNATURES OVER A RETIREMENT THIS DEVICE BELIEVES**, for directory
 * version `signedFor`: each by a seat the directory holds and has not retired,
 * or by the leaving seat itself, verifying over exactly these terms; one per
 * seat. The service only keeps them, so each is checked here.
 */
const signaturesBelieved = (
  doors: RemovalDoors,
  here: DirectoryHere,
  leaf: string,
  terms: RetirementTerms,
  signedFor: number,
  given: readonly RetirementSignature[]
): { publicKey: Hex; signature: Hex }[] => {
  const message = retirementMessage(doors.accountId, signedFor, leaf, terms);
  const out = new Map<string, { publicKey: Hex; signature: Hex }>();
  for (const g of given) {
    const key = String(g?.publicKey ?? '').toLowerCase();
    if (g?.signedFor !== signedFor || out.has(key) || !/^[0-9a-f]{128}$/u.test(String(g.signature))) continue;
    if (!here.dir.seats.some((x) => x.signingKey === key && (x.retired === null || x.seat === leaf))) continue;
    if (!verify(message, g.signature, key as Hex)) continue;
    out.set(key, { publicKey: key as Hex, signature: g.signature });
  }
  return [...out.values()];
};

/**
 * **THE RETIREMENT FILED AND ANCHORED, OR REFUSED, BEFORE ANYTHING ELSE.**
 * The signatures this device believes for the directory version next now are
 * gathered from those the service keeps beside the proposal, and this seat
 * signs again where its own is missing; once they reach the quorum, the full
 * retirement is kept on this device and filed and anchored at once. Refused,
 * with nothing sent to the chain, while too few have signed, or while the
 * filed retirement is not anchored.
 */
export const retirementFiledHere = async (
  doors: RemovalDoors,
  proposalId: string | null,
  leaf: string,
  terms: RetirementTerms,
  others: readonly RetirementSignature[] = []
): Promise<void> => {
  if (doors.directoryChange === undefined) {
    throw new Error(
      "This page cannot file a retirement in the company's directory, so it carries out no removal. Reload the page to get " +
        'the current version. Anything this press already sent may have gone through and stands; nothing more is sent.'
    );
  }
  const records = doors.records!;
  const here = await records.directory(EVERY_RECORD_ASKED);
  const signedFor = here.dir.version + 1;
  const kept = ((await doors.kept?.all(doors.accountId)) ?? []).filter(
    (k) => k.signedAt === signedFor && k.change.kind === 'retire' && k.change.seat === leaf
  );
  const served = proposalId === null ? [] : await signaturesServed(doors, proposalId);
  let given = [
    ...others,
    ...served,
    ...(proposalId === null ? [] : await signaturesKeptHere(doors, proposalId)),
    ...kept.flatMap((k) =>
      k.change.signatures.map((x) => ({ signedFor, publicKey: x.publicKey, signature: x.signature }))
    )
  ];
  const mine = retirementSignedHere(doors, here, leaf, terms);
  if (
    mine !== undefined &&
    !signaturesBelieved(doors, here, leaf, terms, signedFor, given).some((x) => x.publicKey === mine.publicKey)
  ) {
    if (proposalId !== null) await doors.service.retire?.(proposalId, { signature: mine, filer: filerHere(doors) });
    given = [...given, mine];
  }
  const believed = signaturesBelieved(doors, here, leaf, terms, signedFor, given);
  if (proposalId !== null)
    await keepSignaturesHere(
      doors,
      proposalId,
      believed.map((x) => ({ signedFor, ...x }))
    );
  const needed = Math.max(terms.threshold, here.holders.seatBar);
  if (believed.length < needed) throw new RetirementNotYetSigned(believed.length, needed);
  const change = { ...retirementOf(leaf, terms), signatures: believed } as SignedChange;
  await doors.kept?.keep(doors.accountId, { signedAt: signedFor, change });
  await doors.directoryChange(change, signedFor);
  const after = await records.directory();
  const left = directoryNotYetAnchored(after);
  if (!after.dir.seats.some((x) => x.seat === leaf && x.retired !== null) || left.length > 0) {
    throw new Error(
      'the retirement of the leaving seat is filed and not yet anchored, so the removal is not carried out on the chain. ' +
        'Your signature of the retirement, and the retirement, may have gone through and stand; nothing more is sent. Open the company again ' +
        'on a device whose seat may anchor, then carry out the removal again.'
    );
  }
};

/** The retirement signatures this device kept for a removal, none where it keeps none. */
const signaturesKeptHere = async (doors: RemovalDoors, proposalId: string): Promise<readonly RetirementSignature[]> =>
  (await doors.signatures?.all(doors.accountId, proposalId)) ?? [];

/** Keeps `signatures` on this device beside those it kept for the same removal. */
export const keepSignaturesHere = async (
  doors: RemovalDoors,
  proposalId: string,
  signatures: readonly RetirementSignature[]
): Promise<void> => {
  if (signatures.length > 0) await doors.signatures?.keep(doors.accountId, proposalId, signatures);
};

/**
 * For a raised removal this device has judged: this seat signs the retirement again at the directory version next now
 * only where the service serves a signature of this seat's that checks over these very terms at the version it named,
 * so an entry the service lists under this seat's key and this seat never made triggers nothing. Then the signatures
 * this device believes, served and kept, are kept here, and once they reach the quorum the retirement is kept whole,
 * so this device can file it whatever the service later serves.
 */
export const retirementGatheredHere = async (
  doors: RemovalDoors,
  here: DirectoryHere,
  leaf: string,
  proposalId: string,
  terms: RetirementTerms
): Promise<void> => {
  const mine = retirementSignedHere(doors, here, leaf, terms);
  const served = await signaturesServed(doors, proposalId);
  const signedBefore =
    mine !== undefined &&
    served.some(
      (x) =>
        x.signedFor !== mine.signedFor &&
        Number.isSafeInteger(x.signedFor) &&
        signaturesBelieved(doors, here, leaf, terms, x.signedFor, [x]).some((b) => b.publicKey === mine.publicKey)
    );
  if (
    doors.service.retire !== undefined &&
    mine !== undefined &&
    signedBefore &&
    !served.some((x) => x.publicKey === mine.publicKey && x.signedFor === mine.signedFor)
  ) {
    await doors.service.retire(proposalId, { signature: mine, filer: filerHere(doors) });
  }
  const signedFor = here.dir.version + 1;
  const believed = signaturesBelieved(doors, here, leaf, terms, signedFor, [
    ...(await signaturesServed(doors, proposalId)),
    ...(await signaturesKeptHere(doors, proposalId))
  ]);
  await keepSignaturesHere(
    doors,
    proposalId,
    believed.map((x) => ({ signedFor, ...x }))
  );
  if (believed.length >= Math.max(terms.threshold, here.holders.seatBar)) {
    await doors.kept?.keep(doors.accountId, {
      signedAt: signedFor,
      change: { ...retirementOf(leaf, terms), signatures: believed } as SignedChange
    });
  }
};
