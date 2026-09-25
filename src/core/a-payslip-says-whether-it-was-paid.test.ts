import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newWords } from 'midnight-identity';
import { FileStore } from './store-file.js';
import { SimulatedLedger, SimulatedProofSystem } from './ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { AccountService } from './account.js';
import { PayrollService, RecordingInviteDelivery } from './payroll.js';
import { payslipKeypairForWallet } from './payslip-key.js';
import { sealHandover } from './invite-handover.js';
import { openPayslip } from './payslip-open.js';
import { wrapKey, toHex, randomBytes, unwrapKey, unseal, type Hex } from './crypto.js';
import { runMaterialFor, type RunMaterial } from '../midnight/run-material.js';
import { paidMovementOfLeaf, payoutLeafOf } from '../midnight/payout-tree.js';
import { movementOfPayslip, type PayslipCircuits } from '../web/payslip-movement.js';
import { vaultDetails } from '../testing/vault-details.js';
import { payeeFor } from '../testing/payees.js';
import { registryWithTestPrivateForms, aVaultHolding } from '../testing/assets.js';
import { fetchMyPayslips, paymentsOnTheChain, type Fetch } from '../web/my-payslips.js';
import type { ChainReader } from '../web/payslip-worker-client.js';

/** The compiled contracts' own circuits, as the device's reader calls them. */
const CIRCUITS: PayslipCircuits = { details: vaultDetails, leafOf: payoutLeafOf, movementOf: paidMovementOfLeaf };
/** Every slip's address taken as confirmed by the payee's wallet; what an unconfirmed one reads is pinned elsewhere. */
const CONFIRMED = () => true;
import { paidWords } from '../web/YourPay.js';
import type { User } from './types.js';

/**
 * **EACH PAYSLIP SAYS WHETHER IT WAS PAID - "RECORDED AS PAID", "NOT YET" OR
 * "CANNOT TELL" - FROM WHAT THE PAYEE'S OWN DEVICE READ, AND ONLY ITS PAYEE CAN
 * ASK.**
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
  const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), registry, 'undeployed', invites);
  return { store, accounts, payroll, invites };
};
type H = ReturnType<typeof harness>;

const company = async (h: H, name = 'Acme') => {
  const created = await h.accounts.create(name, [{ name: 'Ada', role: 'admin' as const }], 1);
  const rec = h.accounts.require(created.account.id);
  h.store.putAccount({ ...rec, addressSource: 'chain' } as typeof rec);
  return {
    accountId: created.account.id, viewingKey: created.viewingKey,
    by: created.secrets[0]!.signerId, address: (rec.contractAddress as string).toLowerCase(),
  };
};
type C = Awaited<ReturnType<typeof company>>;

let people = 0;
/** Invited, accepted with whatever public key the handover carries, and admitted. */
const hireWithKey = (h: H, c: C, who: string, publicKey: Hex, keyFrom: string, asset = 'GBP') => {
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
const hire = (h: H, c: C, who: string, asset = 'GBP') => {
  const keys = payslipKeypairForWallet(newWords(), c.address, ORIGIN);
  return { id: hireWithKey(h, c, who, keys.publicKey, c.address, asset), keys };
};

/** The period's run, drawn from the roster and raised with real material. */
const raise = async (h: H, c: C, period: string): Promise<{ runId: string; material: RunMaterial }> => {
  const { run } = await h.payroll.createRunFromRoster(c.accountId, period, c.viewingKey);
  return { runId: run.id, material: await raiseLeg(h, c, run.id) };
};

/** One leg of a run already drawn up, raised with real material. */
const raiseLeg = async (h: H, c: C, runId: string, asset?: 'GBP' | 'EUR'): Promise<RunMaterial> => {
  const inputs = await h.payroll.runMaterialInputs(runId, c.viewingKey, asset);
  const material = await runMaterialFor({
    accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: inputs.facts,
    opensAt: BigInt(NOW), closesAt: BigInt(CLOSES), vault: VAULT, detailsOf: vaultDetails,
  });
  await h.payroll.proposeRun(runId, c.viewingKey, c.by, material, asset);
  return material;
};

/** What the device read at one company address: its completed payments, or `null` when it could not read. */
type Record = (company: string) => Hex[] | null;

/**
 * The wire, as the page meets it. Payslips come from the service's own
 * `payslipsFor`, behind the same proof the route asks for. **The service's own
 * list of completed payments answers `serviceSays`**, which a test sets to a
 * payment the contract does not hold, so a page that asked it and believed it
 * would show that slip paid. The device's own read answers from `paid`. Every
 * request, and every read, is kept.
 */
type Wired = Fetch & { reader: ChainReader; reads: Array<{ company: string; movements: Hex[] }> };
const wire = (h: H, paid: Record, opts: { ignoreFrom?: boolean; serviceSays?: Hex[] } = {}) => {
  const seen: Array<{ url: string; body: string; init: RequestInit | undefined }> = [];
  let live: { publicKey: string; value: string } | null = null;
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
    const b = body ? JSON.parse(body) : {};
    if (url === '/api/payslips/proof') {
      live = { publicKey: b.publicKey, value: toHex(randomBytes(32)) };
      return new Response(JSON.stringify({ sealed: wrapKey(live.value, b.publicKey), expiresAt: '' }));
    }
    if (url === '/api/payslips') {
      const ok = live && live.publicKey === b.publicKey && live.value === b.answer;
      live = null;
      if (!ok) return new Response('{"error":"refused"}', { status: 403 });
      return new Response(JSON.stringify(
        opts.ignoreFrom ? h.payroll.payslipsFor(b.publicKey) : h.payroll.payslipsFor(b.publicKey, b.from)));
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
  fetcher: Wired, keys: { secret: Hex; publicKey: Hex }, from: string, now = NOW,
  /* The company addresses the page opened; left out, the address the slips were fetched for. */
  openedFor?: string[],
) => {
  const mine = await fetchMyPayslips(keys, from, fetcher);
  const chain = await paymentsOnTheChain(mine.opened, fetcher.reader, INDEXER, CONFIRMED, now, REGISTRY, openedFor);
  return Object.fromEntries(mine.opened.map(s => [s.period, chain.get(s.runId)]));
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
    expect(await shown(fetcher, dana.keys, c.address)).toEqual({ '2026-08': 'paid' });
    /*
     * RED WHEN the page takes the service's list of completed payments, which
     * says Eli was paid: Eli then reads "paid" for a payment the contract does
     * not hold.
     */
    expect(await shown(fetcher, eli.keys, c.address)).toEqual({ '2026-08': 'not-yet' });
    /* A rehearsal moved no money, whatever a list says. RED WHEN the chain's word overrides it. */
    expect(paidWords({ status: 'settled', settledAt: null, wiring: 'simulated' }, 'paid').paid)
      .toBe('No: a rehearsal, nothing was sent');
    expect(paidWords({ status: 'proposed', settledAt: null, wiring: 'chain' }, 'paid'))
      .toEqual({ paid: 'Recorded as paid', onChain: 'Yes' });
    expect(paidWords({ status: 'proposed', settledAt: null, wiring: 'chain' }, 'not-yet'))
      .toEqual({ paid: 'Not yet', onChain: 'Not yet' });
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
      expect(await shown(fetcher, dana.keys, c.address), why).toEqual({ '2026-08': 'cannot-tell' });
    }
    /* A reader that answers for a different number of payments than it was asked about. */
    const { fetcher } = wire(h, listOf([]));
    const short: ChainReader = { recorded: async () => [] };
    const mine = await fetchMyPayslips(dana.keys, c.address, fetcher);
    expect((await paymentsOnTheChain(mine.opened, short, INDEXER, CONFIRMED, NOW, REGISTRY)).get(mine.opened[0]!.runId))
      .toBe('cannot-tell');
    /*
     * RED WHEN a wallet that named no indexer, or a page with no reader, reads
     * as not paid: there was then nothing read at all.
     */
    expect((await paymentsOnTheChain(mine.opened, fetcher.reader, null, CONFIRMED, NOW, REGISTRY)).get(mine.opened[0]!.runId))
      .toBe('cannot-tell');
    expect((await paymentsOnTheChain(mine.opened, null, INDEXER, CONFIRMED, NOW, REGISTRY)).get(mine.opened[0]!.runId))
      .toBe('cannot-tell');
    expect(fetcher.reads).toEqual([]);
    /* RED WHEN "cannot tell" is put on the screen in the words for "not yet". */
    expect(paidWords({ status: 'proposed', settledAt: null, wiring: 'chain' }, 'cannot-tell'))
      .toEqual({ paid: 'Cannot tell', onChain: 'Not known' });
  });

  it('A RECEIPT THAT NAMES NO COMPANY ADDRESS READS "CANNOT TELL"', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    await raise(h, c, '2026-08');
    const { fetcher, seen } = wire(h, listOf([]));
    const [slip] = (await fetchMyPayslips(dana.keys, c.address, fetcher)).opened;
    /* The run was raised while the company had no address to read the record at. */
    const noAddress = { ...slip!, receipt: { ...slip!.receipt!, company: null } };
    /* RED WHEN a receipt with nowhere to ask reads as not paid. */
    expect((await paymentsOnTheChain([noAddress], fetcher.reader, INDEXER, CONFIRMED, NOW, REGISTRY)).get(slip!.runId)).toBe('cannot-tell');
    expect(fetcher.reads).toEqual([]);
    expect(seen.some(r => r.url.startsWith('/api/payslips/paid'))).toBe(false);
  });

  it('RAISING ONE LEG KEEPS THE OTHER LEG\'S RECEIPTS, AND SHOWS THE STORE NOTHING ABOUT WHO SHARES A LEG', async () => {
    const h = harness();
    const c = await company(h);
    const staff = [hire(h, c, 'Ann', 'GBP'), hire(h, c, 'Ben', 'EUR'), hire(h, c, 'Cat', 'GBP'), hire(h, c, 'Dev', 'EUR')];
    const { run } = await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);
    const stored = () => h.store.getRun(run.id)!.payslips.map(p => JSON.stringify(p.receipt).length);
    const draft = stored();
    const eur = await raiseLeg(h, c, run.id, 'EUR');
    const afterEur = stored();
    const pounds = await raiseLeg(h, c, run.id, 'GBP');
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
      return (await shown(fetcher, p.keys, c.address))['2026-08'];
    }));
    /* Ben is first on the EUR leg and Cat second on the GBP leg. */
    expect(answers).toEqual(['not-yet', 'paid', 'paid', 'not-yet']);
  });

  it('A COMPANY THAT MOVES BETWEEN TWO LEGS SENDS EACH LEG\'S PAYEES TO THE RECORD IT WAS RAISED AT', async () => {
    const h = harness();
    const c = await company(h);
    const ben = hire(h, c, 'Ben', 'EUR');
    const cat = hire(h, c, 'Cat', 'GBP');
    const { run } = await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);
    await raiseLeg(h, c, run.id, 'EUR');
    const moved = 'cd'.repeat(32);
    h.store.putAccount({ ...h.accounts.require(c.accountId), contractAddress: moved });
    await raiseLeg(h, c, run.id, 'GBP');
    const receiptOf = (who: typeof ben) =>
      openPayslip(h.payroll.payslipsFor(who.keys.publicKey, c.address)[0]!, who.keys.secret).receipt!;
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
    /* The page opens every address the company's slips were sealed under, and the one it has now. */
    const opened = h.payroll.payslipAddressesOf(c.address);
    expect(opened.sort()).toEqual([c.address, moved].sort());
    expect((await shown(forBen, ben.keys, c.address, NOW, opened))['2026-08']).toBe('not-yet');
    /* RED WHEN a company that moved reads "cannot tell" for a leg raised at its new address. */
    expect((await shown(forCat, cat.keys, c.address, NOW, opened))['2026-08']).toBe('not-yet');
    expect(forBen.reads.map(r => r.company)).toEqual([c.address]);
    expect(forCat.reads.map(r => r.company)).toEqual([moved]);
    /* A page that did not open the new address reads nothing there, and cannot tell. */
    const unopened = wire(h, both).fetcher;
    expect((await shown(unopened, cat.keys, c.address))['2026-08']).toBe('cannot-tell');
    expect(unopened.reads).toEqual([]);
  });

  it('A RECEIPT ANSWERS ONLY FOR THE SLIP IT WAS SEALED WITH', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    await raise(h, c, '2026-08');
    await raise(h, c, '2026-09');
    const [sep, aug] = h.payroll.payslipsFor(dana.keys.publicKey, c.address);
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
    const mine = await fetchMyPayslips(dana.keys, c.address, fetcher);
    /* RED WHEN a draft goes out with no receipt, which tells the store its leg is not raised. */
    expect(mine.sealed[0]!.receipt).not.toBeNull();
    expect(mine.opened[0]!.receipt).toBeNull();
    expect((await paymentsOnTheChain(mine.opened, fetcher.reader, INDEXER, CONFIRMED, NOW, REGISTRY)).size).toBe(0);
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
    expect(await shown(fetcher, dana.keys, c.address)).toEqual({ '2026-08': 'paid' });

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
  it('A SLIP SEALED TO A STRANGER\'S KEY IS NOT SENT TO THEM, AND NOT SHOWN IF IT IS', async () => {
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
    hireWithKey(h, other, 'Dana', dana.keys.publicKey, other.address);
    await h.payroll.createRunFromRoster(other.accountId, '2026-09', other.viewingKey);
    /* The control: its slip really is sealed to Dana's key and opens with it. */
    const everything = h.payroll.payslipsFor(dana.keys.publicKey);
    expect(everything.map(s => openPayslip(s, dana.keys.secret).payslip.period).sort())
      .toEqual(['2026-08', '2026-09']);

    /* RED WHEN the service sends every slip sealed to the key, whoever issued it. */
    expect(h.payroll.payslipsFor(dana.keys.publicKey, acme.address).map(s => s.period)).toEqual(['2026-08']);
    const honest = wire(h, listOf([]));
    expect(Object.keys(await shown(honest.fetcher, dana.keys, acme.address))).toEqual(['2026-08']);

    /*
     * The same company telling a lie: it says Dana's key was worked out from
     * Acme's address, so its slip would name Acme. What stops it is admission,
     * which takes no address but the company's own. RED WHEN admission takes
     * any address it is handed: the stranger's slip then reaches Dana's page
     * past both filters.
     */
    expect(() => hireWithKey(h, other, 'Dana', dana.keys.publicKey, acme.address))
      .toThrow(/is not this company's address/);
    expect(Object.keys(await shown(honest.fetcher, dana.keys, acme.address))).toEqual(['2026-08']);

    /* And a service that sends it anyway: RED WHEN the page shows a slip naming another company. */
    const careless = wire(h, listOf([]), { ignoreFrom: true });
    const mine = await fetchMyPayslips(dana.keys, acme.address, careless.fetcher);
    expect(mine.opened.map(s => s.period)).toEqual(['2026-08']);
    expect(mine.refused).toBe(1);
  });
});

describe('the payslip lookups read what they answer and not every record', () => {
  it('BY COUNT OF READS: NO LISTING, AND ONE RECORD READ PER RUN FOUND', async () => {
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
    /* The index is built on the first lookup, as it is once per process. */
    expect(h.payroll.payslipsFor(dana.keys.publicKey)).toHaveLength(1);

    /* From here every read of the three collections is counted. */
    const data = (h.store as any).data;
    const counts = { listed: 0, read: 0 };
    for (const name of ['accounts', 'runs', 'employees'] as const) {
      data[name] = new Proxy(data[name], {
        ownKeys: (t) => { counts.listed += 1; return Reflect.ownKeys(t); },
        get: (t, k, r) => { if (typeof k === 'string') counts.read += 1; return Reflect.get(t, k, r); },
      });
    }
    const listings = ['listAccounts', 'listRuns', 'listEmployees'] as const;
    const called: string[] = [];
    for (const m of listings) {
      const real = (h.store as any)[m].bind(h.store);
      (h.store as any)[m] = (...a: unknown[]) => { called.push(m); return real(...a); };
    }

    /* A second run for Dana, written after the index was built, is found too. */
    await h.payroll.createRunFromRoster(target.accountId, '2026-09', target.viewingKey);
    counts.listed = 0; counts.read = 0; called.length = 0;
    const found = h.payroll.payslipsFor(dana.keys.publicKey, target.address);
    expect(found.map(s => s.period)).toEqual(['2026-09', '2026-08']);
    /*
     * RED WHEN either lookup goes back to walking every account: thirteen
     * companies are listed and every run of each is read.
     */
    expect(called).toEqual([]);
    expect(counts.listed).toBe(0);
    expect(counts.read).toBe(2);

    counts.listed = 0; counts.read = 0;
    expect(h.payroll.payslipAddressesOf(target.address)).toEqual([target.address]);
    expect(called).toEqual([]);
    expect(counts.listed).toBe(0);
    /* One account record, read for its address now. */
    expect(counts.read).toBe(1);
  });

  it('A SLIP SEALED BEFORE SLIPS NAMED THEIR KEY IS FOUND BY THE ROSTER RECORD\'S KEY', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    const eli = hire(h, c, 'Eli');
    const { run } = await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);
    const stored = h.store.getRun(run.id)!;
    /* Written as a run from before `sealedTo` existed. */
    h.store.putRun({ ...stored, payslips: stored.payslips.map(({ sealedTo: _k, ...p }) => p) });
    /* RED WHEN the index finds slips only by the key they name. */
    const found = h.payroll.payslipsFor(dana.keys.publicKey, c.address);
    expect(found.map(s => openPayslip(s, dana.keys.secret).payslip.name)).toEqual(['Dana']);
    /* Each person's own slip only, out of the one run. */
    expect(h.payroll.payslipsFor(eli.keys.publicKey, c.address)
      .map(s => openPayslip(s, eli.keys.secret).payslip.name)).toEqual(['Eli']);
  });

  it('THE INDEX FOLLOWS A ROSTER KEY THAT CHANGES AFTER IT WAS BUILT', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    const { run } = await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);
    const stored = h.store.getRun(run.id)!;
    h.store.putRun({ ...stored, payslips: stored.payslips.map(({ sealedTo: _k, ...p }) => p) });
    expect(h.payroll.payslipsFor(dana.keys.publicKey)).toHaveLength(1);
    /* The roster record's key changes once the index exists. */
    const renewed = payslipKeypairForWallet(newWords(), c.address, ORIGIN);
    h.store.putEmployee({ ...h.store.getEmployee(dana.id)!, wrappingPublicKey: renewed.publicKey });
    /* RED WHEN a roster write is not applied to the index: the old key goes on finding the slip. */
    expect(h.payroll.payslipsFor(dana.keys.publicKey)).toEqual([]);
    expect(h.payroll.payslipsFor(renewed.publicKey)).toHaveLength(1);
  });

  it('THE INDEX FOLLOWS A COMPANY THAT MOVES, AND A STORE LOADED FROM ITS FILE', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);
    expect(h.payroll.payslipAddressesOf(c.address)).toEqual([c.address]);
    const moved = 'cd'.repeat(32);
    h.store.putAccount({ ...h.accounts.require(c.accountId), contractAddress: moved });
    /* RED WHEN the index keeps the old address as the company's address now. */
    expect(h.payroll.payslipAddressesOf(moved).sort()).toEqual([c.address, moved].sort());
    expect(h.store.accountsAtPayslipAddress(moved)).toEqual([c.accountId]);
    /* And the address it had before still finds it, for a payee who knows only that one. */
    expect(h.payroll.payslipAddressesOf(c.address).sort()).toEqual([c.address, moved].sort());
    /* A store emptied is asked about what it holds now. RED WHEN the index outlives its data. */
    const emptied = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-emptied-')), 'db.json'));
    for (const a of Object.values(h.store.snapshot().accounts)) emptied.putAccount(a);
    for (const r of Object.values(h.store.snapshot().runs)) emptied.putRun(r);
    expect(emptied.runsWithPayslipsSealedTo(dana.keys.publicKey)).toHaveLength(1);
    expect(emptied.accountsAtPayslipAddress(moved)).toEqual([c.accountId]);
    emptied.reset();
    expect(emptied.runsWithPayslipsSealedTo(dana.keys.publicKey)).toEqual([]);
    expect(emptied.accountsAtPayslipAddress(moved)).toEqual([]);
    /* A store read back from its file answers the same. */
    const again = new FileStore((h.store as any).path);
    expect(again.runsWithPayslipsSealedTo(dana.keys.publicKey)).toHaveLength(1);
    expect(again.accountsAtPayslipAddress(moved)).toEqual([c.accountId]);
  });
});

describe('a payment that can no longer be made does not say "not yet"', () => {
  it('PAST THE END OF ITS WINDOW, AN UNRECORDED PAYMENT READS "CANNOT TELL"', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    await raise(h, c, '2026-08');
    const { fetcher } = wire(h, listOf([]));
    const [slip] = (await fetchMyPayslips(dana.keys, c.address, fetcher)).opened;
    /* The receipt carries the end of the window it can be paid in, sealed with it. */
    expect(slip!.receipt!.until).toBe(CLOSES);
    expect(await shown(fetcher, dana.keys, c.address, CLOSES - 1)).toEqual({ '2026-08': 'not-yet' });
    /*
     * RED WHEN a payment nothing can still make reads "not yet" for good: the
     * window has closed and no retry names Dana.
     */
    expect(await shown(fetcher, dana.keys, c.address, CLOSES)).toEqual({ '2026-08': 'cannot-tell' });
    /* A receipt that does not say when its window ends is never "not yet" either. */
    const noWindow = { ...slip!, receipt: { ...slip!.receipt!, until: null } };
    expect((await paymentsOnTheChain([noWindow], fetcher.reader, INDEXER, CONFIRMED, NOW, REGISTRY)).get(slip!.runId))
      .toBe('cannot-tell');
  });
});

describe('what a payslip names cannot be changed by whoever holds the store', () => {
  it('A COMPANY ADDRESS SWAPPED BESIDE THE SEAL IS REFUSED BY THE PAGE, NOT SHOWN', async () => {
    const h = harness();
    const acme = await company(h, 'Acme');
    const dana = hire(h, acme, 'Dana');
    await h.payroll.createRunFromRoster(acme.accountId, '2026-08', acme.viewingKey);
    const [real] = h.payroll.payslipsFor(dana.keys.publicKey, acme.address);
    expect(openPayslip(real!, dana.keys.secret).issuedBy).toBe(acme.address);
    /*
     * The slip was sealed naming Acme; the store relabels it as another
     * company's. RED WHEN the page believes the label beside the seal: it
     * shows the slip as the other company's.
     */
    const other = 'ef'.repeat(32);
    const relabelled = { ...real!, issuedBy: other };
    expect(openPayslip(relabelled, dana.keys.secret).issuedBy).toBe(acme.address);
    /* A service that relabels every slip it sends as the other company's. */
    const w = wire(h, listOf([])).fetcher;
    const liar: Fetch = async (url, init) => {
      if (url !== '/api/payslips') return w(url, init);
      const body = JSON.parse(String(init!.body));
      const answered = await w(url, { ...init, body: JSON.stringify({ ...body, from: acme.address }) });
      return new Response(JSON.stringify((await answered.json()).map((p: typeof real) => ({ ...p, issuedBy: other }))));
    };
    /* Asked for the other company's slips, the page refuses Acme's slip relabelled as one. */
    const mine = await fetchMyPayslips(dana.keys, other, liar);
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
    const sep = h.payroll.payslipsFor(dana.keys.publicKey, c.address).find(p => p.runId === b.run.id)!;
    const opened = openPayslip(sep, dana.keys.secret);
    expect(opened.receipt).not.toBeNull();
    expect(opened.receipt!.company).toBeNull();
    expect((await paymentsOnTheChain([opened], fetcher.reader, INDEXER, CONFIRMED, NOW, REGISTRY)).get(b.run.id)).toBe('cannot-tell');
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
      accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: [...inputs.facts].reverse(),
      opensAt: BigInt(NOW), closesAt: BigInt(CLOSES), vault: VAULT, detailsOf: vaultDetails,
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

describe('the payslip index follows a rotation written after it was built', () => {
  it('A ROTATION THAT MOVES A SLIP\'S KEY AND THE COMPANY\'S ADDRESS IS FOLLOWED BY BOTH LOOKUPS', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    const { run } = await h.payroll.createRunFromRoster(c.accountId, '2026-08', c.viewingKey);
    /* The index is built. */
    expect(h.payroll.payslipsFor(dana.keys.publicKey)).toHaveLength(1);
    expect(h.payroll.payslipAddressesOf(c.address)).toEqual([c.address]);

    /* A real rotation of the company's key, which leaves every slip where it was. */
    await h.accounts.rotate(c.accountId, c.viewingKey);
    expect(h.payroll.payslipsFor(dana.keys.publicKey)).toHaveLength(1);

    /* A rotation that writes the slip to another key and the company at another address. */
    const renewed = payslipKeypairForWallet(newWords(), c.address, ORIGIN);
    const moved = 'cd'.repeat(32);
    const stored = h.store.getRun(run.id)!;
    h.store.commitRotation({
      account: { ...h.accounts.require(c.accountId), contractAddress: moved },
      employees: [],
      runs: [{ ...stored, payslips: stored.payslips.map(p => ({ ...p, sealedTo: renewed.publicKey })) }],
      proposals: [],
    });
    /*
     * RED WHEN the rotation's writes are not applied to the index: the old key
     * goes on finding the slip, and the company's address now is not known.
     */
    expect(h.payroll.payslipsFor(dana.keys.publicKey)).toEqual([]);
    expect(h.payroll.payslipsFor(renewed.publicKey)).toHaveLength(1);
    expect(h.store.accountsAtPayslipAddress(moved)).toEqual([c.accountId]);
    expect(h.payroll.payslipAddressesOf(moved).sort()).toEqual([c.address, moved].sort());
  });
});

describe('the device builds the value it looks for from what the payee holds, and a forged receipt or slip reads "not yet"', () => {
  /** A receipt as sealed, opened to its plain text: every field it carries, and nothing parsed away. */
  const receiptText = (h: H, who: { keys: { secret: Hex; publicKey: Hex } }, from: string): string => {
    const [sealed] = h.payroll.payslipsFor(who.keys.publicKey, from);
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
    const [danas] = (await fetchMyPayslips(dana.keys, c.address, fetcher)).opened;
    const [elis] = (await fetchMyPayslips(eli.keys, c.address, fetcher)).opened;
    /* The control: Eli's own slip, with his own receipt, reads paid. */
    expect((await paymentsOnTheChain([elis!], fetcher.reader, INDEXER, CONFIRMED, NOW, REGISTRY)).get(elis!.runId))
      .toBe('paid');
    /*
     * The service seals Eli's secrets onto Dana's slip. RED WHEN what the page
     * looks for does not bind the payee's own address: Dana would read paid on
     * the strength of Eli's payment (today's receipt, which carried the value
     * itself, did exactly that).
     */
    const forged = { ...danas!, receipt: { ...danas!.receipt!, nonce: elis!.receipt!.nonce, blinding: elis!.receipt!.blinding } };
    expect((await paymentsOnTheChain([forged], fetcher.reader, INDEXER, CONFIRMED, NOW, REGISTRY)).get(danas!.runId))
      .toBe('not-yet');
  });

  it('A FORGED AMOUNT OR TOKEN READS "NOT YET", NEVER "RECORDED AS PAID"', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    const { material } = await raise(h, c, '2026-08');
    const { fetcher } = wire(h, listOf([paidMovementOfLeaf(material.leaves[0]!)]));
    const [slip] = (await fetchMyPayslips(dana.keys, c.address, fetcher)).opened;
    const read = async (s: typeof slip) =>
      (await paymentsOnTheChain([s!], fetcher.reader, INDEXER, CONFIRMED, NOW, REGISTRY)).get(slip!.runId);
    expect(await read(slip)).toBe('paid');
    /* RED WHEN the amount is left out of what the device builds: a slip saying more reads paid. */
    expect(await read({ ...slip!, payslip: { ...slip!.payslip, amount: slip!.payslip.amount + 1n } })).toBe('not-yet');
    /* RED WHEN the token is left out: a slip naming another asset reads paid. */
    expect(await read({ ...slip!, payslip: { ...slip!.payslip, asset: 'EUR' } })).toBe('not-yet');
  });

  it('A SLIP WHOSE ADDRESS THE WALLET DID NOT CONFIRM READS "CANNOT TELL" AND ASKS NOTHING', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    const { material } = await raise(h, c, '2026-08');
    for (const recorded of [[paidMovementOfLeaf(material.leaves[0]!)], []]) {
      const { fetcher } = wire(h, listOf(recorded));
      const [slip] = (await fetchMyPayslips(dana.keys, c.address, fetcher)).opened;
      /* RED WHEN an unconfirmed address is asked about: it reads paid, or "not yet". */
      expect((await paymentsOnTheChain([slip!], fetcher.reader, INDEXER, () => false, NOW, REGISTRY)).get(slip!.runId))
        .toBe('cannot-tell');
      /* A confirmation that throws is no confirmation. */
      expect((await paymentsOnTheChain([slip!], fetcher.reader, INDEXER, () => { throw new Error('x'); }, NOW, REGISTRY))
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
    const text = receiptText(h, dana, c.address);
    /* RED WHEN a field is added to the receipt, or the old leaf and value come back. */
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['blinding', 'company', 'nonce', 'runId', 'until']);
    /* RED WHEN the run's salt reaches the receipt. */
    const proposalId = h.payroll.requireRun(aug, c.viewingKey).proposalIds.GBP!;
    const salt = h.accounts.runSaltOf(proposalId, c.viewingKey);
    expect(text.toLowerCase()).not.toContain(salt.toLowerCase());
    expect(receiptText(h, eli, c.address).toLowerCase()).not.toContain(salt.toLowerCase());
  });

  it('A RETRY WRITTEN DOWN AND NEVER RAISED DOES NOT EXTEND "UNTIL"; ONCE RAISED IT DOES', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    const { runId } = await raise(h, c, '2026-08');
    const seeds = await h.accounts.payoutSeedsOf(c.accountId, c.viewingKey);
    const LATER = BigInt(CLOSES + 86_400);
    const run = h.payroll.requireRun(runId, c.viewingKey);
    const leg = run.payout!.GBP!;
    leg.retries = [{
      originalIndices: [0], root: leg.root, payees: 1n, opensAt: BigInt(NOW), closesAt: LATER, vault: VAULT,
      proposedBy: c.by, at: '2026-09-25T00:00:00.000Z',
    } as NonNullable<typeof leg.retries>[number]];
    const untilOf = () => {
      const again = { ...run, payslips: (h.payroll as any).withReceipts(run, seeds) };
      (h.payroll as unknown as { putRun: (r: typeof again, k: Hex) => void }).putRun(again, c.viewingKey);
      return openPayslip(h.payroll.payslipsFor(dana.keys.publicKey, c.address)[0]!, dana.keys.secret).receipt!.until;
    };
    /* RED WHEN a retry only written down extends the window: nothing raised can pay Dana after it closes. */
    expect(untilOf()).toBe(CLOSES);
    leg.retries[0]!.proposalId = 'raised-as-this';
    /* RED WHEN a raised retry does not extend it: Dana would read "cannot tell" while the retry can still pay her. */
    expect(untilOf()).toBe(Number(LATER));
  });
});
