/**
 * **THE FEE PAYER AS A SERVICE, DRIVEN OVER HTTP BY THE CLIENT THE WEB PROCESS
 * USES.** The wallet is a double; the fee payer over it is the class that
 * ships, with its ceiling; the service and the client are the real ones, on
 * this machine's loopback.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  feePayerApp, refusalForFeeRequest, secretMatches, LONGEST_DEADLINE_MS, type TransactionCodec,
} from './service.js';
import { RemoteFeeSponsor } from './client.js';
import { WalletFeeSponsor, type SponsorWallet } from '../midnight/sponsor.js';
import type { FeeSponsor } from '../midnight/ledger.js';
import type { SponsoredFee } from '../midnight/sponsored-fees.js';
import { saysNothingWasSent } from '../core/jobs.js';

const SECRET = 'not-a-secret: a test literal of enough length';

/**
 * Both ends run in this process, so a transaction crosses as a handle to the
 * same object. That keeps the double's identity, which is what the cases about
 * WHICH transaction was submitted need.
 */
const handles = (): TransactionCodec => {
  const byId = new Map<string, unknown>();
  const ids = new Map<unknown, string>();
  return {
    read: (bytes) => {
      const id = Buffer.from(bytes).toString();
      if (!byId.has(id)) throw new Error(`no transaction ${id}`);
      return byId.get(id);
    },
    write: (tx) => {
      let id = ids.get(tx);
      if (!id) { id = `tx-${ids.size + 1}`; ids.set(tx, id); byId.set(id, tx); }
      return new Uint8Array(Buffer.from(id));
    },
  };
};

type Call = { method: string; args: unknown[] };

const wallet = (calls: Call[], over: Partial<SponsorWallet> = {}): SponsorWallet => ({
  shieldedSecretKeys: 'k', dustSecretKey: 'd',
  estimateFee: async () => 10n,
  balanceFinalizedTransaction: async (tx) => { calls.push({ method: 'balance', args: [tx] }); return { recipe: tx }; },
  finalizeRecipe: async (r: any) => ({ paid: r.recipe, intents: new Map([[1, { dustActions: { spends: [{ vFee: 10n }] } }]]) }),
  submitTransaction: async (tx) => { calls.push({ method: 'submit', args: [tx] }); return 'ref-1'; },
  revert: async (b) => { calls.push({ method: 'revert', args: [b] }); },
  paidFee: async () => 9n,
  balances: async () => ({ dust: 123n, night: 45n }),
  ...over,
});

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

interface Rig {
  client: RemoteFeeSponsor;
  base: string;
  calls: Call[];
  records: SponsoredFee[];
  payers: FeeSponsor[];
  codec: TransactionCodec;
  /** Runs every deadline still scheduled, as the clock would. */
  fire: () => void;
  /** Runs every deadline ever scheduled, cancelled or not, as a clock that raced a cancel would. */
  fireAll: () => void;
  /** The booking id the service answered most recently. */
  lastBooking: () => string;
}

const rig = async (over: Partial<SponsorWallet> = {}, ceiling = 100n, clock: { at: number | null } = { at: null }): Promise<Rig> => {
  const calls: Call[] = [];
  const records: SponsoredFee[] = [];
  const payers: FeeSponsor[] = [];
  const codec = handles();
  const timers: Array<() => void> = [];
  const everScheduled: Array<() => void> = [];
  const w = wallet(calls, over);
  const app = feePayerApp({
    newPayer: () => {
      const p = new WalletFeeSponsor(w, { perTransaction: ceiling }, undefined, { record: (e) => records.push(e) });
      payers.push(p);
      return p;
    },
    codec,
    secret: SECRET,
    capacity: () => w.balances(),
    now: () => clock.at ?? Date.now(),
    schedule: (_ms, run) => {
      timers.push(run);
      everScheduled.push(run);
      return () => { const i = timers.indexOf(run); if (i >= 0) timers.splice(i, 1); };
    },
  });
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  let last = '';
  const seen = async (input: string, init?: RequestInit) => {
    const res = await fetch(input, init);
    if (input.endsWith('/fee') && res.ok) {
      const body = await res.clone().json();
      last = body.booking;
    }
    return res;
  };
  return {
    client: new RemoteFeeSponsor(new URL(base), SECRET, codec, seen),
    base, calls, records, payers, codec,
    fire: () => { for (const t of timers.splice(0)) t(); },
    fireAll: () => { for (const t of everScheduled) t(); },
    lastBooking: () => last,
  };
};

const soon = () => new Date(Date.now() + 60_000);

describe('the fee payer service', () => {
  /* RED WHEN: the secret check in front of every route is removed. */
  it('answers nothing without the secret, and says nothing about why', async () => {
    const r = await rig();
    for (const auth of [undefined, 'Bearer wrong', `Basic ${SECRET}`, `Bearez ${SECRET}`, SECRET]) {
      const res = await fetch(`${r.base}capacity`, { headers: auth ? { authorization: auth } : {} });
      expect(res.status, String(auth)).toBe(401);
      expect(await res.text()).toBe('');
    }
  });

  /* RED WHEN: the length guard on the secret is removed. */
  it('is not served with a short secret', () => {
    expect(() => feePayerApp({
      newPayer: () => { throw new Error('unused'); }, codec: handles(), secret: 'short',
      capacity: async () => ({ dust: 0n, night: 0n }),
    })).toThrow(/shorter than 32/);
  });

  /*
   * RED WHEN: `/submit` submits something the caller sent rather than the
   * transaction the service kept for the booking.
   */
  it('adds the fee, then submits exactly the transaction it built', async () => {
    const r = await rig();
    const company = { theirs: true };
    r.client.payingFor('acc_one');
    const paid: any = await r.client.addFeeAndFinalise(company, soon());
    expect(paid.paid).toBe(company);
    const ref = await r.client.submit(paid);
    expect(ref.ref).toBe('ref-1');
    const submitted = r.calls.find(c => c.method === 'submit')!;
    expect(submitted.args[0], 'the service submitted something other than what it balanced').toBe(paid);
    expect(r.records.map(x => x.company)).toEqual(['acc_one']);
  });

  /* RED WHEN: `/submit` submits what the request carries rather than what the service kept. */
  it('a submission names a booking, and bytes sent with it are not what is submitted', async () => {
    const r = await rig();
    r.client.payingFor('acc_one');
    const paid = await r.client.addFeeAndFinalise({ n: 1 }, soon());
    const other = Buffer.from(r.codec.write({ somebody: 'else' }) as Uint8Array).toString('base64');
    const booking = (r.client as any).bookings.values().next().value;
    const res = await fetch(`${r.base}submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ booking, tx: other }),
    });
    expect(res.status).toBe(200);
    const submitted = r.calls.filter(c => c.method === 'submit');
    expect(submitted).toHaveLength(1);
    expect(submitted[0].args[0], 'the service submitted what the caller sent').toBe(paid);
  });

  /* RED WHEN: the service builds one fee payer and reuses it, so payments share a record. */
  it('gives every booking its own fee payer', async () => {
    const r = await rig();
    r.client.payingFor('acc_one');
    await r.client.submit(await r.client.addFeeAndFinalise({ n: 1 }, soon()));
    r.client.payingFor('acc_two');
    const second: any = await r.client.addFeeAndFinalise({ n: 2 }, soon()).catch((e) => e);
    expect(second, 'a finished submission still held the wallet').not.toBeInstanceOf(Error);
    await r.client.submit(second);
    expect(r.payers).toHaveLength(2);
    expect(r.payers[0]).not.toBe(r.payers[1]);
    expect(r.records.map(x => x.company)).toEqual(['acc_one', 'acc_two']);
  });

  /* RED WHEN: the busy check is removed, so two bookings stand at once on one wallet. */
  it('pays for one transaction at a time', async () => {
    const r = await rig();
    r.client.payingFor('acc_one');
    await r.client.addFeeAndFinalise({ n: 1 }, soon());
    const second: any = await r.client.addFeeAndFinalise({ n: 2 }, soon()).catch((e) => e);
    expect(second, 'a second booking was made while one was outstanding').toBeInstanceOf(Error);
    expect(second.message).toMatch(/already paying for another transaction/);
    expect(saysNothingWasSent(second)).toBe(true);
    expect(r.payers).toHaveLength(1);
  });

  /* RED WHEN: `balancing` is not set across the await, so two requests racing both book. */
  it('and a request that arrives while the first is still balancing is refused too', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const r = await rig({
      balanceFinalizedTransaction: async (tx) => { await gate; return { recipe: tx }; },
    });
    r.client.payingFor('acc_one');
    const first = r.client.addFeeAndFinalise({ n: 1 }, soon());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const other = new RemoteFeeSponsor(new URL(r.base), SECRET, r.codec);
    other.payingFor('acc_two');
    const second: any = await Promise.race([
      other.addFeeAndFinalise({ n: 2 }, soon()).catch((e) => e),
      new Promise((resolve) => setTimeout(() => resolve('still waiting behind the first'), 500)),
    ]);
    finish();
    await first;
    expect(second).toBeInstanceOf(Error);
    expect(second.message).toMatch(/already paying for another transaction/);
  });

  /*
   * RED WHEN: the release scheduled at the deadline is removed, so a caller
   * that walks away holds our DUST for ever.
   */
  it('releases a booking nobody submitted, at its deadline', async () => {
    const r = await rig();
    r.client.payingFor('acc_one');
    const paid = await r.client.addFeeAndFinalise({ n: 1 }, soon());
    r.fire();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const released = r.calls.find(c => c.method === 'revert');
    expect(released, 'the booking was not released at its deadline').toBeDefined();
    expect(released!.args[0]).toBe(paid);
    const late: any = await r.client.submit(paid).catch((e) => e);
    expect(late, 'a booking past its deadline was still submitted').toBeInstanceOf(Error);
    expect(late.message).toMatch(/holds no such transaction/);
    expect(saysNothingWasSent(late)).toBe(true);
    expect(r.calls.some(c => c.method === 'submit')).toBe(false);
  });

  /*
   * RED WHEN: a booking is forgotten when its submission STARTS rather than
   * when it ends, so a second transaction is balanced while the first is still
   * on its way.
   */
  it('a second fee request is refused until the first submission has finished', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const r = await rig({
      submitTransaction: async (tx) => { await gate; r.calls.push({ method: 'submit', args: [tx] }); return 'ref-1'; },
    });
    r.client.payingFor('acc_one');
    const first = r.client.submit(await r.client.addFeeAndFinalise({ n: 1 }, soon()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const other = new RemoteFeeSponsor(new URL(r.base), SECRET, r.codec);
    other.payingFor('acc_two');
    const second: any = await other.addFeeAndFinalise({ n: 2 }, soon()).catch((e) => e);
    finish();
    await first;
    expect(second, 'a fee was added while another transaction was still being submitted').toBeInstanceOf(Error);
    expect(second.message).toMatch(/already paying for another transaction/);
  });

  /*
   * RED WHEN: a release and a submission of one booking can both go ahead, so
   * a transaction that was sent has its DUST marked free.
   */
  it('a booking is submitted or released, never both', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const r = await rig({
      submitTransaction: async (tx) => { await gate; r.calls.push({ method: 'submit', args: [tx] }); return 'ref-1'; },
    });
    r.client.payingFor('acc_one');
    await r.client.addFeeAndFinalise({ n: 1 }, soon());
    const booking = (r.client as any).bookings.values().next().value;
    const post = (path: string) => fetch(`${r.base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ booking }),
    });
    const submitting = post('submit');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const release = await (await post('release')).json();
    finish();
    expect((await submitting).status).toBe(200);
    expect(release.released, 'a booking being submitted was released').toBe(false);
    expect(r.calls.some(c => c.method === 'revert'), 'the DUST of a sent transaction was let go').toBe(false);
  });

  /* RED WHEN: a booking being released can still be submitted, or the refusal loses its mark. */
  it('and a booking being released is not submitted', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const r = await rig({ revert: async (b) => { await gate; r.calls.push({ method: 'revert', args: [b] }); } });
    r.client.payingFor('acc_one');
    const paid = await r.client.addFeeAndFinalise({ n: 1 }, soon());
    const releasing = r.client.release(paid);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const late: any = await r.client.submit(paid).catch((e) => e);
    finish();
    await releasing;
    expect(late, 'a booking being released was submitted').toBeInstanceOf(Error);
    expect(late.message).toMatch(/releasing this transaction/);
    expect(saysNothingWasSent(late)).toBe(true);
    expect(r.calls.some(c => c.method === 'submit')).toBe(false);
  });

  /*
   * RED WHEN: a second ask to submit a booking that was already submitted is
   * answered as nothing sent. The first may have landed.
   */
  it('asking twice to submit one booking is not answered as nothing sent', async () => {
    const r = await rig();
    r.client.payingFor('acc_one');
    await r.client.submit(await r.client.addFeeAndFinalise({ n: 1 }, soon()));
    expect(r.records.map(x => x.ref)).toEqual(['ref-1']);
    const res = await fetch(`${r.base}submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ booking: r.lastBooking() }),
    });
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.nothingWasSent, 'a submitted booking was called unsent').toBe(false);
    expect(r.calls.filter(c => c.method === 'submit')).toHaveLength(1);
  });

  /* RED WHEN: a release that fails leaves the booking neither held nor gone, so nothing can use it. */
  it('a release that fails leaves the booking held', async () => {
    let refuse = true;
    const r = await rig({ revert: async () => { if (refuse) throw new Error('the vendor refused'); } });
    r.client.payingFor('acc_one');
    const paid = await r.client.addFeeAndFinalise({ n: 1 }, soon());
    await expect(r.client.release(paid)).rejects.toThrow(/the vendor refused/);
    refuse = false;
    const ref = await r.client.submit(paid).catch((e) => e);
    expect(ref, 'a booking whose release failed could not be used again').not.toBeInstanceOf(Error);
  });

  /*
   * RED WHEN: a booking whose release at the deadline failed is never tried
   * again, so it holds the wallet until the process restarts.
   */
  it('a booking whose deadline release failed is let go before the next one is made', async () => {
    let refuse = true;
    const clock = { at: null as number | null };
    const r = await rig({
      revert: async (b) => { r.calls.push({ method: 'revert', args: [b] }); if (refuse) throw new Error('the vendor refused'); },
    }, 100n, clock);
    r.client.payingFor('acc_one');
    const deadline = soon();
    await r.client.addFeeAndFinalise({ n: 1 }, deadline);
    r.fire();
    await new Promise((resolve) => setTimeout(resolve, 20));
    refuse = false;
    clock.at = deadline.getTime() + 1;
    r.client.payingFor('acc_two');
    const next: any = await r.client.addFeeAndFinalise({ n: 2 }, new Date(clock.at + 60_000)).catch((e) => e);
    expect(next, 'a booking past its deadline still held the wallet').not.toBeInstanceOf(Error);
    expect(r.calls.filter(c => c.method === 'revert')).toHaveLength(2);
  });

  /* RED WHEN: a booking still inside its deadline is let go to make room for another. */
  it('and one inside its deadline is not', async () => {
    const r = await rig();
    r.client.payingFor('acc_one');
    await r.client.addFeeAndFinalise({ n: 1 }, soon());
    r.client.payingFor('acc_two');
    const next: any = await r.client.addFeeAndFinalise({ n: 2 }, soon()).catch((e) => e);
    expect(next).toBeInstanceOf(Error);
    expect(r.calls.some(c => c.method === 'revert'), 'a live booking was let go').toBe(false);
  });

  /* RED WHEN: the deadline releases a booking that is already being submitted. */
  it('the deadline does not release a booking that is being submitted', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const r = await rig({
      submitTransaction: async (tx) => { await gate; r.calls.push({ method: 'submit', args: [tx] }); return 'ref-1'; },
    });
    r.client.payingFor('acc_one');
    const submitting = r.client.submit(await r.client.addFeeAndFinalise({ n: 1 }, soon()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    r.fireAll();
    finish();
    await submitting;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.calls.some(c => c.method === 'revert'), 'a transaction being submitted was released at its deadline').toBe(false);
  });

  /* RED WHEN: a refusal from the fee payer loses its mark on the way to the caller. */
  it('a ceiling refusal reaches the caller as nothing sent, in the fee payer\'s words', async () => {
    const r = await rig({ estimateFee: async () => 500n }, 100n);
    r.client.payingFor('acc_one');
    const refused: any = await r.client.addFeeAndFinalise({ n: 1 }, soon()).catch((e) => e);
    expect(refused.message).toMatch(/expected to cost 500 SPECKs/);
    expect(saysNothingWasSent(refused)).toBe(true);
    expect(r.calls.some(c => c.method === 'balance')).toBe(false);
  });

  /*
   * RED WHEN: a submission that threw is reported as nothing sent, by the
   * service or by the client. It may have landed.
   */
  it('a submission that throws is an unknown outcome, not a refusal', async () => {
    const r = await rig({ submitTransaction: async () => { throw new Error('the node closed the socket'); } });
    r.client.payingFor('acc_one');
    const paid = await r.client.addFeeAndFinalise({ n: 1 }, soon());
    const failed: any = await r.client.submit(paid).catch((e) => e);
    expect(failed.message).toMatch(/the node closed the socket/);
    expect(saysNothingWasSent(failed), 'a submission that may have landed was called nothing sent').toBe(false);
  });

  /* RED WHEN: `/release` stops releasing, or stops forgetting what it released. */
  it('lets go of a booking on request', async () => {
    const r = await rig();
    r.client.payingFor('acc_one');
    const paid = await r.client.addFeeAndFinalise({ n: 1 }, soon());
    await r.client.release(paid);
    expect(r.calls.filter(c => c.method === 'revert').map(c => c.args[0])).toEqual([paid]);
    r.client.payingFor('acc_two');
    const next = await r.client.addFeeAndFinalise({ n: 2 }, soon()).catch((e) => e);
    expect(next, 'a released booking still held the wallet').not.toBeInstanceOf(Error);
  });

  /* RED WHEN: the capacity route or its parsing stops carrying whole numbers. */
  it('reports what it holds', async () => {
    const r = await rig();
    expect(await r.client.capacity()).toEqual({ dust: 123n, night: 45n });
  });
});

describe('the rules a fee request is held to', () => {
  const now = Date.parse('2026-09-16T00:00:00Z');
  const ok = { company: 'acc', tx: 'dHg=', ttl: new Date(now + 60_000).toISOString() };

  /* RED WHEN: any one of these checks is removed. */
  it('refuses what it should, and nothing else', () => {
    expect(refusalForFeeRequest(ok, now, false)).toBeNull();
    expect(String(refusalForFeeRequest(ok, now, true))).toMatch(/one at a time/);
    expect(String(refusalForFeeRequest({ ...ok, company: '' }, now, false))).toMatch(/which company/);
    expect(String(refusalForFeeRequest({ ...ok, company: 'x'.repeat(201) }, now, false))).toMatch(/which company/);
    expect(String(refusalForFeeRequest({ ...ok, tx: undefined }, now, false))).toMatch(/no transaction/);
    expect(String(refusalForFeeRequest({ ...ok, tx: '' }, now, false))).toMatch(/no transaction/);
    expect(String(refusalForFeeRequest({ ...ok, ttl: 'soon' }, now, false))).toMatch(/no deadline/);
    expect(String(refusalForFeeRequest({ ...ok, ttl: new Date(now).toISOString() }, now, false))).toMatch(/already passed/);
    expect(String(refusalForFeeRequest(
      { ...ok, ttl: new Date(now + LONGEST_DEADLINE_MS + 1).toISOString() }, now, false)))
      .toMatch(/more than thirty minutes away/);
    expect(refusalForFeeRequest(
      { ...ok, ttl: new Date(now + LONGEST_DEADLINE_MS).toISOString() }, now, false)).toBeNull();
    expect(String(refusalForFeeRequest(undefined, now, false))).toMatch(/which company/);
  });

  /* RED WHEN: the comparison answers true for a wrong or missing secret. */
  it('matches the secret and nothing else', () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(`${SECRET}x`, SECRET)).toBe(false);
    expect(secretMatches('', SECRET)).toBe(false);
    expect(secretMatches(undefined, SECRET)).toBe(false);
  });
});
