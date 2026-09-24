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
import { wrapKey, toHex, randomBytes, type Hex } from './crypto.js';
import { runMaterialFor, type RunMaterial } from '../midnight/run-material.js';
import { paidMovementOfLeaf } from '../midnight/payout-tree.js';
import { vaultDetails } from '../testing/vault-details.js';
import { payeeFor } from '../testing/payees.js';
import { registryWithTestPrivateForms, aVaultHolding } from '../testing/assets.js';
import { fetchMyPayslips, paymentsOnTheChain, type Fetch } from '../web/my-payslips.js';
import { paidWords } from '../web/YourPay.js';
import type { User } from './types.js';

/**
 * **EACH PAYSLIP SAYS WHETHER IT WAS PAID - "PAID", "NOT YET" OR "CANNOT TELL" -
 * AND ONLY ITS PAYEE CAN ASK.**
 *
 * Every payee below is hired through the real invitation, with a key their own
 * wallet's words work out for the company's address, and every run is raised
 * with material built by the real tree builder. The service is the product's
 * own `PayrollService`, reached through a stand-in for the wire that records
 * every request the page makes.
 */

const ORIGIN = 'https://payroll.example';
const VAULT = toHex(new Uint8Array(32).fill(0xa1));

const harness = () => {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-paid-or-not-')), 'db.json'));
  const registry = registryWithTestPrivateForms();
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
    opensAt: 1_800_000_000n, closesAt: 1_800_086_400n, vault: VAULT, detailsOf: vaultDetails,
  });
  await h.payroll.proposeRun(runId, c.viewingKey, c.by, material, asset);
  return material;
};

/**
 * The wire, as the page meets it. Payslips come from the service's own
 * `payslipsFor`, behind the same proof the route asks for; the completed
 * payments come from `paid`. Every request is kept.
 */
const wire = (h: H, paid: (url: string) => Promise<Response> | Response, opts: { ignoreFrom?: boolean } = {}) => {
  const seen: Array<{ url: string; body: string; init: RequestInit | undefined }> = [];
  let live: { publicKey: string; value: string } | null = null;
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
    if (url.startsWith('/api/payslips/paid?')) return paid(url);
    return new Response('{}', { status: 404 });
  };
  return { fetcher, seen };
};

const listOf = (movements: Hex[]) => () => new Response(JSON.stringify({ known: true, movements }));

/** What the page shows for each of this person's slips, by period. */
const shown = async (fetcher: Fetch, keys: { secret: Hex; publicKey: Hex }, from: string) => {
  const mine = await fetchMyPayslips(keys, from, fetcher);
  const chain = await paymentsOnTheChain(mine.opened, fetcher);
  return Object.fromEntries(mine.opened.map(s => [s.period, chain.get(s.runId)]));
};

describe('each payslip says whether it was paid, from the chain', () => {
  it('A PAID PAYSLIP READS "PAID", AN UNPAID ONE "NOT YET"', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    const eli = hire(h, c, 'Eli');
    const { material } = await raise(h, c, '2026-08');
    /* Dana is first on the leg and Eli second, which is the order the leaves are in. */
    const paidDana = paidMovementOfLeaf(material.leaves[0]!);
    const { fetcher } = wire(h, listOf([toHex(randomBytes(32)), paidDana.toUpperCase()]));
    /*
     * RED WHEN the receipt is sealed with another person's leaf, or the page
     * looks for something other than its own recorded value: Dana then reads
     * "not yet" and Eli "paid".
     */
    expect(await shown(fetcher, dana.keys, c.address)).toEqual({ '2026-08': 'paid' });
    expect(await shown(fetcher, eli.keys, c.address)).toEqual({ '2026-08': 'not-yet' });
    /* A rehearsal moved no money, whatever a list says. RED WHEN the chain's word overrides it. */
    expect(paidWords({ status: 'settled', settledAt: null, wiring: 'simulated' }, 'paid').paid)
      .toBe('No: a rehearsal, nothing was sent');
    expect(paidWords({ status: 'proposed', settledAt: null, wiring: 'chain' }, 'paid'))
      .toEqual({ paid: 'Paid', onChain: 'Yes' });
    expect(paidWords({ status: 'proposed', settledAt: null, wiring: 'chain' }, 'not-yet'))
      .toEqual({ paid: 'Not yet', onChain: 'Not yet' });
  });

  it('A CHAIN THAT COULD NOT BE READ READS "CANNOT TELL", NEVER "NOT YET"', async () => {
    const h = harness();
    const c = await company(h);
    const dana = hire(h, c, 'Dana');
    await raise(h, c, '2026-08');
    const unreadable: Array<[string, () => Response | Promise<Response>]> = [
      ['the ledger cannot say', () => new Response(JSON.stringify({ known: false, movements: [] }))],
      ['the service failed', () => new Response('{"error":"down"}', { status: 503 })],
      ['the network failed', () => { throw new TypeError('failed to fetch'); }],
      ['the answer is not a list', () => new Response(JSON.stringify({ known: true, movements: 'none' }))],
      ['an entry is not a value', () => new Response(JSON.stringify({ known: true, movements: [42] }))],
      ['the body is not JSON', () => new Response('<html>')],
    ];
    for (const [why, answer] of unreadable) {
      const { fetcher } = wire(h, answer);
      /* RED WHEN any of these is read as an empty list of completed payments. */
      expect(await shown(fetcher, dana.keys, c.address), why).toEqual({ '2026-08': 'cannot-tell' });
    }
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
    expect((await paymentsOnTheChain([noAddress], fetcher)).get(slip!.runId)).toBe('cannot-tell');
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
    /* The service answers only for a company's address now, as its route does. */
    const route = (url: string) => {
      const asked = new URL(url, 'https://x').searchParams.get('company')!;
      return new Response(JSON.stringify(h.payroll.accountAtCompanyAddress(asked) === null
        ? { known: false, movements: [] } : { known: true, movements: [] }));
    };
    expect((await shown(wire(h, route).fetcher, ben.keys, c.address))['2026-08']).toBe('cannot-tell');
    expect((await shown(wire(h, route).fetcher, cat.keys, c.address))['2026-08']).toBe('not-yet');
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
    expect((await paymentsOnTheChain(mine.opened, fetcher)).size).toBe(0);
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
      /* RED WHEN any request carries this page's sign-in, which would tie a person to what they asked. */
      expect(r.init?.credentials, r.url).toBe('omit');
      /* RED WHEN the page asks about its own payment by its leaf or its recorded value. */
      for (const s of secretsOf) expect(said, r.url).not.toContain(s.toLowerCase());
      expect(said).not.toContain(dana.keys.secret.toLowerCase());
    }
    /* What it does ask for the payments is the company's whole list, by the company's address. */
    expect(seen.filter(r => r.url.startsWith('/api/payslips/paid')).map(r => r.url))
      .toEqual([`/api/payslips/paid?company=${c.address}`]);
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
    expect(h.payroll.accountAtCompanyAddress(moved)).toBe(c.accountId);
    expect(h.payroll.accountAtCompanyAddress(c.address)).toBeNull();
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
