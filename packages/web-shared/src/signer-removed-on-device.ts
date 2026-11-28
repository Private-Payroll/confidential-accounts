/**
 * **A SIGNER REMOVED FROM THIS DEVICE: THE REMOVAL RAISED, APPROVED AND CARRIED
 * OUT, THE LEAVING SEAT'S RETIREMENT FILED FIRST, AND THE COMPANY'S KEY CHANGED
 * AFTER IT.**
 *
 * A removal the chain can no longer carry out, because a signer was removed or
 * replaced since it was raised, is refused. When the chain no longer holds the
 * signer, this device files the retirement it keeps, or waits for the
 * signatures it still needs, and says so.
 */
import type { KeysHeld } from '../../../src/core/company-key.js';
import type { GovernanceOnTheWire } from './governed-call-builder.js';
import { sameGovernance } from './governance-compared.js';
import type { Hex } from '../../../src/core/crypto.js';
import { noAdminLeftRefusal, removalThresholdRefusal } from '../../../src/core/vault-approvers.js';
import { NotOpenedOnThisDevice } from './round-opened-here.js';
import { seatRaisingTheBarHere } from './seat-raising-the-bar-here.js';
import type { RetirementTerms } from '../../../src/core/proposal-filing.js';
import type { DirectorySeat, SignedChange } from '../../../src/midnight/seat-directory.js';
import type { RecordsKeyStatement } from 'midnight-identity/profile/records-key';
import type { DirectoryChangesKeptStore } from './tree-kept-here.js';
import { rotateTheCompanyKeyHere, type KeyRotated, type RotationDoors } from './company-key-here.js';
import { directoryNotYetAnchored, type DirectoryHere } from './vault-page-doors.js';
import {
  type GovernanceDoors,
  type GovernedOutcome,
  governOnDevice,
  riseWaitsForTheDirectory,
  stepsOf,
  type ThresholdChangeSteps
} from './company-change-on-device.js';
import { HEX64, type RoundOnThePage } from './governed-call-on-device.js';
import {
  EVERY_RECORD_ASKED,
  keepSignaturesHere,
  leaversPendingIn,
  type RaiseRead,
  removalRefusalHere,
  retirementFiledHere,
  retirementGatheredHere,
  RetirementNotYetSigned,
  type RetirementSignaturesKept,
  retirementSignedHere,
  retirementTermsHere
} from './retirement-signed-here.js';
import { removalsOpenHere, seatsLeavingHere } from './seats-leaving-here.js';

/* ── A SIGNER REMOVED, FROM THIS DEVICE ──────────────────────────────────────── */

/** What a removal asks of this device beyond any governance change. */
export type RemovalDoors = GovernanceDoors & {
  /**
   * The leaving seat's records-key statement as the roster this device believes holds it, exactly as its own wallet
   * signed it (`leaversStatementIn`); null where no statement counts for the seat.
   */
  readonly leaversStatement: (seat: DirectorySeat) => Promise<RecordsKeyStatement | null>;
  /**
   * Files a quorum's change to the company's directory for the version its signatures name, and anchors it at once
   * (`directoryChangeFiledHere`). Absent, no removal is carried out or finished from this device.
   */
  readonly directoryChange?: (change: SignedChange, signedFor: number) => Promise<unknown>;
  /** Where this device keeps a retirement once it has read a quorum's signatures for it, to file it again. */
  readonly kept?: DirectoryChangesKeptStore;
  /**
   * Where this device keeps every retirement signature it made or read for a removal, by proposal: its own the moment
   * it signs, and each it believed among those the service served. A carrier counts them beside the service's.
   */
  readonly signatures?: RetirementSignaturesKept;
  /**
   * What changing the company's key needs once a removal is carried out on the chain and its retirement anchored: the
   * key the wallet released, the copy the service serves this seat, the waiting answers, the seats the roster admitted,
   * and the filing of the change (`rotateTheCompanyKeyHere`). Absent, this device changes no key.
   */
  readonly companyKey?: Pick<
    RotationDoors,
    'filings' | 'served' | 'released' | 'askTheWallet' | 'waiting' | 'admitted' | 'file' | 'revoked'
  >;
};

/**
 * The removal is open on the chain and can never be carried out there: a signer was removed or replaced since it was
 * raised, so the account refuses it (`requireApproved`). Nothing was filed or sent.
 */
export class RemovalRaisedAgain extends Error {
  constructor() {
    super(
      'a signer was removed or replaced since this removal was raised, so the chain will never carry it out. Nothing was filed ' +
        'or sent. Withdraw it from the device of the signer who raised it, then raise the removal again: a retirement already ' +
        'anchored for this seat stays, and is not signed again.'
    );
    this.name = 'RemovalRaisedAgain';
  }
}

/**
 * Where a removal stands after this device has done what it can, and, once it is done, what changing the company's key
 * came to. A change of the key that fails leaves the removal done.
 */
export type RemovalOutcome = (
  | GovernedOutcome
  /** Approved on the chain, or carried out there, and its retirement not yet signed by enough seats to be filed. */
  | {
      readonly state: 'waiting-for-the-retirement';
      readonly round: RoundOnThePage | null;
      readonly signed: number;
      readonly needed: number;
    }
) & { readonly rotation?: KeyRotated };

/**
 * **A REMOVAL DONE, AND THE COMPANY'S KEY CHANGED AFTER IT FROM THIS DEVICE** where this page can
 * (`rotateTheCompanyKeyHere`): never from the leaving seat's device, nor one under an approved removal. Whatever the change
 * of the key comes to, even a throw, the removal stays done.
 */
const rotatedAfter = async (
  doors: RemovalDoors,
  viewingKey: KeysHeld,
  leaf: string,
  outcome: RemovalOutcome
): Promise<RemovalOutcome> => {
  if (outcome.state !== 'done' || doors.companyKey === undefined || doors.records === undefined) return outcome;
  let rotation: KeyRotated;
  try {
    rotation = await rotateTheCompanyKeyHere(
      {
        ...doors.companyKey,
        accountId: doors.accountId,
        material: doors.material,
        records: doors.records,
        leaving: () => seatsLeavingHere(doors, viewingKey, true)
      },
      { leaf }
    );
  } catch (e) {
    rotation = { state: 'not-rotated', why: (e as Error)?.message ?? String(e) };
  }
  return { ...outcome, rotation };
};

/**
 * Refuses, with nothing filed or sent, a removal the chain will never carry out (`RemovalRaisedAgain`), as its history
 * reads now; else the proposal as that history holds it (nothing where it holds none), or `no-history` where this page
 * reads no history.
 */
const refuseAnOutrunRemoval = async (doors: RemovalDoors, chainId: string): Promise<RaiseRead> => {
  if (doors.records!.roundsOnChain === undefined) return 'no-history';
  const read = (await doors.records!.roundsOnChain([chainId.toLowerCase()]))?.[chainId.toLowerCase()];
  if (read?.outrun === true) throw new RemovalRaisedAgain();
  return read;
};

/** Every directory version filed and not yet anchored, anchored from here where this device may; refused while one still waits. */
const directoryAnchoredFirst = async (doors: RemovalDoors): Promise<void> => {
  let here = await doors.records!.directory();
  if (directoryNotYetAnchored(here).length > 0 && doors.anchorDirectory !== undefined) {
    await doors.anchorDirectory();
    here = await doors.records!.directory();
  }
  const left = directoryNotYetAnchored(here);
  if (left.length > 0) {
    throw new Error(
      `A signer is not removed while ${left.length > 1 ? 'versions' : 'version'} ${left.join(', ')} of the company's ` +
        'directory are filed and not yet anchored: the retirement is filed after them and anchored at once, before the chain is ' +
        'asked. Anything this press already sent may have gone through and stands; nothing more is sent. Open the ' +
        'company on the device of a seat that may anchor, then carry out the removal again.'
    );
  }
};

/**
 * **A REMOVAL THE CHAIN HAS ALREADY CARRIED OUT, FINISHED FROM THIS DEVICE**:
 * the leaf is off the chain, so what is left is its retirement in the
 * directory, filed with the signatures this device keeps or the service keeps
 * beside the removal's proposal - never signed by anyone again where a quorum
 * already signed it. A leaf the directory holds no entry for, or a seat
 * already retired, leaves nothing to file. Once done, the company's key is
 * changed from here (`rotatedAfter`).
 */
const removalFinishedHere = async (
  doors: RemovalDoors,
  viewingKey: KeysHeld,
  leaf: string,
  here: DirectoryHere
): Promise<RemovalOutcome> =>
  rotatedAfter(doors, viewingKey, leaf, await retirementFinishedHere(doors, viewingKey, leaf, here));

/** What finishing a removal the chain carried out leaves to file: the retirement, from this device; `NoRetirementToFile` when it holds none. */
async function retirementFinishedHere(
  doors: RemovalDoors,
  viewingKey: KeysHeld,
  leaf: string,
  here: DirectoryHere
): Promise<RemovalOutcome> {
  const seat = here.dir.seats.find((x) => x.seat === leaf);
  if (seat === undefined || seat.retired !== null) return { state: 'done', round: null };
  const kept = ((await doors.kept?.all(doors.accountId)) ?? []).find(
    (k) => k.change.kind === 'retire' && k.change.seat === leaf && k.signedAt === here.dir.version + 1
  );
  if (kept !== undefined && doors.directoryChange !== undefined) {
    await doors.directoryChange(kept.change, kept.signedAt);
    return { state: 'done', round: null };
  }
  const raised = (await removalsOpenHere(doors, viewingKey, false)).filter(
    (r) => r.leaf === leaf && r.opened.retirement !== undefined
  );
  let short: RetirementNotYetSigned | null = null;
  for (const r of raised) {
    try {
      await retirementFiledHere(doors, r.id, leaf, r.opened.retirement!);
      return { state: 'done', round: null };
    } catch (e) {
      if (!(e instanceof RetirementNotYetSigned)) throw e;
      short ??= e;
    }
  }
  if (short !== null)
    return { state: 'waiting-for-the-retirement', round: null, signed: short.signed, needed: short.needed };
  throw Object.assign(
    new Error(
      'The chain no longer holds this signer, and this device finds no retirement of their seat to file. Nothing ' +
        'was sent. Open the company on the device of a signer who approved the removal, which keeps its retirement and files it.'
    ),
    { name: 'NoRetirementToFile' }
  );
}

/**
 * **A SIGNER REMOVED, AS FAR AS THIS DEVICE CAN TAKE IT.** One ordinary
 * proposal at the approvals a change of who is seated needs (`requireSeatBar`),
 * the leaving seat's own approval counted like any other. Raised with the
 * retirement of its seat built here; approving it also signs that retirement,
 * one press per signer. Carried out in this order: every directory version
 * waiting is anchored; the retirement is filed and anchored at once; only then
 * is the chain asked to take the leaf off, by `removeSignerAndSetThreshold`
 * with the threshold the removal was raised with (`newThreshold`; none or 0
 * keeps the one in force, and a rise waits for the directory to be anchored,
 * as any threshold rise does). `before` runs after every other check, before
 * every send; the steps say whether this call raises, only approves or only
 * carries out (`ThresholdChangeSteps`). Whether the removal has been carried
 * out already is read from the chain, never from the service's words: a
 * removal the chain carried out first is finished here by filing its
 * retirement. Once the removal is done, the company's key is changed from
 * here where these doors can (`rotatedAfter`). `summary`, where given, is the
 * name the removal is filed under. The wallet's removal action is its caller. A removal waits while a seat whose invitation raises the
 * threshold above the bar the removal is approved at is open
 * (`seatRaisingTheBarHere`).
 */
export async function removeSignerOnDevice(
  doors: RemovalDoors,
  input: {
    viewingKey: KeysHeld;
    leaf: string;
    name: string;
    newThreshold?: number;
    summary?: string;
  } & ThresholdChangeSteps
): Promise<RemovalOutcome> {
  if (doors.records === undefined) {
    throw new NotOpenedOnThisDevice(
      "This page cannot read the company's records, so it cannot remove a signer. Reload the page to get " +
        'the current version.'
    );
  }
  const leaf = input.leaf.toLowerCase();
  if (!HEX64.test(leaf)) throw new Error("that is not a signer's seat. Nothing was sent.");
  const newThreshold = input.newThreshold ?? 0;
  if (!Number.isSafeInteger(newThreshold) || newThreshold < 0) {
    throw new Error(
      'the approvals needed once the signer is removed must be a whole number; 0 keeps the number in force. Nothing was sent.'
    );
  }
  const records = doors.records;
  let here = await records.directory(EVERY_RECORD_ASKED);
  if (!here.holders.seats.includes(leaf)) return removalFinishedHere(doors, input.viewingKey, leaf, here);
  let seat = here.dir.seats.find((x) => x.seat === leaf);
  /* The removal asked, at the threshold asked: another open removal of the same seat is another proposal. */
  const asked = {
    kind: 'remove-signer' as const,
    leaf,
    ...(newThreshold === 0 ? {} : { threshold: String(newThreshold) })
  };
  const live = (await removalsOpenHere(doors, input.viewingKey)).find(
    (r) =>
      r.leaf === leaf &&
      r.opened.governance !== undefined &&
      sameGovernance(r.opened.governance as GovernanceOnTheWire, asked)
  );
  /*
   * Before a raise, what the leaving seat entered and the anchor does not hold yet is anchored first, so the boundary is
   * judged over it. Once raised, what that seat files is past the boundary the raise signed, and is not anchored for it.
   */
  if (
    live === undefined &&
    seat !== undefined &&
    seat.retired === null &&
    leaversPendingIn(here, seat.signingKey) > 0 &&
    doors.anchorDirectory !== undefined
  ) {
    await doors.anchorDirectory();
    here = await records.directory(EVERY_RECORD_ASKED);
    seat = here.dir.seats.find((x) => x.seat === leaf);
  }
  const made = seat === undefined || seat.retired !== null ? undefined : await retirementTermsHere(doors, here, seat);
  /*
   * Before a raise nothing has been sent. Once it is raised, the raise and anything this device sent before the check
   * stand, and a refusal sends nothing more for the removal from here.
   */
  const refuse = async (terms: RetirementTerms | undefined, raised = false, raise?: RaiseRead): Promise<void> => {
    const now = await records.directory(EVERY_RECORD_ASKED);
    const bound = raised
      ? null
      : (removalThresholdRefusal(now.holders, leaf as Hex, newThreshold) ??
        noAdminLeftRefusal(now.dir.seats, [...(await doors.approvers()).seats.keys()], leaf));
    const why = bound?.replace(/\.$/u, '') ?? (await removalRefusalHere(doors, now, leaf, terms, raised, raise));
    if (why === null) return;
    throw new Error(
      raised
        ? `This removal is raised, and this device does not approve it or carry it out: ${why}. Nothing more is sent for it from here.`
        : `This removal is not raised from this device: ${why}. Nothing was sent.`
    );
  };
  try {
    /*
     * A removal raised on the chain is judged as its approval is - outrun, its terms, the head it names - before this
     * seat signs its retirement again or keeps a quorum's signatures: a removal this device refuses gets neither, and
     * one the wallet's indexer does not show raised gets neither until it does.
     */
    if (live?.opened.retirement !== undefined) {
      const raise = await refuseAnOutrunRemoval(doors, live.opened.chainId);
      if (raise !== 'no-history' && raise?.raisedAt !== undefined) {
        await refuse(live.opened.retirement, true, raise);
        await retirementGatheredHere(doors, here, leaf, live.id, live.opened.retirement);
      }
    }
    return await rotatedAfter(
      doors,
      input.viewingKey,
      leaf,
      await governOnDevice(doors, {
        viewingKey: input.viewingKey,
        change: asked,
        summary:
          input.summary ??
          (newThreshold === 0
            ? `Remove ${input.name} as a signer`
            : `Remove ${input.name} as a signer, and need ${newThreshold} approvals`),
        body: {
          leaf: leaf as Hex,
          ...(newThreshold === 0 ? {} : { newThreshold }),
          ...(made === undefined ? {} : { retirement: made })
        },
        /*
         * Before a raise, the terms about to be raised; at an approval or the carrying out, the proposal's own, judged
         * against what was anchored at the head the raise names, and that head against the block the raise landed in.
         */
        before: async (opened) => {
          const seat = await seatRaisingTheBarHere(doors, input.viewingKey);
          if (seat !== null) throw new Error(seat);
          if (opened === undefined) await refuse(made);
          else await refuse(opened.retirement, true, await refuseAnOutrunRemoval(doors, opened.chainId));
          if (newThreshold > 0) await riseWaitsForTheDirectory(doors, newThreshold);
          await input.before?.();
        },
        /* This seat's own signature is kept here the moment it is made, whatever the service later serves. */
        signs: async (opened, round) => {
          if (opened.retirement === undefined) return undefined;
          const mine = retirementSignedHere(doors, await records.directory(), leaf, opened.retirement);
          if (mine !== undefined) await keepSignaturesHere(doors, round.id, [mine]);
          return mine;
        },
        beforeCarry: async (opened, round) => {
          await refuseAnOutrunRemoval(doors, opened.chainId);
          await directoryAnchoredFirst(doors);
          const now = await records.directory();
          const held = now.dir.seats.find((x) => x.seat === leaf);
          if (opened.retirement !== undefined && held !== undefined && held.retired === null) {
            await retirementFiledHere(doors, round.id, leaf, opened.retirement);
          }
        },
        carry: (opened) => ({
          circuit: 'removeSignerAndSetThreshold',
          leaf,
          threshold: String(newThreshold),
          proposal: opened.chainId,
          proposalSalt: opened.salt,
          removing: true
        }),
        ...stepsOf(input)
      })
    );
  } catch (e) {
    if (!(e instanceof RetirementNotYetSigned)) {
      /* A carrying out that failed may have lost to another device's: whether the leaf is off is read from the chain again. */
      const now = await records.directory(EVERY_RECORD_ASKED);
      if (!now.holders.seats.includes(leaf)) return removalFinishedHere(doors, input.viewingKey, leaf, now);
      throw e;
    }
    return {
      state: 'waiting-for-the-retirement',
      round: live === undefined ? null : { id: live.id, chainId: live.opened.chainId, status: 'open' },
      signed: e.signed,
      needed: e.needed
    };
  }
}
