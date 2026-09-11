import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import type { ReactNode } from 'react';
import {
  MemoryChallengeStore, cancelRecovery, completeRecovery, fromBase64Url, identityFromSecret,
  newSecret, offerPiece, readPieceHeader, startRecovery, toBase64Url, verifyAssertion,
  verifyRegistration, withdrawPiece,
} from 'midnight-identity';
import type { ChallengeStore, Identity, PieceSet, RecoverySession, Secret } from 'midnight-identity';
import { createPasskey, passkeysAvailable, usePasskey } from 'midnight-identity/browser';
import { browserPort, forgetProfile } from 'midnight-identity/profile/store';
import { EMBEDDER, ORIGIN, RP_ID, RP_NAME } from './config.js';

/**
 * **THE ONE PAGE A PASSKEY CEREMONY MAY RUN INSIDE, AND ONLY FOR TWO CEREMONIES.**
 *
 * A ceremony in a frame reports the page around it, and the verifier refuses
 * one whose surrounding page it was not told to accept. **Making a wallet and
 * unlocking one are the two an approval inside the application needs**, so
 * they accept the embedder. Adopting a passkey, starting again, finishing a
 * recovery and receiving a wallet from another device do not: each replaces or
 * rebuilds what this browser holds, and each stays a thing done in the wallet's
 * own tab, where the address bar is.
 */
const FRAMED_BY: readonly string[] = EMBEDDER === null ? [] : [EMBEDDER];
import {
  StorageError, allPasskeys, forgetAllPasskeys, forgetEverything, forgetSealingKey,
  forgetSecuredSetup, loadSecret, readKeyringRecord, resetPasskeyRecordTo,
  saveArrival, saveCreation, savePasskey, saveSecret, saveSecuredSetup, saveWalletName,
  walletNameOf, walletNameOnRecord, walletOfCredential,
} from './accounts/storage.js';
import { heldWallets, openWallet, openWalletId } from './accounts/wallets-held.js';
import { describeFailure } from './lib/failure-text.js';

/**
 * WHAT STATE THIS BROWSER IS IN, and the ceremonies that move it.
 *
 * This file is the only place the passkey ceremony is wired to storage, so the
 * order audited into the harness survives here unchanged: issue a challenge,
 * run the ceremony, TAKE the challenge (one use), verify, and only
 * then touch storage. The screens call these and render; no screen re-decides
 * any of it.
 *
 * There is no server. The challenge store lives in this tab, so a passkey here
 * proves "this browser, and somebody who can pass its screen lock" — a gate on
 * the interface, not authentication to anybody. The same verification code
 * runs against a real server in the payroll product.
 */

export type Phase =
  /** The browser cannot do passkeys at all. */
  | { readonly name: 'unsupported' }
  /** Nothing stored here yet. */
  | { readonly name: 'welcome' }
  /** An account is stored; its keys stay sealed until a passkey opens the UI. */
  | { readonly name: 'locked' }
  /**
   * A READABLE sealed account with no usable passkey record — the record is
   * cleanly absent, or damaged (`recordDamaged`: damaged public data
   * over a live account is a doorway, never a gravestone). The way in is
   * registering a fresh passkey (`adoptPasskey`), which for the damaged
   * variant also discards the unreadable record — a door the person presses,
   * which is what separates it from a forbidden silent repair.
   */
  | { readonly name: 'account-no-passkey'; readonly recordDamaged: boolean }
  /**
   * The reverse: passkey records with no sealed account behind them. The
   * ceremony would succeed and open nothing. The doors are recovery, another
   * device, or starting fresh (`startFresh`).
   */
  | { readonly name: 'passkey-no-account' }
  | { readonly name: 'unlocked'; readonly identity: Identity; readonly secret: Secret }
  /** Stored state nobody can open or read. The message is storage's own. */
  | { readonly name: 'broken'; readonly message: string };

export interface Session {
  readonly phase: Phase;
  /** A ceremony is in flight — "Waiting for your passkey…". */
  readonly busy: string | null;
  /** The last failure, verbatim. Cleared when a ceremony starts. */
  readonly error: string | null;
  /**
   * @param walletName An optional name for the WHOLE wallet — asked for by the
   * screen BEFORE this is called, because it is passed to `createPasskey` and
   * nothing can change it there afterwards. Omitted or empty behaves exactly
   * as this wallet did before names existed.
   */
  createAccount(walletName?: string): Promise<void>;
  /**
   * @param options.onlyTheOpenWallet The person has already said which wallet:
   * they pressed it in this browser's own list, and the window has switched to
   * it. The browser is then offered that wallet's passkeys and no others, so
   * its chooser does not ask the same question again. Absent, every passkey
   * for this site is offered and the one picked decides which wallet opens.
   */
  unlock(options?: { onlyTheOpenWallet?: boolean }): Promise<void>;
  /**
   * account-no-passkey: register a fresh passkey and open the sealed account.
   *
   * **TAKES NO NAME, DELIBERATELY.** This is a SECOND credential for a wallet
   * that already exists here, and that wallet already has a name or has
   * chosen not to — so this path READS the stored one rather than asking a
   * question whose answer it already holds. Asking here is how a person ends
   * up naming one wallet three times, and how two of its credentials end up
   * disagreeing about what it is called.
   */
  adoptPasskey(): Promise<void>;
  /**
   * passkey-no-account: forget the stale records and create a new wallet.
   *
   * @param walletName As `createAccount` — this is a NEW wallet, so there is
   * nothing on record to reuse and the screen asks.
   */
  startFresh(walletName?: string): Promise<void>;
  /**
   * THE RECOVERY SESSION — §7.11: a resumable session with states, never a
   * function call. It lives in this provider so it survives navigating away
   * and back; it does NOT survive a reload, deliberately — a gathering
   * session holds threshold-many pieces, which is the whole secret, and
   * `SECURITY.md` forbids writing that anywhere unsealed. The screen says so.
   */
  readonly recovery: RecoverySession | null;
  /**
   * Adds one piece, typed or pasted from its card. The threshold comes off
   * the pieces and must agree across them. Returns whether it
   * was accepted, and — because a second piece from the same holder REPLACES
   * the first rather than adding — the holder it replaced, so the screen can
   * say which piece was swapped out instead of counting silently.
   */
  offerRecoveryPiece(text: string, holder: string): {
    readonly ok: boolean; readonly replaced: string | null;
  };
  withdrawRecoveryPiece(holder: string): void;
  /**
   * completeRecovery → the account LANDS → then the gate ceremony.
   *
   * @param walletName Optional, and this path is the one that may already know
   * the answer: if this browser has ever held THIS secret its record is reused
   * (fingerprint-checked), so a person who cannot remember what they called it
   * is not forced to invent a new one. What they type wins over what is found.
   */
  finishRecovery(walletName?: string): Promise<void>;
  /** Cancel: the library drops the gathered pieces. */
  abandonRecovery(): void;
  /** After a terminal session: back to a clean start. */
  resetRecovery(): void;
  /**
   * THE PAIRING LANDING — the pairing half of what `finishRecovery` does for
   * recovery. The screen has already run the pairing protocol and holds the
   * opened secret; this seals it, retires the old passkey record (the standing
   * rule — every credential on record gates the account this landing just
   * replaced), and runs the gate ceremony. A cancelled ceremony leaves the
   * account sealed behind the `account-no-passkey` doorway. NOTHING is
   * written about pieces: pairing proves the other machine had the account,
   * not that any piece exists anywhere, so home shows the does-not-know
   * state rather than a tick or a false warning (§7.15's third state).
   *
   * RETURNS whether the secret LANDED — sealed into storage — regardless of
   * how the ceremony went. The screen must not spend its one-use
   * pairing request until this is true, and a browser that cannot store
   * hears the storage's own sentence on this screen rather than silence.
   */
  /**
   * @param walletName Optional, settled exactly as `finishRecovery` settles
   * it — a wallet ARRIVING on this machine, not a new one. The name does not
   * travel with the pairing: it is a label this browser keeps, so the machine
   * receiving the wallet is the one that says what it is called here.
   */
  finishPairing(secret: Secret, walletName?: string): Promise<boolean>;
  /** True once a pairing has landed an account in this session. */
  readonly paired: boolean;
  /** Drops the keys from memory. The sealed copy stays; a passkey reopens it. */
  lock(): void;
  /** Forgets everything in this browser. Only offered where recovery cannot help. */
  startOver(): void;

  /* ---- This browser holds more than one wallet. ---- */

  /** Every wallet this browser holds, in the order it took them on. */
  readonly wallets: readonly HeldWalletView[];
  /**
   * THE COMPARTMENT THIS WINDOW HAS OPEN — for the screens that read a record
   * while rendering.
   *
   * it is on the session rather than each screen calling
   * `openWalletId()` for itself, so that a screen and the session it renders
   * from cannot answer differently. Every reader in `storage.ts` now REQUIRES
   * a compartment; this is where a screen gets one.
   */
  readonly walletId: string;
  /**
   * TURNS TO ANOTHER WALLET. **It LOCKS — it does not open.** The keys of
   * whatever was unlocked leave memory in the same breath (the phase stops
   * being `unlocked`, and the secret lived only there), and the chosen wallet
   * is then behind its own passkey like any other locked wallet.
   *
   * That is the whole of the refusal: two
   * wallets are never unlocked at once, and there is no path here that could
   * make it happen, because there is no code path that opens a wallet except
   * the one ceremony in `unlock`.
   *
   * **IT NOW RETURNS THE PHASE IT LANDED IN, AND THAT IS THE WHOLE OF
   * THE CHANGE.** It still only locks. The caller that wants the chosen wallet
   * OPENED calls `unlock` itself, in the same handler, so the one ceremony
   * stays the one ceremony; what it could not do before was find out whether
   * the wallet it just turned to is one a passkey ceremony makes any sense
   * for. `wallets-here.tsx` presses the row of a wallet whose compartment may
   * hold a damaged keyring (`broken`) or no credential at all
   * (`account-no-passkey`); firing the browser's chooser at either of those is
   * a prompt the person cannot answer and a red line on a screen that has
   * already been replaced. The phase is derived here regardless — returning it
   * costs nothing and is not a second source of truth, because it is the same
   * value `setPhase` is being given.
   *
   * ── THE RETURN VALUE CAN BE DROPPED, AND IT IS LEFT THAT WAY ──
   *
   * **This is open and this change did not close it.** The attempt was to make
   * the value impossible to drop BY TYPE, without introducing a second opening
   * path, and to say so rather than fix it wrongly if that could not be had.
   * It could not be had. The reasoning, so the next round does not re-derive
   * it:
   *
   * **1. TYPESCRIPT HAS NO SUCH CHECK.** There is no `must_use`, no
   * `nodiscard`, no compiler flag and no type that makes a discarded call
   * illegal: a call used as an expression statement is never checked for
   * assignability against anything, so no return type -- branded, opaque,
   * generic, `unique symbol` -- changes whether `switchTo(id);` compiles.
   * `noUnusedLocals` and `noUnusedParameters` are both on here
   * (`tsconfig.json`) and neither looks at discarded results. **The one
   * mechanism that does exist in this ecosystem is a LINT RULE, and it covers
   * thenables only** (`no-floating-promises`); this repository has no linter,
   * and making `switchTo` async to reach that rule would change a synchronous
   * state transition into one a caller can interleave with, which is a larger
   * change to the opening path than the row is worth.
   *
   * **2. THE DROP IS NOT ACTUALLY THE HOLE.** `wallets-here.tsx` could read
   * the phase and call `unlock()` anyway; the fault named above -- a passkey
   * prompt fired at a compartment that is not open -- would survive a check
   * that only forced the value to be READ. **The only construction that
   * genuinely forecloses it is making `unlock` demand the landed phase as
   * evidence**, and that is refused for two reasons and each alone is enough:
   * `unlock()` is also pressed from `screens/unlock.tsx`, which never switched
   * and has no landed phase to hand over, so it would have to synthesise one --
   * **a token that lies, which is worse than the drop it replaces**; and an
   * `unlock` whose argument comes from `switchTo` is switch-and-open wearing
   * two names, which is exactly what was refused earlier.
   *
   * **SO THE GUARD REMAINS A PLACEMENT AND NOT A PROOF**, and what stands
   * behind it is a test rather than a type:
   * *"a wallet with no credential on record is SWITCHED to and NOT prompted
   * for"* @ `apps/wallet/src/screens/wallets-here.test.tsx:215`, which mutation `04` of
   * The wrong-wallet mutation kills by making every row prompt. That is
   * a proof the guard is THERE; it is not a proof that a later caller cannot
   * omit it. **The honest description of the state is that the row stays
   * open**, against a future where the one ceremony is reachable from one
   * place and can therefore demand its own evidence.
   */
  switchTo(walletId: string): Phase;
  /**
   * TAKES A WALLET OFF THIS BROWSER — the sealed copy, the passkeys, the
   * names, the piece map, the cached balances and the key that opened it.
   *
   * **THE MOST DANGEROUS CONTROL IN THE CHANGE**, and the session's half of
   * making it safe is only that it is a named, separate function with no
   * default: the screen that offers it owns the confirmation, the sentence
   * about what is lost, and the rule that it is not reachable in the middle
   * of anything else.
   */
  removeWallet(walletId: string): void;
}

/**
 * What the stored state adds up to. One function, used at start-up and after
 * every transition that changes storage, so the states cannot be reached in
 * one place and missed in another.
 *
 * THE KEYRING IS PARSED, NOT PROBED FOR EXISTENCE. And the two
 * records are judged separately: a damaged PASSKEY record (public
 * data, worth nothing) over a READABLE account is a doorway with the account
 * behind it, not `broken`; `broken` is reserved for a state where nothing
 * usable can be said about the ACCOUNT itself.
 */
function derivePhase(): Phase {
  if (!passkeysAvailable()) return { name: 'unsupported' };

  /* EVERY QUESTION BELOW IS ABOUT ONE COMPARTMENT, THE OPEN ONE, and
   * that is the whole of the change here: the phases, their conditions and
   * their order are what they were. `welcome` gains one clause, because "no
   * wallet is stored here" and "this browser holds nothing" stopped being the
   * same sentence the moment a browser could hold four. */
  const walletId = openWalletId();
  const keyring = readKeyringRecord(walletId);
  if (keyring.state === 'damaged') {
    return { name: 'broken', message: keyring.error.message };
  }

  let passkeyCount = 0;
  let passkeysDamaged: StorageError | null = null;
  try {
    passkeyCount = allPasskeys(walletId).length;
  } catch (e) {
    if (e instanceof StorageError) passkeysDamaged = e;
    else throw e;
  }

  if (keyring.state === 'readable') {
    if (passkeysDamaged) return { name: 'account-no-passkey', recordDamaged: true };
    if (passkeyCount === 0) return { name: 'account-no-passkey', recordDamaged: false };
    return { name: 'locked' };
  }
  /* No account at all. Damaged passkey records with nothing behind them
   * still get the honest screen — there is no account to build a door to. */
  if (passkeysDamaged) return { name: 'broken', message: passkeysDamaged.message };
  if (passkeyCount > 0) return { name: 'passkey-no-account' };
  return { name: 'welcome' };
}

/**
 * THE COMPARTMENTS THAT ACTUALLY HOLD A WALLET — a sealed keyring, not merely
 * leftovers.
 *
 * **THE DISTINCTION IS THE WHOLE OF THE GUARD BELOW.** `passkey-no-account` is
 * a compartment with credentials and nothing behind them, and it is already in
 * the list of what this browser holds; a wallet LANDING there changes nothing
 * about that list. What changes is that the compartment now has a keyring in
 * it — which is precisely the sentence that screen was drawn to say, going
 * false. Counting compartments would have missed it; counting WALLETS does
 * not.
 */
const walletsHeldNow = (): readonly string[] => heldWallets()
  .filter((wallet) => readKeyringRecord(wallet.id).state !== 'absent')
  .map((wallet) => wallet.id);

/**
 * WHAT THIS BROWSER HOLDS, IN A SENTENCE, for a refusal that has to leave the
 * person somewhere to go. `walletNameOnRecord` is the unchecked reader
 * `storage.ts` documents for exactly this situation — talking ABOUT a wallet
 * whose secret is sealed — scoped per compartment.
 */
function describeWhatIsHeld(): string {
  const held = heldWallets();
  if (held.length === 0) return 'This browser holds no wallet at all.';
  const names = held.map((wallet, i) => walletNameOnRecord(wallet.id) ?? `wallet ${i + 1}`);
  return held.length === 1
    ? `This browser holds one wallet: ${names[0]}.`
    : `This browser holds ${held.length} wallets: ${names.join(', ')}.`;
}

/** One row of the list of wallets this browser holds. */
export interface HeldWalletView {
  readonly id: string;
  /** The name a person gave it, or null for a wallet that was never named. */
  readonly name: string | null;
  /** True for the one this window is looking at — open or locked. */
  readonly current: boolean;
}

/**
 * WHAT THE BROWSER'S PASSKEY CHOOSER IS TOLD THIS CREDENTIAL IS FOR — decided
 * here, and fixed for ever the moment `createPasskey` returns.
 *
 * **THESE STRINGS CANNOT BE CHANGED AFTERWARDS BY THIS OR ANY OTHER WEB
 * APPLICATION.** `navigator.credentials.create` takes them and only the
 * browser or the password manager can rename a saved credential. That is the
 * whole reason every caller below settles the wallet's name BEFORE its
 * ceremony rather than after it, and the reason the rename control says so.
 *
 * THE DATE IS OLD AND IS UNCHANGED IN PURPOSE: a replacement has
 * to be tellable from the original, because after an adopt, a fresh start, a
 * recovery or a pairing the authenticator may hold both and only one is on
 * record.
 *
 * THE WALLET'S OWN NAME GOES IN FRONT OF IT, when there is one — that is
 * the fact a person needs and the date alone never carried. **A wallet with
 * no name keeps exactly the strings this wallet has always passed**: `null`
 * here reproduces them character for character, which is what makes the
 * feature additive rather than compulsory.
 *
 * `what === null` is the FIRST credential of a new wallet — no date, because
 * there is nothing yet for it to be told apart from.
 */
const credentialLabel = (walletName: string | null, what: string | null): string => {
  const wallet = walletName !== null && walletName.trim() !== ''
    ? walletName.trim()
    : 'Midnight wallet';
  return what === null
    ? wallet
    : `${wallet} — ${what} ${new Date().toISOString().slice(0, 10)}`;
};

/**
 * LANDS THE WALLET'S NAME BESIDE THE SECRET THAT HAS JUST BEEN SEALED, and
 * returns what the name now is.
 *
 * Called by all four landings, WITH OR WITHOUT A NAME, which is the rule
 * `storage.ts`'s `walletNameOnRecord` depends on. What it settles on:
 *
 *   1. the name the person just gave, if they gave one;
 *   2. otherwise this browser's own record FOR THIS SECRET — a machine that
 *      already held this wallet knows what it was called, and a recovery or a
 *      re-pairing onto it must not silently drop that;
 *   3. otherwise none, which also REMOVES a record belonging to the wallet
 *      this landing replaced.
 *
 * Step 2 is fingerprint-checked inside `walletNameOf`, so it can only ever
 * return this wallet's own name — never the previous occupant's.
 */
function settleWalletName(secret: Secret, given: string | undefined): string | null {
  const asked = (given ?? '').trim();
  const settled = asked !== '' ? asked : walletNameOf(secret) ?? '';
  saveWalletName(secret, settled);
  return settled === '' ? null : settled;
}

/**
 * **THE GUARD THIS CHANGE INHERITED, REPLACED RATHER THAN REMOVED.**
 *
 * A refusal used to sit in front of both wallet-making ceremonies: re-read the
 * keyring at press time and refuse if a wallet is already stored, naming it.
 * It was built for a real, captured sequence — two windows on this origin, a
 * wallet lands in the first, the second is still showing the create screen it
 * drew a minute ago, and the press overwrote a wallet in silence.
 *
 * **MANY WALLETS MAKES ITS CONDITION FALSE AND ITS PURPOSE TRUE.** "A wallet is already
 * stored here" is no longer a reason to refuse anything — it is the ordinary
 * state of a browser holding three wallets and about to hold a fourth. The
 * RACE does not stop being real, so the question changes rather than going
 * away.
 *
 * WHAT ANSWERS THE DESTRUCTIVE HALF IS NOT THIS FUNCTION ANY MORE, and saying
 * so is the honest part. `storage.ts`'s `slotForLanding` reads which
 * compartment is free AT WRITE TIME, inside `saveSecret`, after the ceremony
 * and microseconds before the seal — so a wallet that arrived while the prompt
 * was open no longer shares a compartment with the one being made. The
 * overwrite is closed structurally, by the keys, and it is closed for all four
 * landings rather than the two that had a guard.
 *
 * WHAT IS LEFT IS THE PERSON'S DECISION, AND IT IS WORTH A REFUSAL OF ITS OWN.
 * `welcome` says *this browser is empty*; `passkey-no-account` says *these
 * credentials have nothing behind them, start again*. If a wallet has arrived
 * since either sentence was drawn, both are now false, and the press is an
 * answer to a question this browser is no longer asking. So: refuse, name what
 * arrived, refresh the screen, and let the person choose against the world
 * that exists.
 *
 * **IT COMPARES WHAT THIS WINDOW LAST RENDERED WITH WHAT IS THERE NOW** —
 * `drawnFor` below, updated on every commit. That is a sharper question than
 * the old "is anything stored", and it is the same question it was really
 * asking: *has the world moved under this screen?*
 *
 * Returns the sentence to say, or null. As before, the caller puts its own
 * screen right and then throws it, because only the caller has the phase
 * setter and a refusal that left a stale screen up would be the same lie in a
 * quieter form.
 */
function theWorldMovedSince(drawnFor: readonly string[]): string | null {
  const arrived = walletsHeldNow().filter((id) => !drawnFor.includes(id));
  if (arrived.length === 0) return null;
  const named = arrived
    .map((id) => walletNameOnRecord(id))
    .filter((name): name is string => name !== null);
  const which = named.length === 0 ? '' : ` — ${named.join(', ')}`;
  return (arrived.length === 1 ? 'a wallet' : `${arrived.length} wallets`)
    + ` arrived in this browser${which} since this screen was drawn — another window or `
    + 'another tab finished something while this one was open. Nothing has been made here '
    + 'and nothing has been replaced. This screen has been refreshed; see what this browser '
    + 'now holds, and choose again.';
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children, challenges: injected }: {
  readonly children: ReactNode;
  /**
   * Substitutable so the one-use rule is TESTABLE, second path. The
   * refusal of a spent challenge is the whole replay defence (the sign
   * counter is off for every synced passkey), and with the store
   * module-private nothing could pin it. Defaults to the real
   * `MemoryChallengeStore`; the app passes nothing. This is an app seam —
   * the library's published surface is untouched.
   */
  readonly challenges?: ChallengeStore;
}): ReactNode {
  const [challenges] = useState<ChallengeStore>(() => injected ?? new MemoryChallengeStore());
  const [phase, setPhase] = useState<Phase>(derivePhase);
  /**
   * WHAT THIS WINDOW LAST DREW ITS SCREENS FOR — the compartments this browser
   * held at the most recent commit. `theWorldMovedSince` compares it with what
   * is there at press time.
   *
   * A REF AND AN EFFECT RATHER THAN STATE, deliberately: it must NOT cause a
   * render, and it must be updated by THIS window's own paint and by nothing
   * else. Another window landing a wallet does not re-render this one — which
   * is exactly the sequence being guarded against, and exactly why the value
   * here goes stale in the way that makes the comparison meaningful.
   */
  const drawnFor = useRef<readonly string[] | null>(null);
  drawnFor.current ??= walletsHeldNow();
  useEffect(() => { drawnFor.current = walletsHeldNow(); });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createAccount = useCallback(async (walletName?: string) => {
    setBusy('Waiting for your passkey…');
    setError(null);
    try {
      /* Before the prompt, and before anything is written. The phase is put
       * right first, then the sentence is thrown onto the error line — the
       * order `adoptPasskey` uses for the mirror-image state. */
      const moved = theWorldMovedSince(drawnFor.current ?? []);
      if (moved !== null) {
        setPhase(derivePhase());
        throw new Error(moved);
      }
      /**
       * WHICH COMPARTMENT A WALLET MADE NOW WOULD LAND IN — asked here,
       * synchronously, before the prompt, because the answer decides what the
       * exclude list must say and the list is fixed the moment the ceremony
       * starts.
       *
       * `storage.ts`'s `slotForLanding` lands a new wallet in the OPEN
       * compartment when that compartment has no keyring — which is
       * `passkey-no-account`, credentials with nothing behind them — and in a
       * fresh one otherwise. The read is the same one it makes.
       */
      const here = openWalletId();
      const landsHere = readKeyringRecord(here).state === 'absent';

      const challenge = await challenges.issue('register');
      const handle = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
      /* THE NAME REACHES THE CHOOSER HERE OR NOWHERE — the secret does not
       * exist yet, so this is the given string and nothing read from disk. */
      const label = credentialLabel(walletName ?? null, null);
      const registration = await createPasskey({
        rpId: RP_ID,
        rpName: RP_NAME,
        challenge,
        person: { id: handle, name: label, displayName: label },
        /**
         * **THE CREDENTIALS OF THE COMPARTMENT THIS WALLET WILL LAND IN, AND
         * NO OTHERS — and this is a fix, not a tidy-up.**
         *
         * An authenticator asked for a second credential under a known
         * handle silently destroys the first, and `excludeCredentials` turns
         * that into a refusal. The handle here is sixteen fresh random bytes,
         * so a collision is impossible — which is exactly why `startFresh`,
         * `finishRecovery` and `finishPairing` all pass an EMPTY list and say
         * so. What this list still buys is the `passkey-no-account` case: a
         * stale credential in the compartment about to be reused.
         *
         * **AND WHAT IT COSTS IF IT NAMES ANY OTHER WALLET'S CREDENTIAL IS THE
         * FEATURE.** `excludeCredentials` makes the authenticator REFUSE when
         * it already holds one of the listed credentials. This browser now
         * holds several wallets whose passkeys are all on this authenticator,
         * so listing another wallet's credential here does not protect
         * anything — it makes "add another wallet" fail with
         * `InvalidStateError`, every time, on exactly the machines where the
         * feature matters.
         */
        existing: landsHere ? allPasskeys(here).map((p) => p.credentialId) : [],
      });
      if (!(await challenges.take(challenge, 'register'))) {
        throw new Error('that took too long and the challenge expired. Try again.');
      }
      const verified = await verifyRegistration(registration, {
        rpId: RP_ID, origin: ORIGIN, challenge, allowFramedBy: FRAMED_BY,
      });

      /* ONE OF THE TWO PLACES A SECRET IS BORN, and the stamp goes on
       * the value `newSecret()` just returned rather than on whatever is being
       * stored. `finishRecovery` seals `done.secret`, which came out of
       * `completeRecovery`, and `finishPairing` seals the one the other
       * machine sent; neither calls `newSecret()` and neither can reach this
       * binding, so neither can stamp itself as a creation. */
      const fresh = newSecret();

      /**
       * THE SEAL COMES FIRST NOW, AND THE ROLLBACK IS GONE BECAUSE
       * THERE IS NOTHING LEFT TO ROLL BACK.
       *
       * `saveSecret` decides WHICH COMPARTMENT this wallet lands in, and it
       * decides it at write time — which is what closes the two-window race
       * for every landing at once. The passkey record belongs to that
       * compartment, so it cannot be written before the compartment is known:
       * writing it first would put the new wallet's credential into whichever
       * wallet this window happened to have open.
       *
       * **THE GUARANTEE AN EARLIER FINDING BOUGHT IS UNCHANGED AND IS NOW
       * STRUCTURAL.** A half-landed registration must not survive: a browser
       * that cannot seal — IndexedDB refused, private browsing, quota — used
       * to be left with a passkey record alone, and every retry then died
       * identically on the exclude list. In this order that record is
       * never written at all. `session.test.tsx`'s rollback test asserts the
       * same two keys are absent and pins it either way.
       */
      const walletId = await saveSecret(fresh);
      savePasskey(verified, walletId);
      /* AFTER the seal, not before: a keyring that could not be stored is a
       * creation that did not happen, and nothing above it ran. A stamp
       * written first would outlive it. */
      saveCreation(fresh);
      /* And the name lands with it, after the seal for the same reason the
       * stamp does: a keyring that could not be stored is a creation that did
       * not happen, and its name must not outlive it. */
      settleWalletName(fresh, walletName);
      setPhase({ name: 'unlocked', identity: identityFromSecret(fresh), secret: fresh });
    } catch (e) {
      /* Storage failures are STATES here too: a damaged passkey
       * record or a browser refusing IndexedDB is not something a retry
       * clears, and the broken screen is where the doors are. */
      if (e instanceof StorageError) {
        setPhase({ name: 'broken', message: e.message });
      } else {
        setError(describeFailure(e));
      }
    } finally {
      setBusy(null);
    }
  }, [challenges]);

  const unlock = useCallback(async (options?: { onlyTheOpenWallet?: boolean }) => {
    setBusy('Waiting for your passkey…');
    setError(null);
    try {
      /* Read before the first `await`, so the passkeys offered belong to the
       * wallet the press switched to, not whichever one another window has
       * turned to since. A damaged passkey record throws `StorageError` here,
       * which lands on the broken screen below like every other read. */
      const allow = options?.onlyTheOpenWallet
        ? allPasskeys(openWalletId()).map((p) => p.credentialId)
        : undefined;
      const challenge = await challenges.issue('sign-in');
      const assertion = await usePasskey({ rpId: RP_ID, challenge, ...(allow ? { allow } : {}) });
      if (!(await challenges.take(challenge, 'sign-in'))) {
        throw new Error('that took too long and the challenge expired. Try again.');
      }
      /**
       * **THE CHOSEN CREDENTIAL IS WHAT DECIDES WHICH WALLET OPENS.**
       *
       * The browser's chooser offers every credential for this ORIGIN, and
       * this origin now holds several wallets, so `passkeyById` — which asks
       * one compartment — could not answer. `walletOfCredential` asks all of
       * them and returns the compartment the chosen credential belongs to.
       * This is also what makes SWITCHING work with no second ceremony: the
       * person picks a passkey and the wallet behind it opens.
       */
      const owner = walletOfCredential(assertion.credentialId);
      if (!owner) {
        /* THE PASSKEY-WITH-NO-WALLET STATE, ALREADY SEEN IN THE WILD. A
         * password manager keeps offering a credential long after this
         * browser's storage stopped knowing about it — a cleared profile, a
         * wallet removed from here. The refusal has to say what this browser
         * DOES hold, or the person is left pressing the same button. */
        throw new Error(
          'that passkey does not open any wallet in this browser. '
          + describeWhatIsHeld()
          + ' If the wallet was made or kept somewhere else, this machine needs it '
          + 'moved onto it first — from your recovery pieces, or from the device '
          + 'that has it.');
      }
      const result = await verifyAssertion(assertion, owner.passkey, {
        rpId: RP_ID, origin: ORIGIN, challenge, allowFramedBy: FRAMED_BY,
      });
      /* The sign counter moved; not saving it would switch off the clone
       * detector, silently — `ports.ts`, PasskeyStore. The compartment is
       * named rather than assumed: the wallet being opened is not necessarily
       * the one this window had open a moment ago. */
      savePasskey(result.passkey, owner.walletId);
      openWallet(owner.walletId);

      const held = await loadSecret(owner.walletId);
      if (!held) {
        throw new Error('this browser has no account stored.');
      }
      setPhase({ name: 'unlocked', identity: identityFromSecret(held), secret: held });
    } catch (e) {
      /* `storage.ts` throws a NAMED error for stored state nothing can open —
       * a gone sealing key, a damaged record. That is not a retryable failure,
       * it is a state, and it gets a screen rather than a red line. The check
       * is the error's TYPE, never its sentence. */
      if (e instanceof StorageError) {
        setPhase({ name: 'broken', message: e.message });
      } else {
        setError(describeFailure(e));
      }
    } finally {
      setBusy(null);
    }
  }, [challenges]);

  /**
   * The replacement-passkey door — from `account-no-passkey` (record absent
   * or damaged) and as a secondary act from `locked` (the credential
   * itself deleted from a platform keychain, an ordinary event).
   * §7.13 is the decision that allows it, and its condition.
   *
   * THE ORDER IS THE FIX: the sealed copy is OPENED FIRST, before
   * any ceremony runs or anything is written — so a wallet that cannot
   * actually be opened mints no credential and the person meets the true
   * state instead of buying a stray credential with a biometric. Only after
   * the ceremony verifies is the store touched: appended to when it is
   * healthy, replaced when the person pressed "discard the damaged record".
   */
  const adoptPasskey = useCallback(async () => {
    setBusy('Waiting for your passkey…');
    setError(null);
    try {
      /* Captured before the first `await`, and used by everything
       * below it. The ceremony in the middle of this function can take as
       * long as a person takes to find their finger, and the record written
       * afterwards belongs to the wallet that was OPENED, not to whichever
       * one another window has turned to since. */
      const here = openWalletId();
      const held = await loadSecret(here);
      if (!held) {
        setPhase(derivePhase());
        throw new Error('there is no stored account here after all — the state changed. '
          + 'This screen has been refreshed; see what this browser now holds.');
      }

      let existing: readonly string[] = [];
      let recordDamaged = false;
      try {
        /* From `locked` there ARE records, and the ceremony requires naming them.
         * This compartment's, which is the wallet being opened. */
        existing = allPasskeys(here).map((p) => p.credentialId);
      } catch (e) {
        if (e instanceof StorageError) recordDamaged = true;
        else throw e;
      }

      const challenge = await challenges.issue('register');
      const handle = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
      /* NOT ASKED FOR — READ. The wallet is already here and already named or
       * deliberately not; `walletNameOf` is fingerprint-checked against the
       * secret this very ceremony is about to open, so the chooser can only
       * ever be told THIS wallet's name. Nothing is written on this path. */
      const name = credentialLabel(walletNameOf(held), 'new passkey');
      const registration = await createPasskey({
        rpId: RP_ID,
        rpName: RP_NAME,
        challenge,
        person: { id: handle, name, displayName: name },
        existing,
      });
      if (!(await challenges.take(challenge, 'register'))) {
        throw new Error('that took too long and the challenge expired. Try again.');
      }
      const verified = await verifyRegistration(registration, {
        rpId: RP_ID, origin: ORIGIN, challenge,
      });
      /* The promise on the screen has been kept — the account opened — so
       * now, and only now, the record is written. Replacing a damaged store
       * is the door the person pressed, not a silent repair. */
      if (recordDamaged) resetPasskeyRecordTo(verified, here);
      else savePasskey(verified, here);

      setPhase({ name: 'unlocked', identity: identityFromSecret(held), secret: held });
    } catch (e) {
      if (e instanceof StorageError) {
        setPhase({ name: 'broken', message: e.message });
      } else {
        setError(describeFailure(e));
      }
    } finally {
      setBusy(null);
    }
  }, [challenges]);

  /**
   * passkey-no-account: a new wallet. NOTHING IS FORGOTTEN UNTIL THE NEW
   * SECRET HAS LANDED: the old order deleted the piece map, then
   * opened the one prompt everybody cancels at least once. The stale
   * credential is kept out of the ceremony's way by an EMPTY exclude list —
   * the fresh user handle cannot collide with it — not by deleting first.
   * The map, the only irreplaceable value in the stale state, goes last.
   */
  const startFresh = useCallback(async (walletName?: string) => {
    setBusy('Waiting for your passkey…');
    setError(null);
    try {
      /* The same guard as `createAccount`, and it is not redundant: this
       * screen says *these credentials have nothing behind them*, and this is
       * the path that goes on to replace the passkey record and forget the
       * piece map. If a wallet has arrived since that sentence was drawn, the
       * sentence is false and the press is an answer to a stale question. */
      const moved = theWorldMovedSince(drawnFor.current ?? []);
      if (moved !== null) {
        setPhase(derivePhase());
        throw new Error(moved);
      }
      const challenge = await challenges.issue('register');
      const handle = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
      /* A NEW wallet, so the given name and nothing else — the record on disk
       * belongs to the wallet this is replacing and would be its name. */
      const name = credentialLabel(walletName ?? null, 'fresh start');
      const registration = await createPasskey({
        rpId: RP_ID,
        rpName: RP_NAME,
        challenge,
        person: { id: handle, name, displayName: name },
        existing: [],
      });
      if (!(await challenges.take(challenge, 'register'))) {
        throw new Error('that took too long and the challenge expired. Try again.');
      }
      const verified = await verifyRegistration(registration, {
        rpId: RP_ID, origin: ORIGIN, challenge,
      });

      /* THE SECOND AND LAST PLACE A SECRET IS BORN. Same rule as
       * `createAccount`: the stamp is on the value `newSecret()` returned, and
       * it is written after the seal. */
      const fresh = newSecret();
      /* The compartment the seal chose, carried to everything after
       * it. That order is what makes this the ONLY safe source: the stale
       * records being replaced below are the ones in the compartment the new
       * wallet just landed in, and nothing else's. */
      const walletId = await saveSecret(fresh);
      saveCreation(fresh);
      /* Settled AFTER the seal, like the stamp — and this call is also what
       * clears the REPLACED wallet's name when no new one was given. */
      settleWalletName(fresh, walletName);
      /* The new wallet exists. Only now are the stale records replaced, and
       * the map — deliberately last — removed. */
      resetPasskeyRecordTo(verified, walletId);
      forgetSecuredSetup(walletId);
      setPhase({ name: 'unlocked', identity: identityFromSecret(fresh), secret: fresh });
    } catch (e) {
      if (e instanceof StorageError) {
        setPhase({ name: 'broken', message: e.message });
      } else {
        setError(describeFailure(e));
      }
    } finally {
      setBusy(null);
    }
  }, [challenges]);

  const [recovery, setRecovery] = useState<RecoverySession | null>(null);

  const offerRecoveryPiece = useCallback((text: string, holder: string) => {
    setError(null);
    try {
      const bytes = fromBase64Url(text.replace(/\s+/g, ''));
      const now = Date.now();
      /* The same normalisation `offerPiece` replaces by — so "replaced" here
       * is true exactly when the library replaced. */
      const replaced = recovery?.gathered.find(
        (p) => p.holder.trim().toLowerCase() === holder.trim().toLowerCase())?.holder ?? null;
      /* The threshold given here is a floor; `offerPiece` reads the real one
       * off the pieces themselves and holds them to agreeing — that is the
       * door, not somebody's memory. */
      const base = recovery ?? startRecovery({ id: 'this-browser', threshold: 2, now });
      setRecovery(offerPiece(base, { holder, bytes }, now));
      return { ok: true, replaced };
    } catch (e) {
      setError(describeFailure(e));
      return { ok: false, replaced: null };
    }
  }, [recovery]);

  const withdrawRecoveryPiece = useCallback((holder: string) => {
    if (!recovery) return;
    setError(null);
    try {
      setRecovery(withdrawPiece(recovery, holder, Date.now()));
    } catch (e) {
      setError(describeFailure(e));
    }
  }, [recovery]);

  /**
   * Finish: rebuild, LAND THE ACCOUNT, then run the gate ceremony. The order
   * is the safety: if the ceremony is cancelled the account is already sealed
   * on this machine and `derivePhase` shows the account-no-passkey doorway —
   * never a recovered secret lost to a misread fingerprint.
   *
   * THE LANDING ITSELF DOES THREE THINGS, IN THIS ORDER:
   *
   *   1. Seal the recovered secret (`saveSecret`).
   *   2. Remove the old passkey record: every credential on it gates
   *      the account this landing just replaced. Left in place, a cancelled
   *      ceremony dropped the person to `locked` behind the OLD credential —
   *      the doorway only ever appeared in an empty browser.
   *   3. Write the secured record from the pieces that were just used
   *      (§7.15): a completed recovery is §7.12's dated fact at full
   *      strength — threshold-many real pieces, fetched from their real
   *      homes, checked against the secret's own fingerprint — so it is
   *      written through the same evidence-carrying writer as the wizard's,
   *      marked PARTIAL because only the pieces that were used are known.
   *      If the evidence does not stand up (a stray extra piece fails the
   *      re-prove), no record is written and home says it does not know —
   *      §7.15's third state — never that the money is gone.
   *
   * Only then the ceremony. On success the new credential is saved into the
   * now-empty record.
   */
  const finishRecovery = useCallback(async (walletName?: string) => {
    if (!recovery) return;
    setBusy('Waiting for your passkey…');
    setError(null);
    try {
      /* Captured BEFORE completing: the completed session has dropped its
       * pieces, and the secured record needs to name what was used. */
      const used = recovery.gathered;
      const done = await completeRecovery(recovery, Date.now());
      /* THE SESSION IS NOT MARKED COMPLETED UNTIL THE SECRET IS SAFELY DOWN
       * Announcing completion first meant a browser that could not
       * store showed "rebuilt and sealed on this machine" over nothing, and
       * a retry met "this recovery is already completed". If `saveSecret`
       * throws, the session stays ready, the failure lands on this screen's
       * own error line, and the same press can be tried again. */
      /* The compartment the recovered wallet landed in. The rule
       * removes a passkey record, so naming the wrong one would retire the
       * credentials of a wallet this recovery never touched. */
      const walletId = await saveSecret(done.secret);
      setRecovery(done.session);
      forgetAllPasskeys(walletId);
      /* The name is settled between the landing and the ceremony, because the
       * ceremony is what carries it into the chooser and the landing is what
       * makes it this browser's to keep. */
      const named = settleWalletName(done.secret, walletName);
      try {
        const set: PieceSet = {
          threshold: done.session.threshold,
          fingerprint: readPieceHeader(used[0]!.bytes).fingerprint,
          setId: readPieceHeader(used[0]!.bytes).setId,
          pieces: used.map((piece) => ({
            /* Holders exactly as the person named them — §7.15. */
            placement: { label: piece.holder, holder: piece.holder },
            bytes: piece.bytes,
          })),
        };
        await saveSecuredSetup(
          done.secret, set,
          Object.fromEntries(used.map((piece) => [piece.holder, Date.now()])),
          { partial: true });
      } catch {
        /* The writer refused to stand behind the record. The account is still
         * safely landed; home shows the does-not-know state, not a false
         * notice and not a false tick. */
      }
      try {
        const challenge = await challenges.issue('register');
        const handle = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
        const name = credentialLabel(named, 'recovered');
        const registration = await createPasskey({
          rpId: RP_ID,
          rpName: RP_NAME,
          challenge,
          person: { id: handle, name, displayName: name },
          /* EMPTY, and safe ONLY because the handle is sixteen fresh random
           * bytes — see `finishPairing`'s identical list. */
          existing: [],
        });
        if (!(await challenges.take(challenge, 'register'))) {
          throw new Error('that took too long and the challenge expired. Try again.');
        }
        const verified = await verifyRegistration(registration, {
          rpId: RP_ID, origin: ORIGIN, challenge,
        });
        savePasskey(verified, walletId);
        setPhase({ name: 'unlocked', identity: identityFromSecret(done.secret), secret: done.secret });
      } catch (ceremonyFailure) {
        /* The account landed and the old record is gone, so this is the
         * account-no-passkey doorway in EVERY browser — and the
         * completed screen states the ceremony's failure as its own fact,
         * with this error shown verbatim. */
        setPhase(derivePhase());
        throw ceremonyFailure;
      }
    } catch (e) {
      if (e instanceof StorageError) {
        /* The landing screen states its own failure. Flipping the
         * whole window to `broken` was worthless here — the recovery and
         * pairing routes are exactly the ones excluded from the broken
         * redirect, so the one route that would show it never rendered it,
         * and the person saw nothing at all. The message lands on THIS
         * screen's error line, verbatim; the phase is re-derived from what
         * storage actually holds. */
        setError(e.message);
        setPhase(derivePhase());
      } else {
        setError(describeFailure(e));
      }
    } finally {
      setBusy(null);
    }
  }, [recovery, challenges]);

  const abandonRecovery = useCallback(() => {
    if (!recovery) return;
    setError(null);
    try {
      setRecovery(cancelRecovery(recovery, 'stopped on this device'));
    } catch (e) {
      setError(describeFailure(e));
    }
  }, [recovery]);

  const resetRecovery = useCallback(() => {
    setError(null);
    setRecovery(null);
  }, []);

  const [paired, setPaired] = useState(false);

  const finishPairing = useCallback(async (
    secret: Secret, walletName?: string,
  ): Promise<boolean> => {
    setBusy('Waiting for your passkey…');
    setError(null);
    let landed = false;
    try {
      /* As `finishRecovery`: the compartment the seal chose, carried
       * to the record retirement and the ceremony below it. */
      const walletId = await saveSecret(secret);
      landed = true;
      /* The landing retires the old record — same rule, same reason as the
       * recovery landing — and writes the durable arrival fact
       * (§7.15's third state): this account arrived from another device on
       * this date. The pairing itself is that evidence at full strength; it
       * says nothing about pieces, so it is never a tick. */
      forgetAllPasskeys(walletId);
      saveArrival(secret);
      /* Same settlement as the recovery landing, and the same three cases:
       * what was typed, else this browser's own record for THIS secret (a
       * machine re-pairing a wallet it already had), else none. */
      const named = settleWalletName(secret, walletName);
      setPaired(true);
      try {
        const challenge = await challenges.issue('register');
        const handle = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
        const name = credentialLabel(named, 'paired');
        const registration = await createPasskey({
          rpId: RP_ID,
          rpName: RP_NAME,
          challenge,
          person: { id: handle, name, displayName: name },
          /* EMPTY, and safe ONLY because the handle above is sixteen fresh
           * random bytes: an authenticator asked for a second
           * credential under a handle it already knows silently destroys
           * the first, and the old record has just been retired, so nothing
           * would even say what was lost. If the handle ever becomes
           * deterministic, this list must name every known credential. */
          existing: [],
        });
        if (!(await challenges.take(challenge, 'register'))) {
          throw new Error('that took too long and the challenge expired. Try again.');
        }
        const verified = await verifyRegistration(registration, {
          rpId: RP_ID, origin: ORIGIN, challenge,
        });
        savePasskey(verified, walletId);
        setPhase({ name: 'unlocked', identity: identityFromSecret(secret), secret });
      } catch (ceremonyFailure) {
        /* Landed, doorway, told — the pairing screen states the ceremony's
         * outcome as its own fact, with this error verbatim. */
        setPhase(derivePhase());
        throw ceremonyFailure;
      }
    } catch (e) {
      if (e instanceof StorageError) {
        /* This screen states its own landing failure — the broken
         * redirect excludes this route, so a phase flip here was silence.
         * The storage's sentence lands on the error line, verbatim. */
        setError(e.message);
        setPhase(derivePhase());
      } else {
        setError(describeFailure(e));
      }
    } finally {
      setBusy(null);
    }
    return landed;
  }, [challenges]);

  const lock = useCallback(() => {
    setError(null);
    setPhase(derivePhase());
  }, []);

  /**
   * REMOVE. The order is the safety and it is the opposite of the landing order:
   * there is nothing being built here, so the records go first and the key
   * that opens them goes last. An interrupted removal leaves a wallet that
   * cannot be opened, never a key with nothing to open — and the pieces are
   * what bring back either.
   *
   * **THE GUARD THAT IS NOT IN THIS FUNCTION IS THE ONE THAT MATTERS**, and
   * it is worth naming here because it is a decision rather than an omission:
   * the only surfaces that call this remove the wallet THIS WINDOW HAS OPEN.
   * There is no control anywhere for removing one of the others. So removing
   * a wallet costs its passkey first — you cannot destroy what you could not
   * open — and a mis-aimed press on a list of four names cannot exist.
   */
  const removeWallet = useCallback((walletId: string) => {
    setError(null);
    /*
     * **AND THE DETAILS THIS WALLET SAVED ABOUT ITS OWNER.** They are kept under
     * a name worked out from this wallet's keys, so only an open wallet can find
     * its own - which the wallet this window has open is, and which is the only
     * wallet anything here removes. Another wallet's details are not touched.
     * Clearing them waits on nothing below, and a failure to is said.
     */
    if (phase.name === 'unlocked' && walletId === openWalletId()) {
      void forgetProfile(browserPort(), phase.identity).catch(() => {
        setError('This wallet was removed, and the details it saved about you in this browser '
          + 'could not be cleared.');
      });
    }
    forgetEverything(walletId);
    forgetSealingKey(walletId);
    setPhase(derivePhase());
  }, [phase]);

  /**
   * FORGET THIS WALLET — the same act as `removeWallet`, on the wallet this
   * window has open, and now literally the same code.
   *
   * IT USED TO MEAN "forget this browser", because a browser held one
   * wallet and the two sentences were the same sentence. They are not any
   * more: the other wallets here are untouched, and every screen that offers
   * this says so. The sealing key goes with it, which `forgetEverything`
   * alone never did — a wallet that is gone should not leave the key that
   * opened it behind.
   */
  const startOver = useCallback(() => {
    removeWallet(openWalletId());
  }, [removeWallet]);

  /**
   * SWITCH. Point this window at another compartment and re-derive: the
   * chosen wallet is locked, because every wallet this browser holds is
   * locked until its own passkey opens it, and the one that WAS unlocked has
   * just had its keys dropped by leaving the `unlocked` phase.
   */
  const switchTo = useCallback((walletId: string): Phase => {
    setError(null);
    openWallet(walletId);
    /* Derived ONCE and both stored and handed back. Deriving it a second
     * time for the caller would be two reads of storage around a state update,
     * which is the shape `shell/wallets.ts` calls a second copy of the answer.
     * Named `phaseAfter` rather than `landed`, which in this file already means
     * something else: `finishPairing`'s flag for whether a secret reached
     * storage. Nothing here lands anything. */
    const phaseAfter = derivePhase();
    setPhase(phaseAfter);
    return phaseAfter;
  }, []);

  /**
   * The list, re-derived whenever anything moves. It is NOT a second copy of
   * the answer — `shell/wallets.ts`'s rule, applied to the outer kind of
   * wallet: the records are the truth and this reads them, so a switch, a
   * landing and a removal cannot leave two surfaces disagreeing.
   */
  const wallets = useMemo<readonly HeldWalletView[]>(() => {
    const current = openWalletId();
    return heldWallets().map((wallet) => ({
      id: wallet.id,
      name: walletNameOnRecord(wallet.id),
      current: wallet.id === current,
    }));
  }, [phase]);

  /* THE SCREEN'S CLAIM, CHECKED. `account-no-passkey` says "the
   * sealed account is intact"; existence of a parseable record cannot prove
   * the sealing key survived, and only the async open can. So entering that
   * phase probes the open in the background: ciphertext that cannot be
   * opened flips to the broken screen with the true cause before — or at
   * worst, shortly after — the person reads a promise that was false. The
   * click path (`adoptPasskey`) opens-first as well, so the probe is a
   * courtesy, not the only guard. */
  useEffect(() => {
    if (phase.name !== 'account-no-passkey') return undefined;
    let stale = false;
    /* Captured where the effect starts, which is where the screen
     * this probe is about was drawn. Synchronous today; the `.then` below is
     * not, and a compartment read inside it would be whichever wallet another
     * window has turned to by the time the open answers. */
    const here = openWalletId();
    loadSecret(here).then(
      (held) => {
        if (!stale && held === null) setPhase(derivePhase());
      },
      (e: unknown) => {
        if (!stale && e instanceof StorageError) {
          setPhase({ name: 'broken', message: e.message });
        }
      },
    );
    return () => { stale = true; };
  }, [phase]);

  /* The old screenshot fixture is GONE, not merely gated: the securing
   * flow is real, so the harness drives the actual wizard and the last trace
   * of the seeding surface leaves the codebase. */

  const session = useMemo<Session>(
    () => ({
      phase,
      busy,
      error,
      createAccount,
      unlock,
      adoptPasskey,
      startFresh,
      recovery,
      offerRecoveryPiece,
      withdrawRecoveryPiece,
      finishRecovery,
      abandonRecovery,
      resetRecovery,
      finishPairing,
      paired,
      lock,
      startOver,
      wallets,
      walletId: openWalletId(),
      switchTo,
      removeWallet,
    }),
    [phase, busy, error, createAccount, unlock, adoptPasskey, startFresh, recovery,
      offerRecoveryPiece, withdrawRecoveryPiece, finishRecovery, abandonRecovery,
      resetRecovery, finishPairing, paired, lock, startOver, wallets, switchTo,
      removeWallet]);

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside SessionProvider — a bug in the shell.');
  return session;
}
