/**
 * **TWO DEVICES ACT ON ONE PROPOSAL AT THE SAME TIME, THROUGH THE PAGE'S OWN
 * MODULE AND THE SERVED ROUTES, AND THE RECORD IS RIGHT AFTERWARDS.**
 *
 * What runs is the page's device module - `sendRaiseFromDevice`, `approveOnDevice`
 * `withdrawOnDevice` and `governedCallServiceFor` - talking over real HTTP to
 * this server's raise, approval, standing and withdrawal relays, which take no
 * key, with two signed-in people and two tabs of one person. **Three pieces are
 * doubles, and they are named here**:
 *
 *   - the ledger under the server is the simulated one, with a door for a
 *     device's transaction that records what it was handed and then does to the
 *     simulated chain what the transaction would have done;
 *   - the worker that builds and proves a call on the device, and the page's
 *     read of the account's on-chain state, are stand-ins: the served
 *     call-state route answers only for a company whose contract this server can
 *     read, and no contract exists here. The stand-in builder writes down which
 *     call it was asked for, and that is what the door carries out;
 *   - the chain's read of who holds each company's account, as the server
 *     checks a relay's seat against it: Ada's and Blake's seats, whose entries
 *     their wallets signed in each company's directory.
 *
 * **WHY THE PROPOSALS ARE WRITTEN BEFORE THE SERVER STARTS.** Raising a payroll
 * leg over the served route asks the vault holdings reader first, and a server
 * with no deployment has a reader that refuses every round that moves money. So
 * each company, its run and its written-down proposal are made by the same
 * services over the same store file and the same ledger the server is then
 * handed, before it is imported - the people who sign in are real sign-ins, and
 * every write after that goes through a route.
 */
import { runsFiledBy } from '../testing/runs-a-seat-filed.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { importTheServer, useOnlyTheseSettings } from '../testing/server-under-test.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

import { TEST_TOKEN } from '../testing/assets.js';
useOnlyTheseSettings({
  ALLOW_SIMULATED_COMPANY_ADDRESS: '1',
  ALLOW_MEMORY_SESSIONS: '1',
  DATABASE_URL: '',
  SERVE: '0',
  APP_ORIGIN: 'https://payroll.example',
  DATA_PATH: join(mkdtempSync(join(tmpdir(), 'mn-two-devices-')), 'db.json'),
});

const ORIGIN = 'https://payroll.example';

const { SimulatedLedger, SimulatedProofSystem } = await import('../core/ledger.js');
const { MidnightCommitments } = await import('../midnight/commitments.js');
const { handInWiring } = await import('../wiring/handed-in.js');
const { FileStore } = await import('../core/store-file.js');
const { walletKeyOf } = await import('../core/store.js');
const { AccountService } = await import('../core/account.js');
const { PayrollService } = await import('../core/payroll.js');
const { runMaterialFor } = await import('../midnight/run-material.js');
const { vaultDetails } = await import('../testing/vault-details.js');
const { registryWithTestPrivateForms, aVaultHolding } = await import('../testing/assets.js');
const { addressOfSlot, signInWithAWallet } = await import('../testing/wallet-session.js');
const { theNetwork } = await import('../midnight/network.js');
const { toHex, newSigningKeypair } = await import('../core/crypto.js');
const { directorySeats } = await import('../testing/directory-seats.js');
const { signedFoundingState } = await import('../core/founding-state.js');
const device = await import('vaults-web-shared/governed-call-on-device.js');
type Hex = import('../core/crypto.js').Hex;
type Standing = import('vaults-web-shared/governed-call-on-device.js').RoundOnThePage;

const NETWORK = theNetwork();
const SLOTS = { ada: 71, blake: 72, cy: 73 } as const;
/** Cy signs in and is a member of none of these companies. */
const USERS = { ada: 'usr_two_devices_ada', blake: 'usr_two_devices_blake', cy: 'usr_two_devices_cy' } as const;
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
  order: { circuit: 'approve'; proposal: Hex } | { circuit: 'cancel'; proposal: Hex } | {
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
      if (o.circuit === 'cancel') return ledger.cancel(accountId, o.proposal, by);
      const r = await ledger.proposeRun(accountId, {
        root: o.run.root, payees: BigInt(o.run.payees), opensAt: BigInt(o.run.opensAt),
        closesAt: BigInt(o.run.closesAt), vault: o.run.vault,
      }, {
        asset: TEST_TOKEN, amount: BigInt(o.half.changeAmount), batchDigest: o.half.changeBatchDigest,
        salt: o.half.proposalSalt,
      }, by);
      return { ref: `tx_${r.proposalId.slice(0, 8)}`, at: r.at };
    };
    return door(circuit, land);
  },
});

/* ── the companies, written before the server starts ────────────────────── */

/** Each company's seats as the chain holds them: Ada's and Blake's, whose wallets signed their directory entries. */
const seats = directorySeats();

const seeded = await (async () => {
  const store = new FileStore(process.env.DATA_PATH!);
  for (const who of ['ada', 'blake', 'cy'] as const) {
    store.putUser({
      id: USERS[who], email: `${who}@northwind.example`, name: who, keyBundle: null, keyBundleVersion: 0,
      walletKey: walletKeyOf(addressOfSlot(SLOTS[who], NETWORK)), createdAt: '2026-09-17T00:00:00.000Z',
    } as never);
  }
  const registry = registryWithTestPrivateForms();
  const accounts = new AccountService(store, ledger, MidnightCommitments, registry, aVaultHolding());
  const payroll = new PayrollService(store, accounts, registry);
  const aCompany = async (name: string, threshold: number, onChain: boolean) => {
    const created = await accounts.create(name, [
      { name: 'Ada', role: 'admin', userId: USERS.ada },
      { name: 'Blake', role: 'approver', userId: USERS.blake },
      { name: 'Cleo', role: 'approver' },
    ], threshold, undefined, drawCompanyLabel());
    const viewingKey = created.viewingKey;
    const account = created.account.id;
    for (const s of accounts.open(account, viewingKey).signers) leaves.set(`${account} ${s.id}`, s.leafCommitment as Hex);
    /* Ada's and Blake's wallets sign their entries in the company's directory, under the keys their devices file with. */
    seats.claim(store, account, USERS.ada, created.secrets[0]!.signingSecret, 0x51);
    seats.claim(store, account, USERS.blake, created.secrets[1]!.signingSecret, 0x52);
    for (let i = 0; i < 3; i++) {
      payroll.hireDirect(account, {
        name: `${name} payee ${i}`, email: `p${i}@${name.toLowerCase()}.example`, title: 'Eng', asset: TEST_TOKEN,
        baseAmount: 100_00n,
      }, viewingKey);
    }
    const { run } = await payroll.createRunFromRoster(account, '2026-08', viewingKey);
    const inputs = await payroll.runMaterialInputs(run.id, viewingKey);
    const now = Math.floor(Date.now() / 1000);
    const material = await runMaterialFor({
      accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: inputs.facts, pay: inputs.pay, asset: inputs.asset,
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
    /*
     * **THE COMPANY'S RECORDS A DEVICE READS THE RUN FROM**, to approve it or
     * to make what it sends: its first state as a founding seat signed it, a
     * directory believing that seat, the people as the service holds them, and
     * the runs and proposals as it stores them now.
     */
    const founder = newSigningKeypair();
    const state = signedFoundingState(account, { keyEpoch: 0, sealed: (await ledger.fetch(account, 0))!.sealedState }, founder.secret);
    const people = payroll.listPeople(account, viewingKey);
    const committee = { tag: 'schnorr', value: '7a'.repeat(32) };
    const records: import('vaults-web-shared/run-rebuilt-here.js').CompanyRecordsHere = {
      directory: async () => ({
        dir: { company: account, version: 1, seats: [{ seat: '4e'.repeat(32), person: USERS.ada, signingKey: founder.publicKey, wrappingKey: 'ab'.repeat(32), committeeKey: committee, role: 'admin', retired: null }] },
        holders: { committee: [committee], seats: ['4e'.repeat(32)], approvals: 1, adoptedVaults: [], founding: '4e'.repeat(32), foundingCommittee: [committee], account: 'ac'.repeat(32) } as never,
        another: new Set(),
      }),
      people: async () => ({ people: people.map((person) => ({ person, version: 1, handedOver: true })), notBelieved: [], notPayable: [] }),
      state: async (id) => (id === '0' ? state : null),
      runs: async () => runsFiledBy(new FileStore(process.env.DATA_PATH!).listRuns(account), account, founder.secret),
      proposals: async () => new FileStore(process.env.DATA_PATH!).listProposals(account),
      registry,
    };
    return {
      account, viewingKey, runId: run.id, proposalId: proposal.id,
      ada: created.secrets[0]!, blake: created.secrets[1]!, records,
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
  directoryChain: seats.directoryChain,
});

const { app } = await importTheServer();

let server: Server;
let base: string;
const tokens: Record<keyof typeof USERS, string> = { ada: '', blake: '', cy: '' };

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
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${a.port}`;
  for (const who of ['ada', 'blake', 'cy'] as const) {
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

const aDevice = (who: keyof typeof USERS, company: { account: string; records: import('vaults-web-shared/run-rebuilt-here.js').CompanyRecordsHere }, signer: string) => {
  const stages: string[] = [];
  const doors: import('vaults-web-shared/governed-call-on-device.js').RaiseDoors = {
    service: {
      ...device.governedCallServiceFor(apiAs(who)),
      callState: async () => ({ account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }),
    },
    builder: {
      governedCall: async ({ order, opened }) => {
        /* The worker's own check, with the contract's own pure circuits: every value is the one the device opened. */
        const { refuseWhatThisDeviceDidNotOpen } = await import('vaults-web-shared/governed-call-builder.js');
        const { pureCircuits } = await import('../../contracts/managed/contract/index.js');
        refuseWhatThisDeviceDidNotOpen({ accountPure: pureCircuits as never }, order, opened);
        return { tx: Buffer.from(JSON.stringify({ signer, order: order as Built['order'] } satisfies Built)).toString('base64') };
      },
    },
    material: { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) },
    /* The device's read of the vault is a stand-in too: every send asks it first, and here it can pay. */
    holdings: aVaultHolding(), assets: registryWithTestPrivateForms(),
    accountId: company.account,
    records: company.records,
    progress: (s) => stages.push(s),
    sleep: async () => {}, waitMs: 40, everyMs: 1,
  };
  return { doors, stages };
};

const standing = async (who: keyof typeof USERS, c: { proposalId: string }): Promise<Standing> => {
  const r = await call('POST', `/api/proposals/${c.proposalId}/standing`, { token: tokens[who], body: {} });
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
    const first = settle(device.sendRaiseFromDevice(one.doors, { runId: c.runId, viewingKey: c.viewingKey, asset: TEST_TOKEN }));
    const second = settle(device.sendRaiseFromDevice(two.doors, { runId: c.runId, viewingKey: c.viewingKey, asset: TEST_TOKEN }));
    await until(() => sent.length >= 2 || (sent.length === 1 && (first.done || second.done)));
    gate.open();
    await until(() => first.done && second.done);
    const [won, lost] = first.error === undefined ? [first, second] : [second, first];
    /* RED WHEN: both tabs pass the service's check before either is written - both are handed to the chain. */
    expect(sent.filter((s) => s.circuit === 'propose')).toHaveLength(1);
    expect(won.error).toBeUndefined();
    expect(won.value!.raisedAt).toBeDefined();
    /* RED WHEN: the refusal loses the sentence the page reads to say nothing was sent. */
    expect(String(lost.error?.message)).toMatch(/is being sent from another request right now/u);
    expect(device.nothingWasSentBy(lost.error)).toBe(true);
    expect((await standing('ada', c)).raisedAt).toBeDefined();
  });

  it('TWO SIGNERS APPROVING FROM THEIR OWN DEVICES AT ONCE: BOTH ARE COUNTED, AND THE COUNT IS THE CHAIN\'S', async () => {
    const c = seeded.twoSigners;
    const round = await standing('ada', c);
    const gate = aGate();
    door = async (_c, land) => { const r = await land(); await gate.opened; return r; };
    const ada = aDevice('ada', c, c.ada.signerId);
    const blake = aDevice('blake', c, c.blake.signerId);
    const both = Promise.all([
      device.approveOnDevice(ada.doors, { round, viewingKey: c.viewingKey }),
      device.approveOnDevice(blake.doors, { round, viewingKey: c.viewingKey }),
    ]);
    await until(() => sent.length === 2);
    gate.open();
    const [a, b] = await both;
    /* RED WHEN: an approval relay writes back the count it read before its send, or a lower count after a higher one - one approval is dropped. */
    const after = await standing('blake', c);
    expect(after.approvalCount).toBe(2);
    expect(Math.max(a.approvalCount ?? 0, b.approvalCount ?? 0)).toBe(2);
    /* RED WHEN: the service writes "approved" itself: whether a proposal is approved is judged on a device, where the vault is opened. */
    expect(after.status).toBe('open');
  });

  it('ONE PERSON APPROVING FROM TWO TABS AT ONCE: ONE TRANSACTION, AND THE OTHER TAB IS TOLD NOTHING WAS SENT', async () => {
    const c = seeded.twoTabs;
    const round = await standing('ada', c);
    const gate = aGate();
    door = async (_c, land) => { await gate.opened; return land(); };
    const first = settle(device.approveOnDevice(aDevice('ada', c, c.ada.signerId).doors, { round, viewingKey: c.viewingKey }));
    const second = settle(device.approveOnDevice(aDevice('ada', c, c.ada.signerId).doors, { round, viewingKey: c.viewingKey }));
    await until(() => sent.length >= 2 || (sent.length === 1 && (first.done || second.done)));
    gate.open();
    await until(() => first.done && second.done);
    const [won, lost] = first.error === undefined ? [first, second] : [second, first];
    /* RED WHEN: both tabs' approvals pass the check before either is sent, and both are handed to the chain. */
    expect(sent.filter((s) => s.circuit === 'approve')).toHaveLength(1);
    expect(won.error).toBeUndefined();
    expect(String(lost.error?.message)).toMatch(/is being sent from another request right now/u);
    expect(device.nothingWasSentBy(lost.error)).toBe(true);
    expect((await standing('ada', c)).approvalCount).toBe(1);
  });

  it('A WITHDRAWAL FROM ANOTHER DEVICE WHILE AN APPROVAL IS BEING SENT STAYS A WITHDRAWAL, AND THE APPROVING DEVICE IS NOT TOLD NOTHING WAS SENT', async () => {
    const c = seeded.withdrawn;
    const round = await standing('ada', c);
    const gate = aGate();
    door = async (circuit, land) => { const r = await land(); if (circuit === 'approve') await gate.opened; return r; };
    const approving = settle(device.approveOnDevice(aDevice('ada', c, c.ada.signerId).doors, { round, viewingKey: c.viewingKey }));
    await until(() => sent.length === 1);
    /* Ada raised it; the chain lets the signer who raised a proposal withdraw it, from any device of theirs. */
    const withdrawn = await device.withdrawOnDevice(aDevice('ada', c, c.ada.signerId).doors, { round, viewingKey: c.viewingKey });
    expect(withdrawn.status).toBe('cancelled');
    gate.open();
    await until(() => approving.done);
    /* RED WHEN: the approval relay's write puts back the open record it read before the withdrawal. */
    const after = await standing('ada', c);
    expect(after.status).toBe('cancelled');
    /* RED WHEN: a send that reached the chain is reported to the page as nothing sent, or as sent and not yet seen. */
    expect(approving.error?.name).toBe('WithdrawnWhileSent');
    expect(String(approving.error?.message)).toMatch(/withdrawn while this approval was being sent/u);
    expect(device.nothingWasSentBy(approving.error)).toBe(false);
    expect(sent.map((x) => x.circuit)).toEqual(['approve', 'cancel']);
  });

  it('AN APPROVAL CARRYING A SIGNING SECRET IS REFUSED BY NAME ON THE SERVED ROUTE, AND NOTHING IS SENT', async () => {
    const c = seeded.twoSigners;
    const r = await call('POST', `/api/proposals/${c.proposalId}/approve`, {
      token: tokens.ada, body: { tx: Buffer.from('{}').toString('base64'), signingSecret: c.ada.signingSecret },
    });
    /* RED WHEN: the served approval route stops refusing a signing secret by name - a key sent by an old page is then dropped silently, and nobody is told to replace it. */
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('signing-secret-refused');
    expect(r.body.error).toMatch(/does not accept a signing secret.*replace it\./su);
    expect(sent).toEqual([]);
  });

  it('EVERY RELAY OF A PROPOSAL, AND THE RUN ROUTES THAT RAISE ONE, ANSWER ONLY A MEMBER OF ITS COMPANY: ANYONE ELSE IS TOLD IT IS NOT FOUND', async () => {
    const c = seeded.raisedTwice;
    /* A body no route takes: a member gets past the gate and is refused for the body; nothing is written or sent. */
    const body = { nothing: 'this route takes' };
    const before = await standing('ada', c);
    const routes = [
      ...['approve', 'standing', 'cancel', 'send', 'carry'].map((r) => `/api/proposals/${c.proposalId}/${r}`),
      `/api/accounts/${c.account}/proposals`,
    ];
    for (const path of routes) {
      const stranger = await call('POST', path, { token: tokens.cy, body });
      /* RED WHEN: the route's gate (ownsProposal, ownsRun or member) is taken off, or stops asking whose company it is. */
      expect(stranger.status, `${path} ${JSON.stringify(stranger.body)}`).toBe(404);
      const member = await call('POST', path, { token: tokens.ada, body });
      /* RED WHEN: the gate refuses a member of the company too. */
      expect(member.status, `${path} ${JSON.stringify(member.body)}`).toBe(400);
    }
    expect(sent).toEqual([]);
    expect(await standing('ada', c)).toEqual(before);
  });
});
