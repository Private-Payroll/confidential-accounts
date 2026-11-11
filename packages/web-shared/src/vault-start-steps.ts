import { ADOPT_VAULT, newProposalId, proposalFilingRefusal, raiseByOf, sealGovernanceProposal, signProposalFiling } from '../../../src/core/proposal-filing.js';
import type { AccountHolders } from 'midnight-identity/profile/records-key';
import type { CreateVaultDoors, Pacing, VaultStartProposals } from './vault-doors.js';
import { DEVICE_RAISE_VERSION } from '../../../src/core/device-raise.js';
import { type DirectoryRead, kindAsked, listedHere } from './vault-page-doors.js';
import { mayNotFileSaid, seatMayFileIn } from './may-file-here.js';
import type { FirstSecretRunParts } from '../../../src/midnight/vault-start.js';
import type { GovernedCallOrder, OpenedRound } from './governed-call-builder.js';
import { type Hex, type Sealed, signingPublicKeyOf } from '../../../src/core/crypto.js';
import { NOT_BUILT, type NotBuiltCode, START_READ_STOP, VaultNotTheCompanys, VaultStartOwed, sentNothing } from './vault-start-stops.js';
import { NO_ASSET } from '../../../src/core/assets.js';
import { READER_REFUSAL } from '../../../src/midnight/secret-readers.js';
import { ReadRanOutOfTime, SERVICE_READ_BOUND_MS, SERVICE_READ_BOUND_SECONDS } from './read-bound.js';
import type { SealedProposal } from '../../../src/core/types.js';
import type { RunSecret } from './vault-pool-opened.js';
import type { StartStandingOnTheWire, VaultBuilderClient } from './vault-worker-client.js';
import { believedFilerHere } from './round-opened-here.js';
import { chainAtOneBlockHere, oneBlockOrNotYet, theVaultAsItsSignersHoldIt } from './vault-read-here.js';
import { handedOver } from './hand-over.js';
import { proposalEntry } from '../../../src/midnight/record-manifest.js';
import { sealingWith } from '../../../src/core/company-key.js';

/* ------------------------------------------------------------ starting a vault */

export const ZERO_HEX = '00'.repeat(32);
const randomHex = (): string => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

/** One block's view of the vault and the company's account, read on this device at the indexer the person's own wallet names. */
type ChainAtTheStart = Awaited<ReturnType<typeof chainAtOneBlockHere>>;

/** What a read on this device answers when it ran out of time: not shown yet, and asked again. */
export const RAN_OUT: unique symbol = Symbol('the read ran out of time');

/** What a wait says when every read in it ran out of time: the chain was never read, so nothing is said of what it holds. */
export const NOT_READ_IN_TIME = `this device could not read the chain in time: no read answered within ${SERVICE_READ_BOUND_SECONDS} seconds.`;

/**
 * Where a vault's start stands now, read off both contracts at one block on this device, with the chain it was read at,
 * and with `secret` where its secret run stands (over the commitment it replaces, finding the secret it must carry);
 * null only while the chain the wallet reads does not hold the vault and the account yet, and `RAN_OUT` when the read
 * of the block did not answer within SERVICE_READ_BOUND_MS, which a later read can clear. Anything else that stops the
 * read - a wallet that names no indexer, a read that fails, a standing the worker cannot work out - is the start not
 * finished at once, naming the vault and why: waiting would not change it.
 */
async function standingIfRead(
  doors: CreateVaultDoors, vault: Hex, secret?: RunSecret, window?: { opensAt: bigint; closesAt: bigint },
) {
  const indexer = await doors.indexer();
  if (indexer === null) {
    throw new VaultStartOwed(vault, 'your wallet did not say which indexer it reads the chain through, so this device cannot '
      + 'read where its start stands.');
  }
  let chain: ChainAtTheStart | null;
  try {
    chain = await oneBlockOrNotYet(doors, vault, indexer);
  } catch (e) {
    if (e instanceof ReadRanOutOfTime) return RAN_OUT;
    throw new VaultStartOwed(vault, `this device could not read the chain at one block (${(e as Error)?.message ?? e}).`, START_READ_STOP.chainUnread);
  }
  if (chain === null) return null;
  const now = BigInt(Math.floor((doors.clock?.() ?? Date.now()) / 1000));
  let read: Awaited<ReturnType<VaultBuilderClient['startStanding']>>;
  try {
    read = await doors.builder.startStanding({
      vault, account: chain.account, accountState: chain.accountState, vaultState: chain.vaultState, now: now.toString(),
      seat: doors.material.signingSecret,
      ...(secret === undefined ? {} : { secret: secret.secret, readers: secret.readers }),
      ...(secret?.previous === undefined ? {} : { previous: secret.previous }),
      ...(secret?.earlier === undefined ? {} : { earlier: secret.earlier }),
      ...(window === undefined ? {} : { window: { opensAt: window.opensAt.toString(), closesAt: window.closesAt.toString() } }),
    });
  } catch (e) {
    throw new VaultStartOwed(vault, `where its start stands could not be worked out on this device (${(e as Error)?.message ?? e}).`, START_READ_STOP.standingUnread);
  }
  return { chain, now, standing: read.standing, run: read.run };
}

export type StartStanding = Exclude<NonNullable<Awaited<ReturnType<typeof standingIfRead>>>, typeof RAN_OUT>;

/**
 * `until` for a read on this device: a read that ran out of time is asked again, and is counted as the
 * SERVICE_READ_BOUND_MS it waited and the pause after it, so a wait whose every read runs out of time ends within
 * `waitMs`. Answers `RAN_OUT` when the wait ended and every read in it ran out, so the chain was never read.
 */
export async function untilReadHere<T>(pacing: Pacing, ask: () => Promise<T | null | typeof RAN_OUT>): Promise<T | null | typeof RAN_OUT> {
  const every = pacing.everyMs ?? 6_000;
  const tries = Math.max(1, Math.ceil((pacing.waitMs ?? 10 * 60_000) / every));
  const aReadThatRanOut = Math.ceil((SERVICE_READ_BOUND_MS + every) / every);
  let everyReadRanOut = true;
  for (let counted = 0; counted < tries;) {
    const got = await ask();
    if (got !== null && got !== RAN_OUT) return got;
    if (got === null) everyReadRanOut = false;
    counted += got === RAN_OUT ? aReadThatRanOut : 1;
    await pacing.sleep(every);
  }
  return everyReadRanOut ? RAN_OUT : null;
}

/**
 * Where a vault's start stands now, waiting only while the chain the wallet reads does not hold the vault and the
 * account at all, or its read of the block ran out of time; a wait that runs out is the start not finished, naming
 * the vault. An indexer that holds both but has not yet caught up with this person's last send answers at once with
 * the older state: only `untilTheChainShows`, after a send, waits for what was sent.
 */
export async function standingNow(
  doors: CreateVaultDoors, vault: Hex, secret?: RunSecret, window?: { opensAt: bigint; closesAt: bigint },
): Promise<StartStanding> {
  const got = await untilReadHere(doors, () => standingIfRead(doors, vault, secret, window));
  if (got === RAN_OUT) throw new VaultStartOwed(vault, NOT_READ_IN_TIME, START_READ_STOP.chainUnread);
  if (got === null) throw new VaultStartOwed(vault, 'the chain your wallet reads has not shown it and your company\'s account yet.');
  return got;
}

/** The service's doors for a start, or the refusal that names what this page is missing. */
type StartSteps = Required<Pick<CreateVaultDoors['service'], 'startAccountCall' | 'startSecret' | 'startCopy'>>;
export const startDoorsOf = (doors: CreateVaultDoors, vault: Hex): {
  readonly accountCall: StartSteps['startAccountCall']; readonly secret: StartSteps['startSecret']; readonly copy: StartSteps['startCopy'];
} => {
  const { startAccountCall, startSecret, startCopy } = doors.service;
  if (startAccountCall === undefined || startSecret === undefined || startCopy === undefined) {
    throw new VaultStartOwed(vault, 'this page cannot send the steps that start a vault. Reload it to get the current version.');
  }
  return {
    accountCall: startAccountCall.bind(doors.service), secret: startSecret.bind(doors.service), copy: startCopy.bind(doors.service),
  };
};

/** Sends one step; a refusal or an answer lost on the way is the start not finished, naming why. */
export async function sent(vault: Hex, what: string, send: () => Promise<unknown>): Promise<void> {
  try {
    await send();
  } catch (e) {
    const why = (e as Error)?.message ?? String(e);
    throw new VaultStartOwed(vault, sentNothing(e)
      ? `${what} was not sent (${why}).`
      : `${what} may have been sent and the answer was lost (${why}). Wait a minute before creating it again.`);
  }
}

/**
 * Asks the chain until `seen` says yes, reading a secret run under `window` when one is named, so the run read is that
 * one; a wait that runs out is the start not finished, naming what was sent.
 */
export async function untilTheChainShows(
  doors: CreateVaultDoors, vault: Hex, what: string,
  seen: (now: StartStanding) => boolean, secret?: RunSecret, window?: { opensAt: bigint; closesAt: bigint },
): Promise<StartStanding> {
  const got = await untilReadHere(doors, async () => {
    const now = await standingIfRead(doors, vault, secret, window);
    return now === null || now === RAN_OUT ? now : seen(now) ? now : null;
  });
  if (got === RAN_OUT) throw new VaultStartOwed(vault, `${what} was sent, and ${NOT_READ_IN_TIME}`, START_READ_STOP.chainUnread);
  if (got === null) throw new VaultStartOwed(vault, `${what} was sent and the chain has not shown it yet.`);
  return got;
}

/** The account's call state, from one block's view of both contracts. */
const callChainOf = (chain: ChainAtTheStart) =>
  ({ blockHash: chain.blockHash, accountState: chain.accountState, parameters: chain.parameters });

/** The account's half of a raise that moves no money: no asset, no amount, no payments, a blinding nobody keeps. */
export const nothingMoves = (asset: string, salt: string) => ({
  assetId: asset, assetBlinding: randomHex(), proposalSalt: salt, changeAmount: '0', changeBatchDigest: ZERO_HEX,
});

/**
 * Builds one of the start's approvals or its adoption on the account here and sends it. An approval is built only for
 * a round whose standing says this seat's approval is not yet counted (`approvedHere`, read from the chain).
 */
export async function accountStep(
  doors: CreateVaultDoors, vault: Hex, chain: ChainAtTheStart,
  step: 'adoption' | 'secret-run', order: GovernedCallOrder & { readonly circuit: 'approve' | 'adopt' }, opened: OpenedRound, what: string,
): Promise<void> {
  let tx: string;
  try {
    ({ tx } = await doors.builder.governedCall({ account: chain.account, order, material: doors.material, chain: callChainOf(chain), opened }));
  } catch (e) {
    throw new VaultStartOwed(vault, `${what} could not be built on this device (${(e as Error)?.message ?? String(e)}). Nothing was sent.`);
  }
  await sent(vault, what, () => handedOver(doors.handOver, {
    tx, call: { kind: 'account-call', contract: doors.account, circuit: order.circuit },
    viaService: () => startDoorsOf(doors, vault).accountCall(vault, { tx, step, call: order.circuit }),
    after: async () => undefined,
  }));
}

/**
 * Whether the chain counts this seat's approval of a start's round, read with this device's signing secret. Refused,
 * saying what resolves it, when the standing was read without it: an approval is never built on a guess.
 */
export const approvedHere = (vault: Hex, round: { readonly approvedHere?: boolean }, what: string): boolean => {
  if (round.approvedHere === undefined) {
    throw new VaultStartOwed(vault, `whether your approval of ${what} is already counted was not read from the chain. Reload the page and start again.`);
  }
  return round.approvedHere;
};

export interface SeatRefusal { readonly code: NotBuiltCode; readonly says: string }

const seatMayRaiseIn = (p: Pick<VaultStartProposals, 'signingSecret'>, here: Awaited<ReturnType<DirectoryRead>>): string | null =>
  seatRefusalIn(p, here)?.says ?? null;

export const seatRefusalIn = (p: Pick<VaultStartProposals, 'signingSecret'>, here: Awaited<ReturnType<DirectoryRead>>): SeatRefusal | null => {
  const s = seatMayFileIn(here, signingPublicKeyOf(p.signingSecret), 'proposal');
  if (!('refused' in s)) return null;
  const code = s.refused === 'no-seat' ? NOT_BUILT.seatUnknown : s.refused === 'not-believed' ? NOT_BUILT.seatNotBelieved : NOT_BUILT.seatMayNotRaise;
  return {
    code,
    says: `${mayNotFileSaid(s, 'your seat\'s role on this company may not raise proposals, and setting up a vault raises two. A signer '
      + 'whose role may raise proposals sets it up')}.`,
  };
};

/** One of the two proposals a vault's start raises: its identity on the chain, and its record as this device seals it. */
export interface StartRound {
  readonly what: string;
  /** The proposal by name, as a sentence says it after "the vault's": "adoption". */
  readonly called: string;
  readonly chainId: string;
  readonly digest: string;
  readonly salt: string;
  /** The vault the identity is made for, given only for a secret run (first or replacing), whose one leaf pays a zero amount of no asset. */
  readonly named?: string;
  readonly seal: (key: Hex) => Sealed;
  /** A secret run's public parts, which the service makes the run again from once its secret is set; absent for the adoption. */
  readonly parts?: FirstSecretRunParts;
}

/**
 * **THE VAULT'S ADOPTION OR FIRST SECRET RUN THE CHAIN CARRIED OUT, WRITTEN
 * DOWN AS CARRIED OUT**: each record of it the company's proposals still hold
 * open, asked of the service by this seat once this device's own read of the
 * chain shows the vault adopted or its secret set (the service checks it is that
 * vault's round, from the run's public parts for a secret run, and reads the
 * chain again before it writes anything). Null when done or nothing is open;
 * otherwise a sentence of why, and the start carries on.
 */
export async function carriedOutWrittenDown(doors: CreateVaultDoors, vault: Hex, round: StartRound): Promise<string | null> {
  const p = doors.proposals;
  if (p.carried === undefined) return null;
  const filer = signingPublicKeyOf(p.signingSecret).toLowerCase();
  const chainId = round.chainId.toLowerCase();
  try {
    const open = (await p.service.sealedProposals(p.accountId))
      .filter((r) => r.accountId === p.accountId && String(r.chainId).toLowerCase() === chainId && (r.status === 'open' || r.status === 'approved'));
    for (const r of open) await p.carried(r.id, { vault, filer, ...(round.parts === undefined ? {} : { run: round.parts }) });
    return null;
  } catch (e) {
    return `The vault's ${round.called} is carried out on the chain, and the company's proposals still show it open: `
      + `${String((e as Error)?.message ?? e).replace(/\.$/u, '')}. Pressing again writes it down.`;
  }
}

/**
 * **WHETHER A SET-UP RAISE WRITTEN DOWN BEFORE MAY STILL REACH THE CHAIN**: in a block whose time is before the
 * deadline its record sets (`raiseByOf`, from when it was written down). Before it by this device's clock, it may, and
 * is sent again under that record. At or past it by this device's clock, the chain's time decides, so no record is
 * taken for dead while the chain may still take its raise: not read yet at the deadline, or not read at all, the press
 * stops with nothing sent. Once the chain's time is at or past the deadline, where the chain stands is read again
 * (`heldNow`): a raise that landed before its deadline shows in a read made after that time, so time first and where
 * it stands second, and one the chain now holds is never taken for dead.
 */
export async function raiseMayStillLand(
  doors: CreateVaultDoors, vault: Hex, rec: SealedProposal, called: string, heldNow: () => Promise<boolean>,
): Promise<boolean> {
  const byMs = Number(raiseByOf(rec.createdAt)) * 1000;
  if ((doors.clock?.() ?? Date.now()) < byMs) return true;
  const raised = `the raise of the vault's ${called} written down as ${rec.id} could reach the chain only before ${new Date(byMs).toISOString()}`;
  if (doors.chainTime === undefined) {
    throw new VaultStartOwed(vault, `${raised}, and this page cannot read the chain's time to tell whether that has passed. Nothing was `
      + 'sent. Reload the page to get the current version, and press again.');
  }
  const chainNow = await doors.chainTime().then((t) => (Number.isFinite(t) ? t : null), () => { /* a time not read is said below; nothing is sent */ return null; });
  if (chainNow === null) {
    throw new VaultStartOwed(vault, `${raised}, and the chain's time could not be read just now to tell whether that has passed. Nothing `
      + 'was sent. Press again in a minute.');
  }
  if (chainNow < byMs) {
    throw new VaultStartOwed(vault, `the raise of the vault's ${called} written down as ${rec.id} may still reach the chain until `
      + `${new Date(byMs).toISOString()}: the newest block the wallet's indexer shows is before that time, though this device's clock `
      + 'is past it, as when the indexer is behind or this device\'s clock is ahead. Nothing was sent. Press again after that time.');
  }
  let held: boolean;
  try {
    held = await heldNow();
  } catch (e) {
    if (e instanceof VaultStartOwed) throw e;
    throw new VaultStartOwed(vault, `${raised}, and where the chain stands could not be read again after its time (${String((e as Error)?.message ?? e)
      .replace(/\.$/u, '')}). Nothing was sent. Press again in a minute.`);
  }
  if (held) {
    throw new VaultStartOwed(vault, `the chain now shows the vault's ${called} written down as ${rec.id} raised, so it is neither withdrawn `
      + 'nor raised again. Nothing was sent. Press again to carry on with it.');
  }
  return false;
}

/**
 * **A SET-UP RECORD WHOSE RAISE CAN NO LONGER LAND, WITHDRAWN** from the company's proposals before another is raised
 * in its place, so they never hold two rounds for one set-up. Only this seat's own record: another signer's is
 * withdrawn by that signer, as any proposal is. A record not withdrawn stops the press with nothing sent.
 */
async function withdrawnForGood(doors: CreateVaultDoors, vault: Hex, rec: SealedProposal, called: string): Promise<void> {
  const p = doors.proposals;
  const own = signingPublicKeyOf(p.signingSecret).toLowerCase();
  const dead = `the raise of the vault's ${called} written down as ${rec.id} can no longer reach the chain: the chain's time has reached `
    + `${new Date(Number(raiseByOf(rec.createdAt)) * 1000).toISOString()}, and it lands only in a block before that time`;
  if (rec.filedBy?.publicKey.toLowerCase() !== own) {
    throw new VaultStartOwed(vault, `${dead}. Another signer wrote it down, so this device neither withdraws it nor raises another beside `
      + 'it. Nothing was sent. Once that signer withdraws it from the company\'s proposals, pressing again raises it afresh.');
  }
  if (p.service.cancel === undefined) {
    throw new VaultStartOwed(vault, `${dead}, and this page cannot withdraw it, so no other is raised beside it. Nothing was sent. Reload `
      + 'the page to get the current version, and press again.');
  }
  let after: Awaited<ReturnType<NonNullable<VaultStartProposals['service']['cancel']>>>;
  try {
    after = await p.service.cancel(rec.id, { filer: own });
  } catch (e) {
    throw new VaultStartOwed(vault, `${dead}, and the company's proposals did not withdraw it (${String((e as Error)?.message ?? e)
      .replace(/\.$/u, '')}), so no other is raised beside it. Nothing was sent. Press again in a minute.`);
  }
  if (after.status !== 'cancelled') {
    throw new VaultStartOwed(vault, `${dead}, and the company's proposals did not mark it withdrawn, so no other is raised beside it. `
      + 'Nothing was sent. Press again in a minute.');
  }
}

/**
 * **A START'S PROPOSAL WRITTEN DOWN AS THE COMPANY'S, AND RAISED WITH IT.**
 * Run on every pass, keyed by the proposal's identity on the chain: the record
 * the company's proposals already hold for it, read only through the company's
 * directory as this device believes it (`listedHere`), or none, in which case
 * this seat seals and signs one. With `raise`, the chain does not hold the
 * proposal yet: the call is built on the account's call state and sent with
 * the record in one request, written down first and then relayed
 * (`submitProvenCall`), or sent again under the record already there while
 * its raise may still land (`raiseMayStillLand`); once it never can, that
 * record is withdrawn (`withdrawnForGood`) and a new one written down and
 * raised, with its own deadline (`writtenDownAfresh`). A secret run's dead
 * record never reaches here: its run is raised over a new window instead
 * (`secretRunStillStanding`). A withdrawn record is never acted on. Without
 * it the chain holds it, and only the record is written down. What this seat
 * filed is then entered in the company's records. A record served under the
 * identity that this company could not have written down for this proposal -
 * its filing signature does not hold, or it is over another payload - is
 * refused by name and neither entered nor raised under, whatever key it names.
 *
 * The approvals, the adoption and the secret read nothing written here: they
 * are made from the chain. So once the raise is sent, or with none to send,
 * nothing here stops the start: a record the service will not give or keep,
 * one this device cannot seal while the company's key is being changed, one
 * not entered, or another seat's record that seat has not entered yet, is
 * returned as a sentence for the press to say, and written down or entered on
 * a later press. Null when the record is written down and believed.
 */
export async function proposedAndWrittenDown(
  doors: CreateVaultDoors, vault: Hex, round: StartRound,
  raise?: { readonly order: GovernedCallOrder; readonly opened: OpenedRound; readonly heldNow: () => Promise<boolean> },
): Promise<string | null> {
  const p = doors.proposals;
  const own = signingPublicKeyOf(p.signingSecret).toLowerCase();
  const notWrittenDown = (why: string): string => `The vault's ${round.called} is on the chain and is not written down in the `
    + `company's records yet: ${why}. Setting the vault up carries on; pressing again writes it down.`;
  const chainId = round.chainId.toLowerCase();
  let found: SealedProposal | undefined;
  let may: string | null;
  try {
    const [served, here] = await Promise.all([p.service.sealedProposals(p.accountId), p.directory(kindAsked('proposal'))]);
    found = listedHere(here, 'proposal', served, 'proposal')
      .find((r) => r.accountId === p.accountId && String(r.chainId).toLowerCase() === chainId && r.status !== 'cancelled');
    may = seatMayRaiseIn(p, here);
  } catch (e) {
    if (raise === undefined) return notWrittenDown(`the company's proposals could not be read (${(e as Error)?.message ?? e})`);
    throw new VaultStartOwed(vault, `the company's proposals could not be read, so ${round.what} was not sent (${(e as Error)?.message ?? e}).`);
  }
  /*
   * A record served under this proposal's identity is acted on only if it is one the company could have written down
   * for this very proposal: signed by the seat it names, for this company, over this proposal's payload. Anything else
   * is not entered or sent under, whoever it names as its filer.
   */
  if (found !== undefined && (proposalFilingRefusal(p.accountId, found) !== null
    || String(found.digest).toLowerCase() !== round.digest.toLowerCase())) {
    throw new VaultStartOwed(vault, `the company's proposals hold a record, ${found.id}, under the identity of the vault's ${round.called} `
      + 'that is not a record of it this company could have written down, so it is neither entered nor raised under. Nothing was sent.');
  }
  if (raise !== undefined && may !== null) throw new VaultStartOwed(vault, `${may} Nothing was sent.`);
  if (found === undefined && may !== null) return notWrittenDown(may.replace(/\.$/u, ''));
  /*
   * A raise sent under a record written down already carries that record's deadline, so the record must be one a seat
   * of the company filed: this seat's own, its signature checked above, or one the company's records anchor to another
   * seat. A record the service alone could have made sets no raise's deadline.
   */
  if (raise !== undefined && found !== undefined && found.filedBy?.publicKey.toLowerCase() !== own) {
    try {
      await believedFilerHere({ directory: p.directory }, p.accountId, found);
    } catch (e) {
      throw new VaultStartOwed(vault, `the company's proposals hold a record, ${found.id}, under the identity of the vault's ${round.called} `
        + `that no seat of the company is believed to have written down (${(e as Error)?.message ?? e}), so ${round.what} was not sent `
        + 'under it. Ask the signer who wrote it down to open the company so their device enters it, then press again.');
    }
  }
  /*
   * The chain does not hold this proposal. A record whose raise can no longer reach it, by the chain's time, is withdrawn
   * first, so the one written down below, with a deadline of its own, is the only one standing for it.
   */
  if (raise !== undefined && found !== undefined && !(await raiseMayStillLand(doors, vault, found, round.called, raise.heldNow))) {
    await withdrawnForGood(doors, vault, found, round.called);
    found = undefined;
  }
  let tx: string | undefined;
  /* A raise carries the deadline of the record it is sent under: the one written down already, or the one written down with it. */
  const writtenAt = found?.createdAt ?? new Date().toISOString();
  if (raise !== undefined) {
    tx = (await buildOrOwe(vault, round.what, async () => {
      const chain = await p.service.callState(p.accountId);
      return doors.builder.governedCall({
        account: chain.account, order: raise.order, material: doors.material, chain, opened: { ...raise.opened, raiseBy: raiseByOf(writtenAt) },
      });
    })).tx;
  }
  let entry: ReturnType<typeof proposalEntry> | null = null;
  if (found !== undefined) {
    const id = found.id;
    if (tx !== undefined) {
      const body = { tx, version: DEVICE_RAISE_VERSION, filer: own };
      const raised = tx;
      await sent(vault, round.what, () => handedOver(doors.handOver, {
        tx: raised, call: { kind: 'account-call', contract: doors.account, circuit: 'propose' },
        viaService: () => p.service.send(id, body),
        after: async () => undefined,
      }));
    }
    if (found.filedBy?.publicKey.toLowerCase() === own) {
      entry = proposalEntry(p.accountId, found);
    } else {
      /* Another seat's record is entered only by that seat's device; until then no device believes it, which is said. */
      try {
        await believedFilerHere({ directory: p.directory }, p.accountId, found);
        return null;
      } catch {
        return notWrittenDown(`the record of it was written down by another signer, and is believed once that signer's device enters it`);
      }
    }
  } else {
    const written = await writtenDownAfresh(doors, vault, round, { writtenAt, tx, notWrittenDown });
    if (typeof written === 'string') return written;
    entry = written;
  }
  if (entry === null) return null;
  try {
    await p.entered.enter([entry]);
    return null;
  } catch (e) {
    /* Written down: entered on the next press, which finds it here again. */
    return notWrittenDown(`it is written down and was not entered in the company's records (${(e as Error)?.message ?? e})`);
  }
}

/**
 * A record of the proposal written down afresh by this seat, sealed under the company's key in force: with the raise
 * it travels with (`tx`), the record first and then both; without one, the record alone, and a record that cannot be
 * sealed or kept now is a sentence for the press to say (`notWrittenDown`), written down on the next press. Answers
 * the record's entry for the company's records.
 */
async function writtenDownAfresh(
  doors: CreateVaultDoors, vault: Hex, round: StartRound,
  at: { readonly writtenAt: string; readonly tx: string | undefined; readonly notWrittenDown: (why: string) => string },
): Promise<ReturnType<typeof proposalEntry> | string> {
  const p = doors.proposals;
  const chainId = round.chainId.toLowerCase();
  const { writtenAt, tx, notWrittenDown } = at;
  const filed = (): { readonly filing: ReturnType<typeof signProposalFiling>; readonly body: Parameters<VaultStartProposals['service']['file']>[1] } => {
    const sealing = sealingWith(p.companyKeys, 0);
    const filing = signProposalFiling(p.accountId, {
      id: newProposalId(), digest: round.digest.toLowerCase() as Hex, chainId: chainId as Hex,
      keyEpoch: sealing.epoch, createdAt: writtenAt, sealed: round.seal(sealing.key),
    }, p.signingSecret);
    return {
      filing,
      body: {
        proposal: filing, salt: round.salt.toLowerCase(), ...(round.named === undefined ? {} : { vault: round.named.toLowerCase() }),
        ...(tx === undefined ? {} : { tx, version: DEVICE_RAISE_VERSION }),
      },
    };
  };
  let made: ReturnType<typeof filed>;
  if (tx === undefined) {
    /* The chain holds it already: a record that cannot be sealed or kept now is written down on the next press. */
    try {
      made = filed();
      await p.service.file(p.accountId, made.body);
    } catch (e) {
      return notWrittenDown(`${(e as Error)?.message ?? e}`.replace(/\.$/u, ''));
    }
  } else {
    try {
      made = filed();
    } catch (e) {
      throw new VaultStartOwed(vault, `${round.what} could not be sealed on this device (${(e as Error)?.message ?? e}). Nothing was sent.`);
    }
    const raised = tx;
    const recordOnly = { proposal: made.body.proposal, salt: made.body.salt, ...(made.body.vault === undefined ? {} : { vault: made.body.vault }) };
    await sent(vault, round.what, () => handedOver(doors.handOver, {
      tx: raised, call: { kind: 'account-call', contract: doors.account, circuit: 'propose' },
      viaService: () => p.service.file(p.accountId, made.body),
      before: () => p.service.file(p.accountId, recordOnly),
      after: async () => undefined,
    }));
  }
  return proposalEntry(p.accountId, made.filing);
}

/** A new vault's adoption, as its record is sealed: a governance proposal for no vault, naming the vault it adopts. */
export const adoptionRound = (doors: CreateVaultDoors, vault: Hex, a: StartStandingOnTheWire['adoption'], summary: string): StartRound => ({
  what: 'raising its adoption', called: 'adoption', chainId: a.proposal, digest: a.payload, salt: a.salt,
  seal: (key) => sealGovernanceProposal({
    accountId: doors.proposals.accountId, viewingKey: key, kind: ADOPT_VAULT, summary, noVault: a.named as Hex,
    body: { vault }, change: { asset: NO_ASSET, amount: 0n, batchDigest: ZERO_HEX as Hex, salt: a.salt as Hex },
    proposedBy: doors.me.signerId,
  }),
});

/** The start's own form of the check: a vault that fails it is a start not finished, naming why. */
export async function asTheWalletReadIt(doors: CreateVaultDoors, vault: Hex): Promise<AccountHolders> {
  try {
    return await theVaultAsItsSignersHoldIt(doors, vault);
  } catch (e) {
    const stoppedAt = e instanceof VaultNotTheCompanys ? READER_REFUSAL.walletReadNothing : undefined;
    throw new VaultStartOwed(vault, (e as Error)?.message ?? String(e), stoppedAt);
  }
}

/** Builds one of the vault's own start calls here, or says the start is not finished and nothing was sent. */
export async function buildOrOwe(vault: Hex, what: string, build: () => Promise<{ tx: string }>): Promise<{ tx: string }> {
  try {
    return await build();
  } catch (e) {
    throw new VaultStartOwed(vault, `${what} could not be built on this device (${(e as Error)?.message ?? e}). Nothing was sent.`);
  }
}
