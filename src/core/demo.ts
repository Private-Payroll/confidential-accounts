import { type AccountService, approvalMessage } from './account.js';
import type { EmployeeSecret, PayrollService } from './payroll.js';
import type { RosterEmployee } from './types.js';
import { sign } from './crypto.js';

/**
 * The demo company pays in pounds, and every figure here is in PENCE.
 *
 * `salary: 9_400` meant nine thousand four hundred pounds and now means ninety
 * four pounds, so every number below is multiplied by a hundred and written
 * with an explicit `_00` at the end. That is deliberately noisy: a seed file is
 * where somebody will copy a figure from, and a bare `940000` invites the next
 * person to write `9400` and wonder why the demo is broke.
 */
const GBP = 'GBP';

const PEOPLE = [
  { name: 'Dana Whitfield',  email: 'dana@northwind.co',  title: 'Head of Engineering', baseAmount: 9400_00n, asset: GBP, startDate: '2024-02-12' },
  { name: 'Eli Barros',      email: 'eli@northwind.co',   title: 'Senior Engineer',     baseAmount: 7100_00n, asset: GBP, startDate: '2024-06-03' },
  { name: 'Fern Adeyemi',    email: 'fern@northwind.co',  title: 'Product Designer',    baseAmount: 6300_00n, asset: GBP, startDate: '2025-01-20' },
  { name: 'Gus Lindqvist',   email: 'gus@northwind.co',   title: 'Engineer',            baseAmount: 5400_00n, asset: GBP, startDate: '2025-03-17' },
  { name: 'Hana Ito',        email: 'hana@northwind.co',  title: 'Finance Lead',        baseAmount: 6800_00n, asset: GBP, startDate: '2024-09-02' },
  { name: 'Idris Mensah',    email: 'idris@northwind.co', title: 'Engineer',            baseAmount: 5200_00n, asset: GBP, startDate: '2025-07-14' },
  { name: 'Jo Ferreira',     email: 'jo@northwind.co',    title: 'Operations',          baseAmount: 4600_00n, asset: GBP, startDate: '2025-11-03' },
  { name: 'Kit Novak',       email: 'kit@northwind.co',   title: 'Engineer',            baseAmount: 5900_00n, asset: GBP, startDate: '2026-01-06' },
];

/**
 * Builds a company that looks like it has been running for a few months, because
 * an empty product tells you nothing about whether the product works.
 */
export async function seedDemo(
  accounts: AccountService,
  payroll: PayrollService,
  /** Binds the first seat to the signed in user so the demo is really theirs. */
  ownerUserId?: string,
) {
  /*
   * **THE DEMO IS DARK, ON PURPOSE, AND IT STOPS BEFORE IT TOUCHES ANYTHING.**
   *
   *
   * It funded the company with `accounts.deposit(…, 480_000_00n, 'Monument
   * Bank')` and then settled two months of payroll by spending that balance.
   * Both were the account's own book, and the book is gone: the account is an
   * authority over a vault, not a holder of money.
   *
   * **THE REFUSAL IS THE FIRST STATEMENT, AND THAT POSITION IS THE POINT.** It
   * was written below `accounts.create`, so every press of the demo button left
   * a real four-signer company behind — with four signing keypairs minted in
   * our process — and then errored, handing the caller no id for it and leaving
   * nothing able to delete it. A write that half-lands where nothing can delete
   * what it left is this project's most repeated failure. Refusing before the
   * first write is the whole fix.
   *
   * **WHEN THE DEMO COMES BACK IT WILL FUND A VAULT**, which is what the
   * product actually does. That path is not built, and building it here would
   * mean inventing vault payroll inside a seeder.
   */
  throw new Error(
    'the demo cannot be seeded, and nothing has been created: it funded the company by ' +
      'depositing into the account, and the account no longer keeps a balance (C292). Two ' +
      'months of settled payroll were spent out of that balance. Both need vault payroll — ' +
      'funding a vault and paying a run from it — which is not built. This is deliberate ' +
      'and is the accepted cost of taking the bytes at the redeploy rather than a later one.',
  );

  // eslint-disable-next-line no-unreachable
  const created = await accounts.create('Northwind Ltd', [
    { name: 'Ada Okafor',     role: 'admin', userId: ownerUserId ?? null },
    { name: 'Blake Ruiz',     role: 'approver' },
    { name: 'Cleo Nakamura',  role: 'approver' },
    { name: 'Devi Raman',     role: 'viewer' },
  ], 2);

  const { account, viewingKey, secrets } = created;

  /*
   * WHAT THE SEEDER DID, KEPT SO THE ROUND THAT REBUILDS IT ON VAULTS HAS IT.
   *
   * It funded the company here — `accounts.deposit(…, 480_000_00n, 'Monument
   * Bank')` — and then settled two months of payroll by spending that balance.
   * Both the funding and the spending were the account's own book, and the book
   * is gone: the account is an authority over a vault, not a holder of money.
   *
   * **WHEN THE DEMO COMES BACK IT WILL FUND A VAULT**, which is what the
   * product actually does. That path is not built, and building it here would
   * mean inventing vault payroll inside a seeder.
   *
   * So it fails, here, with this sentence — rather than seeding a company whose
   * runs can be raised, approved, and never paid, which would look like a
   * working demo right up to the moment somebody pressed Settle.
   */
  // eslint-disable-next-line no-unreachable

  const employees = PEOPLE.map(p => payroll.hireDirect(account.id, p, viewingKey));

  // Two settled months of history, so the run list is not empty on first load.
  for (const period of ['2026-05', '2026-06']) {
    const { run } = await payroll.createRunFromRoster(account.id, period, viewingKey);
    /*
     * **`null` RUN MATERIAL, SO THIS REFUSES, AND THE SEEDER SAYS SO RATHER
     * THAN PRETENDING.**
     *
     * Until `S47` this line raised a governance round carrying a payload hash
     * no vault can ever reproduce, and the seeder showed it as a proposed run.
     * There is no run material to hand it: the vault path is not built
     * and nothing in `src/` builds a payout tree.
     *
     * **THIS BLOCK IS ALREADY UNREACHABLE — `S26` MADE THE SEEDER THROW ABOVE,
     * AND THE `no-unreachable` DISABLE TWENTY LINES UP IS THAT FACT WRITTEN
     * DOWN.** So the `null` changes nothing that runs and is not a fix; it is
     * this line saying what it would do if the seeder came back, so the round
     * that rebuilds the demo on vaults inherits the truth rather than a call
     * that compiles and lies. It would refuse, with the sentence
     * `PayrollService.proposeRun` carries.
     */
    const proposal = await payroll.proposeRun(
      run.id, viewingKey, secrets[0].signerId, null);
    /*
     * **THE SEEDER SIGNS FOR ITSELF, AND THE SERVICE STILL CANNOT.**
     *
     * These two calls are the reason `signingSecret` survives a grep of this
     * file, and the reason is not the one it looks like. Nothing is being
     * received here: this function MINTED these keys four statements ago, for a
     * demonstration company that exists to be walked through alone, and they go
     * to the browser in the response either way. What matters is that the
     * signing is written out where it can be read — `approve` takes a signature
     * and has no secret to sign with, so a seeder that wants two approvals has
     * to make them the same way a device does.
     */
    await accounts.approve(
      proposal.id, secrets[0].signerId, sign(approvalMessage(proposal), secrets[0].signingSecret), viewingKey);
    await accounts.approve(
      proposal.id, secrets[1].signerId, sign(approvalMessage(proposal), secrets[1].signingSecret), viewingKey);
    await payroll.attestPayrollTotal(run.id, viewingKey, GBP);
  }

  return { ...created, employees: seededEmployeesForHttp(employees) };
}

/**
 * **THE ONE PROJECTION THAT DECIDES WHETHER A MNEMONIC LEAVES THIS PROCESS.**
 *
 *
 * `hireDirect` derives each seeded person's payslip key from a wallet it mints
 * for them, and returns the words so the derivation can be checked against its
 * own inputs. **`seedDemo`'s return value is an HTTP body.** The route already
 * hands back every signer's secrets, which is the demo's whole point — but a
 * wrapping secret opens payslips and A MNEMONIC IS A WHOLE WALLET, that
 * person's money keys included. Two different sizes of secret, and only one of
 * them belongs in a JSON response.
 *
 * **THE FIELDS ARE LISTED AND NEVER SPREAD.** A `...e.secret` would carry a new
 * secret on `EmployeeSecret` out of this process without anybody typing a line;
 * listing them means somebody has to, and `payslip-key.test.ts` asserts the
 * list itself so that the typing has to be read.
 *
 * **THIS COVERS THIS ROUTE AND NOT THE OTHER ONE.**
 * `POST /api/accounts/:id/payroll` returns `PayrollService.createRun`'s result
 * whole, `secrets: EmployeeSecret[]` included, with no projection in between —
 * `S29`, found by its money-safety pass. Nothing leaks there today only
 * because the branch that mints a secret sets three fields.
 *
 * **AND IT IS A FUNCTION RATHER THAN AN EXPRESSION INSIDE `seedDemo` BECAUSE
 * THE RULE HAS TO BE TESTABLE WITHOUT SEEDING.** `seedDemo` refuses as its
 * first statement, so a test that reaches this projection
 * through it cannot run at all — which left `payslip-key.test.ts` deliberately
 * red for a round. `S28` wrote the three ways out with none marked correct;
 * this is (a), and it changes what crosses the wire in exactly no way: the same
 * four fields, in the same order, from the same inputs. `payslip-key.test.ts`
 * now drives this directly, against a real `hireDirect` payload with real
 * words in it.
 */
export function seededEmployeesForHttp(
  hired: ReadonlyArray<{ employee: RosterEmployee; secret: EmployeeSecret }>,
): Array<{ employeeId: string; name: string; wrappingSecret: string; title: string }> {
  return hired.map(e => ({
    employeeId: e.secret.employeeId,
    name: e.secret.name,
    wrappingSecret: e.secret.wrappingSecret,
    title: e.employee.title,
  }));
}
