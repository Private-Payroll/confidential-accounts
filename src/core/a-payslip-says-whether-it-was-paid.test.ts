import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newWords } from 'midnight-identity';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { FileStore } from './store-file.js';
import { SimulatedLedger } from './ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { AccountService } from './account.js';
import { PayrollService, RecordingInviteDelivery } from './payroll.js';
import { payslipKeypairForWallet } from './payslip-key.js';
import { sealHandover } from './invite-handover.js';
import { openPayslip, NOT_YOUR_PAYSLIP, type SealedPayslip } from './payslip-open.js';
import { SLIPS_ARE_NOT_ITS_PEOPLE } from './run-raising.js';
import { toHex, randomBytes, unwrapKey, unseal, type Hex } from './crypto.js';
import { runMaterialFor, type RunMaterial } from '../midnight/run-material.js';
import { paidMovementOfLeaf, payoutLeafOf } from '../midnight/payout-tree.js';
import { movementOfPayslip, type PayslipCircuits } from 'vaults-web-shared/payslip-movement.js';
import { vaultDetails } from '../testing/vault-details.js';
import { payeeFor } from '../testing/payees.js';
import { registryWithTestPrivateForms, aVaultHolding } from '../testing/assets.js';
import { fetchMyPayslips, paymentsOnTheChain, type Fetch } from 'vaults-web-shared/my-payslips.js';
import type { ChainReader } from 'vaults-web-shared/payslip-worker-client.js';

/** The compiled contracts' own circuits, as the device's reader calls them. */
const CIRCUITS: PayslipCircuits = { details: vaultDetails, leafOf: payoutLeafOf, movementOf: paidMovementOfLeaf };
/** Every slip's address taken as confirmed by the payee's wallet; what an unconfirmed one reads is pinned elsewhere. */
const CONFIRMED = () => true;
import type { User } from './types.js';
import { payFor } from '../testing/payees.js';

import { runLegOf } from './payroll.js';
import { TEST_TOKEN, OTHER_TEST_TOKEN } from '../testing/assets.js';
/**
 * **EACH PAYSLIP SAYS WHETHER IT WAS PAID - "RECORDED AS PAID", "NOT YET" OR
 * "CANNOT TELL" - FROM WHAT THE PAYEE'S OWN DEVICE READ, AND ONLY ITS PAYEE CAN
 * OPEN IT.**
 *
 * Every payee below is hired through the real invitation, with a key their own
 * wallet's words work out for the company's address, and every run is raised
 * with material built by the real tree builder. The service is the product's
 * own `PayrollService`, reached through a stand-in for the wire that records
 * every request the page makes. The device's own read of the contract is a
 * stand-in answering from a list of completed payments per company address:
 * the worker that really reads it is held against the compiled contract in
 * `contracts/test/a-retried-payment-reads-paid.test.ts`.
 */

const ORIGIN = 'https://payroll.example';
/** Inside every window these runs are raised with. */
const NOW = 1_800_000_000;
const CLOSES = 1_800_086_400;
const INDEXER = {
  indexerUri: 'https://indexer.example/api/v4/graphql',
  indexerWsUri: 'wss://indexer.example/api/v4/graphql/ws',
};
const VAULT = toHex(new Uint8Array(32).fill(0xa1));

/** The registry the service pays from here, and so the one the page reads a slip's token from. */
const REGISTRY = registryWithTestPrivateForms();
const harness = () => {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-paid-or-not-')), 'db.json'));
  const registry = REGISTRY;
  const accounts = new AccountService(
    store, new SimulatedLedger(MidnightCommitments), MidnightCommitments, registry, aVaultHolding());
  const invites = new RecordingInviteDelivery();
  const payroll = new PayrollService(store, accounts, registry, 'undeployed', invites);
  return { store, accounts, payroll, invites };
};
type H = ReturnType<typeof harness>;

const company = async (h: H, name = 'Acme') => {
  const created = await h.accounts.create(name, [{ name: 'Ada', role: 'admin' as const }], 1, undefined, drawCompanyLabel());
  const rec = h.accounts.require(created.account.id);
  h.store.putAccount({ ...rec, addressSource: 'chain' } as typeof rec);
  return {
    accountId: created.account.id, viewingKey: created.viewingKey,
    by: created.secrets[0]!.signerId, address: (rec.contractAddress as string).toLowerCase(),
    label: rec.companyLabel!,
  };
};
type C = Awaited<ReturnType<typeof company>>;

let people = 0;
/** Invited, accepted with whatever public key the handover carries, and admitted. */
const hireWithKey = (h: H, c: C, who: string, publicKey: Hex, keyFrom: string, asset = TEST_TOKEN) => {
  people += 1;
  const email = `${who.toLowerCase()}${people}@acme.example`;
  const { sentTo, employee } = h.payroll.invite(c.accountId, {
    name: who, email, title: 'Engineer', asset, baseAmount: 100_00n,
  }, c.viewingKey, 'usr_ada');
  const userId = 'usr_' + people;
  h.store.putUser({
    id: userId, email, name: email, keyBundle: null, keyBundleVersion: 0, walletKey: null,
    createdAt: '2026-09-24T00:00:00.000Z',
  } as User);
  h.payroll.acceptInvite(h.invites.tokenFor(sentTo!), sealHandover({
    wrappingPublicKey: publicKey,
    address: payeeFor((people.toString(16).padStart(2, '0')).repeat(32), 'undeployed').bech32,
    confirmation: null, keyFrom,
  }, h.accounts.require(c.accountId).inboxPublicKey), userId);
  h.payroll.admit(employee.id, c.viewingKey, 'usr_ada');
  return employee.id;
};
const hire = (h: H, c: C, who: string, asset = TEST_TOKEN) => {
  const keys = payslipKeypairForWallet(newWords(), c.label, ORIGIN);
  return { id: hireWithKey(h, c, who, keys.publicKey, c.label, asset), keys };
};

/** The period's run, drawn from the roster and raised with real material. */
const raise = async (h: H, c: C, period: string): Promise<{ runId: string; material: RunMaterial }> => {
  const { run } = await h.payroll.createRunFromRoster(c.accountId, period, c.viewingKey);
  return { runId: run.id, material: await raiseLeg(h, c, run.id) };
};

/** One leg of a run already drawn up, raised with real material. */
const raiseLeg = async (h: H, c: C, runId: string, asset?: string): Promise<RunMaterial> => {
  const inputs = await h.payroll.runMaterialInputs(runId, c.viewingKey, asset);
  const material = await runMaterialFor({
    accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: inputs.facts, pay: inputs.pay, asset: inputs.asset,
    opensAt: BigInt(NOW), closesAt: BigInt(CLOSES), vault: VAULT, detailsOf: vaultDetails,
  });
  await h.payroll.proposeRun(runId, c.viewingKey, c.by, material, asset);
  return material;
};

/** The months this file's runs are drawn for, newest first, which is how a payee's page asks for them. */
const PERIODS = ['2026-09', '2026-08', '2026-07'] as const;

/** What a payee's device does: asks for every slip of the company's months, newest first, and keeps those its key opens. */
const slipsOf = (h: H, label: string, secret: Hex, periods: readonly string[] = PERIODS): SealedPayslip[] =>
  periods.flatMap((period) => h.payroll.payslipsOf(label, period)).filter((s) => {
    try { openPayslip(s, secret); return true; } catch (e) { if ((e as Error).message !== NOT_YOUR_PAYSLIP) throw e; return false; }
  });

/** What the device read at one company address: its completed payments, or `null` when it could not read. */
type Record = (company: string) => Hex[] | null;

/**
 * The wire, as the page meets it. Payslips come from the service's own
 * `payslipsOf`, every slip of the company's month. `everyCompany` stands for
 * a service that sends every company's slips for the month whatever label was
 * asked. **The service's own
 * list of completed payments answers `serviceSays`**, which a test sets to a
 * payment the contract does not hold, so a page that asked it and believed it
 * would show that slip paid. The device's own read answers from `paid`. Every
 * request, and every read, is kept.
 */
type Wired = Fetch & { reader: ChainReader; reads: Array<{ company: string; movements: Hex[] }> };
const wire = (h: H, paid: Record, opts: { everyCompany?: boolean; serviceSays?: Hex[] } = {}) => {
  const seen: Array<{ url: string; body: string; init: RequestInit | undefined }> = [];
  const reads: Wired['reads'] = [];
  const reader: ChainReader = {
    recorded: async (indexer, company, payments) => {
      expect(indexer).toEqual(INDEXER);
      /* What the device's worker does: each payment's recorded value, built with the contracts' own circuits. */
      const movements = payments.map(p => movementOfPayslip(CIRCUITS, p));
      reads.push({ company, movements });
      const list = paid(company);
      if (list === null) return null;
      const held = new Set(list.map(m => m.toLowerCase()));
      return movements.map(m => held.has(m.toLowerCase()));
    },
  };
  const fetcher: Fetch = async (url, init) => {
    const body = init?.body ? String(init.body) : '';
    seen.push({ url, body, init });
    if (url.startsWith('/api/payslips?')) {
      const q = new URLSearchParams(url.slice('/api/payslips?'.length));
      const period = q.get('period')!;
      const labels = opts.everyCompany
        ? [...new Set(Object.values(h.store.snapshot().accounts).map((a) => a.companyLabel).filter((l) => typeof l === 'string').map(String))]
        : [q.get('company')!];
      return new Response(JSON.stringify(labels.flatMap((l) => h.payroll.payslipsOf(l, period))));
    }
    if (url.startsWith('/api/payslips/paid?')) {
      /* The service's word. RED WHEN the page believes it. */
      return new Response(JSON.stringify({ known: true, movements: opts.serviceSays ?? [] }));
    }
    return new Response('{}', { status: 404 });
  };
  return { fetcher: Object.assign(fetcher, { reader, reads }) as Wired, seen, reads };
};

const listOf = (movements: Hex[]): Record => () => movements;

/** What the page shows for each of this person's slips, by period, read at `now`. */
const shown = async (
  fetcher: Wired, keys: { secret: Hex; publicKey: Hex }, from: C, now = NOW,
  /* The accounts the payee's wallet read the label off; left out, the account the company has now. */
  openedFor: string[] = [from.address],
) => {
  const opened = [];
  for (const period of PERIODS) opened.push(...(await fetchMyPayslips(keys, from.label, period, fetcher)).opened);
  const chain = await paymentsOnTheChain(opened, fetcher.reader, INDEXER, CONFIRMED, now, REGISTRY, openedFor);
  return Object.fromEntries(opened.map(s => [s.period, chain.get(s.runId)]));
};

describe('each payslip says whether it was paid, from the chain', () => {
  it('A PAID PAYSLIP READS "RECORDED AS PAID", AN UNPAID ONE "NOT YET" - WHATEVER THE SERVICE SAYS', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    const eli = hire(h, c, 'Eli');
    const { material } = await raise(h, c, '2026-08');
    /* Dana is first on the leg and Eli second, which is the order the leaves are in. */
    const paidDana = paidMovementOfLeaf(material.leaves[0]!);
    const { fetcher } = wire(h, listOf([toHex(randomBytes(32)), paidDana.toUpperCase()]),
      { serviceSays: [paidDana, paidMovementOfLeaf(material.leaves[1]!)] });
    /*
     * RED WHEN the receipt is sealed with another person's leaf, or the page
     * looks for something other than its own recorded value: Dana then reads
     * "not yet" and Eli "paid".
     */
    expect(await shown(fetcher, dana.keys, c)).toEqual({ '2026-08': 'paid' });
    /*
     * RED WHEN the page takes the service's list of completed payments, which
     * says Eli was paid: Eli then reads "paid" for a payment the contract does
     * not hold.
     */
    expect(await shown(fetcher, eli.keys, c)).toEqual({ '2026-08': 'not-yet' });
  });

  it('A CHAIN THAT COULD NOT BE READ READS "CANNOT TELL", NEVER "NOT YET"', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    await raise(h, c, '2026-08');
    const unreadable: Array<[string, Record]> = [
      ['the contract could not be read', () => null],
      ['the reader failed', () => { throw new TypeError('failed to fetch'); }],
    ];
    for (const [why, answer] of unreadable) {
      const { fetcher } = wire(h, answer);
      /* RED WHEN any of these is read as an empty list of completed payments. */
      expect(await shown(fetcher, dana.keys, c), why).toEqual({ '2026-08': 'cannot-tell' });
    }
    /* A reader that answers for a different number of payments than it was asked about. */
    const { fetcher } = wire(h, listOf([]));
    const short: ChainReader = { recorded: async () => [] };
    const mine = await fetchMyPayslips(dana.keys, c.label, '2026-08', fetcher);
    expect((await paymentsOnTheChain(mine.opened, short, INDEXER, CONFIRMED, NOW, REGISTRY, [c.address])).get(mine.opened[0]!.runId))
      .toBe('cannot-tell');
    /*
     * RED WHEN a wallet that named no indexer, or a page with no reader, reads
     * as not paid: there was then nothing read at all.
     */
    expect((await paymentsOnTheChain(mine.opened, fetcher.reader, null, CONFIRMED, NOW, REGISTRY, [c.address])).get(mine.opened[0]!.runId))
      .toBe('cannot-tell');
    expect((await paymentsOnTheChain(mine.opened, null, INDEXER, CONFIRMED, NOW, REGISTRY, [c.address])).get(mine.opened[0]!.runId))
      .toBe('cannot-tell');
    expect(fetcher.reads).toEqual([]);
  });

  it('A RECEIPT THAT NAMES NO COMPANY ADDRESS READS "CANNOT TELL"', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    await raise(h, c, '2026-08');
    const { fetcher, seen } = wire(h, listOf([]));
    const [slip] = (await fetchMyPayslips(dana.keys, c.label, '2026-08', fetcher)).opened;
    /* The run was raised while the company had no address to read the record at. */
    const noAddress = { ...slip!, receipt: { ...slip!.receipt!, company: null } };
    /* RED WHEN a receipt with nowhere to ask reads as not paid. */
    expect((await paymentsOnTheChain([noAddress], fetcher.reader, INDEXER, CONFIRMED, NOW, REGISTRY, [c.address])).get(slip!.runId)).toBe('cannot-tell');
    expect(fetcher.reads).toEqual([]);
    expect(seen.some(r => r.url.startsWith('/api/payslips/paid'))).toBe(false);
  });

  it('RAISING ONE LEG KEEPS THE OTHER LEG\'S RECEIPTS, AND SHOWS THE STORE NOTHING ABOUT WHO SHARES A LEG', async () => {
    const h = harness();
    const c = await company(h);
    const staff = [hire(h, c, 'Ann', TEST_TOKEN), hire(h, c, 'Ben', OTHER_TEST_TOKEN), hire(h, c, 'Cat', TEST_TOKEN), hire(h, c, 'Dev', OTHER_TEST_TOKEN)];
    const { run } = await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);
    const stored = () => h.store.getRun(run.id)!.payslips.map(p => JSON.stringify(p.receipt).length);
    const draft = stored();
    const eur = await raiseLeg(h, c, run.id, OTHER_TEST_TOKEN);
    const afterEur = stored();
    const pounds = await raiseLeg(h, c, run.id, TEST_TOKEN);
    /*
     * RED WHEN raising a leg writes receipts onto that leg's slips alone: the
     * store would then see which people share an asset. Every slip carries a
     * receipt of one length before, between and after the raises.
     */
    for (const lengths of [draft, afterEur, stored()]) expect(new Set(lengths).size).toBe(1);
    expect(afterEur).toEqual(draft);
    /* RED WHEN the second raise drops or replaces the first leg's receipts. */
    const answers = await Promise.all(staff.map(async p => {
      const { fetcher } = wire(h, listOf([paidMovementOfLeaf(eur.leaves[0]!), paidMovementOfLeaf(pounds.leaves[1]!)]));
      return (await shown(fetcher, p.keys, c))['2026-08'];
    }));
    /* Ben is first on the EUR leg and Cat second on the GBP leg. */
    expect(answers).toEqual(['not-yet', 'paid', 'paid', 'not-yet']);
  });

  it('A COMPANY THAT MOVES BETWEEN TWO LEGS SENDS EACH LEG\'S PAYEES TO THE RECORD IT WAS RAISED AT', async () => {
    const h = harness();
    const c = await company(h);
    const ben = hire(h, c, 'Ben', OTHER_TEST_TOKEN);
    const cat = hire(h, c, 'Cat', TEST_TOKEN);
    const { run } = await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);
    await raiseLeg(h, c, run.id, OTHER_TEST_TOKEN);
    const moved = 'cd'.repeat(32);
    h.store.putAccount({ ...h.accounts.require(c.accountId), contractAddress: moved });
    await raiseLeg(h, c, run.id, TEST_TOKEN);
    const receiptOf = (who: typeof ben) =>
      openPayslip(slipsOf(h, c.label, who.keys.secret)[0]!, who.keys.secret).receipt!;
    /* Both legs name the one label, which a company keeps wherever its account is. */
    expect(receiptOf(ben).label).toBe(c.label);
    expect(receiptOf(cat).label).toBe(c.label);
    /*
     * RED WHEN a later raise re-seals an earlier leg's receipts with the
     * company's address now: Ben would be sent to a record his payment was
     * never written to, and read "not yet" for money already paid.
     */
    expect(receiptOf(ben).company).toBe(c.address);
    expect(receiptOf(cat).company).toBe(moved);
    /*
     * The device reads each contract at the address its receipt names, and a
     * contract a company moved away from is still on the chain to be read.
     */
    const both: Record = (at) => (at === c.address || at === moved ? [] : null);
    const forBen = wire(h, both).fetcher;
    const forCat = wire(h, both).fetcher;
    /*
     * The service names the account the company has now. A wallet that read
     * the label off both accounts sends each leg's payees to its own record.
     */
    expect(h.payroll.payslipAddressesOf(c.label)).toEqual([{ label: c.label, account: moved }]);
    const opened = [c.address, moved];
    expect((await shown(forBen, ben.keys, c, NOW, opened))['2026-08']).toBe('not-yet');
    /* RED WHEN a company that moved reads "cannot tell" for a leg raised at its new address. */
    expect((await shown(forCat, cat.keys, c, NOW, opened))['2026-08']).toBe('not-yet');
    expect(forBen.reads.map(r => r.company)).toEqual([c.address]);
    expect(forCat.reads.map(r => r.company)).toEqual([moved]);
    /* A page that did not open the new account reads nothing there, and cannot tell. */
    const unopened = wire(h, both).fetcher;
    expect((await shown(unopened, cat.keys, c))['2026-08']).toBe('cannot-tell');
    expect(unopened.reads).toEqual([]);
    /* Nor one that opened no account at all: a label locates no contract. RED WHEN the default reads one. */
    const none = wire(h, both).fetcher;
    const mine = await fetchMyPayslips(ben.keys, c.label, '2026-08', none);
    const chain = await paymentsOnTheChain(mine.opened, none.reader, INDEXER, CONFIRMED, NOW, REGISTRY);
    expect(chain.get(mine.opened[0]!.runId)).toBe('cannot-tell');
    expect(none.reads).toEqual([]);
  });

  it('A RECEIPT ANSWERS ONLY FOR THE SLIP IT WAS SEALED WITH', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    await raise(h, c, '2026-08');
    await raise(h, c, '2026-09');
    const [sep, aug] = slipsOf(h, c.label, dana.keys.secret);
    expect(openPayslip(aug!, dana.keys.secret).receipt?.runId).toBe(aug!.runId);
    /*
     * The service moves August's receipt onto September's slip. RED WHEN the
     * receipt is not bound to its run: September would then read as paid on
     * the strength of August's payment.
     */
    const swapped = { ...sep!, receipt: aug!.receipt };
    expect(openPayslip(swapped, dana.keys.secret).receipt).toBeNull();
    expect(openPayslip(sep!, dana.keys.secret).receipt?.runId).toBe(sep!.runId);
  });

  it('A SLIP NOT YET RAISED CARRIES A RECEIPT THAT NAMES NO PAYMENT, AND ASKS NOTHING', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);
    const { fetcher, seen } = wire(h, listOf([]));
    const mine = await fetchMyPayslips(dana.keys, c.label, '2026-08', fetcher);
    /* RED WHEN a draft goes out with no receipt, which tells the store its leg is not raised. */
    expect(mine.sealed[0]!.receipt).not.toBeNull();
    expect(mine.opened[0]!.receipt).toBeNull();
    expect((await paymentsOnTheChain(mine.opened, fetcher.reader, INDEXER, CONFIRMED, NOW, REGISTRY, [c.address])).size).toBe(0);
    expect(fetcher.reads).toEqual([]);
    expect(seen.some(r => r.url.startsWith('/api/payslips/paid'))).toBe(false);
  });
});

describe('nothing the page sends names which payment it opened', () => {
  it('NO REQUEST CARRIES THE LEAF, THE RECORDED VALUE OR THE SECRET', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    hire(h, c, 'Eli');
    const { material } = await raise(h, c, '2026-08');
    const { fetcher, seen } = wire(h, listOf([paidMovementOfLeaf(material.leaves[0]!)]));
    expect(await shown(fetcher, dana.keys, c)).toEqual({ '2026-08': 'paid' });

    const secretsOf = material.leaves.flatMap(l => [l, paidMovementOfLeaf(l)]);
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) {
      const said = (r.url + ' ' + r.body + ' ' + JSON.stringify(r.init?.headers ?? {})).toLowerCase();
      /*
       * The sign-in rides on every request, because the service answers a
       * signed-in person only. It goes to this page's own origin and nowhere
       * else. RED WHEN it is sent to any origin, or left off.
       */
      expect(r.init?.credentials, r.url).toBe('same-origin');
      /* RED WHEN the page asks about its own payment by its leaf or its recorded value. */
      for (const s of secretsOf) expect(said, r.url).not.toContain(s.toLowerCase());
      expect(said).not.toContain(dana.keys.secret.toLowerCase());
    }
    /*
     * RED WHEN the page asks the service whether anything was paid. What it
     * reads is the contract, on this device, by the company's address; the
     * values it looks for stay on the device.
     */
    expect(seen.filter(r => r.url.startsWith('/api/payslips/paid'))).toEqual([]);
    expect(fetcher.reads.map(r => r.company)).toEqual([c.address]);
    /* And the receipt reaches the service only as ciphertext. */
    const stored = JSON.stringify(h.store.snapshot().runs);
    for (const s of secretsOf) expect(stored).not.toContain(s.toLowerCase());
  });
});

describe('a company cannot put a payslip on the page of somebody who did not accept it', () => {
  it('A SLIP SEALED TO A STRANGER\'S KEY IS NOT SENT AS THE COMPANY\'S THEY ASKED FOR, AND NOT SHOWN IF IT IS', async () => {
    const h = harness();
    const acme = await company(h, 'Acme');
    const dana = hire(h, acme, 'Dana');
    await h.payroll.createRunFromRoster(acme.accountId, '2026-08', acme.viewingKey);

    /*
     * Another company learns Dana's payslip key for Acme and admits a roster
     * record carrying it, sealing the handover itself - the one party that
     * can, because the handover is sealed to its own inbox.
     */
    const other = await company(h, 'Other');
    hireWithKey(h, other, 'Dana', dana.keys.publicKey, other.label);
    await h.payroll.createRunFromRoster(other.accountId, '2026-09', other.viewingKey);
    /* The control: its slip really is sealed to Dana's key and opens with it. */
    expect(slipsOf(h, other.label, dana.keys.secret).map(s => openPayslip(s, dana.keys.secret).payslip.period)).toEqual(['2026-09']);

    /* RED WHEN the service sends another company's slips as the company asked for. */
    expect(slipsOf(h, acme.label, dana.keys.secret).map(s => s.period)).toEqual(['2026-08']);
    expect(h.payroll.payslipsOf(acme.label, '2026-09')).toEqual([]);
    const honest = wire(h, listOf([]));
    expect(Object.keys(await shown(honest.fetcher, dana.keys, acme))).toEqual(['2026-08']);

    /*
     * The same company telling a lie: it says Dana's key was worked out from
     * Acme's label, so its slip would name Acme. What stops it is admission,
     * which takes no label but the company's own. RED WHEN admission takes
     * any label it is handed: the stranger's slip then reaches Dana's page
     * past both filters.
     */
    expect(() => hireWithKey(h, other, 'Dana', dana.keys.publicKey, acme.label))
      .toThrow(/is not this company's label/);
    expect(Object.keys(await shown(honest.fetcher, dana.keys, acme))).toEqual(['2026-08']);

    /* And a service that sends it anyway: RED WHEN the page shows a slip naming another company. */
    const careless = wire(h, listOf([]), { everyCompany: true });
    const august = await fetchMyPayslips(dana.keys, acme.label, '2026-08', careless.fetcher);
    expect(august.opened.map(s => s.period)).toEqual(['2026-08']);
    const september = await fetchMyPayslips(dana.keys, acme.label, '2026-09', careless.fetcher);
    expect(september.opened).toEqual([]);
    expect(september.refused).toBe(1);
  });
});

describe('a company\'s month is every slip of its own runs for that month, and nothing says whose', () => {
  it('ONE COMPANY\'S MONTH OUT OF MANY: ITS OWN SLIPS ONLY, AND NOTHING BESIDE A SLIP NAMES A PERSON, A KEY OR A LABEL', async () => {
    const h = harness();
    const companies: C[] = [];
    for (let i = 0; i < 12; i++) companies.push(await company(h, `Co ${i}`));
    for (const c of companies) {
      hire(h, c, 'Someone');
      await h.payroll.createRunFromRoster(c.accountId, '2026-07', c.viewingKey);
    }
    const target = companies[5]!;
    const dana = hire(h, target, 'Dana');
    await h.payroll.createRunFromRoster(target.accountId, '2026-08', target.viewingKey);
    await h.payroll.createRunFromRoster(target.accountId, '2026-09', target.viewingKey);
    /* RED WHEN another company's slips, or another month's, are sent as this company's month. */
    expect(h.payroll.payslipsOf(target.label, '2026-07')).toHaveLength(1);
    expect(h.payroll.payslipsOf(target.label, '2026-08')).toHaveLength(2);
    expect(slipsOf(h, target.label, dana.keys.secret).map(s => s.period)).toEqual(['2026-09', '2026-08']);
    expect(slipsOf(h, companies[4]!.label, dana.keys.secret)).toEqual([]);
    /* RED WHEN anything the service keeps or sends of a slip names its person, its key or its label. */
    const kept = JSON.stringify(h.store.snapshot().runs).toLowerCase();
    const sent = JSON.stringify(PERIODS.flatMap(p => h.payroll.payslipsOf(target.label, p))).toLowerCase();
    for (const v of [dana.id, dana.keys.publicKey, target.label]) {
      expect(kept).not.toContain(v.toLowerCase());
      expect(sent).not.toContain(v.toLowerCase());
    }
    expect(h.payroll.payslipAddressesOf(target.label)).toEqual([{ label: target.label, account: target.address }]);
  });

  it('A RUN WHOSE SLIPS ARE NOT ONE TO EACH PERSON ITS SEALED RECORD NAMES IS NOT RAISED, AND NOTHING IS WRITTEN', async () => {
    const h = harness();
    const c = await company(h);
    hire(h, c, 'Dana');
    hire(h, c, 'Eli');
    const { run } = await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);
    const stored = h.store.getRun(run.id)!;
    /*
     * The store loses one slip, or carries one nobody's sealed entry names. RED WHEN the raise seals receipts beside
     * the slips there are by position alone, or leaves a slip nobody is named for without a receipt of its length.
     */
    for (const payslips of [stored.payslips.slice(0, 1), [...stored.payslips, stored.payslips[0]!]]) {
      h.store.putRun({ ...stored, payslips });
      const before = JSON.stringify(h.store.getRun(run.id));
      await expect(raiseLeg(h, c, run.id)).rejects.toThrow(SLIPS_ARE_NOT_ITS_PEOPLE);
      expect(JSON.stringify(h.store.getRun(run.id))).toBe(before);
    }
    /* The run as drawn is raised. */
    h.store.putRun(stored);
    await raiseLeg(h, c, run.id);
  });

  it('A COMPANY THAT MOVES IS FOUND BY ITS LABEL AT ITS ACCOUNT NOW, AND A STORE LOADED FROM ITS FILE ANSWERS THE SAME', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);
    expect(h.payroll.payslipAddressesOf(c.label)).toEqual([{ label: c.label, account: c.address }]);
    const moved = 'cd'.repeat(32);
    h.store.putAccount({ ...h.accounts.require(c.accountId), contractAddress: moved });
    /* RED WHEN the lookup answers with the account the company had before. */
    expect(h.payroll.payslipAddressesOf(c.label)).toEqual([{ label: c.label, account: moved }]);
    /* RED WHEN an account's address finds a company: the lookup is by label alone. */
    expect(h.payroll.payslipAddressesOf(moved)).toEqual([]);
    expect(h.payroll.payslipAddressesOf(c.address)).toEqual([]);
    /* The slip sealed before the move is still the company's month. */
    expect(slipsOf(h, c.label, dana.keys.secret).map(s => s.period)).toEqual(['2026-08']);
    /* A store emptied is asked about what it holds now; one read back from its file answers the same. */
    const again = new FileStore((h.store as any).path);
    expect(again.runsOfLabelFor(c.label, '2026-08')).toHaveLength(1);
    expect(again.accountsCarrying(c.label)).toEqual([c.accountId]);
    again.reset();
    expect(again.runsOfLabelFor(c.label, '2026-08')).toEqual([]);
    expect(again.accountsCarrying(c.label)).toEqual([]);
  });
});

describe('a payment that can no longer be made does not say "not yet"', () => {
  it('PAST THE END OF ITS WINDOW, AN UNRECORDED PAYMENT READS "CANNOT TELL"', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    await raise(h, c, '2026-08');
    const { fetcher } = wire(h, listOf([]));
    const [slip] = (await fetchMyPayslips(dana.keys, c.label, '2026-08', fetcher)).opened;
    /* The receipt carries the end of the window it can be paid in, sealed with it. */
    expect(slip!.receipt!.until).toBe(CLOSES);
    expect(await shown(fetcher, dana.keys, c, CLOSES - 1)).toEqual({ '2026-08': 'not-yet' });
    /*
     * RED WHEN a payment nothing can still make reads "not yet" for good: the
     * window has closed and no retry names Dana.
     */
    expect(await shown(fetcher, dana.keys, c, CLOSES)).toEqual({ '2026-08': 'cannot-tell' });
    /* A receipt that does not say when its window ends is never "not yet" either. */
    const noWindow = { ...slip!, receipt: { ...slip!.receipt!, until: null } };
    expect((await paymentsOnTheChain([noWindow], fetcher.reader, INDEXER, CONFIRMED, NOW, REGISTRY, [c.address])).get(slip!.runId))
      .toBe('cannot-tell');
  });
});

describe('what a payslip names cannot be changed by whoever holds the store', () => {
  it('A COMPANY LABEL A SERVICE WRITES BESIDE THE SEAL IS IGNORED, AND ANOTHER COMPANY\'S SLIP SENT AS ONE ASKED FOR IS REFUSED', async () => {
    const h = harness();
    const acme = await company(h, 'Acme');
    const dana = hire(h, acme, 'Dana');
    await h.payroll.createRunFromRoster(acme.accountId, '2026-08', acme.viewingKey);
    const [real] = slipsOf(h, acme.label, dana.keys.secret);
    expect(openPayslip(real!, dana.keys.secret).issuedBy).toBe(acme.label);
    /*
     * The slip was sealed naming Acme; a service writes another company's label
     * beside it. RED WHEN the page believes anything beside the seal: it shows
     * the slip as the other company's.
     */
    const other = 'co_' + 'ef'.repeat(32);
    const relabelled = { ...real!, issuedBy: other };
    expect(openPayslip(relabelled, dana.keys.secret).issuedBy).toBe(acme.label);
    /* A service that sends Acme's slips, labelled beside the seal, when asked for the other company's. */
    const w = wire(h, listOf([])).fetcher;
    const liar: Fetch = async (url, init) => {
      if (!url.startsWith('/api/payslips?')) return w(url, init);
      const answered = await w(url.replace(encodeURIComponent(other), encodeURIComponent(acme.label)), init);
      return new Response(JSON.stringify((await answered.json()).map((p: typeof real) => ({ ...p, issuedBy: other }))));
    };
    /* Asked for the other company's slips, the page refuses Acme's slip sent as one. */
    const mine = await fetchMyPayslips(dana.keys, other, '2026-08', liar);
    expect(mine.opened).toEqual([]);
    expect(mine.refused).toBe(1);
  });

  it('A RECEIPT FROM A COMPANY WITH NO ADDRESS IS THE SAME LENGTH AS ONE FROM A COMPANY WITH ONE', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    const a = await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);
    /* The same company, for a while with no address to read a record at. */
    h.store.putAccount({ ...h.accounts.require(c.accountId), contractAddress: 'none yet' });
    const b = await h.payroll.createRunFromRoster(c.accountId, '2026-09', c.viewingKey);
    const lengthOf = (runId: string) => h.store.getRun(runId)!.payslips.map(p => JSON.stringify(p.receipt).length);
    /*
     * RED WHEN a receipt naming no company is written shorter: the store could
     * then tell which receipts point at no record.
     */
    expect(lengthOf(b.run.id)).toEqual(lengthOf(a.run.id));
    /*
     * Raised there, the receipt is still that length, and it opens to a
     * receipt naming no company - which asks nothing and says it cannot tell.
     * RED WHEN what stands in for no company is read as a company's address.
     */
    await raiseLeg(h, c, b.run.id);
    expect(lengthOf(b.run.id)).toEqual(lengthOf(a.run.id));
    const { fetcher } = wire(h, listOf([]));
    const sep = slipsOf(h, c.label, dana.keys.secret).find(p => p.runId === b.run.id)!;
    const opened = openPayslip(sep, dana.keys.secret);
    expect(opened.receipt).not.toBeNull();
    expect(opened.receipt!.company).toBeNull();
    expect((await paymentsOnTheChain([opened], fetcher.reader, INDEXER, CONFIRMED, NOW, REGISTRY, [c.address])).get(b.run.id)).toBe('cannot-tell');
    expect(fetcher.reads).toEqual([]);
  });
});

describe('a leg is raised only with its payments in its people\'s order', () => {
  it('MATERIAL WHOSE PAYMENTS ARE IN ANOTHER ORDER IS REFUSED, AND NOTHING IS WRITTEN', async () => {
    const h = harness();
    const c = await company(h);
    hire(h, c, 'Dana');
    hire(h, c, 'Eli');
    const { run } = await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);
    const inputs = await h.payroll.runMaterialInputs(run.id, c.viewingKey);
    const reversed = await runMaterialFor({
      accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: [...inputs.facts].reverse(), pay: payFor([...inputs.facts].reverse()),
      asset: inputs.asset, opensAt: BigInt(NOW), closesAt: BigInt(CLOSES), vault: VAULT, detailsOf: vaultDetails,
    });
    const before = JSON.stringify(h.store.getRun(run.id));
    /*
     * RED WHEN the raise checks only how many payments there are: Dana's
     * receipt would then carry Eli's payment and Eli's Dana's.
     */
    await expect(h.payroll.proposeRun(run.id, c.viewingKey, c.by, reversed))
      .rejects.toThrow(/position 1 is not Dana's/);
    expect(JSON.stringify(h.store.getRun(run.id))).toBe(before);
    /* The same payments in the run's own order are raised. */
    await raiseLeg(h, c, run.id);
  });
});

describe('the device builds the value it looks for from what the payee holds, and a forged receipt or slip reads "not yet"', () => {
  /** A receipt as sealed, opened to its plain text: every field it carries, and nothing parsed away. */
  const receiptText = (h: H, who: { keys: { secret: Hex; publicKey: Hex } }, from: string): string => {
    const [sealed] = slipsOf(h, from, who.keys.secret);
    const r = sealed!.receipt!;
    return unseal(r.sealed, unwrapKey(r.wrapped, who.keys.secret));
  };

  it('A RECEIPT NAMING A PAID COLLEAGUE\'S NONCE AND BLINDING READS "NOT YET"', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    const eli = hire(h, c, 'Eli');
    const { material } = await raise(h, c, '2026-08');
    /* Eli, second on the leg, was paid. Dana was not. */
    const { fetcher } = wire(h, listOf([paidMovementOfLeaf(material.leaves[1]!)]));
    const [danas] = (await fetchMyPayslips(dana.keys, c.label, '2026-08', fetcher)).opened;
    const [elis] = (await fetchMyPayslips(eli.keys, c.label, '2026-08', fetcher)).opened;
    /* The control: Eli's own slip, with his own receipt, reads paid. */
    expect((await paymentsOnTheChain([elis!], fetcher.reader, INDEXER, CONFIRMED, NOW, REGISTRY, [c.address])).get(elis!.runId))
      .toBe('paid');
    /*
     * The service seals Eli's secrets onto Dana's slip. RED WHEN what the page
     * looks for does not bind the payee's own address: Dana would read paid on
     * the strength of Eli's payment (today's receipt, which carried the value
     * itself, did exactly that).
     */
    const forged = { ...danas!, receipt: { ...danas!.receipt!, nonce: elis!.receipt!.nonce, blinding: elis!.receipt!.blinding } };
    expect((await paymentsOnTheChain([forged], fetcher.reader, INDEXER, CONFIRMED, NOW, REGISTRY, [c.address])).get(danas!.runId))
      .toBe('not-yet');
  });

  it('A FORGED AMOUNT OR TOKEN READS "NOT YET", NEVER "RECORDED AS PAID"', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    const { material } = await raise(h, c, '2026-08');
    const { fetcher } = wire(h, listOf([paidMovementOfLeaf(material.leaves[0]!)]));
    const [slip] = (await fetchMyPayslips(dana.keys, c.label, '2026-08', fetcher)).opened;
    const read = async (s: typeof slip) =>
      (await paymentsOnTheChain([s!], fetcher.reader, INDEXER, CONFIRMED, NOW, REGISTRY, [c.address])).get(slip!.runId);
    expect(await read(slip)).toBe('paid');
    /* RED WHEN the amount is left out of what the device builds: a slip saying more reads paid. */
    expect(await read({ ...slip!, payslip: { ...slip!.payslip, amount: slip!.payslip.amount + 1n } })).toBe('not-yet');
    /* RED WHEN the token is left out: a slip naming another asset reads paid. */
    expect(await read({ ...slip!, payslip: { ...slip!.payslip, asset: OTHER_TEST_TOKEN } })).toBe('not-yet');
  });

  it('A SLIP WHOSE ADDRESS THE WALLET DID NOT CONFIRM READS "CANNOT TELL" AND ASKS NOTHING', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    const { material } = await raise(h, c, '2026-08');
    for (const recorded of [[paidMovementOfLeaf(material.leaves[0]!)], []]) {
      const { fetcher } = wire(h, listOf(recorded));
      const [slip] = (await fetchMyPayslips(dana.keys, c.label, '2026-08', fetcher)).opened;
      /* RED WHEN an unconfirmed address is asked about: it reads paid, or "not yet". */
      expect((await paymentsOnTheChain([slip!], fetcher.reader, INDEXER, () => false, NOW, REGISTRY, [c.address])).get(slip!.runId))
        .toBe('cannot-tell');
      /* A confirmation that throws is no confirmation. */
      expect((await paymentsOnTheChain([slip!], fetcher.reader, INDEXER, () => { throw new Error('x'); }, NOW, REGISTRY, [c.address]))
        .get(slip!.runId)).toBe('cannot-tell');
      expect(fetcher.reads).toEqual([]);
    }
  });

  it('EVERY RECEIPT IS ONE LENGTH AND CARRIES A NONCE AND A BLINDING, NEVER A SALT, A PATH OR A LEAF', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    const eli = hire(h, c, 'Eli');
    const { runId: aug } = await raise(h, c, '2026-08');
    await h.payroll.createRunFromRoster(c.accountId, '2026-09', c.viewingKey);
    const lengths = Object.values(h.store.snapshot().runs).flatMap(r => r.payslips.map(p => JSON.stringify(p.receipt).length));
    /* RED WHEN a raised receipt and a stand-in differ in length. */
    expect(new Set(lengths).size).toBe(1);
    const text = receiptText(h, dana, c.label);
    /* RED WHEN a field is added to the receipt, or the old leaf and value come back. */
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['blinding', 'company', 'label', 'nonce', 'runId', 'until']);
    /* RED WHEN the run's salt reaches the receipt. */
    const proposalId = h.payroll.requireRun(aug, c.viewingKey).proposalIds[runLegOf(TEST_TOKEN, 'shielded')]!;
    const salt = h.accounts.runSaltOf(proposalId, c.viewingKey);
    expect(text.toLowerCase()).not.toContain(salt.toLowerCase());
    expect(receiptText(h, eli, c.label).toLowerCase()).not.toContain(salt.toLowerCase());
  });

  it('A RETRY WRITTEN DOWN AND NEVER RAISED DOES NOT EXTEND "UNTIL"; ONCE RAISED IT DOES', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    const { runId } = await raise(h, c, '2026-08');
    const seeds = await h.accounts.payoutSeedsOf(c.accountId, c.viewingKey);
    const payKey = await h.accounts.payRecordKeyOf(c.accountId, c.viewingKey);
    const LATER = BigInt(CLOSES + 86_400);
    const run = h.payroll.requireRun(runId, c.viewingKey);
    const leg = run.payout![runLegOf(TEST_TOKEN, 'shielded')]!;
    leg.retries = [{
      originalIndices: [0], root: leg.root, payees: 1n, opensAt: BigInt(NOW), closesAt: LATER, vault: VAULT,
      proposedBy: c.by, at: '2026-09-25T00:00:00.000Z',
    } as NonNullable<typeof leg.retries>[number]];
    const untilOf = () => {
      const again = { ...run, payslips: (h.payroll as any).withReceipts(run, seeds, payKey) };
      (h.payroll as unknown as { putRun: (r: typeof again, k: Hex) => void }).putRun(again, c.viewingKey);
      return openPayslip(slipsOf(h, c.label, dana.keys.secret)[0]!, dana.keys.secret).receipt!.until;
    };
    /* RED WHEN a retry only written down extends the window: nothing raised can pay Dana after it closes. */
    expect(untilOf()).toBe(CLOSES);
    leg.retries[0]!.proposalId = 'raised-as-this';
    /* RED WHEN a raised retry does not extend it: Dana would read "cannot tell" while the retry can still pay her. */
    expect(untilOf()).toBe(Number(LATER));
  });
});
