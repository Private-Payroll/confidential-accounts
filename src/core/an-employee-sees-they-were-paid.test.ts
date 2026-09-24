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
import { sealHandover, openHandover, HANDOVER_SCHEMA } from './invite-handover.js';
import { sealToInbox } from './sealed-records.js';
import { openPayslip, payslipPublicKeyOf, NOT_YOUR_PAYSLIP } from './payslip-open.js';
import { assets as productAssets } from './assets.js';
import { payeeFor } from '../testing/payees.js';
import { registryWithTestPrivateForms, aVaultHolding } from '../testing/assets.js';
import type { AssetRegistry } from './assets.js';
import type { User } from './types.js';

/**
 * **A PAYEE OPENS THEIR OWN PAYSLIPS, AND ONLY THEIRS, WITH THE KEY THEIR
 * WALLET WORKS OUT - FROM THE COMPANY ADDRESS EACH SLIP NAMES.**
 *
 * Every key below comes from a wallet's own words through the real derivation,
 * named a company address, exactly as a payee's browser derives it.
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

/** A company whose address came from a chain, which is what a payslip key may be derived from. */
const company = async (h: H) => {
  const { account, viewingKey } = await h.accounts.create(
    'Acme', [{ name: 'Ada', role: 'admin' as const }], 1);
  const rec = h.accounts.require(account.id);
  (h.store as any).putAccount({ ...rec, addressSource: 'chain' });
  return { accountId: account.id, viewingKey, address: (rec.contractAddress as string).toLowerCase() };
};

/** Invited, accepted from their own wallet's key for `keyFrom`, and admitted. */
const hire = (
  h: H, c: { accountId: string; viewingKey: string }, who: string, amount: bigint,
  words: string[], keyFrom: string, byte: string,
) => {
  const email = `${who.toLowerCase()}@acme.example`;
  const { sentTo, employee } = h.payroll.invite(c.accountId, {
    name: who, email, title: 'Engineer', asset: 'GBP', baseAmount: amount,
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
    const dana = hire(h, c, 'Dana', 6_200_00n, newWords(), c.address, 'a1');
    const eli = hire(h, c, 'Eli', 4_800_00n, newWords(), c.address, 'b2');
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
      expect(opened.payslip.asset).toBe('GBP');
      expect(opened.payslip.period).toBe(s.period);
      expect(opened.issuedBy).toBe(c.address);
      /* And a colleague's key opens none of them. */
      expect(() => openPayslip(s, eli.keys.secret)).toThrow(NOT_YOUR_PAYSLIP);
    }
    /* Eli's are Eli's. */
    expect(h.payroll.payslipsFor(eli.keys.publicKey).map(s => openPayslip(s, eli.keys.secret).payslip.name))
      .toEqual(['Eli', 'Eli']);
    /* A key nobody was hired with has nothing. */
    expect(h.payroll.payslipsFor(payslipKeypairForWallet(newWords(), c.address, ORIGIN).publicKey))
      .toEqual([]);
  });

  it('WHAT THE SERVICE HANDS OVER IS CIPHERTEXT: NO NAME, NO AMOUNT, NO SECRET', async () => {
    const c = await company(h);
    const dana = hire(h, c, 'Dana Whitfield', 6_200_00n, newWords(), c.address, 'a1');
    await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);
    const handed = h.payroll.payslipsFor(dana.keys.publicKey);
    /* RED WHEN the slip is handed over opened, or with anything beside the run's own facts. */
    expect(handed).toHaveLength(1);
    expect(Object.keys(handed[0]).sort()).toEqual(
      ['issuedBy', 'period', 'runId', 'settledAt', 'slip', 'status', 'wiring', 'wrapped']);
    const text = JSON.stringify(handed);
    expect(text).not.toContain('Dana Whitfield');
    expect(text).not.toContain(dana.keys.secret);
  });

  it('THE HANDOVER CARRIES THE ADDRESS THE KEY CAME FROM, AND NOTHING ELSE NEW', async () => {
    const c = await company(h);
    const keys = payslipKeypairForWallet(newWords(), c.address, ORIGIN);
    /* Sealed directly, as a device that added a field by mistake would seal it. */
    const sealed = sealToInbox({
      schema: HANDOVER_SCHEMA,
      wrappingPublicKey: keys.publicKey, address: payeeFor('a1'.repeat(32), 'undeployed').bech32,
      confirmation: null, keyFrom: c.address.toUpperCase(), secret: keys.secret,
    }, h.accounts.require(c.accountId).inboxPublicKey);
    const opened = openHandover(sealed, c.accountId, c.viewingKey);
    /* RED WHEN the opened handover passes through whatever was sealed. */
    expect(JSON.stringify(opened)).not.toContain(keys.secret);
    expect(opened.keyFrom).toBe(c.address);
  });

  it('A PAYEE PAID WITHOUT BEING ON THE ROSTER FINDS THEIR SLIP WITH THE KEY THEY WERE HANDED', async () => {
    const c = await company(h);
    const { run, secrets } = await h.payroll.createRun(c.accountId, '2026-08', [
      { name: 'Kit', asset: 'GBP', amount: 1_00n },
    ], c.viewingKey);
    const [kit] = secrets;
    const found = h.payroll.payslipsFor(payslipPublicKeyOf(kit.wrappingSecret));
    /* RED WHEN the lookup reads the roster alone: a payee with no roster record finds nothing. */
    expect(found.map(s => s.runId)).toEqual([run.id]);
    expect(openPayslip(found[0], kit.wrappingSecret).payslip.name).toBe('Kit');
    /* No company address produced that key, so the slip names none. */
    expect(found[0].issuedBy).toBeNull();
  });
});

describe('a payslip still opens after its company moves to a new address', () => {
  it('EACH SLIP NAMES THE ADDRESS ITS KEY CAME FROM, AND THE OLD ADDRESS IS FOUND FROM THE NEW ONE', async () => {
    const h = harness();
    const c = await company(h);
    const words = newWords();
    const dana = hire(h, c, 'Dana', 6_200_00n, words, c.address, 'a1');
    await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);

    /* The company moves. */
    const moved = 'cd'.repeat(32);
    (h.store as any).putAccount({ ...h.accounts.require(c.accountId), contractAddress: moved });
    await h.payroll.createRunFromRoster(c.accountId, '2026-09', c.viewingKey);

    /*
     * A payee who knows the company only by its new address is told every
     * address its slips were sealed under. RED WHEN only the current address
     * comes back: the old one is never asked for and August stays closed.
     */
    const other = await company(h);
    const addresses = h.payroll.payslipAddressesOf(moved);
    expect(addresses).toContain(c.address);
    expect(addresses).toContain(moved);
    /* Asked by the old address, the same answer. RED WHEN only the current
     * address finds the company. */
    expect(h.payroll.payslipAddressesOf(c.address).sort()).toEqual(addresses.sort());
    /* RED WHEN the answer is every company's addresses rather than this one's. */
    expect(addresses).not.toContain(other.address);

    /*
     * Both slips, the one sealed before the move and the one after, name the
     * address Dana's key was worked out from. RED WHEN a slip names the
     * company's address at the time it was sealed: September says the new
     * address, and the wallet's key for that address opens nothing.
     */
    const all = h.payroll.payslipsFor(dana.keys.publicKey);
    expect(all.map(s => [s.period, s.issuedBy])).toEqual([['2026-09', c.address], ['2026-08', c.address]]);
    for (const s of all) {
      const fromTheWallet = payslipKeypairForWallet(words, s.issuedBy!, ORIGIN);
      expect(openPayslip(s, fromTheWallet.secret).payslip.name).toBe('Dana');
      /* The key for the new address is a different key, and opens neither. */
      expect(() => openPayslip(s, payslipKeypairForWallet(words, moved, ORIGIN).secret))
        .toThrow(NOT_YOUR_PAYSLIP);
    }
  });

  /** Invited and accepted from a key worked out from `keyFrom`; not yet admitted. */
  const accepted = (h: H, c: { accountId: string; viewingKey: string; address: string }, who: string, words: string[],
    keyFrom: string | undefined, byte: string) => {
    const email = `${who.toLowerCase()}@acme.example`;
    const { sentTo, employee } = h.payroll.invite(c.accountId, {
      name: who, email, title: 'Engineer', asset: 'GBP', baseAmount: 1_00n,
    }, c.viewingKey, 'usr_ada');
    const keys = payslipKeypairForWallet(words, keyFrom ?? c.address, ORIGIN);
    h.payroll.acceptInvite(h.invites.tokenFor(sentTo!), sealHandover({
      wrappingPublicKey: keys.publicKey, address: payeeFor(byte.repeat(32), 'undeployed').bech32,
      confirmation: null, ...(keyFrom === undefined ? {} : { keyFrom }),
    }, h.accounts.require(c.accountId).inboxPublicKey), signIn(h, email));
    return { id: employee.id, keys };
  };

  it('THE ADDRESS IS THE ONE THE PAYEE\'S DEVICE NAMED, EVEN IF THE COMPANY MOVED BEFORE ADMITTING THEM', async () => {
    const h = harness();
    const c = await company(h);
    hire(h, c, 'Dana', 1_00n, newWords(), c.address, 'a1');
    await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);
    const words = newWords();
    const eli = accepted(h, c, 'Eli', words, c.address, 'b2');
    /* The company moves between Eli's acceptance and the admission. */
    (h.store as any).putAccount({ ...h.accounts.require(c.accountId), contractAddress: 'ef'.repeat(32) });
    h.payroll.admit(eli.id, c.viewingKey, 'usr_ada');
    await h.payroll.createRunFromRoster(c.accountId, '2026-09', c.viewingKey);
    /* RED WHEN admission records the company's address at that moment rather
     * than the one the payee's key was worked out from. */
    const [slip] = h.payroll.payslipsFor(eli.keys.publicKey);
    expect(slip.issuedBy).toBe(c.address);
    expect(openPayslip(slip, payslipKeypairForWallet(words, slip.issuedBy!, ORIGIN).secret).payslip.name)
      .toBe('Eli');
  });

  it('A HANDOVER WITH NO ADDRESS IS TAKEN AS THE ADDRESS AT ADMISSION, AND KEEPS IT AFTER A MOVE', async () => {
    const h = harness();
    const c = await company(h);
    const words = newWords();
    const old = accepted(h, c, 'Dana', words, undefined, 'a1');
    h.payroll.admit(old.id, c.viewingKey, 'usr_ada');
    (h.store as any).putAccount({ ...h.accounts.require(c.accountId), contractAddress: 'ef'.repeat(32) });
    await h.payroll.createRunFromRoster(c.accountId, '2026-09', c.viewingKey);
    /* RED WHEN nothing is recorded at admission: the slip then names the address
     * after the move, which is not the one the key came from. */
    const [slip] = h.payroll.payslipsFor(old.keys.publicKey);
    expect(slip.issuedBy).toBe(c.address);
  });

  it('A KEY WORKED OUT FROM AN ADDRESS THAT IS NOT THIS COMPANY\'S IS REFUSED AT ADMISSION', async () => {
    const h = harness();
    const c = await company(h);
    const stranger = '77'.repeat(32);
    const eve = accepted(h, c, 'Eve', newWords(), stranger, 'c3');
    /* RED WHEN any well-formed address is taken: every colleague's page would
     * then ask their wallet about somebody else's contract. */
    expect(() => h.payroll.admit(eve.id, c.viewingKey, 'usr_ada')).toThrow(/is not this company's address/);
    expect(h.payroll.payslipAddressesOf(c.address)).not.toContain(stranger);
    /* And the invitation is put back, so accepting again is possible. */
    expect(h.store.listInvites(c.accountId).find(i => i.subjectId === eve.id)?.acceptedAt).toBeUndefined();
  });

  it('A HANDOVER THAT NAMES SOMETHING OTHER THAN A COMPANY ADDRESS IS REFUSED', async () => {
    const h = harness();
    const c = await company(h);
    const sealed = sealHandover({
      wrappingPublicKey: 'ab'.repeat(32), address: payeeFor('a1'.repeat(32), 'undeployed').bech32,
      confirmation: null, keyFrom: 'not-an-address',
    }, h.accounts.require(c.accountId).inboxPublicKey);
    /* RED WHEN the field is stored as it came. */
    expect(() => openHandover(sealed, c.accountId, c.viewingKey)).toThrow(/is not a company address/);
  });
});

describe('a payee in an asset that cannot be paid on Midnight is refused at hiring', () => {
  it('REFUSED AT THE INVITATION AND AT SELF-PAYEE, NAMING WHY; TAKEN IN AN ASSET THAT CAN BE PAID', async () => {
    /* The product's own registry, where GBP has no form on Midnight. */
    const h = harness(productAssets);
    const c = await company(h);
    /* RED WHEN the refusal is removed: the invitation is made in GBP. */
    expect(() => h.payroll.invite(c.accountId, {
      name: 'Dana', email: 'dana@acme.example', title: 'Engineer', asset: 'GBP', baseAmount: 1n,
    }, c.viewingKey, 'usr_ada')).toThrow(/nobody can be hired in GBP\. GBP has no form on Midnight/);
    expect(h.store.listEmployees(c.accountId)).toHaveLength(0);

    const me = signIn(h, 'ada@acme.example');
    (h.store as any).putAccount({ ...h.accounts.require(c.accountId), memberUserIds: [me] });
    expect(() => h.payroll.addSelfAsPayee(c.accountId, me, {
      name: 'Ada', email: null, title: 'Founder', asset: 'USD', baseAmount: 1n,
    }, c.viewingKey, {
      wrappingPublicKey: 'ab'.repeat(32), address: payeeFor('a1'.repeat(32), 'undeployed'),
    })).toThrow(/nobody can be hired in USD/);
    expect(h.store.listEmployees(c.accountId)).toHaveLength(0);

    /* The test token has a private form and is taken. */
    expect(() => h.payroll.invite(c.accountId, {
      name: 'Eli', email: 'eli@acme.example', title: 'Engineer', asset: 'TESTUSD', baseAmount: 1n,
    }, c.viewingKey, 'usr_ada')).not.toThrow();
  });
});
