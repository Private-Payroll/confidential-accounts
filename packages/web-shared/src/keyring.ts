/**
 * The client half of identity.
 *
 * Everything that can decrypt lives here, in the browser, and nowhere else. The
 * server holds a sealed blob it cannot open, and no credential of any kind. That is the entire trust model, and this file is where it is
 * either honoured or quietly broken, so it is deliberately small.
 *
 * What is in memory while signed in:
 *   encKey   RELEASED BY THE WALLET for this person on this site, never transmitted
 *   keyring  signing and wrapping secrets, one entry per account
 *
 * **AND WHAT IS NOT IN THIS PAGE AT ALL: THE SIGN-IN ITSELF.** It is a cookie the
 * server sets and this page's code cannot read, so no script here can copy it
 * off the machine, and the browser sends it with every request to this site.
 *
 * What survives a page reload: the sign-in, and nothing else. A reload keeps
 * you signed in and does not keep a company open: **`encKey` is asked of the
 * wallet again**, because keeping it in storage would put it where any script
 * on the page can read it.
 */
import { boundedRead, isReadMethod } from './read-bound.js';
import type { KeysHeld } from '../../../src/core/company-key.js';
import type { Inviter, SignedSeatInvitation } from '../../../src/core/invitation.js';
import type { DirectoryHereDeps, OwedDirectoryEntry } from './vault-page-doors.js';
import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountAddress, CompanyLabel, VaultAddress } from 'midnight-identity/profile/company-label';
import { randomBytes, seal, sign, signingPublicKeyOf, toHex, unseal, unwrapKey, type Hex, type Sealed } from '../../../src/core/crypto.js';
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import { PAY_KEY_COMMITMENT_ENTRY } from 'midnight-identity/profile/records-key';
import { NO_ASSET } from '../../../src/core/assets.js';
import {
  askWalletToSignIn, openWalletDialog, WalletClosed, type Openable, type WalletDialog,
} from './wallet-sign-in.js';
/* The screen that draws the waiting needs the type, and it should not have to
 * know which file below this one the wallet plumbing lives in. */
export type { WalletDialog } from './wallet-sign-in.js';
import { askWalletForKeys } from './wallet-unlock.js';
import { askWalletToPay } from './wallet-balance.js';
import { askWalletToSignCommittee, type CommitteeAsked } from './wallet-committee.js';
import { askWalletToFinishCreation } from './wallet-creation.js';
import { aStepIsShortOfLife } from '../../../src/midnight/intent-lifetime.js';
import {
  askWalletToSignRecordsKey, askWalletWhoHolds, type HoldersAsked, type HoldersRead, type RecordsKeyAsked, type RecordsKeySigned,
} from './wallet-records-key.js';
/* **THE WALLET IS SHOWN INSIDE THIS PAGE.** Every journey below defaults to it;
 * a test hands in a window of its own and drives the same conversation. */
import { walletInThisPage, walletQuietlyInThisPage } from './wallet-frame.js';
import { approvalMessage } from '../../../src/core/account.js';
import { rosterBelievedHere, RosterNotBelieved, seatsAdmittedHere, type BelievedAccount } from './roster-here.js';
import { directoryFilingsFrom } from './vault-page-doors.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { openRoster } from '../../../src/core/roster-record.js';
import {
  COMPANY_CREATION_STATES, foundTheCompanyHere, type CompanyCreationState, type CompanyFounded,
} from '../../../src/core/company-founding.js';
import { CREATED_BEFORE_SIGNED_STATE, openStateRecord } from '../../../src/core/founding-state.js';
import type { AccountCallChainOnTheWire, AccountPresenceOnTheWire, PayKeyStandingOnTheWire } from './vault-worker-client.js';
import type { GovernedCallOrder, OpenedRound, SignerMaterial } from './governed-call-builder.js';

export type { CompanyCreationState } from '../../../src/core/company-founding.js';
import { newSeatKeys } from './accept-seat.js';
import type { SeatOpening } from '../../../src/core/seat-opening.js';
import { clobberRefusal, seatToPromote } from './seat-repair.js';
import type { SealedAccount } from '../../../src/core/types.js';
import {
  forgetRememberedCompanies, markOlderListTaken, olderListNotYetTaken, onlyCompanyLabels,
  rememberedCompanies,
} from './my-payslips.js';

export interface AccountKeys {
  signerId: string;
  signingSecret: Hex;
  wrappingSecret: Hex;
  /**
   * Hides this signer in the on-chain signer tree. As precious as the signing
   * key: without it the signer cannot reproduce their leaf and cannot prove
   * membership on the contract, even holding a valid key. Recovery has to
   * restore this too.
   */
  blinding: Hex;
  /**
   * **THE LEAF'S THIRD ARGUMENT, ON THE DEVICE AND NOT ON THE ROSTER.**
   *
   *
   * The circuit reads the scope from the DEVICE's private state
   * (`signerScope()`, a witness over `AccountPrivateState.scope`), so this is
   * the client's copy of the same thing and it belongs beside the blinding.
   * Putting it on the seat instead would tell the server which vault a signer
   * is scoped to, which is exactly the partition of the signer set the leaf's
   * blinding exists to hide.
   *
   * **REQUIRED, AND AN ENTRY SAVED WITHOUT ONE IS REFUSED BY NAME.** Key
   * material saved before scopes were recorded has none. Reading that absence
   * as any value - the scheme's own "every vault", or thirty-two zero bytes -
   * would be this page deciding a seat's leaf for it, and a wrong guess is a
   * signer who cannot prove they are one on a device that looks healthy. So
   * such an entry is not handed out at all: `keysFor` refuses it, and says the
   * seat has to be taken on this device again. Nothing converts one.
   */
  scope: Hex;
  /**
   * **THE SEAT THAT INVITED THIS SIGNER: ITS COMMITTEE KEY AND THE DIRECTORY
   * ENTRY ITS WALLET SIGNED**, as the invitation carried it. Handed to this
   * person's wallet on their first records-key ask for the company, which keeps
   * no account for a company it did not create until the person confirms it
   * against the inviter's. Absent for a seat taken without an invitation.
   */
  invitedBy?: Inviter;
  /**
   * **WHO THE SEAT IS FOR, AS THE SEAT THAT INVITED SIGNED IT**, kept from the
   * invitation this person accepted until their own directory entry carries it,
   * which every member's device holds it to. Absent for the founding seat and
   * for a seat added from a code.
   */
  invited?: SignedSeatInvitation;
  /**
   * **THIS SEAT'S OPENING OF ITS OWN LEAF**, made on this device when the seat
   * was taken: its public key on the account, scope and blinding, and the
   * wallet key and salt the blinding was made from. Carried in the seat's own
   * directory entry, which other devices believe only through it. Absent for a
   * seat taken on a device that made none, whose entry is then never believed:
   * that seat is taken again.
   */
  opening?: SeatOpening;
}

/** An entry as a saved bundle may hold it: material saved before scopes were recorded has no scope. */
export type SavedAccountKeys = Omit<AccountKeys, 'scope'> & { scope?: unknown };

/** Key material this device holds for a company, saved before scopes were recorded. */
class SeatSavedBeforeScopes extends Error {
  constructor(readonly accountId: string) {
    super(
      'the keys saved for you for this company were written before vault scopes were recorded, so they ' +
        'cannot say which vaults you may act on, and nothing here guesses or converts them. Nothing was ' +
        'opened, signed or sent. Your keys are saved for your sign-in, so taking a seat again under the same ' +
        'sign-in is refused too; a seat taken under a new invitation by another sign-in can act. A company ' +
        'where every signer holds keys like these can no longer act at all.',
    );
    this.name = 'SeatSavedBeforeScopes';
  }
}

const SCOPE = /^[0-9a-fA-F]{64}$/u;

/**
 * **THE KEYS A SAVED ENTRY MAY BE USED AS, OR A REFUSAL.** An entry with no
 * scope, or a scope that is not thirty-two bytes, is refused; nothing is
 * filled in.
 */
function keysToActWith(accountId: string, saved: SavedAccountKeys | undefined | null): AccountKeys | null {
  if (!saved) return null;
  if (typeof saved.scope !== 'string' || !SCOPE.test(saved.scope)) throw new SeatSavedBeforeScopes(accountId);
  return { ...saved, scope: saved.scope };
}

/**
 * **KEY MATERIAL THAT IS DURABLE BEFORE ITS LEAF IS PUBLISHED.**
 *
 * A leaf published before its material is sealed, followed by a refused bundle
 * write, seats a signer whose key material never survived - a seat that counts
 * towards N and can never approve, which is the state `ownLeafReading` detects.
 *
 * So the material is sealed HERE first, under the
 * account it is for, and only then does a leaf leave the machine. The entry
 * carries no `signerId` because the server has not assigned one yet, and
 * `signingPublicKey` is what
 * matches it back to a seat on the roster afterwards.
 */
export interface PendingSeat {
  /** Which account this seat is on. The key of the map is not this. */
  accountId: string;
  signingPublicKey: Hex;
  signingSecret: Hex;
  wrappingSecret: Hex;
  blinding: Hex;
  scope: Hex;
  /** The seat that invited this signer, as the invitation carried it; promoted with the material. */
  invitedBy?: Inviter;
  /** This seat's opening of its own leaf, made here with the leaf; promoted with the material. */
  opening?: SeatOpening;
  /** Who the seat is for, as the seat that invited signed it; promoted with the material and carried into the seat's own entry. */
  invited?: SignedSeatInvitation;
}

/**
 * **THE APPROVAL SIGNATURE IS MADE HERE, WHICH IS TO SAY ON THIS MACHINE.**
 *
 *
 * Approving used to be a POST carrying `signingSecret`, and the server made the
 * signature. That handed a whole signing key to a party that only ever needed
 * one signature from it — and a key that has produced one signature can produce
 * every other, so a three-of-five account was a one-of-one account for anybody
 * who had been given a seat's secret once.
 *
 * It lives in this file rather than in the screen that draws the button because
 * this file is the only part of the client that is allowed to touch a secret;
 * everything above it works in signatures, tokens and public keys. A screen that
 * can reach `signingSecret` is a screen that can put it in a request body, which
 * is exactly the mistake being removed — so the screens no longer can.
 *
 * **WHAT IS SIGNED IS `approvalMessage(proposal)`, NOT THE DIGEST ALONE.**
 * A digest states what a proposal SAYS; `chainId` states which round it IS and which
 * vault will pay. Signing the digest alone made a signature replayable across
 * rounds and across vaults. One definition, in `core/account.ts`.
 */
export function signApproval(proposal: { digest: Hex; chainId: Hex }, keys: { signingSecret: Hex }): Hex {
  return sign(approvalMessage(proposal), keys.signingSecret);
}

/**
 * THIS IS A KEYRING, NOT A VAULT, AND THE RENAME IS NOT COSMETIC.
 *
 * It was called `Vault`, while `src/midnight/vault-*.ts` and
 * `docs/scope-vaults-and-settlement.md` use that same word for **the thing
 * money actually moves through.** Two unrelated concepts under one name, both
 * live — and it read as though signing up created a keyring, which it does not
 * and must not. **A principal signs up and holds no money.** Vaults are made
 * later, and one person can be associated with several: their own payee
 * address, and one per company they are a signer on.
 *
 * What this holds is the keys that OPEN things, one entry per account.
 */
export interface Keyring {
  /** Keyed by account id. As saved, so an entry may predate scopes; `keysFor` is the only way one is handed out. */
  accounts: Record<string, SavedAccountKeys>;
  /**
   * **KEYED BY SIGNING PUBLIC KEY, NOT BY ACCOUNT**, and normally empty.
   *
   *
   * An entry here is key material this device sealed BEFORE publishing the leaf
   * it makes, and it survives until the seat it belongs to is on the roster and
   * has been promoted into `accounts`.
   *
   * **KEYED BY THE KEY BECAUSE KEYING BY ACCOUNT DESTROYS MATERIAL.** If a
   * POST succeeds and the promotion then fails, an entry here holds the ONLY
   * copy of the blinding for a leaf that is already on a roster. Under an
   * account-keyed map a second accepted invite for the same account overwrites
   * it, and that loses the material for good, made by the fix for
   * A signing public key is unique per seat and is the one half of this
   * material the server was given, so it names the seat without naming a
   * secret.
   *
   * **Optional, because an older bundle has no such field** and
   * `JSON.parse` of one must keep working.
   */
  pendingSeats?: Record<string, PendingSeat>;
  /**
   * **THE COMPANIES THAT PAY THIS PERSON, BY THEIR PUBLIC CONTRACT ADDRESS.**
   *
   * Kept here, sealed with everything else, because the service must not hold
   * in a form it can read which signed-in person is paid by which company. It
   * holds nothing that opens anything: the key that opens a payslip is worked
   * out from the wallet each time.
   *
   * **Optional, because saved keys written before it have no such field** and
   * `JSON.parse` of them must keep working.
   */
  paidBy?: string[];
  /**
   * **EVERY COMPANY THIS PERSON HAS STARTED ON A CHAIN AND NOT FINISHED**, keyed by the company, any number at once.
   * Each is kept on its own and finished, started again, set aside or taken up on its own. One that was started again
   * after its deploy was signed or sent is kept with `setAside: true` (not deleted: its deploy may still turn up on
   * the chain). Optional, because saved keys written before it have no such field.
   */
  creations?: Record<string, SavedCreation>;
  /**
   * **ONLY IN SAVED KEYS WRITTEN BEFORE EVERY CREATION WAS KEPT IN `creations`.** A creation set aside used to live
   * here. `creationsInOneRecord` folds each one into `creations` (marked `setAside`) when the keys are read, and
   * nothing writes this field again.
   */
  creationsSetAside?: Record<string, SavedCreation>;
  /**
   * **THIS PERSON'S SIGNED DIRECTORY ENTRY FOR A COMPANY, UNTIL ITS DIRECTORY
   * HOLDS IT**, keyed by the company (`fileTheOwedDirectoryEntry`). Public
   * keys and a signature: nothing here opens anything. Optional, because saved
   * keys written before it have no such field.
   */
  directoryEntriesOwed?: Record<string, OwedDirectoryEntry>;
}

export interface Me { id: string; email: string | null; name: string }

/**
 * **WHETHER THIS TAB HAS A LIVE SESSION.** Not the sign-in: that is a cookie
 * this code cannot read. Set by a sign-in or by `resumeSession`, and cleared by
 * a sign-out or the first `401`.
 */
let sessionLive = false;
let encKey: Hex | null = null;
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
 * This module keeps it in memory only, like `encKey`, and writes it nowhere. The
 * server holds only a hash of it (`walletKeyOf`), so after a reload it is back
 * only when the screen that made the sign-in chose to carry it across in its
 * own tab and hands it to `resumeSession` (`SignInCarried`).
 */
let walletAddress: string | null = null;
/**
 * **THE KEY THE WALLET RELEASED, AND WHICH COMPANY IT WAS RELEASED FOR.**
 *
 *
 * `encKey` alone cannot answer this. It means *"the key that opens the bundle,
 * however this tab came by it"*, and nothing downstream can tell which unlock
 * gave it, **which is exactly why a second variable is needed here.** A payslip
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
 * company's key, for the same reason as `encKey`: a reload asks the wallet again.
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
 * **WHAT THE SERVER HOLDS SAVED FOR THIS PERSON, AS LAST READ AND OPENED HERE.**
 *
 * `none` is a person with no saved keys at all on this deployment; `some` is a
 * saved bundle, which this tab has opened. Null until this tab has opened them.
 *
 * It is what lets a company this tab cannot open say something true. A person
 * has ONE saved bundle and every device and every wallet release reaches the
 * same one, so once it has been opened, a company missing from it is missing
 * everywhere this deployment could offer it - not merely missing from this
 * device.
 */
let savedKeys: 'none' | 'some' | null = null;
/**
 * **WHETHER THE KEY THIS TAB HOLDS WAS GIVEN BY THE WALLET THIS TAB SIGNED IN WITH.**
 *
 * True only when the wallet was asked for it naming the address this tab's own
 * sign-in answer carried - and a wallet gives that key only when one of its own
 * accounts has exactly that address. A tab that did not sign anybody in (a
 * reload, a second tab) does not know the address and asks without it.
 *
 * **IT DECIDES ONE THING: WHETHER A PERSON'S FIRST KEYS MAY BE SAVED FROM HERE.**
 * Once keys are saved, a key from any other wallet fails to open them and is
 * refused, so what is saved is its own check. Before anything is saved there is
 * nothing to check against, and the keys saved first are sealed under whichever
 * wallet answered - so they are saved only under a key this tab asked for with
 * the address it signed in as.
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
 * Every company's viewing key is reached through the keyring, and the keyring
 * is sealed under `encKey`. A wallet sign-in produces a signature, and *a
 * signature is not a key*, so signing in opens nothing.
 *
 * **`encKey` IS THE KEY THE WALLET DERIVES FOR THIS PERSON ON THIS SITE**, set
 * only by opening the saved keys, after a person pressed a button on the
 * wallet's own screen. It is not any company's key: a person's keys for every
 * company they belong to here are sealed under it together, which is what lets
 * one wallet address belong to more than one company. Everything downstream -
 * `viewingKeyFor`, `openAccount`, `putBundle` - reads the keyring and never
 * asks which key opened it.
 */
export const canOpenCompanies = () => encKey !== null;

/**
 * **WHY A COMPANY THIS PERSON IS ON CANNOT BE OPENED FROM THIS TAB**, in a few
 * words for a list row. The full sentence, with what would change it, is
 * `lockedCompanyRefusal`.
 *
 * Every sentence is about what THIS TAB READ, and says so. Another tab or
 * device can save keys after this one looked, and a tab can be holding keys it
 * has not managed to save, so nothing here claims what no device can do.
 */
function lockedCompanyReason(accountId: string): string {
  try {
    keysFor(accountId);
  } catch (e) {
    if (e instanceof SeatSavedBeforeScopes) return 'the keys saved for you were written before vault scopes were recorded';
    throw e;
  }
  if (anythingSavedFor(accountId)) return 'it did not open with the keys saved for you';
  if (savedKeys === 'none') return 'no keys were saved for you here when this tab last looked';
  if (savedKeys === 'some') {
    return 'the keys saved for you here, when this tab last looked, do not include this company';
  }
  return 'your wallet has not opened the keys saved for you in this tab yet';
}

function lockedCompanyRefusal(accountId: string): string {
  if (anythingSavedFor(accountId)) {
    return `${lockedCompanyReason(accountId)}: you may not have been given access to it yet.`;
  }
  if (savedKeys === null) {
    return 'your wallet has not opened the keys saved for you in this tab yet, so this company '
      + 'cannot be opened until it has.';
  }
  /*
   * **CONDITIONS ARE NAMED AS CONDITIONS, NOT AS WHAT WILL HAPPEN.** A company
   * made by something that kept no keys for this person, or started in a tab
   * that closed before finishing, never has keys saved - and a refusal that
   * only said what would open it read as a promise that something would.
   */
  return `${lockedCompanyReason(accountId)}. It opens here only once keys for it are saved for you - `
    + 'by the tab that created it finishing setting it up - and opening it reads what is saved '
    + 'again. If that tab was closed first, or the company was made by something that kept no keys '
    + 'for you, nothing can open it.';
}

/**
 * **WHY THE KEYS SAVED FOR YOU DID NOT OPEN, SAID WHEN THEY DO NOT.** Nothing is
 * written over keys this tab cannot open, so both causes a person can do
 * something about are named, and the one they cannot is named as that.
 */
const DID_NOT_OPEN = 'the keys saved for you here did not open with the key your wallet gave, so '
  + 'nothing has been opened, and nothing will be saved over them. Each wallet gives a different key: '
  + 'if the wallet that answered is not the one your keys were saved with, answer with that one. If '
  + 'it is, they were saved in a way this site no longer opens, and nothing here can open them.';

const WENT_BACK = 'what is saved for you here is older than what this tab already read, or is gone, '
  + 'so it has not been taken in place of the keys this tab holds. Something has changed on the '
  + 'server that this page cannot explain. Do not close or reload this tab or sign out: keys this '
  + 'tab holds that are not saved anywhere else go with it.';

/** A second key, in a tab that already opened your saved keys, that is not the same key. */
const NOT_THE_SAME_WALLET = 'the wallet that answered gave a different key from the one this tab '
  + 'opened your saved keys with, so it is not the wallet you opened them with. Nothing it gave has '
  + 'been used. Answer with the wallet you signed in with.';

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

export const keysFor = (accountId: string): AccountKeys | null => keysToActWith(accountId, keyring.accounts[accountId]);

/** Whether anything at all is saved here for a company, whether or not it can be used. */
const anythingSavedFor = (accountId: string): boolean => Boolean(keyring.accounts[accountId]);

/**
 * **THIS SIGNER'S OWN THREE, FOR THE BACKGROUND THREAD THAT BUILDS A RAISE OR
 * AN APPROVAL ON THIS DEVICE.** The one place outside this file a signing key
 * goes, and it goes nowhere off this device: the thread uses it for one call
 * and keeps none of it.
 */
export function signerMaterialFor(accountId: string): { signingSecret: Hex; blinding: Hex; scope: Hex } {
  const keys = keysFor(accountId);
  if (!keys) throw new Error(lockedCompanyRefusal(accountId));
  return { signingSecret: keys.signingSecret, blinding: keys.blinding, scope: keys.scope };
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
 * The keys saved for this person did not open with the key the wallet gave, or
 * a second key the wallet gave is not the one this tab holds. Nothing was used
 * and nothing was written.
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

/** The service refused a request, and what its refusal carried besides the words: whether nothing was sent, and for what. */
class ServiceRefused extends Error {
  constructor(message: string, readonly body: Record<string, unknown>) { super(message); }
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
  if (!r.ok) throw new ServiceRefused(body?.error ?? `request failed: ${r.status}`, typeof body === 'object' && body !== null ? body : {});
  return body;
};

export const api = (path: string, opts?: RequestInit & { read?: boolean }) => {
  const { read, ...init } = opts ?? {};
  if (read !== true && !isReadMethod(init.method)) return apiOnce(path, init);
  return boundedRead(`The service (${path.split('?')[0]})`, (signal) => apiOnce(path, { ...init, signal }));
};

/* ---------------- sign in and out ---------------- */

/*
 * **`signInWithWallet` BELOW IS THE ONLY WAY IN**, and `openKeysWithWallet` is
 * what sets `encKey`, the key that opens the bundle. Nothing in this module
 * produces a key from a typed secret: every key it holds was released by the
 * person's wallet.
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
 * **WHAT WE CALL OURSELVES TO A WALLET, AND THE WALLET BELIEVES NONE OF IT.**
 *
 * Untrusted words, rendered as text on the wallet's screen beside the origin it
 * OBSERVED. One copy, because two asks now send it and a name that drifts
 * between them is a person seeing two different sites.
 */
const US_TO_A_WALLET = {
  name: 'Confidential Accounts',
  rdns: 'social.lemonade.confidential-accounts',
} as const;

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
  /* NO KEYRING AND NO `encKey`. See `canOpenCompanies` — this is not an
   * omission here, it is the state of the product after this proposal. */
  encKey = null;
  keyring = { accounts: {} };
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
 * **OPENING THE KEYS SAVED FOR THIS PERSON, WITH THE KEY THEIR WALLET GIVES FOR
 * THEM ON THIS SITE.**
 *
 * One press on the wallet's own screen, and a password appears nowhere:
 *
 *   1. **ask the wallet for the keyring key**, naming the person signed in
 *      here and - when this tab signed them in - the address it signed in as. The
 *      wallet derives the key from its seed and the person, and gives it only if
 *      one of its own accounts has that address (`wallet-unlock.ts`);
 *   2. **read the keys saved for this person and open them with it.** Keys that
 *      do not open are refused out loud and left exactly as they are: nothing
 *      is opened, nothing is written, and nothing here ever saves over them.
 *
 * **ONE KEY FOR EVERY COMPANY THIS PERSON BELONGS TO HERE.** A company's own
 * key is not asked for by this; it is asked for, in the same kind of answer,
 * only where the company's own keys are wanted (`companyKeysForVaults`).
 *
 * **THE KEY IS NEVER SENT ANYWHERE.** It is assigned to `encKey`, which lives in
 * this module for the life of the tab and is dropped by `forgetLocally`. A
 * reload asks the wallet again. **And it is the same key on a second device and
 * after a recovery**, because the wallet recomputes it from the person's own
 * seed and this site's identifier for them.
 */
export async function openKeysWithWallet(
  walletOrigin: string,
  /* The window, and the page's own origin, injected so the whole conversation
   * can be driven in a test with no browser. */
  view: Openable = walletInThisPage(window),
  atOrigin: string = window.location.origin,
  /* The dialog a longer journey already opened in its own click. */
  already?: WalletDialog,
): Promise<void> {
  if (!sessionLive) throw new Error('not signed in');

  /*
   * **OPENED HERE, IN THE CLICK, BEFORE ANYTHING IS AWAITED.**
   * A deliberate defect moves this line below the ask and a
   * test dies by name.
   */
  const dialog = openTheWallet(view, walletOrigin, already);
  try {
    await openKeysOnceOpen(walletOrigin, view, atOrigin, dialog, null);
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
): Promise<{ drawn: CompanyLabel | null; committeeKey: { tag: string; value: string } | null }> {
  const who = me;
  if (who === null) throw new Error('not signed in');
  /* **THE ADDRESS THIS TAB SIGNED IN AS, FROM THE SERVER'S OWN ANSWER TO THAT
   * SIGN-IN**, or null in a tab that did not sign anybody in. It gates and never
   * derives: the wallet will not give the key without holding it. */
  const signedInAs = walletAddress;
  const released = await askWalletForKeys(view, walletOrigin, {
    person: who.id,
    signedInAs,
    company: company === 'new' ? 'new' : company?.label ?? null,
    account: company === 'new' || company === null ? null : company.account,
    atOrigin,
    name: US_TO_A_WALLET.name,
    rdns: US_TO_A_WALLET.rdns,
  }, dialog);
  /* A sign-out, or another person's sign-in, while the wallet was open: this
   * tab is no longer the one that asked, and nothing it was given is used. */
  if (me !== who) throw new AuthError('not signed in');
  const key = toHex(released.key);

  if (encKey !== null) {
    /*
     * **THIS TAB ALREADY OPENED THE SAVED KEYS, SO THE WALLET THAT ANSWERS NOW
     * MUST GIVE THE SAME KEY.** A different one is a different wallet - and it
     * is refused before the company key it gave beside it is used for anything.
     */
    if (key !== encKey) throw new SavedKeysDidNotOpen(NOT_THE_SAME_WALLET);
    if (signedInAs !== null) keyCheckedAgainstSignIn = true;
    if (company !== null && company !== 'new' && released.companyKey !== null) {
      /* **RECORDED WITH THE COMPANY IT BELONGS TO**, and only here: this answer's
       * keyring key has just matched the one this tab's saved keys are open with,
       * so its company key came from that same wallet. A payslip key can only
       * ever be derived from it, for THIS company. */
      releasedCompanyKey = {
        accountId: company.accountId, key: toHex(released.companyKey), label: company.label,
        account: company.account, committeeKey: released.committeeKey,
      };
    }
  } else {
    const r = await api('/api/me/keys');
    let opened: Keyring = { accounts: {} };
    if (r.keyBundle) {
      try { opened = creationsInOneRecord(JSON.parse(unseal(r.keyBundle as Sealed, key))); }
      catch {
        /* **REFUSED OUT LOUD AND LEFT AS IT IS.** No key is kept, so nothing in
         * this tab can write, and no fallback is tried: there is one way keys
         * are sealed here, and keys that do not open with it are not guessed at. */
        throw new SavedKeysDidNotOpen(DID_NOT_OPEN);
      }
    }
    encKey = key;
    keyCheckedAgainstSignIn = signedInAs !== null;
    savedKeys = r.keyBundle ? 'some' : 'none';
    keyring = opened;
    bundleVersion = typeof r.version === 'number' ? r.version : 0;
    /* A company key given beside keys opened for the first time here has
     * nothing to be checked against, so it is not kept. */
  }
  /*
   * The key the person holds a seat on the company with: for a new company, given beside the label the wallet drew
   * for it; for a named company, the key the wallet works out from that company's label - asked on a first open too,
   * so an invitee's device can make its seat's leaf for it.
   */
  return company === 'new'
    ? { drawn: released.company, committeeKey: released.committeeKey }
    : { drawn: null, committeeKey: company === null ? null : released.committeeKey };
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
 * COMMITTEE WITH, FROM THE WALLET WHOSE KEYS THIS TAB HAS OPEN.** Both come in
 * the answer that also gives the keyring key this tab already holds, and are
 * kept only when that key matches, so they are that wallet's. A tab that
 * already holds them asks nothing.
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
    if (encKey === null) {
      throw new Error('your saved keys are not open in this tab, so the key for this company '
        + 'cannot be checked against them. Open the company with your wallet and try again.');
    }
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
 * **READING WHAT IS SAVED FOR THIS PERSON AGAIN, WITH THE KEY THIS TAB HOLDS.**
 * No wallet is asked. Another tab or device may have saved a company's keys
 * since this tab opened them; this is how this tab sees them. Keys that no
 * longer open with this tab's key are refused out loud and left as they are.
 */
export async function reopenSavedKeys(): Promise<void> {
  const key = encKey;
  if (key === null) throw new Error('your saved keys are not open in this tab.');
  const base = keyring;
  const heldVersion = bundleVersion;
  const heldSome = savedKeys === 'some';
  const r = await api('/api/me/keys');
  /* **A READ THAT HAS GONE BACKWARDS IS NOT TAKEN IN PLACE OF WHAT THIS TAB
   * HOLDS.** Saved keys only ever grow, one accepted write at a time; an older
   * version, or nothing where this tab has read something, is the server
   * answering from before - and adopting it would let this tab's next save make
   * the loss permanent. */
  const readVersion = typeof r?.version === 'number' ? r.version : 0;
  if (readVersion < heldVersion || (heldSome && !r?.keyBundle)) throw new SavedKeysWentBack(WENT_BACK);
  let opened: Keyring = { accounts: {} };
  if (r?.keyBundle) {
    try { opened = creationsInOneRecord(JSON.parse(unseal(r.keyBundle as Sealed, key))); }
    catch { throw new SavedKeysDidNotOpen(DID_NOT_OPEN); }
  }
  /* Only onto the list it was read for: a sign-out or another read while this
   * one was on its way has already replaced it. */
  if (keyring !== base || encKey !== key) return;
  keyring = opened;
  savedKeys = r?.keyBundle ? 'some' : 'none';
  bundleVersion = typeof r?.version === 'number' ? r.version : 0;
}

/**
 * Forgets everything this tab holds. LOCAL ONLY — it does not sign the person
 * out on the server, and it must not: it is also the 401 handler above, where
 * the sign-in is already gone and calling the API again would recurse.
 *
 * Use `signOut()` for the button.
 */
export function forgetLocally() {
  sessionLive = false; encKey = null; keyring = { accounts: {} }; me = null; walletAddress = null;
  releasedCompanyKey = null; savedKeys = null; keyCheckedAgainstSignIn = false;
  /* What was learnt of the service's clock and of where a company stands belongs to the sign-in it was learnt in. */
  clockOffsetMs = 0; standingFacts.clear(); walletsIndexer = null;
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
 * WHEN THIS TAB HAS THEM OPEN, AND WHAT THIS BROWSER HOLDS FOR THEM ALONE.**
 * Empty for nobody signed in. Never another person's: the browser's list is
 * kept under the person it was written for.
 */
export function companiesThatPayYou(storage?: Pick<Storage, 'getItem'> | null): string[] {
  if (me === null) return [];
  const saved = encKey === null ? [] : onlyCompanyLabels(keyring.paidBy ?? []);
  return [...new Set([...saved, ...rememberedCompanies(me.id, storage)])];
}

/**
 * **WHAT THIS BROWSER HELD FOR THIS PERSON, MOVED INTO THEIR SAVED KEYS.** Run
 * once the saved keys are open. The browser's list is emptied only after the
 * save is taken; a refused save leaves it where it was and is thrown, so the
 * page says why rather than leaving the list in this browser unsaid.
 *
 * **AND THE LIST AN OLDER PAYSLIPS PAGE KEPT HERE FOR NOBODY IN PARTICULAR**,
 * read once: into the saved keys of the first person whose saved keys take it,
 * and then marked as taken so it is not read again. It is left where it is and
 * not emptied. What that page kept were companies' account addresses, which
 * name no company any more, so only a label in it is taken - and anybody using
 * this browser could already read it.
 */
export async function bringCompaniesThatPayYouAcross(
  storage?: (Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) | null,
): Promise<void> {
  const who = me;
  if (who === null || encKey === null) return;
  const here = rememberedCompanies(who.id, storage);
  const older = olderListNotYetTaken(storage);
  if (here.length === 0 && older.length === 0) return;
  const held = onlyCompanyLabels(keyring.paidBy ?? []);
  const next = [...new Set([...held, ...here, ...older])];
  if (next.length > held.length) await putBundle({ ...keyring, paidBy: next });
  if (me !== who) return;
  if (here.length > 0) forgetRememberedCompanies(who.id, storage);
  if (older.length > 0) markOlderListTaken(storage);
}

/**
 * **NOTHING MAY SILENTLY REPLACE KEY MATERIAL THAT IS ALREADY HERE.**
 *
 * `keyring.accounts` holds ONE entry per account and every writer used to
 * assign into it unconditionally. The field that is destroyed is the
 * `blinding`, which decision 0003 guarantees exists nowhere else in the world:
 * accepting an invite while holding a seat on the same company replaced the
 * operator's own material with the invitee's, and **nothing failed** — the next
 * open reported `agrees`, because the material now there matches the leaf now
 * there. Their old seat stays on the roster, counts towards N, and can never be
 * proved again. A silent failure that looks like success.
 *
 * So a write that would change the signing secret of an account this device
 * already holds refuses and names what would be lost. A write of the SAME
 * material is idempotent and passes — a retry must not be a refusal.
 */
function refuseToClobber(accountId: string, incoming: AccountKeys) {
  const refusal = clobberRefusal(keyring.accounts[accountId], incoming);
  if (refusal) throw new Error(refusal);
}

/**
 * **STEP ONE OF ACCEPTING A SEAT: MAKE THE MATERIAL DURABLE.**
 *
 * Nothing that is not durable should reach a roster, so this is what runs
 * before the leaf is POSTed rather than after. If it refuses — a version
 * conflict, a dead session, material already held for this company — no leaf
 * has left this machine and nothing anywhere needs undoing, which is the
 * property the old order could not have.
 *
 * Keyed by the seat's own signing public key, so accepting a second invite
 * cannot overwrite an entry that is the only copy of a published seat's
 * blinding.
 */
export async function sealPendingSeat(seat: PendingSeat) {
  if (!encKey) throw new Error('not signed in');
  refuseToClobber(seat.accountId, {
    signerId: '(not yet seated)',
    signingSecret: seat.signingSecret,
    wrappingSecret: seat.wrappingSecret,
    blinding: seat.blinding,
    scope: seat.scope,
  });
  await putBundle({
    ...keyring,
    pendingSeats: { ...(keyring.pendingSeats ?? {}), [seat.signingPublicKey]: seat },
  });
}

/** What this device sealed and has not promoted yet, for one account. */
/**
 * **KEEPS THIS PERSON'S SIGNED DIRECTORY ENTRY FOR `accountId` UNTIL THE
 * DIRECTORY HOLDS IT**, and hands back the doors that read it and let it go.
 * Saved with the keys, so another of this person's devices files it too.
 */
export async function oweDirectoryEntry(accountId: string, owed: Omit<OwedDirectoryEntry, 'opening' | 'invited'>): Promise<void> {
  /* The entry is filed with this seat's own opening, made on this device when the seat was taken, and its invitation. */
  const { opening, invited } = keyring.accounts[accountId] ?? {};
  const kept: OwedDirectoryEntry = {
    ...owed, ...(opening === undefined ? {} : { opening }), ...(invited === undefined ? {} : { invited }),
  };
  await putBundle({ ...keyring, directoryEntriesOwed: { ...keyring.directoryEntriesOwed, [accountId]: kept } });
}

/**
 * **AN INVITATION RE-ISSUED FOR THIS PERSON'S SEAT, KEPT IN PLACE OF THE ONE
 * THEY JOINED BY**: the seat that signed it as their inviter, for their
 * wallet's first records-key ask, and the invitation itself, for their own
 * directory entry - both replaced in one write, so the wallet and the entry
 * never name two different inviters. An entry still owed carries the new one.
 * Refused for a company this device holds no seat's keys for.
 */
export async function keepTheReissuedInvitation(accountId: string, reissued: { readonly inviter: Inviter; readonly invited: SignedSeatInvitation }): Promise<void> {
  if (!encKey) throw new Error('not signed in');
  const keys = keyring.accounts[accountId];
  if (keys === undefined) throw new Error('this device holds no seat of yours for that company, so the invitation was not kept.');
  const owed = keyring.directoryEntriesOwed?.[accountId];
  await putBundle({
    ...keyring,
    accounts: { ...keyring.accounts, [accountId]: { ...keys, invitedBy: reissued.inviter, invited: reissued.invited } },
    ...(owed === undefined ? {} : { directoryEntriesOwed: { ...keyring.directoryEntriesOwed, [accountId]: { ...owed, invited: reissued.invited } } }),
  });
}

/** The doors over this person's owed directory entry for `accountId`: read it, and let it go once it is filed. */
export const directoryEntryOwed = (accountId: string) => ({
  read: (): OwedDirectoryEntry | null => keyring.directoryEntriesOwed?.[accountId] ?? null,
  settle: async (): Promise<void> => {
    const { [accountId]: _filed, ...rest } = keyring.directoryEntriesOwed ?? {};
    await putBundle({ ...keyring, directoryEntriesOwed: rest });
  },
});

export const pendingSeatsFor = (accountId: string): PendingSeat[] =>
  Object.values(keyring.pendingSeats ?? {}).filter(x => x.accountId === accountId);

/**
 * **STEP THREE: THE SEAT HAS AN ID, SO THE MATERIAL BECOMES THIS ACCOUNT'S
 * KEYS.** One `putBundle`, so the promotion and the removal cannot half happen.
 *
 * **WHAT HAPPENS TO A LEAF ALREADY SENT WHEN THIS FAILS**, which is the
 * reason the material is sealed first rather than the publish made
 * retractable: the leaf stands, the seat is on the roster, and
 * **the material it was made from is already sealed in the bundle** — this call
 * only moves it. So the failure is recoverable on this device or any other that
 * opens the same bundle, and `finishPendingSeat` below is the door. A
 * retraction would have had to unpublish a leaf from a roster the server owns,
 * and could not have been offered honestly.
 */
export async function promotePendingSeat(signingPublicKey: Hex, signerId: string) {
  if (!encKey) throw new Error('not signed in');
  const seat = keyring.pendingSeats?.[signingPublicKey];
  if (!seat) throw new Error('there is no seat waiting to be finished for that key on this device');
  const keys: AccountKeys = {
    signerId,
    signingSecret: seat.signingSecret,
    wrappingSecret: seat.wrappingSecret,
    blinding: seat.blinding,
    scope: seat.scope,
    ...(seat.invitedBy === undefined ? {} : { invitedBy: seat.invitedBy }),
    ...(seat.opening === undefined ? {} : { opening: seat.opening }),
    ...(seat.invited === undefined ? {} : { invited: seat.invited }),
  };
  refuseToClobber(seat.accountId, keys);
  const { [signingPublicKey]: _gone, ...rest } = keyring.pendingSeats ?? {};
  await putBundle({
    ...keyring,
    accounts: { ...keyring.accounts, [seat.accountId]: keys },
    pendingSeats: rest,
  });
}

/**
 * **THE DOOR FOR A SEAT THAT WAS PUBLISHED AND NOT FINISHED.**
 *
 * Called on the way into a company, before anything asks for that company's
 * keys. Nothing to do is the ordinary case and costs no write.
 *
 * ── WHAT IT PROVES BEFORE IT PROMOTES, AND WHY THE FIRST VERSION DID NOT ──
 *
 * Trial-unwrapping each wrapped viewing key with the pending wrapping secret
 * and taking the `signerId` written beside whichever ciphertext opened is not
 * enough, though a substituted roster may seem unable to forge one: `wrapKey`
 * is public-key sealing: anyone holding the wrapping PUBLIC
 * key — which this device POSTed to the server one step earlier — can produce a
 * ciphertext that opens under the matching secret, and the `signerId` beside it
 * is unauthenticated plaintext the server chooses.
 *
 * So the unwrapped value is USED rather than discarded: it is the viewing key,
 * it opens the roster, and the promotion happens only if the seat at that
 * `signerId` carries **this device's own signing public key**. That is a value
 * derived from a secret which never left here, so a forged entry names a seat
 * whose public key does not match and is refused.
 *
 * **AND A PENDING ENTRY THAT MATCHES NOTHING IS NOT CONSUMED.** It is the only
 * copy of a published seat's blinding; a wrong or absent match must cost a
 * retry, never the seat.
 *
 * **IT ANSWERS FALSE UNTIL ACCESS IS GRANTED, AND THAT IS CORRECT.** A seat
 * published but not yet granted has no wrapped key to open, and an account this
 * device cannot open is one there is nothing to finish for yet.
 */
export async function finishPendingSeat(
  accountId: string,
  sealed: SealedAccount,
): Promise<boolean> {
  const found = seatToPromote(pendingSeatsFor(accountId), sealed);
  if (!found) return false;
  await promotePendingSeat(found.signingPublicKey, found.signerId);
  return true;
}

/**
 * The one place the bundle is written, so the version cannot be forgotten by
 * one caller and remembered by another.
 *
 * A refusal means another device changed the keys since this tab read them.
 * **Retrying would erase that change**, so it is surfaced rather than swallowed.
 *
 * **THE KEY LIST THIS TAB HOLDS CHANGES ONLY WHEN THE SERVER HAS TAKEN THE WRITE.**
 * Every caller hands in the list it wants saved, and it becomes this tab's list
 * after the answer and not before. So a refused write leaves the list exactly
 * as it was - there is nothing to put back, and no copy taken at the wrong
 * moment to put back wrongly - and this tab never goes on believing something
 * the server refused. It used to assign first and keep a copy to restore; every
 * caller assigned before calling, so the copy already held the change and a
 * refusal restored nothing.
 */
async function putBundle(next: Keyring) {
  if (!encKey) throw new Error('not signed in');
  /* **A PERSON'S FIRST KEYS ARE SAVED ONLY UNDER A KEY THIS TAB ASKED FOR WITH THE
   * ADDRESS IT SIGNED IN AS.** Every writer comes through here, so no writer can
   * be the one that forgets. `keyCheckedAgainstSignIn` says why. */
  if (savedKeys !== 'some' && !keyCheckedAgainstSignIn) throw new FirstKeysNeedTheSignIn(FIRST_KEYS_NEED_THE_SIGN_IN);
  const key = encKey;
  const base = keyring;
  /* What devices once believed of each company's roster was kept here; the anchor on chain answers that now, so it is not written again. */
  const { rostersBelieved: _noLongerKept, ...written } = next as Keyring & { readonly rostersBelieved?: unknown };
  const r = await api('/api/me/keys', {
    method: 'PUT',
    body: JSON.stringify({
      keyBundle: seal(JSON.stringify(written), key),
      ifVersion: bundleVersion,
    }),
  });
  /* **AND ONLY ONTO THE LIST IT WAS MADE FROM.** A sign-out, a sign-in, or an
   * unlock that read the keys again, while the write was on its way, has
   * replaced what this tab holds - each of them puts a new list in place - and
   * putting the written list back over that would bring keys back into a tab
   * that was told to forget them. The write itself stands. */
  if (keyring !== base) return;
  keyring = next;
  bundleVersion = typeof r?.version === 'number' ? r.version : bundleVersion + 1;
  savedKeys = 'some';
}

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
 * **THE COMPANY IS FOUNDED ON THIS DEVICE** (`foundTheCompanyOnThisDevice`): the
 * service is sent, in the same request, the founding signer's committee key,
 * which their wallet gave beside the label it drew, and what this device made
 * and sealed - everything the account's deploy is built from in this browser.
 */
async function foundCompany(
  spec: CompanyToFound, walletOrigin: string, view: Openable, atOrigin: string, builder: AccountCreationBuilder,
): Promise<Founded> {
  if (!sessionLive || me === null) throw new Error('not signed in');
  const startedBy = me.id;
  /*
   * **THE WINDOW OPENS IN THE PRESS, EVERY TIME.** The new company's label is
   * the wallet's to draw, so a tab that already holds this person's key asks
   * the wallet too - and the key in its answer must be the one this tab holds.
   */
  const alreadyOpen = encKey !== null;
  const dialog = openTheWallet(view, walletOrigin);
  try {
    const { drawn, committeeKey } = await openKeysOnceOpen(walletOrigin, view, atOrigin, dialog, 'new');
    if (drawn === null) throw new Error('Your wallet did not make up a label for the new company, so nothing was created. Update your wallet and try again.');
    const foundingKey = schnorrKeyOf(committeeKey);
    if (foundingKey === null) {
      throw new Error('Your wallet drew a label for the new company but gave no key to hold it with, so nothing was created. '
        + 'Update your wallet and try again.');
    }
    /* **A TAB THAT ALREADY HELD THE KEY READS WHAT IS SAVED NOW**, so keys saved
     * since - or keys that no longer open with this key - are known before a
     * company exists rather than after. */
    if (alreadyOpen) await reopenSavedKeys();
    /* Asked before anything is created, so a refusal costs nothing. */
    if (savedKeys !== 'some' && !keyCheckedAgainstSignIn) throw new FirstKeysNeedTheSignIn(FIRST_KEYS_NEED_THE_SIGN_IN);
    return await foundTheCompanyOnThisDevice(spec, drawn, foundingKey, builder, startedBy);
  } catch (e) {
    putAway(dialog);
    throw e;
  } finally {
    doneWaiting();
  }
}

const HEX64_KEY = /^[0-9a-f]{64}$/u;

/** A committee key as the wallet gave it, or null when it is not one. */
const schnorrKeyOf = (k: { tag: string; value: string } | null): { tag: 'schnorr'; value: string } | null => {
  if (k === null || k.tag !== 'schnorr') return null;
  const value = String(k.value).toLowerCase();
  return HEX64_KEY.test(value) ? { tag: 'schnorr', value } : null;
};

/**
 * **WHAT IS KEPT OF A COMPANY THIS PERSON IS CREATING ON A CHAIN, UNTIL ITS
 * CREATION IS FINISHED**: with everything else they have saved, so a reload, a
 * closed tab or another of their browsers carries on from where it stopped and
 * never makes a second company of the same creation. Any number of creations are kept at once, each under its own company.
 *
 * Nothing here is a secret of the company: the request that made it is public
 * halves and what its secrets seal, the deploy and the second step are public
 * once sent, and the signature is the founding signer's on a public step. The
 * seat's own secrets are kept beside it as every seat's are.
 */
interface SavedCreation {
  readonly accountId: string;
  /** The person who started it: every later write of it is refused when somebody else is signed in. Absent on a creation kept before it was recorded. */
  readonly person?: string;
  readonly label: CompanyLabel;
  readonly foundingKey: { readonly tag: 'schnorr'; readonly value: string };
  /** The request that made the company, exactly as sent: sent again, it is the same company. */
  readonly request: {
    readonly name: string;
    readonly signers: ReadonlyArray<{ readonly name: string; readonly role: 'admin' | 'approver' | 'initiator' | 'viewer' }>;
    readonly threshold: number;
    readonly companyLabel: CompanyLabel;
    readonly foundingKey: { readonly tag: 'schnorr'; readonly value: string };
    readonly founding: CompanyFounded;
  };
  /** The service answered the request: the company exists. */
  readonly made: boolean;
  /** The account's deploy, built here, and the keys its second step adds. */
  readonly deploy: {
    readonly account: AccountAddress; readonly tx: string; readonly insert: ReadonlyArray<{ circuit: string; key: string }>;
    /** When it was built (epoch ms, taken before it was built): its time to live runs from there. Absent on one kept before this was kept. */
    readonly builtAt?: number;
  } | null;
  /** The second step, signed by the founding signer's wallet, and that signature. */
  readonly signed: {
    readonly tx: string; readonly signature: { readonly tag: string; readonly value: string };
    /** When it was built, as for the deploy. */
    readonly builtAt?: number;
  } | null;
  /** The service recorded the deploy and the second step. */
  readonly recorded: boolean;
  /**
   * The service refused a step for the life it had left, so what is kept is built again before it is next sent, whatever
   * this device's clock says of its age: the service reads the step's own time to live, which this device cannot.
   */
  readonly mustBeBuiltAgain?: true;
  /** Set when this creation was started again after its deploy was signed or sent: kept, not listed as being finished, and taken up if its account turns up. */
  readonly setAside?: true;
}

/*
 * **THE TIME THE SERVICE GOES BY.** A transaction's time to live is stamped from the clock of the device that builds it
 * and judged by the node's. A device whose clock is slow builds steps that are short of life from the moment they are
 * built, and judging them by that same clock never shows it. The service says what time it is with its standings and
 * with a refusal for time, and this device builds by that time from then on: the difference, kept for the page's life.
 */
let clockOffsetMs = 0;
const learnTheServiceClock = (now: unknown): void => {
  const at = typeof now === 'string' ? Date.parse(now) : NaN;
  if (Number.isFinite(at)) clockOffsetMs = at - Date.now();
};
const theTime = (): number => Date.now() + clockOffsetMs;
/** What a builder is told of the time: the difference, when this device's clock is not the service's. */
const byTheServiceClock = (): { clockOffsetMs?: number } => (clockOffsetMs === 0 ? {} : { clockOffsetMs });
/** The service's last reading, by company, of whether the step it holds for where the company stands may be replaced. */
const standingFacts = new Map<string, { state: CompanyCreationState; replaceable: boolean }>();

/**
 * Sends a step to the service. A refusal for the step's life, which says nothing was sent, makes what is kept be built
 * again before it is next sent, and teaches this device the service's time.
 */
async function sentToTheService(accountId: string, path: string, body?: string): Promise<Record<string, unknown>> {
  try {
    return await api(path, { method: 'POST', ...(body === undefined ? {} : { body }) });
  } catch (e) {
    if (e instanceof ServiceRefused && e.body['runsOutSoon'] === true && e.body['nothingWasSent'] === true) {
      learnTheServiceClock(e.body['now']);
      const kept = theCreation(accountId);
      if (kept !== undefined && kept.mustBeBuiltAgain !== true) await keepCreation({ ...kept, mustBeBuiltAgain: true });
    }
    throw e;
  }
}

/** This person's company being created, if there is one. */
const theCreation = (accountId: string): SavedCreation | undefined => {
  const c = keyring.creations?.[accountId];
  return c !== undefined && c.setAside !== true ? c : undefined;
};

const howFarOn = (c: SavedCreation): number => (c.recorded ? 4 : 0) + (c.signed !== null ? 2 : 0) + (c.deploy !== null ? 1 : 0);

/**
 * Saved keys written before every creation was kept in `creations` hold the ones set aside in `creationsSetAside`.
 * Read into the new shape, each is a creation of its own marked `setAside`; none is lost. If the same company is in both,
 * the one further on is kept.
 */
export function creationsInOneRecord(k: Keyring): Keyring {
  const { creationsSetAside, ...rest } = k;
  if (creationsSetAside === undefined || creationsSetAside === null || typeof creationsSetAside !== 'object') return k;
  const creations: Record<string, SavedCreation> = { ...(rest.creations ?? {}) };
  for (const [id, aside] of Object.entries(creationsSetAside)) {
    const active = creations[id];
    if (active === undefined) creations[id] = { ...aside, setAside: true };
    else if (howFarOn(aside) > howFarOn(active)) {
      const { setAside: _flag, ...asActive } = aside;
      creations[id] = asActive;
    }
  }
  return { ...rest, creations };
}

/**
 * A creation is written only into the saved keys of the person who started it: a step that returns after somebody
 * else was signed in and opened their keys would otherwise leave them holding it, unable to create a company.
 */
function refuseWhenNotTheStarter(c: SavedCreation): void {
  if (c.person !== undefined && (me === null || me.id !== c.person)) throw new CompanyStartedBySomebodyElse(STARTED_BY_SOMEBODY_ELSE);
}

/** Writes what is kept of a creation, with everything else saved, and nothing else changed. */
async function keepCreation(c: SavedCreation): Promise<void> {
  refuseWhenNotTheStarter(c);
  await putBundle({ ...keyring, creations: { ...(keyring.creations ?? {}), [c.accountId]: c } });
}

/** Drops what was kept of a creation: once it is finished, or when its deploy was never built. */
async function forgetCreation(accountId: string): Promise<void> {
  const kept = keyring.creations?.[accountId];
  if (kept !== undefined) refuseWhenNotTheStarter(kept);
  if (kept?.setAside === true) return;
  const { [accountId]: _done, ...rest } = keyring.creations ?? {};
  await putBundle({ ...keyring, creations: rest });
}

/**
 * Sets one creation aside: it stays in `creations` under its own company id, marked `setAside`, so it is not lost and no
 * other creation is touched. In one write.
 */
async function setCreationAside(accountId: string): Promise<void> {
  const kept = theCreation(accountId);
  if (kept === undefined) return;
  refuseWhenNotTheStarter(kept);
  await putBundle({ ...keyring, creations: { ...(keyring.creations ?? {}), [accountId]: { ...kept, setAside: true } } });
}

/**
 * **A CREATION SET ASIDE, TAKEN UP AGAIN** because its account turned up on the chain: its mark is taken off, so the
 * carry finds it and the company is finished. Only that creation is touched; any other kept creation stays as it is.
 */
export async function takeUpACreationSetAside(accountId: string): Promise<boolean> {
  const aside = keyring.creations?.[accountId];
  if (aside === undefined || aside.setAside !== true) return false;
  refuseWhenNotTheStarter(aside);
  const { setAside: _taken, ...active } = aside;
  await putBundle({ ...keyring, creations: { ...(keyring.creations ?? {}), [accountId]: active } });
  return true;
}

/**
 * **THE COMPANY MADE ON THIS DEVICE, AND KEPT BEFORE ANYTHING IS SENT.**
 *
 * The founding signer's seat is made here with the keys an invited seat is
 * made with, and its leaf worked out from them where the chain's own function
 * runs. Every secret of the company is made here beside it and sealed: the
 * service is sent the seat's public halves and leaf, the company's record with
 * its viewing key wrapped to this seat alone, and its first state, sealed.
 *
 * **THE SEAT'S SECRETS AND THE REQUEST ARE SAVED FIRST, IN ONE WRITE**, with
 * everything else this person has saved, so a company never exists whose
 * founding signer's keys were not kept, and a request that was sent and not
 * answered is sent again as it was rather than made again. If the save is
 * refused, nothing has been sent.
 */
async function foundTheCompanyOnThisDevice(
  spec: CompanyToFound, label: CompanyLabel, foundingKey: { tag: 'schnorr'; value: string },
  builder: AccountCreationBuilder, person: string,
): Promise<Founded> {
  /* The founding seat's blinding commits to the key that holds the account from its deploy, as every seat's does to its holder's. */
  const keys = newSeatKeys(foundingKey);
  const seat = await builder.foundingSeat({ signingSecret: keys.signingSecret, blinding: keys.blinding });
  const leaf = String(seat?.seat ?? '').toLowerCase();
  const scope = String(seat?.scope ?? '').toLowerCase();
  const publicKey = String(seat?.publicKey ?? '').toLowerCase();
  if (!HEX64_KEY.test(leaf) || !HEX64_KEY.test(scope) || !HEX64_KEY.test(publicKey)) {
    throw new Error('your seat in the new company could not be worked out on this device, so nothing was created.');
  }
  const opening: SeatOpening = {
    publicKey, scope, blinding: keys.blinding, walletKey: { tag: 'schnorr', value: foundingKey.value.toLowerCase() }, salt: keys.salt,
  };
  const founded = foundTheCompanyHere({
    name: spec.name, signer: spec.signers[0]!, userId: person, label,
    seat: { signingPublicKey: keys.signingPublicKey, wrappingPublicKey: keys.wrappingPublicKey, leaf },
    signingSecret: keys.signingSecret,
  });
  const accountId = founded.account.id;
  /* Somebody else signed in while it was being made: their saved keys are not where this seat goes. */
  if (me === null || me.id !== person) throw new CompanyStartedBySomebodyElse(STARTED_BY_SOMEBODY_ELSE);
  const mine: AccountKeys = {
    signerId: founded.seat.signerId, signingSecret: keys.signingSecret, wrappingSecret: keys.wrappingSecret,
    blinding: keys.blinding, scope, opening,
  };
  refuseToClobber(accountId, mine);
  if (keyring.creations?.[accountId] !== undefined) throw new Error('a creation is already kept under this company\'s id, so the new one was not kept. Nothing was created.');
  const saved: SavedCreation = {
    accountId, person, label, foundingKey,
    request: { name: spec.name, signers: spec.signers, threshold: spec.threshold, companyLabel: label, foundingKey, founding: founded },
    made: false, deploy: null, signed: null, recorded: false,
  };
  await putBundle({
    ...keyring,
    accounts: { ...keyring.accounts, [accountId]: mine },
    creations: { ...(keyring.creations ?? {}), [accountId]: saved },
  });
  await sendTheCompany(saved);
  return { accountId, label, foundingKey, foundingLeaf: founded.seat.leaf };
}

/** Sends the request that made the company, as it was kept, and keeps that the service answered. */
async function sendTheCompany(saved: SavedCreation): Promise<SavedCreation> {
  if (saved.made) return saved;
  await api('/api/accounts', { method: 'POST', body: JSON.stringify(saved.request) });
  const made = { ...saved, made: true };
  await keepCreation(made);
  return made;
}

/** Builds the account's deploy for a company kept here, once, and keeps it. */
async function buildTheDeploy(saved: SavedCreation, builder: AccountCreationBuilder): Promise<SavedCreation> {
  if (saved.deploy !== null) return saved;
  const builtAt = theTime();
  const built = await builder.accountDeploy({
    foundingLeaf: saved.request.founding.seat.leaf, label: saved.label, foundingKey: saved.foundingKey, ...byTheServiceClock(),
  });
  const account = readAccountAddress(built.account);
  if (account === null) throw new Error('the account\'s deploy was built without an address that can be read, so nothing was sent.');
  const next = { ...saved, deploy: { account, tx: built.tx, insert: built.insert, builtAt } };
  await keepCreation(next);
  return next;
}

/** What builds and proves the account's transactions: the vault worker, or anything that answers as it does. */
export interface AccountCreationBuilder {
  /**
   * The leaf the account seats for the keys made on this device, and the scope
   * it was made under, worked out with the chain's own function.
   */
  foundingSeat(material: { signingSecret: string; blinding: string }): Promise<{ seat: string; scope: string; publicKey: string }>;
  accountDeploy(input: { foundingLeaf: string; label: string; foundingKey: { tag: string; value: string }; clockOffsetMs?: number }): Promise<{
    account: string; tx: string; insert: ReadonlyArray<{ circuit: string; key: string }>;
  }>;
  finishedCreation(input: { account: string; signature: { tag: string; value: string }; clockOffsetMs?: number }): Promise<{ tx: string }>;
  /**
   * Whether the chain holds a contract at the account, at the indexer the person's wallet names: with the time of the
   * newest block it names and the newest time to live of the kept transactions. Throws when the indexer cannot say.
   */
  accountPresence?(input: { account: string; indexer: { indexerUri: string; indexerWsUri: string }; transactions: string[] }): Promise<AccountPresenceOnTheWire>;
  /**
   * The same deploy and the same signed second step, each carried in a fresh
   * transaction: the same account, the same signature, nothing made again.
   */
  creationAgain(input: { deploy: string; insert: string; clockOffsetMs?: number }): Promise<{ account: string; deploy: string; insert: string }>;
  /** Where the pay-record key stands on the account for this signer, and a copy of it sealed to them. */
  payKeyStanding(input: {
    account: string; accountState: string; key: string; signingSecret: string; wrappingPublicKey: string;
  }): Promise<PayKeyStandingOnTheWire>;
  /** A raise, an approval or a seal on the company account, built and proved with this signer's own material. */
  governedCall(input: {
    account: string; order: GovernedCallOrder; material: SignerMaterial; chain: AccountCallChainOnTheWire; opened: OpenedRound;
  }): Promise<{ tx: string }>;
}

/** The company this person has started on a chain and whose account's deploy is built, until the service has recorded it. */
export const companyAwaitingItsSecondPress = (accountId: string): { accountId: string; account: AccountAddress } | null => {
  const saved = theCreation(accountId) ?? null;
  return saved !== null && saved.deploy !== null && !saved.recorded ? { accountId: saved.accountId, account: saved.deploy.account } : null;
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
 * yet. It is the name written on the kept request; when that holds none (a creation kept by older code), the name sealed in
 * the creation's own roster, opened with this person's own seat key. Null for a company this device holds no creation of,
 * or whose creation holds no name; never the service's word for it.
 */
export const companyNameKeptHere = (accountId: string): string | null => {
  const kept = keyring.creations?.[accountId] ?? keyring.creationsSetAside?.[accountId];
  if (kept === undefined || kept === null) return null;
  const given = aNameIfAny(kept.request?.name);
  if (given !== null) return given;
  try {
    const mine = keyring.accounts[accountId];
    const founding = kept.request?.founding;
    const wrapped = founding?.account.wrappedKeys.find((w) => w.signerId === mine?.signerId);
    if (mine === undefined || founding === undefined || wrapped === undefined) return null;
    return aNameIfAny(openRoster(founding.roster, unwrapKey(wrapped, mine.wrappingSecret)).name);
  } catch {
    return null;
  }
};

const aNameIfAny = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * **A KEPT CREATION CARRIED ON PAST ITS FIRST PRESS**: the company is posted to the service again if its first post never
 * arrived (`made` false), and its deploy is built if that never was. The service takes the same company again as it was
 * (a different one under the id is refused), and nothing is signed or sent to the chain. Only this creation is touched.
 * False when no creation is kept for it here.
 */
export async function carryTheFirstPressOn(accountId: string, builder: AccountCreationBuilder): Promise<boolean> {
  const saved = theCreation(accountId);
  if (saved === undefined) return false;
  refuseWhenNotTheStarter(saved);
  await buildTheDeploy(await sendTheCompany(saved), builder);
  return true;
}

/** The company this person is creating whose deploy was never built, so nothing is signed or sent for it and it can be started again. */
export const companyKeptWithNoDeploy = (accountId: string): string | null => {
  const saved = theCreation(accountId);
  return saved !== undefined && saved.deploy === null ? saved.accountId : null;
};

/**
 * **THE FIRST PRESS: THE COMPANY IS MADE HERE AND ITS ACCOUNT'S DEPLOY IS
 * BUILT HERE, HELD BY THE FOUNDING SIGNER'S OWN KEY FROM ITS FIRST TRANSACTION.**
 *
 * The wallet draws the company's label and gives the key the founding signer
 * sits on its committee with; the company and every secret it has are made on
 * this device and kept; the service records what they seal, and the key, before
 * any deploy exists; this browser builds and proves the deploy and keeps it.
 * **NOTHING IS SENT TO THE CHAIN.** The account's address is known now, and the
 * second press asks the wallet to sign the step that finishes it. It returns
 * the label the wallet drew, so the page can show the person the name their
 * wallet gave the company.
 *
 * **A COMPANY IS NEVER REFUSED BECAUSE ANOTHER IS NOT FINISHED.** Each creation is kept on its own, under its own
 * company id, and carried on or started again on its own; a new one is added beside the others and never replaces one.
 * A kept creation whose deploy was never built can be dropped, by `forgetAnUnsentCreation`.
 */
export async function startCompanyHeldFromTheStart(
  spec: CompanyToFound,
  walletOrigin: string,
  builder: AccountCreationBuilder,
  view: Openable = walletInThisPage(window),
  atOrigin: string = window.location.origin,
): Promise<{ accountId: string; account: AccountAddress; label: CompanyLabel }> {
  /* Before the wallet is opened: a company is created with its founding signer only. */
  if (spec.signers.length !== 1 || spec.threshold !== 1) {
    throw new Error('a company is created with you as its only signer, at a threshold of one; everybody else joins by '
      + 'invitation, their seat made on their own device. Nothing was created.');
  }
  const founded = await foundCompany(spec, walletOrigin, view, atOrigin, builder);
  const saved = theCreation(founded.accountId);
  if (saved === undefined) throw new Error('the company was made but what was kept of it could not be read back, so no account was built. Nothing was sent.');
  const built = await buildTheDeploy(saved, builder);
  return { accountId: founded.accountId, account: built.deploy!.account, label: founded.label };
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
 * **THE SECOND PRESS: THE WALLET READS THE DEPLOY ITSELF AND SIGNS THE STEP THAT
 * FINISHES THE ACCOUNT, AND BOTH ARE SENT TOGETHER.**
 *
 * It carries on from what was kept: a request the service did not answer is
 * sent again as it was, a deploy not yet built is built, and a step already
 * signed is not signed again. The service records the deploy and the signed
 * second step before it sends either, and sends the deploy. A send that did not
 * arrive is pressed again: the same bytes go, and the wallet is not asked twice.
 *
 * **A DEPLOY AND A SECOND STEP WITH LESS THAN SEVENTEEN OF THEIR THIRTY MINUTES LEFT
 * ARE BUILT AGAIN BEFORE THEY ARE SENT**, whatever the time between the presses:
 * the node refuses a transaction past its time to live (`Custom error: 228`), and
 * the signature names no time, so building again needs no press. It answers
 * `builtAgain` then, for the page to say so.
 *
 * Needs this person's saved keys open, which is where what was kept is.
 */
export async function signCompanyCreationFromTheWallet(
  accountId: string,
  walletOrigin: string,
  builder: AccountCreationBuilder,
  view: Openable = walletInThisPage(window),
  atOrigin: string = window.location.origin,
): Promise<{ accountId: string; account: AccountAddress; state: CompanyCreationState; builtAgain?: true }> {
  if (!sessionLive) throw new Error('not signed in');
  if (encKey === null) throw new Error('open your saved keys first: what was kept of the company you are creating is with them.');
  let saved = theCreation(accountId);
  if (saved === undefined) throw new Error('there is no company waiting to be finished.');
  saved = await buildTheDeploy(await sendTheCompany(saved), builder);
  if (saved.signed === null) {
    const deploy = saved.deploy!;
    const dialog = openTheWallet(view, walletOrigin);
    let signature: { tag: string; value: string };
    try {
      ({ signature } = await askWalletToFinishCreation(view, walletOrigin, {
        company: saved.label, account: deploy.account, deploy: deploy.tx, insert: deploy.insert,
        signer: saved.foundingKey, atOrigin, name: US_TO_A_WALLET.name, rdns: US_TO_A_WALLET.rdns,
      }, dialog));
    } catch (e) {
      putAway(dialog);
      throw e;
    } finally {
      doneWaiting();
    }
    const builtAt = theTime();
    const finished = await builder.finishedCreation({ account: deploy.account, signature, ...byTheServiceClock() });
    saved = { ...saved, signed: { tx: finished.tx, signature: { tag: signature.tag, value: signature.value }, builtAt } };
    await keepCreation(saved);
  }
  /*
   * **NEVER SENT AS IT WAS BUILT HOURS AGO.** The deploy was built at the first press and the second step when the
   * wallet signed, and each lives thirty minutes from there. A pair with too little life left is built again, here and
   * now, and that is sent: the same deploy, so the same account, and the same signature, which names no time - so
   * the wallet is not asked again. The second step is built after the deploy and rebuilt with it, so the deploy's
   * age is the older of the two.
   */
  let builtAgain = false;
  if (saved.mustBeBuiltAgain === true || aStepIsShortOfLife(saved.deploy!.builtAt, theTime())) {
    await carriedAgain(saved.accountId, builder);
    saved = theCreation(saved.accountId)!;
    builtAgain = true;
  }
  const deploy = saved.deploy!;
  const body = JSON.stringify({ deploy: deploy.tx, insert: saved.signed!.tx });
  /* A pair built again may meet a service that already holds the one it replaces, which that service must replace, not be sent as a second deploy. */
  const stands = builtAgain ? (await companyCreationStanding(saved.accountId)).state : 'not-created';
  let state: CompanyCreationState;
  if (stands === 'not-created') {
    state = creationStateOf((await sentToTheService(saved.accountId, `/api/accounts/${saved.accountId}/creation`, body)).state);
  } else if (stands === 'deploy-sent' || stands === 'deploy-expired') {
    state = creationStateOf((await sentToTheService(saved.accountId, `/api/accounts/${saved.accountId}/creation/again`, body)).state);
  } else if (stands === 'unknown') {
    throw new Error('the service could not say where the company stands, so the deploy built again was not sent. Nothing was sent; press again.');
  } else {
    state = stands;
  }
  if (!saved.recorded) await keepCreation({ ...saved, recorded: true });
  return { accountId: saved.accountId, account: deploy.account, state, ...(builtAgain ? { builtAgain: true as const } : {}) };
}

/**
 * **A DEPLOY OR A SECOND STEP THAT CAN NO LONGER LAND, CARRIED AGAIN.** Each
 * transaction lives thirty minutes. One that ran out before it landed is
 * carried in a fresh one: the same deploy, so the same account, and the same
 * signature, so the wallet is not asked again and nothing is made again.
 */
async function carriedAgain(accountId: string, builder: AccountCreationBuilder): Promise<{ deploy: string; insert: string }> {
  const saved = theCreation(accountId);
  if (saved === undefined || saved.deploy === null || saved.signed === null) {
    throw new Error('this browser does not hold what was sent for this company, so it cannot be sent again. Open your '
      + 'saved keys on the browser you created it from. Nothing was sent.');
  }
  const builtAt = theTime();
  const again = await builder.creationAgain({ deploy: saved.deploy.tx, insert: saved.signed.tx, ...byTheServiceClock() });
  if (readAccountAddress(again.account) !== saved.deploy.account) {
    throw new Error('carried again, the deploy would create another account than the one your wallet signed for. Nothing was sent.');
  }
  /* Started again while it was built: the creation is set aside, and is neither kept nor sent. */
  if (theCreation(accountId) === undefined) {
    throw new Error('this company was started again while it was being built, so it was not kept or sent. Nothing was sent.');
  }
  const { mustBeBuiltAgain: _asked, ...kept } = saved;
  await keepCreation({ ...kept, deploy: { ...saved.deploy, tx: again.deploy, builtAt }, signed: { ...saved.signed, tx: again.insert, builtAt } });
  return { deploy: again.deploy, insert: again.insert };
}

/**
 * **FINISHING A COMPANY WHOSE ACCOUNT IS ON THE CHAIN**: the service sends the
 * second step it recorded with the deploy, once the chain shows the account.
 * Pressed again when it did not land; nothing is signed again. A deploy that
 * ran out before it landed, or a second step that ran out before it was sent,
 * is carried again from what this browser kept and recorded in its place.
 */
export async function finishCompanyOnTheChain(
  accountId: string, builder?: AccountCreationBuilder,
): Promise<{ account: AccountAddress | null; state: CompanyCreationState; builtAgain?: true }> {
  const standing = await companyCreationStanding(accountId);
  /* A creation set aside whose deploy turns out to have landed is finished from what was set aside. */
  if (DEPLOY_LANDED.has(standing.state)) await takeUpACreationSetAside(accountId);
  if (builder !== undefined && (standing.state === 'deploy-expired' || (standing.state === 'deploy-sent' && keptCreationRunsOutSoon(accountId, 'deploy-sent')))) {
    const again = await carriedAgain(accountId, builder);
    const answer = await sentToTheService(accountId, `/api/accounts/${accountId}/creation/again`, JSON.stringify(again));
    return { account: readAccountAddress(answer.account), state: creationStateOf(answer.state), builtAgain: true };
  }
  if (builder !== undefined && (standing.state === 'finish-expired' || (standing.state === 'finish-owed' && keptCreationRunsOutSoon(accountId, 'finish-owed')))) {
    const { insert } = await carriedAgain(accountId, builder);
    const answer = await sentToTheService(accountId, `/api/accounts/${accountId}/creation/finish`, JSON.stringify({ insert }));
    return { account: readAccountAddress(answer.account), state: creationStateOf(answer.state), builtAgain: true };
  }
  const answer = await sentToTheService(accountId, `/api/accounts/${accountId}/creation/finish`);
  return { account: readAccountAddress(answer.account), state: creationStateOf(answer.state) };
}

/**
 * Whether the step this browser kept for the stage the service reads the company at is short of life: the deploy while
 * the chain does not show the account, the second step while it does and the account is not finished. The page asks
 * before it sends the step the service recorded, so that one with ten minutes left is carried again, not sent.
 */
export function keptCreationRunsOutSoon(accountId: string, state: CompanyCreationState): boolean {
  const saved = theCreation(accountId);
  if (saved === undefined || saved.deploy === null || saved.signed === null) return false;
  const kept = state === 'deploy-sent' || state === 'deploy-expired' ? saved.deploy
    : state === 'finish-owed' || state === 'finish-expired' ? saved.signed : null;
  if (kept === null) return false;
  /* The service refused a step for its life: built again whatever this device thinks of its age. */
  if (saved.mustBeBuiltAgain === true) return true;
  /*
   * The step that matters is the one the SERVICE recorded, which is not always the one kept here (a post that failed, a
   * replacement it refused), and its life is read from its own time to live. The service's reading leads; this device's
   * reading of when it built what it kept is only for a service that has not said.
   */
  const said = standingFacts.get(accountId);
  if (said !== undefined && said.state === state) return said.replaceable;
  return aStepIsShortOfLife(kept.builtAt, theTime());
}

/**
 * **THE COMPANY'S PAY-RECORD KEY, COMMITTED ON ITS ACCOUNT AND SEALED TO ITS
 * FOUNDING SIGNER**, the last step of creating it. The key was made with the
 * company, on this device, and kept sealed in its first state; it is opened
 * here with the founding signer's own key, and nothing of it leaves but the
 * account's commitment to it and the copy sealed to them.
 *
 * Carried out from what the chain shows, so a press that stopped half way
 * carries on: the proposal that commits the account to the key is raised once,
 * approved by the founding signer, and carried out by sealing their copy, each
 * only once the chain shows the one before. Each is built and proved here, and
 * the service only reads it and sends it. It drops nothing: what was kept of the creation is dropped by
 * `forgetAFinishedCreation`, once the person's wallet shows the key committed.
 */
export async function sealThePayRecordKey(
  accountId: string, builder: AccountCreationBuilder,
  opts: { readonly wait?: (ms: number) => Promise<void>; readonly tries?: number } = {},
): Promise<{ state: CompanyCreationState }> {
  if (encKey === null) throw new Error('open your saved keys first: the company\'s pay-record key is opened with them.');
  const saved = theCreation(accountId);
  const mine = keysFor(accountId);
  if (saved === undefined || mine === null) {
    throw new Error('this browser does not hold what this company was created with, so its pay-record key cannot be sealed '
      + 'here. Open your saved keys on the browser you created it from. Nothing was sent.');
  }
  const founding = saved.request.founding;
  const wrapped = founding.account.wrappedKeys.find((w) => w.signerId === mine.signerId);
  if (wrapped === undefined) throw new Error('the company was not made with a viewing key for your seat, so its pay-record key cannot be opened. Nothing was sent.');
  const viewingKey = unwrapKey(wrapped, mine.wrappingSecret);
  /* A creation kept before the first state was a signed record carries none: that company is made again. */
  if (founding.state === undefined) throw new Error(CREATED_BEFORE_SIGNED_STATE);
  const key = String(openStateRecord(founding.state, viewingKey).blinding.payRecordKey ?? '');
  if (!HEX64_KEY.test(key)) throw new Error('the company\'s first state carries no pay-record key, so none was sealed. Nothing was sent.');
  const material: SignerMaterial = { signingSecret: mine.signingSecret, blinding: mine.blinding, scope: mine.scope };
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const tries = opts.tries ?? 60;

  const read = async () => {
    const chain = await api(`/api/accounts/${accountId}/call-state`) as AccountCallChainOnTheWire & { account: string };
    const standing = await builder.payKeyStanding({
      account: chain.account, accountState: chain.accountState, key, signingSecret: mine.signingSecret,
      wrappingPublicKey: founding.seat.wrappingPublicKey,
    });
    return { chain, standing };
  };
  const until = async (what: string, done: (s: PayKeyStandingOnTheWire) => boolean) => {
    for (let i = 0; i < tries; i += 1) {
      const now = await read();
      if (done(now.standing)) return now;
      await wait(5_000);
    }
    throw new Error(`the chain does not show ${what} yet. Nothing more was sent; press again to carry on from there.`);
  };
  const send = async (call: 'propose' | 'approve' | 'sealPayKey', tx: string) => {
    await api(`/api/accounts/${accountId}/creation/pay-key`, { method: 'POST', body: JSON.stringify({ call, tx }) });
  };

  let at = await read();
  if (at.standing.committed !== null && !at.standing.isThisKey) {
    throw new Error('the company\'s account is committed to another pay-record key than the one it was created with, so '
      + 'yours was not sealed. Nothing was sent.');
  }
  const r = at.standing.round;
  const payKey = { kind: 'pay-key', commitment: r.commitment } as const;
  const opened: OpenedRound = {
    chainId: r.proposal, digest: r.payload, vault: at.standing.noVault, salt: r.salt,
    summary: 'Commit the company to its pay-record key', governance: payKey,
    half: { assetId: NO_ASSET_ON_THE_WIRE, changeAmount: '0', changeBatchDigest: ZERO_ON_THE_WIRE },
  };
  const call = async (order: GovernedCallOrder) =>
    (await builder.governedCall({ account: at.chain.account, order, material, chain: at.chain, opened })).tx;
  if (at.standing.committed === null) {
    if (!r.open) {
      await send('propose', await call({
        circuit: 'propose', payKey,
        half: { assetId: NO_ASSET_ON_THE_WIRE, assetBlinding: randomHex32(), proposalSalt: r.salt, changeAmount: '0', changeBatchDigest: ZERO_ON_THE_WIRE },
        proposal: r.proposal,
      }));
      at = await until('the proposal that commits the company to its pay-record key', (s) => s.round.open || s.committed !== null);
    }
    if (at.standing.committed === null && at.standing.round.approvals < at.standing.round.needed) {
      const before = at.standing.round.approvals;
      await send('approve', await call({ circuit: 'approve', proposal: r.proposal, of: { governance: payKey, proposalSalt: r.salt } }));
      at = await until('your approval of that proposal', (s) => s.round.approvals > before || s.committed !== null);
    }
  }
  if (!at.standing.sealedMine) {
    await send('sealPayKey', await call({
      circuit: 'sealPayKey', wrap: at.standing.wrap, commitment: r.commitment, proposal: r.proposal, proposalSalt: r.salt,
    }));
    at = await until('your copy of the pay-record key', (s) => s.sealedMine);
  }
  return { state: 'finished' };
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
  learnTheServiceClock(answer.now);
  if (typeof answer.replaceable === 'boolean') {
    standingFacts.set(accountId, { state, replaceable: answer.replaceable });
    return { account: readAccountAddress(answer.account), state, replaceable: answer.replaceable };
  }
  standingFacts.delete(accountId);
  return { account: readAccountAddress(answer.account), state };
}

/** A state the service named, or `unknown` for anything this page does not know. */
const creationStateOf = (s: unknown): CompanyCreationState =>
  COMPANY_CREATION_STATES.find((k) => k === s) ?? 'unknown';

const ZERO_ON_THE_WIRE = '00'.repeat(32);
const NO_ASSET_ON_THE_WIRE = NO_ASSET;
const randomHex32 = (): string => toHex(randomBytes(32));

/**
 * Derives the viewing key from the account's wrapped keys and this user's own
 * wrapping secret: the company's key at epoch 0, opened from the copy the
 * account record holds for this seat. It is not stored on this device: it is
 * opened again from material only this device holds. A key
 * the company changed to after a signer left is never opened here: it is
 * opened from the company's directory (`companyKeyHere`), which takes this
 * key as epoch 0's. Throws when this device holds no keys for the company, or
 * the record holds no copy for its seat.
 */
export function viewingKeyFor(account: { id: string; wrappedKeys: any[] }): Hex {
  const keys = keysFor(account.id);
  if (!keys) throw new Error('no keys for this account on this device');
  const wrapped = account.wrappedKeys.find((w: any) => w.signerId === keys.signerId);
  if (!wrapped) throw new Error('you have not been granted access to this account yet');
  return unwrapKey(wrapped, keys.wrappingSecret);
}

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
 * its account record is never read. A refusal throws `RosterNotBelieved`.
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
  /** The company's records as the head on chain holds them, for the company `accountId` and its account (`heldFor`). */
  anchored: (accountId: string, company: CompanyLabel, account: AccountAddress) => DirectoryHereDeps['anchored'],
  /** The leaf each directory entry's opening makes, worked out in the page's vault worker. */
  leaves: (company: CompanyLabel, account: AccountAddress) => DirectoryHereDeps['leaves'],
  /**
   * The company's keys as this device reads them from its directory (`companyKeyHere`), every epoch it can reach; a
   * page always gives them. Without them, this seat's served copy is the one key, as for a company never changed.
   */
  companyKeys?: (rec: SealedAccount) => Promise<KeysHeld>,
): Promise<BelievedAccount | null> {
  const read = await rosterReadFor(rec, holders, anchored, leaves, companyKeys);
  return read === null ? null : (await rosterBelievedHere(...read)).account;
}

/**
 * **THE SEATS THE COMPANY'S ROSTER ADMITTED** (`seatsAdmittedHere`), read with the same doors as `openAccount`, for a
 * change of the company's key only. Throws, so the change waits, when this device holds no keys for the account or
 * the roster is not believed.
 */
export async function seatsAdmittedFor(
  rec: SealedAccount & { readonly roster?: SealedCompanyRecord | null },
  holders: Parameters<typeof openAccount>[1], anchored: Parameters<typeof openAccount>[2], leaves: Parameters<typeof openAccount>[3],
  companyKeys?: Parameters<typeof openAccount>[4],
): Promise<ReadonlySet<string>> {
  const read = await rosterReadFor(rec, holders, anchored, leaves, companyKeys);
  if (read === null) throw new Error('this device holds no keys for the company, so it cannot read who its roster admitted.');
  return seatsAdmittedHere(...read);
}

/** What `rosterBelievedHere` is asked with for `rec` on this page, or null when this device holds no keys for it. */
async function rosterReadFor(
  rec: SealedAccount & { readonly roster?: SealedCompanyRecord | null },
  holders: Parameters<typeof openAccount>[1], anchored: Parameters<typeof openAccount>[2], leaves: Parameters<typeof openAccount>[3],
  companyKeys?: Parameters<typeof openAccount>[4],
): Promise<Parameters<typeof rosterBelievedHere> | null> {
  const keys = keysFor(rec.id);
  let served: Hex;
  try {
    if (keys === null) return null;
    served = viewingKeyFor(rec);
  } catch {
    return null;
  }
  const label = readCompanyLabel(rec.companyLabel ?? null);
  const account = readAccountAddress(rec.contractAddress ?? null);
  if (label === null || account === null) throw new RosterNotBelieved(NO_ACCOUNT_TO_READ_SIGNERS_BY);
  const viewingKey = companyKeys === undefined ? served : await companyKeys(rec);
  return [rec, viewingKey, {
    accountId: rec.id, label, account,
    reads: {
      filings: () => directoryFilingsFrom(api, rec.id), holders: () => holders(label, account), anchored: anchored(rec.id, label, account),
      leaves: leaves(label, account),
    },
    own: { signerId: keys.signerId, signingPublicKey: signingPublicKeyOf(keys.signingSecret) },
    proposals: async () => api(`/api/accounts/${encodeURIComponent(rec.id)}/proposals`),
  }];
}

/** The fixed sentence for a company with no account on the chain: nothing names who holds its seats, so its signers are not read. */
const NO_ACCOUNT_TO_READ_SIGNERS_BY = 'This company has no account on the chain that names who holds its seats, so this '
  + 'device does not read its signers.';
