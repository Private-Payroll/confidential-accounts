import { REQUEST_SCHEMA } from 'midnight-identity/profile/request';

/**
 * **THE WIRE SHAPE OF A SIGN-IN ASK, AND NOTHING ELSE IN THIS FILE.**
 * `docs/NEXT.md` X5 §2, `C149`, `docs/scope-payroll-identity.md` §4.
 *
 * ── WHY THREE EXPORTS LEFT `wallet-identity.ts`, WHICH IS THE POINT OF IT ──
 *
 * They were the top of that file and moving them out is what takes **ten
 * megabytes of WebAssembly off the payroll page.**
 *
 * `wallet-identity.ts` is the SERVICE. It is constructed with a `SessionStore`,
 * a `ChallengeStore` and a `RateLimiter` — three server things — and it judges
 * signatures, so it imports `midnight-identity/profile/disclosure`, which
 * imports `@midnightntwrk/wallet-sdk-address-format`, which imports
 * `@midnightntwrk/ledger-v9`, which is WebAssembly. **The browser wanted one
 * function out of all of that**: `signInAsk`, which builds a plain object and
 * touches nothing. An import is all-or-nothing, so the page loaded the chain to
 * reach it, and the cost was a blank page in every real browser while 908 tests
 * stayed green, because tests run in Node and Node loads WebAssembly by a
 * different path than a browser does.
 *
 * ── THE RULE THIS FILE EXISTS TO KEEP ─────────────────────────────────────
 *
 * **NOTHING UNDER `src/web/` IMPORTS `wallet-identity.ts`.** It is not a style
 * preference and it is not enforced by a linter: `no-wasm-in-the-page.test.ts`
 * builds the real application through the real configuration and fails if a
 * `.wasm` asset comes out of it. That is the only kind of check that can see
 * this, because the defect it guards is invisible to every test that runs in
 * Node — including all of the ones that were green while the page was blank.
 *
 * ── IT IS THE SHAPE `wallet-unlock.ts` ALREADY HAD ────────────────────────
 *
 * `src/core/wallet-unlock.ts` is this file for the other ask: the wire shape and
 * the words, in `core/`, with `src/web/wallet-unlock.ts` as the browser plumbing
 * beside it and no service in between. **The sign-in pair was the odd one out**
 * — its ask lived inside the service — and that asymmetry is the whole defect
 * written in one sentence.
 *
 * ── AND WHY IT IS NOT CALLED `wallet-sign-in.ts` ──────────────────────────
 *
 * That is the name the symmetry asks for, and `src/core/wallet-sign-in.test.ts`
 * already has it and tests the SERVICE. A source file whose neighbouring test
 * file tests something else is a trap laid for whoever reads it next, and a
 * longer name is cheaper than that.
 */

/** What the wallet is opened with. `midnight-identity/profile/request`. */
export const SIGN_IN_KIND = 'sign-in' as const;

/**
 * THE WIRE SHAPE OF A SIGN-IN ASK, BUILT HERE SO ONE PLACE OWNS IT.
 *
 * Two fields are ABSENT rather than empty, and both absences are load-bearing
 * on the wallet's side — `packages/identity/src/profile/request.ts` refuses either by
 * name rather than ignoring it:
 *
 *   · **no `origin`.** A requester that can name its own origin can name
 *     somebody else's. The wallet takes it from `MessageEvent.origin`.
 *   · **no `wants`.** A sign-in asks one question and asks for nothing. An
 *     empty list is refused too, by presence rather than by content.
 *
 * So this builder has no parameter for either, which is the strongest form of
 * the rule: there is nowhere to put one.
 */
export interface SignInAsk {
  readonly schema: typeof REQUEST_SCHEMA;
  readonly kind: typeof SIGN_IN_KIND;
  readonly requester: { readonly name: string; readonly rdns: string };
  readonly purpose: string;
  readonly nonce: string;
  readonly expiresAt: number;
}

export const signInAsk = (parts: {
  name: string; rdns: string; purpose: string; nonce: string; expiresAt: number;
}): SignInAsk => Object.freeze({
  schema: REQUEST_SCHEMA,
  kind: SIGN_IN_KIND,
  requester: Object.freeze({ name: parts.name, rdns: parts.rdns }),
  purpose: parts.purpose,
  nonce: parts.nonce,
  expiresAt: parts.expiresAt,
});
