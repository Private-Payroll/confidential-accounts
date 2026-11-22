/**
 * **A PUBLIC DEPOSIT INTO A COMPANY'S VAULT** (`depositPubliclyIntoCompanyVault`),
 * with the failures that name what happened to it.
 */
import type { Hex } from '../../../src/core/crypto.js';
import type { VaultCallOnChain } from '../../../src/midnight/note-index.js';
import { PUBLIC_DEPOSIT_ENTRY } from './public-deposit-call.js';
import type { AccountAddress, CompanyLabel, VaultAddress } from 'midnight-identity/profile/company-label';
import type { VaultBuilderClient } from './vault-worker-client.js';
import { VaultAskFailed } from './vault-worker-client.js';
import { ReadRanOutOfTime } from './read-bound.js';
import { CompanyChangedMeanwhile, VaultNotAdopted } from './company-view-probe.js';
import type { VaultService } from './vault-service.js';
import { sentNothing } from './vault-start-stops.js';
import { type ChainHereDoors, type Pacing, type VaultOnChainDoors, until } from './vault-doors.js';
import { theWalletsIndexer } from './vault-read-here.js';
import { takesDepositsOrThrow } from './vault-fundable-here.js';
import { chainParametersForADeposit, DEPOSIT_CLOCKS_MAY_DIFFER_MS, type DepositDoors, whyNotTheDepositBuilt } from './vault-private-deposit.js';

/**
 * **WHEN A PUBLIC DEPOSIT CAN NO LONGER LAND**, on this device's clock: its own time to live (`until`, read from the
 * transaction the wallet signed) and the margin for a device clock ahead of the chain's. Before this the same money is
 * not put in again, and only after it is a deposit the chain does not show said never to have landed.
 */
export const publicDepositCannotLandAfter = (until: number): number => until + DEPOSIT_CLOCKS_MAY_DIFFER_MS;

/* ----------------------------------------------------------- a public deposit */

/** What the vault receives in a public deposit: one public token, and an amount of it in its smallest unit. */
export interface PublicDepositMoney {
  readonly token: Hex;
  readonly value: bigint;
}

/**
 * **THE SERVICE DID NOT SEND THIS PUBLIC DEPOSIT, AND THE WALLET HAS SIGNED IT.** No money has moved, but the signed
 * transaction can still land until `publicDepositCannotLandAfter(until)`, `until` being its own time to live, and if it
 * does, the money goes into this vault. So the same money must not be put in again before then. `refusal` is the
 * service's own answer.
 */
export class PublicDepositSignedNotSent extends Error {
  constructor(readonly vault: Hex, readonly until: number, refusal: unknown) {
    const at = new Date(publicDepositCannotLandAfter(until)).toLocaleTimeString();
    super(`the public deposit was not sent, so no money has moved yet. Your wallet already signed it, and `
      + `until ${at} anyone can still send it. If they do, the money goes into this vault and nowhere else. Do not put `
      + `the same money in again before ${at}, or the vault may receive it twice. The service said: `
      + `${(refusal as Error)?.message ?? String(refusal)}`);
    this.name = 'PublicDepositSignedNotSent';
  }
}

/**
 * **THE WALLET SIGNED A PUBLIC DEPOSIT OTHER THAN THE ONE THIS DEVICE BUILT, AND
 * THIS PAGE DID NOT SEND IT.** The page cannot say no money moved: the wallet
 * holds what it signed and can send it itself until it can no longer land
 * (`publicDepositCannotLandAfter(until)`), so, as for any signed public deposit
 * this page did not send, the money is not put in again before then.
 */
export class PublicDepositNotAsBuilt extends PublicDepositSignedNotSent {
  constructor(vault: Hex, until: number, why: string) {
    super(vault, until, why);
    const at = new Date(publicDepositCannotLandAfter(until)).toLocaleTimeString();
    this.message = `this page did not send the public deposit, because your wallet handed back a deposit other than `
      + `the one this device built: ${why} Your wallet already signed what it handed back, and until ${at} anyone `
      + `holding it, your wallet included, can still send it. Do not put money in again before ${at}. If your wallet's `
      + 'public balance has not dropped by then, no money moved.';
    this.name = 'PublicDepositNotAsBuilt';
  }
}

/**
 * **THE COMPANY CHANGED WHILE THE PERSON APPROVED A PUBLIC DEPOSIT, AND THIS PAGE DID NOT SEND IT.** The company is
 * read again immediately before the send; this is a deposit that check stopped, because the company no longer adopts
 * the vault (`notAdopted`) or because who holds the company, or its records, moved meanwhile. As for any signed public
 * deposit this page did not send, the money is not put in again before it can no longer land.
 */
export class PublicDepositStoppedByAChange extends PublicDepositSignedNotSent {
  constructor(vault: Hex, until: number, readonly notAdopted: boolean, refusal: unknown) {
    super(vault, until, refusal);
    const at = new Date(publicDepositCannotLandAfter(until)).toLocaleTimeString();
    this.message = (notAdopted
      ? 'this page did not send the public deposit, because the company no longer adopts this vault: it was retired after this page first checked it. '
      : 'this page did not send the public deposit, because the company changed while you approved it in your wallet, so it was not sent on what was read before. ')
      + `No money moved. Your wallet already signed the deposit, and until ${at} anyone holding it can still send it. If anyone does, `
      + (notAdopted ? 'the vault refuses it, because it is retired, and no money moves. ' : 'the money goes into this vault. ')
      + `Do not put money in again before ${at}.`;
    this.name = 'PublicDepositStoppedByAChange';
  }
}

/** The change the company's check found before a send, read from the refusal and what caused it, or null for any other refusal. */
const changeFoundIn = (e: unknown): 'not-adopted' | 'changed' | null => {
  for (let at: unknown = e, depth = 0; at instanceof Error && depth < 4; at = at.cause, depth += 1) {
    if (at instanceof VaultNotAdopted) return 'not-adopted';
    if (at instanceof CompanyChangedMeanwhile) return 'changed';
  }
  return null;
};

/**
 * **THE CHAIN TOOK THIS PUBLIC DEPOSIT AND REFUSED IT.** The part of the transaction that carries the vault's public
 * deposit failed, so nothing went into the vault, and the chain will not apply the same transaction again: the money
 * can be put in again at once. Raised only on the chain's own result for that part, read at the wallet's indexer.
 */
export class PublicDepositRefused extends Error {
  constructor(readonly vault: Hex, readonly transactionHash: string) {
    super(`the chain refused this public deposit (${transactionHash}), so nothing went into the vault and it will not `
      + 'be tried again. You can put money in again now.');
    this.name = 'PublicDepositRefused';
  }
}

/**
 * **THIS PUBLIC DEPOSIT CAN NO LONGER LAND, AND THE CHAIN DOES NOT SHOW IT.** Raised only when the wallet's indexer
 * answered cleanly that it holds no such transaction, after the deposit's own time to live (`until`) and the margin for
 * clocks that differ have both passed. Nothing went into the vault, and the money can be put in again.
 */
export class PublicDepositNeverLanded extends Error {
  constructor(readonly vault: Hex, readonly until: number) {
    super(`the public deposit did not reach the chain before ${new Date(until).toLocaleTimeString()}, when it stopped `
      + 'being valid, so it never will and nothing went into the vault. You can put money in again now.');
    this.name = 'PublicDepositNeverLanded';
  }
}

/**
 * **A PUBLIC DEPOSIT MAY HAVE BEEN SENT, AND THIS PAGE HAS NOT SEEN IT ARRIVE.** The
 * money may have moved. Raised for every failure after the service began
 * sending, and when the chain at the wallet's indexer has not shown the deposit
 * by the end of the wait or cannot be looked at, so no screen reads it as a
 * deposit that did not happen. `until` is the deposit's own time to live, read
 * from the transaction the wallet signed; the time it names is
 * `publicDepositCannotLandAfter(until)`. `cause`, when given, is why this page
 * could not see it, and is named for support.
 */
export class PublicDepositNotYetSeen extends Error {
  constructor(readonly vault: Hex, readonly until: number, cause?: unknown) {
    super('the public deposit may have been sent, and this page was not told whether it arrived. Do not put the same '
      + `money in again before ${new Date(publicDepositCannotLandAfter(until)).toLocaleTimeString()}. If it has not arrived by then, it never will. `
      + 'Open your wallet: if its public balance has dropped by this amount and you spent nothing else from it, the '
      + 'vault has it. "Check my last deposit" finds only private deposits, so it cannot tell you about this one.'
      + (cause === undefined ? '' : ` Details for support: ${(cause as Error)?.message ?? String(cause)}`),
      cause === undefined ? undefined : { cause });
    this.name = 'PublicDepositNotYetSeen';
  }
}

/**
 * Whether a failed look for a landed public deposit may come right if it is asked again: the read ran out of time,
 * the vault worker stopped or was too slow, or the indexer could not be read (`NoteIndexUnreadable`, which is also
 * what a transaction not yet indexed looks like). Anything else - the wallet naming no indexer, the indexer refusing
 * the question, bytes the worker cannot read or that carry no identifier - answers the same way every time.
 */
const aLookThatMayClear = (e: unknown): boolean => {
  if (e instanceof ReadRanOutOfTime) return true;
  if (!(e instanceof VaultAskFailed)) return false;
  if (e.reason === 'took-too-long' || e.reason === 'stopped') return true;
  return e.reason === 'answered' && e.workerName === 'NoteIndexUnreadable';
};

export interface PublicDepositDoors extends Pacing {
  readonly service: VaultService;
  readonly builder: VaultBuilderClient;
  readonly company: CompanyLabel;
  readonly account: AccountAddress;
  readonly onChain: VaultOnChainDoors['onChain'];
  readonly indexer: ChainHereDoors['indexer'];
  readonly pay: DepositDoors['pay'];
  /** The time now, in milliseconds. */
  readonly clock?: () => number;
}

const HEX32_TOKEN = /^[0-9a-f]{64}$/u;

/**
 * **A PUBLIC DEPOSIT IS DONE ONLY WHEN THE CHAIN SHOWS IT**, and its hash on the chain is returned. The service's
 * answer, its hash included, is its own word. The deposit is looked for at the indexer the wallet names, by the
 * identifiers of the very transaction the wallet signed, which the service's fee does not change, and judged by the
 * part of it that carries this vault's public deposit (`vaultCallOnChain`). Another deposit of the same token and
 * amount is another transaction and is never taken for this one. A part the chain refused ends the wait at once:
 * nothing went in. A read that may come right if asked again keeps the wait going; one that cannot, or an answer
 * that cannot say whether the deposit took effect, ends it at once as may have been sent. Only a clean answer that
 * the indexer holds no such transaction, once the deposit's own time and the margin for clocks have passed, says it
 * never landed.
 */
async function publicDepositSeenOnChain(
  doors: PublicDepositDoors, vault: Hex, transaction: string, livesUntil: number,
) {
  doors.progress?.('waiting for the chain');
  const clock = doors.clock ?? Date.now;
  let lastFailure: unknown;
  type Look = { readonly found: VaultCallOnChain } | { readonly cannot: unknown } | { readonly never: true };
  const seen = await until<Look>(doors, async () => {
    try {
      const found = await doors.builder.vaultCallOnChain!({
        vault, entryPoints: [PUBLIC_DEPOSIT_ENTRY], transaction, indexer: await theWalletsIndexer(doors, vault),
      });
      if (found.of !== 'not-seen') return { found };
      return clock() > publicDepositCannotLandAfter(livesUntil) ? { never: true } : null;
    } catch (e) {
      lastFailure = e;
      return aLookThatMayClear(e) ? null : { cannot: e };
    }
  });
  if (seen === null) throw new PublicDepositNotYetSeen(vault, livesUntil, lastFailure);
  if ('never' in seen) throw new PublicDepositNeverLanded(vault, livesUntil);
  if ('cannot' in seen) throw new PublicDepositNotYetSeen(vault, livesUntil, seen.cannot);
  if (seen.found.of === 'refused') throw new PublicDepositRefused(vault, seen.found.transactionHash);
  if (seen.found.of !== 'landed') {
    throw new PublicDepositNotYetSeen(vault, livesUntil, new Error(seen.found.of === 'not-known' ? seen.found.why : seen.found.of));
  }
  return seen.found.transactionHash;
}

/**
 * **A PUBLIC TOKEN PUT INTO THE COMPANY'S VAULT AS IT IS.**
 *
 * The vault's public deposit takes one token and one amount; the chain adds them
 * to the vault's public balance, which anyone can read. So, unlike a private
 * deposit, **NOTHING IS CHOSEN, KEPT OR RECORDED ON THIS DEVICE**: there is no
 * coin, no nonce, no journal line and no note, and a vault that holds only
 * public money needs no record of its own to be paid out of.
 *
 *   1. the vault, read on this device, must be adopted by the company's account,
 *      pinned to it and started, with every circuit of it and of the account this
 *      app's, as for a private deposit; the chain's parameters are read the same way;
 *   2. the deposit is built and proved in the vault worker, which refuses one
 *      that would ask for anything but this token and this amount;
 *   3. the signer's own wallet pays the public amount and signs, after showing
 *      the token, the amount, and that both are public;
 *   4. the wallet's answer must name exactly this token and this amount leaving
 *      it, or nothing is sent;
 *   5. the transaction the wallet signed is read on this device: its
 *      identifiers, its earliest time to live, and what it puts into the vault,
 *      which must be exactly the call built here, taking this token and this
 *      amount once (`whyNotTheDepositBuilt`). One this device cannot read, that
 *      is not the deposit built, or that can no longer land, is not sent;
 *   6. the service is handed the transaction and nothing else; it adds the
 *      network fee and sends it, and refuses one that is not exactly one
 *      public token, a positive amount of it, into this vault;
 *   7. this device waits until the chain at the wallet's indexer shows the very
 *      transaction the wallet signed with the part carrying this vault's public
 *      deposit applied, and only then says it is done. It returns the chain's
 *      hash of that transaction, never the service's. A deposit whose part the
 *      chain refused ends at once with nothing paid in, and one the indexer
 *      still does not hold once its time to live and the margin for clocks
 *      have passed never landed.
 *
 * **WHY NOTHING IS KEPT ON THIS DEVICE.** A private deposit is kept here
 * until the chain holds it because its coin was chosen here and its note must
 * be recorded, and a second deposit must not choose the same coin. A public
 * deposit has none of those: if this page closes during the wait there is
 * nothing on this device to finish, and the wallet's public balance and the
 * chain say whether it arrived.
 */
export async function depositPubliclyIntoCompanyVault(
  doors: PublicDepositDoors, vault: Hex, money: PublicDepositMoney,
): Promise<{ txRef: string; transactionHash: string; token: Hex; value: bigint }> {
  /* The token as the asset's row names it: 64 lowercase hex characters, compared and sent as it is. */
  if (typeof money.token !== 'string' || !HEX32_TOKEN.test(money.token)) {
    throw new Error('this is not a public token a vault can hold, so nothing was built or sent. No money moved. Reload the page and try again; if it happens again, the service needs attention.');
  }
  if (typeof money.value !== 'bigint' || money.value <= 0n) throw new Error('an amount of nothing is not a deposit.');
  if (typeof doors.service.depositPublicly !== 'function') {
    throw new Error('this page cannot send a public deposit, so nothing was built or sent. No money moved. Reload the page and try again; if it happens again, the service needs attention.');
  }
  doors.progress?.('checking the vault');
  const answer = await takesDepositsOrThrow(doors, vault);
  /* Asked before the wallet is, so a deposit into a vault not yet started asks the wallet for nothing. */
  if (answer.of !== 'fundable') throw new Error(answer.why);
  const view = answer.view;
  if (view.state === undefined) throw new Error('the chain does not show this vault\'s state, so no money goes in.');
  const parameters = await chainParametersForADeposit(doors, vault);
  if (typeof doors.builder.publicDeposit !== 'function') {
    throw new Error('this page cannot build a public deposit, so nothing was built or sent. No money moved. Reload the page and try again; if it happens again, the service needs attention.');
  }
  /* A deposit this page could not read or watch arrive would end with nobody able to say it did, so it is not started. */
  if (typeof doors.builder.vaultCallOnChain !== 'function' || typeof doors.builder.readTransaction !== 'function') {
    throw new Error('this page cannot watch the chain for a public deposit, so nothing was built or sent. No money moved. Reload the page and try again; if it happens again, the service needs attention.');
  }
  doors.progress?.('building the deposit');
  const built = await doors.builder.publicDeposit({
    vault, token: money.token, amount: money.value.toString(), state: view.state, parameters,
  });
  doors.progress?.('asking your wallet');
  const paid = await doors.pay({ company: doors.company, account: doors.account, vault: vault as VaultAddress, transaction: built.tx });
  /*
   * **WHAT THE WALLET SAYS LEFT IT MUST BE WHAT WAS ASKED.** The wallet reads the
   * amount from the transaction, not from this page; an answer naming anything
   * else is not sent. What it booked is let go when the transaction can no
   * longer be sent.
   */
  const leaves = Array.isArray(paid?.leaves) ? paid.leaves as readonly { token?: unknown; amount?: unknown; kind?: unknown }[] : [];
  if (leaves.length !== 1 || leaves[0]?.kind !== 'unshielded'
    || String(leaves[0]?.token).toLowerCase() !== money.token || String(leaves[0]?.amount) !== money.value.toString()) {
    throw new Error('your wallet prepared a payment for something other than this public deposit, so this page did not '
      + 'send it and no money moved. You can put money in again now.');
  }
  /*
   * **WHEN IT CAN NO LONGER LAND, READ FROM WHAT THE WALLET SIGNED.** Every intent's time to live is checked by the
   * chain, so the earliest is the deposit's; the fee the service merges in can only end it sooner. A transaction this
   * device cannot read, or that names nothing to look for it by, could never be followed to the chain, and one already
   * past its time could never land: neither is sent.
   */
  const read = await doors.builder.readTransaction!({ transaction: paid.transaction });
  if (read === null || read.timeToLive === null || read.identifiers.length === 0) {
    throw new Error('this page could not read the public deposit your wallet signed, so it did not send it and no '
      + 'money moved. You can put money in again now.');
  }
  const livesUntil = read.timeToLive;
  if ((doors.clock ?? Date.now)() >= livesUntil) {
    throw new Error(`the public deposit your wallet signed stopped being valid at ${new Date(livesUntil).toLocaleTimeString()}, `
      + 'so this page did not send it and no money moved. You can put money in again now.');
  }
  /*
   * The wallet's own account of what it paid (`leaves`) is its word; the transaction it signed is what lands. One that
   * is not the deposit built here is not sent, and, being signed, is said to be still sendable until it can no longer land.
   */
  const builtRead = await doors.builder.readTransaction!({ transaction: built.tx }).catch(() => null);
  const notAsBuilt = whyNotTheDepositBuilt(read, builtRead, { vault, token: money.token, amount: money.value });
  if (notAsBuilt !== null) throw new PublicDepositNotAsBuilt(vault, livesUntil, notAsBuilt);
  doors.progress?.('sending the deposit');
  let sent: { txRef: string; transactionHash: string | null };
  try {
    sent = await doors.service.depositPublicly(vault, paid.transaction);
  } catch (e) {
    if (!sentNothing(e)) throw new PublicDepositNotYetSeen(vault, livesUntil);
    const change = changeFoundIn(e);
    if (change !== null) throw new PublicDepositStoppedByAChange(vault, livesUntil, change === 'not-adopted', e);
    throw new PublicDepositSignedNotSent(vault, livesUntil, e);
  }
  const transactionHash = await publicDepositSeenOnChain(doors, vault, paid.transaction, livesUntil);
  doors.progress?.('done');
  return { txRef: sent.txRef, transactionHash, token: money.token, value: money.value };
}
