import { REQUEST_SCHEMA } from 'midnight-identity/profile/request';
import type { FoundingAsked, ServedHandedIn, TidyAsked } from 'midnight-identity/profile/request';
import type { KeyringHandedIn } from 'midnight-identity/profile/unlock';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';

/**
 * **ASKING THE WALLET FOR THE KEY THAT OPENS A COMPANY — this side's half.**
 *
 * ── WHAT THIS FILE IS, IN ONE PARAGRAPH ───────────────────────────────────
 *
 * A password did two jobs here: it let a person in, and it made the key that
 * opened their sealed bundle. The first was replaced with a wallet sign-in and
 * the second could not be, because **a signature is not a key** and nothing
 * the wallet exported handed one out. That was reported rather than worked
 * around. The wallet side then built the missing half — a third kind of ask,
 * `unlock`, which derives a key for one company and releases it after a press
 * on the wallet's own screen. This file and `packages/web-shared/src/wallet-unlock.ts` are the
 * other end of it.
 *
 * ── THE ASK CARRIES NO ORIGIN AND NO ATTRIBUTES, AND HAS NOWHERE TO PUT ONE ─
 *
 * The same shape as `signInAsk` and for the same reasons — the wallet refuses
 * either by name rather than ignoring it:
 *
 *   · **no `origin`.** A requester that can name its own origin can name
 *     somebody else's. The wallet takes it from `MessageEvent.origin`.
 *   · **no `wants`.** An unlock is not a disclosure that also hands over a key;
 *     the wallet refuses an unlock carrying attributes as
 *     `attributes-on-an-unlock`, because a screen that says both things at once
 *     is a screen nobody reads correctly.
 *
 * So the builder has a parameter for neither.
 *
 * ── AND `company` IS THE ONE FIELD THAT IS CLAIMED ────────────────────────
 *
 * It has to be: the wallet holds no companies, so the company can only arrive
 * from whoever is asking. **That is exactly why this side must not let the
 * ASKING PAGE choose it either.** The value handed to this builder comes from
 * `companyForSession` — the sign-in, the membership check, and the address the
 * ledger assigned — and never from anything a caller sent us. That rule lives
 * in `src/core/company-address.ts`; this builder is downstream of it and simply
 * has no way to fabricate one.
 */

/** What the wallet is opened with. `midnight-identity/profile/request`. */
export const UNLOCK_KIND = 'unlock' as const;

/**
 * THE WIRE SHAPE OF AN UNLOCK, BUILT HERE SO ONE PLACE OWNS IT.
 *
 * `company` travels WHOLE — all sixty-four characters. Two origins were ground
 * onto one 31-bit index in 2.86 billion tries on a single core, and the rule
 * that demonstration bought applies to every identifier that reaches a key: **a
 * selector narrower than the thing it selects can be ground.** Nothing here
 * shortens, folds or hashes the address.
 */
export interface UnlockAsk {
  readonly schema: typeof REQUEST_SCHEMA;
  readonly kind: typeof UNLOCK_KIND;
  readonly requester: { readonly name: string; readonly rdns: string };
  readonly purpose: string;
  readonly nonce: string;
  readonly expiresAt: number;
  /** The company's label. */
  readonly company: CompanyLabel;
  /** The account that carries it; absent for a company with no account yet. */
  readonly account?: AccountAddress;
}

export const unlockAsk = (parts: {
  name: string; rdns: string; purpose: string;
  nonce: string; expiresAt: number; company: CompanyLabel; account: AccountAddress | null;
}): UnlockAsk => Object.freeze({
  schema: REQUEST_SCHEMA,
  kind: UNLOCK_KIND,
  requester: Object.freeze({ name: parts.name, rdns: parts.rdns }),
  purpose: parts.purpose,
  nonce: parts.nonce,
  expiresAt: parts.expiresAt,
  company: parts.company,
  ...(parts.account !== null ? { account: parts.account } : {}),
});

/**
 * **WHAT THE PERSON IS BEING ASKED FOR, IN THEIR WORDS AND NOT OURS.**
 *
 * The wallet renders this as text beside the origin it observed and the company
 * it was asked about. It says what the key does and what it does not, because
 * a key is a capability for the future and — unlike a disclosure — the person
 * cannot see afterwards what was done with it.
 */
export const UNLOCK_PURPOSE =
  'So this page can open your company\'s records on this device. The key is made by your '
  + 'wallet for this one company, it is never sent to our servers, and it is forgotten '
  + 'when you close the tab.';

/** How long an unlock ask is good for. The wallet refuses an expired one. */
export const UNLOCK_WINDOW_MS = 5 * 60_000;

/**
 * **ASKING THE WALLET FOR THE KEY A PERSON'S SAVED KEYS HERE ARE SEALED UNDER.**
 *
 * A person keeps one sealed set of their own keys on this deployment - one entry
 * per company they sit on - and it belongs to the PERSON, not to any one company:
 * sealed under a company's key, it could never hold a second company's keys. So
 * it is sealed under a key the wallet derives for this person here, and this is
 * the ask for it.
 *
 *   · **`person`** is the id this deployment gave the signed-in person. It is an
 *     ingredient of the key, and it comes from the sign-in - never from a caller.
 *   · **`signedInAs`** is the wallet address this tab signed in as, taken from the
 *     server's answer to that sign-in. It is NOT an ingredient: the wallet gives
 *     the key only if one of its own accounts has exactly that address, so in a
 *     browser holding several wallets it cannot come from one other than the
 *     wallet the person signed in with. Null when this tab does not know it.
 *   · **`company`**, when present, asks for that company's key in the same answer,
 *     so the two are known to come from one wallet. It is the company's label,
 *     and **`account`** beside it is the account that carries the label, which
 *     the wallet reads for itself before it gives anything.
 *   · **`companyIfOnChain`** says that company is the one the person opened,
 *     named beside opening the saved keys: the wallet gives its key only when its
 *     own read confirms the account carries the label, and otherwise answers with
 *     the saved keys opened alone, holding nothing up.
 *   · **`drawLabel`** asks the wallet to start a company: it draws the new
 *     company's label itself and answers with it and the founding signer's keys
 *     for it. Never together with `company`.
 */
export const KEYRING_KIND = 'keyring' as const;

export interface KeyringAsk {
  readonly schema: typeof REQUEST_SCHEMA;
  readonly kind: typeof KEYRING_KIND;
  readonly requester: { readonly name: string; readonly rdns: string };
  readonly purpose: string;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly person: string;
  readonly signedInAs?: string;
  readonly company?: CompanyLabel;
  readonly account?: AccountAddress;
  readonly drawLabel?: true;
  /**
   * With `company`, `account` and the saved keys handed in: the company is named beside opening the saved keys, so the
   * wallet gives its key only when its own read of the chain shows that account carrying that label, and otherwise
   * opens the saved keys alone.
   */
  readonly companyIfOnChain?: true;
  /** With `drawLabel` only: the new company's name and founding signer. */
  readonly founding?: FoundingAsked;
  /** The saved keys as the service holds them, which the wallet opens itself; with a founding, the seat is written into them. */
  readonly keyring?: KeyringHandedIn;
  /** Each listed company's viewing key wrapped to its seats, with its inbox public key, for the wallet to open its own. */
  readonly served?: readonly ServedHandedIn[];
  /** Changes to kept creations the page asks for. */
  readonly tidy?: readonly TidyAsked[];
}

export const keyringAsk = (parts: {
  name: string; rdns: string; purpose: string; nonce: string; expiresAt: number;
  person: string; signedInAs: string | null; company: CompanyLabel | null;
  account: AccountAddress | null; drawLabel?: boolean; companyIfOnChain?: boolean;
  founding?: { readonly asked: FoundingAsked; readonly keyring: KeyringHandedIn };
  keys?: { readonly keyring: KeyringHandedIn; readonly served: readonly ServedHandedIn[]; readonly tidy: readonly TidyAsked[] };
}): KeyringAsk => Object.freeze({
  schema: REQUEST_SCHEMA,
  kind: KEYRING_KIND,
  requester: Object.freeze({ name: parts.name, rdns: parts.rdns }),
  purpose: parts.purpose,
  nonce: parts.nonce,
  expiresAt: parts.expiresAt,
  person: parts.person,
  /* Absent rather than null on the wire when unknown, so the wallet's screen can
   * say that this page does not know which address it signed in as. */
  ...(parts.signedInAs !== null ? { signedInAs: parts.signedInAs } : {}),
  ...(parts.company !== null ? { company: parts.company } : {}),
  ...(parts.account !== null ? { account: parts.account } : {}),
  ...(parts.drawLabel === true ? { drawLabel: true as const } : {}),
  ...(parts.companyIfOnChain === true && parts.company !== null && parts.drawLabel !== true ? { companyIfOnChain: true as const } : {}),
  ...(parts.drawLabel === true && parts.founding !== undefined
    ? { founding: parts.founding.asked, keyring: parts.founding.keyring } : {}),
  ...(parts.drawLabel !== true && parts.keys !== undefined
    ? { keyring: parts.keys.keyring, served: parts.keys.served, ...(parts.keys.tidy.length > 0 ? { tidy: parts.keys.tidy } : {}) } : {}),
});

/** What the person is being asked for, beside what the wallet itself says it gives. */
export const KEYRING_PURPOSE =
  'So this page can read every company you belong to on this site: your wallet opens the keys saved for you and '
  + 'gives this page the keys that read them. Your seats\' keys, and the key your saved keys open with, stay in your '
  + 'wallet.';

/** And when a company's key is asked for in the same answer. */
export const KEYRING_AND_COMPANY_PURPOSE =
  'So this page can read your companies here and work out your payslip key for this company: your wallet opens the '
  + 'keys saved for you and gives this page the keys that read them. Your seats\' keys stay in your wallet.';

/** And when the company the person opened is named beside opening the saved keys, for its vault balances. */
export const KEYRING_AND_OPENED_COMPANY_PURPOSE =
  'So this page can read every company you belong to on this site and the vault balances of the company you opened: '
  + 'your wallet opens the keys saved for you and gives this page the keys that read them. Your seats\' keys stay in your wallet.';

/**
 * And when the page is starting a company with this person as its founding
 * signer. The label is public and is sent on: it is what the company's account
 * is created with, and what every other signer's wallet works its keys out from.
 */
export const KEYRING_AND_NEW_COMPANY_PURPOSE =
  'So this page can start a new company with you as its founding signer. Your wallet makes up its label, which goes '
  + 'to our servers, and writes your new seat into your saved keys itself. Your seat\'s keys stay in your wallet.';
