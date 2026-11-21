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
import { notePreparing } from './read-bound.js';
import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { toHex, type Hex, type Sealed } from '../../../src/core/crypto.js';
import {
  askWalletToSignIn, US_TO_A_WALLET, WalletClosed, type Openable, type WalletDialog,
} from './wallet-sign-in.js';
import { actInTheWallet, type ActOutcome } from './wallet-act.js';
import {
  AnotherPersonError, AuthError, CouldNotCheckError, ServiceRefused, theSignInIsHeldBy,
} from './service-transport.js';
import { walletCallsOnPage } from './asks-on-page.js';
import { personOnPage } from './person-on-page.js';
import { doneWaiting, forgetTheWalletsIndexer, openTheWallet, putAway } from './wallet-asks.js';
import { readsAreStale, STALE } from './company-reads-stale.js';
import type { NotAskedWhy, StepAt } from 'midnight-identity/profile/channel';
import type { KeyringHandedIn, KeysRead, SealedKeyring } from 'midnight-identity/profile/unlock';
import { MOST_SERVED, type FoundingAsked, type ServedHandedIn } from 'midnight-identity/profile/request';
/* The screen that draws the waiting needs the type, and it should not have to
 * know which file below this one the wallet plumbing lives in. */
export type { WalletDialog } from './wallet-sign-in.js';
import { askWalletForKeys, UnlockRefused } from './wallet-unlock.js';
/* **THE WALLET IS SHOWN INSIDE THIS PAGE.** Every journey below defaults to it;
 * a test hands in a window of its own and drives the same conversation. */
import { walletInThisPage } from './wallet-frame.js';

/** A company as this device opened it: the entries it believes, and each entry it refused with why, for a screen to say. */
export type { OpenedAccount } from './company-judges.js';

export type { CompanyCreationState } from '../../../src/core/company-founding.js';
import { seatToPromote } from './seat-repair.js';
import type { SealedAccount } from '../../../src/core/types.js';
import { onlyCompanyLabels, rememberedCompanies } from './my-payslips.js';
import {
  metadataFrom, type Keyring, type OwedDirectoryEntry, type PendingSeat, type SeatPublicHalves,
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
/** The saved keys' parts that open nothing, as the wallet last said them: what a creation in progress reads its own state from. */
export const keptKeyring = (): Keyring => keyring;
/**
 * Whether a person's first keys may be saved from this tab: some are saved already, or this tab signed the person in
 * and so can tell which wallet answers (`keyCheckedAgainstSignIn`).
 */
export const firstKeysMaySaveFromHere = (): boolean => savedKeys === 'some' || keyCheckedAgainstSignIn;
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
export function viewingKeyFor(account: Pick<SealedAccount, 'id' | 'wrappedKeys'>): Hex {
  if (seatHeldHere(account.id) === null) throw new Error('no keys for this account on this device');
  const key = read?.viewing[account.id];
  if (key === undefined) throw new Error('you have not been granted access to this account yet');
  return key;
}

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
/* ---------------- sign in and out ---------------- */

/*
 * **`signInWithWallet` BELOW IS THE ONLY WAY IN**, and `openKeysWithWallet` is
 * what has the wallet read the saved keys for this tab. Nothing in this module
 * produces a key from a typed secret: every key it holds was released by the
 * person's wallet, and none of them opens the saved keys.
 */

/**
 * SIGNING IN WITH THE WALLET: how a person gets in.
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
    const challenge = await personOnPage.challenge() as { nonce: string; expiresAt: string; handle: string };
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
  const r = await personOnPage.signIn({
    handle: challenge.handle, nonce: challenge.nonce, response,
    ...(inviteToken ? { inviteToken } : {}),
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
  /* Whatever this tab read of a company, it read as whoever was signed in before. */
  readsAreStale({ company: null, why: STALE.signedIn, signedIn: true });
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
      const r = await personOnPage.me() as { user: unknown };
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
 *
 * **A STOP WHILE PREPARING IS SAID TWICE.** The page writes which step it stopped
 * at and the kind of error (`notePreparing`), and tells the window it opened why it
 * will not ask (`notAsking`), so the window shows that reason instead of waiting.
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
  const what = opening === undefined ? 'opening your saved keys' : 'opening a company';
  const at = { step: OPEN_STEP.naming as OpenStep };
  try {
    /* A company the service will not name is opened as none: the saved keys still open, and the stop is written. */
    const named = opening === undefined ? null : await companyNamedFor(opening).catch((e: unknown) => {
      notePreparing(`${what}: the service did not name the company (${kindOf(e)}), so only the saved keys are opened`);
      return null;
    });
    const company = named === null || named.account === null ? null : named;
    await openKeysOnceOpen(walletOrigin, view, atOrigin, dialog, company, undefined, company !== null, (step) => { at.step = step; });
  } catch (e) {
    /* Before the ask, or an ask that was never put together: the wallet was asked nothing. */
    const before = at.step !== OPEN_STEP.answered
      && (at.step !== OPEN_STEP.asking || !(e instanceof WalletClosed || e instanceof UnlockRefused));
    notePreparing(`${what}: stopped while ${at.step} (${kindOf(e)})${before ? ', before anything was asked of the wallet' : ''}`);
    /* A dialog a longer journey opened is that journey's to put away. */
    if (!already) {
      try { if (before) dialog.notAsking?.(NOT_ASKED_AT[at.step]); } finally { putAway(dialog); }
    }
    throw e;
  } finally {
    doneWaiting();
  }
}

/** The steps the page takes to open the saved keys, in order, as the console report names them. */
const OPEN_STEP = {
  naming: 'naming the company',
  signedIn: 'checking you are signed in',
  savedKeys: 'reading your saved keys from the service',
  savedKeysOlder: 'checking your saved keys',
  companies: 'reading the companies you belong to',
  asking: 'asking the wallet',
  answered: 'taking in what the wallet gave',
} as const;
type OpenStep = (typeof OPEN_STEP)[keyof typeof OPEN_STEP];

/** What the window is told for a stop at each step before the ask; the wallet says it in its own words. */
const NOT_ASKED_AT: Readonly<Record<OpenStep, NotAskedWhy>> = {
  [OPEN_STEP.naming]: 'ask-not-built',
  [OPEN_STEP.signedIn]: 'signed-out',
  [OPEN_STEP.savedKeys]: 'saved-keys-unread',
  [OPEN_STEP.savedKeysOlder]: 'saved-keys-older',
  [OPEN_STEP.companies]: 'ask-not-built',
  [OPEN_STEP.asking]: 'ask-not-built',
  [OPEN_STEP.answered]: 'ask-not-built',
};

/** An error's kind, for the console report: its class, and for a wallet window that ended, how. Never its message. */
const kindOf = (e: unknown): string => {
  if (e instanceof WalletClosed) return `WalletClosed ${e.refusal.of}`;
  if (e instanceof Error) return e.constructor.name !== '' && e.constructor.name !== 'Error' ? e.constructor.name : e.name;
  return typeof e;
};

export async function openKeysOnceOpen(
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
  /** Told each step as it starts, so a caller can say which one a stop came at. */
  step?: (at: OpenStep) => void,
): Promise<{
  drawn: CompanyLabel | null; committeeKey: { tag: string; value: string } | null;
  founding: { founded: Readonly<Record<string, unknown>>; sealed: SealedKeyring; ifVersion: number } | null;
  /** With `'new'`: what the wallet read from the saved keys it sealed with the new seat, taken in only once they are kept. */
  read: KeysRead | null;
}> {
  step?.(OPEN_STEP.signedIn);
  const who = me;
  if (who === null) throw new Error('not signed in');
  /* **THE ADDRESS THIS TAB SIGNED IN AS, FROM THE SERVICE'S OWN ANSWER TO THAT
   * SIGN-IN**, or null in a tab that did not sign anybody in. It gates and never
   * derives: the wallet will not answer without holding it. */
  const signedInAs = walletAddress;
  /* The saved keys a founding was handed are the copy the wallet reads: one read for the press, the one it seals over. */
  step?.(OPEN_STEP.savedKeys);
  const handedIn = founding !== undefined ? founding.keyring : await savedKeysForTheWallet();
  /* **A READ THAT HAS GONE BACKWARDS IS NOT HANDED ON.** Saved keys only ever grow, one accepted write at a time; an
   * older version, or nothing where the wallet has read something for this tab, is the server answering from before. */
  step?.(OPEN_STEP.savedKeysOlder);
  if (read !== null && (handedIn.version < bundleVersion || (savedKeys === 'some' && handedIn.sealed === null))) {
    throw new SavedKeysWentBack(WENT_BACK);
  }
  step?.(OPEN_STEP.companies);
  const tidy = [...tidyOwed].map(([record, what]) => ({ record, what }));
  const keys = founding !== undefined ? undefined : { keyring: handedIn, served: await servedForTheWallet(), tidy };
  step?.(OPEN_STEP.asking);
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
  step?.(OPEN_STEP.answered);
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
export function takeTheRead(got: KeysRead, some: boolean, version: number): void {
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
export function takeWhatTheActionLeft(outcome: ActOutcome, accountId: string | null): void {
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
export async function servedForTheAction(accountId: string): Promise<ServedHandedIn[]> {
  return (await servedForTheWallet()).filter((s) => s.accountId === accountId).slice(0, 1);
}

async function servedForTheWallet(): Promise<ServedHandedIn[]> {
  let listed: unknown;
  try { listed = await personOnPage.companies(); } catch (e) {
    notePreparing(`reading the companies you belong to failed (${kindOf(e)}), so none is handed to the wallet`);
    return [];
  }
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
export async function companyNamedFor(accountId: string): Promise<{ accountId: string; label: CompanyLabel; account: AccountAddress | null }> {
  const answer = await personOnPage.companyNamed(accountId) as { company?: unknown; account?: unknown } | null;
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
 * Forgets everything this tab holds. LOCAL ONLY — it does not sign the person
 * out on the server, and it must not: it is also what the service transport runs on a 401, where
 * the sign-in is already gone and calling the API again would recurse.
 *
 * Use `signOut()` for the button.
 */
export function forgetLocally() {
  sessionLive = false; read = null; keyring = { accounts: {} }; me = null; walletAddress = null;
  releasedCompanyKey = null; savedKeys = null; keyCheckedAgainstSignIn = false; tidyOwed.clear();
  forgetTheWalletsIndexer();
  readsAreStale({ company: null, why: STALE.signInEnded, signedIn: false });
}

theSignInIsHeldBy({
  person: () => me,
  isLive: () => sessionLive,
  lost: (why) => { forgetLocally(); forgotBecause = why; },
});

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
    await personOnPage.signOut();
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
  return ((await personOnPage.sessions()) as { sessions: unknown }).sessions as Array<{
    id: string; issuedAt: string; expiresAt: string;
    userAgent: string | null; current: boolean;
  }>;
}

/** Ends one of them by id. "Sign out that phone." */
export async function endSession(id: string) {
  await personOnPage.endSession(id);
}

/** Ends every other session and keeps this one. */
export async function signOutEverywhereElse() {
  return ((await personOnPage.endOtherSessions()) as { ended: unknown }).ended as number;
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
  const r = await personOnPage.savedKeys() as { keyBundle?: unknown; version?: unknown } | null;
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
    r = await personOnPage.keepSavedKeys({ keyBundle: sealed, ifVersion }) as Record<string, unknown> | null;
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
export const tidyOwed = new Map<string, 'aside' | 'forget'>();

const HEX64_KEY = /^[0-9a-f]{64}$/u;

/** A committee key as the wallet gave it, or null when it is not one. */
export const schnorrKeyOf = (k: { tag: string; value: string } | null): { tag: 'schnorr'; value: string } | null => {
  if (k === null || k.tag !== 'schnorr') return null;
  const value = String(k.value).toLowerCase();
  return HEX64_KEY.test(value) ? { tag: 'schnorr', value } : null;
};

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
  const send = walletCallsOnPage(() => (me === null ? null : me.id));
  try {
    const handedIn = await savedKeysForTheWallet();
    const own = typeof intent['record'] === 'string' ? intent['record'] : null;
    const served = own === null ? [] : await servedForTheAction(own);
    const ended = await actInTheWallet(view, walletOrigin, {
      intent,
      relay: async () => false,
      call: async (request) => {
        if (me === null || me.id !== person) throw new Error('the person signed in changed, so nothing more is sent for this action.');
        return send(request);
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
    /* Whatever the action wrote, this page read the company before it: what it read is stale, and whoever holds it is told. */
    if (typeof intent['record'] === 'string') readsAreStale({ company: intent['record'], why: STALE.actedInTheWallet, signedIn: true });
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
