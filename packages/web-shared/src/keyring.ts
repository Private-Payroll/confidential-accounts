/**
 * The client half of identity.
 *
 * Nothing here can decrypt the person's saved keys or sign as their seat: the
 * server holds a sealed blob it cannot open, and this page holds that sealed
 * copy too, and opens it never. Only the person's wallet opens and changes it.
 *
 * What is in memory while signed in:
 *   read     what the wallet read from the saved keys for this tab: each seat's
 *            public halves and scope, each company's viewing key it opened and
 *            believed, and its public name for the person (`KeysRead`)
 *   keyring  the saved keys' parts that open nothing (the creations, what is
 *            owed), as the wallet last said them; it never holds a seat
 *   releasedCompanyKey  a company's key the wallet released, with the company
 *
 * **AND WHAT IS NOT IN THIS PAGE AT ALL: THE SIGN-IN ITSELF.** It is a cookie the
 * server sets and this page's code cannot read, so no script here can copy it
 * off the machine, and the browser sends it with every request to this site.
 *
 * What survives a page reload: the sign-in, and nothing else. A reload keeps
 * you signed in and does not keep a company open: **the wallet is asked to read
 * the saved keys again**, because keeping what it read in storage would put it
 * where any script on the page can read it.
 */
import { isReadMethod, serviceRead } from './read-bound.js';
import type { KeysHeld } from '../../../src/core/company-key.js';
import type { Inviter, SignedSeatInvitation } from '../../../src/core/invitation.js';
import type { DirectoryHereDeps, OwedDirectoryEntry } from './vault-page-doors.js';
import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountAddress, CompanyLabel, VaultAddress } from 'midnight-identity/profile/company-label';
import { toHex, type Hex, type Sealed } from '../../../src/core/crypto.js';
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import { PAY_KEY_COMMITMENT_ENTRY } from 'midnight-identity/profile/records-key';
import {
  askWalletToSignIn, openWalletDialog, US_TO_A_WALLET, WalletClosed, type Openable, type WalletDialog,
} from './wallet-sign-in.js';
import { actInTheWallet, type ActOutcome } from './wallet-act.js';
import { pageWireSend } from './http-sealed-pool-store.js';
import type { StepAt } from 'midnight-identity/profile/channel';
import type { KeyringHandedIn, KeysRead, SealedKeyring } from 'midnight-identity/profile/unlock';
import { MOST_SERVED, type FoundingAsked, type ServedHandedIn } from 'midnight-identity/profile/request';
/* The screen that draws the waiting needs the type, and it should not have to
 * know which file below this one the wallet plumbing lives in. */
export type { WalletDialog } from './wallet-sign-in.js';
import { askWalletForKeys } from './wallet-unlock.js';
import { askWalletToPay } from './wallet-balance.js';
import { askWalletToSignCommittee, type CommitteeAsked } from './wallet-committee.js';
import {
  askWalletToSignRecordsKey, askWalletWhoHolds, type HoldersAsked, type HoldersRead, type RecordsKeyAsked, type RecordsKeySigned,
} from './wallet-records-key.js';
/* **THE WALLET IS SHOWN INSIDE THIS PAGE.** Every journey below defaults to it;
 * a test hands in a window of its own and drives the same conversation. */
import { walletInThisPage, walletQuietlyInThisPage } from './wallet-frame.js';

/** A company as this device opened it: the entries it believes, and each entry it refused with why, for a screen to say. */
export type { OpenedAccount } from './company-judges.js';
import { openAccountWith, seatsAdmittedWith, type OpenedAccount } from './company-judges.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import {
  COMPANY_CREATION_STATES, type CompanyCreationState,
} from '../../../src/core/company-founding.js';
import type { AccountPresenceOnTheWire } from './vault-worker-client.js';

export type { CompanyCreationState } from '../../../src/core/company-founding.js';
import { seatToPromote } from './seat-repair.js';
import type { SealedAccount } from '../../../src/core/types.js';
import { onlyCompanyLabels, rememberedCompanies } from './my-payslips.js';
import {
  metadataFrom, type Keyring, type PendingSeat, type SavedCreation, type SeatPublicHalves,
} from './keyring-blob.js';
/* The keyring's format is defined once, beside this file, and read by the person's wallet too. */
export type { AccountKeys, Keyring, PendingSeat, SavedAccountKeys, SavedCreation } from './keyring-blob.js';
export { creationsInOneRecord } from './keyring-blob.js';
export type { SeatPublicHalves } from './keyring-blob.js';

export interface Me { id: string; email: string | null; name: string }

/**
 * **WHETHER THIS TAB HAS A LIVE SESSION.** Not the sign-in: that is a cookie
 * this code cannot read. Set by a sign-in or by `resumeSession`, and cleared by
 * a sign-out or the first `401`.
 */
let sessionLive = false;
/**
 * **WHAT THE WALLET READ FROM THE SAVED KEYS FOR THIS TAB, OR NULL BEFORE IT HAS** (`KeysRead`). Never a key and never
 * a seat's secret: each seat's public halves and scope, each company's viewing key the wallet opened and believed, and
 * the wallet's public name for this person. The saved keys themselves stay sealed: this tab carries the sealed copy
 * between the service and the wallet and never opens it. `partial` when it came from an action's end answer in a tab
 * the wallet had not read the saved keys for: then it holds the action's own company and nothing else, and every other
 * company still needs the wallet to read them.
 */
let read: { seats: Record<string, SeatPublicHalves>; viewing: Record<string, Hex>; holder: string; partial?: true } | null = null;
/**
 * **THE PARTS OF THE SAVED KEYS THAT OPEN NOTHING, AS THE WALLET LAST SAID THEM** (`metadataFrom`): the creations and
 * what is owed. Held as a keyring with no seats in it, so the reads below keep their shape; it never holds a seat.
 */
let keyring: Keyring = { accounts: {} };
let me: Me | null = null;
/**
 * WHAT VERSION OF THE BUNDLE THIS TAB LAST SAW.
 *
 * Sent with every write so the server can refuse one that did not see the last
 * one — without it, two devices signed in silently overwrite each other.
 * **Registration counts as the first write on BOTH sides**: they disagreed
 * once, and every write a new account made was then refused as stale, for ever,
 * with a message telling the person to reload.
 */
let bundleVersion = 0;
/**
 * THE SUBWALLET THIS TAB SIGNED IN AS, or null while this tab has not signed in with a wallet.
 *
 * This module keeps it in memory only, like what the wallet read for it, and writes it nowhere. The
 * server holds only a hash of it (`walletKeyOf`), so after a reload it is back
 * only when the screen that made the sign-in chose to carry it across in its
 * own tab and hands it to `resumeSession` (`SignInCarried`).
 */
let walletAddress: string | null = null;
/**
 * **THE KEY THE WALLET RELEASED, AND WHICH COMPANY IT WAS RELEASED FOR.**
 *
 *
 * What the wallet read from the saved keys cannot answer this: nothing in it says which company's key a release
 * gave, **which is exactly why a second variable is needed here.** A payslip
 * keypair made from any key but the one the wallet released for this company
 * would be a perfectly usable keypair that no wallet, no second device and no
 * recovery can ever work out again - payslips sealed to a key nobody can
 * rebuild, because every test of the sealing would still pass.
 *
 * So the ACCOUNT ID travels with the bytes. A payslip key may be derived only
 * when this says the bytes came from the wallet **for that same company**, and
 * `companyKeyReleasedFor` answers null for every other state rather than
 * handing back something that would work.
 *
 * In memory only, dropped on sign-out and replaced whenever the wallet gives a
 * company's key: a reload asks the wallet again.
 */
let releasedCompanyKey: {
  accountId: string;
  key: Hex;
  /** The company's label the wallet was asked about, which is what a payslip key from `key` names. */
  label: CompanyLabel;
  /** The account the wallet read that label off, or null when the company has none yet. */
  account: AccountAddress | null;
  /** Public. Given in the same answer as the company key, so it is that wallet's. */
  committeeKey: { tag: string; value: string } | null;
} | null = null;
/**
 * **WHAT THE SERVER HOLDS SAVED FOR THIS PERSON, AS LAST READ HERE AND OPENED BY THE WALLET.**
 *
 * `none` is a person with no saved keys at all on this deployment; `some` is a
 * saved bundle, which the wallet has opened for this tab. Null until it has.
 *
 * It is what lets a company this tab cannot open say something true. A person
 * has ONE saved bundle and every device and every wallet release reaches the
 * same one, so once it has been opened, a company missing from it is missing
 * everywhere this deployment could offer it - not merely missing from this
 * device.
 */
let savedKeys: 'none' | 'some' | null = null;
/**
 * **WHETHER WHAT THIS TAB HOLDS WAS READ BY THE WALLET THIS TAB SIGNED IN WITH.**
 *
 * True only when the wallet was asked naming the address this tab's own
 * sign-in answer carried - and a wallet answers that only when one of its own
 * accounts has exactly that address. A tab that did not sign anybody in (a
 * reload, a second tab) does not know the address and asks without it.
 *
 * **IT DECIDES ONE THING: WHETHER A PERSON'S FIRST KEYS MAY BE SAVED FROM HERE.**
 * Once keys are saved, any other wallet fails to open them and refuses, so what
 * is saved is its own check. Before anything is saved there is nothing to check
 * against, and the keys saved first are sealed by whichever wallet answered - so
 * they are saved only from an answer this tab asked for with the address it signed in as.
 */
let keyCheckedAgainstSignIn = false;
/**
 * **WHY THIS TAB LAST FORGOT ITS SESSION, WHEN A SERVER ANSWER MADE IT.**
 *
 * A `401` means the server holds no session for this browser's cookie. A `409`
 * means the cookie now belongs to somebody else, signed in from another tab.
 * Signing out needs the difference: after the first there is nothing to end,
 * and after the second a sign-out sent from here would end THEIR session.
 */
let forgotBecause: 'no-session' | 'another-person' | null = null;

export const currentUser = () => me;
export const signedInWallet = () => walletAddress;
/**
 * **THE COMPANY KEY THIS TAB HOLDS FOR `accountId`, OR NULL.**
 *
 * Null is the ordinary answer and is never an error to paper over: a tab whose
 * wallet has released no key for a company holds none, and a tab that unlocked a DIFFERENT
 * company holds one that would derive the wrong payslip keypair. The caller
 * refuses by name; nothing here substitutes.
 */
export const companyKeyReleasedFor = (accountId: string): Hex | null =>
  releasedCompanyKey?.accountId === accountId ? releasedCompanyKey.key : null;

/* Who is told when the person's wallet releases a company's key to this tab. */
const releaseWatchers = new Set<(accountId: string) => void>();

/**
 * Calls `watch` with the company's id each time the person's wallet releases that company's key to this tab, so a
 * read that needed it (what a vault holds privately) can be made again; the answer stops it. A watcher that throws
 * stops neither the release nor the others.
 */
export function watchCompanyKeyReleased(watch: (accountId: string) => void): () => void {
  releaseWatchers.add(watch);
  return () => { releaseWatchers.delete(watch); };
}
/**
 * **THE PUBLIC KEY THIS PERSON SITS ON `accountId`'s VAULT COMMITTEE WITH**, from
 * the same answer as the company key this tab holds, or null. The key that signs
 * with it never reaches this page.
 */
export const committeeKeyReleasedFor = (accountId: string): { tag: string; value: string } | null =>
  releasedCompanyKey?.accountId === accountId ? releasedCompanyKey.committeeKey : null;
export const isSignedIn = () => sessionLive && me !== null;
/**
 * **WHETHER THIS TAB CAN OPEN A COMPANY, WHICH IS NOT THE SAME QUESTION AS
 * WHETHER IT IS SIGNED IN.**
 *
 * Every company's viewing key is reached through the saved keys, which only the
 * person's wallet opens. A wallet sign-in produces a signature, and *a signature
 * is not a key*, so signing in opens nothing. This tab can open a company once
 * the wallet has read the saved keys for it (`read`), after a person pressed a
 * button on the wallet's own screen: the seats' public halves and the viewing
 * keys the wallet opened, never a key the saved keys open with. A read an action left for its own company alone opens
 * that company (`accountId`) and no other.
 */
export const canOpenCompanies = (accountId?: string): boolean => read !== null
  && (read.partial !== true || (accountId !== undefined && Object.prototype.hasOwnProperty.call(read.viewing, accountId)));

/** The saved keys the service holds now are older than what the wallet last read for this tab, or are gone. */
const WENT_BACK = 'what is saved for you here is older than what this tab already read, or is gone, '
  + 'so it has not been taken in place of what this tab holds. Something has changed on the '
  + 'server that this page cannot explain. Do not close or reload this tab or sign out until it is understood.';

/** A second answer, in a tab the wallet already read the saved keys for, from a wallet that is not the same one. */
const NOT_THE_SAME_WALLET = 'the wallet that answered is not the one that read your saved keys for this tab, so nothing it '
  + 'gave has been used. Answer with the wallet you signed in with.';

/**
 * **A PERSON'S FIRST KEYS ARE SAVED ONLY FROM A TAB THAT CAN TELL WHICH WALLET
 * SIGNED IN** (`keyCheckedAgainstSignIn` says why). This is the refusal when
 * this tab did not sign them in: its own class so a screen can tell it apart
 * and say it in its own words; its message is `FIRST_KEYS_NEED_THE_SIGN_IN`.
 */
export class FirstKeysNeedTheSignIn extends Error {}

const FIRST_KEYS_NEED_THE_SIGN_IN = 'nothing is saved for you here yet, and this tab did not sign you '
  + 'in, so it cannot make sure that the wallet answering is the one you signed in with before your '
  + 'first keys are saved under its key. Nothing has been created or saved. Sign in again in this tab, '
  + 'with the same wallet address, and try again.';

/**
 * The company this tab is waiting to finish was started by somebody other than
 * the person signed in here now. Its own class so a screen can tell it apart
 * and say it in its own words; nothing is saved and the company stays waiting
 * for the person who started it.
 */
export class CompanyStartedBySomebodyElse extends Error {}

const STARTED_BY_SOMEBODY_ELSE = 'the company waiting to be finished in this tab was started by '
  + 'somebody else, who is not the person signed in here now. Its keys are never saved into yours. '
  + 'Nothing has been saved; the person who started it can sign in again in this tab to finish it.';

/**
 * **THIS SIGNER'S SEAT FOR A COMPANY, AS THE WALLET READ IT: ITS PUBLIC HALVES AND SCOPE, AND NOTHING ELSE**, or null
 * when the saved keys the wallet read for this tab hold no seat for it. Nothing here signs, opens or proves.
 */
export const seatHeldHere = (accountId: string): SeatPublicHalves | null =>
  (read !== null && Object.prototype.hasOwnProperty.call(read.seats, accountId) ? read.seats[accountId]! : null);

/**
 * **THE PUBLIC HALF OF THIS SIGNER'S SEAT FOR A COMPANY, AND NOTHING ELSE**: its signing public key, by which a read finds
 * the seat's own directory entry and its leaf there. A read of a vault's private money takes this and never the seat's
 * secrets, so it can sign or prove nothing. It is what the wallet read from the saved keys for this tab; null when that
 * holds no seat for the company.
 */
export async function seatShownHere(accountId: string): Promise<{ readonly signingPublicKey: Hex } | null> {
  const seat = seatHeldHere(accountId);
  return seat === null ? null : Object.freeze({ signingPublicKey: seat.signingPublicKey.toLowerCase() as Hex });
}

/**
 * **A COMPANY'S VIEWING KEY AS THE WALLET OPENED IT FOR THIS TAB**: the one wrapped to this signer's seat, given only when
 * it made the company's inbox public key. Throws when the wallet gave none, so a read refuses rather than guesses.
 */
export function viewingKeyFor(account: { id: string; wrappedKeys: any[] }): Hex {
  if (seatHeldHere(account.id) === null) throw new Error('no keys for this account on this device');
  const key = read?.viewing[account.id];
  if (key === undefined) throw new Error('you have not been granted access to this account yet');
  return key;
}

/* ---------------- transport ---------------- */

export class AuthError extends Error {}
/**
 * The sign-in this tab sent belongs to somebody else. Still an `AuthError` to
 * every caller that only asks whether the tab is signed in; told apart where it
 * matters, which is signing out - that session is still live in this browser.
 */
export class AnotherPersonError extends AuthError {}

/**
 * The service answered 503 `could-not-check`: it could not look up whether this sign-in is live. It
 * says nothing about the person, so it is NOT an `AuthError`: nobody is signed out for it and
 * nothing is forgotten. The page keeps the person signed in and asks again.
 */
export class CouldNotCheckError extends Error {}

/** How long `resumeSession` waits before each new ask when the service could not check, then gives up. */
export const RESUME_BACKOFF_MS: readonly number[] = [600, 1500, 4000];
/**
 * The wallet did not say what the keys saved for this person hold, or a second
 * answer came from another wallet than the one that read them for this tab.
 * Nothing was used and nothing was written.
 */
export class SavedKeysDidNotOpen extends Error {}
/**
 * What is saved for this person is older than what this tab already read, or is
 * gone. It is not taken in place of what this tab holds.
 */
export class SavedKeysWentBack extends Error {}

/** Starting a creation again was asked for a company this browser keeps no creation for. */
export class NoCreationKeptHere extends Error {}

/** The service holds no record at the address asked for (a 404). The message is the service's own. */
export class NotOnTheService extends Error {}

/**
 * The service refused a request, and what its refusal carried besides the words: whether nothing was sent, and for what.
 * `code` is the reason a fee was not paid (`fee-not-paid`, `network-refused`), kept only from a 422 whose body says
 * nothing was sent; any other answer, a 502 included, leaves it unset.
 */
export class ServiceRefused extends Error {
  readonly code: 'fee-not-paid' | 'network-refused' | undefined;
  constructor(message: string, readonly body: Record<string, unknown>, status?: number) {
    super(message);
    const named = body['code'];
    this.code = status === 422 && body['nothingWasSent'] === true && (named === 'fee-not-paid' || named === 'network-refused') ? named : undefined;
  }
}

const apiOnce = async (path: string, opts?: RequestInit) => {
  const r = await fetch(path, {
    ...opts,
    /* The sign-in cookie rides on this, and only to this page's own origin. */
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      /* **WHO THIS TAB WAS PREPARED FOR.** The sign-in is the browser's, so a
       * sign-in in another tab changes it under this one; the server refuses a
       * request whose session is somebody else, rather than letting this tab's
       * keys be written under them. */
      ...(me ? { 'x-signed-in-as': me.id } : {}),
      ...(opts?.headers ?? {}),
    },
  });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401) {
    forgetLocally();
    forgotBecause = 'no-session';
    throw new AuthError(body?.error ?? 'not signed in');
  }
  if (r.status === 409 && body?.code === 'another-person') {
    forgetLocally();
    forgotBecause = 'another-person';
    throw new AnotherPersonError(body.error);
  }
  if (r.status === 503 && body?.code === 'could-not-check') throw new CouldNotCheckError(body?.error ?? 'the service could not check your sign-in');
  if (r.status === 404) throw new NotOnTheService(body?.error ?? `request failed: ${r.status}`);
  if (!r.ok) throw new ServiceRefused(body?.error ?? `request failed: ${r.status}`, typeof body === 'object' && body !== null ? body : {}, r.status);
  return body;
};

export const api = (path: string, opts?: RequestInit & { read?: boolean }) => {
  const { read, ...init } = opts ?? {};
  if (read !== true && !isReadMethod(init.method)) return apiOnce(path, init);
  return serviceRead(`The service (${path.split('?')[0]})`, (signal) => apiOnce(path, { ...init, signal }));
};

/* ---------------- sign in and out ---------------- */

/*
 * **`signInWithWallet` BELOW IS THE ONLY WAY IN**, and `openKeysWithWallet` is
 * what has the wallet read the saved keys for this tab. Nothing in this module
 * produces a key from a typed secret: every key it holds was released by the
 * person's wallet, and none of them opens the saved keys.
 */

/* ---------------- the wallet dialog, and the page behind it ---------------- */

/**
 * **THE PAGE BEHIND THE DIALOG HAS TO SHOW THAT IT IS WAITING.**
 *
 * A person who presses a button, sees nothing change, and cannot see the window
 * that opened behind their browser presses it again — and a second press is a
 * second ask. So every wallet ask in this module announces itself: the screen
 * subscribes once, draws *waiting for your wallet* while a dialog is open, and
 * offers the way out that `WalletDialog.giveUp` is.
 *
 * It is a subscription rather than a parameter because the asks are started
 * from four different places on three different screens, and a callback
 * threaded through all of them is a callback one of them forgets.
 */
type WalletWaiting = (dialog: WalletDialog | null) => void;

const watching = new Set<WalletWaiting>();

/** Returns the way to stop watching. Call it from an effect's cleanup. */
export function onWalletWaiting(watch: WalletWaiting): () => void {
  watching.add(watch);
  return () => { watching.delete(watch); };
}

const nowWaiting = (dialog: WalletDialog | null): void => {
  for (const watch of watching) watch(dialog);
};

/**
 * **THE WINDOW IS OPENED HERE, AND EVERY CALLER CALLS THIS BEFORE ITS FIRST
 * `await`.** That is the whole repair, and it is one line at each of
 * the four call sites rather than a rule written down somewhere.
 *
 * `already` is the dialog a longer journey opened in its own click — creating a
 * company opens the wallet in the press, then talks to this server, then asks
 * the wallet — so the second half does not open a second window.
 */
function openTheWallet(
  view: Openable, walletOrigin: string, already?: WalletDialog,
): WalletDialog {
  const dialog = already ?? openWalletDialog(view, walletOrigin);
  nowWaiting(dialog);
  return dialog;
}

/** Nothing is waiting on a wallet any more, however it ended. */
const doneWaiting = (): void => { nowWaiting(null); };

/**
 * **A JOURNEY THAT OPENS ITS OWN DIALOG ANNOUNCES IT HERE.** Accepting an
 * invitation drives two asks through one dialog it owns, so it does not come
 * through `openTheWallet` - and a wallet shown with no dialog announced has a
 * *Stop waiting* that can hide the wallet but cannot refuse the ask in flight.
 * Returns the way to stop announcing; call it when the journey ends.
 */
export function showWaitingFor(dialog: WalletDialog): () => void {
  nowWaiting(dialog);
  return doneWaiting;
}

/**
 * **A JOURNEY THAT FAILED PUTS ITS WALLET AWAY BEFORE IT STOPS SAYING IT IS WAITING.**
 *
 * Every wallet journey opens the wallet in the press and then talks to this
 * server. When that talk fails the ask never ran, so nothing closed the wallet
 * - and `doneWaiting` then removed the one control that could, leaving a wallet
 * on screen with nothing able to put it away. `giveUp` is safe after anything:
 * an ask that already ended has already closed it, and a second close is not a
 * second event.
 */
const putAway = (dialog: WalletDialog): void => { dialog.giveUp(); };

/**
 * SIGNING IN WITH THE WALLET. `docs/scope-payroll-identity.md` §10 step 1.
 *
 * Three steps and no password anywhere in them: ask this server for a nonce,
 * open the wallet and have it sign one payload naming this origin, hand the
 * answer back for the server to check.
 *
 * **NOTHING IS BELIEVED HERE.** The signature is checked on the server, which
 * is the thing that signs a person in; a check made by the page being persuaded
 * is not a check. What this function decides is only which window it will
 * listen to.
 *
 * `inviteToken` is passed through when the person arrived on an invitation, and
 * it is the only thing that lets the reused-subwallet refusal happen at sign-in
 * rather than one step later — a sign-in with no company in it cannot be judged
 * against a company.
 */
export async function signInWithWallet(
  walletOrigin: string, inviteToken?: string,
  /* The window, injected so the whole conversation can be driven in a test
   * with no browser — the shape `openKeysWithWallet` has too. */
  view: Openable = walletInThisPage(window),
): Promise<Me> {
  /*
   * **OPENED HERE, IN THE CLICK, BEFORE ONE BYTE HAS BEEN AWAITED.**
   * The deliberate defect for this order moves this line below the challenge
   * and a test dies by name.
   */
  const dialog = openTheWallet(view, walletOrigin);
  try {
    const challenge = await api('/api/auth/wallet/challenge', { method: 'POST' });
    const response = await askWalletToSignIn(view, walletOrigin, {
      nonce: challenge.nonce,
      /* The wallet refuses an ask that has already expired, so the deadline is
       * the challenge's own rather than a second number that could disagree. */
      expiresAt: Date.parse(challenge.expiresAt),
      name: US_TO_A_WALLET.name,
      rdns: US_TO_A_WALLET.rdns,
      purpose: 'So this company knows it is you. Nothing else is asked for.',
    }, dialog);
    return await finishWalletSignIn(challenge, response, inviteToken);
  } catch (e) {
    putAway(dialog);
    throw e;
  } finally {
    doneWaiting();
  }
}

/** Everything after the wallet answered. Split out so the ask above reads as
 * one thing: open the window, get the answer, hand it to the server. */
async function finishWalletSignIn(
  challenge: { handle: string; nonce: string },
  response: unknown,
  inviteToken?: string,
): Promise<Me> {
  const r = await api('/api/auth/wallet', {
    method: 'POST',
    body: JSON.stringify({
      handle: challenge.handle, nonce: challenge.nonce, response,
      ...(inviteToken ? { inviteToken } : {}),
    }),
  });
  return takeTheSignIn(r);
}

/**
 * **A SIGN-IN MADE IN THIS TAB BY ANOTHER SCREEN, TAKEN THE WAY THIS MODULE TAKES ITS OWN.**
 *
 * A screen that signs the person in with its own code, over the same routes,
 * hands over the service's answer to `POST /api/auth/wallet` exactly as it
 * came back. What this module keeps from it is what it keeps from its own
 * sign-in, by the same lines: who signed in and the address the service says
 * the sign-in was for. The address only gates: the wallet gives the key a
 * person's first keys are saved under only when one of its own accounts has
 * that address, so an address the wallet does not hold saves nothing.
 *
 * An answer without a person or an address is refused, and this tab is left
 * as it was.
 */
export function signedInByAnotherScreen(answer: unknown): Me {
  const a = (answer ?? {}) as { user?: { id?: unknown; name?: unknown }; address?: unknown };
  if (typeof a.user?.id !== 'string' || typeof a.user.name !== 'string' || typeof a.address !== 'string' || a.address === '') {
    throw new Error('the sign-in answer handed over names no person or no address, so this tab did not take it.');
  }
  return takeTheSignIn(a as { user: Me; address: string });
}

/** What this tab keeps from a sign-in the service answered, however this tab asked for it. */
function takeTheSignIn(r: any): Me {
  /* NO TOKEN IS READ OFF THE ANSWER. A browser's sign-in answer does not carry
   * one: the server set the sign-in as a cookie this page cannot read. */
  sessionLive = true;
  walletAddress = r.address;
  savedKeys = null;
  keyCheckedAgainstSignIn = false;
  /* A sign-in releases nothing. The unlock is what does. */
  releasedCompanyKey = null;
  /* NOTHING READ FROM THE SAVED KEYS. See `canOpenCompanies` — this is not an
   * omission here, it is the state of the product after this proposal. */
  read = null;
  keyring = { accounts: {} };
  tidyOwed.clear();
  me = r.user;
  bundleVersion = 0;
  return r.user as Me;
}

/**
 * **THE ADDRESS A SIGN-IN WAS FOR, CARRIED ACROSS A RELOAD BY THE SCREEN THAT
 * MADE IT**, and whom it was for. The service does not say the address again
 * after a reload, so a screen that wants a first company to need no second
 * sign-in keeps what the sign-in answer said, in its own tab, and hands it back
 * to `resumeSession`.
 */
export interface SignInCarried {
  readonly personId: string;
  readonly address: string;
}

/**
 * **PICKING UP THE SIGN-IN THIS BROWSER ALREADY HAS, AFTER A RELOAD.**
 *
 * The page cannot see the cookie, so it asks the server who it is. An answer
 * is a person still signed in and they are not sent back through their wallet;
 * a `401` is nobody, and `api` has already forgotten everything on its way
 * past. **It opens no company**: the key that does is the wallet's to release
 * again, and nothing here pretends otherwise.
 *
 * **`carried`, WHEN A SCREEN KEPT IT, GIVES BACK THE ADDRESS THE SIGN-IN WAS
 * FOR**, and is taken only when it names the person the service says is signed
 * in now. The address only gates, as it does after a sign-in in this tab: the
 * wallet gives the key a person's first keys are saved under only when one of
 * its own accounts has exactly that address. With nothing carried, or carried
 * for somebody else, the address is left as it was.
 *
 * Null for nobody. Any other failure is thrown, so a server that is down is not
 * reported as a person who is signed out.
 */
export async function resumeSession(
  carried: SignInCarried | null = null,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => { setTimeout(done, ms); }),
): Promise<Me | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await api('/api/me');
      sessionLive = true;
      me = r.user as Me;
      if (carried !== null && carried.personId === me.id && typeof carried.address === 'string' && carried.address !== '') {
        walletAddress = carried.address;
      }
      return me;
    } catch (e) {
      if (e instanceof AuthError) return null;
      const notChecked = e instanceof CouldNotCheckError || e instanceof TypeError;
      if (!notChecked || attempt >= RESUME_BACKOFF_MS.length) throw e;
      await wait(RESUME_BACKOFF_MS[attempt]!);
    }
  }
}

/**
 * **HAVING THE PERSON'S WALLET READ THE KEYS SAVED FOR THEM, FOR THIS TAB.**
 *
 * One press on the wallet's own screen, and a password appears nowhere:
 *
 *   1. **read the keys saved for this person, sealed, and each listed company's
 *      viewing key wrapped to its seats**, from the service;
 *   2. **hand them to the wallet**, naming the person signed in here and - when
 *      this tab signed them in - the address it signed in as. The wallet opens
 *      the saved keys itself, and answers only if one of its own accounts has
 *      that address (`wallet-unlock.ts`), with what they hold that is not secret:
 *      each seat's public halves and scope, each company's viewing key it opened
 *      and believed, the creations and what is owed (`KeysRead`).
 *
 * **NOTHING SECRET COMES BACK.** The saved keys stay sealed in this tab, and no
 * seat's secret or key they open with is in the answer. **THE COMPANY OPENED**
 * (`opening`, its record's id), when the service names the account that carries
 * its label, is named in the same ask: the wallet gives that company's key in the
 * same answer only when its own read of the chain confirms the account carries
 * the label, and otherwise opens the saved keys alone. A key given is taken in as
 * `companyKeysForVaults` takes it, so the company's vault balances can be read
 * with no other window. A company the service names no account for, or whose
 * record cannot be read, is not named, and the saved keys open as they would with
 * none. Whatever this tab holds is dropped by `forgetLocally`; a reload asks the
 * wallet again.
 */
export async function openKeysWithWallet(
  walletOrigin: string,
  /* The window, and the page's own origin, injected so the whole conversation
   * can be driven in a test with no browser. */
  view: Openable = walletInThisPage(window),
  atOrigin: string = window.location.origin,
  /* The dialog a longer journey already opened in its own click. */
  already?: WalletDialog,
  /* The record id of the company the person opened, whose vault balances are opened with the saved keys. */
  opening?: string,
): Promise<void> {
  if (!sessionLive) throw new Error('not signed in');

  /*
   * **OPENED HERE, IN THE CLICK, BEFORE ANYTHING IS AWAITED.**
   * A test fails if this line moves below the ask: a dialog opened after an
   * `await` is blocked as a pop-up.
   */
  const dialog = openTheWallet(view, walletOrigin, already);
  try {
    const named = opening === undefined ? null : await companyNamedFor(opening).catch(() => null);
    const company = named === null || named.account === null ? null : named;
    await openKeysOnceOpen(walletOrigin, view, atOrigin, dialog, company, undefined, company !== null);
  } catch (e) {
    /* A dialog a longer journey opened is that journey's to put away. */
    if (!already) putAway(dialog);
    throw e;
  } finally {
    doneWaiting();
  }
}

async function openKeysOnceOpen(
  walletOrigin: string, view: Openable, atOrigin: string,
  dialog: WalletDialog,
  /**
   * The company whose keys are wanted too: its label and the account that
   * carries it, as the service's record gives them; `'new'` when this tab is
   * starting a company and the wallet is to draw its label; or null.
   */
  company: { accountId: string; label: CompanyLabel; account: AccountAddress | null } | 'new' | null,
  /** With `'new'`: what the company is founded with, and the saved keys as the service holds them, for the wallet to write its seat into. */
  founding?: { readonly asked: FoundingAsked; readonly keyring: KeyringHandedIn },
  /** Whether the company is the one the person opened, named beside opening the saved keys: its key may be withheld. */
  companyIfOnChain = false,
): Promise<{
  drawn: CompanyLabel | null; committeeKey: { tag: string; value: string } | null;
  founding: { founded: Readonly<Record<string, unknown>>; sealed: SealedKeyring; ifVersion: number } | null;
  /** With `'new'`: what the wallet read from the saved keys it sealed with the new seat, taken in only once they are kept. */
  read: KeysRead | null;
}> {
  const who = me;
  if (who === null) throw new Error('not signed in');
  /* **THE ADDRESS THIS TAB SIGNED IN AS, FROM THE SERVICE'S OWN ANSWER TO THAT
   * SIGN-IN**, or null in a tab that did not sign anybody in. It gates and never
   * derives: the wallet will not answer without holding it. */
  const signedInAs = walletAddress;
  /* The saved keys a founding was handed are the copy the wallet reads: one read for the press, the one it seals over. */
  const handedIn = founding !== undefined ? founding.keyring : await savedKeysForTheWallet();
  /* **A READ THAT HAS GONE BACKWARDS IS NOT HANDED ON.** Saved keys only ever grow, one accepted write at a time; an
   * older version, or nothing where the wallet has read something for this tab, is the server answering from before. */
  if (read !== null && (handedIn.version < bundleVersion || (savedKeys === 'some' && handedIn.sealed === null))) {
    throw new SavedKeysWentBack(WENT_BACK);
  }
  const tidy = [...tidyOwed].map(([record, what]) => ({ record, what }));
  const keys = founding !== undefined ? undefined : { keyring: handedIn, served: await servedForTheWallet(), tidy };
  const released = await askWalletForKeys(view, walletOrigin, {
    person: who.id,
    signedInAs,
    company: company === 'new' ? 'new' : company?.label ?? null,
    account: company === 'new' || company === null ? null : company.account,
    atOrigin,
    name: US_TO_A_WALLET.name,
    rdns: US_TO_A_WALLET.rdns,
    ...(company === 'new' && founding !== undefined ? { founding } : {}),
    ...(keys === undefined ? {} : { keys }),
    ...(companyIfOnChain ? { companyIfOnChain: true } : {}),
  }, dialog);
  /* A sign-out, or another person's sign-in, while the wallet was open: this
   * tab is no longer the one that asked, and nothing it was given is used. */
  if (me !== who) throw new AuthError('not signed in');
  const got = released.read;
  if (got === null) throw new SavedKeysDidNotOpen('your wallet did not say what your saved keys hold, so nothing from it was used.');
  /*
   * **A TAB THE WALLET ALREADY READ FOR MUST HEAR FROM THE SAME WALLET.** A different one is refused before anything it
   * gave beside it is used: its public name for this person is not the one this tab holds.
   */
  if (read !== null && got.holder !== read.holder) throw new SavedKeysDidNotOpen(NOT_THE_SAME_WALLET);
  let version = handedIn.version;
  if (got.resealed !== null) {
    /* The creation changes this tab asked for, made by the wallet where the saved keys agreed: written over the copy handed in. */
    const kept = await keepWhatTheWalletSealed(got.resealed.sealed as unknown as Sealed, got.resealed.ifVersion);
    if (kept !== null) {
      version = kept;
      for (const t of tidy) if (tidyOwed.get(t.record) === t.what) tidyOwed.delete(t.record);
    }
  }
  if (signedInAs !== null) keyCheckedAgainstSignIn = true;
  if (company === 'new') {
    /* A founding's read is of saved keys not yet kept: taken in by `keepWhatTheWalletFounded` once they are. */
    savedKeys = handedIn.sealed !== null ? 'some' : 'none';
    return { drawn: released.company, committeeKey: released.committeeKey, founding: released.founding, read: got };
  }
  takeTheRead(got, handedIn.sealed !== null, version);
  if (company !== null && released.companyKey !== null && savedKeys === 'some') {
    /* **RECORDED WITH THE COMPANY IT BELONGS TO**, and only here: the wallet that gave it opened this person's saved
     * keys in the same answer, so it is their wallet. A payslip key can only ever be derived from it, for THIS company.
     * A company key given beside no saved keys at all has nothing to be checked against, so it is not kept. */
    releasedCompanyKey = {
      accountId: company.accountId, key: toHex(released.companyKey), label: company.label,
      account: company.account, committeeKey: released.committeeKey,
    };
    for (const watch of [...releaseWatchers]) {
      try { watch(company.accountId); } catch { /* a watcher's own failure stays the watcher's */ }
    }
  }
  /*
   * The key the person holds a seat on the company with: for a new company, given beside the label the wallet drew
   * for it; for a named company, the key the wallet works out from that company's label. A new company's answer also
   * gives what the wallet founded it with and the saved keys it sealed again with the founding seat in them; the
   * seat's keys stay in the wallet.
   */
  return { drawn: null, committeeKey: company === null ? null : released.committeeKey, founding: null, read: null };
}

/**
 * **WHAT THE WALLET READ, TAKEN IN.** The metadata is read again through the page's own allow-list (`metadataFrom`), so
 * a field it does not name never reaches this tab's memory; the viewing keys of a company the answer did not name are
 * kept from the same wallet's earlier answer.
 */
function takeTheRead(got: KeysRead, some: boolean, version: number): void {
  const metadata = metadataFrom(got.metadata);
  const seats: Record<string, SeatPublicHalves> = {};
  for (const [id, s] of Object.entries(got.seats)) {
    seats[id] = Object.freeze({
      signerId: s.signerId, signingPublicKey: s.signingPublicKey as Hex, wrappingPublicKey: s.wrappingPublicKey as Hex, scope: s.scope as Hex,
    });
  }
  read = {
    seats,
    viewing: { ...(read !== null && read.holder === got.holder ? read.viewing : {}), ...(got.viewing as Record<string, Hex>) },
    holder: got.holder,
  };
  keyring = {
    accounts: {}, creations: { ...metadata.creations },
    directoryEntriesOwed: { ...metadata.directoryEntriesOwed } as Keyring['directoryEntriesOwed'], paidBy: [...metadata.paidBy],
  };
  savedKeys = some ? 'some' : 'none';
  bundleVersion = version;
}

/**
 * **WHAT AN ACTION LEFT IN THE SAVED KEYS, FROM ITS END ANSWER**: the same reading, from the same wallet, at the version
 * the page last kept. An answer from another wallet, or none, changes nothing here. In a tab the wallet has not read the
 * saved keys for, the creations and what is owed are taken, and, when the answer carries the viewing key of the
 * action's own company (`accountId`) with that company's seat, a read of that company alone (`partial`): this tab then
 * opens that company and reads its vaults with no other window, and asks the wallet to read the saved keys before it
 * opens any other.
 */
function takeWhatTheActionLeft(outcome: ActOutcome, accountId: string | null): void {
  const left = outcome.keys;
  if (left === undefined) return;
  if (Object.keys(left.viewing).some((id) => id !== accountId)) return;
  if (read === null || read.partial === true) {
    const metadata = metadataFrom(left.metadata);
    keyring = {
      accounts: {}, creations: { ...metadata.creations },
      directoryEntriesOwed: { ...metadata.directoryEntriesOwed } as Keyring['directoryEntriesOwed'], paidBy: [...metadata.paidBy],
    };
    if (accountId === null) return;
    const seat = Object.prototype.hasOwnProperty.call(left.seats, accountId) ? left.seats[accountId]! : null;
    const key = (left.viewing as Record<string, Hex>)[accountId];
    if (seat === null || key === undefined || (read !== null && read.holder !== left.holder)) return;
    read = {
      seats: {
        ...(read?.seats ?? {}),
        [accountId]: Object.freeze({
          signerId: seat.signerId, signingPublicKey: seat.signingPublicKey as Hex, wrappingPublicKey: seat.wrappingPublicKey as Hex, scope: seat.scope as Hex,
        }),
      },
      viewing: { ...(read?.viewing ?? {}), [accountId]: key },
      holder: left.holder,
      partial: true,
    };
    return;
  }
  if (left.holder !== read.holder) return;
  takeTheRead(left, true, bundleVersion);
}

/**
 * **EACH COMPANY'S VIEWING KEY AS THE SERVICE HOLDS IT, WRAPPED TO ITS SEATS, WITH ITS INBOX PUBLIC KEY**, for the
 * wallet to open the one wrapped to this person's seat. None of it is secret. A list the service will not give is an
 * empty one: the wallet then opens no company's key, and those companies stay locked here.
 */
/** The action's own company's served keys, for its end answer to give that company's viewing key; none when not served. */
async function servedForTheAction(accountId: string): Promise<ServedHandedIn[]> {
  return (await servedForTheWallet()).filter((s) => s.accountId === accountId).slice(0, 1);
}

async function servedForTheWallet(): Promise<ServedHandedIn[]> {
  let listed: unknown;
  try { listed = await api('/api/accounts'); } catch { return []; }
  if (!Array.isArray(listed)) return [];
  const out: ServedHandedIn[] = [];
  for (const a of listed.slice(0, MOST_SERVED)) {
    if (typeof a?.id !== 'string' || typeof a?.inboxPublicKey !== 'string' || !Array.isArray(a?.wrappedKeys)) continue;
    out.push({
      accountId: a.id, inboxPublicKey: String(a.inboxPublicKey).toLowerCase(),
      wrappedKeys: (a.wrappedKeys as any[]).slice(0, MOST_SERVED).filter((w) => typeof w?.signerId === 'string')
        .map((w) => ({ signerId: w.signerId, iv: w.iv, tag: w.tag, body: w.body, ephemeral: w.ephemeral })),
    });
  }
  return out;
}

/**
 * **THE COMPANY AS THE SERVICE'S RECORD NAMES IT, FOR THE WALLET**: its label,
 * and the account that carries the label when it has one. From `POST
 * /api/accounts/:id/unlock`, which sends no body: there is nothing this page
 * could tell the service about which company it is that the service should
 * believe. Refused by name when the answer is not a label and an address.
 */
async function companyNamedFor(accountId: string): Promise<{ accountId: string; label: CompanyLabel; account: AccountAddress | null }> {
  const answer = await api(`/api/accounts/${accountId}/unlock`, { method: 'POST' });
  const label = readCompanyLabel(answer?.company);
  const account = answer?.account === null || answer?.account === undefined ? null : readAccountAddress(answer.account);
  if (label === null || (answer?.account !== null && answer?.account !== undefined && account === null)) {
    throw new Error('the service did not name this company in a way your wallet can check - its label, and the '
      + 'account that carries it - so your wallet was not asked.');
  }
  return { accountId, label, account };
}

/**
 * **THIS COMPANY'S KEY AND THE PUBLIC KEY THIS PERSON SITS ON ITS VAULT
 * COMMITTEE WITH, FROM THE WALLET THAT READS THIS PERSON'S SAVED KEYS.** Both
 * come in the answer in which that wallet reads the saved keys for this tab,
 * and are kept only when it did read some, and from the wallet that read them
 * for this tab before (`openKeysOnceOpen`), so they are that wallet's. A tab
 * that already holds them asks nothing.
 */
export async function companyKeysForVaults(
  accountId: string, walletOrigin: string,
  view: Openable = walletInThisPage(window),
  atOrigin: string = window.location.origin,
): Promise<{
  companyKey: Hex; committeeKey: { tag: string; value: string };
  /** The company's label, which the keys are derived from. */
  company: CompanyLabel;
  /**
   * The account that carries it: the contract a new vault is pinned to and a
   * deposit is checked against. Its own field, and never the label.
   */
  account: AccountAddress;
}> {
  if (!sessionLive) throw new Error('not signed in');
  const company = await companyNamedFor(accountId);
  /* Everything done with these keys reaches the company's account on the chain, so a company with none gets no keys here. */
  if (company.account === null) {
    throw new Error('this company has no account on the chain yet, so nothing about its vaults can be done here.');
  }
  let companyKey = companyKeyReleasedFor(accountId);
  let committeeKey = committeeKeyReleasedFor(accountId);
  if (companyKey === null || committeeKey === null) {
    const dialog = openTheWallet(view, walletOrigin);
    try {
      await openKeysOnceOpen(walletOrigin, view, atOrigin, dialog, company);
    } catch (e) {
      putAway(dialog);
      throw e;
    } finally {
      doneWaiting();
    }
    companyKey = companyKeyReleasedFor(accountId);
    committeeKey = committeeKeyReleasedFor(accountId);
  }
  if (companyKey === null || committeeKey === null) {
    throw new Error('your wallet did not give this company\'s keys, so nothing about its vaults can be done here.');
  }
  return { companyKey, committeeKey, company: company.label, account: company.account };
}

/**
 * **THE WALLET KEY THIS PERSON WILL HOLD A SEAT ON AN INVITING COMPANY WITH**,
 * from their own wallet, asked with the company's label and account as the
 * invitation they opened names them: the key the wallet works out from that
 * label, which the seat's leaf is then made to commit to on this device.
 * Asked in the press, on a first open too. Nothing is checked against it here:
 * the wallet checks the invitation itself when it is first asked to sign for
 * the company.
 */
export async function walletKeyForAnInvitation(
  company: { readonly accountId: string; readonly label: CompanyLabel; readonly account: AccountAddress },
  walletOrigin: string,
  view: Openable = walletInThisPage(window),
  atOrigin: string = window.location.origin,
): Promise<{ tag: 'schnorr'; value: string }> {
  if (!sessionLive) throw new Error('not signed in');
  const dialog = openTheWallet(view, walletOrigin);
  try {
    const { committeeKey } = await openKeysOnceOpen(walletOrigin, view, atOrigin, dialog, { ...company });
    const key = schnorrKeyOf(committeeKey);
    if (key === null) throw new Error('your wallet gave no key for this company, so no seat was made. Update your wallet and try again.');
    return key;
  } catch (e) {
    putAway(dialog);
    throw e;
  } finally {
    doneWaiting();
  }
}

/**
 * **ASKS THIS PERSON'S WALLET TO PUT IN THE COINS A DEPOSIT NEEDS.** Opened in
 * the press, like every wallet journey; see `wallet-balance.ts`.
 */
export async function payIntoAVaultFromTheWallet(
  walletOrigin: string,
  ask: { company: CompanyLabel; account: AccountAddress; vault: VaultAddress; transaction: string },
  view: Openable = walletInThisPage(window),
  atOrigin: string = window.location.origin,
  already?: WalletDialog,
): Promise<{ transaction: string; leaves: readonly unknown[] }> {
  if (!sessionLive) throw new Error('not signed in');
  const dialog = openTheWallet(view, walletOrigin, already);
  try {
    return await askWalletToPay(view, walletOrigin, {
      ...ask, atOrigin, name: US_TO_A_WALLET.name, rdns: US_TO_A_WALLET.rdns,
    }, dialog);
  } catch (e) {
    if (!already) putAway(dialog);
    throw e;
  } finally {
    doneWaiting();
  }
}

/**
 * **ASKS THIS PERSON'S WALLET TO SIGN A CHANGE TO WHO HOLDS THEIR COMPANY'S
 * RULES.** Opened in the press, like every wallet journey; see
 * `wallet-committee.ts`.
 */
export async function signCommitteeChangeFromTheWallet(
  walletOrigin: string,
  ask: Pick<CommitteeAsked, 'company' | 'account' | 'to' | 'contracts'>,
  view: Openable = walletInThisPage(window),
  atOrigin: string = window.location.origin,
  already?: WalletDialog,
): Promise<Awaited<ReturnType<typeof askWalletToSignCommittee>>> {
  if (!sessionLive) throw new Error('not signed in');
  const dialog = openTheWallet(view, walletOrigin, already);
  try {
    return await askWalletToSignCommittee(view, walletOrigin, {
      ...ask, atOrigin, name: US_TO_A_WALLET.name, rdns: US_TO_A_WALLET.rdns,
    }, dialog);
  } catch (e) {
    if (!already) putAway(dialog);
    throw e;
  } finally {
    doneWaiting();
  }
}

/**
 * **THE SEAT THAT INVITED THIS SIGNER, AS A RECORDS-KEY ASK CARRIES IT**: its
 * wallet key, its signed entry and its own seat's opening, and nothing of any
 * other seat. The wallet checks the entry against a schnorr key and the
 * opening against the inviter's seat on the chain, so an inviter named under
 * any other kind of key is left out and the ask is made without one.
 */
export const invitedByForTheWallet = (inviter: Inviter | undefined): Pick<RecordsKeyAsked, 'invitedBy'> =>
  inviter === undefined || inviter.committeeKey.tag !== 'schnorr' || inviter.opening?.walletKey?.tag !== 'schnorr' ? {}
    : {
      invitedBy: {
        committeeKey: { tag: 'schnorr', value: inviter.committeeKey.value }, statement: inviter.statement,
        opening: { ...inviter.opening, walletKey: { tag: 'schnorr', value: inviter.opening.walletKey.value } },
      },
    };

/**
 * **THIS PERSON'S RECORDS KEY FOR THEIR SEAT, SIGNED BY THEIR OWN WALLET, AND WHO
 * HOLDS THE COMPANY'S ACCOUNT NOW AS THAT WALLET READ IT.** Asked right before a
 * vault's secret is approved, so what it is checked against is read then.
 * With `firstSecret`, asked before a vault's first secret, the wallet also
 * shows the person that vault and every reader its secret will be sealed to:
 * a confirmation for the person, not a lock, since the chain accepts the
 * approval on the seat's proof this page makes.
 * Opened in the press, like every wallet journey; see `wallet-records-key.ts`.
 */
export async function recordsKeyFromTheWallet(
  walletOrigin: string,
  ask: Pick<RecordsKeyAsked, 'company' | 'account' | 'seat' | 'vault' | 'signingKey' | 'invitedBy' | 'firstSecret'>,
  view: Openable = walletInThisPage(window),
  atOrigin: string = window.location.origin,
  already?: WalletDialog,
): Promise<RecordsKeySigned> {
  if (!sessionLive) throw new Error('not signed in');
  const dialog = openTheWallet(view, walletOrigin, already);
  try {
    return await askWalletToSignRecordsKey(view, walletOrigin, {
      ...ask, atOrigin, name: US_TO_A_WALLET.name, rdns: US_TO_A_WALLET.rdns,
    }, dialog);
  } catch (e) {
    if (!already) putAway(dialog);
    throw e;
  } finally {
    doneWaiting();
  }
}

/**
 * The indexer this person's wallet last named in an answer it gave in this tab: the wallet names it only with an
 * answer it completes, never with a refusal. Null until it has named one.
 */
let walletsIndexer: { readonly indexerUri: string; readonly indexerWsUri: string } | null = null;

/**
 * **WHO HOLDS THE COMPANY NOW, AS THIS PERSON'S OWN WALLET READS THE CHAIN**, with
 * no press. Asked afresh for every read that believes a filing; see
 * `wallet-records-key.ts`. Nothing is shown and nothing is unlocked: the wallet
 * is asked in a frame of its own that nobody sees (`walletQuietlyInThisPage`),
 * and the page says it is waiting for nothing.
 */
export async function holdersFromTheWallet(
  walletOrigin: string,
  ask: Pick<HoldersAsked, 'company' | 'account' | 'movements' | 'roles'>,
  view: Openable = walletQuietlyInThisPage(window),
  atOrigin: string = window.location.origin,
): Promise<HoldersRead> {
  if (!sessionLive) throw new Error('not signed in');
  const dialog = openWalletDialog(view, walletOrigin);
  try {
    const read = await askWalletWhoHolds(view, walletOrigin, {
      ...ask, atOrigin, name: US_TO_A_WALLET.name, rdns: US_TO_A_WALLET.rdns,
    }, dialog);
    if (read.indexer !== null) walletsIndexer = read.indexer;
    return read;
  } finally {
    putAway(dialog);
  }
}

/**
 * Forgets everything this tab holds. LOCAL ONLY — it does not sign the person
 * out on the server, and it must not: it is also the 401 handler above, where
 * the sign-in is already gone and calling the API again would recurse.
 *
 * Use `signOut()` for the button.
 */
export function forgetLocally() {
  sessionLive = false; read = null; keyring = { accounts: {} }; me = null; walletAddress = null;
  releasedCompanyKey = null; savedKeys = null; keyCheckedAgainstSignIn = false; tidyOwed.clear();
  /* The indexer the wallet named belongs to the sign-in it was learnt in. */
  walletsIndexer = null;
}

/**
 * Signing out for real: the service ends the sign-in, so a token dropped by
 * this tab is not left valid until it expires, which on a shared or stolen
 * machine would make "sign out" do nothing an attacker would notice.
 *
 * The local clear happens either way. If the network is down we still must not
 * leave the keys sitting in this tab, and a sign-in we failed to end is a
 * smaller problem than a keyring left open on somebody's screen.
 */
export async function signOut(): Promise<{ ended: boolean; anotherPerson: boolean }> {
  /*
   * **AND IT SAYS WHETHER THE SERVER ENDED IT**, because this page cannot end it
   * itself: the sign-in is an `HttpOnly` cookie, and a reload picks one up
   * the server did not end. Ended is a confirmed sign-out, or a server saying
   * there was no session to end. Not ended is a server that could not be
   * reached or failed, or one that belongs to somebody else.
   */
  /*
   * **A TAB THAT HAS ALREADY FORGOTTEN WHO IT WAS SENDS NOTHING.** Its request
   * would carry no name, and the server would end whichever session the cookie
   * holds - after a `409`, somebody else's, from another tab. So it answers from
   * what made it forget: the server saying there was no sign-in is one
   * ended; anything else is not.
   */
  if (me === null) {
    const because = forgotBecause;
    forgetLocally();
    return { ended: because === 'no-session', anotherPerson: because === 'another-person' };
  }
  let ended = false;
  let anotherPerson = false;
  try {
    await api('/api/auth/logout', { method: 'POST' });
    ended = true;
  } catch (e) {
    anotherPerson = e instanceof AnotherPersonError;
    ended = e instanceof AuthError && !anotherPerson;
  } finally {
    forgetLocally();
  }
  return { ended, anotherPerson };
}

/** The signed-in devices. Never includes a token — see SessionStore.list. */
export async function listSessions() {
  return (await api('/api/me/sessions')).sessions as Array<{
    id: string; issuedAt: string; expiresAt: string;
    userAgent: string | null; current: boolean;
  }>;
}

/** Ends one of them by id. "Sign out that phone." */
export async function endSession(id: string) {
  await api(`/api/me/sessions/${id}/revoke`, { method: 'POST' });
}

/** Ends every other session and keeps this one. */
export async function signOutEverywhereElse() {
  return (await api('/api/me/sessions/others/revoke', { method: 'POST' })).ended as number;
}

/* ---------------- the keyring ---------------- */

/**
 * **THE COMPANIES THAT PAY THE SIGNED-IN PERSON: WHAT THEIR SAVED KEYS HOLD,
 * WHEN THE WALLET HAS READ THEM FOR THIS TAB, AND WHAT THIS BROWSER HOLDS FOR THEM ALONE.**
 * Empty for nobody signed in. Never another person's: the browser's list is
 * kept under the person it was written for.
 */
export function companiesThatPayYou(storage?: Pick<Storage, 'getItem'> | null): string[] {
  if (me === null) return [];
  const saved = read === null ? [] : onlyCompanyLabels(keyring.paidBy ?? []);
  return [...new Set([...saved, ...rememberedCompanies(me.id, storage)])];
}

/**
 * **WHY THIS TAB WRITES NO SAVED KEYS.** The saved keys are sealed under a key only the person's wallet holds, and only
 * the wallet changes them; this tab carries the sealed copy between the service and the wallet. The functions below
 * wrote them from this tab before the seat secrets left it. None has a production caller: each
 * refuses at once, reading and writing nothing.
 */
const THIS_TAB_WRITES_NO_SAVED_KEYS = 'this page no longer writes your saved keys: only your wallet changes them, in an '
  + 'action it runs. Nothing was written.';
const writesNoSavedKeys = async (): Promise<never> => { throw new Error(THIS_TAB_WRITES_NO_SAVED_KEYS); };

/** Moved the companies this browser held for this person into their saved keys. Refuses: see `writesNoSavedKeys`. */
export async function bringCompaniesThatPayYouAcross(
  _storage?: (Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) | null,
): Promise<void> {
  if (me === null || read === null) return;
  await writesNoSavedKeys();
}

/** Sealed a joiner's seat into the saved keys. Refuses: see `writesNoSavedKeys`. */
export async function sealPendingSeat(_seat: PendingSeat): Promise<void> { await writesNoSavedKeys(); }

/** Kept a signed directory entry owed in the saved keys. Refuses: see `writesNoSavedKeys`. */
export async function oweDirectoryEntry(_accountId: string, _owed: Omit<OwedDirectoryEntry, 'opening' | 'invited'>): Promise<void> {
  await writesNoSavedKeys();
}

/** Kept a re-issued invitation in the saved keys. Refuses: see `writesNoSavedKeys`. */
export async function keepTheReissuedInvitation(
  _accountId: string, _reissued: { readonly inviter: Inviter; readonly invited: SignedSeatInvitation },
): Promise<void> {
  await writesNoSavedKeys();
}

/** The doors over this person's owed directory entry for `accountId`, as the wallet read it: letting it go refuses here. */
export const directoryEntryOwed = (accountId: string) => ({
  read: (): OwedDirectoryEntry | null => keyring.directoryEntriesOwed?.[accountId] ?? null,
  settle: async (): Promise<void> => { await writesNoSavedKeys(); },
});

/** The seats sealed and not promoted, for one account: none, since a seat's secrets are not on this page. */
export const pendingSeatsFor = (_accountId: string): PendingSeat[] => [];

/** Promoted a pending seat into the saved keys. Refuses: see `writesNoSavedKeys`. */
export async function promotePendingSeat(_signingPublicKey: Hex, _signerId: string): Promise<void> { await writesNoSavedKeys(); }

/** Finished a seat published and not finished: there is none on this page, so it finishes nothing. */
export async function finishPendingSeat(accountId: string, sealed: SealedAccount): Promise<boolean> {
  return Boolean(seatToPromote(pendingSeatsFor(accountId), sealed));
}

/**
 * THE SAVED KEYS AS THE SERVICE HOLDS THEM NOW, SEALED, TO HAND TO THE PERSON'S WALLET FOR AN ACTION IT RUNS, with the
 * version the service gave them. Read from the service each time rather than from this tab, so the wallet is handed the
 * newest copy there is; the wallet opens them and refuses a copy older than one it has already opened.
 */
export async function savedKeysForTheWallet(): Promise<{ readonly sealed: Sealed | null; readonly version: number }> {
  const r = await api('/api/me/keys');
  return {
    sealed: r?.keyBundle ? r.keyBundle as Sealed : null,
    version: typeof r?.version === 'number' ? r.version : 0,
  };
}

/**
 * KEEPS SAVED KEYS THE PERSON'S WALLET SEALED, written only over the version the wallet was handed, so a change made
 * from another tab or device meanwhile is refused rather than erased. Returns the version the service now holds, or
 * null when the service refused the write. The sealed copy is passed on unread: this tab cannot open it.
 */
export async function keepWhatTheWalletSealed(sealed: Sealed, ifVersion: number): Promise<number | null> {
  let r: Record<string, unknown> | null;
  try {
    r = await api('/api/me/keys', { method: 'PUT', body: JSON.stringify({ keyBundle: sealed, ifVersion }) }) as Record<string, unknown> | null;
  } catch (e) {
    if (e instanceof ServiceRefused) return null;
    throw e;
  }
  const version = typeof r?.['version'] === 'number' ? r['version'] as number : ifVersion + 1;
  if (version > bundleVersion) bundleVersion = version;
  return version;
}

/**
 * **CHANGES TO KEPT CREATIONS THIS TAB HAS ASKED FOR AND THE WALLET HAS NOT YET MADE**: set aside (Start again, when a
 * deploy never landed) or drop (one nothing was signed for). Carried in this tab's next ask for the saved keys, where the
 * wallet makes each only when the saved keys agree; until then this tab reads the creation as already changed. Memory
 * only: a reload forgets them, and the creation shows again as it is kept.
 */
const tidyOwed = new Map<string, 'aside' | 'forget'>();

/* ---------------- bringing a company into being ---------------- */

/** What a company is made from: its name, who signs for it, and how many signatures it needs. */
export interface CompanyToFound {
  name: string;
  signers: Array<{ name: string; role: 'admin' | 'approver' | 'initiator' | 'viewer' }>;
  threshold: number;
}

/** A company as its founding signer's press made it: the label their wallet drew, and what its account is deployed from. */
interface Founded {
  readonly accountId: string;
  readonly label: CompanyLabel;
  /** The key the founding signer sits on the company's committee with, which alone holds the account from its first transaction. */
  readonly foundingKey: { tag: 'schnorr'; value: string };
  /** The founding signer's seat in the account, as this device made it. */
  readonly foundingLeaf: string;
}

/**
 * **THE COMPANY IS FOUNDED IN THE WALLET**, in the one window the press opens:
 * the wallet draws the label, makes the founding seat from its words, signs the
 * founding roster and state with it and writes the seat into the person's saved
 * keys, sealed again (`apps/wallet/src/keyring/found-company.ts`). This page
 * hands the wallet the saved keys as the service holds them and the company's
 * name and founding signer, keeps the saved keys the wallet sealed over the
 * version it named, and only then sends the service what the company was
 * founded with. The founding seat's keys never reach this page.
 */
async function foundCompany(spec: CompanyToFound, walletOrigin: string, view: Openable, atOrigin: string): Promise<Founded> {
  if (!sessionLive || me === null) throw new Error('not signed in');
  /*
   * **THE WINDOW OPENS IN THE PRESS, EVERY TIME.** The new company's label is
   * the wallet's to draw, so a tab the wallet already read for asks it too - and
   * its answer must come from the same wallet (`openKeysOnceOpen`).
   */
  const startedBy = me.id;
  const dialog = openTheWallet(view, walletOrigin);
  try {
    const handedIn = await savedKeysForTheWallet();
    const signer = spec.signers[0]!;
    const { drawn, committeeKey, founding, read: foundedRead } = await openKeysOnceOpen(walletOrigin, view, atOrigin, dialog, 'new', {
      asked: { name: spec.name, signer: { name: signer.name, role: signer.role } }, keyring: handedIn,
    });
    if (drawn === null) throw new Error('Your wallet did not make up a label for the new company, so nothing was created. Close the wallet\'s window, reload this page and start the company again.');
    const foundingKey = schnorrKeyOf(committeeKey);
    if (foundingKey === null) {
      throw new Error('Your wallet drew a label for the new company but gave no key to hold it with, so nothing was created. '
        + 'Close the wallet\'s window, reload this page and start the company again.');
    }
    if (founding === null) {
      throw new Error('Your wallet drew a label for the new company but did not hand back what it founded it with, so nothing '
        + 'was created. Close the wallet\'s window, reload this page and start the company again.');
    }
    /* Asked before anything is kept, so a refusal costs nothing. */
    if (savedKeys !== 'some' && !keyCheckedAgainstSignIn) throw new FirstKeysNeedTheSignIn(FIRST_KEYS_NEED_THE_SIGN_IN);
    return await keepWhatTheWalletFounded(drawn, foundingKey, founding, startedBy, foundedRead!);
  } catch (e) {
    putAway(dialog);
    throw e;
  } finally {
    doneWaiting();
  }
}

/**
 * The saved keys the wallet sealed with the new seat in them, kept over the
 * version it named; then the creation they keep, read back and checked against
 * the label and key the wallet gave, sent to the service.
 */
async function keepWhatTheWalletFounded(
  label: CompanyLabel, foundingKey: { tag: 'schnorr'; value: string },
  founding: { founded: Readonly<Record<string, unknown>>; sealed: SealedKeyring; ifVersion: number },
  person: string,
  foundedRead: KeysRead,
): Promise<Founded> {
  const account = founding.founded['account'] as { id?: unknown } | undefined;
  const accountId = typeof account?.id === 'string' ? account.id : null;
  if (accountId === null) {
    throw new Error('Your wallet founded the company without an id it can be kept under, so nothing was created. '
      + 'Reload this page and start the company again.');
  }
  /* The saved keys the wallet sealed are the starter's: somebody else signed in on this tab since is never written over with them. */
  if (me === null || me.id !== person) throw new CompanyStartedBySomebodyElse(STARTED_BY_SOMEBODY_ELSE);
  const kept = await keepWhatTheWalletSealed(founding.sealed as unknown as Sealed, founding.ifVersion);
  if (kept === null) {
    throw new Error('Your saved keys, with your seat in the new company, were not kept by the service: they changed on another '
      + 'device since this page read them, or the service refused them. Nothing was created. Reload this page, which reads '
      + 'your newest saved keys, and start the company again.');
  }
  /* What the wallet read from the saved keys it sealed, taken in now they are kept: the new seat and its creation. */
  takeTheRead(foundedRead, true, kept);
  const saved = theCreation(accountId);
  if (saved === undefined || saved.label !== label || saved.foundingKey.value !== foundingKey.value) {
    throw new Error('the company was founded but what was kept of it could not be read back as the company your wallet drew, '
      + 'so nothing was sent. Reload this page and start the company again.');
  }
  refuseWhenNotTheStarter(saved);
  await sendTheCompany(saved, 'new');
  /* A sign-in by somebody else while the service was answering: this tab acts for them now, and nothing more is done here. */
  if (me === null || me.id !== person) throw new CompanyStartedBySomebodyElse(STARTED_BY_SOMEBODY_ELSE);
  return { accountId, label, foundingKey, foundingLeaf: saved.request.founding.seat.leaf };
}

const HEX64_KEY = /^[0-9a-f]{64}$/u;

/** A committee key as the wallet gave it, or null when it is not one. */
const schnorrKeyOf = (k: { tag: string; value: string } | null): { tag: 'schnorr'; value: string } | null => {
  if (k === null || k.tag !== 'schnorr') return null;
  const value = String(k.value).toLowerCase();
  return HEX64_KEY.test(value) ? { tag: 'schnorr', value } : null;
};

/**
 * This person's company being created, if there is one: as the wallet last read it, with the changes this tab asked
 * for and has not yet seen made (`tidyOwed`), one finished here (`finishedHere`), and one set aside that this tab took
 * up again because its deploy landed (`takenUpHere`; the wallet takes it up itself when it finishes it).
 */
const theCreation = (accountId: string): SavedCreation | undefined => {
  if (tidyOwed.has(accountId) || finishedHere.has(accountId)) return undefined;
  const c = keyring.creations?.[accountId];
  if (c === undefined) return undefined;
  if (c.setAside !== true) return c;
  if (!takenUpHere.has(accountId)) return undefined;
  const { setAside: _taken, ...active } = c;
  return active as SavedCreation;
};

/** Creations this tab saw finished on the chain: no longer offered here; the wallet drops them when it finishes one. */
const finishedHere = new Set<string>();
/** Creations set aside whose deploy this tab saw land: offered to finish again here; the wallet takes them up. */
const takenUpHere = new Set<string>();
/** Creations this tab sent to the service, so a later relay does not send them again. */
const sentHere = new Set<string>();

/**
 * A creation is written only into the saved keys of the person who started it: a step that returns after somebody
 * else was signed in and opened their keys would otherwise leave them holding it, unable to create a company.
 */
function refuseWhenNotTheStarter(c: SavedCreation): void {
  if (c.person !== undefined && (me === null || me.id !== c.person)) throw new CompanyStartedBySomebodyElse(STARTED_BY_SOMEBODY_ELSE);
}

/**
 * Drops what was kept of a creation: one finished is no longer offered here (the wallet drops it from the saved keys
 * when it finishes it); one whose deploy was never built is asked of the wallet in this tab's next ask (`tidyOwed`).
 */
async function forgetCreation(accountId: string): Promise<void> {
  const kept = keyring.creations?.[accountId];
  if (kept !== undefined) refuseWhenNotTheStarter(kept);
  if (kept?.setAside === true) return;
  if (kept !== undefined && kept.signed === null && !kept.recorded) tidyOwed.set(accountId, 'forget');
  else finishedHere.add(accountId);
}

/**
 * Sets one creation aside: asked of the wallet in this tab's next ask (`tidyOwed`), which keeps all of it under its own
 * company id, marked `setAside`, so it is not lost and no other creation is touched. This tab reads it as set aside at once.
 */
async function setCreationAside(accountId: string): Promise<void> {
  const kept = theCreation(accountId);
  if (kept === undefined) return;
  refuseWhenNotTheStarter(kept);
  tidyOwed.set(accountId, 'aside');
}

/**
 * **A CREATION SET ASIDE, TAKEN UP AGAIN** because its account turned up on the chain: this tab offers it to finish
 * again, and the wallet takes its mark off when it finishes it (`apps/wallet/src/actions/finish-company.ts`). Only
 * that creation is touched; any other kept creation stays as it is.
 */
export async function takeUpACreationSetAside(accountId: string): Promise<boolean> {
  const aside = keyring.creations?.[accountId];
  if (aside === undefined) return false;
  if (tidyOwed.get(accountId) === 'aside') {
    /* Set aside here and not yet in the saved keys: the change is no longer asked of the wallet. */
    refuseWhenNotTheStarter(aside);
    tidyOwed.delete(accountId);
    return true;
  }
  if (aside.setAside !== true || takenUpHere.has(accountId)) return false;
  refuseWhenNotTheStarter(aside);
  takenUpHere.add(accountId);
  return true;
}

/**
 * Sends the request that made the company, as it was kept, unless this tab sent it or the service already holds the
 * company. Nothing is written into the saved keys for it: the service's own answer says whether it holds it.
 */
async function sendTheCompany(saved: SavedCreation, known: 'new' | 'ask' = 'ask'): Promise<SavedCreation> {
  if (saved.made || sentHere.has(saved.accountId)) return saved;
  if (known === 'ask') {
    try {
      await api(`/api/accounts/${saved.accountId}/creation`);
      sentHere.add(saved.accountId);
      return saved;
    } catch (e) {
      if (!(e instanceof NotOnTheService)) throw e;
    }
  }
  await api('/api/accounts', { method: 'POST', body: JSON.stringify(saved.request) });
  sentHere.add(saved.accountId);
  return saved;
}

/**
 * What reads the chain for a kept creation this page is asked to start again: the vault worker, or anything that
 * answers as it does. A company's account is built, signed and proved in the wallet (`finishCompanyInTheWallet`),
 * never here.
 */
export interface AccountCreationBuilder {
  /**
   * Whether the chain holds a contract at the account, at the indexer the person's wallet names: with the time of the
   * newest block it names and the newest time to live of the kept transactions. Throws when the indexer cannot say.
   */
  accountPresence?(input: { account: string; indexer: { indexerUri: string; indexerWsUri: string }; transactions: string[] }): Promise<AccountPresenceOnTheWire>;
}

/**
 * The company this person has started and not finished, for which the press that finishes it is owed: every creation
 * still kept, since the wallet drops a creation from the saved keys as the last step of finishing it. The account is
 * the one the wallet built, once it has.
 */
export const companyAwaitingItsSecondPress = (accountId: string): { accountId: string; account: AccountAddress | null } | null => {
  const saved = theCreation(accountId) ?? null;
  return saved !== null ? { accountId: saved.accountId, account: saved.deploy?.account ?? null } : null;
};

/** Every company this person is creating on a chain, each kept on its own, in the order they were started. A creation set aside is not among them. */
export const companiesBeingCreated = (): string[] => Object.keys(keyring.creations ?? {}).filter((id) => theCreation(id) !== undefined);

/** Whether this company is one this person is creating on a chain, kept with their saved keys, until its creation is finished. A creation set aside is not. */
export const companyBeingCreated = (accountId: string): boolean => theCreation(accountId) !== undefined;

/**
 * The label the wallet drew for the company being created, as this browser kept it: the one source of the label the
 * person is shown after the first press. Null when no creation is kept, or when it is another company's than the one asked
 * about.
 */
export const companyBeingCreatedLabel = (accountId: string): CompanyLabel | null => theCreation(accountId)?.label ?? null;

/**
 * The name the person gave a company, as this device kept it with the company's creation, whether that creation is still
 * kept or was set aside: the one source of the name of a company that is not finished, which has no sealed record to open
 * yet: the name written on the kept request. Null for a company this device holds no creation of, or whose creation holds
 * no name; never the service's word for it, and never the roster opened here, which only the seat's own keys open.
 */
export const companyNameKeptHere = (accountId: string): string | null => {
  const kept = keyring.creations?.[accountId] ?? keyring.creationsSetAside?.[accountId];
  if (kept === undefined || kept === null) return null;
  return aNameIfAny(kept.request?.name);
};

const aNameIfAny = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * **THE FIRST PRESS: THE COMPANY IS FOUNDED IN THE WALLET** (`foundCompany`).
 *
 * The wallet draws the company's label, makes the founding seat from its words,
 * signs the founding roster and state and keeps the seat in the saved keys; the
 * service records what was founded, and the founding signer's committee key.
 * **NOTHING IS SENT TO THE CHAIN, AND NO ACCOUNT IS BUILT YET**: the second
 * press is one action the wallet runs whole, which builds the account and
 * finishes it (`finishCompanyInTheWallet`). It returns the label the wallet
 * drew, so the page can show the person the name their wallet gave the company.
 *
 * **A COMPANY IS NEVER REFUSED BECAUSE ANOTHER IS NOT FINISHED.** Each creation is kept on its own, under its own
 * company id, and carried on or started again on its own; a new one is added beside the others and never replaces one.
 * A kept creation from which nothing was sent to the chain can be dropped, by `forgetAnUnsentCreation`.
 */
export async function startCompanyHeldFromTheStart(
  spec: CompanyToFound,
  walletOrigin: string,
  view: Openable = walletInThisPage(window),
  atOrigin: string = window.location.origin,
): Promise<{ accountId: string; label: CompanyLabel }> {
  /* Before the wallet is opened: a company is created with its founding signer only. */
  if (spec.signers.length !== 1 || spec.threshold !== 1) {
    throw new Error('a company is created with you as its only signer, at a threshold of one; everybody else joins by '
      + 'invitation, their seat made on their own device. Nothing was created.');
  }
  const founded = await foundCompany(spec, walletOrigin, view, atOrigin);
  return { accountId: founded.accountId, label: founded.label };
}

/**
 * Drops a kept creation from which nothing reached the chain, so the first press can make a company again: its
 * deploy was never built, or was built and never signed for or sent. It refuses when this browser keeps no creation
 * for the company, and when anything was signed or sent: that carries on, and dropping it would lose what the
 * wallet signed or what the chain already holds. The company's keys stay kept, because the service may already
 * list the company.
 */
export async function forgetAnUnsentCreation(accountId: string): Promise<void> {
  const saved = theCreation(accountId);
  if (saved === undefined) throw new Error('this browser keeps no creation for this company.');
  if (saved.signed !== null || saved.recorded) {
    throw new Error('this company\'s second step was signed or sent, so it is carried on, not started again. Nothing was dropped.');
  }
  await forgetCreation(accountId);
}

/** What starting a kept creation again came to. */
export type StartedAgain =
  /** What was kept of it is dropped; the first press can make a company again. */
  | { readonly of: 'dropped' }
  /** Its account is on the chain, so it is finished, never dropped. */
  | { readonly of: 'on-the-chain' }
  /** Nothing shows it on the chain, but what was sent can still land for this many minutes. */
  | { readonly of: 'may-still-land'; readonly minutes: number }
  /** The chain could not be read well enough to say nothing landed. */
  | { readonly of: 'not-confirmed' };

/** The service's own margin past a transaction's time to live before it counts it as run out. */
const THE_SERVICES_MARGIN_MS = 5 * 60_000;

/** The service's creation standings in which the account's deploy has not landed. */
const DEPLOY_NOT_LANDED: ReadonlySet<CompanyCreationState> = new Set<CompanyCreationState>(['not-created', 'deploy-sent', 'deploy-expired']);

/** The service's creation standings in which the account's deploy has landed. */
const DEPLOY_LANDED: ReadonlySet<CompanyCreationState> = new Set<CompanyCreationState>(['finish-owed', 'finish-expired', 'finish-sent', 'pay-key-owed', 'finished']);

/**
 * **STARTING A KEPT CREATION AGAIN: ONLY WHEN THE CHAIN SHOWS NO ACCOUNT, AND NOTHING SENT CAN STILL LAND.**
 * Only the person who started it. A creation whose second step was never signed was never sent, and is dropped at once.
 * One that was signed or sent is set aside (not deleted: `takeUpACreationSetAside` finishes it if its account turns up)
 * only when all of this holds: the service does not say its deploy landed; the person's wallet does not read the
 * account; and this device, reading the chain at the indexer that wallet named (never the service's word), is told by
 * a clean answer that no contract is held at the address AND the chain's own newest block is past the newest time to
 * live of the kept transactions, read from their bytes, by the service's five-minute margin. No device clock is used.
 * Any failure, an indexer not named, or a transaction that cannot be read keeps the creation. A landed deploy is
 * finished, never set aside. The company's keys stay kept.
 */
export async function startAnUnfinishedCreationAgain(
  accountId: string, walletOrigin: string, builder: AccountCreationBuilder | null, view?: Openable, atOrigin?: string,
): Promise<StartedAgain> {
  const saved = theCreation(accountId);
  if (saved === undefined) throw new NoCreationKeptHere('this browser keeps no creation for this company.');
  refuseWhenNotTheStarter(saved);
  if (saved.signed === null && !saved.recorded) {
    await forgetAnUnsentCreation(accountId);
    return { of: 'dropped' };
  }
  const standing = (await companyCreationStanding(accountId)).state;
  if (DEPLOY_LANDED.has(standing)) return { of: 'on-the-chain' };
  if (!DEPLOY_NOT_LANDED.has(standing) || saved.deploy === null) return { of: 'not-confirmed' };
  const account = saved.deploy.account;
  try {
    await holdersFromTheWallet(walletOrigin, { company: saved.label, account }, view, atOrigin);
    return { of: 'on-the-chain' };
  } catch (e) {
    if (!(e instanceof WalletClosed && e.refusal.of === 'unreadable')) return { of: 'not-confirmed' };
  }
  const indexer = walletsIndexer;
  if (indexer === null || builder === null || builder.accountPresence === undefined) return { of: 'not-confirmed' };
  let seen: AccountPresenceOnTheWire;
  try {
    seen = await builder.accountPresence({
      account, indexer, transactions: [saved.deploy.tx, ...(saved.signed === null ? [] : [saved.signed.tx])],
    });
  } catch {
    return { of: 'not-confirmed' };
  }
  if (seen.held) return { of: 'on-the-chain' };
  if (seen.ttl === null || !Number.isFinite(seen.ttl) || !Number.isFinite(seen.blockTime)) return { of: 'not-confirmed' };
  const endsAt = seen.ttl + THE_SERVICES_MARGIN_MS;
  if (seen.blockTime < endsAt) return { of: 'may-still-land', minutes: Math.max(1, Math.ceil((endsAt - seen.blockTime) / 60_000)) };
  const now = theCreation(accountId);
  if (now === undefined) return { of: 'dropped' };
  /* Carried again while the chain was read: what was read is not what is kept now. */
  if (now.deploy?.tx !== saved.deploy.tx || now.signed?.tx !== saved.signed?.tx) return { of: 'not-confirmed' };
  await setCreationAside(accountId);
  return { of: 'dropped' };
}

/** True when the person's wallet, reading the account itself, shows the company's pay-record key committed on it. */
export async function walletShowsPayKeyCommitted(
  walletOrigin: string, company: CompanyLabel, account: AccountAddress, view?: Openable, atOrigin?: string,
): Promise<boolean> {
  const read = await holdersFromTheWallet(walletOrigin, { company, account, movements: [PAY_KEY_COMMITMENT_ENTRY] }, view, atOrigin);
  return read.payments !== undefined && read.payments.payKeyCommitment !== null;
}

/**
 * Asks the wallet, quietly, whether the pay-record key is committed on the account THIS BROWSER KEPT for the
 * creation: the kept label and the kept deploy's account, never a pair a service names. Null when nothing is kept
 * for the company here; false when the kept creation built no deploy.
 */
export async function keptCreationShowsItsKeyCommitted(
  accountId: string, walletOrigin: string, view?: Openable, atOrigin?: string,
): Promise<boolean | null> {
  const saved = theCreation(accountId);
  if (saved === undefined) return null;
  if (saved.deploy === null) return false;
  return await walletShowsPayKeyCommitted(walletOrigin, saved.label, saved.deploy.account, view, atOrigin);
}

/**
 * Drops what this browser kept to carry a creation on, once the company is finished: true when something was dropped,
 * false when nothing was kept. It asks the wallet itself, about the kept label and account, and refuses unless the
 * wallet shows the pay-record key committed there, so no caller can drop a creation on another's word. The
 * company's keys stay kept.
 */
export async function forgetAFinishedCreation(
  accountId: string, walletOrigin: string, view?: Openable, atOrigin?: string,
): Promise<boolean> {
  if (theCreation(accountId) === undefined) return false;
  if ((await keptCreationShowsItsKeyCommitted(accountId, walletOrigin, view, atOrigin)) !== true) {
    throw new Error('your wallet does not show this company\'s pay-record key committed on its account, so what was kept of its creation is kept. Nothing was dropped.');
  }
  if (theCreation(accountId) === undefined) return false;
  await forgetCreation(accountId);
  return true;
}

/**
 * **THE SECOND PRESS: FINISH CREATING THE COMPANY, AS ONE ACTION IN THE
 * WALLET** (`apps/wallet/src/actions/finish-company.ts`), in one window behind
 * one passkey: the wallet builds the account's deploy and its signed second
 * step, has them sent, finishes the account, and proves the pay-record key's
 * proposal, approval and seal, each from its own reads of the chain and with
 * the founding seat it makes again from its words. This page hands the wallet
 * the saved keys as the service holds them, keeps those the wallet seals
 * again, and sends each transaction the wallet hands it where the wallet says
 * it goes (`relayForTheCreation`). It proves and signs nothing itself.
 *
 * It resolves with where the action ended: done, or stopped at a step, which
 * the person carries on from with one more press (the wallet works out from
 * the chain what is already done).
 *
 * **IN A TAB THE WALLET HAS NOT YET READ FOR**, the company is named to the
 * wallet by the label the service's record gives it, in the same one window:
 * the wallet finishes it only when it drew that label and keeps its creation in
 * the saved keys, and the action's end answer tells this tab what they hold.
 */
export async function finishCompanyInTheWallet(
  accountId: string,
  walletOrigin: string,
  opts: { readonly onStep?: (at: StepAt) => void } = {},
  view: Openable = walletInThisPage(window),
  _atOrigin: string = window.location.origin,
): Promise<ActOutcome> {
  if (!sessionLive || me === null) throw new Error('not signed in');
  const saved = theCreation(accountId);
  if (saved === undefined && canOpenCompanies()) throw new NoCreationKeptHere('this browser keeps no creation for this company.');
  if (saved !== undefined) refuseWhenNotTheStarter(saved);
  const person = me.id;
  const dialog = openTheWallet(view, walletOrigin);
  try {
    const label = saved !== undefined ? saved.label : (await companyNamedFor(accountId)).label;
    const handedIn = await savedKeysForTheWallet();
    const served = await servedForTheAction(accountId);
    const ended = await actInTheWallet(view, walletOrigin, {
      intent: { name: 'finish-company', company: label },
      relay: (transaction, at) => relayForTheCreation(accountId, transaction, at),
      savedKeys: {
        person, keyring: handedIn as unknown as KeyringHandedIn, served,
        /* Kept only for the person the action runs for: somebody else signed in on this tab since is never written over. */
        keep: async (sealed, ifVersion) => {
          if (me === null || me.id !== person) return null;
          return keepWhatTheWalletSealed(sealed as unknown as Sealed, ifVersion);
        },
      },
      ...(opts.onStep === undefined ? {} : { onStep: opts.onStep }),
      minutes: 30,
      name: US_TO_A_WALLET.name,
      rdns: US_TO_A_WALLET.rdns,
    }, dialog);
    takeWhatTheActionLeft(ended, accountId);
    return ended;
  } catch (e) {
    putAway(dialog);
    throw e;
  } finally {
    doneWaiting();
  }
}

/**
 * **RUNS ONE ACTION ON A COMPANY IN THE PERSON'S WALLET**, over one window: the
 * wallet is handed the person's saved keys sealed, as the service holds them,
 * and asks this page for each call to the service the action's route list
 * names, which this page makes as the person signed in here and answers with
 * the service's status and body; what it seals again is kept over the version
 * it names. This page builds, signs and proves nothing: the wallet reads the
 * chain itself and judges every answer. Resolves with how the action ended.
 */
export async function actOnACompanyInTheWallet(
  intent: { readonly name: string } & Readonly<Record<string, string>>,
  walletOrigin: string,
  opts: { readonly onStep?: (at: StepAt) => void } = {},
  view: Openable = walletInThisPage(window),
): Promise<ActOutcome> {
  if (!sessionLive || me === null) throw new Error('not signed in');
  const person = me.id;
  const dialog = openTheWallet(view, walletOrigin);
  const send = pageWireSend(() => (me === null ? null : me.id));
  try {
    const handedIn = await savedKeysForTheWallet();
    const own = typeof intent['record'] === 'string' ? intent['record'] : null;
    const served = own === null ? [] : await servedForTheAction(own);
    const ended = await actInTheWallet(view, walletOrigin, {
      intent,
      relay: async () => false,
      call: async (request) => {
        if (me === null || me.id !== person) throw new Error('the person signed in changed, so nothing more is sent for this action.');
        return send(request.path, request as never);
      },
      savedKeys: {
        person, keyring: handedIn as unknown as KeyringHandedIn, served,
        keep: async (sealed, ifVersion) => {
          if (me === null || me.id !== person) return null;
          return keepWhatTheWalletSealed(sealed as unknown as Sealed, ifVersion);
        },
      },
      ...(opts.onStep === undefined ? {} : { onStep: opts.onStep }),
      minutes: 30,
      name: US_TO_A_WALLET.name,
      rdns: US_TO_A_WALLET.rdns,
    }, dialog);
    takeWhatTheActionLeft(ended, own);
    return ended;
  } catch (e) {
    putAway(dialog);
    throw e;
  } finally {
    doneWaiting();
  }
}

/**
 * **PUTS MONEY INTO A VAULT PRIVATELY FROM THE PERSON'S WALLET**: the private-deposit action, run over one window as
 * every action on a company is (`actOnACompanyInTheWallet`). The page names the company, the vault, the private token
 * and how much in the token's smallest units; the amount is written here as the action carries it, a whole number in
 * decimal. The wallet reads the chain itself, builds, proves and pays the deposit, and checks every field; this page
 * builds and signs nothing for it. Resolves with how the action ended.
 */
export function privateDepositInTheWallet(
  ask: {
    readonly record: string; readonly company: CompanyLabel; readonly account: AccountAddress;
    readonly vault: string; readonly token: string; readonly units: bigint;
  },
  walletOrigin: string,
  opts: { readonly onStep?: (at: StepAt) => void } = {},
  view: Openable = walletInThisPage(window),
): Promise<ActOutcome> {
  return actOnACompanyInTheWallet({
    name: 'private-deposit', record: ask.record, company: ask.company, account: ask.account,
    vault: ask.vault, token: ask.token, amount: ask.units.toString(),
  }, walletOrigin, opts, view);
}

/* The standings in which the service has already been handed the account's second step, so handing it again is not owed. */
const SECOND_STEP_HANDED: ReadonlySet<CompanyCreationState> = new Set<CompanyCreationState>(['finish-sent', 'pay-key-owed', 'finished']);

/**
 * **WHERE EACH TRANSACTION OF FINISHING A COMPANY GOES**, by what the wallet
 * says it is for (`FINISH_COMPANY_RELAYS`). True once the service has taken it;
 * false for anything else, which stops the action at that step. A name this
 * page does not know is refused, never guessed at.
 */
export async function relayForTheCreation(
  accountId: string, transaction: string, at: { readonly what?: string; readonly also?: string },
): Promise<boolean> {
  const at$ = `/api/accounts/${accountId}/creation`;
  const post = async (path: string, body: unknown): Promise<boolean> => {
    await api(path, { method: 'POST', body: JSON.stringify(body) });
    return true;
  };
  switch (at.what) {
    case 'creation':
    case 'creation-again': {
      if (at.also === undefined) return false;
      /* The service records the account against the company it was told was founded; tell it first if it was not. */
      const saved = theCreation(accountId);
      if (saved !== undefined) await sendTheCompany(saved);
      /*
       * WHERE THE CREATION GOES IS WHAT THE SERVICE HOLDS, not what the wallet
       * did: the wallet cannot know whether a relay answered late was recorded.
       * A deploy the service holds and says may be replaced takes the one carried
       * again in its place; anything else goes to the creation itself, which
       * records a first deploy and sends the recorded one again.
       */
      const held = await companyCreationStanding(accountId);
      const replaces = held.state !== 'not-created' && held.replaceable === true;
      return post(replaces ? `${at$}/again` : at$, { deploy: transaction, insert: at.also });
    }
    case 'creation-finish': {
      /* Handed again after a stop: already with the service, so nothing more is sent and the wallet carries on. */
      if (SECOND_STEP_HANDED.has((await companyCreationStanding(accountId)).state)) return true;
      return post(`${at$}/finish`, { insert: transaction });
    }
    case 'pay-key-propose': return post(`${at$}/pay-key`, { call: 'propose', tx: transaction });
    case 'pay-key-approve': return post(`${at$}/pay-key`, { call: 'approve', tx: transaction });
    case 'pay-key-seal': return post(`${at$}/pay-key`, { call: 'sealPayKey', tx: transaction });
    default: return false;
  }
}

/** **WHETHER A COMPANY IS FINISHED**, as the service reads its record and the chain. */
export async function companyCreationStanding(accountId: string): Promise<{ account: AccountAddress | null; state: CompanyCreationState; replaceable?: boolean }> {
  let answer;
  try {
    answer = await api(`/api/accounts/${accountId}/creation`);
  } catch (e) {
    /* A company this browser keeps that the service never stored (the first press's send failed) is not created. */
    if (e instanceof NotOnTheService && theCreation(accountId) !== undefined) return { account: null, state: 'not-created' };
    throw e;
  }
  const state = creationStateOf(answer.state);
  if (typeof answer.replaceable === 'boolean') {
    return { account: readAccountAddress(answer.account), state, replaceable: answer.replaceable };
  }
  return { account: readAccountAddress(answer.account), state };
}

/** A state the service named, or `unknown` for anything this page does not know. */
const creationStateOf = (s: unknown): CompanyCreationState =>
  COMPANY_CREATION_STATES.find((k) => k === s) ?? 'unknown';

/**
 * Opens an account the server just served us.
 *
 * The server sends ciphertext because that is all it has: the company
 * name, the signer list, the roles and the spending limits are sealed under a
 * key it never sees. Opening happens here, on the device that can, using exactly
 * the same code the server used to seal it.
 *
 * **THE SIGNERS ARE READ ONLY FROM THE COMPANY'S ROSTER RECORD, AND ONLY AS
 * THIS DEVICE BELIEVES IT** (`rosterBelievedHere`): filed by a seat the
 * company's directory believes, read afresh with the chain as `holders` reads
 * it through the person's own wallet, and each entry held to its own signer's
 * witnesses, this device's own key among them for its own entry. A company with
 * no roster record is refused with `NO_ROSTER_RECORD`; the unsigned list on
 * its account record is never read. A refusal throws `RosterNotBelieved`. Each
 * entry refused on its own is handed back beside the company, with why.
 *
 * The roster opens under the company's key of the epoch it was sealed at,
 * from `companyKeys`.
 *
 * Returns null rather than throwing when this device holds no keys for the
 * account. That is a real state — you are a member, on a machine you have not
 * enrolled — and the account picker has to render something for it.
 */
export async function openAccount(
  rec: SealedAccount & { readonly roster?: SealedCompanyRecord | null },
  holders: (company: CompanyLabel, account: AccountAddress) => Promise<AccountHoldersRead>,
  anchored: (accountId: string, company: CompanyLabel, account: AccountAddress) => DirectoryHereDeps['anchored'],
  leaves: (company: CompanyLabel, account: AccountAddress) => DirectoryHereDeps['leaves'],
  companyKeys?: (rec: SealedAccount) => Promise<KeysHeld>,
): Promise<OpenedAccount | null> {
  return openAccountWith({ api, keysFor: seatHeldHere, servedKeyFor: viewingKeyFor }, rec, holders, anchored, leaves, companyKeys);
}

/** The seats the company's roster admitted, read with the same doors as `openAccount`; throws when this device holds no keys for it. */
export async function seatsAdmittedFor(
  rec: SealedAccount & { readonly roster?: SealedCompanyRecord | null },
  holders: Parameters<typeof openAccount>[1], anchored: Parameters<typeof openAccount>[2], leaves: Parameters<typeof openAccount>[3],
  companyKeys?: Parameters<typeof openAccount>[4],
): Promise<ReadonlySet<string>> {
  return seatsAdmittedWith({ api, keysFor: seatHeldHere, servedKeyFor: viewingKeyFor }, rec, holders, anchored, leaves, companyKeys);
}
