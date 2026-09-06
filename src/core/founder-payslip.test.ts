import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newWords } from 'midnight-identity';
import { FileStore } from './store-file.js';
import { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } from './ledger.js';
import { AccountService } from './account.js';
import { PayrollService, RecordingInviteDelivery } from './payroll.js';
import { payslipKeypairForWallet } from './payslip-key.js';
import { payeeFor } from '../testing/payees.js';
import type { User } from './types.js';

/**
 * **THE FIRST MONEY PATH THIS PRODUCT HAS EVER HAD, WALKED END TO END.**
 * `docs/NEXT.md` X7 §2.
 *
 * A company is made, ONE person becomes payable, payroll runs, and that person
 * opens their payslip. **No second person, no invitation, no mailer and no
 * token.** Until this file existed nobody had ever been paid by this product
 * and no payslip had ever been opened — every existing test walks a PIECE of
 * that and none of them walks the whole of it, which is how a path can be green
 * in every part and broken between them.
 *
 * ── WHY IT IS A TEST AND NOT A SCREENSHOT WALK ───────────────────────────
 *
 * §2 asks for the walk in a test *"not by hand"*, and the reason is in the last
 * assertion: **that the COMPANY cannot open the employee's payslip.** A person
 * clicking through the product can see that a payslip opens; nobody can see
 * that another key does not. That negative is the product's whole claim and it
 * is only checkable from here.
 *
 * ── WHAT IS SIMULATED, SAID OUT LOUD ─────────────────────────────────────
 *
 * The WALLET. `payslipKeypairForWallet` is the wallet's own derivation, walked
 * with its own code from `midnight-identity` — the same call `hireDirect` makes
 * for a seeded employee — so the keypair here is the one a real wallet would
 * release for this company and not a fixture standing in for it. **What is not
 * simulated is the sealing**: every seal, wrap and refusal below is production
 * code with production keys.
 *
 * What is NOT simulated and could not be is the founder's EMAIL. `X7` §1 says
 * the founder has signed in with their wallet; a wallet sign-in has no email,
 * and `addSelfAsPayee` refuses one by name. So the founder here signs
 * in the way the product supports TODAY — with an email — and the wall that
 * puts in front of a wallet-signed-in founder is reported, not worked around.
 */

const ORIGIN = 'https://payroll.example';

const harness = () => {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-x7-')), 'db.json'));
  const ledger = new SimulatedLedger(SimulatedCommitments);
  const accounts = new AccountService(store, ledger, SimulatedCommitments);
  const payroll = new PayrollService(
    store, accounts, new SimulatedProofSystem(), undefined, 'undeployed',
    new RecordingInviteDelivery());
  return { store, accounts, payroll };
};

/**
 * The founder's sign-in. An EMAIL one, because that is the only kind
 * `addSelfAsPayee` will serve — see the header, and `§3` below, which pins the
 * refusal rather than leaving it as a reading.
 */
const signIn = (store: { putUser: (u: User) => void }, email: string): string => {
  const id = 'usr_' + email.replace(/[^a-z0-9]/gi, '_');
  store.putUser({
    id, email, name: email, keyBundle: null,
    keyBundleVersion: 0, identityPublicKey: null, walletKey: null,
    createdAt: '2026-08-23T00:00:00.000Z',
  } as User);
  return id;
};

describe('a founder pays themselves — the first end-to-end money path', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  /**
   * Makes a company, puts the founder on it, and hands back everything the walk
   * needs — including the twenty-four words a wallet would hold, because the
   * whole point of the derivation is that they are the only durable input.
   */
  const company = async () => {
    const { account, viewingKey } = await h.accounts.create(
      'Solo', [{ name: 'Founder', role: 'admin' as const }], 1);
    const founder = signIn(h.store, 'founder@solo.example');
    (h.store as any).putAccount({
      ...h.accounts.require(account.id), memberUserIds: [founder],
    });
    const address = h.accounts.require(account.id).contractAddress;
    /*
     * A company with no address cannot derive anybody a payslip key, and
     * `hireDirect` refuses by name rather than minting one. If this ever goes
     * null the walk below would be testing a state the product refuses, so it
     * is asserted here rather than discovered three steps later.
     */
    expect(address, 'the ledger assigned this company no address').toBeTruthy();
    return { account, viewingKey, founder, company: address as string, words: newWords() };
  };

  it('§2 THE WALK: one payable person, a run, and a payslip they can read', async () => {
    const { account, viewingKey, founder, company: addr, words } = await company();

    /*
     * **THE KEYPAIR IS THE WALLET'S, DERIVED.** This is the call
     * the screen makes — `payslipKeypairFrom` over the key the wallet released —
     * reached here through the words, so the test can play the second device
     * further down.
     */
    const wallet = payslipKeypairForWallet(words, addr, ORIGIN);

    const me = h.payroll.addSelfAsPayee(account.id, founder, {
      name: 'The Founder', email: 'ignored — read off the sign-in', title: 'Founder',
      asset: 'GBP', baseAmount: 5_500_00n,
    }, viewingKey, {
      wrappingPublicKey: wallet.publicKey,
      address: payeeFor('a1'.repeat(32), 'undeployed'),
    });

    /* Payable immediately: no token ever existed, so there was nothing to
     * deliver and nothing to intercept. */
    expect(me.status).toBe('active');
    /* And the record is about the CALLER, whatever the body said. */
    expect(me.email).toBe('founder@solo.example');

    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-08', viewingKey);

    /* ── THE PAYSLIP OPENS, WITH THE KEY THE WALLET DERIVED ──────────────── */
    const mine = h.payroll.employeeView(run.id, me.id, wallet.secret);
    const slip = mine.payslip as { name: string; amount: bigint; asset: string; period: string };
    expect(slip.name).toBe('The Founder');
    expect(slip.amount).toBe(5_500_00n);
    expect(slip.asset).toBe('GBP');
    expect(slip.period).toBe('2026-08');

    /*
     * ── AND THE COMPANY CANNOT OPEN IT. THIS IS THE PRODUCT'S WHOLE CLAIM ──
     *
     * Decided 23 Aug: the architecture stands as it is. For an audit
     * a company REGENERATES a payslip from the run it already holds; it never
     * opens the employee's copy. The account viewing key opens the sealed
     * roster, the sealed run and the sealed proposals — and it is not the key
     * this slip is wrapped to, so it does not open this.
     *
     * Asserted on the MESSAGE and not merely on "it threw": a refusal for the
     * wrong reason — a missing run, a missing slip — would satisfy a bare
     * `toThrow()` while the guarantee was gone.
     */
    expect(() => h.payroll.employeeView(run.id, me.id, viewingKey))
      .toThrow('that key cannot open this payslip');

    /*
     * ── AND A SECOND DEVICE OPENS IT, WHICH IS WHY THE KEY IS DERIVED ─────
     *
     * The same words and the same company address, at a DIFFERENT origin,
     * because the wallet gates on the origin and derives from the company
     * alone. Nothing was carried from the first device: no secret was stored,
     * sent or kept anywhere in the walk above.
     */
    const secondDevice = payslipKeypairForWallet(words, addr, 'https://elsewhere.example');
    expect(h.payroll.employeeView(run.id, me.id, secondDevice.secret).payslip)
      .toEqual(mine.payslip);
  });

  /**
   * **THE WALL `X7` RAN INTO, AND IT IS DOWN.**
   *
   * `X7` described a founder who signed in with their WALLET and pinned the
   * refusal instead of working around it: `addSelfAsPayee`'s defence was that
   * the email on the record was the caller's own, and a wallet sign-in has
   * none. **The repair was never a check** — it was the type. `RosterEmployee.
   * email` is `string | null`, null means *nothing ever asked them for one*,
   * and the cap keys on the sign-in that set the address instead.
   *
   * **THE EMPTY STRING IS STILL WRONG AND IS STILL PINNED**, one test down.
   */
  const walletFounder = async (id = 'usr_wallet_founder', key = 'ab') => {
    const made = await company();
    h.store.putUser({
      id, email: null, name: '',
      keyBundle: null, keyBundleVersion: 0, identityPublicKey: null,
      walletKey: 'wk_' + key.repeat(16), createdAt: '2026-08-23T00:00:00.000Z',
    } as unknown as User);
    (h.store as any).putAccount({
      ...h.accounts.require(made.account.id), memberUserIds: [id],
    });
    return { ...made, walletOnly: id };
  };

  it('§3 A WALLET SIGN-IN CAN BE MADE PAYABLE, AND IS PAID', async () => {
    const { account, viewingKey, company: addr, words, walletOnly } = await walletFounder();
    const wallet = payslipKeypairForWallet(words, addr, ORIGIN);

    const me = h.payroll.addSelfAsPayee(account.id, walletOnly, {
      /* Nothing on this route says anything about an email, and the service
       * reads the caller's own — which is `null`, because nothing ever asked
       * them for one. */
      name: 'The Founder', email: null, title: 'Founder', asset: 'GBP', baseAmount: 5_500_00n,
    }, viewingKey, {
      wrappingPublicKey: wallet.publicKey,
      address: payeeFor('b2'.repeat(32), 'undeployed'),
    });

    expect(me.status).toBe('active');
    /* **NULL, NOT BLANK.** A blank is what inverts the cap. */
    expect(me.email).toBeNull();
    /* And the record says whose it is by the sign-in that set the address. */
    expect(me.handedOverBy).toBe(walletOnly);

    /* AND THE MONEY PATH RUNS TO THE END: a payslip they can open. */
    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-08', viewingKey);
    expect(h.payroll.paymentFactsFor(run.id, viewingKey)[0]!.payee.bech32)
      .toBe(me.address!.bech32);
    const slip = h.payroll.employeeView(run.id, me.id, wallet.secret)
      .payslip as { name: string; amount: bigint };
    expect(slip.name).toBe('The Founder');
    expect(slip.amount).toBe(5_500_00n);
  });

  it('§3 AND ONE PAYABLE ENTRY PER PERSON, WITH NO EMAIL TO KEY ON', async () => {
    /*
     * **THE CAP IS THE WHOLE OF §3 AND A GREEN SUITE HERE IS WORTH NOTHING
     * WITHOUT IT.** `docs/NEXT.md` X8 §3: *two payable entries for one person
     * must be refused.* The email cannot do it — there is none — so the cap
     * keys on the sign-in that set the address, and a second call from the same
     * sign-in is a second salary.
     */
    const { account, viewingKey, company: addr, words, walletOnly } = await walletFounder();
    const spec = {
      name: 'The Founder', email: null, title: 'Founder',
      asset: 'GBP', baseAmount: 5_500_00n,
    };
    const hand = (b: string) => ({
      wrappingPublicKey: payslipKeypairForWallet(words, addr, ORIGIN).publicKey,
      address: payeeFor(b.repeat(32), 'undeployed'),
    });
    h.payroll.addSelfAsPayee(account.id, walletOnly, spec, viewingKey, hand('b2'));
    expect(() => h.payroll.addSelfAsPayee(account.id, walletOnly, spec, viewingKey, hand('b3')))
      .toThrow(/already payable on this account/);
    expect(h.payroll.listPeople(account.id, viewingKey).filter(p => p.status === 'active'))
      .toHaveLength(1);
  });

  it('§3 AND TWO DIFFERENT WALLET SIGN-INS ARE TWO PEOPLE, NOT ONE', async () => {
    /*
     * **THE OTHER DIRECTION, AND IT IS THE ONE A BLANK WOULD HAVE BROKEN.**
     * `X7` pinned that an empty string inverts the cap: two absences compare
     * equal, so the SECOND wallet founder on a company would have been refused
     * as a duplicate of the first, and the first would have read as somebody
     * else. Null never meets null here — the cap compares two emails only when
     * both records have one.
     */
    const first = await walletFounder('usr_wallet_one', 'a1');
    const { account, viewingKey, company: addr, words } = first;
    const second = 'usr_wallet_two';
    h.store.putUser({
      id: second, email: null, name: '',
      keyBundle: null, keyBundleVersion: 0, identityPublicKey: null,
      walletKey: 'wk_' + 'c3'.repeat(16), createdAt: '2026-08-23T00:00:00.000Z',
    } as unknown as User);
    (h.store as any).putAccount({
      ...h.accounts.require(account.id),
      memberUserIds: [first.walletOnly, second],
    });
    const spec = (name: string) => ({
      name, email: null, title: 'Founder', asset: 'GBP', baseAmount: 100_00n,
    });
    const hand = (b: string) => ({
      wrappingPublicKey: payslipKeypairForWallet(words, addr, ORIGIN).publicKey,
      address: payeeFor(b.repeat(32), 'undeployed'),
    });
    h.payroll.addSelfAsPayee(account.id, first.walletOnly, spec('One'), viewingKey, hand('d1'));
    expect(h.payroll.addSelfAsPayee(account.id, second, spec('Two'), viewingKey, hand('d2'))
      .status).toBe('active');
    expect(h.payroll.listPeople(account.id, viewingKey).filter(p => p.status === 'active'))
      .toHaveLength(2);
  });

  it('§3 AND AN EMPTY STRING IS NOT AN EMAIL — `X7`\'s pin, kept', async () => {
    /*
     * **A BLANK INVERTS THE CAP, AND THE PLACE IT IS REFUSED IS NOT A CHECK IN
     * `addSelfAsPayee`.** The email on the record is read off the caller's own
     * sign-in and never off the body, so a blank cannot reach the record
     * through this door however hard a caller pushes: the spec's email is
     * overwritten. This is that, asserted rather than read.
     */
    const { account, viewingKey, company: addr, words, walletOnly } = await walletFounder();
    const me = h.payroll.addSelfAsPayee(account.id, walletOnly, {
      name: 'The Founder', email: '', title: 'Founder', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, {
      wrappingPublicKey: payslipKeypairForWallet(words, addr, ORIGIN).publicKey,
      address: payeeFor('b4'.repeat(32), 'undeployed'),
    });
    expect(me.email).toBeNull();
    expect(me.email).not.toBe('');

    /* AND THE OTHER DOOR REFUSES ONE BY NAME. An invitation is addressed to
     * somebody, and neither a blank nor a null names anybody. */
    expect(() => h.payroll.invite(account.id, {
      name: 'Nobody', email: '', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, walletOnly)).toThrow(/names nobody/);
    expect(() => h.payroll.invite(account.id, {
      name: 'Nobody', email: null, title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, walletOnly)).toThrow(/names nobody/);
  });
});
