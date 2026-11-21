/**
 * **A PROPOSAL WITHDRAWN FROM THIS DEVICE.**
 *
 * The chain lets nobody withdraw a run once its time to be paid has begun, and
 * only the signer who raised a change withdraws it, so this device reads where
 * the proposal stands on the chain and refuses, before anything is sent, every
 * withdrawal the chain would not take, saying why. A proposal written down and
 * never raised is withdrawn from the company's records only once a raise of it
 * can no longer reach the chain.
 */
import type { KeysHeld } from '../../../src/core/company-key.js';
import type { OpenedRound, RoundOnChain } from './governed-call-builder.js';
import { NotOpenedOnThisDevice, openTheRoundHere } from './round-opened-here.js';
import { handedOver, notThroughOurService } from './hand-over.js';
import { raiseMayStillLandAt } from '../../../src/core/proposal-filing.js';
import { closedOnRecord, closesOnRecord, filerHere, type GovernedCallDoors, onChainHere, type RoundOnThePage, SentAndNotYetSeen, theRoundAsked } from './governed-call-on-device.js';

/** Why this device refuses a withdrawal before anything is built or sent: each in words the person can act on. */
export type WithdrawalStop =
  'closed' | 'started' | 'sent-not-yet-seen' | 'filed-by-another' | 'not-raised-here' | 'raiser-not-read' | 'retirement-filed'
  | 'chain-time-not-read' | 'started-may-be-paid' | 'started-charged' | 'clock-ahead' | 'may-still-land';

const WITHDRAWAL_STOPS: Readonly<Record<WithdrawalStop, string>> = {
  closed: 'the chain no longer holds this proposal: it was carried out, withdrawn or closed already, so there is nothing to withdraw.',
  started: 'this run\'s time to be paid has begun, and from then on the chain lets nobody withdraw it. It does not have the '
    + 'approvals it was raised needing: leave it unapproved, and it closes when its time ends.',
  'started-may-be-paid': 'this run\'s time to be paid has begun, and from then on the chain lets nobody withdraw it. It has the '
    + 'approvals it was raised needing, or this wallet could not read how many it needs, so it may be paid now with no other '
    + 'approval. A signer whose seat may hold runs on its vault can still hold it on the chain until it is '
    + 'charged or paid.',
  'started-charged': 'this run has been charged to its period and can be paid, so the chain lets nobody withdraw it or hold it.',
  'clock-ahead': 'this device\'s clock is ahead of the chain\'s time. The chain would still take this run\'s withdrawal, but this '
    + 'device checks the withdrawal against its own clock as it builds it, and by that clock the run\'s time to be paid has begun. '
    + 'Set this device\'s clock right and try again.',
  'sent-not-yet-seen': 'this proposal was sent to the chain and the chain does not show it yet, so it may still arrive. Wait until '
    + 'the chain shows it, then withdraw it.',
  'may-still-land': 'the chain does not show this proposal, and a raise of it sent from a device may still reach the chain '
    + 'until {until}, by the chain\'s time. Withdrawn now, the company\'s records would say it is withdrawn while the chain may '
    + 'still open it. Withdraw it after that time.',
  'filed-by-another': 'another signer wrote this proposal down and it has not been sent to the chain. Only the signer who wrote it '
    + 'down withdraws it before then: ask them.',
  'not-raised-here': 'this change to the company was raised by another signer, and the chain lets only the signer who raised it '
    + 'withdraw it: ask them.',
  'retirement-filed': 'the signer this removal takes off is already written down as retired in the company\'s directory, ready '
    + 'for the removal to be carried out. Withdrawn now, the directory would say they left while the chain still seats them, '
    + 'and every later change to the company would be refused. Carry the removal out instead.',
  'raiser-not-read': 'this wallet could not read from the chain who raised this proposal, so it cannot tell whether the chain '
    + 'would take your withdrawal. Reload and try again.',
  'chain-time-not-read': 'this wallet could not read the chain\'s time, so it cannot tell whether a run\'s time to be paid '
    + 'has begun, from when the chain takes no withdrawal of it, or whether a raise of a proposal the chain does not show may '
    + 'still reach it. Reload and try again.',
};

/** A withdrawal this device refused before anything was built or sent, naming why. */
export class WithdrawalRefused extends Error {
  readonly nothingWasSent = true;
  /** For `may-still-land`: the chain time, as an ISO date, until which a raise of the proposal may still land. */
  readonly until?: string;
  constructor(readonly why: WithdrawalStop, until?: string) {
    super(`${WITHDRAWAL_STOPS[why].replace(/^./u, (c) => c.toUpperCase()).replace('{until}', until ?? '')} Nothing was sent.`);
    this.name = 'WithdrawalRefused';
    if (until !== undefined) this.until = until;
  }
}

/**
 * Where a withdrawal sent from this device left the proposal, as the chain shows it once it no longer holds it:
 *   - `withdrawn`: the call that closed it is a withdrawal, read from that call's own operations in its transaction
 *     (`closedBy`, `roundsOnChainIn`); another proposal's calls in the same block are not this one's;
 *   - `withdrawn-or-closed`: the calls of that block were not read one by one (a history that carries no transaction
 *     bytes) and the withdrawal is among them beside other calls, so whether it or another of them closed this one is
 *     not told here; it is closed either way;
 *   - `closed-otherwise`: the call that closed it is no withdrawal: it was carried out or closed before the withdrawal
 *     landed, and the withdrawal changed nothing;
 *   - `records-withdrawn-not-on-chain`: the chain does not hold it now, and the company's records now mark it withdrawn.
 *     Never reported as withdrawn: that no raise of it was sent rests on the service's word, and the service relays
 *     raises, so one it held may still land open. Its raiser can then withdraw it on the chain; a run also stops being
 *     payable once its window closes, but a change to the company has no window, so only that withdrawal closes it.
 */
export type WithdrawalOutcome = 'withdrawn' | 'withdrawn-or-closed' | 'closed-otherwise' | 'records-withdrawn-not-on-chain';

/** The chain's time in milliseconds, or a refusal: a time that was not read, or is not a whole positive number, decides nothing. */
const chainTimeRead = async (read: (() => Promise<number>) | undefined): Promise<number> => {
  const at = read === undefined ? undefined : await read().catch(() => undefined);
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) throw new WithdrawalRefused('chain-time-not-read');
  return at;
};

/**
 * Why a run whose time to be paid has begun is not withdrawn, by where it stands: charged to its period, short of the
 * approvals its hold says it was raised needing (or holding none), or able to be paid, where only a hold stops it.
 */
const startedStop = (onChain: RoundOnChain): WithdrawalStop => {
  if (onChain.held === 'cleared') return 'started-charged';
  const short = onChain.approvals === 0 || (onChain.needed !== undefined && onChain.approvals < onChain.needed);
  return short ? 'started' : 'started-may-be-paid';
};

/* The contract's own refusal of a run's withdrawal once its time to be paid has begun. */
const RUN_STARTED = /that run has already started/u;

const outcomeOfAClose = (closedBy: readonly string[]): WithdrawalOutcome => {
  if (!closedBy.includes('cancel')) return 'closed-otherwise';
  return closedBy.every((c) => c === 'cancel') ? 'withdrawn' : 'withdrawn-or-closed';
};

/** What a withdrawal is asked for: the proposal as the page shows it, the company's keys, the chain's time and the caller's own check. */
type WithdrawalAsked = {
  round: { readonly id: string; readonly chainId?: string }; viewingKey: KeysHeld;
  chainTime?: () => Promise<number>;
  check?: (opened: OpenedRound, onChain: RoundOnChain) => void;
};

/** The company's records as a withdrawal reads them: with where its proposals stand on the chain. */
type HeldWithTheChain = NonNullable<GovernedCallDoors['records']> & { readonly roundsOnChain: NonNullable<NonNullable<GovernedCallDoors['records']>['roundsOnChain']> };

/** Whether the records this page was given read where the company's proposals stand on the chain. */
const holdsTheChain = (records: GovernedCallDoors['records']): records is HeldWithTheChain => records?.roundsOnChain !== undefined;

/**
 * **THE PROPOSAL A WITHDRAWAL IS ASKED FOR, READ BEFORE ANYTHING IS DECIDED**: as the service names it, as this device
 * opens it, and where it stands on the chain. Refuses a page that cannot withdraw or read the chain, a proposal the
 * service and the records name differently, and a removal whose leaving seat the directory already shows retired.
 */
async function withdrawalReadHere(doors: GovernedCallDoors, input: WithdrawalAsked) {
  const { service } = doors;
  if (service.cancel === undefined) {
    throw new Error('This page cannot withdraw proposals. Reload the page to get the current version. Nothing was sent.');
  }
  const served = theRoundAsked(await service.standing(input.round.id), input.round.id, input.round.chainId);
  const opened = await openTheRoundHere(doors.service, doors.accountId, input.round.id, input.viewingKey, false, doors.records, doors.leaves, true);
  if (String(opened.chainId).toLowerCase() !== String(served.chainId).toLowerCase()) {
    throw new Error('the company now names another proposal than the one shown here. Nothing was built or sent.');
  }
  const chainId = String(opened.chainId).toLowerCase();
  if (!holdsTheChain(doors.records)) {
    throw new NotOpenedOnThisDevice('This page cannot read where the company\'s proposals stand on the chain, so it cannot '
      + 'withdraw one. Reload the page to get the current version.');
  }
  doors.progress?.('reading-the-chain');
  const records = doors.records;
  const onChain = (await records.roundsOnChain([chainId]))[chainId];
  if (onChain === undefined) {
    throw new NotOpenedOnThisDevice('Where this proposal stands on the chain was not read, so nothing is decided from it. '
      + 'Reload the page and try again.');
  }
  input.check?.(opened, onChain);
  /*
   * A removal whose leaving seat's retirement is already filed (filed before the removal is carried out) is never
   * withdrawn: the directory would say retired while the chain seats them, and no record is rewritten to undo it.
   */
  if (opened.removes !== undefined) {
    const here = await records.directory();
    if (here.dir.seats.some((x) => String(x.seat).toLowerCase() === opened.removes && x.retired !== null)) {
      throw new WithdrawalRefused('retirement-filed');
    }
  }
  return { served, opened, chainId, onChain, records };
}

/**
 * **A PROPOSAL THE CHAIN NEVER HELD, MARKED WITHDRAWN IN THE COMPANY'S RECORDS WITH NO CALL**, only by the seat that
 * wrote it down and only once no raise of it can still land; refused otherwise, saying until when.
 */
async function withdrawnFromTheRecordsHere(
  doors: GovernedCallDoors, input: WithdrawalAsked, read: { served: RoundOnThePage; opened: OpenedRound; chainId: string; records: HeldWithTheChain },
): Promise<RoundOnThePage & { readonly withdrawal: WithdrawalOutcome }> {
  const { service } = doors;
  const { served, opened, chainId, records } = read;
  /*
   * A raise of it may be on its way from any device, sent through the service or not, and the chain takes one until its
   * deadline, `raiseBy`, which the proposal's signed record fixes. Past it by the chain's own time none can ever land,
   * so the records may say withdrawn whatever the service says it sent; before it, or with the chain's time unread, a
   * raise the service says it sent is waited for, and one written down only by this seat is refused until that time.
   */
  const sent = served.txRef !== undefined || served.raisedAt !== undefined;
  const mine = String(opened.filedBy ?? '').toLowerCase() === filerHere(doors).toLowerCase();
  const raiseByMs = opened.raiseBy === undefined ? undefined : Number(opened.raiseBy) * 1000;
  const chainNow = raiseByMs === undefined ? undefined : await chainTimeRead(input.chainTime).catch(() => undefined);
  if (raiseByMs === undefined || chainNow === undefined || raiseMayStillLandAt(opened.raiseBy!, chainNow)) {
    if (sent) throw new WithdrawalRefused('sent-not-yet-seen');
    if (!mine) throw new WithdrawalRefused('filed-by-another');
    if (raiseByMs === undefined) {
      throw new NotOpenedOnThisDevice('This proposal\'s record does not say when it was written down, so this device cannot tell until '
        + 'when a raise of it may still reach the chain. Write the change down again from this device, and withdraw this one once the '
        + 'new one is on the chain.');
    }
    if (chainNow === undefined) throw new WithdrawalRefused('chain-time-not-read');
    throw new WithdrawalRefused('may-still-land', new Date(raiseByMs).toISOString());
  }
  if (!mine) throw new WithdrawalRefused('filed-by-another');
  /*
   * Where the chain stood was read before its time. A raise that landed in a block before the deadline shows in any
   * read made after a block at or past it, so where it stands is read again now, and the records say withdrawn only
   * if the chain still never held it.
   */
  const again = (await records.roundsOnChain([chainId]))[chainId];
  if (again === undefined) {
    throw new NotOpenedOnThisDevice('Where this proposal stands on the chain was not read again after the chain\'s time, so it is not '
      + 'withdrawn. Nothing was withdrawn. Reload the page and try again.');
  }
  if (again.held !== 'never') {
    throw new NotOpenedOnThisDevice('the chain now shows this proposal, which it did not when first read, so it is not withdrawn here. '
      + 'Nothing was withdrawn. Open it again to see where it stands.');
  }
  const answer = theRoundAsked(await service.cancel!(input.round.id, { filer: filerHere(doors) }), input.round.id, chainId);
  if (answer.status !== 'cancelled') {
    throw new Error('the company\'s records did not mark this proposal withdrawn. Open it again to see where it stands.');
  }
  return { ...answer, withdrawal: 'records-withdrawn-not-on-chain' };
}

/** Waits until the chain no longer holds a proposal whose withdrawal was sent, and returns where it stands then; says it was sent and not yet seen when the wait runs out. */
async function withdrawalSeenHere(doors: GovernedCallDoors, records: HeldWithTheChain, chainId: string, sent: RoundOnThePage): Promise<RoundOnChain> {
  const gone = (r: RoundOnChain | undefined): r is RoundOnChain => r !== undefined && r.held !== 'open' && r.held !== 'cleared';
  const sleep = doors.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = doors.waitMs ?? 5 * 60_000;
  const everyMs = doors.everyMs ?? 6_000;
  let now: RoundOnChain | undefined = (await records.roundsOnChain([chainId]))[chainId];
  for (let waited = 0; !gone(now) && waited < waitMs; waited += everyMs) {
    doors.progress?.('waiting-for-the-chain');
    await sleep(everyMs);
    try {
      now = (await records.roundsOnChain([chainId]))[chainId];
    } catch {
      /* A read that failed decides nothing: the chain is asked again. */
    }
  }
  if (!gone(now)) throw new SentAndNotYetSeen('Your withdrawal', sent);
  return now;
}

/**
 * **A PROPOSAL WITHDRAWN FROM THIS DEVICE.** The proposal is opened from the company's records for a withdrawal
 * (`openTheRoundHere`): believed as its filer filed it, its identity the one its own record makes. Where it stands is
 * read from the chain, through the person's own wallet, with this seat, and the withdrawal is refused before anything is
 * built or sent unless the chain would take it: a run only before its time to be paid begins, by any signer; any other
 * proposal only by the seat that raised it (`raisedHere`, the withdraw key its hold carries). `check` is the caller's
 * own refusal of the kind it opened. A removal whose leaving seat the directory already shows retired is refused. One the
 * chain does not hold is marked withdrawn in the company's records with no call, only by the seat that wrote it down, only
 * once the chain's time has passed the deadline its raise carries (`raiseBy`), and reported as exactly that, never as
 * withdrawn; one the service says was sent and the chain does not show yet is refused until the chain's time passes
 * that deadline, and then it is marked withdrawn the same way, since no raise of it can land. A
 * withdrawal sent is waited on until the chain no longer holds the proposal, and the outcome is the chain's.
 *
 * Whether a run's time to be paid has begun is judged by `chainTime`, the time of the newest block at the indexer the
 * person's own wallet names, in milliseconds, which may be hours off this device's clock. It is read for a run and for a
 * proposal the chain does not hold, and either is refused when it is not read. The cancel itself is still run on this device against this
 * device's clock as it is built, so a clock ahead of the chain's is refused with words saying so. The chain judges the
 * withdrawal against the block it lands in, later than the newest block read here, so one sent just before a run's
 * time begins may still be refused by the chain, and costs only its fee. A run whose time has begun is refused with
 * words that say where it stands (`startedStop`).
 */
export async function withdrawOnDevice(
  doors: GovernedCallDoors,
  input: WithdrawalAsked,
): Promise<RoundOnThePage & { readonly withdrawal: WithdrawalOutcome }> {
  const { service } = doors;
  const { served, opened, chainId, onChain, records } = await withdrawalReadHere(doors, input);
  if (onChain.held === 'closed') throw new WithdrawalRefused('closed');
  if (onChain.held === 'cleared') throw new WithdrawalRefused(startedStop(onChain));
  if (onChain.held === 'never') return withdrawnFromTheRecordsHere(doors, input, { served, opened, chainId, records });
  if (onChain.opensAt !== undefined) {
    const chainNow = await chainTimeRead(input.chainTime);
    if (onChain.opensAt * 1000 <= chainNow) throw new WithdrawalRefused(startedStop(onChain));
  } else if (onChain.raisedHere === undefined) {
    throw new WithdrawalRefused('raiser-not-read');
  } else if (!onChain.raisedHere) {
    throw new WithdrawalRefused('not-raised-here');
  }
  const chain = await service.callState(doors.accountId);
  doors.progress?.('building');
  /*
   * The cancel is run on this device before it is proved, and that run checks a run's window against this device's
   * clock, since no block time can be handed to it. The chain's time already said the window has not opened, so the
   * contract's own refusal here means this device's clock is ahead of the chain's.
   */
  const { tx } = await doors.builder.governedCall({
    account: chain.account, order: { circuit: 'cancel', proposal: opened.chainId }, material: doors.material, chain, opened,
  }).catch((e: unknown) => {
    if (onChain.opensAt !== undefined && RUN_STARTED.test(String((e as { message?: unknown } | null)?.message ?? e))) {
      throw new WithdrawalRefused('clock-ahead');
    }
    throw e;
  });
  doors.progress?.('sending');
  const sent = theRoundAsked(await handedOver(doors.handOver, {
    tx, call: { kind: 'account-call', contract: chain.account, circuit: 'cancel' },
    viaService: () => service.cancel!(input.round.id, { tx, filer: filerHere(doors) }),
    before: async () => { closesOnRecord(service); },
    after: () => service.standing(input.round.id),
  }), input.round.id, chainId);
  const now = await withdrawalSeenHere(doors, records, chainId, sent);
  const withdrawal = outcomeOfAClose(now.closedBy ?? []);
  /* Sent any way but through our service, our service's record is closed from its own read of the chain once it is gone. */
  const kept = notThroughOurService(doors.handOver) && withdrawal === 'withdrawn'
    ? await closedOnRecord(service, input.round.id, chainId, filerHere(doors), 'withdrawn').catch(() => sent)
    : sent;
  const standing = await onChainHere(doors, kept);
  return { ...standing, withdrawal };
}
