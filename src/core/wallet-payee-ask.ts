import { REQUEST_SCHEMA } from 'midnight-identity/profile/request';
/*
 * **THE ATTRIBUTE'S NAME COMES FROM THE WALLET'S OWN VOCABULARY.**
 *
 * It was going to be a string literal here, on the grounds that importing the
 * registry to reach one word is what `C149` is about — but `attributes.ts`
 * imports `definition.ts` and nothing else, so it costs the page nothing, and
 * `no-wasm-in-the-page.test.ts` is what proves that rather than this comment.
 * **One spelling, owned by the side that owns the vocabulary**, so a rename
 * there is a typecheck failure here rather than a request that quietly asks for
 * nothing. This is one of the two cross-repository edges this round adds; the
 * other is the export that makes it reachable.
 */
import { RECEIVING_ADDRESS } from 'midnight-identity/profile/attributes';

/**
 * **ASKING THE WALLET WHERE TO PAY SOMEBODY — this side's half.**
 * `docs/NEXT.md` X8 §2, `docs/how-money-can-be-lost.md` `C153`,
 * `docs/scope-payroll-identity.md` §10 step 2.
 *
 * ── WHAT THIS ROUND IS, IN ONE PARAGRAPH ──────────────────────────────────
 *
 * `X7` built the screen that makes a founder payable and ran into a wall: the
 * wallet had no way to hand over a receiving address, so **the screen took one
 * as PASTED TEXT.** That was safe on that one door because the person pasting
 * and the person being paid are the same by construction — and it is a
 * precedent that must not spread to any door where they are not, which is every
 * other door money enters by. The wallet's `X8` round added the
 * attribute; this file is the ask that reaches it.
 *
 * ── IT IS A DISCLOSURE, AND NOT A KIND OF ITS OWN ─────────────────────────
 *
 * The wallet took shape (a): a receiving address is one more attribute, asked
 * for BY NAME on the surface that already approves everything leaving a wallet.
 * So this builds an ordinary `disclosure` — the same kind that has always
 * carried a first name — and the only thing that makes it about money is the
 * name in `wants`.
 *
 * ── **AND IT NEVER PROPOSES AN ADDRESS.** ─────────────────────────────────
 *
 * `packages/identity/src/profile/request.ts` refuses a request that names one, on the
 * body and on any single want, **by presence and by name**. This builder has
 * nowhere to put one: there is no parameter for an address anywhere below, and
 * a want carries exactly the three fields the wallet allows. A payer that could
 * name the address is a payer telling a payee where their own money goes.
 *
 * ── NO `origin`, FOR THE REASON THE OTHER TWO ASKS HAVE NONE ──────────────
 *
 * A requester that can name its own origin can name somebody else's. The wallet
 * takes it from `MessageEvent.origin`, and the strongest form of that rule is
 * that this type has no field for one.
 *
 * ── AND NO WASM IN THIS FILE, WHICH IS WHY IT IS ITS OWN FILE ─────────────
 *
 * It imports one constant. The thing that VERIFIES what comes
 * back is `wallet-payee.ts` beside it, which reaches the wallet SDK and must
 * never be imported from `src/web/`; `no-wasm-in-the-page.test.ts` is what
 * keeps that true rather than a convention.
 */

/** What the wallet is opened with. `midnight-identity/profile/request`. */
export const PAYEE_KIND = 'disclosure' as const;

/** Re-exported so the server half names it without a second import path. */
export { RECEIVING_ADDRESS };

export interface PayeeAsk {
  readonly schema: typeof REQUEST_SCHEMA;
  readonly kind: typeof PAYEE_KIND;
  readonly requester: { readonly name: string; readonly rdns: string };
  readonly purpose: string;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly wants: readonly {
    readonly attribute: string;
    readonly required: boolean;
    readonly reason: string;
  }[];
}

/**
 * **WHAT THE PERSON IS BEING ASKED FOR, IN THEIR WORDS AND NOT OURS.**
 *
 * The wallet renders this as text and never as markup, and it is the requester
 * saying what it wants the details FOR. It says what happens next, because the
 * thing that follows this press is a salary arriving somewhere.
 */
export const PAYEE_PURPOSE =
  'To put you on this company’s payroll, so it knows where to send your salary.';

const PAYEE_REASON =
  'Your pay is sent here. Nothing else on this company’s roster decides where it goes.';

/**
 * **THERE IS NO WINDOW CONSTANT HERE, AND THAT IS THE DECISION.**
 *
 * The unlock has one, because its nonce is generated in the page and nothing
 * but the wallet has an opinion about how long it lives. **This nonce is the
 * SERVER's challenge**, which expires on the server's own schedule
 * (`challenges.ts`), so a second number here could only ever disagree with it —
 * and the disagreement a person meets is the worst kind: their wallet approves,
 * and the deployment then refuses a value they never saw, at the end of the one
 * flow in this product that ends in money. So `expiresAt` is passed in and it
 * is the challenge's own, exactly as `signInWithWallet` already does it.
 */

export const payeeAsk = (parts: {
  name: string; rdns: string; nonce: string; expiresAt: number;
}): PayeeAsk => Object.freeze({
  schema: REQUEST_SCHEMA,
  kind: PAYEE_KIND,
  requester: Object.freeze({ name: parts.name, rdns: parts.rdns }),
  purpose: PAYEE_PURPOSE,
  nonce: parts.nonce,
  expiresAt: parts.expiresAt,
  /* ONE THING, REQUIRED, AND NO VALUE BESIDE IT. */
  wants: Object.freeze([Object.freeze({
    attribute: RECEIVING_ADDRESS, required: true, reason: PAYEE_REASON,
  })]),
});
