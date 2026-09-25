/**
 * **A COMPANY FOUNDED ONE OF ONE SEATS A SECOND SIGNER, RAISES ITS THRESHOLD,
 * AND SEATS A THIRD SIGNER BEYOND IT - THROUGH THE PAGE'S OWN MODULE AND THE
 * SERVED ROUTES, WITH EVERY GOVERNED CALL MADE ON A SIGNER'S DEVICE.**
 *
 * What runs is the page's device module - `seatSignerOnDevice`,
 * `changeThresholdOnDevice` and `governedCallServiceFor` - talking over real
 * HTTP to this server's routes, with three signed-in people. **Two pieces are
 * doubles, and they are named here**:
 *
 *   - the ledger under the server is the simulated one. **Its governed calls
 *     refuse unless they arrive through the door for a device's transaction**,
 *     which is what the chain does to this service: it holds no signer's
 *     secret, so a raise, an approval, a seat or a threshold change made by the
 *     service itself fails the contract's signer check. The door records what
 *     it was handed and then does to the simulated chain what the transaction
 *     would have done;
 *   - the worker that builds and proves a call on the device, and the page's
 *     read of the account's on-chain state, are stand-ins. The stand-in builder
 *     writes down which call it was asked for, and that is what the door carries
 *     out. The real circuits are driven by the device's own builder in
 *     `contracts/test/a-company-seats-its-signers-from-the-page.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

process.env.ALLOW_SIMULATED_COMPANY_ADDRESS = '1';
process.env.ALLOW_MEMORY_SESSIONS = '1';
process.env.DATABASE_URL = '';
process.env.SERVE = '0';
process.env.APP_ORIGIN = 'https://payroll.example';
process.env.DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-seats-')), 'db.json');

const ORIGIN = 'https://payroll.example';

const { SimulatedLedger, SimulatedProofSystem } = await import('../core/ledger.js');
const { MidnightCommitments } = await import('../midnight/commitments.js');
const { handInWiring } = await import('../wiring/handed-in.js');
const { FileStore } = await import('../core/store-file.js');
const { walletKeyOf } = await import('../core/store.js');
const { AccountService, approvalMessage, openAccount } = await import('../core/account.js');
const { NO_ASSET } = await import('../core/assets.js');
const { addressOfSlot, signInWithAWallet } = await import('../testing/wallet-session.js');
const { theNetwork } = await import('../midnight/network.js');
const { sign, newSigningKeypair, newWrappingKeypair, newBlinding } = await import('../core/crypto.js');
const { storedSignerLeaf } = await import('../core/signer-leaf.js');
const device = await import('../web/governed-call-on-device.js');
const { refuseARaiseThatIsNotTheRecordedOne } = await import('../web/governed-call-builder.js');
const { pureCircuits } = await import('../../contracts/managed/contract/index.js');
type Hex = import('../core/crypto.js').Hex;
type Order = import('../web/governed-call-builder.js').GovernedCallOrder;

const NETWORK = theNetwork();
const SLOTS = { ada: 81, blake: 82, cleo: 83, vic: 84, dora: 85 } as const;
const USERS = {
  ada: 'usr_seats_ada', blake: 'usr_seats_blake', cleo: 'usr_seats_cleo', vic: 'usr_seats_vic', dora: 'usr_seats_dora',
} as const;
type Who = keyof typeof USERS;

/* ── the chain: every governed call is refused unless a device's transaction carries it ── */

const ledger = new SimulatedLedger(MidnightCommitments);
const leaves = new Map<string, Hex>();
const sent: Array<{ circuit: string; signer: string }> = [];
let throughTheDoor = false;
const refusedHere: string[] = [];
for (const name of ['propose', 'approve', 'addSigner', 'setThreshold'] as const) {
  const real = (ledger as any)[name].bind(ledger);
  (ledger as any)[name] = async (...args: unknown[]) => {
    if (!throughTheDoor) {
      refusedHere.push(name);
      throw new Error('not a signer on this account');
    }
    return real(...args);
  };
}
Object.assign(ledger, {
  submitProvenCall: async (accountId: string, bytes: Uint8Array, circuit: string) => {
    const built = JSON.parse(Buffer.from(bytes).toString('utf8')) as { signer: string; order: Order };
    const o = built.order;
    if (o.circuit !== circuit) throw new Error(`the door was told ${circuit} and handed ${o.circuit}`);
    sent.push({ circuit, signer: built.signer });
    const by = { signerId: built.signer, leaf: leaves.get(`${accountId} ${built.signer}`)! };
    throughTheDoor = true;
    try {
      if (o.circuit === 'approve') return await ledger.approve(accountId, o.proposal as Hex, by);
      if (o.circuit === 'amendSigner') return await ledger.addSigner(accountId, o.leaf as Hex, o.proposal as Hex, by);
      if (o.circuit === 'setThreshold') return await ledger.setThreshold(accountId, Number(o.threshold), o.proposal as Hex, by);
      if (o.circuit === 'propose' && 'governance' in o) {
        const payload = o.governance.kind === 'add-signer'
          ? MidnightCommitments.signerAddPayload(o.governance.leaf as Hex)
          : MidnightCommitments.signerThresholdPayload(Number(o.governance.threshold));
        return await ledger.propose(accountId, payload, {
          asset: NO_ASSET, amount: 0n, batchDigest: o.half.changeBatchDigest as Hex, salt: o.half.proposalSalt as Hex,
        }, by, MidnightCommitments.noVault());
      }
      throw new Error(`this door does not carry ${o.circuit}`);
    } finally {
      throughTheDoor = false;
    }
  },
});

/* ── one company, founded one of one before the server starts ─────────────── */

const people = {
  blake: { ...newSigningKeypair(), wrapping: newWrappingKeypair(), blinding: newBlinding() },
  cleo: { ...newSigningKeypair(), wrapping: newWrappingKeypair(), blinding: newBlinding() },
};
const scope = MidnightCommitments.allVaults();
const leafOf = (who: 'blake' | 'cleo') =>
  storedSignerLeaf({ signingSecret: people[who].secret, blinding: people[who].blinding, scope }, MidnightCommitments);

const store = new FileStore(process.env.DATA_PATH!);
for (const who of Object.keys(USERS) as Who[]) {
  store.putUser({
    id: USERS[who], email: `${who}@seats.example`, name: who, keyBundle: null, keyBundleVersion: 0,
    walletKey: walletKeyOf(addressOfSlot(SLOTS[who], NETWORK)), createdAt: '2026-09-25T00:00:00.000Z',
  } as never);
}
const accounts = new AccountService(store, ledger, MidnightCommitments);
throughTheDoor = true;
const created = await accounts.create('Seats', [{ name: 'Ada', role: 'admin', userId: USERS.ada }], 1);
throughTheDoor = false;
const company = created.account.id;
const viewingKey = created.viewingKey;
const ada = created.secrets[0]!;
leaves.set(`${company} ${ada.signerId}`, created.account.signers[0]!.leafCommitment as Hex);

/**
 * A person accepts their invitation on their own device: only the public halves
 * and their leaf reach the service. Both are written before the server starts,
 * because the server reads the store file once, when it is imported.
 */
const invited = (who: 'blake' | 'cleo') => {
  const raw = accounts.inviteSigner(company, who, `${who}@seats.example`, 'approver');
  const s = accounts.acceptSignerInvite(raw.token, USERS[who], people[who].publicKey, people[who].wrapping.publicKey, leafOf(who));
  leaves.set(`${company} ${s.id}`, leafOf(who));
  return s.id;
};
const waiting = { blake: invited('blake'), cleo: invited('cleo') };

/* A second company, where Vic holds a viewer's seat beside Ada and one person waits for access. */
const viewed = await accounts.create('Viewed', [
  { name: 'Ada', role: 'admin', userId: USERS.ada }, { name: 'Vic', role: 'viewer', userId: USERS.vic },
], 1);
const viewedWaiting = (() => {
  const pair = newSigningKeypair();
  const raw = accounts.inviteSigner(viewed.account.id, 'Dora', 'dora@seats.example', 'approver');
  return accounts.acceptSignerInvite(raw.token, USERS.dora, pair.publicKey, newWrappingKeypair().publicKey,
    storedSignerLeaf({ signingSecret: pair.secret, blinding: newBlinding(), scope }, MidnightCommitments)).id;
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
const tokens: Record<Who, string> = { ada: '', blake: '', cleo: '', vic: '', dora: '' };

const call = async (method: string, path: string, opts: { token?: string; body?: unknown } = {}) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};

beforeAll(async () => {
  server = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${a.port}`;
  for (const who of Object.keys(USERS) as Who[]) {
    const signedIn = await signInWithAWallet(call, { slot: SLOTS[who], origin: ORIGIN, network: NETWORK });
    expect(signedIn.userId).toBe(USERS[who]);
    tokens[who] = signedIn.token;
  }
});
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });

/* ── the page's side, as one device of one signed-in person ─────────────────── */

const apiAs = (who: Who) => async (path: string, init?: RequestInit) => {
  const r = await fetch(base + path, {
    ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body?.error ?? `request failed: ${r.status}`), { nothingWasSent: body?.nothingWasSent });
  return body;
};

/**
 * One person's device. The builder is a stand-in for the worker, and it asks
 * the same question the worker's builder asks before it builds anything: is
 * this order the proposal its own parts and salt make, with the contract's own
 * pure circuits. So the orders the service hands over, salts included, are
 * checked here as a device would check them. `refuse` names circuits this
 * device fails to build, as a device that stops part-way would.
 */
const aDevice = (who: Who, signerId: string, signingSecret: Hex, refuse: string[] = []) => {
  const doors: import('../web/governed-call-on-device.js').GovernedCallDoors = {
    service: {
      ...device.governedCallServiceFor(apiAs(who)),
      callState: async () => ({ account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }),
    },
    builder: {
      governedCall: async ({ order }) => {
        refuseARaiseThatIsNotTheRecordedOne({ accountPure: pureCircuits as never }, order);
        if (refuse.includes(order.circuit)) throw new Error(`this device could not build ${order.circuit}`);
        return { tx: Buffer.from(JSON.stringify({ signer: signerId, order })).toString('base64') };
      },
    },
    material: { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) },
    accountId: company,
    sleep: async () => {}, waitMs: 40, everyMs: 1,
  };
  return {
    doors,
    signerId,
    /* The proposal as the service answered it is the one the person is shown and signs. */
    sign: (round: any) => sign(approvalMessage(round), signingSecret),
  };
};

const seat = (d: ReturnType<typeof aDevice>, signerId: string, who: 'blake' | 'cleo') =>
  device.seatSignerOnDevice(d.doors, { viewingKey, signerId: d.signerId, sign: d.sign, seat: { signerId, leaf: leafOf(who) } });

/** The company as the server holds it now, opened here with the viewing key as a page opens it. */
const companyNow = async () => openAccount((await call('GET', `/api/accounts/${company}`, { token: tokens.ada })).body, viewingKey);
const signersNow = async () => (await companyNow()).signers.map(s => ({ name: s.name, status: s.status }));

describe('A COMPANY SEATS ITS SIGNERS FROM THEIR OWN DEVICES, ON THE PRODUCT\'S ROUTES', () => {
  let blake = '';

  it('THE SERVICE CANNOT SEAT ANYBODY ITSELF: on an approved proposal, the grant it used to offer reaches a governed call this service holds no secret for', async () => {
    blake = waiting.blake;
    /* Ada's device raises and approves Blake's seat, and stops before carrying it out. */
    await expect(seat(aDevice('ada', ada.signerId, ada.signingSecret, ['amendSigner']), blake, 'blake'))
      .rejects.toThrow(/could not build amendSigner/u);
    expect(sent.map(s => s.circuit)).toEqual(['propose', 'approve']);
    refusedHere.length = 0;
    const r = await call('POST', `/api/accounts/${company}/grant`, { token: tokens.ada, body: { viewingKey, signerId: blake } });
    /* RED WHEN: the service is able to seat a person without a signer's device - it then holds a secret it must not. */
    expect(r.status).not.toBe(200);
    expect(refusedHere).toEqual(['addSigner']);
    expect((await signersNow())).toEqual([
      { name: 'Ada', status: 'active' }, { name: 'blake', status: 'pending' }, { name: 'cleo', status: 'pending' }]);
  });

  it('THE SECOND SIGNER, ALREADY ONE BEYOND A THRESHOLD OF ONE, IS SEATED FROM THE FIRST SIGNER\'S DEVICE', async () => {
    refusedHere.length = 0;
    const out = await seat(aDevice('ada', ada.signerId, ada.signingSecret), blake, 'blake');
    /* RED WHEN: the page cannot raise, approve or carry out a seat - the company then stays one of one. */
    expect(out).toEqual({ state: 'done' });
    expect(sent.map(s => s.circuit)).toEqual(['propose', 'approve', 'amendSigner']);
    expect(refusedHere).toEqual([]);
    expect((await signersNow())).toEqual([
      { name: 'Ada', status: 'active' }, { name: 'blake', status: 'active' }, { name: 'cleo', status: 'pending' }]);
    expect((await ledger.status(company))!.signerCount).toBe(2);
    /* The seated person is a member now, and their sign-in can open the company. */
    expect((await call('GET', `/api/accounts/${company}`, { token: tokens.blake })).status).toBe(200);
  });

  it('THE THRESHOLD IS RAISED TO TWO FROM A DEVICE, AND THE THIRD SIGNER, BEYOND IT, WAITS FOR A SECOND DEVICE', async () => {
    sent.length = 0;
    const adaDevice = aDevice('ada', ada.signerId, ada.signingSecret);
    /* RED WHEN: the threshold cannot be changed from a device - the company can then never require more than one approval. */
    expect(await device.changeThresholdOnDevice(adaDevice.doors, {
      viewingKey, signerId: ada.signerId, sign: adaDevice.sign, newThreshold: 2,
    })).toEqual({ state: 'done' });
    expect((await ledger.status(company))!.threshold).toBe(2);
    expect((await companyNow()).policy.threshold).toBe(2);

    const cleo = waiting.cleo;
    sent.length = 0;
    const first = await seat(adaDevice, cleo, 'cleo');
    /* One approval of two: nothing is carried out, and the page is told the proposal waits for the others. */
    expect(first.state).toBe('waiting-for-approvals');
    expect(sent.map(s => s.circuit)).toEqual(['propose', 'approve']);
    expect((await signersNow()).find(s => s.name === 'cleo')!.status).toBe('pending');

    const blakeSigner = blake;
    const blakeDevice = aDevice('blake', blakeSigner, people.blake.secret);
    /* RED WHEN: the second signer's device cannot approve or carry out a seat - a company larger than its threshold is never finished. */
    expect(await seat(blakeDevice, cleo, 'cleo')).toEqual({ state: 'done' });
    expect(sent.map(s => `${s.circuit} ${s.signer === blakeSigner ? 'blake' : 'ada'}`))
      .toEqual(['propose ada', 'approve ada', 'approve blake', 'amendSigner blake']);
    expect((await signersNow()).map(s => s.status)).toEqual(['active', 'active', 'active']);
    expect((await ledger.status(company))!.signerCount).toBe(3);
    expect(refusedHere).toEqual([]);
  });

  it('A SEAT IS REFUSED BEFORE ANYTHING IS SENT FOR SOMEBODY WHO IS NOT A MEMBER, AND FOR A PERSON NOT WAITING FOR ONE', async () => {
    const r = await call('POST', `/api/accounts/${company}/signers/${ada.signerId}/round`, { token: tokens.ada, body: { viewingKey } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/already has a seat/u);
    const s = await call('POST', `/api/accounts/${company}/signers/${ada.signerId}/seat`, {
      token: tokens.ada, body: { viewingKey, tx: Buffer.from('{}').toString('base64') },
    });
    expect(s.status).toBe(422);
    expect(s.body.nothingWasSent).toBe(true);
    /* Somebody who is not a member of the company is not answered at all. */
    const tx = Buffer.from('{}').toString('base64');
    for (const path of [`signers/${waiting.cleo}/round`, `signers/${waiting.cleo}/seat`, 'threshold/round', 'threshold']) {
      const n = await call('POST', `/api/accounts/${company}/${path}`, { token: tokens.dora, body: { viewingKey, newThreshold: 1, tx } });
      expect(n.status, path).toBe(404);
    }
    /* RED WHEN: a viewer's seat can carry out a seat or a threshold change. */
    sent.length = 0;
    const v = await call('POST', `/api/accounts/${viewed.account.id}/signers/${viewedWaiting}/seat`, {
      token: tokens.vic, body: { viewingKey: viewed.viewingKey, tx },
    });
    expect(v.status).toBe(422);
    expect(v.body.error).toMatch(/only a seated signer who may approve/u);
    const t = await call('POST', `/api/accounts/${viewed.account.id}/threshold`, {
      token: tokens.vic, body: { viewingKey: viewed.viewingKey, newThreshold: 2, tx },
    });
    expect(t.status).toBe(422);
    expect(t.body.error).toMatch(/only a seated signer who may approve/u);
    expect(sent).toEqual([]);
  });
});
