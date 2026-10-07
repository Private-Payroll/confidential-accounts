/**
 * **A RAISE OR A SEND FROM A SIGNER'S DEVICE NAMES THE VERSION OF THE PAGE THAT
 * CHECKED THE VAULT, AND THE PAYMENTS IT CHECKED, AND THE SERVED ROUTES REFUSE
 * ONE THAT DOES NOT.**
 *
 * The service cannot check a vault's private money: only the device can open
 * the vault's notes. So it refuses a device raise or send from a page that does
 * not say it is the current version, and one whose digest of the payments
 * checked is not the digest of what the service is about to write down or send.
 *
 * What runs is this server's own routes over real HTTP, with a signed-in
 * person, and for the ordinary path the page's own device module. **Three
 * pieces are doubles, and they are named here**: the ledger under the server is
 * the simulated one, with a door for a device's transaction that records what
 * it was handed and then does what the transaction would have done; the
 * device's worker, its read of the account's on-chain state and its read of the
 * vault are stand-ins, because no contract and no vault exist here; and, for
 * the ordinary path, the company's first state is re-signed here as its
 * founding seat's record, with the directory, the wallet's read and the people
 * given as a device holds them, because these companies were made by the
 * service. The device reads the company's runs and proposals from the server.
 *
 * The companies and the one proposal written down are made before the server
 * starts, over the same store file and the same ledger it is handed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { importTheServer, useOnlyTheseSettings } from '../testing/server-under-test.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

useOnlyTheseSettings({
  ALLOW_SIMULATED_COMPANY_ADDRESS: '1',
  ALLOW_MEMORY_SESSIONS: '1',
  DATABASE_URL: '',
  SERVE: '0',
  APP_ORIGIN: 'https://payroll.example',
  DATA_PATH: join(mkdtempSync(join(tmpdir(), 'mn-device-raise-')), 'db.json'),
});

const ORIGIN = 'https://payroll.example';

const { SimulatedLedger, SimulatedProofSystem } = await import('../core/ledger.js');
const { MidnightCommitments } = await import('../midnight/commitments.js');
const { handInWiring } = await import('../wiring/handed-in.js');
const { FileStore } = await import('../core/store-file.js');
const { walletKeyOf } = await import('../core/store.js');
const { AccountService } = await import('../core/account.js');
const { PayrollService } = await import('../core/payroll.js');
const { SEED_ASSETS, assets: productAssets } = await import('../core/assets.js');
const { runMaterialFor } = await import('../midnight/run-material.js');
const { vaultDetails } = await import('../testing/vault-details.js');
const { aVaultHolding } = await import('../testing/assets.js');
const { addressOfSlot, signInWithAWallet } = await import('../testing/wallet-session.js');
const { theNetwork } = await import('../midnight/network.js');
const { toHex } = await import('../core/crypto.js');
const { directorySeats } = await import('../testing/directory-seats.js');
const { DEVICE_RAISE_VERSION, paymentChecked, paymentsCheckedDigest, paymentsOnTheWire } = await import('../core/device-raise.js');
type Hex = import('../core/crypto.js').Hex;

const NETWORK = theNetwork();
const SLOT = 81;
const USER = 'usr_device_raise_ada';
const VAULT = toHex(new Uint8Array(32).fill(0xb2));
/* Whichever asset this build can pay privately; the test names none. */
const PRIVATE = SEED_ASSETS.find((a) => a.ledger.shielded !== null)!;
const HELD = 1n << 100n;

/* ── the chain, and its door for a device's transaction ─────────────────── */

const ledger = new SimulatedLedger(MidnightCommitments);
const leaves = new Map<string, Hex>();
const sent: string[] = [];
type Built = {
  signer: string;
  order: {
    circuit: 'propose'; proposal: Hex;
    run: { root: Hex; payees: string; opensAt: string; closesAt: string; vault: Hex };
    half: { changeAmount: string; changeBatchDigest: Hex; proposalSalt: Hex };
  };
};
Object.assign(ledger, {
  submitProvenCall: async (accountId: string, bytes: Uint8Array, circuit: string) => {
    const built = JSON.parse(Buffer.from(bytes).toString('utf8')) as Built;
    sent.push(circuit);
    const o = built.order;
    const r = await ledger.proposeRun(accountId, {
      root: o.run.root, payees: BigInt(o.run.payees), opensAt: BigInt(o.run.opensAt),
      closesAt: BigInt(o.run.closesAt), vault: o.run.vault,
    }, {
      asset: PRIVATE.code, amount: BigInt(o.half.changeAmount), batchDigest: o.half.changeBatchDigest,
      salt: o.half.proposalSalt,
    }, { signerId: built.signer, leaf: leaves.get(`${accountId} ${built.signer}`)! });
    return { ref: `tx_${r.proposalId.slice(0, 8)}`, at: r.at };
  },
});

/* ── the companies, written before the server starts ────────────────────── */

const now = Math.floor(Date.now() / 1000);
const WINDOW = { opensAt: String(now - 60), closesAt: String(now + 3_600) };

/* The service's own reading of the companies' runs, over the store the server is handed: what each check is compared with. */
let theService: InstanceType<typeof PayrollService>;
/* Ada's seat in each company's directory, as her wallet signed it, and the chain's read of it: a stand-in, as the relays check her seat against it. */
const seats = directorySeats();
const seeded = await (async () => {
  const store = new FileStore(process.env.DATA_PATH!);
  store.putUser({
    id: USER, email: 'ada@northwind.example', name: 'ada', keyBundle: null, keyBundleVersion: 0,
    walletKey: walletKeyOf(addressOfSlot(SLOT, NETWORK)), createdAt: '2026-09-23T00:00:00.000Z',
  } as never);
  const accounts = new AccountService(store, ledger, MidnightCommitments, productAssets, aVaultHolding(HELD));
  const payroll = new PayrollService(store, accounts, productAssets);
  theService = payroll;
  const aCompany = async (name: string, writtenDown: boolean, withdrawn = false) => {
    const created = await accounts.create(name, [{ name: 'Ada', role: 'admin', userId: USER }], 1, undefined, drawCompanyLabel());
    const { viewingKey } = created;
    const account = created.account.id;
    for (const s of accounts.open(account, viewingKey).signers) leaves.set(`${account} ${s.id}`, s.leafCommitment as Hex);
    seats.claim(store, account, USER, created.secrets[0]!.signingSecret, 0x61);
    for (let i = 0; i < 3; i++) {
      payroll.hireDirect(account, {
        name: `${name} payee ${i}`, email: `p${i}@${name.toLowerCase()}.example`, title: 'Eng', asset: PRIVATE.code,
        baseAmount: BigInt(100 + i) * 1_000_000n,
      }, viewingKey);
    }
    const { run } = await payroll.createRunFromRoster(account, '2026-08', viewingKey);
    let proposalId: string | undefined;
    if (writtenDown) {
      const inputs = await payroll.runMaterialInputs(run.id, viewingKey);
      const material = await runMaterialFor({
        accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: inputs.facts, pay: inputs.pay, asset: inputs.asset,
        opensAt: BigInt(WINDOW.opensAt), closesAt: BigInt(WINDOW.closesAt), vault: VAULT, detailsOf: vaultDetails,
      });
      const proposal = await payroll.proposeRun(run.id, viewingKey, created.secrets[0]!.signerId, material, undefined, { onDevice: true });
      proposalId = proposal.id;
      if (withdrawn) await accounts.cancel(proposal.id, viewingKey);
    }
    return { account, viewingKey, runId: run.id, signer: created.secrets[0]!.signerId, proposalId };
  };
  return {
    /* One company per refusal, so a refusal that failed to refuse cannot turn the next case red for it. */
    raised: await aCompany('Raised', false),
    written: await aCompany('Written', true),
    sendsOnce: await aCompany('Sendsonce', true),
    withdrawn: await aCompany('Withdrawn', true, true),
  };
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
let token = '';

type Res = { status: number; body: any };
const call = async (method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Res> => {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const post = (path: string, body: unknown) => call('POST', path, { token, body });

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${a.port}`;
  const signedIn = await signInWithAWallet(call, { slot: SLOT, origin: ORIGIN, network: NETWORK });
  expect(signedIn.userId).toBe(USER);
  token = signedIn.token;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { sent.length = 0; });

/* ── what the device would have been handed, and what it would send ─────── */

/**
 * What the service will raise or send for a leg, by its own reading of the run: the leg's recorded payments once it is
 * written down, each person's payment from the roster before. The payments a device's digest is compared with.
 */
const legPayments = async (c: { runId: string; viewingKey: string }) => {
  const recorded = Object.values(theService.requireRun(c.runId, c.viewingKey as Hex).payout ?? {})[0]?.facts;
  const facts = recorded ?? (await theService.runMaterialInputs(c.runId, c.viewingKey as Hex)).facts;
  return { payments: paymentsOnTheWire(facts.map(paymentChecked)) as Array<{ kind: string; token: string; amount: string }> };
};
/** What the service wrote a leg down as, in the shape a device builds it from. */
const writtenDown = async (c: { runId: string; viewingKey: string }) => {
  const o = await theService.raiseOrderOf(c.runId, c.viewingKey as Hex);
  return o === null ? null : {
    proposalId: o.proposalId, chainId: o.chainId,
    order: {
      circuit: 'propose' as const,
      run: { root: o.run.root, payees: o.run.payees.toString(), opensAt: o.run.opensAt.toString(), closesAt: o.run.closesAt.toString(), vault: o.run.vault },
      half: o.half, proposal: o.chainId,
    },
    paymentsChecked: o.paymentsChecked,
  };
};
const digestOf = (payments: Array<{ kind: string; token: string; amount: string }>) =>
  paymentsCheckedDigest(payments);

/*
 * A leg's first raise is made on the signer's device and filed with its proposal and the run as raised, in one
 * request that names this page's version: `a-leg-is-raised-on-the-device.test.ts`. What stays here is the send of a
 * proposal already written down.
 */

describe('A SEND FROM A DEVICE NAMES ITS PAGE, AND CARRIES ONLY THE CALL IT PROVED', () => {
  const send = async (c: { runId: string; viewingKey: string }, more: Record<string, unknown>) =>
    post(`/api/proposals/${(await writtenDown(c))!.proposalId}/send`, { tx: Buffer.from('{}').toString('base64'), ...more });

  it('3. A SEND THAT NAMES NO VERSION, OR ANOTHER, IS REFUSED, AND NOTHING IS SENT', async () => {
    const c = seeded.written;
    for (const [why, more] of [
      ['no version', {}],
      ['the version before', { version: DEVICE_RAISE_VERSION - 1 }],
      ['a version after', { version: DEVICE_RAISE_VERSION + 1 }],
      ['the right number spelled as a string', { version: String(DEVICE_RAISE_VERSION) }],
    ] as const) {
      const r = await send(c, more);
      /* RED WHEN: a send from a page that may not have checked the vault is sent. */
      expect(r.status, why).toBe(422);
      expect(r.body?.nothingWasSent, why).toBe(true);
      expect(String(r.body?.error), why).toMatch(/Reload the page and try again\. Nothing was sent\./u);
    }
    expect(sent).toEqual([]);
  });

  /*
   * **WHAT THE DEVICE CHECKED IS ITS OWN, AND IS COMPARED THERE.** The device
   * holds the proposal written down to the payments it checked against the vault
   * before it builds anything (`refusePaymentsTheVaultCannotPay`, red in
   * `packages/web-shared/src/governed-call-on-device.test.ts` 4c and
   * `one-answer-for-the-page-and-the-service.test.ts` 3); the send carries the
   * proven call and the page's version, and nothing else.
   */
  it('6. A SEND THAT CARRIES WHAT THE DEVICE CHECKED, OR A KEY, IS REFUSED AS A FIELD THE ROUTE DOES NOT TAKE, AND NOTHING IS SENT', async () => {
    const c = seeded.written;
    const checked = digestOf((await legPayments(c)).payments);
    for (const [why, more] of [
      ['the digest of what was checked', { version: DEVICE_RAISE_VERSION, checked }],
      ['the viewing key', { version: DEVICE_RAISE_VERSION, viewingKey: c.viewingKey }],
    ] as const) {
      const r = await send(c, more);
      /* RED WHEN: the send route stops being strict, so a key or anything the device checked rides in with the call. */
      expect(r.status, why).toBe(400);
      expect(r.body?.nothingWasSent, why).toBe(true);
    }
    expect(sent).toEqual([]);
  });

  it('A SEND OF EXACTLY WHAT WAS WRITTEN DOWN GOES OUT', async () => {
    const c = seeded.sendsOnce;
    const asked = await legPayments(c);
    const order = (await writtenDown(c))!;
    /* RED WHEN: the digest of what was written down is not the digest of what a device checks - every good send is then refused on the device. */
    expect(order.paymentsChecked).toBe(digestOf(asked.payments));
    const built = Buffer.from(JSON.stringify({ signer: c.signer, order: order.order })).toString('base64');
    const ok = await post(`/api/proposals/${order.proposalId}/send`, { tx: built, version: DEVICE_RAISE_VERSION });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(sent).toEqual(['propose']);
  });

  it('A SEND OF A WITHDRAWN PROPOSAL IS REFUSED AS WITHDRAWN', async () => {
    const c = seeded.withdrawn;
    const id = c.proposalId!;
    const r = await post(`/api/proposals/${id}/send`, { tx: Buffer.from('{}').toString('base64'), version: DEVICE_RAISE_VERSION });
    /* RED WHEN: a withdrawn proposal is sent, or refused as anything a send again would mend. */
    expect(r.status).toBe(422);
    expect(r.body?.nothingWasSent).toBe(true);
    expect(String(r.body?.error)).toMatch(/this proposal is cancelled, so it is not sent to the chain\. Nothing was sent\./u);
    expect(sent).toEqual([]);
  });

});

describe('THE SERVICE HANDS OUT NOTHING A RAISE IS BUILT FROM: THE DEVICE MAKES IT FROM THE COMPANY\'S RECORDS', () => {
  it('NO ROUTE ANSWERS WITH A LEG\'S PAYMENTS, A WRITTEN-DOWN ORDER, THE LEGS OR WHAT A VAULT PAYS', async () => {
    const c = seeded.raised;
    for (const path of ['leg-payments', 'raise-order', 'legs', 'retry-payments', 'retry-order', 'payments', 'private-payments', 'propose', 'retry']) {
      const r = await post(`/api/runs/${c.runId}/${path}`, { viewingKey: c.viewingKey, indices: [0], proposalId: 'prp_x' });
      /* RED WHEN: a route that opened the run with the viewing key and handed out what a device makes for itself, or raised a run or a retry with it, is back. */
      expect(r.status, path).toBe(404);
      expect(JSON.stringify(r.body), path).not.toMatch(/amount|payments|leaves|salt/u);
    }
  });
});
