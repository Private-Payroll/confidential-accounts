import { readKeyringRelease, readRelease } from 'midnight-identity/profile/unlock';
import type { HeldScope, KeyringHandedIn, KeysRead, ReleaseFailure, SealedKeyring, WalletIndexer } from 'midnight-identity/profile/unlock';
import type { FoundingAsked, ServedHandedIn, TidyAsked } from 'midnight-identity/profile/request';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { toHex, randomBytes } from '../../../src/core/crypto.js';
import {
  KEYRING_AND_COMPANY_PURPOSE, KEYRING_AND_NEW_COMPANY_PURPOSE, KEYRING_AND_OPENED_COMPANY_PURPOSE, KEYRING_PURPOSE, UNLOCK_PURPOSE, UNLOCK_WINDOW_MS,
  keyringAsk, unlockAsk,
} from '../../../src/core/wallet-unlock.js';
import { askWallet, type Openable, type WalletDialog } from './wallet-sign-in.js';

/**
 * **OPENING THE WALLET AND ASKING IT TO RELEASE ONE COMPANY'S KEY.**
 *
 * ── THE ONE PLACE IN THIS PRODUCT THAT RECEIVES A SECRET ON THE WIRE ──────
 *
 * A sign-in response is a signature: it proves something and gives nothing
 * away, so this side forwards it to the service unjudged and the service decides.
 * **A release is a key.** It arrives in this tab, it is used in this tab, and
 * it goes nowhere else — so there is no service to defer to and the checking has
 * to happen here.
 *
 * That is `readRelease`, and it is imported from the wallet's own package
 * rather than reimplemented, for the reason `verify` is imported: the code
 * payroll runs should be the code the wallet's own tests check, not a
 * description of it. It reads **none of its three expectations out of the message** — the
 * origin is ours, the nonce is the one this function generated, and the company
 * is the one this page asked about — because a value that agrees with itself is
 * what a forged one looks like.
 *
 * ── THE NONCE IS THIS PAGE'S OWN, AND IT IS NOT THE SERVICE'S ─────────────
 *
 * A sign-in nonce comes from the service, because the service is the party that
 * has to be sure the answer is fresh. **Nothing about a release reaches the
 * service**, so a service-issued nonce here would be a round trip that proves
 * nothing to anybody, and would put a value belonging to one conversation into
 * another party's hands. It is generated here and compared here.
 *
 * ── WHAT THIS FUNCTION RETURNS, AND WHAT IT DELIBERATELY DOES NOT DO ──────
 *
 * It returns thirty-two bytes and nothing else — not the message, not the
 * wallet's clock reading, not the origin it echoed. **Nothing here logs, stores
 * or transmits the key**, and the caller (`keyring.ts`) keeps it in a module
 * variable for the life of the tab and nowhere else. A reload asks the wallet
 * again.
 */

export type UnlockFailure = ReleaseFailure | 'person-mismatch' | 'wallet-refused';

export class UnlockRefused extends Error {
  readonly code: UnlockFailure;
  constructor(code: UnlockFailure, message: string) {
    super(message);
    this.name = 'UnlockRefused';
    this.code = code;
  }
}

export interface UnlockAsked {
  /** The company's label, from `POST /api/accounts/:id/unlock`. **Never from anything a caller sent.** */
  readonly company: CompanyLabel;
  /** The account that carries it, from the same answer, or null when there is none yet. */
  readonly account: AccountAddress | null;
  /** This page's own origin, as the browser knows it. Not a value we were sent. */
  readonly atOrigin: string;
  /** The requester's own words about itself. Untrusted by the wallet, shown as text. */
  readonly name: string;
  readonly rdns: string;
  /** Injectable so a test can drive the whole conversation with no browser. */
  readonly now?: () => number;
  readonly nonce?: string;
}

/**
 * ASK ONCE, TAKE ONE ANSWER, CHECK IT AGAINST WHAT WE OURSELVES CHOSE.
 *
 * `view` is the window rather than a global so the conversation can be driven
 * in a test — the wallet's own `channel.ts` is shaped the same way and for the
 * same reason.
 */
export async function askWalletToUnlock(
  view: Openable, walletOrigin: string, ask: UnlockAsked, dialog?: WalletDialog,
): Promise<Uint8Array> {
  return (await askWalletToUnlockAndWhereItReads(view, walletOrigin, ask, dialog)).key;
}

/**
 * What the wallet said about the addresses it holds: its digests, and the ask
 * they were taken under - this page's own nonce, its own origin and the company
 * it asked about. Tested with `listHolds`.
 */
interface HeldAddresses {
  readonly scope: HeldScope;
  readonly digests: readonly string[];
}

/**
 * `askWalletToUnlock`, plus two things the wallet may say with the key: the
 * indexer it reads the chain through (public, used to read a contract on this
 * device), and digests of the addresses it holds, which this page can test an
 * address it already has against and cannot read an address out of. Each is
 * `null` when the wallet did not say.
 */
export async function askWalletToUnlockAndWhereItReads(
  view: Openable, walletOrigin: string, ask: UnlockAsked, dialog?: WalletDialog,
): Promise<{ key: Uint8Array; indexer: WalletIndexer | null; held: HeldAddresses | null }> {
  const now = ask.now ?? (() => Date.now());
  /* Sixteen random bytes. It ties one answer to one question and is not a
   * secret; it is generated here because nobody else is a party to it. */
  const nonce = ask.nonce ?? toHex(randomBytes(16));

  const answer = await askWallet(view, walletOrigin, unlockAsk({
    name: ask.name,
    rdns: ask.rdns,
    purpose: UNLOCK_PURPOSE,
    nonce,
    expiresAt: now() + UNLOCK_WINDOW_MS,
    company: ask.company,
    account: ask.account,
  }), dialog);

  /*
   * **THREE EXPECTATIONS, ALL THREE OURS.** `atOrigin` is where this page is
   * running, `expectingNonce` is what we just generated, `forCompany` is what
   * this page asked about. A release that answers a different origin, a different
   * question or a DIFFERENT COMPANY is refused rather than used — the last of
   * those is the one only this side can catch, and using the wrong company's
   * key would seal records nobody can open again.
   */
  const read = readRelease(answer, {
    atOrigin: ask.atOrigin,
    expectingNonce: nonce,
    forCompany: ask.company,
    forAccount: ask.account,
  });
  if (read.ok === false) throw new UnlockRefused(read.code, read.says);
  return {
    key: read.key, indexer: read.indexer,
    held: read.held === null ? null : Object.freeze({
      scope: Object.freeze({ nonce, origin: ask.atOrigin, company: ask.company }), digests: read.held,
    }),
  };
}

export interface KeyringAsked {
  /** From this tab's own sign-in: the id the service gave the signed-in person. */
  readonly person: string;
  /** From this tab's own sign-in answer, or null when this tab does not know it. */
  readonly signedInAs: string | null;
  /**
   * The label of a company whose key is wanted too, from `POST /api/accounts/:id/unlock`;
   * `'new'` when this page is starting a company and the wallet is to draw its label; else null.
   */
  readonly company: CompanyLabel | 'new' | null;
  /** The account that carries that label, from the same answer, or null. */
  readonly account: AccountAddress | null;
  readonly atOrigin: string;
  readonly name: string;
  readonly rdns: string;
  readonly now?: () => number;
  readonly nonce?: string;
  /** With `company: 'new'`: what the new company is founded with, and the saved keys the wallet writes its seat into. */
  readonly founding?: { readonly asked: FoundingAsked; readonly keyring: KeyringHandedIn };
  /**
   * The saved keys as the service holds them, each listed company's viewing key wrapped to its seats, and the
   * creation changes this page asks for: the wallet opens the saved keys itself and answers with what they hold that
   * is not secret (`read`). With a founding, the founding's saved keys are these.
   */
  readonly keys?: { readonly keyring: KeyringHandedIn; readonly served: readonly ServedHandedIn[]; readonly tidy: readonly TidyAsked[] };
  /**
   * With a named company and `keys`: the company is the one the person opened, named beside opening the saved keys.
   * The wallet gives its key only when its own read of the chain confirms it; an answer giving none is then the saved
   * keys opened alone, with no company key.
   */
  readonly companyIfOnChain?: boolean;
}

/**
 * **ASK THE WALLET ONCE TO READ THE KEYS SAVED FOR THIS PERSON**, and for a
 * company's key with it when one is named. No key the saved keys open with
 * comes back: an answer carrying one is refused. Every expectation the answer is
 * checked against is this page's own - `readKeyringRelease` says what those
 * comparisons prove and what they do not. When the ask starts a company, the
 * answer also gives what the wallet founded it with and the saved keys it sealed
 * again with the founding seat in them, and an answer without them is refused;
 * otherwise `founding` is null. The founding seat's keys never cross. When the
 * ask hands the saved keys in (`keys`, or a founding), the answer must also say
 * what the wallet read from them (`read`: no secret), or it is refused. The
 * page uses that read, and never the key, to know the seats it holds.
 */
export async function askWalletForKeys(
  view: Openable, walletOrigin: string, ask: KeyringAsked, dialog?: WalletDialog,
): Promise<{
  companyKey: Uint8Array | null;
  /** Public: the key the person sits on this company's vault committee with. */
  committeeKey: { tag: string; value: string } | null;
  /** The company the keys are for: the one asked about, or the one the wallet drew. */
  company: CompanyLabel | null;
  /** What the wallet founded a new company with, and the saved keys it sealed again with the seat in them; null for any other ask. */
  founding: { founded: Readonly<Record<string, unknown>>; sealed: SealedKeyring; ifVersion: number } | null;
  /** What the wallet read from the saved keys this page handed in: nothing secret. */
  read: KeysRead | null;
}> {
  const now = ask.now ?? (() => Date.now());
  const nonce = ask.nonce ?? toHex(randomBytes(16));
  const opened = ask.companyIfOnChain === true && ask.company !== null && ask.company !== 'new' && ask.account !== null
    && ask.keys !== undefined;
  const answer = await askWallet(view, walletOrigin, keyringAsk({
    name: ask.name,
    rdns: ask.rdns,
    purpose: ask.company === null ? KEYRING_PURPOSE
      : ask.company === 'new' ? KEYRING_AND_NEW_COMPANY_PURPOSE
        : opened ? KEYRING_AND_OPENED_COMPANY_PURPOSE : KEYRING_AND_COMPANY_PURPOSE,
    nonce,
    expiresAt: now() + UNLOCK_WINDOW_MS,
    person: ask.person,
    signedInAs: ask.signedInAs,
    company: ask.company === 'new' ? null : ask.company,
    account: ask.company === 'new' ? null : ask.account,
    drawLabel: ask.company === 'new',
    ...(opened ? { companyIfOnChain: true } : {}),
    ...(ask.company === 'new' && ask.founding !== undefined ? { founding: ask.founding } : {}),
    ...(ask.company !== 'new' && ask.keys !== undefined ? { keys: ask.keys } : {}),
  }), dialog);
  const { atOrigin, person, signedInAs, company } = ask;
  const checked = readKeyringRelease(answer, {
    atOrigin, expectingNonce: nonce, person, signedInAs,
    forCompany: company === 'new' ? 'drawn' : company,
    forAccount: company === 'new' ? null : ask.account,
    handedIn: ask.keys !== undefined || ask.founding !== undefined,
    companyIfOnChain: opened,
  });
  if (checked.ok === false) throw new UnlockRefused(checked.code, checked.says);
  return {
    companyKey: checked.companyKey, committeeKey: checked.committeeKey, company: checked.company,
    founding: checked.founding, read: checked.read,
  };
}
