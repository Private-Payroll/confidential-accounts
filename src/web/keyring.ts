/**
 * The client half of identity.
 *
 * Everything that can decrypt lives here, in the browser, and nowhere else. The
 * server holds a sealed blob it cannot open, and — since `PI4b` — no credential
 * of any kind. That is the entire trust model, and this file is where it is
 * either honoured or quietly broken, so it is deliberately small.
 *
 * What is in memory while signed in:
 *   encKey   RELEASED BY THE WALLET for one company, never transmitted
 *   keyring  signing and wrapping secrets, one entry per account
 *   token    a session token, which authorises but decrypts nothing
 *
 * What survives a page reload: the token only. **`encKey` used to be re-derived
 * from a password at sign in; it is asked of the wallet again instead**, which
 * is the same behaviour from the person's side and a better answer to where the
 * key came from. A reload therefore signs you out, which is the honest
 * behaviour: keeping `encKey` in storage would put it where any script on the
 * page can read it.
 */
import { seal, sign, toHex, unseal, unwrapKey, type Hex, type Sealed } from '../core/crypto.js';
import {
  askWalletToSignIn, openWalletDialog, type Openable, type WalletDialog,
} from './wallet-sign-in.js';
/* The screen that draws the waiting needs the type, and it should not have to
 * know which file below this one the wallet plumbing lives in. */
export type { WalletDialog } from './wallet-sign-in.js';
import { askWalletToUnlock } from './wallet-unlock.js';
import { askWalletForPayeeAddress } from './wallet-payee.js';
import { openAccount as openSealedAccount, approvalMessage } from '../core/account.js';
import { clobberRefusal, seatToPromote } from './seat-repair.js';
import type { Account, SealedAccount } from '../core/types.js';

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
   * **OPTIONAL, AND ABSENT MEANS `allVaults()`.** Every bundle sealed before
   * `S34` was written by a caller that passed two arguments and took the
   * scheme's default; reading a missing value as anything else would report
   * every one of those seats as a mismatch.
   */
  scope?: Hex;
}

/**
 * **KEY MATERIAL THAT IS DURABLE BEFORE ITS LEAF IS PUBLISHED.** `C329`,
 *
 *
 * The invite path used to POST the leaf and then seal the keyring. `putBundle`
 * rolls back and rethrows on a version conflict and the secrets were only ever
 * in that closure, so a conflict at the wrong moment seated a signer whose key
 * material never survived — a seat that counts towards N and can never approve,
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
 * A digest states what a round SAYS; `chainId` states which round it IS and which
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
  /** Keyed by account id. */
  accounts: Record<string, AccountKeys>;
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
}

export interface Me { id: string; email: string | null; name: string }

let token: string | null = null;
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
 * In memory only, like `encKey` and for the same reason — a reload signs you
 * out, and putting it in storage would put it where any script on the page can
 * read it. The server holds only a hash of it (`walletKeyOf`), so this is the
 * one place the address itself exists on this side.
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
 * In memory only, dropped on sign-out and replaced on every unlock, for the
 * same reason as `encKey`: a reload asks the wallet again.
 */
let releasedCompanyKey: { accountId: string; key: Hex } | null = null;

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
export const isSignedIn = () => token !== null && (encKey !== null || walletAddress !== null);
/**
 * **WHETHER THIS TAB CAN OPEN A COMPANY, WHICH IS NOT THE SAME QUESTION AS
 * WHETHER IT IS SIGNED IN.** `PI1`; **answered differently since `PI2a`.**
 *
 * Every company's viewing key is reached through the keyring, and the keyring
 * is sealed under `encKey`. `PI1` could only ever derive that from a password —
 * a wallet sign-in produces a signature, and *a signature is not a key* — so a
 * person could sign in with their wallet and open nothing. That was `C129`.
 *
 * **`encKey` NO LONGER MEANS "FROM A PASSWORD". IT MEANS "THE KEY THAT OPENS
 * THE BUNDLE, HOWEVER THIS TAB CAME BY IT."** `PI2a` made that true and `PI4b`
 * made it exact: `unlockWithWallet` is now the ONLY thing that sets it, for one
 * company, after a person pressed a button on the wallet's own screen.
 * Everything downstream — `viewingKeyFor`, `openAccount`, `putBundle` — is
 * unchanged and cannot tell the difference, which is the point: the day-one
 * posture is exactly what it was, and where the key comes from is better.
 */
export const canOpenCompanies = () => encKey !== null;
export const keysFor = (accountId: string): AccountKeys | null => keyring.accounts[accountId] ?? null;

/* ---------------- transport ---------------- */

export class AuthError extends Error {}

export const api = async (path: string, opts?: RequestInit) => {
  const r = await fetch(path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts?.headers ?? {}),
    },
  });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401) { forgetLocally(); throw new AuthError(body?.error ?? 'not signed in'); }
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
 * **`signInWithWallet` BELOW IS THE ONLY WAY IN**, and `unlockWithWallet` is
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
export type WalletWaiting = (dialog: WalletDialog | null) => void;

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
   * with no browser — the shape `unlockWithWallet` has always had. */
  view: Openable = window as never,
): Promise<Me> {
  /*
   * **OPENED HERE, IN THE CLICK, BEFORE ONE BYTE HAS BEEN AWAITED.**
   * `scripts/mutate-wallet-dialog.mjs` 01 moves this line below the challenge
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
  token = r.session.token;
  walletAddress = r.address;
  /* A sign-in releases nothing. The unlock is what does. */
  releasedCompanyKey = null;
  /* NO KEYRING AND NO `encKey`. See `canOpenCompanies` — this is not an
   * omission here, it is the state of the product after this round. */
  encKey = null;
  keyring = { accounts: {} };
  me = r.user;
  bundleVersion = 0;
  return r.user as Me;
}

/**
 * **OPENING THE KEYRING WITH THE KEY THE WALLET RELEASED.** `docs/NEXT.md`
 * PI2a, `docs/scope-payroll-identity.md` §9b.
 *
 * The half `PI1` could not build. Three steps, and a password appears in none
 * of them:
 *
 *   1. **ask this server which company we may open** — the account comes from
 *      the path and the membership check that already exists, and the address
 *      comes from what the ledger assigned. **Nothing this page believes about
 *      which company it is decides anything**; `company-address.ts` is where
 *      that rule lives and it has nowhere to put a claim.
 *   2. **open the wallet and ask it to release that company's key**, checked on
 *      arrival against the origin we are running at, the nonce we generated and
 *      the company we were told — `wallet-unlock.ts`.
 *   3. **open the bundle with it**, exactly as `signIn` opens it with the
 *      password-derived key. Nothing below this line knows the difference.
 *
 * **THE KEY IS NEVER SENT ANYWHERE.** It is not put in a request body, not in a
 * URL, not in storage and not in a log: it is assigned to `encKey`, which lives
 * in this module for the life of the tab and is dropped by `forgetLocally`. A
 * reload asks the wallet again, which is the same behaviour a password has and
 * is the honest one — keeping it anywhere persistent would put it where any
 * script on the page can read it.
 *
 * **AND IT IS THE SAME KEY ON A SECOND DEVICE.** That is what a DERIVED key
 * buys and a stored one never did: the wallet recomputes it from the person's
 * own seed and this company's address, so a phone that has never seen this
 * laptop opens the same bundle. `wallet-unlock.test.ts` holds that.
 */
/**
 * **ASKING THE WALLET WHERE TO PAY THIS PERSON.**
 *
 * It returns the three things `POST /api/accounts/:id/self-payee` needs and
 * **judges none of them**: the handle, the nonce, and whatever the wallet
 * answered. `src/core/wallet-payee.ts` decides on the server, where the record
 * is written — a check made in this page would be a second opinion about a
 * value the server has to judge for itself, and it would drag `ledger-v9` into
 * the bundle.
 *
 * **THE CHALLENGE IS ASKED FOR BEHIND THE MEMBERSHIP GATE**, on the company
 * this is about, because the row it leads to is on that company's roster.
 */
export async function payeeDisclosureFromWallet(
  accountId: string, walletOrigin: string,
  view: Openable = window as never,
): Promise<{ handle: string; nonce: string; response: unknown }> {
  if (!token) throw new Error('not signed in');
  /* **OPENED IN THE CLICK.** `C154` — the same order as the other two, and for
   * the same reason: the challenge below is a round trip, and a permission
   * spent on it is gone by the time a window is wanted. */
  const dialog = openTheWallet(view, walletOrigin);
  try {
    const challenge = await api(
      `/api/accounts/${accountId}/payee-challenge`, { method: 'POST' });
    const response = await askWalletForPayeeAddress(view, walletOrigin, {
      nonce: challenge.nonce,
      /* The challenge's own deadline, not a second number beside it. */
      expiresAt: Date.parse(challenge.expiresAt),
      name: US_TO_A_WALLET.name,
      rdns: US_TO_A_WALLET.rdns,
    }, dialog);
    return { handle: challenge.handle, nonce: challenge.nonce, response };
  } finally {
    doneWaiting();
  }
}

export async function unlockWithWallet(
  accountId: string, walletOrigin: string,
  /* The window, and the page's own origin, injected so the whole conversation
   * can be driven in a test with no browser. */
  view: Openable = window as never,
  atOrigin: string = window.location.origin,
  /* The dialog a longer journey already opened in its own click. Creating a
   * company is the only caller that has one; everybody else opens here. */
  already?: WalletDialog,
): Promise<void> {
  if (!token) throw new Error('not signed in');

  /*
   * **OPENED HERE, IN THE CLICK, BEFORE THE COMPANY IS ASKED FOR.**
   * `scripts/mutate-wallet-dialog.mjs` 02 moves this line below that question
   * and a test dies by name.
   */
  const dialog = openTheWallet(view, walletOrigin, already);
  try {
    await unlockOnceOpen(accountId, walletOrigin, view, atOrigin, dialog);
  } finally {
    doneWaiting();
  }
}

async function unlockOnceOpen(
  accountId: string, walletOrigin: string, view: Openable, atOrigin: string,
  dialog: WalletDialog,
): Promise<void> {
  /* THE COMPANY COMES FROM THE SESSION. This is a POST that sends no body:
   * there is nothing this page could tell the server about which company it is
   * that the server should believe. */
  const { company } = await api(`/api/accounts/${accountId}/unlock`, { method: 'POST' });

  const key = await askWalletToUnlock(view, walletOrigin, {
    company,
    atOrigin,
    name: US_TO_A_WALLET.name,
    rdns: US_TO_A_WALLET.rdns,
  }, dialog);
  const ek = toHex(key);

  const r = await api('/api/me/keys');
  /*
   * **THE ENVELOPE REFUSAL THAT WAS HERE IS DELETED WITH THE ENVELOPE.**
   * `PI4a`, `A-17`.
   *
   * It refused an account whose bundle was sealed under a bundle key rather
   * than directly — *"a device envelope, which a wallet-released key does not
   * open"* — because that would have failed as **wrong wallet** when it meant
   * **wrong door**. It was right, and it now guards a state nothing can reach:
   * the only thing that ever built an envelope is gone, and the server does not
   * return a bundle key because there is no longer such a field.
   *
   * **A refusal for an unreachable state is a branch nobody can test**, which
   * is how it becomes wrong without anybody noticing.
   */

  let opened: Keyring = { accounts: {} };
  if (r.keyBundle) {
    try { opened = JSON.parse(unseal(r.keyBundle as Sealed, ek)); }
    catch {
      /* The bundle is sealed under a DIFFERENT key. **The sentence that used to
       * be here blamed a password, and `C158` records that it is wrong for a
       * wallet-only person — who is now everybody, because `PI4b` deleted the
       * password.** The remaining cause is the one `C158` is about: a person has
       * ONE bundle and it is sealed under the key released for ONE company, so
       * the second company they make cannot open it. **What the bundle is
       * sealed under is NOT this round's to change** — that is `C158`, and it is
       * decided with a measurement in its own round. What is fixed here is only
       * that the message no longer names a thing that cannot exist. */
      throw new Error(
        'your keys could not be opened with the key your wallet released for this company. '
        + 'They are sealed under the key for a different company you belong to.');
    }
  }
  encKey = ek;
  /* **RECORDED WITH THE COMPANY IT BELONGS TO**, so a payslip key can only ever
   * be derived from the key this wallet released for THIS company. */
  releasedCompanyKey = { accountId, key: ek };
  keyring = opened;
  bundleVersion = typeof r.version === 'number' ? r.version : 0;
}

/**
 * Forgets everything this tab holds. LOCAL ONLY — it does not end the session
 * on the server, and it must not: it is also the 401 handler above, where the
 * session is already gone and calling the API again would recurse.
 *
 * Use `signOut()` for the button.
 */
export function forgetLocally() {
  token = null; encKey = null; keyring = { accounts: {} }; me = null; walletAddress = null;
  releasedCompanyKey = null;
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
export async function signOut() {
  try {
    if (token) await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // Already dead, or unreachable. Either way, clear.
  } finally {
    forgetLocally();
  }
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
export async function rememberAccount(accountId: string, keys: AccountKeys) {
  if (!encKey) throw new Error('not signed in');
  refuseToClobber(accountId, keys);
  keyring = { ...keyring, accounts: { ...keyring.accounts, [accountId]: keys } };
  await putBundle();
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
  keyring = {
    ...keyring,
    pendingSeats: { ...(keyring.pendingSeats ?? {}), [seat.signingPublicKey]: seat },
  };
  await putBundle();
}

/** What this device sealed and has not promoted yet, for one account. */
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
  keyring = {
    ...keyring,
    accounts: { ...keyring.accounts, [seat.accountId]: keys },
    pendingSeats: rest,
  };
  await putBundle();
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
 * **Retrying would erase that change**, so it is surfaced rather than swallowed
 * and the local edit is rolled back — this tab must not go on believing
 * something the server refused.
 */
async function putBundle() {
  if (!encKey) throw new Error('not signed in');
  const key = encKey;
  const before = keyring;
  try {
    const r = await api('/api/me/keys', {
      method: 'PUT',
      body: JSON.stringify({
        keyBundle: seal(JSON.stringify(keyring), key),
        ifVersion: bundleVersion,
      }),
    });
    bundleVersion = typeof r?.version === 'number' ? r.version : bundleVersion + 1;
  } catch (e) {
    keyring = before;
    throw e;
  }
}

/* ---------------- bringing a company into being ---------------- */

/**
 * **A COMPANY THAT EXISTS AND WHOSE KEYS THIS TAB HAS NOT SEALED YET.**
 *
 * The window between step 1 and step 3 below is the only genuinely dangerous
 * moment in this round, and it is dangerous because of what `create` returns:
 * **the founder's signing secret, wrapping secret and blinding are handed back
 * ONCE and are written down nowhere.** The viewing key is wrapped to that
 * wrapping key on the account record, so losing these secrets is losing the
 * company — intact, sealed, and unopenable. `C127` with the founder inside it.
 *
 * That window is not new: the password path has always been create-then-seal.
 * **What is new is that a human press now sits inside it**, and a person can
 * decline it, close the wallet, or open the wrong one. A declined press must
 * cost a retry rather than the company.
 *
 * So the secrets stay here, in memory, for the life of the tab, and the screen
 * can offer to finish. **In memory and nowhere else**, for `encKey`'s reason:
 * anything persisted is somewhere a script on this page can read.
 */
let pendingCompany: { accountId: string; keys: AccountKeys } | null = null;

/** The company this tab created and has not finished sealing, if there is one. */
export const companyAwaitingSetup = (): string | null => pendingCompany?.accountId ?? null;

/**
 * **SOMEBODY WITH A WALLET STARTS A COMPANY.** `docs/NEXT.md` PI3, `C141`,
 *
 *
 * ── THE ORDERING PROBLEM, WHICH IS THE WHOLE ROUND ────────────────────────
 *
 * Sealing the founder's keyring needs a key; the key is derived from the
 * company's address; **the company has no address until it exists.** Three
 * steps in an order nothing performed, which is why a wallet account could be
 * admitted to somebody else's company and could not start its own — and why the
 * password could not be deleted. `PI2a` declared it rather than working around
 * it, which is why this is a design and not a bug fix.
 *
 * **THE ORDER THAT WORKS IS CREATE, UNLOCK, SEAL**, and it is three steps
 * because the second cannot precede the first:
 *
 *   1. **The company is brought into being and the LEDGER assigns its address.**
 *      Nothing on this side invents one. The identifier is the chain's
 *      *because it is not ours to mint*, and `C140` records which it was.
 *   2. **The wallet is asked for that company's key** — through
 *      `unlockWithWallet`, so the company still comes from the authenticated
 *      session and never from this page. **A creation path is a new door and
 *      this is the round where it could have become the one that takes a
 *      company from a request body.** It has nowhere to put one: the account id
 *      goes in the path, and the address comes back from what the ledger
 *      assigned.
 *   3. **The founder's own secrets are sealed under that key.** From here a
 *      second device, or a recovery, recomputes the same key from the words and
 *      opens the same bundle.
 *
 * ── AND A PASSWORD APPEARS IN NONE OF THEM ────────────────────────────────
 *
 * There is no parameter for one, no fallback to one, and nothing on this path
 * derives auth material. **That was the point of `PI3` and it is what let
 * `PI4b` happen:** while creating a company was the one thing only a password
 * could do, the password could not be deleted and `C129` stayed open. It is
 * deleted now.
 *
 * ── WHAT IT REFUSES ───────────────────────────────────────────────────────
 *
 * A tab that can already open companies is turned away. **The reason has
 * changed under it and the refusal has not.** It used to be that `encKey` there
 * was a PASSWORD-derived key; there is no such key any more, so what such a tab
 * holds is the key the wallet released for ANOTHER company — and step 2 would
 * replace it, after which that person's bundle, sealed under the first, opens
 * with nothing. **That is `C158` and it is explicitly not this round's**, so
 * the behaviour is left exactly as it was. The ordinary creation path serves
 * them and this does not.
 */
export async function createCompanyWithWallet(
  spec: {
    name: string;
    signers: Array<{ name: string; role: 'admin' | 'approver' | 'initiator' | 'viewer' }>;
    threshold: number;
  },
  walletOrigin: string,
  /* The window and this page's own origin, injected so the whole journey can be
   * driven in a test with no browser — the same shape `unlockWithWallet` takes. */
  view: Openable = window as never,
  atOrigin: string = window.location.origin,
): Promise<{ accountId: string }> {
  if (!token) throw new Error('not signed in');
  if (encKey) {
    throw new Error(
      'this tab already holds the key that seals your keys, so it does not need to ask '
      + 'your wallet for a new one. Create the company the ordinary way.');
  }

  /*
   * **STEP 1 — AND THE ADDRESS IS NOT ASKED FOR HERE.** What comes back is
   * used for one thing: the founder's own secrets, which exist in this response
   * and nowhere else in the world. The company's address is fetched in step 2
   * from the session, which is the rule `PI2a` built and this path must not
   * become the exception to.
   */
  /*
   * **THE WINDOW OPENS IN THE PRESS, AND THE COMPANY IS MADE AFTER IT.**
   *
   * This journey is the one that cannot be repaired by reordering two lines:
   * step 2 needs a company, and a company takes a round trip to make. So the
   * dialog is opened first and carried down to the unlock, which is the ask it
   * was opened for. The page behind it says so the whole time.
   */
  const dialog = openTheWallet(view, walletOrigin);

  const created = await api('/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ name: spec.name, signers: spec.signers, threshold: spec.threshold }),
  });

  const accountId = String(created.account.id);
  const mine = created.secrets[0];
  pendingCompany = {
    accountId,
    keys: {
      signerId: mine.signerId,
      signingSecret: mine.signingSecret,
      wrappingSecret: mine.wrappingSecret,
      blinding: mine.blinding,
      /* The scope the founder's own leaf was made under, carried from the
       * response rather than defaulted here. */
      scope: mine.scope,
    },
  };

  await finishCompanyCreation(walletOrigin, view, atOrigin, dialog);
  return { accountId };
}

/**
 * **STEPS 2 AND 3, SEPARATELY, SO A DECLINED PRESS COSTS A RETRY.**
 *
 * Called by `createCompanyWithWallet` and by the screen when the person
 * pressed the wrong thing on their wallet the first time. It reads the secrets
 * this tab is holding and takes no company from anywhere else — **there is no
 * parameter for one**, which is the same rule the unlock has and for the same
 * reason.
 *
 * **THE SLOT IS CLEARED ONLY AFTER THE BUNDLE IS WRITTEN.** If the wallet is
 * declined or the server refuses, the secrets are still here and the person can
 * try again; clearing first would turn a declined press into a lost company.
 */
export async function finishCompanyCreation(
  walletOrigin: string,
  view: Openable = window as never,
  atOrigin: string = window.location.origin,
  /* Present when the creation press opened the window and this is the second
   * half of that journey; absent when a person is retrying from the screen,
   * where this call IS the click. */
  already?: WalletDialog,
): Promise<{ accountId: string }> {
  const waiting = pendingCompany;
  if (!waiting) {
    throw new Error('there is no company waiting to be set up in this tab.');
  }

  /*
   * **STEP 2.** Through the unlock, deliberately, rather than by handing the
   * wallet the address the creation response happened to carry. Two things
   * follow from going the long way round, and both are the round:
   *
   *   · the company comes from the authenticated session, so this new
   *     door is not the one that takes a company from a caller; and
   *   · `C140`'s guard is in the path, so **a company whose address no chain
   *     assigned is refused here** — before anything is sealed under a key
   *     derived from it. Outside `npm run dev` that is every company today,
   *     which is a dependency on the chain and is written up as one.
   */
  await unlockWithWallet(waiting.accountId, walletOrigin, view, atOrigin, already);

  /* **STEP 3.** The same call the password path makes, unchanged. */
  await rememberAccount(waiting.accountId, waiting.keys);
  pendingCompany = null;
  return { accountId: waiting.accountId };
}

/**
 * Derives the viewing key from the account's wrapped keys and this user's own
 * wrapping secret. Note what does not happen: the viewing key is never stored,
 * never sent, and never asked of the server. It is recomputed per session from
 * material only this device holds.
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
