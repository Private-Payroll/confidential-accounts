import { REQUEST_SCHEMA } from 'midnight-identity/profile/request';

/**
 * **ASKING THE WALLET FOR THE KEY THAT OPENS A COMPANY — this side's half.**
 * `docs/NEXT.md` PI2a §1, `docs/scope-payroll-identity.md` §9b.
 *
 * ── WHAT THIS FILE IS, IN ONE PARAGRAPH ───────────────────────────────────
 *
 * A password did two jobs here: it let a person in, and it made the key that
 * opened their sealed bundle. The first was replaced with a wallet sign-in and
 * the second could not be, because **a signature is not a key** and nothing
 * the wallet exported handed one out. That was reported rather than worked
 * around. The wallet side then built the missing half — a third kind of ask,
 * `unlock`, which derives a key for one company and releases it after a press
 * on the wallet's own screen. This file and `src/web/wallet-unlock.ts` are the
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
 * `companyForSession` — the session, the membership check, and the address the
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
  readonly company: string;
}

export const unlockAsk = (parts: {
  name: string; rdns: string; purpose: string;
  nonce: string; expiresAt: number; company: string;
}): UnlockAsk => Object.freeze({
  schema: REQUEST_SCHEMA,
  kind: UNLOCK_KIND,
  requester: Object.freeze({ name: parts.name, rdns: parts.rdns }),
  purpose: parts.purpose,
  nonce: parts.nonce,
  expiresAt: parts.expiresAt,
  company: parts.company,
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
 *     so the two are known to come from one wallet.
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
  readonly company?: string;
}

export const keyringAsk = (parts: {
  name: string; rdns: string; purpose: string; nonce: string; expiresAt: number;
  person: string; signedInAs: string | null; company: string | null;
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
});

/** What the person is being asked for, beside what the wallet itself says it gives. */
export const KEYRING_PURPOSE =
  'So this page can open the keys saved for you here - for every company you belong to on this '
  + 'site - on this device. They are never sent to our servers, and the key is forgotten when you '
  + 'close the tab.';

/** And when a company's key is asked for in the same answer. */
export const KEYRING_AND_COMPANY_PURPOSE =
  'So this page can open the keys saved for you here and work out your payslip key for this '
  + 'company, on this device. Neither is sent to our servers, and both are forgotten when you '
  + 'close the tab.';
