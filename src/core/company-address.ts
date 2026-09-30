import type { DataStore } from './store.js';
import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';

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
 * member of, and its label and account are looked up from that company's own
 * record - the label written once when the founding signer's wallet drew it,
 * the account as the ledger assigned it. **A caller that names its own company
 * is not served.**
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
  /** A real company of yours created without a label, so no wallet can derive its keys. */
  | 'company-has-no-label'
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
 * **A COMPANY AS A WALLET IS ASKED ABOUT IT: ITS LABEL, AND THE ACCOUNT THAT
 * CARRIES THE LABEL WHEN A CHAIN HAS ASSIGNED ONE.** The label is what every
 * signer's wallet derives the company's keys from. The account is where the
 * wallet reads the label back from before it gives or signs anything, and
 * `null` when the company has no account a chain assigned.
 */
export interface CompanyNamed {
  readonly label: CompanyLabel;
  readonly account: AccountAddress | null;
}

/** The account's address, when a chain assigned it (or, in development, when it was simulated), else null. */
const chainAccountOf = (rec: { contractAddress?: string | null; addressSource?: string | null }): AccountAddress | null => {
  const account = readAccountAddress(rec.contractAddress);
  if (account === null) return null;
  return rec.addressSource === 'chain' || inDevelopment() ? account : null;
};

/**
 * THE COMPANY THIS SESSION MAY OPEN: ITS LABEL, AND ITS ACCOUNT WHEN A CHAIN
 * ASSIGNED ONE.
 *
 * **A COMPANY IS UNLOCKABLE WHEN IT HAS A LABEL.** Its keys are derived from
 * the label, so they exist before the company has an account and do not depend
 * on where one is. **Every chain action needs a chain-assigned address as well,
 * and asks for it separately** (`accountForChain`), so no key is ever derived
 * from an address and no contract is ever reached through a label.
 */
export function companyForSession(
  store: DataStore, userId: string, accountId: string,
): CompanyNamed {
  const rec = store.getAccount(accountId);
  /*
   * ONE ANSWER FOR MISSING AND FOR NOT-YOURS, which is `member`'s rule and the
   * reason it is the same 404: anything else lets a caller enumerate account
   * ids by reading the difference.
   */
  if (!rec || !rec.memberUserIds.includes(userId)) {
    throw new NoCompanyAddress('company-not-yours', 'account not found');
  }
  const label = readCompanyLabel(rec.companyLabel);
  if (label === null) {
    /*
     * **A REAL COMPANY WITH NO LABEL, AND THE HONEST ANSWER IS NO.** Every key
     * a signer holds for a company is derived from its label, which the
     * founding signer's wallet drew when the company was created. Substituting
     * anything - the account's address, our own account id, a value made up
     * here - would be this service choosing which keys a wallet derives.
     */
    throw new NoCompanyAddress(
      'company-has-no-label',
      'this company was created without a label, so there is nothing a wallet can derive its keys from. '
      + 'Companies are created with the label the founding signer\'s wallet makes up; this one cannot be '
      + 'opened with a wallet.');
  }
  return { label, account: chainAccountOf(rec) };
}

/**
 * **THE ACCOUNT'S ADDRESS FOR A CHAIN ACTION, AND ONLY ONE A CHAIN ASSIGNED.**
 *
 * A label locates no contract, so every action that reaches the chain asks for
 * the account's address here and is refused, by name, when the company has
 * none a chain assigned. The two refusals keep their own codes: *nothing is
 * there*, and *something is there and this server made it up* - only the
 * second is a thing a developer may deliberately work past.
 */
export function accountForChain(store: DataStore, accountId: string): AccountAddress {
  const rec = store.getAccount(accountId);
  if (!rec) throw new NoCompanyAddress('company-not-yours', 'account not found');
  const account = readAccountAddress(rec.contractAddress);
  if (account === null) {
    throw new NoCompanyAddress(
      'company-not-on-a-chain',
      'this company is not on a chain yet, so it has no account to act on. Nothing was done.');
  }
  if (rec.addressSource !== 'chain' && !inDevelopment()) {
    throw new NoCompanyAddress(
      'company-address-not-from-a-chain',
      'this company has an address, but no chain gave it one - it was made up by this server while the '
      + 'company was being set up. Nothing was done on the chain.');
  }
  return account;
}

/**
 * **THE SAME COMPANY, FOR SOMEBODY WHO IS NOT A MEMBER YET.**
 *
 * ── WHY AN INVITEE NEEDS IT AT ALL ────────────────────────────────────────
 *
 * The key that opens an employee's payslips is `payslipKeypairFrom(companyKey)`
 * and **the wallet derives that company key from the company's label**. So an
 * invitee accepting an offer has to name the company to their wallet — and
 * `companyForSession` above cannot serve them, because the whole point of an
 * invitation is that they are not on the account.
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
 * And what travels is not a secret in the first place: **the label is public on
 * the company's account, and the account's address is on the chain.** They are
 * selectors, not capabilities — the wallet still reads the label off the account
 * itself and refuses to release anything until a person approves it, on the
 * wallet's own screen, against the origin the BROWSER reported.
 *
 * `null` rather than a throw for a company with no label, because an
 * invitation must still be raisable; the refusal reaches the invitee's screen
 * instead of the hiring form.
 */
export function companyForOffer(
  store: DataStore, accountId: string,
): CompanyNamed | null {
  const rec = store.getAccount(accountId);
  if (!rec) return null;
  const label = readCompanyLabel(rec.companyLabel);
  if (label === null) return null;
  return { label, account: chainAccountOf(rec) };
}

/** The label alone, for the records that name the company a payslip key was worked out from. */
export const companyLabelOfRecord = (store: DataStore, accountId: string): CompanyLabel | null =>
  companyForOffer(store, accountId)?.label ?? null;
