import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { newWords } from 'midnight-identity';
import { FileStore } from './store-file.js';
import { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } from './ledger.js';
import { AccountService } from './account.js';
import { PayrollService, RecordingInviteDelivery } from './payroll.js';
import { seededEmployeesForHttp } from './demo.js';
import { payeeAddressFromKeys } from '../midnight/payee-address.js';
import { newWrappingKeypair, toHex } from './crypto.js';
import { payslipKeypairForWallet, payslipKeypairFrom } from './payslip-key.js';
import { sealHandover, type SealedHandover } from './invite-handover.js';
import type { DataStore } from './store.js';
import type { Hex } from './crypto.js';
import type { PayeeAddress } from '../midnight/payee-address.js';

/**
 * **X11 §7 — THE INVITEE'S OWN DEVICE SEALS, SO A TEST HAS TO SEAL TOO.**
 *
 * `acceptInvite` has nowhere to put a plain address any more: it takes a blob
 * the service cannot open, sealed to the account's inbox public key. That key
 * reaches a real invitee inside the sealed offer; here it is looked up from the
 * invite the token belongs to, which is the same account by construction.
 */
const handedOver = (
  h: { store: DataStore },
  token: string,
  parts: { wrappingPublicKey: Hex; address: PayeeAddress; confirmation?: string | null },
): SealedHandover => {
  const invite = h.store.getInvite(token);
  if (!invite) throw new Error(`no invite for ${token} — the test is wrong, not the code`);
  const account = h.store.getAccount(invite.accountId);
  if (!account) throw new Error('no account for that invite');
  return sealHandover(
    {
      wrappingPublicKey: parts.wrappingPublicKey,
      address: parts.address.bech32,
      /* X12 §2 — the code the invitee read off their own wallet. Null here:
       * these tests are about what the SERVICE does with a handover, and the
       * comparison the code exists for is made on an admin's screen. */
      confirmation: parts.confirmation ?? null,
    },
    account.inboxPublicKey);
};

/**
 * **THE PAYSLIP KEY IS DERIVED, NOT MINTED AND KEPT.** `docs/NEXT.md` PI2b §2,
 * `C135`, `C127`, `C136`.
 *
 * ── THE ONE TEST THIS ROUND IS JUDGED ON IS `§4` ──────────────────────────
 *
 * *A person on a new device opens payslips issued before that device existed.*
 * Everything above it is the apparatus that makes that sentence mean something:
 * that the key is the person's and nobody else's, that no employer made it, and
 * that nothing anywhere wrote it down.
 *
 * ── AND WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────
 *
 * **Not one assertion about payslip SEALING was written, moved or reworded by
 * this round.** `core.test.ts` holds those — that an employee opens exactly one
 * slip, that another employee's secret does not, that the account viewing key
 * is nowhere near the path — and they pass unchanged against a key that is now
 * derived rather than random, which is the strongest available evidence that
 * the guarantee left this round exactly as it found it. `§3` below adds the
 * negatives that are about the DERIVATION specifically, and adds no others.
 */

const ORIGIN = 'https://payroll.example';
const ELSEWHERE = 'https://payroll.self-hosted.example';

const world = () => {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-pi2b-')), 'db.json'));
  const accounts = new AccountService(
    store, new SimulatedLedger(SimulatedCommitments), SimulatedCommitments);
  const invites = new RecordingInviteDelivery();
  const payroll = new PayrollService(
    store, accounts, new SimulatedProofSystem(), undefined, 'undeployed', invites);
  return { store, accounts, payroll, invites };
};

const SIGNERS = [
  { name: 'Ada', role: 'admin' as const, userId: 'usr_ada' },
  { name: 'Blake', role: 'approver' as const },
];

const A_PAYEE_ADDRESS = payeeAddressFromKeys(
  { coinPublicKey: '41'.repeat(32), encryptionPublicKey: '42'.repeat(32) }, 'undeployed');

/** Somebody with a sign-in of their own, because `admit` requires one. A-11. */
const signIn = (store: { putUser: (u: any) => void }, email: string) => {
  const id = 'usr_' + email.replace(/[^a-z0-9]/gi, '_');
  store.putUser({
    id, email, name: email, keyBundle: null,
    createdAt: '2026-08-23T00:00:00.000Z',
  });
  return id;
};

/* ======================================================================== */

describe('§1 — THE DERIVATION IS A PURE FUNCTION OF A WALLET AND A COMPANY', () => {
  it('THE DERIVATION IS PINNED TO FIXED BYTES — the salt is not a thing anyone may tidy', () => {
    /*
     * **`T-196` `P1`, `SC9` `F4`, `S46`. THE ONE ASSERTION IN THIS FILE THAT IS
     * NOT SELF-REFERENTIAL.**
     *
     * Every other relation §1 pins — determinism, host-independence,
     * distinctness, not-the-parent-key, the length refusal — **stays true when
     * `PAYSLIP_SALT` changes to any other fixed string.** A changed-but-fixed
     * salt keeps this whole file green **and makes every payslip ever issued
     * unopenable**, by the person it belongs to, for good. The constant's own
     * comment (`payslip-key-derive.ts:99-101`) says *"the day it changes is the
     * day every payslip stops opening"* and nothing enforced it.
     *
     * **THE LOSS IS PAYSLIP READABILITY AND NOT FUNDS, SAID PLAINLY** so that
     * nobody has to deflate this later. It is still permanent.
     *
     * ── WHERE THESE BYTES CAME FROM — RULE 9 ──────────────────────────────
     *
     * **NOT FROM THIS REPOSITORY.** `node:crypto` — OpenSSL, not `@noble` —
     * computed `hkdfSync('sha256', ikm, utf8('midnight-payroll/payslip-wrapping/v1'),
     * <empty info>, 32)` for the secret, and OpenSSL's X25519 derived the
     * public half from it. **So this pins the SALT, the empty `info`, the
     * `sha256`, the 32-byte length and the curve** — every parameter of the
     * expansion at `payslip-key-derive.ts:132-133` — against an implementation
     * that has never seen this code.
     *
     * `contracts/test/run-keys.test.ts:171-206` is the model, and it is the
     * model for the reason written there: a schedule that only agrees with
     * itself catches an argument swap in nothing.
     */
    expect(payslipKeypairFrom(new Uint8Array(32).fill(0x11))).toEqual({
      secret: '4f9e108132ff27430f4dbe109104521f019068f7f03a3c5ab9fe9bc8f515ce7f',
      publicKey: '1cd075135b08e64262129c9b29ec29c2d6b78bbc113586feb4214b8a56c8ac65',
    });

    /* A second IKM, so a derivation that ignored its input and returned a
     * constant is not mistaken for one that is pinned. */
    expect(payslipKeypairFrom(Uint8Array.from(
      { length: 32 }, (_, i) => i + 1,
    ))).toEqual({
      secret: '6de6d8471a70a6ecfc555cfbbd7b58a524020ab45a4be930dc18aff4e7f83d2a',
      publicKey: '029390d27165ecb192191f0ec668610c24735b8bbb899ce6d0b90ab63ef77946',
    });

    /* And what a changed salt would produce — OpenSSL's answer for the same
     * IKM under `…/v2`. It is here so the test states what it is
     * discriminating between rather than only that a number changed. */
    expect(payslipKeypairFrom(new Uint8Array(32).fill(0x11)).secret)
      .not.toBe('0a03c86670830de9f3802b238d214999c446ecc8c9a438a7ad61cd578f60283f');
  });

  it('THE SAME WORDS AND THE SAME COMPANY GIVE THE SAME KEY, EVERY TIME', () => {
    const words = newWords();
    expect(payslipKeypairForWallet(words, 'a1'.repeat(32), ORIGIN).secret)
      .toBe(payslipKeypairForWallet(words, 'a1'.repeat(32), ORIGIN).secret);
  });

  it('THE HOST IS NOT AN INGREDIENT — a self-hosted client derives the same key', () => {
    /*
     * The property the whole design rests on, and the reason `W3` changed what
     * the parent is derived from. A key that moved with the host would mean a
     * customer's copy of their own data opens at our address and nowhere else,
     * which is `C127` reopened by the mechanism meant to serve it.
     */
    const words = newWords();
    expect(payslipKeypairForWallet(words, 'a1'.repeat(32), ELSEWHERE).secret)
      .toBe(payslipKeypairForWallet(words, 'a1'.repeat(32), ORIGIN).secret);
  });

  it('TWO COMPANIES NEVER SHARE A KEY, and neither do two people', () => {
    const mine = newWords();
    const theirs = newWords();
    const here = payslipKeypairForWallet(mine, 'a1'.repeat(32), ORIGIN).secret;

    expect(payslipKeypairForWallet(mine, 'b2'.repeat(32), ORIGIN).secret).not.toBe(here);
    expect(payslipKeypairForWallet(theirs, 'a1'.repeat(32), ORIGIN).secret).not.toBe(here);
  });

  it('THE PAYSLIP KEY IS NOT THE KEY IT IS DERIVED FROM', () => {
    /*
     * No key in this system does two jobs. The released key opens the company
     * keyring; this one opens payslips. Holding one must not be holding the
     * other, and a one-way expansion is what makes that true rather than said.
     */
    const released = new Uint8Array(32).fill(7);
    expect(payslipKeypairFrom(released).secret).not.toBe(toHex(released));
  });

  it('and something that is not a released key is refused rather than expanded', () => {
    /*
     * A LOUD REFUSAL, because the alternative is silent: any bytes at all
     * expand into a perfectly usable keypair that nothing will ever derive
     * again — a payslip sealed to nobody, found out when somebody reads it.
     */
    expect(() => payslipKeypairFrom(new Uint8Array(31))).toThrow(/31 bytes/);
    expect(() => payslipKeypairFrom(new Uint8Array(0))).toThrow(/0 bytes/);
  });
});

describe('§2 — NOBODY WRITES THE SECRET DOWN, INCLUDING US', () => {
  it('THE SEED DERIVES THE KEY AND NO LONGER INVENTS ONE', async () => {
    const h = world();
    const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
    const { secret } = h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);

    /*
     * ASSERTED AGAINST THE DERIVATION, NOT AGAINST A SHAPE. A random secret is
     * 64 hex characters too — which is exactly why `C140` exists one level up —
     * so the only claim worth making is that this key is what those words and
     * that company produce.
     */
    expect(secret.words).toBeDefined();
    expect(secret.wrappingSecret).toBe(
      payslipKeypairForWallet(
        secret.words!, h.store.getAccount(account.id)!.contractAddress!, ORIGIN).secret);
  });

  it('THE SECRET IS IN NO STORED RECORD ANYWHERE — not the roster, not the run', async () => {
    const h = world();
    const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
    const { employee, secret } = h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
    const derived = payslipKeypairForWallet(
      secret.words!, h.store.getAccount(account.id)!.contractAddress!, ORIGIN);
    await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);

    /*
     * **SEARCHED IN THE RAW TEXT, NOT THE REDACTED TEXT, AND THE FIRST VERSION
     * OF THIS TEST HAD IT THE WRONG WAY ROUND.**
     *
     * `redactHex` blanks every hex run of 32 characters or more, which is what
     * makes searching for a SALARY sound (M-101). A wrapping secret is 64 hex
     * characters — so redacting first deletes the very thing being looked for,
     * and the assertion passes whatever the store contains. `redact.ts`'s own
     * header says so: long values must be searched for literally, and at 64
     * characters a chance collision is not a thing that happens.
     */
    const raw = JSON.stringify((h.store as unknown as { data: unknown }).data);
    /*
     * **TWO POSITIVE CONTROLS BEFORE THE ABSENCE**, because an absence test
     * over the wrong string passes perfectly. The store really was read, and it
     * really does hold this person's key material — the PUBLIC half.
     */
    expect(raw).toContain(employee.id);
    expect(raw).toContain(derived.publicKey);
    expect(raw).not.toContain(secret.wrappingSecret);

    /*
     * **AND THE WORDS, AS A PHRASE RATHER THAN ONE AT A TIME.** A BIP-39 word
     * list contains `name`, `asset`, `type`, `index` and `credit`, every
     * one of which is a legitimate key in this store — so asserting word by
     * word is a test that fails at random on correct code, which is M-101
     * wearing different clothes. The whole phrase cannot collide with anything.
     */
    expect(raw).not.toContain(secret.words!.join(' '));
  });

  it('THE COMPANY HOLDS ONLY THE PUBLIC HALF', async () => {
    const h = world();
    const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
    const { employee, secret } = h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);

    const onRoster = h.payroll.person(employee.id, viewingKey)!;
    const derived = payslipKeypairForWallet(
      secret.words!, h.store.getAccount(account.id)!.contractAddress!, ORIGIN);
    expect(onRoster.wrappingPublicKey).toBe(derived.publicKey);
    expect(JSON.stringify(onRoster)).not.toContain(derived.secret);
  });

  /*
   * ──────────────────────────────────────────────────────────────────────────
   * **THIS TEST WAS RED ON PURPOSE FOR ONE ROUND, AND `S29` TOOK OPTION (a).**
   * `C303`, `C312`, `T-63`.
   *
   * `S28` could not close it: the assertion is about a property OF the
   * projection `seedDemo` returns, `seedDemo` refuses as its first statement
   * (`C292`, `S26`), and a tests-only round may not edit `src/core/demo.ts`.
   * It wrote three ways out with none marked correct (rule 20). (a) was
   * *extract the projection into a callable of its own and drive that*.
   *
   * **THAT IS WHAT THIS NOW DOES, AND THE RULE IS UNCHANGED RATHER THAN
   * LOWERED.** `seededEmployeesForHttp` is the same four fields, listed and not
   * spread, from the same inputs; nothing about what crosses the wire moved.
   * What moved is that the rule can be asserted without seeding a company that
   * cannot be seeded — and the input below is a REAL `hireDirect` payload with
   * real words in it, not a hand-built object, so a new secret appearing on
   * `EmployeeSecret` is still caught by this test rather than by nobody.
   * ──────────────────────────────────────────────────────────────────────────
   */
  it('THE SEED\'S HTTP PAYLOAD CARRIES NO MNEMONIC — a wallet is not a wrapping secret', async () => {
    /*
     * **`C45`, AND THE SIZE OF THE SECRET IS THE WHOLE POINT.** `/api/demo/seed`
     * already hands back every signer's secrets, which is what makes the demo
     * walkable alone. A wrapping secret opens payslips; **a mnemonic is a whole
     * wallet, that person's money keys included.** `seededEmployeesForHttp`
     * lists the fields it returns instead of spreading them, so a new secret on
     * `EmployeeSecret` cannot leave THROUGH THIS PROJECTION without somebody
     * typing a line.
     *
     * **AND THAT IS ONE OF THE TWO ROUTES THAT RETURN AN `EmployeeSecret` TO
     * THE WIRE.** `S29`, found by its own `money-safety-auditor`.
     * `POST /api/accounts/:id/payroll` returns `payroll.createRun`'s result
     * WHOLE — `{ run, secrets: EmployeeSecret[] }` — with no projection between
     * the interface and `res.json`. Nothing leaks there today, because the ad
     * hoc branch that mints a secret sets three fields and `words` is absent by
     * construction; **but a field added to `EmployeeSecret` leaves by that route
     * on the next deploy with nobody typing anything.** Rule 27, `C286`: the
     * property holds because nobody has written the code that would break it.
     * The route is a row; the two assertions below are what this file can hold
     * without one.
     */
    const h = world();
    const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
    const hired = [
      { name: 'Dana', email: 'dana@a.co', title: 'Eng',     asset: 'GBP', baseAmount: 9400_00n },
      { name: 'Eli',  email: 'eli@a.co',  title: 'Finance', asset: 'GBP', baseAmount: 7100_00n },
    ].map(spec => h.payroll.hireDirect(account.id, spec, viewingKey));

    /*
     * **POSITIVE CONTROLS BEFORE THE ABSENCE**, because an absence test over a
     * payload that never held the secret passes perfectly, and because the
     * probe has to be the shape the secret would really arrive in.
     *
     * **AND THE FIRST ONE FAILED THE ROUND THAT WROTE IT, WHICH IS WHY IT IS
     * HERE.** `S29`; the register row is described in `BACKLOG.md` for the
     * controller and is deliberately not numbered here (rule 16). The assertion
     * this test carried until now was
     * `expect(body).not.toMatch(/\b(?:[a-z]{3,8} ){11,}[a-z]{3,8}\b/)` — a
     * space-separated phrase. **`words` is a string ARRAY**, so a `...e.secret`
     * would put `"words":["dove","radar",…]` into the body and that regex would
     * not match one character of it. The rule was held by
     * `not.toHaveProperty('words')` alone; the phrase probe was decorative and
     * had been quoted as evidence for a round. The control below is what says
     * so: it fails if the probe cannot find the secret when the secret IS
     * there.
     *
     * The phrase form is kept as well, because a future field that joins the
     * words is the other way this leaves — and both forms are now controlled.
     */
    const asArray = (e: { secret: { words?: string[] } }) => JSON.stringify(e.secret.words);
    const asPhrase = (e: { secret: { words?: string[] } }) => e.secret.words!.join(' ');
    const raw = JSON.stringify(hired);
    for (const e of hired) expect(e.secret.words).toHaveLength(24);
    for (const e of hired) expect(raw).toContain(asArray(e));
    expect(asPhrase(hired[0])).toMatch(/\b(?:[a-z]{3,8} ){11,}[a-z]{3,8}\b/);

    const employees = seededEmployeesForHttp(hired);
    const body = JSON.stringify(employees);

    expect(employees.length).toBe(hired.length);
    /*
     * **THE FIELD LIST ITSELF, ASSERTED.** Without this the "somebody has to
     * type a line" half of the rule is watched by nothing: adding a fifth field
     * to the LISTED projection leaves every other assertion here green, which
     * this round's `test-auditor` measured. Now an addition has to be read and
     * re-approved rather than merely typed.
     */
    expect(Object.keys(employees[0]).sort())
      .toEqual(['employeeId', 'name', 'title', 'wrappingSecret']);
    for (const e of employees) {
      expect(e).not.toHaveProperty('words');
      /* And a wrapping secret really did come through — the SHAPE of one, which
       * is all this line checks; §4 below is what proves one opens a payslip. */
      expect(e.wrappingSecret).toMatch(/^[0-9a-f]{64}$/);
    }
    /* Neither form of the mnemonic is anywhere in the payload. */
    for (const e of hired) {
      expect(body).not.toContain(asArray(e));
      expect(body).not.toContain(asPhrase(e));
    }
    expect(body).not.toMatch(/\b(?:[a-z]{3,8} ){11,}[a-z]{3,8}\b/);
  });

  it('AN AD HOC PAYEE STILL GETS A MINTED KEY, AND THE TYPE SAYS SO', async () => {
    /*
     * **THE ONE PLACE `C135` IS STILL TRUE, PINNED SO IT CANNOT SPREAD
     * QUIETLY.** An ad hoc run pays somebody with no roster entry, so there is
     * no handover, no wallet and nothing to derive from. The secret is returned
     * once and `words` is ABSENT — which is the difference being visible in the
     * type rather than in a comment.
     */
    const h = world();
    const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
    const { secrets } = await h.payroll.createRun(account.id, '2026-07', [
      { name: 'Vendor', asset: 'GBP', amount: 50_00n },
    ], viewingKey);

    expect(secrets).toHaveLength(1);
    expect(secrets[0].wrappingSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets[0].words).toBeUndefined();
  });
});

describe('§3 — THE KEY OPENS THIS PERSON\'S PAYSLIP AND NOTHING ELSE OPENS IT', () => {
  it('A COMPANY\'S OWN KEYS DO NOT OPEN A PAYSLIP — not the viewing key, not a signer\'s',
    async () => {
      /*
       * **THE ONE THAT MATTERS.** Decided 23 Aug: the architecture stands as
       * it is. The employer holds the viewing key that opens the
       * roster, the runs and the policy, and it must not open one payslip.
       * `scripts/mutate-payslip-key.mjs` 05 wraps the slip key to a company-held
       * key instead of the payee's, and this is what dies.
       */
      const h = world();
      const { account, viewingKey, secrets } = await h.accounts.create('Acme', SIGNERS, 1);
      const { employee } = h.payroll.hireDirect(account.id, {
        name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
      }, viewingKey);
      const { run } = await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);

      expect(() => h.payroll.employeeView(run.id, employee.id, viewingKey))
        .toThrow(/that key cannot open this payslip/);
      expect(() => h.payroll.employeeView(run.id, employee.id, secrets[0].wrappingSecret))
        .toThrow(/that key cannot open this payslip/);
    });

  it('ANOTHER PERSON\'S DERIVED KEY DOES NOT OPEN IT EITHER', async () => {
    /*
     * `scripts/mutate-payslip-key.mjs` 04 takes the person's own key out of the
     * expansion, so every employee derives the same keypair. This is what
     * notices — and it notices through the real product path rather than by
     * comparing two derivations, because equal keys are only a defect once
     * somebody's payslip opens with the wrong one.
     */
    const h = world();
    const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
    const dana = h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
    const sam = h.payroll.hireDirect(account.id, {
      name: 'Sam', email: 's@a.co', title: 'Design', asset: 'GBP', baseAmount: 200_00n,
    }, viewingKey);
    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);

    expect(h.payroll.employeeView(run.id, dana.employee.id, dana.secret.wrappingSecret)
      .payslip).toBeTruthy();
    expect(h.payroll.employeeView(run.id, sam.employee.id, sam.secret.wrappingSecret)
      .payslip).toBeTruthy();

    /*
     * **BOTH DIRECTIONS, AND THE SECOND ONE IS NOT SYMMETRY FOR ITS OWN SAKE.**
     * A run seals slips in roster order, so a defect that wraps every slip to
     * the FIRST payee's key leaves the first person's own slip working
     * perfectly — and a test that only ever reads downwards would pass while
     * everybody else's pay was readable by one colleague.
     * `scripts/mutate-payslip-key.mjs` 05 is exactly that, and this line is
     * what dies.
     */
    expect(() =>
      h.payroll.employeeView(run.id, dana.employee.id, sam.secret.wrappingSecret))
      .toThrow(/that key cannot open this payslip/);
    expect(() =>
      h.payroll.employeeView(run.id, sam.employee.id, dana.secret.wrappingSecret))
      .toThrow(/that key cannot open this payslip/);
  });

  it('AND A KEY DERIVED FOR ANOTHER COMPANY DOES NOT OPEN IT', async () => {
    /*
     * The same wallet, the same person, the wrong company. This is what stops
     * one employer's released key becoming a skeleton key across every employer
     * that person has ever had.
     */
    const h = world();
    const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
    const { employee, secret } = h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);

    const elsewhere = payslipKeypairForWallet(secret.words!, 'b2'.repeat(32), ORIGIN);
    expect(() => h.payroll.employeeView(run.id, employee.id, elsewhere.secret))
      .toThrow(/that key cannot open this payslip/);
  });

  it('THE EMPLOYER NEVER GENERATES THE EMPLOYEE\'S KEY ON THE REAL PATH', async () => {
    /*
     * `payroll.ts:221-223` says why: an employer that generated it could read
     * the slip. On the real path the roster entry is `pending` and carries NO
     * key at all until the person's own device sends a public half — so there
     * is a state, reachable and asserted, in which the company has hired
     * somebody and can seal nothing to them.
     */
    const h = world();
    const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
    const { employee } = h.payroll.invite(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, 'usr_ada');

    const onRoster = h.payroll.person(employee.id, viewingKey)!;
    expect(onRoster.status).toBe('pending');
    expect(onRoster.wrappingPublicKey).toBeNull();
    await expect(h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey))
      .rejects.toThrow(/Dana/);
  });
});

describe('§4 — A NEW DEVICE OPENS PAYSLIPS ISSUED BEFORE IT EXISTED', () => {
  it('A WALLET REBUILT FROM ITS WORDS ALONE OPENS A PAYSLIP ISSUED BEFORE THAT DEVICE EXISTED',
    async () => {
      /*
       * **THE TEST THIS ROUND IS JUDGED ON.** It is the whole difference
       * between a derived key and a stored one, and it is written as the
       * sequence it really is rather than as two derivations compared.
       *
       * DEVICE ONE hands over a public key derived from the person's wallet,
       * through the real onboarding — invite, accept, admit. The company then
       * issues a payslip. **Nothing about device one is carried forward past
       * that point except the twenty-four words**, which is what a person has
       * when their laptop is gone.
       */
      const h = world();
      const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
      const company = h.store.getAccount(account.id)!.contractAddress!;

      const words = TEST_MNEMONIC;
      const deviceOne = payslipKeypairForWallet(words, company, ORIGIN);

      const { employee, sentTo } = h.payroll.invite(account.id, {
        name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 6_200_00n,
      }, viewingKey, 'usr_ada');
      const dana = signIn(h.store, 'd@a.co');
      h.payroll.acceptInvite(h.invites.tokenFor(sentTo), handedOver(h, h.invites.tokenFor(sentTo), {
        /* ONLY THE PUBLIC HALF LEAVES THE DEVICE. */
        wrappingPublicKey: deviceOne.publicKey,
        address: A_PAYEE_ADDRESS,
      }), dana);
      h.payroll.admit(employee.id, viewingKey, 'usr_ada');

      const { run } = await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);

      /*
       * DEVICE TWO. A laptop that did not exist when that payslip was sealed,
       * holding nothing: no keyring, no bundle, no backup, no copy of
       * `deviceOne`. It is handed the words and the company's own address —
       * which is public, and which `companyForSession` would give it — and it
       * works the key out.
       */
      const secondDevice = payslipKeypairForWallet(words, company, ELSEWHERE);

      const view = h.payroll.employeeView(run.id, employee.id, secondDevice.secret);
      expect((view.payslip as { amount: bigint }).amount).toBe(6_200_00n);
      expect((view.payslip as { period: string }).period).toBe('2026-07');
      expect(view.runId).toBe(run.id);
    });

  it('AND A DIFFERENT WALLET ON THAT SECOND DEVICE OPENS NOTHING', async () => {
    /*
     * The other half of the same claim, and an absence test is worth nothing
     * without it: the one above would pass just as happily if `employeeView`
     * had stopped checking anything at all.
     */
    const h = world();
    const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
    const company = h.store.getAccount(account.id)!.contractAddress!;

    const { employee, sentTo } = h.payroll.invite(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 6_200_00n,
    }, viewingKey, 'usr_ada');
    h.payroll.acceptInvite(h.invites.tokenFor(sentTo), handedOver(h, h.invites.tokenFor(sentTo), {
      wrappingPublicKey: payslipKeypairForWallet(TEST_MNEMONIC, company, ORIGIN).publicKey,
      address: A_PAYEE_ADDRESS,
    }), signIn(h.store, 'd@a.co'));
    h.payroll.admit(employee.id, viewingKey, 'usr_ada');
    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);

    const somebodyElse = payslipKeypairForWallet(newWords(), company, ORIGIN);
    expect(() => h.payroll.employeeView(run.id, employee.id, somebodyElse.secret))
      .toThrow(/that key cannot open this payslip/);
    /* And a key that was never derived from anything at all. */
    expect(() => h.payroll.employeeView(run.id, employee.id, newWrappingKeypair().secret))
      .toThrow(/that key cannot open this payslip/);
  });
});
