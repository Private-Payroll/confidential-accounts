import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newWords } from 'midnight-identity';
import { drawCompanyLabel, readCompanyLabel, type CompanyLabel } from 'midnight-identity/profile/company-label';
import { FileStore } from './store-file.js';
import { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } from './ledger.js';
import { AccountService } from './account.js';
import { PayrollService, RecordingInviteDelivery } from './payroll.js';
import { payslipKeypairForWallet } from './payslip-key.js';
import { sealHandover, openHandover, HANDOVER_SCHEMA } from './invite-handover.js';
import { sealToInbox } from './sealed-records.js';
import { openPayslip, payslipPublicKeyOf, NOT_YOUR_PAYSLIP } from './payslip-open.js';
import { assets as productAssets } from './assets.js';
import { payeeFor } from '../testing/payees.js';
import { registryWithTestPrivateForms, aVaultHolding } from '../testing/assets.js';
import type { AssetRegistry } from './assets.js';
import type { User } from './types.js';

import { TEST_TOKEN, OTHER_TEST_TOKEN } from '../testing/assets.js';
import { TEST_SETTLEMENT_ASSET } from './assets.js';
/** The value, or a failure that says one was missing: an index that finds nothing is a broken test, not a value to carry on with. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value here, and there was none');
  return value;
}

/**
 * **A PAYEE OPENS THEIR OWN PAYSLIPS, AND ONLY THEIRS, WITH THE KEY THEIR
 * WALLET WORKS OUT - FROM THE COMPANY LABEL EACH SLIP NAMES.**
 *
 * Every key below comes from a wallet's own words through the real derivation,
 * named a company label, exactly as a payee's browser derives it.
 */

const ORIGIN = 'https://payroll.example';

const harness = (registry: AssetRegistry = registryWithTestPrivateForms()) => {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-paid-')), 'db.json'));
  const accounts = new AccountService(
    store, new SimulatedLedger(SimulatedCommitments), SimulatedCommitments, registry, aVaultHolding());
  const invites = new RecordingInviteDelivery();
  const payroll = new PayrollService(
    store, accounts, new SimulatedProofSystem(), registry, 'undeployed', invites);
  return { store, accounts, payroll, invites };
};
type H = ReturnType<typeof harness>;

const signIn = (h: H, email: string): string => {
  const id = 'usr_' + email.replace(/[^a-z0-9]/gi, '_');
  h.store.putUser({
    id, email, name: email, keyBundle: null, keyBundleVersion: 0, walletKey: null,
    createdAt: '2026-09-24T00:00:00.000Z',
  } as User);
  return id;
};

/** A company with a label, which is what a payslip key is derived from, and an account from a chain. */
const company = async (h: H) => {
  const { account, viewingKey } = await h.accounts.create(
    'Acme', [{ name: 'Ada', role: 'admin' as const }], 1, undefined, drawCompanyLabel());
  const rec = h.accounts.require(account.id);
  (h.store as any).putAccount({ ...rec, addressSource: 'chain' });
  return {
    accountId: account.id, viewingKey, address: (rec.contractAddress as string).toLowerCase(),
    label: rec.companyLabel!,
  };
};

/** Invited, accepted from their own wallet's key for `keyFrom`, and admitted. */
const hire = (
  h: H, c: { accountId: string; viewingKey: string }, who: string, amount: bigint,
  words: string[], keyFrom: CompanyLabel, byte: string,
) => {
  const email = `${who.toLowerCase()}@acme.example`;
  const { sentTo, employee } = h.payroll.invite(c.accountId, {
    name: who, email, title: 'Engineer', asset: TEST_TOKEN, baseAmount: amount,
  }, c.viewingKey, 'usr_ada');
  const token = h.invites.tokenFor(sentTo!);
  const keys = payslipKeypairForWallet(words, keyFrom, ORIGIN);
  const inbox = h.accounts.require(c.accountId).inboxPublicKey;
  h.payroll.acceptInvite(token, sealHandover({
    wrappingPublicKey: keys.publicKey,
    address: payeeFor(byte.repeat(32), 'undeployed').bech32,
    confirmation: null,
    keyFrom,
  }, inbox), signIn(h, email));
  h.payroll.admit(employee.id, c.viewingKey, 'usr_ada');
  return { id: employee.id, keys };
};

describe('an employee sees each payment made to them, and nobody else\'s', () => {
  let h: H;
  beforeEach(() => { h = harness(); });

  it('THE SLIPS FOR ONE KEY ARE THAT PERSON\'S, AND THEY OPEN WITH IT', async () => {
    const c = await company(h);
    const dana = hire(h, c, 'Dana', 6_200_00n, newWords(), c.label, 'a1');
    const eli = hire(h, c, 'Eli', 4_800_00n, newWords(), c.label, 'b2');
    await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);
    await h.payroll.createRunFromRoster(c.accountId, '2026-09', c.viewingKey);

    const danas = h.payroll.payslipsFor(dana.keys.publicKey);
    /*
     * RED WHEN the lookup returns the company's slips rather than this key's:
     * four slips, and Eli's two do not open with Dana's key.
     */
    expect(danas.map(s => s.period)).toEqual(['2026-09', '2026-08']);
    for (const s of danas) {
      const opened = openPayslip(s, dana.keys.secret);
      expect(opened.payslip.name).toBe('Dana');
      expect(opened.payslip.amount).toBe(6_200_00n);
      expect(opened.payslip.asset).toBe(TEST_TOKEN);
      expect(opened.payslip.period).toBe(s.period);
      expect(opened.issuedBy).toBe(c.label);
      /* And a colleague's key opens none of them. */
      expect(() => openPayslip(s, eli.keys.secret)).toThrow(NOT_YOUR_PAYSLIP);
    }
    /* Eli's are Eli's. */
    expect(h.payroll.payslipsFor(eli.keys.publicKey).map(s => openPayslip(s, eli.keys.secret).payslip.name))
      .toEqual(['Eli', 'Eli']);
    /* A key nobody was hired with has nothing. */
    expect(h.payroll.payslipsFor(payslipKeypairForWallet(newWords(), c.label, ORIGIN).publicKey))
      .toEqual([]);
  });

  it('WHAT THE SERVICE HANDS OVER IS CIPHERTEXT: NO NAME, NO AMOUNT, NO SECRET', async () => {
    const c = await company(h);
    const dana = hire(h, c, 'Dana Whitfield', 6_200_00n, newWords(), c.label, 'a1');
    await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);
    const handed = h.payroll.payslipsFor(dana.keys.publicKey);
    /* RED WHEN the slip is handed over opened, or with anything beside the run's own facts. */
    expect(handed).toHaveLength(1);
    expect(Object.keys(present(handed[0])).sort()).toEqual(
      ['issuedBy', 'period', 'receipt', 'runId', 'settledAt', 'slip', 'status', 'wiring', 'wrapped']);
    /* A draft has not been raised, so its receipt names no payment yet. */
    expect(openPayslip(present(handed[0]), dana.keys.secret).receipt).toBeNull();
    const text = JSON.stringify(handed);
    expect(text).not.toContain('Dana Whitfield');
    expect(text).not.toContain(dana.keys.secret);
  });

  it('THE HANDOVER CARRIES THE LABEL THE KEY CAME FROM, AND NOTHING ELSE NEW', async () => {
    const c = await company(h);
    const keys = payslipKeypairForWallet(newWords(), c.label, ORIGIN);
    /* Sealed directly, as a device that added a field by mistake would seal it. */
    const sealed = sealToInbox({
      schema: HANDOVER_SCHEMA,
      wrappingPublicKey: keys.publicKey, address: payeeFor('a1'.repeat(32), 'undeployed').bech32,
      confirmation: null, keyFrom: c.label, secret: keys.secret,
    }, h.accounts.require(c.accountId).inboxPublicKey);
    const opened = openHandover(sealed, c.accountId, c.viewingKey);
    /* RED WHEN the opened handover passes through whatever was sealed. */
    expect(JSON.stringify(opened)).not.toContain(keys.secret);
    expect(opened.keyFrom).toBe(c.label);
  });

  it('A PAYEE PAID WITHOUT BEING ON THE ROSTER FINDS THEIR SLIP WITH THE KEY THEY WERE HANDED', async () => {
    const c = await company(h);
    const { run, secrets } = await h.payroll.createRun(c.accountId, '2026-08', [
      { name: 'Kit', asset: TEST_TOKEN, amount: 1_00n },
    ], c.viewingKey);
    const [kit] = secrets;
    const found = h.payroll.payslipsFor(payslipPublicKeyOf(present(kit).wrappingSecret));
    /* RED WHEN the lookup reads the roster alone: a payee with no roster record finds nothing. */
    expect(found.map(s => s.runId)).toEqual([run.id]);
    expect(openPayslip(present(found[0]), present(kit).wrappingSecret).payslip.name).toBe('Kit');
    /* No company label produced that key, so the slip names none. */
    expect(present(found[0]).issuedBy).toBeNull();
  });
});

describe('a payslip still opens after its company moves to a new address', () => {
  it('EACH SLIP NAMES THE LABEL ITS KEY CAME FROM, AND THE LABEL FINDS THE ACCOUNT THE COMPANY HAS NOW', async () => {
    const h = harness();
    const c = await company(h);
    const words = newWords();
    const dana = hire(h, c, 'Dana', 6_200_00n, words, c.label, 'a1');
    await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);

    /* The company moves. */
    const moved = 'cd'.repeat(32);
    (h.store as any).putAccount({ ...h.accounts.require(c.accountId), contractAddress: moved });
    await h.payroll.createRunFromRoster(c.accountId, '2026-09', c.viewingKey);

    /*
     * A payee who knows the company by its label is told the account that
     * carries it now. RED WHEN the lookup answers with the account the company
     * had before, or with another company's.
     */
    const other = await company(h);
    expect(h.payroll.payslipAddressesOf(c.label)).toEqual([{ label: c.label, account: moved }]);
    /* RED WHEN an account's address finds a company: the lookup is by label alone. */
    expect(h.payroll.payslipAddressesOf(moved)).toEqual([]);
    expect(h.payroll.payslipAddressesOf(c.address)).toEqual([]);

    /*
     * Both slips, the one sealed before the move and the one after, name the
     * label Dana's key was worked out from. RED WHEN a slip names anything the
     * move changed.
     */
    const all = h.payroll.payslipsFor(dana.keys.publicKey);
    expect(all.map(s => [s.period, s.issuedBy])).toEqual([['2026-09', c.label], ['2026-08', c.label]]);
    for (const s of all) {
      const fromTheWallet = payslipKeypairForWallet(words, readCompanyLabel(s.issuedBy)!, ORIGIN);
      expect(openPayslip(s, fromTheWallet.secret).payslip.name).toBe('Dana');
      /* The key for another company's label is a different key, and opens neither. */
      expect(() => openPayslip(s, payslipKeypairForWallet(words, other.label, ORIGIN).secret))
        .toThrow(NOT_YOUR_PAYSLIP);
    }
  });

  /** Invited and accepted from a key worked out from `keyFrom`; not yet admitted. */
  const accepted = (h: H, c: { accountId: string; viewingKey: string; label: CompanyLabel }, who: string, words: string[],
    keyFrom: CompanyLabel | undefined, byte: string) => {
    const email = `${who.toLowerCase()}@acme.example`;
    const { sentTo, employee } = h.payroll.invite(c.accountId, {
      name: who, email, title: 'Engineer', asset: TEST_TOKEN, baseAmount: 1_00n,
    }, c.viewingKey, 'usr_ada');
    const keys = payslipKeypairForWallet(words, keyFrom ?? c.label, ORIGIN);
    h.payroll.acceptInvite(h.invites.tokenFor(sentTo!), sealHandover({
      wrappingPublicKey: keys.publicKey, address: payeeFor(byte.repeat(32), 'undeployed').bech32,
      confirmation: null, ...(keyFrom === undefined ? {} : { keyFrom }),
    }, h.accounts.require(c.accountId).inboxPublicKey), signIn(h, email));
    return { id: employee.id, keys };
  };

  it('THE LABEL IS THE ONE THE PAYEE\'S DEVICE NAMED, EVEN IF THE COMPANY MOVED BEFORE ADMITTING THEM', async () => {
    const h = harness();
    const c = await company(h);
    hire(h, c, 'Dana', 1_00n, newWords(), c.label, 'a1');
    await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);
    const words = newWords();
    const eli = accepted(h, c, 'Eli', words, c.label, 'b2');
    /* The company moves between Eli's acceptance and the admission. */
    (h.store as any).putAccount({ ...h.accounts.require(c.accountId), contractAddress: 'ef'.repeat(32) });
    h.payroll.admit(eli.id, c.viewingKey, 'usr_ada');
    await h.payroll.createRunFromRoster(c.accountId, '2026-09', c.viewingKey);
    /* RED WHEN admission records anything but the label the payee's key was worked out from. */
    const [slip] = h.payroll.payslipsFor(eli.keys.publicKey);
    expect(present(slip).issuedBy).toBe(c.label);
    expect(openPayslip(present(slip), payslipKeypairForWallet(words, readCompanyLabel(present(slip).issuedBy)!, ORIGIN).secret).payslip.name)
      .toBe('Eli');
  });

  it('A HANDOVER WITH NO LABEL IS TAKEN AS THE COMPANY\'S LABEL, AND KEEPS IT AFTER A MOVE', async () => {
    const h = harness();
    const c = await company(h);
    const words = newWords();
    const old = accepted(h, c, 'Dana', words, undefined, 'a1');
    h.payroll.admit(old.id, c.viewingKey, 'usr_ada');
    (h.store as any).putAccount({ ...h.accounts.require(c.accountId), contractAddress: 'ef'.repeat(32) });
    await h.payroll.createRunFromRoster(c.accountId, '2026-09', c.viewingKey);
    /* RED WHEN the slip names the account's address rather than the label the key came from. */
    const [slip] = h.payroll.payslipsFor(old.keys.publicKey);
    expect(present(slip).issuedBy).toBe(c.label);
    expect(openPayslip(present(slip), old.keys.secret).payslip.name).toBe('Dana');
  });

  it('A KEY WORKED OUT FROM A LABEL THAT IS NOT THIS COMPANY\'S IS REFUSED AT ADMISSION', async () => {
    const h = harness();
    const c = await company(h);
    const stranger = readCompanyLabel('co_' + '77'.repeat(32))!;
    const eve = accepted(h, c, 'Eve', newWords(), stranger, 'c3');
    /* RED WHEN any well-formed label is taken: every slip sealed to Eve would
     * then send her wallet to somebody else's company to open it. */
    expect(() => h.payroll.admit(eve.id, c.viewingKey, 'usr_ada')).toThrow(/is not this company's label/);
    expect(h.payroll.payslipAddressesOf(c.label).map(x => x.label)).toEqual([c.label]);
    /* And the invitation is put back, so accepting again is possible. */
    expect(h.store.listInvites(c.accountId).find(i => i.subjectId === eve.id)?.acceptedAt).toBeUndefined();
  });

  it('A HANDOVER THAT NAMES SOMETHING OTHER THAN A COMPANY LABEL IS REFUSED', async () => {
    const h = harness();
    const c = await company(h);
    /* RED WHEN the field is stored as it came; the account's own address among it. */
    for (const keyFrom of ['not-a-label', c.address, c.label.toUpperCase()]) {
      const sealed = sealHandover({
        wrappingPublicKey: 'ab'.repeat(32), address: payeeFor('a1'.repeat(32), 'undeployed').bech32,
        confirmation: null, keyFrom,
      }, h.accounts.require(c.accountId).inboxPublicKey);
      expect(() => openHandover(sealed, c.accountId, c.viewingKey), keyFrom).toThrow(/is not a company's label/);
    }
  });
});

describe('a payee in an asset that cannot be paid on Midnight is refused at hiring', () => {
  it('REFUSED AT THE INVITATION AND AT SELF-PAYEE, NAMING WHY; TAKEN IN AN ASSET THAT CAN BE PAID', async () => {
    /*
     * The product's own registry, which holds only tokens a vault can hold. A
     * token it does not hold (here the test fixture tokens, which only a test
     * registry carries) is money no vault of this product can pay.
     */
    const h = harness(productAssets);
    const c = await company(h);
    /* RED WHEN the refusal is removed: the invitation is made in a token no vault here can hold. */
    expect(() => h.payroll.invite(c.accountId, {
      name: 'Dana', email: 'dana@acme.example', title: 'Engineer', asset: TEST_TOKEN, baseAmount: 1n,
    }, c.viewingKey, 'usr_ada')).toThrow(`no asset in the registry is the token "${TEST_TOKEN}"`);
    expect(h.store.listEmployees(c.accountId)).toHaveLength(0);

    const me = signIn(h, 'ada@acme.example');
    (h.store as any).putAccount({ ...h.accounts.require(c.accountId), memberUserIds: [me] });
    expect(() => h.payroll.addSelfAsPayee(c.accountId, me, {
      name: 'Ada', email: null, title: 'Founder', asset: OTHER_TEST_TOKEN, baseAmount: 1n,
    }, c.viewingKey, {
      wrappingPublicKey: 'ab'.repeat(32), address: payeeFor('a1'.repeat(32), 'undeployed'),
    })).toThrow(`no asset in the registry is the token "${OTHER_TEST_TOKEN}"`);
    expect(h.store.listEmployees(c.accountId)).toHaveLength(0);

    /* The test token has a private form and is taken. */
    expect(() => h.payroll.invite(c.accountId, {
      name: 'Eli', email: 'eli@acme.example', title: 'Engineer', asset: TEST_SETTLEMENT_ASSET, baseAmount: 1n,
    }, c.viewingKey, 'usr_ada')).not.toThrow();
  });
});
