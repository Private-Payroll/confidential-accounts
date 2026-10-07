/**
 * **A PAYROLL RUN'S LEGS, ITS PERIOD AND ITS SEALED FORM: WHAT THE SERVICE AND
 * A SIGNER'S DEVICE BOTH READ A RUN BY.**
 *
 * Every function here depends only on the run it is handed, so the device that
 * approves a run works out its legs, its payees, its month and each person's
 * pay record by the same code the service raised it with, and the two cannot
 * come to disagree about which people a leg pays or what each is paid for.
 */
import type { AssetId, AssetRegistry, LedgerForm } from './assets.js';
import { assets as defaultAssets, ledgerTokenOf, symbolOf } from './assets.js';
import type { Employee, PayrollRun, RosterEmployee, RunLeg, RunPayout, SealedRun } from './types.js';
import type { PaymentFacts } from '../midnight/payout-tree.js';
import { payrollPayee } from './movement.js';
import type { PayRecord } from '../midnight/run-keys.js';
import type { Hex } from './crypto.js';
import { openRecord, sealRecord } from './sealed-records.js';
import { kindOfRun } from './already-paid.js';

/**
 * **ONE LEG OF A RUN IS ONE TOKEN IN ONE FORM.**
 *
 * One run pays one ledger token, in one form: privately from the vault's notes
 * or publicly from its balance. A payroll whose payees include both private and
 * public addresses is raised as two legs, one per form, side by side, each its
 * own approval round over its own tree. A leg is written `<token>:<form>`.
 */
export const runLegOf = (asset: AssetId, form: LedgerForm): RunLeg => `${asset}:${form}`;

/** Whether a value names a leg, as against naming only a token. */
export const isRunLeg = (value: string): value is RunLeg =>
  /^[0-9a-f]{64}:(shielded|unshielded)$/.test(value);

/** The token a leg pays. */
export const assetOfLeg = (leg: RunLeg): AssetId => leg.slice(0, leg.indexOf(':'));

/** The form a leg pays in. */
export const formOfLeg = (leg: RunLeg): LedgerForm =>
  (leg.slice(leg.indexOf(':') + 1) === 'unshielded' ? 'unshielded' : 'shielded');

/** What an answer about one leg carries: its token, its form and the leg itself. */
export const legFieldsOf = (leg: RunLeg): { asset: AssetId; form: LedgerForm; leg: RunLeg } =>
  ({ asset: assetOfLeg(leg), form: formOfLeg(leg), leg });

/** A leg as a person reads it: the form and the token's symbol, never the token. */
export const legName = (leg: RunLeg, registry: AssetRegistry = defaultAssets): string =>
  `${formOfLeg(leg) === 'shielded' ? 'private' : 'public'} ${symbolOf(assetOfLeg(leg), registry)}`;

/**
 * **WHICH LEG A CALLER MEANS: A LEG, A TOKEN, OR NOTHING.** A token on its own
 * is enough where the run pays it in one form only; nothing at all is enough
 * where the run has one leg.
 */
export type RunLegChoice = RunLeg | AssetId;

/**
 * **THE LEG A REQUEST NAMES**: its token, and its form where the run pays that
 * token both privately and publicly. Neither means the run's only leg. A form
 * without its token names nothing and is refused.
 */
export const legChoiceOf = (b: { asset?: string; form?: LedgerForm }): RunLegChoice | undefined => {
  if (b.form !== undefined && b.asset === undefined) {
    throw new Error('a form names a leg only beside the token it is a form of. Send the token as well.');
  }
  if (b.asset === undefined) return undefined;
  return b.form === undefined ? b.asset : runLegOf(b.asset, b.form);
};

/** The form a person on a run is paid in: their address's kind when the run was drawn. */
export const formOfEmployee = (e: Employee): LedgerForm => e.form ?? 'shielded';

export const legOfEmployee = (e: Employee): RunLeg => runLegOf(e.asset, formOfEmployee(e));

/** Every leg a run pays, sorted, so two reads of one run list them in one order. */
export const legsOfRun = (run: PayrollRun): RunLeg[] =>
  [...new Set(run.employees.map(legOfEmployee))].sort();

export const legEmployees = (run: PayrollRun, leg: RunLeg): Employee[] =>
  run.employees.filter(e => legOfEmployee(e) === leg);

/** The leg a payroll round written down here is for. */
export const legOfRound = (r: { asset: AssetId; form?: LedgerForm }): RunLeg => runLegOf(r.asset, r.form ?? 'shielded');

/**
 * Resolves a choice among the legs given, or refuses naming them. `null` where
 * a choice was made and none of the legs is it.
 */
export const chooseLeg = (
  legs: readonly RunLeg[], which: RunLegChoice | undefined, _what: string, registry: AssetRegistry,
): RunLeg | null => {
  if (which === undefined) {
    if (legs.length === 1) return legs[0]!;
    const names = legs.map(l => legName(l, registry));
    throw new Error(
      `This run has ${legs.length === 2 ? 'two' : legs.length} sets of payments: `
      + `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}. `
      + 'Each is approved on its own. Choose which to send for approval.');
  }
  if (isRunLeg(which)) return legs.includes(which) ? which : null;
  const ofToken = legs.filter(l => assetOfLeg(l) === which);
  if (ofToken.length <= 1) return ofToken[0] ?? null;
  throw new Error(
    `This run pays ${symbolOf(which, registry)} both privately and publicly. Each is approved on its own. `
    + 'Say whether you mean the private or the public payments.');
};

/**
 * **WHAT EACH PERSON ON ONE LEG IS PAID FOR, IN THE LEG'S ORDER**: the person
 * by their roster entry, the run's month, the run's kind of pay, and which
 * payment of that kind for that month it is - the first, unless the run was
 * drawn to pay them a numbered extra. Each payee's nonce is derived from it,
 * and the account refuses a second payment carrying a nonce it has recorded, so
 * nobody is paid twice for one month by this run or any other.
 */
export const payRecordsOf = (run: PayrollRun, people: Employee[]): PayRecord[] =>
  people.map(e => ({
    person: e.id,
    month: canonicalPeriod(run.period),
    kind: kindOfRun(run),
    occurrence: run.repeats?.extra?.[e.id] ?? 0,
  }));

/**
 * **WHAT ONE LEG'S PAYEE SECRETS ARE DERIVED FROM, AND WHY IT IS NOT THE RUN'S
 * OWN ID.**
 *
 * Every per-payee nonce and blinding on a run comes out of this identifier and
 * the account's seed. Two legs of one payroll are two approvals over two
 * separate trees, and if they shared an identifier they would derive the SAME
 * secrets for position 0 of each - and each payee is handed their own nonce and
 * blinding, so the person at position 0 of one leg would hold the secrets of
 * whoever sits there in the other. They are different runs by the only measure
 * that matters here, so they get different identifiers.
 *
 * The value is stored with the leg rather than recomputed on demand, so that
 * changing this rule cannot strand a run that is already approved.
 */
export const runIdForLeg = (run: PayrollRun, leg: RunLeg): string => `${run.id}:${leg}`;

/**
 * **WHICH LEG OF A RUN IS BEING ACTED ON, RESOLVED IN ONE PLACE.**
 *
 * A run that settles in one asset needs nobody to say which; a run that settles
 * in two cannot be guessed at, because guessing would act on one set of people
 * and report about another. Every door that works a leg at a time asks here, so
 * a caller cannot get one answer at the raise and a different one at the read.
 */
/**
 * **WHICH LEG A PAYMENT VIEW IS ABOUT, RESOLVED OVER THE LEGS THAT HAVE
 * MATERIAL RATHER THAN OVER THE PAYROLL.**
 *
 * A run's payroll says which currencies it settles in; its payout record says
 * which of those have actually been raised. A view is about the second, and the
 * difference matters at both ends: a run with nothing raised has nothing to
 * report and says so once, in the shape every reader already handles, rather
 * than refusing for want of an argument that would not have helped; and a run
 * with two legs raised cannot be reported on without being told which, because
 * answering about one is how a screen comes to call a payroll complete while
 * everybody in the other currency is still owed.
 *
 * `null` where there is nothing to report on at all.
 */
export const raisedLegOf = (
  run: PayrollRun, which: RunLegChoice | undefined, registry: AssetRegistry = defaultAssets,
): RunLeg | null => {
  const raised = Object.keys(run.payout ?? {}).sort();
  if (raised.length === 0) return null;
  if (which === undefined && raised.length > 1) {
    throw new Error(
      `this run has payout material for ${raised.length} legs (${raised.map(l => legName(l, registry)).join(', ')}) and a ` +
        'payment view is about one of them. Name which leg: each is its own approval round ' +
        'over its own set of payees, and an answer about one says nothing about the other.',
    );
  }
  return chooseLeg(raised, which, 'has payout material for', registry);
};

export const legOf = (run: PayrollRun, which: RunLegChoice | undefined, registry: AssetRegistry = defaultAssets): RunLeg => {
  const leg = chooseLeg(legsOfRun(run), which, 'pays', registry);
  if (leg === null) {
    throw new Error(`this run pays nobody in ${isRunLeg(which!) ? legName(which!, registry) : symbolOf(which!, registry)}`);
  }
  return leg;
};

/**
 * **A PAY PERIOD HAS ONE SPELLING, AND ANYTHING ELSE IS REFUSED HERE RATHER
 * THAN COMPARED LATER.**
 *
 * Every guard in this file against paying somebody twice asks whether two runs
 * are for the same period, and every one of them asked it by comparing the text
 * a person typed. So `2026-08 ` with a trailing space, or `2026-8` without the
 * zero, was a DIFFERENT period to all of them: a second payroll was drawn for
 * it beside the first, raised beside it, and everybody on both was paid twice,
 * each time under their own payment secrets so that nothing on chain connected
 * the two. The chain now records the month each payment is for, and it is
 * spelled one way for that too. Neither spelling is an attack. Both are a retype, and the restart a
 * person reaches for is exactly the moment they retype it.
 *
 * **SO A PERIOD STOPS BEING FREE TEXT AT THE POINT IT ENTERS.** A run is drawn
 * for a month, written `YYYY-MM`, and a month is what this returns: anything
 * that names August 2026 comes back as `2026-08` however it was typed, and a
 * string that names no month is refused, with the form that is wanted. The
 * guards then compare a value rather than a typing, and there is no longer such
 * a thing as a spelling they have not seen.
 *
 * **IT IS IN THE SERVICE AND NOT ONLY ON THE WAY IN.** The routes in front of
 * this are the doors the product happens to have today; a third one, a script,
 * or a call path added later would each reach those guards with whatever it was
 * handed. A refusal a caller cannot go around is the only kind that bounds
 * anything.
 */
export const canonicalPeriod = (period: string): string => {
  const written = period.trim();
  const named = /^(\d{4})-(\d{1,2})$/.exec(written);
  const month = named ? Number(named[2]) : 0;
  if (!named || month < 1 || month > 12) {
    throw new Error(
      `"${period}" does not name a pay period. A run is drawn for one month, written as the `
      + 'year, a hyphen and the month: 2026-08 is August 2026. Write the month that way and '
      + 'draw the run again.');
  }
  return `${named[1]}-${String(month).padStart(2, '0')}`;
};

/** Every proposal a run's legs record for their retries. */
export const retryProposalIdsOf = (payout: Record<RunLeg, RunPayout> | undefined): string[] =>
  Object.values(payout ?? {}).flatMap(p =>
    (p.retries ?? []).map(r => r.proposalId).filter((id): id is string => id !== undefined));

/**
 * **A RUN SEALED AS IT IS KEPT**: its numbers sealed under the company's
 * viewing key, and outside the seal what finds it - its period, its status,
 * the proposals it was raised as - and the payslips, each sealed to its payee.
 * The one sealing, for the device that draws or raises a run and for the
 * service's own writes.
 */
export const sealedRunOf = (run: PayrollRun, viewingKey: Hex, keyEpoch: number): Omit<SealedRun, 'wiring' | 'filedBy'> => {
  const { employees, totals, proposalIds, payout, skips, repeats, wiring: _wiring, ...operational } = run as PayrollRun & { wiring?: unknown };
  return {
    ...operational,
    // Outside the envelope so a run can be found by its proposals; the map
    // that says which asset each leg is in stays inside, so the store cannot
    // see that this company pays anyone in ether.
    proposalIds: [...Object.values(proposalIds), ...retryProposalIdsOf(payout)].sort(),
    keyEpoch,
    sealed: sealRecord('payroll', run.accountId, { employees, totals, proposalIds, payout, skips, repeats } satisfies RunSecrets, viewingKey),
  };
};

/** The numbers on a run, sealed. Everything else about it is operational. */
export type RunSecrets = Pick<PayrollRun, 'employees' | 'totals' | 'proposalIds' | 'payout' | 'skips' | 'repeats'>;

/**
 * **A STORED RUN, OPENED WITH THE VIEWING KEY.** `proposalIds` is taken from
 * inside the envelope rather than from the list outside it: the outside one is
 * there to find a run by its proposals and does not say which leg each is for.
 */
export const openSealedRun = (r: SealedRun, viewingKey: Hex): PayrollRun => {
  const { sealed, keyEpoch: _epoch, proposalIds: _outside, filedBy: _filedBy, ...operational } = r;
  return { ...operational, ...openRecord<RunSecrets>('payroll', r.accountId, sealed, viewingKey) };
};

/**
 * **WHAT EACH PERSON ON A LEG IS PAID: THE ADDRESS ON THEIR ROSTER RECORD, THE
 * TOKEN IN THEIR ADDRESS'S FORM, AND THE AMOUNT THE RUN NAMES.** Refused, by
 * name, for anybody who is not on the roster, is not active, has no address,
 * has an address other than the one the run was drawn against, or whose address
 * is now of the other form. `personOf` is how the caller reads a roster record:
 * the service from its store, a device from the records it opened and believed.
 */
export const factsOfThePaid = (
  people: readonly Employee[], personOf: (id: string) => RosterEmployee | null | undefined,
  registry: AssetRegistry = defaultAssets,
): PaymentFacts[] =>
  people.map((e) => {
    const person = personOf(e.id);
    if (!person) {
      throw new Error(
        `${e.name} is not on the roster, so there is no address to pay them at. `
        + 'An ad hoc run can seal a payslip to somebody, but it cannot send them money.');
    }
    if (person.status !== 'active') {
      throw new Error(
        `${person.name} is ${person.status}, not active. Paying them now would settle `
        + 'into an address nobody has confirmed they can reach.');
    }
    if (!person.address) {
      throw new Error(
        `${person.name} has no address. It has to come from their own device or wallet — `
        + 'there is nowhere for an operator to enter one for somebody else, on purpose.');
    }
    /*
     * **THE TOKEN IS THE LEDGER'S, IN THE FORM THIS PAYEE IS PAID IN, READ OFF
     * THE ASSET'S ROW.** A vault pays out of the token a payment names, so a
     * payment naming its money by the account's name for the asset would be
     * approved, paid for, and refused at the vault. Where the asset has no
     * private form this refuses now, before any material is built or any fee
     * is spent, and says which assets can be paid privately.
     */
    const payee = payrollPayee(person.name, person.address);
    /*
     * **THE ADDRESS PAID IS THE ADDRESS ON THE PAYSLIP, OR NOTHING IS PAID.**
     * The payslip was written when the run was drawn and names where its
     * payee is paid; this pays the roster's address as it is now. Asked
     * after the address is known to be one a payroll may pay at all. A run
     * drawn before its people's addresses were kept beside them has nothing
     * to compare, and is paid as it always was.
     */
    if (e.paidTo !== undefined && e.paidTo.toLowerCase() !== person.address.bech32.toLowerCase()) {
      throw new Error(
        `${person.name}'s address on the roster has changed since this run was drawn, so it would `
        + 'pay an address their payslip does not name. Nothing was raised and no fee was spent. '
        + `Check the change with ${person.name}, then draw the run again. If a round of this run was `
        + 'raised before, withdraw it first.');
    }
    /*
     * **A PERSON IS PAID IN THE FORM THEIR LEG IS.** The leg was settled by
     * their address when the run was drawn; an address of the other kind now
     * would put them in a run of the other form.
     */
    if (payee.kind !== formOfEmployee(e)) {
      throw new Error(
        `${person.name} is on this run to be paid ${formOfEmployee(e) === 'shielded' ? 'privately' : 'publicly'}, `
        + `but their payment address is now a ${payee.kind === 'shielded' ? 'private' : 'public'} one. `
        + `Nothing was sent for approval and no fee was spent. Create the run again so ${person.name} is paid the way their address allows.`);
    }
    return {
      payee,
      token: ledgerTokenOf(e.asset, payee.kind, registry),
      amount: e.amount,
    };
  });

