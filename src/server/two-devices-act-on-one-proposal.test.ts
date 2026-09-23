/**
 * **TWO DEVICES ACT ON ONE PROPOSAL AT THE SAME TIME, THROUGH THE PAGE'S OWN
 * MODULE AND THE SERVED ROUTES, AND THE RECORD IS RIGHT AFTERWARDS.**
 *
 * What runs is the page's device module - `sendRaiseFromDevice`, `approveOnDevice`
 * and `governedCallServiceFor` - talking over real HTTP to this server's raise,
 * approval, standing and withdrawal routes, with two signed-in people and two
 * tabs of one person. **Two pieces are doubles, and they are named here**:
 *
 *   - the ledger under the server is the simulated one, with a door for a
 *     device's transaction that records what it was handed and then does to the
 *     simulated chain what the transaction would have done;
 *   - the worker that builds and proves a call on the device, and the page's
 *     read of the account's on-chain state, are stand-ins: the served
 *     call-state route answers only for a company whose contract this server can
 *     read, and no contract exists here. The stand-in builder writes down which
 *     call it was asked for, and that is what the door carries out.
 *
 * **WHY THE PROPOSALS ARE WRITTEN BEFORE THE SERVER STARTS.** Raising a payroll
 * leg over the served route asks the vault holdings reader first, and a server
 * with no deployment has a reader that refuses every round that moves money. So
 * each company, its run and its written-down proposal are made by the same
 * services over the same store file and the same ledger the server is then
 * handed, before it is imported - the people who sign in are real sign-ins, and
 * every write after that goes through a route.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

process.env.ALLOW_SIMULATED_COMPANY_ADDRESS = '1';
process.env.ALLOW_MEMORY_SESSIONS = '1';
process.env.DATABASE_URL = '';
process.env.SERVE = '0';
process.env.APP_ORIGIN = 'https://payroll.example';
process.env.DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-two-devices-')), 'db.json');

const ORIGIN = 'https://payroll.example';

const { SimulatedLedger, SimulatedProofSystem } = await import('../core/ledger.js');
const { MidnightCommitments } = await import('../midnight/commitments.js');
const { handInWiring } = await import('../wiring/handed-in.js');
const { FileStore } = await import('../core/store-file.js');
const { walletKeyOf } = await import('../core/store.js');
const { AccountService, approvalMessage } = await import('../core/account.js');
const { PayrollService } = await import('../core/payroll.js');
const { runMaterialFor } = await import('../midnight/run-material.js');
const { vaultDetails } = await import('../testing/vault-details.js');
const { registryWithTestPrivateForms, aVaultHolding } = await import('../testing/assets.js');
const { addressOfSlot, signInWithAWallet } = await import('../testing/wallet-session.js');
const { theNetwork } = await import('../midnight/network.js');
const { sign, toHex } = await import('../core/crypto.js');
const device = await import('../web/governed-call-on-device.js');
type Hex = import('../core/crypto.js').Hex;
type Proposal = import('../core/types.js').Proposal;

const NETWORK = theNetwork();
const SLOTS = { ada: 71, blake: 72 } as const;
const USERS = { ada: 'usr_two_devices_ada', blake: 'usr_two_devices_blake' } as const;
const VAULT = toHex(new Uint8Array(32).fill(0xa1));

/* ── the chain, and its door for a device's transaction ─────────────────── */

const ledger = new SimulatedLedger(MidnightCommitments);
const leaves = new Map<string, Hex>();
const sent: Array<{ circuit: string; signer: string }> = [];
/** What the door does with a call it was handed; `land` carries it out on the chain. */
let door: (circuit: string, land: () => Promise<{ ref: string; at: string }>) => Promise<{ ref: string; at: string }> =
  (_c, land) => land();
type Built = {
  signer: string;
  order: { circuit: 'approve'; proposal: Hex } | {
    circuit: 'propose'; proposal: Hex;
    run: { root: Hex; payees: string; opensAt: string; closesAt: string; vault: Hex };
    half: { changeAmount: string; changeBatchDigest: Hex; proposalSalt: Hex };
  };
};
Object.assign(ledger, {
  submitProvenCall: async (accountId: string, bytes: Uint8Array, circuit: string) => {
    const built = JSON.parse(Buffer.from(bytes).toString('utf8')) as Built;
    sent.push({ circuit, signer: built.signer });
    const by = { signerId: built.signer, leaf: leaves.get(`${accountId} ${built.signer}`)! };
    const land = async () => {
      const o = built.order;
      if (o.circuit === 'approve') return ledger.approve(accountId, o.proposal, by);
      const r = await ledger.proposeRun(accountId, {
        root: o.run.root, payees: BigInt(o.run.payees), opensAt: BigInt(o.run.opensAt),
        closesAt: BigInt(o.run.closesAt), vault: o.run.vault,
      }, {
        asset: 'GBP', amount: BigInt(o.half.changeAmount), batchDigest: o.half.changeBatchDigest,
        salt: o.half.proposalSalt,
      }, by);
      return { ref: `tx_${r.proposalId.slice(0, 8)}`, at: r.at };
    };
    return door(circuit, land);
  },
});

/* ── the companies, written before the server starts ────────────────────── */

const seeded = await (async () => {
  const store = new FileStore(process.env.DATA_PATH!);
  for (const who of ['ada', 'blake'] as const) {
    store.putUser({
      id: USERS[who], email: `${who}@northwind.example`, name: who, keyBundle: null, keyBundleVersion: 0,
      walletKey: walletKeyOf(addressOfSlot(SLOTS[who], NETWORK)), createdAt: '2026-09-17T00:00:00.000Z',
    } as never);
  }
  const registry = registryWithTestPrivateForms();
  const accounts = new AccountService(store, ledger, MidnightCommitments, registry, aVaultHolding());
  const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), registry);
  const aCompany = async (name: string, threshold: number, onChain: boolean) => {
    const created = await accounts.create(name, [
      { name: 'Ada', role: 'admin', userId: USERS.ada },
      { name: 'Blake', role: 'approver', userId: USERS.blake },
      { name: 'Cleo', role: 'approver' },
    ], threshold);
    const viewingKey = created.viewingKey;
    const account = created.account.id;
    for (const s of accounts.open(account, viewingKey).signers) leaves.set(`${account} ${s.id}`, s.leafCommitment as Hex);
    for (let i = 0; i < 3; i++) {
      payroll.hireDirect(account, {
        name: `${name} payee ${i}`, email: `p${i}@${name.toLowerCase()}.example`, title: 'Eng', asset: 'GBP',
        baseAmount: 100_00n,
      }, viewingKey);
    }
    const { run } = await payroll.createRunFromRoster(account, '2026-08', viewingKey);
    const inputs = await payroll.runMaterialInputs(run.id, viewingKey);
    const now = Math.floor(Date.now() / 1000);
    const material = await runMaterialFor({
      accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: inputs.facts,
      opensAt: BigInt(now - 60), closesAt: BigInt(now + 3_600), vault: VAULT, detailsOf: vaultDetails,
    });
    const proposal = await payroll.proposeRun(run.id, viewingKey, created.secrets[0]!.signerId, material, undefined,
      { onDevice: true });
    if (onChain) {
      const order = (await payroll.raiseOrderOf(run.id, viewingKey))!;
      const built: Built = {
        signer: created.secrets[0]!.signerId,
        order: {
          circuit: 'propose', proposal: order.chainId,
          run: { ...order.run, payees: String(order.run.payees), opensAt: String(order.run.opensAt), closesAt: String(order.run.closesAt) },
          half: order.half as never,
        },
      };
      await accounts.sendRaise(proposal.id, viewingKey, Buffer.from(JSON.stringify(built)), created.secrets[0]!.signerId);
      await accounts.refreshStanding(proposal.id, viewingKey);
    }
    return {
      account, viewingKey, runId: run.id, proposalId: proposal.id,
      ada: created.secrets[0]!, blake: created.secrets[1]!,
    };
  };
  const result = {
    raisedTwice: await aCompany('Raisedtwice', 2, false),
    twoSigners: await aCompany('Twosigners', 2, true),
    twoTabs: await aCompany('Twotabs', 3, true),
    withdrawn: await aCompany('Withdrawn', 3, true),
  };
  sent.length = 0;
  return result;
})();

handInWiring({
  name: 'simulated',
  commitments: MidnightCommitments,
  createLedger: () => ledger,
  createProofSystem: () => new SimulatedProofSystem(),
});

const { app } = await import('./index.js');

let server: Server;
let base: string;
const tokens: Record<keyof typeof USERS, string> = { ada: '', blake: '' };

type Res = { status: number; body: any };
const call = async (method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Res> => {
  const r = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

beforeAll(async () => {
  server = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${a.port}`;
  for (const who of ['ada', 'blake'] as const) {
    const signedIn = await signInWithAWallet(call, { slot: SLOTS[who], origin: ORIGIN, network: NETWORK });
    expect(signedIn.userId).toBe(USERS[who]);
    tokens[who] = signedIn.token;
  }
});
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });

/* ── the page's side, as one device of one signed-in person ─────────────── */

/** The page's own request function, over this person's sign-in: a refusal is thrown with the service's sentence. */
const apiAs = (who: keyof typeof USERS) => async (path: string, init?: RequestInit) => {
  const r = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error ?? `request failed: ${r.status}`);
  return body;
};

const aDevice = (who: keyof typeof USERS, company: { account: string }, signer: string) => {
  const stages: string[] = [];
  const doors: import('../web/governed-call-on-device.js').RaiseDoors = {
    service: {
      ...device.governedCallServiceFor(apiAs(who)),
      callState: async () => ({ account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }),
    },
    builder: {
      governedCall: async ({ order }) => ({
        tx: Buffer.from(JSON.stringify({ signer, order } satisfies Built)).toString('base64'),
      }),
    },
    material: { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) },
    /* The device's read of the vault is a stand-in too: every send asks it first, and here it can pay. */
    holdings: aVaultHolding(), assets: registryWithTestPrivateForms(),
    accountId: company.account,
    progress: (s) => stages.push(s),
    sleep: async () => {}, waitMs: 40, everyMs: 1,
  };
  return { doors, stages };
};

const standing = async (who: keyof typeof USERS, c: { proposalId: string; viewingKey: string }): Promise<Proposal> => {
  const r = await call('POST', `/api/proposals/${c.proposalId}/standing`, { token: tokens[who], body: { viewingKey: c.viewingKey } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};

const aGate = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { opened, open };
};
const until = async (test: () => boolean) => {
  for (let i = 0; i < 2_000 && !test(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!test()) throw new Error('what the test was waiting for never happened');
};
const settle = <T>(p: Promise<T>) => {
  const s: { done: boolean; value?: T; error?: any } = { done: false };
  p.then((v) => { s.done = true; s.value = v; }, (e) => { s.done = true; s.error = e; });
  return s;
};

describe('TWO DEVICES, ONE PROPOSAL, THE SERVED ROUTES', () => {
  /* Each case starts from an empty record of sends and a door that lands at once, whatever the last case left. */
  beforeEach(() => {
    sent.length = 0;
    door = (_c, land) => land();
  });

  it('ONE PROPOSAL SENT FROM TWO TABS AT ONCE IS HANDED OVER ONCE, AND THE OTHER TAB IS TOLD NOTHING WAS SENT', async () => {
    const c = seeded.raisedTwice;
    const gate = aGate();
    door = async (_c, land) => { await gate.opened; return land(); };
    const one = aDevice('ada', c, c.ada.signerId);
    const two = aDevice('ada', c, c.ada.signerId);
    const first = settle(device.sendRaiseFromDevice(one.doors, { runId: c.runId, viewingKey: c.viewingKey, asset: 'GBP' }));
    const second = settle(device.sendRaiseFromDevice(two.doors, { runId: c.runId, viewingKey: c.viewingKey, asset: 'GBP' }));
    await until(() => sent.length >= 2 || (sent.length === 1 && (first.done || second.done)));
    gate.open();
    await until(() => first.done && second.done);
    const [won, lost] = first.error === undefined ? [first, second] : [second, first];
    /* RED WHEN: both tabs pass the service's check before either is written - both are handed to the chain. */
    expect(sent.filter((s) => s.circuit === 'propose')).toHaveLength(1);
    expect(won.error).toBeUndefined();
    expect(won.value!.raisedAt).toBeDefined();
    /* RED WHEN: the refusal loses the sentence the page reads to say nothing was sent. */
    expect(String(lost.error?.message)).toMatch(/is being sent to the chain right now/u);
    expect(device.nothingWasSentBy(lost.error)).toBe(true);
    expect((await standing('ada', c)).raisedAt).toBeDefined();
  });

  it('TWO SIGNERS APPROVING FROM THEIR OWN DEVICES AT ONCE: BOTH SIGNATURES ARE RECORDED, AND THE PROPOSAL IS APPROVED', async () => {
    const c = seeded.twoSigners;
    const round = await standing('ada', c);
    const gate = aGate();
    door = async (_c, land) => { const r = await land(); await gate.opened; return r; };
    const ada = aDevice('ada', c, c.ada.signerId);
    const blake = aDevice('blake', c, c.blake.signerId);
    const signed = (s: { signingSecret: Hex }) => sign(approvalMessage(round), s.signingSecret);
    const both = Promise.all([
      device.approveOnDevice(ada.doors, { round, signerId: c.ada.signerId, signature: signed(c.ada), viewingKey: c.viewingKey }),
      device.approveOnDevice(blake.doors, { round, signerId: c.blake.signerId, signature: signed(c.blake), viewingKey: c.viewingKey }),
    ]);
    await until(() => sent.length === 2);
    gate.open();
    const [a, b] = await both;
    /* RED WHEN: an approval route writes back the record it read before its send - one signature is dropped for ever. */
    const after = await standing('blake', c);
    expect(after.approvals.map((x) => x.signerId).sort()).toEqual([c.ada.signerId, c.blake.signerId].sort());
    expect(after.status).toBe('approved');
    expect(after.approvalRound).toEqual({ state: 'satisfied', approvals: 2, threshold: 2 });
    expect([a.status, b.status]).toEqual(['approved', 'approved']);
  });

  it('ONE PERSON APPROVING FROM TWO TABS AT ONCE: ONE TRANSACTION, ONE SIGNATURE, AND THE OTHER TAB IS TOLD NOTHING WAS SENT', async () => {
    const c = seeded.twoTabs;
    const round = await standing('ada', c);
    const gate = aGate();
    door = async (_c, land) => { await gate.opened; return land(); };
    const signature = sign(approvalMessage(round), c.ada.signingSecret);
    const first = settle(device.approveOnDevice(aDevice('ada', c, c.ada.signerId).doors,
      { round, signerId: c.ada.signerId, signature, viewingKey: c.viewingKey }));
    const second = settle(device.approveOnDevice(aDevice('ada', c, c.ada.signerId).doors,
      { round, signerId: c.ada.signerId, signature, viewingKey: c.viewingKey }));
    await until(() => sent.length >= 2 || (sent.length === 1 && (first.done || second.done)));
    gate.open();
    await until(() => first.done && second.done);
    const [won, lost] = first.error === undefined ? [first, second] : [second, first];
    /* RED WHEN: both tabs' approvals pass the check before either is recorded, and both are handed to the chain. */
    expect(sent.filter((s) => s.circuit === 'approve')).toHaveLength(1);
    expect(won.error).toBeUndefined();
    expect(String(lost.error?.message)).toMatch(/is being sent to the chain right now/u);
    expect(device.nothingWasSentBy(lost.error)).toBe(true);
    const after = await standing('ada', c);
    expect(after.approvals.map((x) => x.signerId)).toEqual([c.ada.signerId]);
    expect(after.approvalRound).toEqual({ state: 'short', approvals: 1, threshold: 3 });
  });

  it('A WITHDRAWAL THROUGH ITS ROUTE WHILE AN APPROVAL IS BEING SENT STAYS A WITHDRAWAL, AND THE DEVICE IS NOT TOLD NOTHING WAS SENT', async () => {
    const c = seeded.withdrawn;
    const round = await standing('ada', c);
    const gate = aGate();
    door = async (_c, land) => { const r = await land(); await gate.opened; return r; };
    const approving = settle(device.approveOnDevice(aDevice('ada', c, c.ada.signerId).doors, {
      round, signerId: c.ada.signerId, signature: sign(approvalMessage(round), c.ada.signingSecret), viewingKey: c.viewingKey,
    }));
    await until(() => sent.length === 1);
    const withdrawn = await call('POST', `/api/proposals/${c.proposalId}/cancel`, {
      token: tokens.blake, body: { viewingKey: c.viewingKey, by: c.blake.signerId },
    });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    gate.open();
    await until(() => approving.done);
    /* RED WHEN: the approval route's write puts back the open record it read before the withdrawal. */
    const after = await standing('ada', c);
    expect(after.status).toBe('cancelled');
    expect(after.approvals).toEqual([]);
    /* RED WHEN: a send that reached the chain is reported to the page as nothing sent. */
    expect(String(approving.error?.message)).toMatch(/withdrawn while this approval was being sent/u);
    expect(device.nothingWasSentBy(approving.error)).toBe(false);
  });
});
