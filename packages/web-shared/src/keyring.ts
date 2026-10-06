/**
 * The client half of identity.
 *
 * Everything that can decrypt lives here, in the browser, and nowhere else. The
 * server holds a sealed blob it cannot open, and — since `PI4b` — no credential
 * of any kind. That is the entire trust model, and this file is where it is
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
import type { OwedDirectoryEntry } from './vault-page-doors.js';
import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountAddress, CompanyLabel, VaultAddress } from 'midnight-identity/profile/company-label';
import { parseCanonical, randomBytes, seal, sign, toHex, unseal, unwrapKey, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { NO_ASSET } from '../../../src/core/assets.js';
import {
  askWalletToSignIn, openWalletDialog, type Openable, type WalletDialog,
} from './wallet-sign-in.js';
/* The screen that draws the waiting needs the type, and it should not have to
 * know which file below this one the wallet plumbing lives in. */
export type { WalletDialog } from './wallet-sign-in.js';
import { askWalletForKeys } from './wallet-unlock.js';
import { askWalletToPay } from './wallet-balance.js';
import { askWalletToSignCommittee, type CommitteeAsked } from './wallet-committee.js';
import { askWalletToFinishCreation } from './wallet-creation.js';
import {
  askWalletToSignRecordsKey, askWalletWhoHolds, type HoldersAsked, type HoldersRead, type RecordsKeyAsked, type RecordsKeySigned,
} from './wallet-records-key.js';
/* **THE WALLET IS SHOWN INSIDE THIS PAGE.** Every journey below defaults to it;
 * a test hands in a window of its own and drives the same conversation. */
import { walletInThisPage } from './wallet-frame.js';
import { openAccount as openSealedAccount, approvalMessage } from '../../../src/core/account.js';
import {
  COMPANY_CREATION_STATES, foundTheCompanyHere, type CompanyCreationState, type CompanyFounded,
} from '../../../src/core/company-founding.js';
import type { AccountCallChainOnTheWire, PayKeyStandingOnTheWire } from './vault-worker-client.js';
import type { GovernedCallOrder, OpenedRound, SignerMaterial } from './governed-call-builder.js';

export type { CompanyCreationState } from '../../../src/core/company-founding.js';
import { newSeatKeys } from './accept-seat.js';
import { clobberRefusal, seatToPromote } from './seat-repair.js';
import type { Account, SealedAccount } from '../../../src/core/types.js';
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
 * **KEY MATERIAL THAT IS DURABLE BEFORE ITS LEAF IS PUBLISHED.** `C329`,
 *
 *
 * The invite path used to POST the leaf and then seal the keyring. A refused
 * bundle write rethrows, and the secrets were only ever in that closure, so a
 * conflict at the wrong moment seated a signer whose key material never survived — a seat that counts towards N and can never approve,
 * which is precisely the state `ownLeafReading` was built to detect. **`S33`
 * built the detector; this is one of the factories.**
 *
 * So the order is inverted: the material is sealed HERE first, under the
 * account it is for, and only then does a leaf leave the machine. The entry
 * carries no `signerId` because the server has not assigned one yet — which is
 * the whole reason the old order existed — and `signingPublicKey` is what
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
   * **KEYED BY THE KEY BECAUSE KEYING BY ACCOUNT DESTROYS MATERIAL.** `S34`'s
   * money-safety pass: if a POST succeeds and the promotion then fails, an
   * entry here holds the ONLY copy of the blinding for a leaf that is already
   * on a roster. Under an account-keyed map a second accepted invite for the
   * same account overwrites it, and that is `C325` manufactured by the fix for
   * A signing public key is unique per seat and is the one half of this
   * material the server was given, so it names the seat without naming a
   * secret.
   *
   * **Optional, because a bundle sealed before `S34` has no such field** and
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
   * **A COMPANY THIS PERSON IS CREATING ON A CHAIN, UNTIL ITS CREATION IS
   * FINISHED**, keyed by the company. Optional, because saved keys written
   * before it have no such field.
   */
  creations?: Record<string, SavedCreation>;
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
 * THE SUBWALLET THIS TAB SIGNED IN AS, or null for a password sign-in.
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
 * however this tab came by it"* — a password-derived key and a wallet-released
 * company key are both assigned to it and nothing downstream can tell them
 * apart, **which is deliberate and is exactly why a second variable is needed
 * here.** Deriving a payslip keypair from a password-derived key would produce
 * a perfectly usable keypair that no wallet, no second device and no recovery
 * can ever work out again — `C135` reopened by a road nobody would notice,
 * because every test of the sealing would still pass.
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
 * Null is the ordinary answer and is never an error to paper over: a password
 * sign-in has no released key at all, and a tab that unlocked a DIFFERENT
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
 * SIGNED IN.** `keyCheckedAgainstSignIn` says why.
 */
/**
 * A person's first keys refused because this tab did not sign them in. Its own
 * class so a screen can tell it apart and say it in its own words; its message
 * is `FIRST_KEYS_NEED_THE_SIGN_IN`.
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

const cannotBeSavedSentence = (): string => 'this company\'s keys cannot be saved: the keys now '
  + 'saved for you here do not open with the key this tab holds, and saving would mean writing over '
  + 'keys this tab cannot open, which nothing here does. Its keys are only in this tab, so closing '
  + 'this tab or signing out loses this company for good.';

/**
 * **WHAT GOES WITH THE COMPANY THIS TAB IS WAITING TO FINISH, WHEN IT CAN NEVER BE FINISHED.**
 * Null is the ordinary case: a save that was refused is tried again by Finish,
 * after reading what is saved now.
 */
export function companyAwaitingSetupProblem(): { canFinish: boolean; why: string } | null {
  if (!startedByTheSignedIn(pendingCompany)) return null;
  if (pendingCompany?.savingFailed === 'cannot-be-saved') return { canFinish: false, why: cannotBeSavedSentence() };
  return null;
}
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

export const api = async (path: string, opts?: RequestInit) => {
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
  if (!r.ok) throw new Error(body?.error ?? `request failed: ${r.status}`);
  return body;
};

/* ---------------- sign in and out ---------------- */

/*
 * **`register` AND `signIn` ARE DELETED.**
 *
 * They were the client half of the password: `derive` stretched it with
 * argon2id, the `authKey` half went to `/api/auth/register` or
 * `/api/auth/login`, and the `encKey` half stayed here and opened the bundle.
 * **Both routes are gone and so is the derivation** — `deriveAuthMaterial`,
 * `KDF` and the argon2id import with them, so nothing in this module can
 * produce a key from a typed secret any more.
 *
 * **`signInWithWallet` BELOW IS THE ONLY WAY IN**, and `openKeysWithWallet` is
 * what sets `encKey`. The comment on `canOpenCompanies` already said the
 * important half of this: `encKey` does not mean *from a password*, it means
 * *the key that opens the bundle, however this tab came by it* — and there is
 * now exactly one way it can come by it.
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
 * is the thing that mints a session; a check made by the page being persuaded
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
export async function resumeSession(carried: SignInCarried | null = null): Promise<Me | null> {
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
    throw e;
  }
}

/**
 * **OPENING THE KEYS SAVED FOR THIS PERSON, WITH THE KEY THEIR WALLET GIVES FOR
 * THEM ON THIS SITE.**
 *
 * One press on the wallet's own screen, and a password appears nowhere:
 *
 *   1. **ask the wallet for the keyring key**, naming the person this session
 *      is and - when this tab signed them in - the address it signed in as. The
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
      try { opened = JSON.parse(unseal(r.keyBundle as Sealed, key)); }
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
  /* The key the person sits on the new company's committee with, given beside the label the wallet drew for it. */
  return company === 'new'
    ? { drawn: released.company, committeeKey: released.committeeKey }
    : { drawn: null, committeeKey: null };
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
 * **THIS PERSON'S RECORDS KEY FOR THEIR SEAT, SIGNED BY THEIR OWN WALLET, AND WHO
 * HOLDS THE COMPANY'S ACCOUNT NOW AS THAT WALLET READ IT.** Asked right before a
 * vault's secret is approved, so what it is checked against is read then.
 * Opened in the press, like every wallet journey; see `wallet-records-key.ts`.
 */
export async function recordsKeyFromTheWallet(
  walletOrigin: string,
  ask: Pick<RecordsKeyAsked, 'company' | 'account' | 'seat' | 'vault' | 'signingKey'>,
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
 * **WHO HOLDS THE COMPANY NOW, AS THIS PERSON'S OWN WALLET READS THE CHAIN**, with
 * no press. Asked afresh for every read that believes a filing; see
 * `wallet-records-key.ts`.
 */
export async function holdersFromTheWallet(
  walletOrigin: string,
  ask: Pick<HoldersAsked, 'company' | 'account'>,
  view: Openable = walletInThisPage(window),
  atOrigin: string = window.location.origin,
  already?: WalletDialog,
): Promise<HoldersRead> {
  if (!sessionLive) throw new Error('not signed in');
  const dialog = openTheWallet(view, walletOrigin, already);
  try {
    return await askWalletWhoHolds(view, walletOrigin, {
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
    try { opened = JSON.parse(unseal(r.keyBundle as Sealed, key)); }
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
 * Forgets everything this tab holds. LOCAL ONLY — it does not end the session
 * on the server, and it must not: it is also the 401 handler above, where the
 * session is already gone and calling the API again would recurse.
 *
 * Use `signOut()` for the button.
 */
export function forgetLocally() {
  sessionLive = false; encKey = null; keyring = { accounts: {} }; me = null; walletAddress = null;
  releasedCompanyKey = null; savedKeys = null; keyCheckedAgainstSignIn = false;
  /*
   * **AND THE FOUNDER'S UNSEALED SECRETS.**
   *
   * `pendingCompany` holds the only copy in existence of a founder's signing
   * secret, wrapping secret and blinding, between the company being created and
   * the keyring being sealed. Everything else on this line is dropped on the
   * way out; leaving these behind would leave the most valuable thing this tab
   * ever holds alive past the moment the person said stop. **Dropping them
   * loses the company if the sealing never happened** — which is the correct
   * outcome for a person who signed out mid-way and the honest one, rather than
   * keeping their secrets against a session that no longer exists.
   */
  pendingCompany = null;
}

/**
 * S-3: signing out for real.
 *
 * Until now this function was `forgetLocally` and nothing else, which is the
 * bug S-3 names — the tab dropped the token and the token stayed valid until
 * it expired, so "sign out" on a shared or stolen machine did nothing an
 * attacker would notice. The server call is the whole fix.
 *
 * The local clear happens either way. If the network is down we still must not
 * leave the keys sitting in this tab, and a session we failed to end is a
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

/** Adds an account's secrets and pushes the resealed bundle. */
async function rememberAccount(accountId: string, keys: AccountKeys) {
  if (!encKey) throw new Error('not signed in');
  refuseToClobber(accountId, keys);
  await putBundle({ ...keyring, accounts: { ...keyring.accounts, [accountId]: keys } });
}

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
 * **NOTHING MAY SILENTLY REPLACE KEY MATERIAL THAT IS ALREADY HERE.** `S34`'s
 * money-safety pass, and it is the worst thing that audit found.
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
export async function oweDirectoryEntry(accountId: string, owed: OwedDirectoryEntry): Promise<void> {
  await putBundle({ ...keyring, directoryEntriesOwed: { ...keyring.directoryEntriesOwed, [accountId]: owed } });
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
 * question `C329` asks and the reason the order was inverted rather than the
 * publish made retractable: the leaf stands, the seat is on the roster, and
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
 * The first version trial-unwrapped each wrapped viewing key with the pending
 * wrapping secret, took the `signerId` written beside whichever ciphertext
 * opened, and said in its own comment that a substituted roster could not forge
 * one. **That was false and `S34`'s money-safety pass caught it (rule
 * 14).** `wrapKey` is public-key sealing: anyone holding the wrapping PUBLIC
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
  const r = await api('/api/me/keys', {
    method: 'PUT',
    body: JSON.stringify({
      keyBundle: seal(JSON.stringify(next), key),
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

/**
 * **A COMPANY THAT EXISTS AND WHOSE KEYS THIS TAB HAS NOT SAVED YET.**
 *
 * `create` returns **the founding signer's signing secret, wrapping secret and blinding
 * ONCE, and they are written down nowhere.** The viewing key is wrapped to that
 * wrapping key on the account record, so losing these secrets is losing the
 * company - intact, sealed, and unopenable.
 *
 * Nothing sits between creating a company and saving its keys any more: the key
 * they are saved under is this person's, and it is open before the company is
 * made. **What can still come between them is the server refusing the save**,
 * because another tab or device saved keys first. So the secrets stay here, in
 * memory, for the life of the tab, and the screen offers to finish. **In memory
 * and nowhere else**, for `encKey`'s reason: anything persisted is somewhere a
 * script on this page can read.
 */
let pendingCompany: {
  accountId: string;
  /**
   * **WHO STARTED IT.** Its keys are saved only into that person's saved keys:
   * a tab can be signed in as somebody else before it is finished, and the
   * keys it would then be saved under are theirs.
   */
  personId: string;
  keys: AccountKeys;
  /**
   * **`cannot-be-saved` WHEN THIS TAB HAS SEEN THAT IT NEVER CAN BE.** A save was
   * refused and the keys saved since do not open with the key this tab holds, so
   * saving would mean writing over keys this tab cannot open. Nothing here does
   * that, so this does not change back, and Finish stops.
   */
  savingFailed: 'cannot-be-saved' | null;
} | null = null;

/** Whether `waiting` was started by the person this tab is signed in as now. */
const startedByTheSignedIn = (waiting: { personId: string } | null): boolean => waiting !== null && me !== null && waiting.personId === me.id;

/**
 * The company this tab created and has not finished saving the keys of, if
 * there is one, and only for the person who started it: to anybody else signed
 * in here since, there is none they can finish.
 */
export const companyAwaitingSetup = (): string | null => (startedByTheSignedIn(pendingCompany) ? pendingCompany!.accountId : null);

/**
 * **SOMEBODY WITH A WALLET STARTS A COMPANY.**
 *
 * ── THE ORDER, WHICH IS THE WHOLE OF IT ───────────────────────────────────
 *
 *   1. **The wallet is asked, and it makes up the new company's label.** In
 *      the same answer it gives the key the keys saved for this person here are
 *      sealed under, and those keys are opened with it - or, when this tab has
 *      them open already, the key is checked against the one it holds. **Keys
 *      that do not open are refused here, before anything is created**, so a
 *      company is never made whose keys could not be saved beside them. The
 *      label is the wallet's: this page asks for a new company and does not
 *      choose which, so neither it nor the service behind it can.
 *   2. **The company is brought into being with that label**, and the ledger
 *      assigns whatever it assigns. Nothing about saving the founding signer's
 *      keys waits on it.
 *   3. **The founding signer's own secrets are saved beside everything already saved**,
 *      under the same key. From here a second device, or a recovery, opens them.
 *
 * **ANY NUMBER OF COMPANIES.** Nothing here looks at whether this person already
 * belongs to one, because nothing about saving a new company's keys depends on it.
 *
 * ── WHAT IT REFUSES ───────────────────────────────────────────────────────
 *
 * - A tab already waiting to finish a company: starting another would replace
 *   the only copy of the first one's keys.
 * - Saved keys that do not open (step 1).
 * - A person's FIRST keys from a tab that did not sign them in - see
 *   `keyCheckedAgainstSignIn`. Refused before anything is created.
 */
export async function createCompanyWithWallet(
  spec: {
    name: string;
    signers: Array<{ name: string; role: 'admin' | 'approver' | 'initiator' | 'viewer' }>;
    threshold: number;
  },
  walletOrigin: string,
  /* The window and this page's own origin, injected so the whole journey can be
   * driven in a test with no browser. */
  view: Openable = walletInThisPage(window),
  atOrigin: string = window.location.origin,
): Promise<{ accountId: string }> {
  const founded = await foundCompany(spec, walletOrigin, view, atOrigin, 'as-today');
  return { accountId: founded.accountId };
}

/** A company as its founding signer's press made it: the label their wallet drew, and on a chain what its account is deployed from. */
interface Founded {
  readonly accountId: string;
  readonly label: CompanyLabel;
  /** On a chain: the key the founding signer sits on the company's committee with, which alone holds the account from its first transaction. */
  readonly foundingKey: { tag: 'schnorr'; value: string } | null;
  /** On a chain: the founding signer's seat in the account, as the service made it. */
  readonly foundingLeaf: string | null;
}

/**
 * **ONE WAY A COMPANY IS FOUNDED, WITH ONE DIFFERENCE**: held from the start,
 * the company is made on this device (`foundTheCompanyOnThisDevice`) and the
 * service is sent, in the same request, the founding signer's committee key,
 * which their wallet gave beside the label it drew, and what this device made
 * and sealed - everything the account's deploy is built from in this browser.
 */
async function foundCompany(
  spec: Parameters<typeof createCompanyWithWallet>[0], walletOrigin: string, view: Openable, atOrigin: string,
  how: 'as-today' | { readonly heldFromTheStart: AccountCreationBuilder },
): Promise<Founded> {
  if (!sessionLive || me === null) throw new Error('not signed in');
  const startedBy = me.id;
  if (pendingCompany !== null) {
    /* Somebody else's unfinished company is not theirs to finish, so they are not told to finish it. */
    if (!startedByTheSignedIn(pendingCompany)) throw new CompanyStartedBySomebodyElse(STARTED_BY_SOMEBODY_ELSE);
    throw new Error('a company this tab started is not finished yet, and its keys are only in '
      + 'this tab. Finish setting it up before starting another.');
  }

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
    const foundingKey = how !== 'as-today' ? schnorrKeyOf(committeeKey) : null;
    if (how !== 'as-today' && foundingKey === null) {
      throw new Error('Your wallet drew a label for the new company but gave no key to hold it with, so nothing was created. '
        + 'Update your wallet and try again.');
    }
    /* **A TAB THAT ALREADY HELD THE KEY READS WHAT IS SAVED NOW**, so keys saved
     * since - or keys that no longer open with this key - are known before a
     * company exists rather than after. */
    if (alreadyOpen) await reopenSavedKeys();
    /* Asked before anything is created, so a refusal costs nothing. */
    if (savedKeys !== 'some' && !keyCheckedAgainstSignIn) throw new FirstKeysNeedTheSignIn(FIRST_KEYS_NEED_THE_SIGN_IN);

    if (how !== 'as-today') return await foundTheCompanyOnThisDevice(spec, drawn, foundingKey!, how.heldFromTheStart, startedBy);

    /*
     * **STEP 2.** What comes back is used for one thing: the founding signer's own
     * secrets, which exist in this response and nowhere else in the world.
     */
    const created = await api('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({
        name: spec.name, signers: spec.signers, threshold: spec.threshold, companyLabel: drawn,
      }),
    });

    const accountId = String(created.account.id);
    const founded: Founded = { accountId, label: drawn, foundingKey: null, foundingLeaf: null };
    const mine = created.secrets[0];
    pendingCompany = {
      accountId,
      personId: startedBy,
      savingFailed: null,
      keys: {
        signerId: mine.signerId,
        signingSecret: mine.signingSecret,
        wrappingSecret: mine.wrappingSecret,
        blinding: mine.blinding,
        /* The scope the founding signer's own leaf was made under, carried from the
         * response rather than defaulted here. */
        scope: mine.scope,
      },
    };

    /* **STEP 3.** The slot is cleared only after the keys are written. */
    try {
      /* Somebody else signed in while the company was being made: its keys wait, bound to who started it. */
      if (!startedByTheSignedIn(pendingCompany)) throw new CompanyStartedBySomebodyElse(STARTED_BY_SOMEBODY_ELSE);
      await rememberAccount(accountId, pendingCompany.keys);
    } catch (refused) {
      /*
       * **A REFUSED SAVE IS READ AGAIN AND TRIED ONCE MORE, NOW.** The usual cause is
       * another tab or device saving at the same moment, and what it saved opens
       * with the same key - so this company's keys are saved beside it at once
       * rather than left waiting in a tab whose sign-in may end before anybody
       * presses Finish. A refusal about the sign-in itself is not retried.
       */
      if (refused instanceof AuthError) throw refused;
      await finishCompanyCreation();
      return founded;
    }
    pendingCompany = null;
    return founded;
  } catch (e) {
    putAway(dialog);
    throw e;
  } finally {
    doneWaiting();
  }
}

/**
 * **SAVING THE KEYS OF A COMPANY THIS TAB STARTED, AGAIN, AFTER A SAVE WAS REFUSED.**
 *
 * No wallet is asked: the key the keys are saved under is already open here.
 * What is saved now is read again first, because the refusal means somebody
 * saved something since - and this company's keys are saved beside it rather
 * than over it. **The slot is cleared only after the keys are written.**
 */
export async function finishCompanyCreation(): Promise<{ accountId: string }> {
  const waiting = pendingCompany;
  if (!waiting) {
    throw new Error('there is no company waiting to be set up in this tab.');
  }
  /* **ONLY INTO THE SAVED KEYS OF THE PERSON WHO STARTED IT.** Asked before anything is read or written. */
  if (!startedByTheSignedIn(waiting)) throw new CompanyStartedBySomebodyElse(STARTED_BY_SOMEBODY_ELSE);
  if (waiting.savingFailed === 'cannot-be-saved') throw new Error(cannotBeSavedSentence());
  try {
    await reopenSavedKeys();
  } catch (e) {
    if (e instanceof SavedKeysDidNotOpen && pendingCompany?.accountId === waiting.accountId) {
      pendingCompany = { ...pendingCompany, savingFailed: 'cannot-be-saved' };
      throw new SavedKeysDidNotOpen(cannotBeSavedSentence());
    }
    throw e;
  }
  /* And again after the read: a sign-in as somebody else may have come in while it was on its way. */
  if (!startedByTheSignedIn(waiting)) throw new CompanyStartedBySomebodyElse(STARTED_BY_SOMEBODY_ELSE);
  await rememberAccount(waiting.accountId, waiting.keys);
  if (pendingCompany?.accountId === waiting.accountId) pendingCompany = null;
  return { accountId: waiting.accountId };
}

/* ---------------- a company's account, created from this browser ---------------- */

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
 * never makes a second company.
 *
 * Nothing here is a secret of the company: the request that made it is public
 * halves and what its secrets seal, the deploy and the second step are public
 * once sent, and the signature is the founding signer's on a public step. The
 * seat's own secrets are kept beside it as every seat's are.
 */
interface SavedCreation {
  readonly accountId: string;
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
  readonly deploy: { readonly account: AccountAddress; readonly tx: string; readonly insert: ReadonlyArray<{ circuit: string; key: string }> } | null;
  /** The second step, signed by the founding signer's wallet, and that signature. */
  readonly signed: { readonly tx: string; readonly signature: { readonly tag: string; readonly value: string } } | null;
  /** The service recorded the deploy and the second step. */
  readonly recorded: boolean;
}

/** This person's company being created, if there is one. */
const savedCreation = (): SavedCreation | null => {
  const all = Object.values(keyring.creations ?? {});
  return all.length === 0 ? null : all[0]!;
};

/** Writes what is kept of a creation, with everything else saved, and nothing else changed. */
async function keepCreation(c: SavedCreation): Promise<void> {
  await putBundle({ ...keyring, creations: { ...(keyring.creations ?? {}), [c.accountId]: c } });
}

/** Drops what was kept of a creation, once it is finished. */
async function forgetCreation(accountId: string): Promise<void> {
  const { [accountId]: _done, ...rest } = keyring.creations ?? {};
  await putBundle({ ...keyring, creations: rest });
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
  spec: Parameters<typeof createCompanyWithWallet>[0], label: CompanyLabel, foundingKey: { tag: 'schnorr'; value: string },
  builder: AccountCreationBuilder, person: string,
): Promise<Founded> {
  const keys = newSeatKeys();
  const seat = await builder.foundingSeat({ signingSecret: keys.signingSecret, blinding: keys.blinding });
  const leaf = String(seat?.seat ?? '').toLowerCase();
  const scope = String(seat?.scope ?? '').toLowerCase();
  if (!HEX64_KEY.test(leaf) || !HEX64_KEY.test(scope)) {
    throw new Error('your seat in the new company could not be worked out on this device, so nothing was created.');
  }
  const founded = foundTheCompanyHere({
    name: spec.name, signer: spec.signers[0]!, userId: person, label,
    seat: { signingPublicKey: keys.signingPublicKey, wrappingPublicKey: keys.wrappingPublicKey, leaf },
  });
  const accountId = founded.account.id;
  /* Somebody else signed in while it was being made: their saved keys are not where this seat goes. */
  if (me === null || me.id !== person) throw new CompanyStartedBySomebodyElse(STARTED_BY_SOMEBODY_ELSE);
  const mine: AccountKeys = {
    signerId: founded.seat.signerId, signingSecret: keys.signingSecret, wrappingSecret: keys.wrappingSecret,
    blinding: keys.blinding, scope,
  };
  refuseToClobber(accountId, mine);
  const saved: SavedCreation = {
    accountId, label, foundingKey,
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
  const built = await builder.accountDeploy({
    foundingLeaf: saved.request.founding.seat.leaf, label: saved.label, foundingKey: saved.foundingKey,
  });
  const account = readAccountAddress(built.account);
  if (account === null) throw new Error('the account\'s deploy was built without an address that can be read, so nothing was sent.');
  const next = { ...saved, deploy: { account, tx: built.tx, insert: built.insert } };
  await keepCreation(next);
  return next;
}

/** What builds and proves the account's transactions: the vault worker, or anything that answers as it does. */
export interface AccountCreationBuilder {
  /**
   * The leaf the account seats for the keys made on this device, and the scope
   * it was made under, worked out with the chain's own function.
   */
  foundingSeat(material: { signingSecret: string; blinding: string }): Promise<{ seat: string; scope: string }>;
  accountDeploy(input: { foundingLeaf: string; label: string; foundingKey: { tag: string; value: string } }): Promise<{
    account: string; tx: string; insert: ReadonlyArray<{ circuit: string; key: string }>;
  }>;
  finishedCreation(input: { account: string; signature: { tag: string; value: string } }): Promise<{ tx: string }>;
  /**
   * The same deploy and the same signed second step, each carried in a fresh
   * transaction: the same account, the same signature, nothing made again.
   */
  creationAgain(input: { deploy: string; insert: string }): Promise<{ account: string; deploy: string; insert: string }>;
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
export const companyAwaitingItsSecondPress = (): { accountId: string; account: AccountAddress } | null => {
  const saved = savedCreation();
  return saved !== null && saved.deploy !== null && !saved.recorded ? { accountId: saved.accountId, account: saved.deploy.account } : null;
};

/** The company this person is creating on a chain, kept with their saved keys, until its creation is finished. */
export const companyBeingCreated = (): string | null => savedCreation()?.accountId ?? null;

/**
 * **THE FIRST PRESS: THE COMPANY IS MADE HERE AND ITS ACCOUNT'S DEPLOY IS
 * BUILT HERE, HELD BY THE FOUNDING SIGNER'S OWN KEY FROM ITS FIRST TRANSACTION.**
 *
 * The wallet draws the company's label and gives the key the founding signer
 * sits on its committee with; the company and every secret it has are made on
 * this device and kept; the service records what they seal, and the key, before
 * any deploy exists; this browser builds and proves the deploy and keeps it.
 * **NOTHING IS SENT TO THE CHAIN.** The account's address is known now, and the
 * second press asks the wallet to sign the step that finishes it.
 *
 * **ONE COMPANY AT A TIME.** While a company this person started is not
 * finished, this refuses: the second press, or `finishCompanyOnTheChain`, carries
 * that one on, from wherever it stopped.
 */
export async function startCompanyHeldFromTheStart(
  spec: Parameters<typeof createCompanyWithWallet>[0],
  walletOrigin: string,
  builder: AccountCreationBuilder,
  view: Openable = walletInThisPage(window),
  atOrigin: string = window.location.origin,
): Promise<{ accountId: string; account: AccountAddress }> {
  if (savedCreation() !== null) {
    throw new Error('a company you started is not finished yet. Finish it before starting another.');
  }
  /* Before the wallet is opened: a company is created with its founding signer only. */
  if (spec.signers.length !== 1 || spec.threshold !== 1) {
    throw new Error('a company is created with you as its only signer, at a threshold of one; everybody else joins by '
      + 'invitation, their seat made on their own device. Nothing was created.');
  }
  const founded = await foundCompany(spec, walletOrigin, view, atOrigin, { heldFromTheStart: builder });
  const saved = keyring.creations?.[founded.accountId];
  if (saved === undefined) throw new Error('the company was made but what was kept of it could not be read back, so no account was built. Nothing was sent.');
  const built = await buildTheDeploy(saved, builder);
  return { accountId: founded.accountId, account: built.deploy!.account };
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
 * Needs this person's saved keys open, which is where what was kept is.
 */
export async function signCompanyCreationFromTheWallet(
  walletOrigin: string,
  builder: AccountCreationBuilder,
  view: Openable = walletInThisPage(window),
  atOrigin: string = window.location.origin,
): Promise<{ accountId: string; account: AccountAddress; state: CompanyCreationState }> {
  if (!sessionLive) throw new Error('not signed in');
  if (encKey === null) throw new Error('open your saved keys first: what was kept of the company you are creating is with them.');
  let saved = savedCreation();
  if (saved === null) throw new Error('there is no company waiting to be finished.');
  saved = await buildTheDeploy(await sendTheCompany(saved), builder);
  const deploy = saved.deploy!;
  if (saved.signed === null) {
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
    const finished = await builder.finishedCreation({ account: deploy.account, signature });
    saved = { ...saved, signed: { tx: finished.tx, signature: { tag: signature.tag, value: signature.value } } };
    await keepCreation(saved);
  }
  const sent = await api(`/api/accounts/${saved.accountId}/creation`, {
    method: 'POST', body: JSON.stringify({ deploy: deploy.tx, insert: saved.signed!.tx }),
  });
  if (!saved.recorded) await keepCreation({ ...saved, recorded: true });
  return { accountId: saved.accountId, account: deploy.account, state: creationStateOf(sent.state) };
}

/**
 * **A DEPLOY OR A SECOND STEP THAT CAN NO LONGER LAND, CARRIED AGAIN.** Each
 * transaction lives thirty minutes. One that ran out before it landed is
 * carried in a fresh one: the same deploy, so the same account, and the same
 * signature, so the wallet is not asked again and nothing is made again.
 */
async function carriedAgain(accountId: string, builder: AccountCreationBuilder): Promise<{ deploy: string; insert: string }> {
  const saved = keyring.creations?.[accountId];
  if (saved === undefined || saved.deploy === null || saved.signed === null) {
    throw new Error('this browser does not hold what was sent for this company, so it cannot be sent again. Open your '
      + 'saved keys on the browser you created it from. Nothing was sent.');
  }
  const again = await builder.creationAgain({ deploy: saved.deploy.tx, insert: saved.signed.tx });
  if (readAccountAddress(again.account) !== saved.deploy.account) {
    throw new Error('carried again, the deploy would create another account than the one your wallet signed for. Nothing was sent.');
  }
  await keepCreation({ ...saved, deploy: { ...saved.deploy, tx: again.deploy }, signed: { ...saved.signed, tx: again.insert } });
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
): Promise<{ account: AccountAddress | null; state: CompanyCreationState }> {
  const standing = await companyCreationStanding(accountId);
  if (standing.state === 'deploy-expired' && builder !== undefined) {
    const again = await carriedAgain(accountId, builder);
    const answer = await api(`/api/accounts/${accountId}/creation/again`, { method: 'POST', body: JSON.stringify(again) });
    return { account: readAccountAddress(answer.account), state: creationStateOf(answer.state) };
  }
  if (standing.state === 'finish-expired' && builder !== undefined) {
    const { insert } = await carriedAgain(accountId, builder);
    const answer = await api(`/api/accounts/${accountId}/creation/finish`, { method: 'POST', body: JSON.stringify({ insert }) });
    return { account: readAccountAddress(answer.account), state: creationStateOf(answer.state) };
  }
  const answer = await api(`/api/accounts/${accountId}/creation/finish`, { method: 'POST' });
  return { account: readAccountAddress(answer.account), state: creationStateOf(answer.state) };
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
 * the service only reads it and sends it. When the chain shows the founding
 * signer's copy sealed, what was kept of the creation is dropped.
 */
export async function sealThePayRecordKey(
  accountId: string, builder: AccountCreationBuilder,
  opts: { readonly wait?: (ms: number) => Promise<void>; readonly tries?: number } = {},
): Promise<{ state: CompanyCreationState }> {
  if (encKey === null) throw new Error('open your saved keys first: the company\'s pay-record key is opened with them.');
  const saved = keyring.creations?.[accountId];
  const mine = keysFor(accountId);
  if (saved === undefined || mine === null) {
    throw new Error('this browser does not hold what this company was created with, so its pay-record key cannot be sealed '
      + 'here. Open your saved keys on the browser you created it from. Nothing was sent.');
  }
  const founding = saved.request.founding;
  const wrapped = founding.account.wrappedKeys.find((w) => w.signerId === mine.signerId);
  if (wrapped === undefined) throw new Error('the company was not made with a viewing key for your seat, so its pay-record key cannot be opened. Nothing was sent.');
  const viewingKey = unwrapKey(wrapped, mine.wrappingSecret);
  const key = String(parseCanonical<{ blinding: { payRecordKey?: unknown } }>(unseal(founding.sealedState.sealed, viewingKey)).blinding.payRecordKey ?? '');
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
  await forgetCreation(accountId);
  return { state: 'finished' };
}

/** **WHETHER A COMPANY IS FINISHED**, as the service reads its record and the chain. */
export async function companyCreationStanding(accountId: string): Promise<{ account: AccountAddress | null; state: CompanyCreationState }> {
  const answer = await api(`/api/accounts/${accountId}/creation`);
  return { account: readAccountAddress(answer.account), state: creationStateOf(answer.state) };
}

/** A state the service named, or `unknown` for anything this page does not know. */
const creationStateOf = (s: unknown): CompanyCreationState =>
  COMPANY_CREATION_STATES.find((k) => k === s) ?? 'unknown';

const ZERO_ON_THE_WIRE = '00'.repeat(32);
const NO_ASSET_ON_THE_WIRE = NO_ASSET;
const randomHex32 = (): string => toHex(randomBytes(32));

/**
 * Derives the viewing key from the account's wrapped keys and this user's own
 * wrapping secret. It is not stored on this device: it is recomputed per
 * session from material only this device holds. It is not kept by the server
 * either, and no read hands it over: the page opens what it reads, the people
 * included, and no route reads it from an address. But the page still hands
 * it to the service in the body of the run, proposal and governance writes
 * that open a company's sealed records there (`governed-call-on-device.ts`,
 * `vault-page-doors.ts`), so it is not yet a key the service never sees.
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
 * The server sends ciphertext because since M-96 that is all it has: the company
 * name, the signer list, the roles and the spending limits are sealed under a
 * key it never sees. Opening happens here, on the device that can, using exactly
 * the same code the server used to seal it.
 *
 * Returns null rather than throwing when this device holds no keys for the
 * account. That is a real state — you are a member, on a machine you have not
 * enrolled — and the account picker has to render something for it.
 */
export function openAccount(rec: SealedAccount): Account | null {
  try {
    return openSealedAccount(rec, viewingKeyFor(rec));
  } catch {
    return null;
  }
}
