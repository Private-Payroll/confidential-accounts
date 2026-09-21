import type { DataStore } from './store.js';

/**
 * **WHICH COMPANY A PERSON MAY ASK THEIR WALLET TO OPEN — AND THE ANSWER COMES
 * FROM THE SESSION.** `docs/NEXT.md` PI2a §2, `docs/scope-payroll-identity.md`
 * §9.
 *
 * ── THE ONE DANGEROUS LINE IN THIS DESIGN, AND THIS FILE IS IT ────────────
 *
 * The wallet takes the ASKING SITE's address from the browser, so a page cannot
 * claim to be somebody else. **It cannot do that for the company.** The company
 * arrives inside the request, because there is nowhere else it could come from
 * — the wallet holds no companies — which is why it shows a fingerprint and
 * asks a person to check it before it releases anything.
 *
 * **THIS SIDE MUST NOT MAKE THAT WORSE.** The one claimed value in the whole
 * protocol is claimed by the PAGE, and the page is ours. So the page is not
 * allowed to choose it either: the account is one the session is already a
 * member of, and the address is looked up from what the ledger assigned. **A
 * caller that names its own company is not served.**
 *
 * `../../docs/scope-payroll-identity.md` §9 states the rule this implements,
 * and states why it is not a nicety: `Purposes.Seat` is keyed by a company
 * number the product assigns, and *"if payroll ever lets a caller supply that
 * number, the same attack arrives by the front door and needs no grinding at
 * all — it just asks."* Two origins were ground onto one 31-bit index in
 * eighty-one minutes to make that point the hard way.
 *
 * ── THE SHAPE OF THE RULE IS THE ARGUMENT LIST ────────────────────────────
 *
 * **THIS FUNCTION HAS NOWHERE TO PUT A CLAIMED COMPANY.** It takes a store, the
 * user the session resolved to, and the account in the path — and there is no
 * fourth parameter, in the same way `unlockKeyFor` in the wallet has no third.
 * A rule expressed as a missing parameter cannot be forgotten by a caller;
 * a deliberate defect that adds one back adds it at the route, which is
 * the only place it could be added, and names the test that dies.
 *
 * ── AND THE MEMBERSHIP CHECK IS MADE HERE TOO, DELIBERATELY ───────────────
 *
 * The route already goes through the `member` middleware. This checks again,
 * for the reason the wallet's `unlock.ts` has a door of its own next to
 * `request.ts`'s: **a caller that assembled the call by hand never went through
 * the parser.** A service method that hands out a company identifier on the
 * strength of an argument it was given is one refactor away from being called
 * from somewhere with no middleware in front of it.
 */

/** Sixty-four hex characters — what a Midnight contract address is. */
const COMPANY_ADDRESS = /^[0-9a-fA-F]{64}$/u;

/**
 * **THE ONE DELIBERATE WAY PAST THE PROVENANCE REFUSAL, AND IT IS NOT A
 * PARAMETER.**
 *
 * The rule above is that this function has nowhere to put a claimed company,
 * and a fourth argument saying *serve me anyway* would be that rule undone by
 * the same door — a route one refactor away from forwarding a request field
 * into it. **An environment variable cannot arrive in a request.** It is set by
 * whoever starts the process, it is read here and nowhere else, and it is
 * greppable in one place.
 *
 * Read on every call rather than captured at import, so a test can put the
 * process in development for one assertion and out of it for the next without
 * reloading the module — and so that what it reports is what the process is
 * actually configured with rather than what it was when the file first loaded.
 *
 * `globalThis.process` is reached optionally because this file is core and
 * core runs in a browser too, where there is no `process` at all. **In a
 * browser this is always false**, which is the correct answer there: nothing in
 * a browser bundle should be waving a simulated company through.
 */
const inDevelopment = (): boolean =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.ALLOW_SIMULATED_COMPANY_ADDRESS === '1';

export type CompanyFailure =
  /** Not a member, or no such account. **The same answer for both.** */
  | 'company-not-yours'
  /** A real company of yours that has no contract, so it has no address. */
  | 'company-not-on-a-chain'
  /**
   * A real company of yours whose address **no chain ever assigned**.
   * A separate code from `company-not-on-a-chain` on purpose: that
   * one means *nothing is there*, this one means *something is there and we
   * made it up*, and only the second is a thing a developer may deliberately
   * work past.
   */
  | 'company-address-not-from-a-chain';

export class NoCompanyAddress extends Error {
  readonly code: CompanyFailure;
  constructor(code: CompanyFailure, message: string) {
    super(message);
    this.name = 'NoCompanyAddress';
    this.code = code;
  }
}

/**
 * THE COMPANY THIS SESSION MAY OPEN, NAMED BY ITS OWN ADDRESS ON THE CHAIN.
 *
 * Returns the canonical lower-case spelling, because that is what the wallet
 * derives from and what `readRelease` compares. Both sides fold before they
 * compare, so that two spellings of one company can never become two keys.
 */
export function companyForSession(
  store: DataStore, userId: string, accountId: string,
): string {
  const rec = store.getAccount(accountId);
  /*
   * ONE ANSWER FOR MISSING AND FOR NOT-YOURS, which is `member`'s rule and the
   * reason it is the same 404: anything else lets a caller enumerate account
   * ids by reading the difference.
   */
  if (!rec || !rec.memberUserIds.includes(userId)) {
    throw new NoCompanyAddress('company-not-yours', 'account not found');
  }
  const address = rec.contractAddress;
  if (typeof address !== 'string' || !COMPANY_ADDRESS.test(address)) {
    /*
     * **A REAL COMPANY WITH NO CONTRACT, AND THE HONEST ANSWER IS NO.**
     *
     * A wallet derives this company's key from its address; a company with no
     * address has no such key, and substituting anything at all — our own
     * account id, a hash of the name, a value minted here — would be minting
     * the identifier the design chose the chain's for precisely so we could
     * not. So the person is told what is missing.
     */
    throw new NoCompanyAddress(
      'company-not-on-a-chain',
      'this company is not on a chain yet, so it has no address — and the key that opens '
      + 'its records is derived from that address. Nothing can be unlocked with a wallet '
      + 'until the company has been deployed.');
  }
  /*
   * **AND AN ADDRESS NO CHAIN EVER ASSIGNED IS REFUSED TOO.**
   *
   * The check above tests the SHAPE, and `SimulatedLedger` mints that shape on
   * purpose — thirty-two random bytes spelled exactly as a contract address is
   * spelled. So the shape check passes for a company that has never been near a
   * chain, and the refusal above, which is correct and well argued, could never
   * once fire. The record now carries where its address came from, written by
   * the ledger that assigned it, and this is the line that reads it.
   *
   * **ABSENT IS NOT `'chain'`.** Every company created before the source field
   * existed has no source recorded and there is no way to establish one after
   * the fact. Reading absence as a chain's would wave through exactly the
   * records nothing can vouch for.
   *
   * **WHAT IS AT STAKE IS NOT THIS CALL.** A key derived from an invented
   * number is not wrong today — it is all test data and no company has ever
   * been deployed. It is wrong on the day one IS: either the real address
   * replaces the invented one and everything sealed under the old one stops
   * opening, or the invented one is kept for ever and the company's identity is
   * a number our own server made up, which is exactly what taking the identity
   * from the chain was chosen to avoid.
   */
  if (rec.addressSource !== 'chain' && !inDevelopment()) {
    throw new NoCompanyAddress(
      'company-address-not-from-a-chain',
      'this company has an address, but no chain gave it one — it was made up by this '
      + 'server while the company was being set up. The key that opens its records is '
      + 'derived from that address, so anything sealed under it would stop opening on the '
      + 'day the company is really deployed. Nothing will be unlocked with a wallet until '
      + 'then.');
  }
  return address.toLowerCase();
}

/**
 * **THE SAME ADDRESS, FOR SOMEBODY WHO IS NOT A MEMBER YET.** `docs/NEXT.md`
 *
 * ── WHY AN INVITEE NEEDS IT AT ALL ────────────────────────────────────────
 *
 * The key that opens an employee's payslips is `payslipKeypairFrom(companyKey)`
 * and **the wallet derives that company key from the company's own contract
 * address**. So an invitee accepting an offer has to name the company to their
 * wallet — and `companyForSession` above cannot serve them, because the whole
 * point of an invitation is that they are not on the account.
 *
 * **THE ANSWER IS NOT A SECOND KEY PATH.** It would be the wrong thing anyway:
 * a payslip key that an invitee derives one way and a member derives another
 * is a payslip that stops opening the day somebody is promoted.
 *
 * ── SO IT TRAVELS IN THE SEALED OFFER, AND HERE IS WHY THAT IS SAFE ───────
 *
 * The offer is sealed under `sha256("midnight-invite-offer:" + token)` and the
 * database holds only `sha256(token)`, so **the only party who can open it is
 * whoever holds the link, and we cannot.** Nothing new is published.
 *
 * And what travels is not a secret in the first place: **a contract address is
 * public on a chain by construction.** It is a selector, not a capability — the
 * wallet still refuses to release anything until a person approves it, on the
 * wallet's own screen, against the origin the BROWSER reported. Knowing which
 * company to ask about buys an interceptor nothing they could not read off the
 * chain.
 *
 * ── AND THE PROVENANCE GATE IS THE SAME GATE ──────────────────────────────
 *
 * `null` rather than a throw, because an invitation must still be raisable for
 * a company that is not deployed — that is every company today. What must NOT
 * happen is an invitee sealing real payslip keys under an address our own
 * server made up, so the provenance rule is exactly `companyForSession`'s and
 * the refusal reaches the invitee's screen instead of the hiring form.
 */
export function companyAddressForOffer(
  store: DataStore, accountId: string,
): string | null {
  const rec = store.getAccount(accountId);
  if (!rec) return null;
  const address = rec.contractAddress;
  if (typeof address !== 'string' || !COMPANY_ADDRESS.test(address)) return null;
  if (rec.addressSource !== 'chain' && !inDevelopment()) return null;
  return address.toLowerCase();
}
