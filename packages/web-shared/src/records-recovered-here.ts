/**
 * **A RECOVERY OF THE COMPANY'S RECORD ANCHOR, RAISED, APPROVED AND CARRIED OUT
 * ON THE SIGNERS' OWN DEVICES, WITH NOTHING READ THROUGH THE COMPANY'S SERVICE.**
 *
 * Where a batch of the company's records can be checked by no device - its
 * header given by nobody, or given and false - every device's read stops
 * there, and the quorum moves the anchor on past it from the last header its
 * devices checked (`recoverAnchor`). The seat raising it hands the
 * other signers a file (`ProposalFile`, through
 * `governance-from-the-chain.ts`); each device checks that file
 * against the chain at the indexer the person's own wallet names, and
 * approves only where its own read rule holds: the
 * header the recovery resumes from is one this device checked, and the header
 * right after it is one this device cannot check. Carrying it out makes the
 * recovery's header here and builds the call - the account's own checks refuse
 * it before anything is kept - then keeps the header on this device, files it
 * with the service where the service takes it, and sends the call, believed
 * carried out only when the chain shows it. A recovery is raised to be
 * carried out before a time its raiser chooses, which the approvals bind; past
 * it the account refuses it, and it is raised again. It also names the head the
 * latest recovery carried out wrote, read off the account's state, which the
 * approvals bind too: once another recovery is carried out the account refuses
 * it, so no device approves or carries it out from then on, and it is raised
 * again. The service makes each step
 * faster and is needed for none: the account's state, the proposal's standing
 * and who holds the account are read at the wallet's indexer, and a call the
 * service will not send, or says it sent and the chain does not show, is sent
 * and paid for by the person's own wallet when the person chooses it.
 */
import type { Hex } from '../../../src/core/crypto.js';
import { EMPTY_HEAD } from '../../../src/midnight/record-manifest.js';
import {
  headStepOf, nextTreeHeader, treeBatchOf, type CheckedHead, type ResumesFrom, type TransitionStop, type TreeHeader,
} from '../../../src/midnight/record-tree.js';
import type { AnchorsOnChain } from './governed-call-builder.js';
import type { TreeService } from './record-entered-here.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import { keptWith, type CheckedHeadsStore, type HeadersKeptStore } from './tree-kept-here.js';
import {
  approveFromAFile, callStateHere, fileCheckedAgainstTheChain, raiseFromTheChain, sentFromHere, standingNow,
  type FromTheChainDoors, type ProposalFile, type SentBy,
} from './governance-from-the-chain.js';

/** What a recovery asks of this device, beside what any proposal read from the chain and a file does. */
export interface RecoveryDoors extends FromTheChainDoors {
  readonly builder: FromTheChainDoors['builder'] & Pick<VaultBuilderClient, 'recoverAnchor' | 'anchorTag' | 'anchorHeads' | 'lastRecovery'>;
  /** This device's own read of the company's records: the last head it checked, and where and why it stopped. */
  readonly read: () => Promise<{ readonly reached: CheckedHead; readonly stop: TransitionStop | null }>;
  /** The heads this device checked, kept on it: where its read stands when the service cannot be reached. */
  readonly checked?: CheckedHeadsStore;
  /** The account's history and who holds the account now, at the indexer the person's own wallet names. */
  readonly onChain: () => Promise<AnchorsOnChain>;
  /** Where this device keeps the headers it signed, to file again; absent, none is kept. */
  readonly headers?: HeadersKeptStore;
  /** Where the service keeps the company's headers; absent or refusing, the recovery's header is kept on this device only. */
  readonly tree?: Pick<TreeService, 'fileHeader'>;
  readonly now?: () => Date;
}

/** Where this device's own read of the company's records stands, and whether the service could be reached for it. */
export interface OwnStanding {
  readonly reached: CheckedHead;
  readonly stop: TransitionStop | null;
  /** The service could not be reached: the read stands at the last head this device kept, stopped at the batch after it. */
  readonly serviceUnreached: boolean;
}

/**
 * **THIS DEVICE'S OWN READ, WITH THE SERVICE OR WITHOUT IT**: the read the page
 * makes; where the service cannot be reached for it, the last head this device
 * checked and kept, stopped at the batch after it whenever the chain holds
 * another head - no device can be given that batch's header then.
 */
async function ownStandingHere(doors: Pick<RecoveryDoors, 'accountId' | 'read' | 'checked' | 'onChain'>): Promise<OwnStanding> {
  try {
    return { ...(await doors.read()), serviceUnreached: false };
  } catch (e) {
    const kept = await doors.checked?.read(doors.accountId);
    if (kept === undefined || kept === null) {
      throw new Error(`this device could not read the company's records (${(e as Error)?.message ?? String(e)}) and keeps no head of them it checked, `
        + 'so it cannot say where they stopped. Open the company on a device that has read its records before');
    }
    const { landed } = await doors.onChain();
    const head = landed.length === 0 ? EMPTY_HEAD : landed[landed.length - 1]!.head.toLowerCase();
    const reached = kept.latest;
    return {
      reached, serviceUnreached: true,
      stop: head === reached.head ? null : { stop: 'not-given', seq: reached.seq + 1, what: 'the company\'s service could not be reached' },
    };
  }
}

/**
 * **WHY THIS DEVICE MAY NOT RAISE, APPROVE OR CARRY OUT A RECOVERY RESUMING FROM
 * `resumesFrom`, OR NULL WHEN IT MAY**: the header it resumes
 * from is one this device checked, and the header right after it is one this
 * device cannot check - not given, or false. So an honest device never gives
 * up a batch it can check.
 */
export function recoveryRefusal(own: OwnStanding, resumesFrom: ResumesFrom): string | null {
  if (own.stop === null) {
    return 'this device reads the company\'s records up to the head the chain holds, so nothing is stopped and nothing needs recovering. '
      + 'Do not approve it; ask the signer who raised it what their device shows';
  }
  if (own.reached.seq > resumesFrom.seq) {
    return `this device checked batch ${resumesFrom.seq + 1}, the one after the batch this recovery resumes from, and a recovery would give it up. `
      + 'Do not approve it; ask the signer who raised it why their device could not check it';
  }
  if (own.reached.seq < resumesFrom.seq) {
    return `this device has checked the company's records only up to batch ${own.reached.seq}, before batch ${resumesFrom.seq} the recovery resumes from, `
      + 'so it cannot say that batch is the company\'s. Reload the page so it checks further, then try again';
  }
  if (own.reached.head !== resumesFrom.head.toLowerCase() || own.reached.root !== resumesFrom.root.toLowerCase()) {
    return `this device checked batch ${resumesFrom.seq} as another batch than the one the recovery resumes from. `
      + 'Do not approve it; ask the signer who raised it what their device shows';
  }
  if (own.stop.seq !== resumesFrom.seq + 1) {
    return `this device stops at batch ${own.stop.seq}, not at the batch after the one the recovery resumes from. Reload the page, then try again`;
  }
  return null;
}

/** What the service's absence means for a step taken without it, said to the person, who chooses to go on. */
const WITHOUT_THE_SERVICE = 'the company\'s service could not be reached, so this device could not ask it for the batch after the last one it checked; '
  + 'going on gives that batch up as one no device here can check. Choose to go on without the service only if it stays unreachable';

/** The device's own read, held to the rule (`recoveryRefusal`) and, without the service, to the person's choice to go on. */
async function standingFor(doors: RecoveryDoors, resumesFrom: ResumesFrom, withoutTheService: boolean): Promise<OwnStanding> {
  const own = await ownStandingHere(doors);
  const why = recoveryRefusal(own, resumesFrom);
  if (why !== null) throw new Error(`${why}. Nothing was built or sent`);
  if (own.serviceUnreached && !withoutTheService) throw new Error(`${WITHOUT_THE_SERVICE}. Nothing was built or sent`);
  return own;
}

/**
 * A recovery's file - the header it resumes from, the last time it may be
 * carried out and the head the latest recovery carried out wrote when it was
 * raised - or refused as not one.
 */
const recoveryOf = (file: ProposalFile): { readonly resumesFrom: ResumesFrom; readonly latest: number; readonly lastRecovery: string } => {
  if (file.change.kind !== 'recover-anchor' || file.resumesFrom === undefined) {
    throw new Error('this file is not a recovery of the company\'s records. Nothing was built or sent. Open it where the change it names is made');
  }
  return { resumesFrom: file.resumesFrom, latest: Number(file.change.latest), lastRecovery: String(file.change.lastRecovery).toLowerCase() };
};

/**
 * **THE HEAD THE LATEST RECOVERY CARRIED OUT WROTE**, thirty-two zero bytes
 * before any, read off the account's state at the indexer the person's own
 * wallet names (`callStateHere`) and never from the service; with that state,
 * for a call to be built on.
 */
async function latestRecoveryHere(doors: RecoveryDoors): Promise<{ readonly head: string; readonly chain: Awaited<ReturnType<typeof callStateHere>> }> {
  const chain = await callStateHere(doors);
  const head = String(await doors.builder.lastRecovery({ accountState: chain.accountState })).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(head)) {
    throw new Error('the account\'s latest recovery could not be read from its state. Nothing was built or sent. Reload the page to use the current build');
  }
  return { head, chain };
}

/**
 * **A RECOVERY THAT NAMES A LATEST RECOVERY THE ACCOUNT NO LONGER HOLDS, REFUSED
 * BEFORE ANYTHING IS BUILT OR SENT.** The account refuses to carry it out, and
 * that refusal lands after the fee is paid, so approving or carrying it out
 * could only spend a fee. The refusal shows both heads, because a device whose
 * indexer is behind the chain reads an older one: the one behind waits for its
 * wallet to catch up, and the recovery is raised again only from a current read,
 * since one raised from a read that is behind names the same old head.
 */
const refusedVoid = (approved: string, latest: string, step: string): void => {
  if (approved !== latest) {
    throw new Error(`this recovery names ${approved} as the head the latest recovery carried out wrote, and the account at your wallet's indexer holds ${latest}, `
      + `so as this device reads it, it is void and the account would refuse it; ${step} could only spend a fee. Nothing was built or sent. `
      + 'If your wallet has not caught up with the chain, wait until it has and try again. Otherwise another recovery carried out has replaced the one it names: '
      + 'raise it again, and have it approved, once this device\'s read of the account is current; a recovery raised from an indexer behind the chain names the same old head, and is void too');
  }
};

/**
 * **HOW FAR AHEAD A RECOVERY'S LAST TIME MAY BE**, from the moment a device
 * raises or approves it: seven days. A recovery needs a quorum, and an honest
 * approver's device refuses one further ahead, so an approval never stays good
 * long after the records have moved on. Read only through
 * `recoveryHorizonSeconds`, so the company can later set it without the checks
 * changing.
 */
const RECOVERY_HORIZON_DAYS = 7;

/** The horizon, in seconds, for the company `accountId`: today the one named value for every company. */
const recoveryHorizonSeconds = (_accountId: string): number => RECOVERY_HORIZON_DAYS * 24 * 60 * 60;

/** The horizon in whole days, as it is said to the person. */
const horizonSaid = (accountId: string): string => `${Math.floor(recoveryHorizonSeconds(accountId) / (24 * 60 * 60))} days`;

/** The time this device reads now, in whole seconds since 1970, as the chain's block time counts them. */
const secondsNow = (doors: Pick<RecoveryDoors, 'now'>): number => Math.floor((doors.now ?? (() => new Date()))().getTime() / 1000);

/**
 * **A RECOVERY WHOSE LAST TIME HAS PASSED, REFUSED BEFORE ANYTHING IS MADE OR
 * SENT.** The account refuses to carry it out from that time on, so approving it
 * or carrying it out could change nothing; it is raised again, with a later
 * time. Judged by this device's clock: the chain judges again by its own.
 */
const refusedPast = (doors: Pick<RecoveryDoors, 'now'>, latest: number, step: string): void => {
  if (secondsNow(doors) >= latest) {
    throw new Error(`the time to carry out this recovery passed at ${new Date(latest * 1000).toISOString()}, so ${step} cannot carry it out. `
      + 'Nothing was built or sent. Ask the signer who raised it to raise it again, with a later time');
  }
};

/**
 * **A RECOVERY RAISED FROM THIS DEVICE**, resuming from the last header it
 * checked, where its read stopped at the header right after, to be carried out
 * before `latest` - the time the person raising it chose - and naming the head
 * the latest recovery carried out wrote (`latestRecoveryHere`), both of which
 * the approvals bind: raised from the chain (`raiseFromTheChain`), and the file
 * to hand the other signers returned.
 */
export async function raiseRecoveryHere(
  doors: RecoveryDoors, input: { readonly latest: Date; readonly withoutTheService?: boolean },
): Promise<{ readonly file: ProposalFile; readonly sentBy: SentBy }> {
  const latest = Math.floor(input.latest.getTime() / 1000);
  if (!Number.isSafeInteger(latest) || latest <= secondsNow(doors)) {
    throw new Error('the last time to carry out a recovery must be later than now. Nothing was sent. Choose a later time');
  }
  if (latest > secondsNow(doors) + recoveryHorizonSeconds(doors.accountId)) {
    throw new Error(`the last time to carry out a recovery may be at most ${horizonSaid(doors.accountId)} from now. Nothing was sent. Choose a nearer time`);
  }
  const own = await ownStandingHere(doors);
  if (own.reached.seq < 0) {
    throw new Error('this device has checked no batch of the company\'s records, so there is nothing a recovery could resume from. Nothing was sent');
  }
  const resumesFrom: ResumesFrom = { seq: own.reached.seq, head: own.reached.head, root: own.reached.root };
  await standingFor(doors, resumesFrom, input.withoutTheService === true);
  const { head: lastRecovery } = await latestRecoveryHere(doors);
  return raiseFromTheChain(doors, {
    change: { kind: 'recover-anchor', resumesFrom: resumesFrom.head, latest: String(latest), lastRecovery },
    summary: `Recover the company's records from batch ${resumesFrom.seq}, giving up every batch after it, which no signer's device can check, `
      + `if it is carried out before ${new Date(latest * 1000).toISOString()}`,
    resumesFrom,
  });
}

/**
 * **A RECOVERY APPROVED FROM THIS DEVICE**, from its file, only where this
 * device's own read holds to the rule and the account still holds as its latest
 * recovery the one the file names.
 */
export async function approveRecoveryHere(
  doors: RecoveryDoors, file: ProposalFile, input: { readonly withoutTheService?: boolean } = {},
): Promise<{ readonly sentBy: SentBy; readonly approvalsBefore: number }> {
  const { resumesFrom, latest, lastRecovery } = recoveryOf(file);
  refusedPast(doors, latest, 'approving it now');
  if (latest > secondsNow(doors) + recoveryHorizonSeconds(doors.accountId)) {
    throw new Error(`this recovery may be carried out until ${new Date(latest * 1000).toISOString()}, more than ${horizonSaid(doors.accountId)} after now, `
      + 'so this device does not approve it: an approval good for that long could be carried out long after the company\'s records have moved on. '
      + 'Nothing was built or sent. Ask the signer who raised it to raise it again with a nearer time');
  }
  return approveFromAFile(doors, file, async () => {
    refusedVoid(lastRecovery, (await latestRecoveryHere(doors)).head, 'approving it');
    await standingFor(doors, resumesFrom, input.withoutTheService === true);
  });
}

/**
 * A recovery carried out: its header, the head the account moved to, how the
 * call went, whether the service kept the header, and where in its transaction
 * the call landed, as read off it.
 */
interface RecoveryCarriedOut {
  readonly header: TreeHeader;
  readonly head: Hex;
  readonly sentBy: SentBy;
  readonly filed: boolean;
  readonly placement: 'guaranteed' | 'fallible';
}

/**
 * **A CARRYING OUT THE CHAIN TOOK AND THE ACCOUNT REFUSED, OR THAT ANOTHER
 * ANCHOR BEAT**: nothing was written, and the recovery is still open, to be
 * carried out again within its window. Where the call landed in its
 * transaction's fallible section and the chain shows it refused, its fee was
 * paid.
 */
export class RecoveryNotCarriedOut extends Error {}

/** What the chain shows of a carrying out sent from this device. */
type CarriedOutOnTheChain = 'landed' | 'another' | { readonly beaten: boolean; readonly feePaid: boolean };

/**
 * **WHAT THE CHAIN SHOWS OF THIS CARRYING OUT**, read at the indexer the
 * person's own wallet names, or null while it shows nothing of it:
 *   - `landed` once the head the recovery moves to is on the chain with its
 *     proposal closed;
 *   - beaten while the proposal stays open and the head has moved on from the
 *     one the call was built on - its own call moves the head only as it closes
 *     the proposal, so another anchor got there first;
 *   - refused while the proposal stays open, the head has not moved, and a
 *     call to `recoverAnchor` landed refused since this one was sent - read off
 *     its transaction's result (`failedCalls`): its time passed, who holds
 *     the account changed, or another recovery was carried out, before the
 *     chain took it;
 *   - `another` once the proposal was closed with that head never on the chain:
 *     another signer's device carried it out, or its raiser withdrew it.
 * A refused call seen is a fee paid.
 */
const carriedOutOnTheChain = (
  doors: RecoveryDoors, chainId: string, previous: Hex, head: Hex, failedBefore: number,
) => async (): Promise<CarriedOutOnTheChain | null> => {
  const standing = await standingNow(doors, chainId);
  const { landed } = await doors.onChain();
  if (standing.held === 'open') {
    const feePaid = (standing.failedCalls ?? []).filter((c) => c === 'recoverAnchor').length > failedBefore;
    const now = (landed.length === 0 ? EMPTY_HEAD : landed[landed.length - 1]!.head).toLowerCase();
    if (now === previous) return feePaid ? { beaten: false, feePaid } : null;
    /* The head moved: read the proposal again, so this device's own call landing between the two reads is not read as beaten. */
    if ((await standingNow(doors, chainId)).held === 'open') return { beaten: true, feePaid };
  }
  if ((await doors.onChain()).landed.some((l) => l.head.toLowerCase() === head)) return 'landed';
  return standing.held === 'never' ? null : 'another';
};

/**
 * **A RECOVERY CARRIED OUT FROM THIS DEVICE**, once the chain holds its proposal
 * approved: its header made here on the last header this device checked -
 * the one it resumes from - anchoring nothing, naming who holds the account
 * now and this seat's tag; the call built on the account's state at the
 * wallet's indexer, naming the head the chain holds now, and refused before it
 * is built while the account's latest recovery is not the one the approvals
 * name (`refusedVoid`), so the account's own
 * checks - its approvals at the bar for changing who is seated, its window,
 * the head and holders - refuse it before anything is kept or sent; then the
 * header kept on this device and filed with the service where the service
 * takes it (a device that kept it files it again when the service is back);
 * and the call sent (`sentFromHere`) and believed carried out only when the
 * chain shows it (`carriedOutOnTheChain`). One another anchor beat is said,
 * with the recovery still open.
 */
export async function carryOutRecoveryHere(
  doors: RecoveryDoors, file: ProposalFile, input: { readonly withoutTheService?: boolean } = {},
): Promise<RecoveryCarriedOut> {
  const { resumesFrom, latest, lastRecovery } = recoveryOf(file);
  refusedPast(doors, latest, 'carrying it out now');
  const { standing } = await fileCheckedAgainstTheChain(doors, file);
  refusedVoid(lastRecovery, (await latestRecoveryHere(doors)).head, 'carrying it out');
  const own = await standingFor(doors, resumesFrom, input.withoutTheService === true);
  const onChain = await doors.onChain();
  const company = doors.accountId;
  const chainHead = (onChain.landed.length === 0 ? EMPTY_HEAD : onChain.landed[onChain.landed.length - 1]!.head).toLowerCase() as Hex;
  const tag = await doors.builder.anchorTag({ account: doors.account, material: doors.material }) as Hex;
  const made = nextTreeHeader({
    company, before: own.reached, entries: [], current: new Map(), proof: { siblings: [] }, priorChain: () => undefined,
    held: onChain.now, at: (doors.now ?? (() => new Date()))().toISOString(), tag, recovery: { previous: chainHead, salt: file.salt as Hex },
  }, doors.material.signingSecret as Hex);
  if (made === null) throw new Error('the recovery\'s header could not be made. Nothing was sent. Reload the page to use the current version');
  const { header } = made;
  const head = String((await doors.builder.anchorHeads({ after: [headStepOf(header)] })).after[0]!).toLowerCase() as Hex;
  /* Read again off the state the call is built on: a recovery carried out since the read above voids this one too. */
  const { head: latestNow, chain } = await latestRecoveryHere(doors);
  refusedVoid(lastRecovery, latestNow, 'carrying it out');
  /*
   * Built before anything is kept or sent: where the account refuses it - its approvals short of the bar for changing
   * who is seated, its window, the head or the holders - the builder says why in the account's own words, and nothing
   * is kept or sent.
   */
  const built = await doors.builder.recoverAnchor({
    account: chain.account, material: doors.material, chain, previous: chainHead, batch: treeBatchOf(header),
    held: { approvals: header.held.approvals, signerRoot: header.held.signerRoot },
    resumesFrom: resumesFrom.head, latest: String(latest), lastRecovery, proposal: file.chainId, proposalSalt: file.salt,
  });
  /* Kept on this device first, so a header the chain takes is one this device can always file again. */
  await doors.headers?.signed(company, keptWith(header, () => undefined, () => undefined));
  let filed = false;
  try {
    if (doors.tree !== undefined) { await doors.tree.fileHeader(company, header); filed = true; }
  } catch { /* the service would not keep it: kept here, and filed again when it can be */ }
  const failedBefore = (standing.failedCalls ?? []).filter((c) => c === 'recoverAnchor').length;
  const { sentBy, went } = await sentFromHere(doors, built.tx, carriedOutOnTheChain(doors, file.chainId, chainHead, head, failedBefore));
  const until = new Date(latest * 1000).toISOString();
  if (typeof went === 'object' && went.beaten) {
    throw new RecoveryNotCarriedOut(`another anchor of the company's records got there first, so this carrying out wrote nothing${went.feePaid ? ' and its fee was paid' : ''}. `
      + `The recovery is still open: carry it out again before ${until}`);
  }
  if (typeof went === 'object') {
    throw new RecoveryNotCarriedOut('the company\'s account refused this carrying out as the chain took it - its time had passed, who holds the account '
      + `changed, or another recovery was carried out, since it was built - so it wrote nothing and its fee was paid. The recovery is still open: reload the page and carry it out again before ${until}, `
      + 'or, if that time has passed, ask the signer who raised it to raise it again');
  }
  if (went === 'another') {
    throw new Error('the chain no longer holds this recovery open, and the head this device sent is not on it: another signer\'s device carried it out first, '
      + 'or its raiser withdrew it. Reload the page to read the company\'s records as they stand');
  }
  return { header, head, sentBy, filed, placement: built.placement };
}
