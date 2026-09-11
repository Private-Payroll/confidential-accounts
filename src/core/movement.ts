import { nanoid } from 'nanoid';
import type { Payee, PayeeAddress } from '../midnight/payee-address.js';
import type { AssetId, AssetRegistry } from './assets.js';
import { assets as defaultAssets, ledgerTokenOf, privateForm } from './assets.js';
import type { PaymentFacts } from '../midnight/payout-tree.js';
import type { EntryKind } from './types.js';

/**
 * **THE TWO KINDS OF MOVEMENT, AND THE PRODUCT RULE THAT SEPARATES THEM.**
 *
 *
 * The word MOVEMENT already means something in this repository: the append-only
 * set of blinded commitments the contract keeps, one per settlement
 * (`StateBlinding` in `types.ts`, `movements` in `ledger.ts`). **This file is
 * about the same events one layer up** — what a company thinks it is doing when
 * money leaves an account. Same word, same event, read from the chain in one
 * place and by a finance manager in the other.
 *
 * ── WHY THERE ARE TWO KINDS AND NOT ONE ──────────────────────────────────
 *
 * **A public payment publishes the recipient's address and the amount.** An
 * address that only ever receives from one company's account, on payday, every
 * month, is not much of a disguise. So who chooses is not a preference:
 *
 *   A PAYROLL RUN      nobody chooses. **Always private.** An employee never
 *                      consents to being disclosed and must never be asked to.
 *   A ONE-OFF TRANSFER the company chooses, per transfer. It is the company's
 *                      own money going somewhere the company picked, and a
 *                      vendor who wants public settlement is a real customer.
 *
 * ── AND THE CONTRACT DOES NOT KNOW ANY OF THIS ───────────────────────────
 *
 * `recordPayment` (`ConfidentialAccount.compact:2118-2300`) checks the proposal
 * id, the payment window, approval at the vault's threshold, leaf membership in
 * the approved root, and double-spend. **It has never known what a payroll is**
 * and it must not learn: the recipient is opaque bytes inside `details`.
 *
 * **So the distinction is a PRODUCT concept and lives entirely here.** No
 * circuit may be proposed for it, and that is deliberate rather than a gap: a
 * rule the chain enforced would be a rule every customer's contract had to be
 * redeployed to change.
 */

/**
 * **WHAT A COMPANY THINKS IT IS DOING. A VALUE, NOT A CONVENTION.**
 *
 * Two values and no third. A vault WITHDRAWAL is a transfer to the company's
 * own address and needs no kind of its own — what makes it a withdrawal is who
 * the payee is, and that lives on the payee rather than here.
 *
 * `EntryKind` in `types.ts` has four values and says what the LEDGER LINE is;
 * this says what the OPERATION was. They meet in `entryKindOf` below and
 * nowhere else, so a transfer cannot become a payroll by somebody writing the
 * other string into an entry.
 */
export type MovementKind = 'payroll' | 'transfer';

/**
 * **PRIVATE OR PUBLIC, IN THE CUSTOMER'S OWN WORDS.**
 *
 * Deliberately not `shielded` and `unshielded`. Those are the platform's names
 * for two key spaces, and a finance manager cannot answer a question asked in
 * them. Having the type carry the customer's words is what leaves nothing to
 * translate at the screen, where a translation is a place to get it backwards.
 *
 * Not identity's `DisclosureResponse`, which is a signed statement a wallet
 * makes. This is a company's choice about one payment.
 */
export type Privacy = 'private' | 'public';

/**
 * **READ OFF THE ADDRESS, NEVER ASKED FOR.** The move `payeeOf` makes one layer
 * down, for the same reason.
 *
 * A `shield-addr` settles privately and an `addr` settles publicly. There is no
 * third behaviour and no way for either to be paid the other way, so this
 * renames a fact rather than taking a decision, and no call site can label a
 * payee one thing while it is paid the other.
 *
 * Exhaustive over the union: a third payee kind fails to compile here.
 */
export const privacyOf = (p: Payee): Privacy =>
  p.kind === 'shielded' ? 'private' : 'public';

/**
 * **WHICH LEDGER LINE A MOVEMENT WRITES.**
 *
 * One function rather than a string at each call site, because the misfiling
 * this round exists to prevent is exactly a transfer written into the log as a
 * payroll, where an auditor reading it in a year sees somebody's salary.
 * `deposit` and `withdrawal` are `EntryKind`'s other two and are not movements
 * a company raises through this door.
 *
 * It compiles only while every `MovementKind` is also an `EntryKind`, which is
 * the property worth holding: the two vocabularies cannot drift apart without
 * the compiler saying so here.
 */
export const entryKindOf = (m: MovementKind): EntryKind => m;

/**
 * **A PAYROLL RUN CANNOT CONTAIN A PUBLIC PAYEE. REFUSED, NOT WARNED ABOUT.**
 * `C250`, scoped 29 August.
 *
 * ── WHY A REFUSAL AND NOT A CONFIRMATION ─────────────────────────────────
 *
 * A warning is a decision handed to an operator at the worst moment, and this
 * one is wrong for every customer. The person it would disclose is not in the
 * room, has not been asked, and cannot be asked: **an employee never consents
 * to being paid publicly.** There is nothing for an operator to weigh, so there
 * is nothing to put in front of them.
 *
 * ── AND THERE IS NO FLAG ─────────────────────────────────────────────────
 *
 * **This takes a name and a payee, permanently.** A test pins the arity,
 * because a rule with a switch beside it is the rule not existing, and the
 * switch always arrives as a test-mode option somebody needs for an afternoon.
 * `a-payroll-run-is-always-private.test.ts` is what fails if either goes.
 *
 * ── WHAT IT ALSO PREVENTS, WHICH IS WORTH KNOWING ────────────────────────
 *
 * `C255`'s withdrawal is a one-payee run to the company's own public address.
 * Because this refusal sits on the payroll path, **a withdrawal cannot be built
 * as a payroll run at all**, so it cannot reach payroll history as somebody's
 * salary. That is the misfiling the row is most worried about, closed by a
 * refusal written for something else.
 *
 * ── AND IT DOES NOT SAY "PAYROLL IS ALWAYS PRIVATE" ──────────────────────
 *
 * It did, and a product-copy pass was right to refuse it. **No asset has a
 * private form today** — `privateForm` answers `not-yet` for every row of the
 * registry — so a sentence telling a customer their payroll already settles
 * where nobody can read it is the overclaim that ends the company, printed at
 * the moment they are most likely to believe it.
 *
 * **The rule is defensible without the claim**: this is about which addresses
 * the payroll door accepts, and it says exactly that.
 *
 * Returns the payee NARROWED, so the caller's own type says private too.
 */
export function payrollPayee(name: string, payee: Payee): PayeeAddress {
  if (payee.kind === 'shielded') return payee;
  throw new Error(
    `${name} is set up to be paid publicly. `
    + 'A public payment puts the address and the amount on a record anyone can read. '
    + 'An employee is never paid that way, so a payroll run will not accept a public address. '
    + 'To pay a public address, use a one-off transfer.');
}

/**
 * **A ONE-OFF TRANSFER: THE COMPANY'S OWN MONEY, TO AN ADDRESS IT CHOSE.**
 *
 * A vendor, a supplier, a contractor, or the company's own account. It is not a
 * payroll run and must never be presented as one: its own history, its own
 * screen, its own ledger line. `S12b` builds that surface against this type.
 *
 * **Approved at the vault's threshold like any other movement, and that is
 * `recordPayment`'s doing rather than this file's.** The contract checks the
 * proposal, the window, approval at the vault's threshold and leaf membership,
 * and it has never known what a payroll is — so nothing about being a transfer
 * can relax governance, because governance never learns that it is one. Said
 * this way round because the first version of this paragraph claimed the
 * property for this module, which does not hold it.
 */
export interface Transfer {
  readonly id: string;
  readonly accountId: string;
  /**
   * **A LITERAL, NOT A `MovementKind`.** A `Transfer` whose kind can be set is
   * a `Transfer` that can be set to `payroll`, and then a transfer is filed as
   * a salary by assignment. Here there is nothing to assign.
   */
  readonly movement: 'transfer';
  /** Who is paid. One value, and its kind came out of the decode that made it. */
  readonly payee: Payee;
  readonly asset: AssetId;
  /** In the asset's smallest unit, like every other amount here. */
  readonly amount: bigint;
  /**
   * **WHAT THE COMPANY CHOSE, STORED, AND IT CANNOT DISAGREE WITH THE
   * ADDRESS.**
   *
   * Settlement is decided by `payee.kind` alone, so this field changes nothing
   * about where money goes. It is stored because **the choice is what an
   * auditor asks about a year later**: this company decided, on this transfer,
   * to settle in public. A record holding only the address makes that an
   * inference rather than a fact.
   *
   * `transferOf` refuses a value that disagrees with the address, which is the
   * only reason a second field is tolerable here at all.
   */
  readonly privacy: Privacy;
  /** What the company calls this payment. Shown back to them, never to a chain. */
  readonly reference: string;
  /**
   * The approval round that settles it, once one is raised.
   *
   * **ALWAYS `null` AT CONSTRUCTION, AND THERE IS NO WAY TO SUPPLY ONE.** It
   * was a spec field, which meant a transfer could be minted already naming
   * somebody else's approved round. The chain refuses that settlement on the
   * root check so no money moves, and the RECORD still ends up attributing a
   * transfer to a round that never authorised it — which is a lie in exactly
   * the document an auditor reads. The round is written on when it is raised.
   */
  readonly proposalId: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface TransferSpec {
  readonly accountId: string;
  readonly payee: Payee;
  readonly asset: AssetId;
  readonly amount: bigint;
  /**
   * **THE TOGGLE'S POSITION, AS THE PERSON LEFT IT.** Passed in rather than
   * derived, so a toggle set to private beside a public address is REFUSED
   * rather than quietly corrected to whatever the address says.
   *
   * The quiet correction is the failure worth naming: the person believes they
   * chose private, the money settles in public, and every screen agreed with
   * them the whole way.
   */
  readonly privacy: Privacy;
  readonly reference: string;
  readonly createdBy: string;
  /**
   * **THE ADDRESSES ON THIS ACCOUNT'S PAYROLL ROSTER. REQUIRED, NEVER
   * DEFAULTED.** `C250`, and it is the half of the rule `payrollPayee` cannot
   * reach.
   *
   * `payrollPayee` is written on the shape of a RUN. The rule is about WHO the
   * payee is: *no employee is ever disclosed publicly.* Those are not the same
   * sentence, and the gap between them is a bonus, an expense or a correction
   * raised as a one-off transfer to an employee's own address, with every
   * check passing.
   *
   * **Required and not defaulted, for `payeeAddress`'s reason about `network`**:
   * a default is how the check quietly stops being made. `PayrollService.
   * listPeople(...)` is where the list comes from.
   */
  readonly employees: ReadonlyArray<Payee>;
  readonly at?: Date;
  readonly registry?: AssetRegistry;
}

/**
 * **THE ONE WAY A TRANSFER IS MADE, AND EVERY REFUSAL IT CARRIES.**
 *
 * Three of them, and each is something a screen can offer that a settlement
 * cannot do:
 *
 * 1. **The choice and the address must agree.** See `Transfer.privacy`.
 * 2. **Private is refused for an asset that has no private form.**
 *    `privateForm` answers it and the reason travels in the message, so a
 *    screen has something true to show rather than a red border. `C234`'s
 *    shape is an interface implying an operation the settlement cannot
 *    perform, and offering private money that does not exist yet is that.
 * 3. **An amount is a positive whole number in the smallest unit**, which is
 *    `assets.ts`'s first rule enforced rather than assumed at a new door.
 */
export function transferOf(spec: TransferSpec): Transfer {
  const registry = spec.registry ?? defaultAssets;
  const asset = registry.require(spec.asset);

  if (typeof spec.amount !== 'bigint') {
    throw new Error('a transfer amount is a whole number in the asset\'s smallest unit');
  }
  if (spec.amount <= 0n) throw new Error('a transfer has to move a positive amount');

  const says = privacyOf(spec.payee);
  if (spec.privacy !== says) {
    throw new Error(
      `this transfer is set to ${spec.privacy} and the address is a ${says} one. `
      + 'An address decides which way it is paid, and this choice cannot change that. '
      + `Either switch this transfer to ${says}, or use a ${spec.privacy} address.`);
  }

  /*
   * **NO EMPLOYEE IS EVER DISCLOSED PUBLICLY, CHECKED WHERE THE TRANSFER IS
   * MADE.** See `TransferSpec.employees`.
   *
   * **THE PRIVATE DIRECTION IS DELIBERATELY NOT REFUSED HERE**, and the reason
   * is that it is a filing question rather than a disclosure one: an expense
   * reimbursed to an employee is a real transfer and not a salary, so refusing
   * it would refuse an ordinary thing a company does. **A private transfer to
   * an employee does file a payment to them outside payroll history**, and
   * whether that is right is reported rather than decided in this round.
   */
  if (spec.privacy === 'public'
    && spec.employees.some(e => e.bech32 === spec.payee.bech32)) {
    throw new Error(
      'this address is on the payroll roster. '
      + 'A public payment puts the address and the amount on a record anyone can read. '
      + 'An employee is never paid that way, so pay them through payroll instead.');
  }

  if (spec.privacy === 'private') {
    const form = privateForm(asset);
    if (form.of !== 'available') throw new Error(form.why);
  }

  const reference = (spec.reference ?? '').trim();
  if (!reference) {
    throw new Error('give this transfer a reference, so it can be recognised later');
  }

  return Object.freeze({
    id: 'trf_' + nanoid(10),
    accountId: spec.accountId,
    movement: 'transfer',
    payee: spec.payee,
    asset: asset.code,
    amount: spec.amount,
    privacy: spec.privacy,
    reference,
    proposalId: null,
    createdBy: spec.createdBy,
    createdAt: (spec.at ?? new Date()).toISOString(),
  });
}

/**
 * **WHAT THE CHAIN NEEDS TO SETTLE A TRANSFER, AND IT IS A ONE-PAYEE RUN.**
 *
 *
 * `recordPayment` never checks who the recipient is: it checks the proposal,
 * the window, approval at the vault's threshold, leaf membership in the
 * approved root, and double-spend. **So a transfer is not a new kind of
 * settlement.** It is a run with one payee, built by `buildRun` from
 * `[transferFacts(t)]`, approved and paid on circuits that already exist. No
 * new circuit, no contract change, no redeploy.
 *
 * **HERE RATHER THAN AT THE SCREEN**, so `S12b` has one call rather than three
 * fields to assemble.
 *
 * **AND THE TOKEN IS THE LEDGER'S, NOT THE ASSET CODE.** A vault holds money by
 * the ledger's token type and pays out of the token it is handed, and this
 * payment commits to that token. `ledgerTokenOf` reads it off the asset's own
 * row, in the form the payee is paid in, and refuses an asset with no such form
 * rather than handing back a value that would be refused after the approvals.
 * `assetIdBytes` is the account's name for an asset and is not used here.
 *
 * **A PAYROLL RUN'S PAYMENTS DO NOT COME FROM HERE** but from `paymentFactsFor`
 * in `payroll.ts`, which asks the same function for the private form, because a
 * payroll run is always private.
 *
 * **AND IT IS THE COUNTERPART OF `paymentFactsFor`, NOT A WIDENING OF IT.**
 * That one returns `ShieldedPaymentFacts` because a payroll run is always
 * private; this one returns `PaymentFacts`, because a transfer is whichever
 * kind the address is. Two functions, two return types, one refusal between
 * them — rather than one function with a flag deciding which rule applies.
 */
export const transferFacts = (t: Transfer, registry: AssetRegistry = defaultAssets): PaymentFacts => ({
  payee: t.payee,
  token: ledgerTokenOf(t.asset, t.payee.kind, registry),
  amount: t.amount,
});
