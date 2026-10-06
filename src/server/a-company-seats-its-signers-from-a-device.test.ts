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
  DATA_PATH: join(mkdtempSync(join(tmpdir(), 'mn-seats-')), 'db.json'),
});

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
const { sign, newSigningKeypair, newWrappingKeypair, newBlinding, signingPublicKeyOf } = await import('../core/crypto.js');
const { storedSignerLeaf } = await import('../core/signer-leaf.js');
const { newSeatInvitation, proveSeatKeys } =
  await import('../core/seat-invite-proof.js');
const { newSeatKeys } = await import('vaults-web-shared/accept-seat.js');
const { invitePayeeHere, inviteSignerHere, openInvitationHere, acceptAsSignerHere } = await import('vaults-web-shared/invitation-on-device.js');
const { identityFromSecret } = await import('midnight-identity');
const { committeeKeyFor } = await import('midnight-identity/profile/committee-key');
const { signDirectoryEntry } = await import('midnight-identity/profile/records-key');
type CompanyLabel = import('midnight-identity/profile/company-label').CompanyLabel;
type PendingSeat = import('vaults-web-shared/keyring.js').PendingSeat;
const device = await import('vaults-web-shared/governed-call-on-device.js');
const { refuseARaiseThatIsNotTheRecordedOne, refuseWhatThisDeviceDidNotOpen, recordForOneCall, NotWhatThisDeviceOpened } =
  await import('vaults-web-shared/governed-call-builder.js');
const { unseal, parseCanonical } = await import('../core/crypto.js');
const { pureCircuits } = await import('../../contracts/managed/contract/index.js');
type Hex = import('../core/crypto.js').Hex;
type Order = import('vaults-web-shared/governed-call-builder.js').GovernedCallOrder;

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
const created = await accounts.create('Seats', [{ name: 'Ada', role: 'admin', userId: USERS.ada }], 1, undefined, drawCompanyLabel());
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
  const keys = { signingPublicKey: people[who].publicKey, wrappingPublicKey: people[who].wrapping.publicKey, leafCommitment: leafOf(who) };
  /* With the proof the person's link let their device make, as the join page sends it. */
  const s = accounts.acceptSignerInvite(raw.token, USERS[who], keys.signingPublicKey, keys.wrappingPublicKey, keys.leafCommitment,
    proveSeatKeys(newSeatInvitation(viewingKey, company, who, 'approver'), keys));
  leaves.set(`${company} ${s.id}`, leafOf(who));
  return s.id;
};
const waiting = { blake: invited('blake'), cleo: invited('cleo') };

/* A second company, where Vic holds a viewer's seat beside Ada and one person waits for access. */
const viewed = await accounts.create('Viewed', [
  { name: 'Ada', role: 'admin', userId: USERS.ada }, { name: 'Vic', role: 'viewer', userId: USERS.vic },
], 1, undefined, drawCompanyLabel());
const viewedWaiting = (() => {
  const pair = newSigningKeypair();
  const raw = accounts.inviteSigner(viewed.account.id, 'Dora', 'dora@seats.example', 'approver');
  const keys = {
    signingPublicKey: pair.publicKey, wrappingPublicKey: newWrappingKeypair().publicKey,
    leafCommitment: storedSignerLeaf({ signingSecret: pair.secret, blinding: newBlinding(), scope }, MidnightCommitments),
  };
  return accounts.acceptSignerInvite(raw.token, USERS.dora, keys.signingPublicKey, keys.wrappingPublicKey, keys.leafCommitment,
    proveSeatKeys(newSeatInvitation(viewed.viewingKey, viewed.account.id, 'Dora', 'approver'), keys)).id;
})();

/* A third company, two of two, where an invitation is raised on one device and seated from two. */
const joined = await accounts.create('Joined', [
  { name: 'Ada', role: 'admin', userId: USERS.ada }, { name: 'Blake', role: 'approver', userId: USERS.blake },
], 2, undefined, drawCompanyLabel());
for (const [i, sg] of joined.account.signers.entries()) {
  leaves.set(`${joined.account.id} ${joined.secrets[i]!.signerId}`, sg.leafCommitment as Hex);
}
/*
 * Ada's seat in Joined's directory, as her own wallet would have signed it: the
 * key her filings are signed with is her device's signing key, so the
 * invitations her device makes are hers by the directory's own check.
 */
const adaInJoined = (() => {
  const identity = identityFromSecret(new Uint8Array(32).fill(41));
  const label = store.getAccount(joined.account.id)!.companyLabel as CompanyLabel;
  const account = store.getAccount(joined.account.id)!.contractAddress as never;
  const committeeKey = committeeKeyFor(identity, label) as { tag: string; value: string };
  const statement = signDirectoryEntry(identity, label, account, new Uint8Array(32).fill(141),
    signingPublicKeyOf(joined.secrets[0]!.signingSecret), '41'.repeat(32));
  store.fileDirectory(joined.account.id, { company: joined.account.id, version: 1, change: { kind: 'claim', entry: { person: USERS.ada, committeeKey, statement } } });
  return { committeeKey, statement, signingSecret: joined.secrets[0]!.signingSecret, label, account };
})();

handInWiring({
  name: 'simulated',
  commitments: MidnightCommitments,
  createLedger: () => ledger,
  createProofSystem: () => new SimulatedProofSystem(),
  /* The chain as the server reads Joined's account: Ada's wallet on its committee and her seat held, one approval. */
  directoryChain: async (accountId, seats) => (accountId !== joined.account.id ? null : {
    seats: { committee: [adaInJoined.committeeKey], threshold: 1, seats: seats.filter((x) => x === adaInJoined.statement.seat) },
    approvals: 1,
  }),
});

const { app } = await importTheServer();

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
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
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

/** The account's asset blinding each raise was composed with, in order, as the worker's record holds it. */
const blindingsProvedWith: string[] = [];

/**
 * One person's device. The builder is a stand-in for the worker, and it asks
 * the same questions the worker's builder asks before it builds anything, with
 * the contract's own pure circuits: is every value the service handed over the
 * one this device opened from the company's own sealed records, and is this
 * order the proposal its own parts and salt make. So the orders the service
 * hands over, salts included, are checked here as a device would check them,
 * and the record is composed as the worker composes it. `refuse` names
 * circuits this device fails to build, as a device that stops part-way would.
 */
const aDevice = (who: Who, signerId: string, signingSecret: Hex, refuse: string[] = [], accountId: string = company) => {
  const doors: import('vaults-web-shared/governed-call-on-device.js').GovernedCallDoors = {
    service: {
      ...device.governedCallServiceFor(apiAs(who)),
      callState: async () => ({ account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }),
    },
    builder: {
      governedCall: async ({ order, opened }) => {
        refuseWhatThisDeviceDidNotOpen({ accountPure: pureCircuits as never }, order, opened);
        refuseARaiseThatIsNotTheRecordedOne({ accountPure: pureCircuits as never }, order);
        const record = recordForOneCall(order, { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) }, opened);
        if (order.circuit === 'propose') blindingsProvedWith.push(Buffer.from(record.assetBlinding).toString('hex'));
        if (refuse.includes(order.circuit)) throw new Error(`this device could not build ${order.circuit}`);
        return { tx: Buffer.from(JSON.stringify({ signer: signerId, order })).toString('base64') };
      },
    },
    material: { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) },
    accountId,
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

  it('1. A SIGNER SEATED AFTER THE COMPANY WAS CREATED RAISES AND APPROVES A ROUND FROM THEIR OWN DEVICE, AND 4. THE COMPANY FINISHES IT', async () => {
    sent.length = 0;
    blindingsProvedWith.length = 0;
    const blakeDevice = aDevice('blake', blake, people.blake.secret);
    /* RED WHEN: a signer seated after the deploy cannot raise or approve - their seat then acts on nothing. */
    expect((await device.changeThresholdOnDevice(blakeDevice.doors, { viewingKey, signerId: blake, sign: blakeDevice.sign, newThreshold: 3 })).state)
      .toBe('waiting-for-approvals');
    expect(sent.map(s => `${s.circuit} ${s.signer === blake ? 'blake' : 'other'}`)).toEqual(['propose blake', 'approve blake']);
    /* The raise is proved with the account's own blinding, which the service reads from the account's sealed state. */
    const kept = await ledger.fetch(company, accounts.require(company).keyEpoch);
    expect(blindingsProvedWith).toEqual([parseCanonical<any>(unseal(kept!.sealedState, viewingKey)).blinding.assetBlinding]);

    /* RED WHEN: an honest company cannot finish a round a late signer raised. */
    const adaDevice = aDevice('ada', ada.signerId, ada.signingSecret);
    expect(await device.changeThresholdOnDevice(adaDevice.doors, { viewingKey, signerId: ada.signerId, sign: adaDevice.sign, newThreshold: 3 }))
      .toEqual({ state: 'done' });
    expect((await ledger.status(company))!.threshold).toBe(3);
    expect(refusedHere).toEqual([]);
  });

  it('2. A SALT OR AN IDENTITY THE COMPANY\'S RECORDS DO NOT HOLD IS REFUSED ON THE DEVICE BY NAME, AND NOTHING IS SENT', async () => {
    const vAda = viewed.secrets[0]!;
    const doraLeaf = (await call('GET', `/api/accounts/${viewed.account.id}`, { token: tokens.ada })).body;
    const leaf = openAccount(doraLeaf, viewed.viewingKey).signers.find(x => x.id === viewedWaiting)!.leafCommitment as Hex;
    const tamper = (change: (a: any) => void) => {
      const d = aDevice('ada', vAda.signerId, vAda.signingSecret, [], viewed.account.id);
      const plain = d.doors.service;
      return {
        ...d,
        doors: { ...d.doors, service: { ...plain, seatRound: async (id: string, s: string, body: any) => {
          const a = await plain.seatRound!(id, s, body); change(a); return a;
        } } },
      };
    };
    const OTHER = 'ee'.repeat(32);
    for (const [value, change] of [
      ['salt', (a: any) => { a.asked.proposalSalt = OTHER; a.order.order.half.proposalSalt = OTHER; }],
      ['proposal identity', (a: any) => { a.proposal.chainId = OTHER; a.order.chainId = OTHER; a.order.order.proposal = OTHER; }],
    ] as const) {
      sent.length = 0;
      const d = tamper(change);
      const refused = await device.seatSignerOnDevice(d.doors, {
        viewingKey: viewed.viewingKey, signerId: vAda.signerId, sign: d.sign, seat: { signerId: viewedWaiting, leaf },
      }).catch(e => e);
      /* RED WHEN: a value the service substituted reaches a proof - or is refused without saying which value it was. */
      expect(refused, value).toBeInstanceOf(NotWhatThisDeviceOpened);
      expect(refused.value).toBe(value);
      expect(sent).toEqual([]);
    }
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
  it('AN INVITATION MADE ON ONE DEVICE IS ACCEPTED ON THE INVITEE\'S OWN AND SEATED FROM TWO OTHERS, END TO END', async () => {
    const at = joined.account.id;
    const [jAda, jBlake] = joined.secrets as [typeof joined.secrets[0], typeof joined.secrets[0]];
    /* Ada's device makes the invitation: the token, the sealed offer and the seat's secret never leave it. */
    const sendAs = (who: Who) => async (path: string, init: { method: 'GET' | 'POST'; body?: string }) => {
      const r = await fetch(base + path, { method: init.method, ...(init.body === undefined ? {} : { body: init.body }),
        headers: { 'content-type': 'application/json', ...(who === 'dora' || init.method === 'POST' ? { authorization: `Bearer ${tokens[who]}` } : {}) } });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const opened = await call('GET', `/api/accounts/${at}`, { token: tokens.ada });
    const made = await inviteSignerHere({
      id: at, name: 'Joined', label: adaInJoined.label, account: adaInJoined.account, inboxPublicKey: opened.body.inboxPublicKey,
      keyEpoch: opened.body.keyEpoch, viewingKey: joined.viewingKey,
    }, adaInJoined, { name: 'Dora', role: 'approver' }, ORIGIN, sendAs('ada'));
    /* Dora's device, signed in as Dora, opens the link and accepts with nothing but what the link carries. */
    const sealedThere: PendingSeat[] = [];
    const accepted = await acceptAsSignerHere(await openInvitationHere(made.link, sendAs('dora')), MidnightCommitments, {
      newKeys: newSeatKeys,
      seal: async (seat) => { sealedThere.push(seat); },
      promote: async () => {},
    }, sendAs('dora'));
    const leaf = storedSignerLeaf(sealedThere[0]!, MidnightCommitments);
    /* Ada's device raises the seat and approves it; two approvals are needed, so it waits. */
    const adaDevice = aDevice('ada', jAda.signerId, jAda.signingSecret, [], at);
    const first = await device.seatSignerOnDevice(adaDevice.doors, {
      viewingKey: joined.viewingKey, signerId: jAda.signerId, sign: adaDevice.sign, seat: { signerId: accepted.signerId!, leaf } });
    /* RED WHEN: the device that raised the invitation cannot raise the seat of a key that arrived from another device. */
    expect(first.state).toBe('waiting-for-approvals');
    /* Blake's device, which raised nothing, approves it and carries it out. */
    const blakeDevice = aDevice('blake', jBlake.signerId, jBlake.signingSecret, [], at);
    const second = await device.seatSignerOnDevice(blakeDevice.doors, {
      viewingKey: joined.viewingKey, signerId: jBlake.signerId, sign: blakeDevice.sign, seat: { signerId: accepted.signerId!, leaf } });
    /* RED WHEN: an honest invitation accepted on the invitee's own device cannot be seated. */
    expect(second).toEqual({ state: 'done' });
    const now = openAccount((await call('GET', `/api/accounts/${at}`, { token: tokens.ada })).body, joined.viewingKey);
    /* RED WHEN: the seat carried out is not recorded, and Dora stays waiting. */
    expect(now.signers.map((x) => ({ name: x.name, status: x.status }))).toEqual([
      { name: 'Ada', status: 'active' }, { name: 'Blake', status: 'active' }, { name: 'Dora', status: 'active' }]);
    /* RED WHEN: the key seated is not the one made and kept on Dora's device. */
    expect(now.signers.find((x) => x.name === 'Dora')!.signingPublicKey).toBe(sealedThere[0]!.signingPublicKey);
  });

  it('A PERSON\'S STATUS AND ADMISSION ANSWER ONLY A MEMBER OF THEIR COMPANY, BEHIND THE SERVICE\'S OWN GATE', async () => {
    const at = joined.account.id;
    const sendAs = (who: Who) => async (path: string, init: { method: string; body?: string }) => {
      const r = await fetch(base + path, { method: init.method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` }, ...(init.body === undefined ? {} : { body: init.body }) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const opened = await call('GET', `/api/accounts/${at}`, { token: tokens.ada });
    const made = await invitePayeeHere({
      id: at, name: 'Joined', label: adaInJoined.label, account: adaInJoined.account, inboxPublicKey: opened.body.inboxPublicKey,
      keyEpoch: opened.body.keyEpoch, viewingKey: joined.viewingKey,
    }, adaInJoined, { name: 'Eli', email: 'eli@joined.co', title: 'Engineer', asset: NO_ASSET as never, baseAmount: 1n, startDate: '2026-10-01' }, ORIGIN, sendAs('ada'));
    const person = made.person!;
    for (const [path, member] of [[`/api/people/${person}/status`, 'not-this-change'], [`/api/employees/${person}/admit`, 'nothing-handed-over']] as const) {
      /* RED WHEN: somebody who is not a member of the person's company reaches the route at all. */
      expect((await call('POST', path, { token: tokens.vic, body: {} })).status, path).toBe(404);
      /* RED WHEN: a member of the person's company is turned away at the gate rather than answered by the route. */
      expect((await call('POST', path, { token: tokens.ada, body: {} })).body, path).toMatchObject({ refused: member });
    }
  });

  it('A PAYEE INVITED, ACCEPTED AND ADMITTED FROM DEVICES, AGAINST THE SERVICE\'S OWN ROUTES', async () => {
    const { acceptAsPayeeHere } = await import('vaults-web-shared/invitation-on-device.js');
    const { admitHere, readPeopleHere } = await import('vaults-web-shared/people-on-device.js');
    const { directoryHere } = await import('vaults-web-shared/vault-page-doors.js');
    const { signJoinCode } = await import('midnight-identity/profile/join-code');
    const { signRecordsKey } = await import('midnight-identity/profile/records-key');
    const { payeeFor } = await import('../testing/payees.js');
    const { TEST_SETTLEMENT_ASSET } = await import('../core/assets.js');
    const at = joined.account.id;
    const sendAs = (who: Who) => async (path: string, init: { method: string; body?: string }) => {
      const r = await fetch(base + path, { method: init.method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` }, ...(init.body === undefined ? {} : { body: init.body }) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const opened = await call('GET', `/api/accounts/${at}`, { token: tokens.ada });
    const company = {
      id: at, name: 'Joined', label: adaInJoined.label, account: adaInJoined.account, inboxPublicKey: opened.body.inboxPublicKey,
      keyEpoch: opened.body.keyEpoch, viewingKey: joined.viewingKey,
    };
    const made = await invitePayeeHere(company, adaInJoined, { name: 'Fen', email: 'fen@joined.co', title: 'Engineer', asset: TEST_SETTLEMENT_ASSET, baseAmount: 1n, startDate: '2026-10-01' }, ORIGIN, sendAs('ada'));
    /* Fen's own wallet signs the code for where Fen is paid, and Fen's device accepts the link with it. */
    const address = payeeFor('7e'.repeat(32), NETWORK).bech32;
    const code = signJoinCode(identityFromSecret(new Uint8Array(32).fill(77)), adaInJoined.label, USERS.vic, { kind: 'payee', address, payslipKey: 'cd'.repeat(32) });
    const accepted = await acceptAsPayeeHere(await openInvitationHere(made.link, sendAs('vic')), code, sendAs('vic'));
    /* RED WHEN: the service's invitation list hands a member the acceptance's hash, the sealed offer or what the payee handed over. */
    const listed = (await call('GET', `/api/accounts/${at}/invites`, { token: tokens.ada })).body as Record<string, unknown>[];
    const mine = listed.find((i) => i.subjectId === made.person);
    expect(mine, 'the invitation is listed').toBeDefined();
    for (const field of ['acceptanceHash', 'offer', 'handover', 'token']) expect(Object.keys(mine!), field).not.toContain(field);
    /* Ada's device: the directory as she believes it, her wallet's read of the chain, and her wallet's statement of her records key. */
    const seatOfAda = adaInJoined.statement.seat;
    const device = {
      company, signingSecret: adaInJoined.signingSecret, signedInAs: USERS.ada, send: sendAs('ada'), network: NETWORK,
      directory: () => directoryHere({
        accountId: at, label: adaInJoined.label,
        filings: async () => (await call('GET', `/api/accounts/${at}/directory`, { token: tokens.ada })).body.filings,
        holders: async () => ({ committee: [adaInJoined.committeeKey], threshold: 1, seats: [seatOfAda], approvals: 1, adoptedVaults: [], account: adaInJoined.account }),
        attested: async () => [{ committeeKey: adaInJoined.committeeKey, statement: signRecordsKey(identityFromSecret(new Uint8Array(32).fill(41)), adaInJoined.label, adaInJoined.account, new Uint8Array(32).fill(141), seatOfAda) }],
      }),
    };
    const here = (await readPeopleHere(device)).people.find((p) => p.person.id === made.person)!;
    expect(here.handedOver).toBe(true);
    /* RED WHEN: the service's own hand-over route or invitation list gives the admitting device something it cannot admit from. */
    const admitted = await admitHere(device, here, accepted.fingerprint);
    expect(admitted).toMatchObject({ status: 'active', address: { bech32: address }, wrappingPublicKey: 'cd'.repeat(32) });
    const after = (await readPeopleHere(device)).people.find((p) => p.person.id === made.person)!;
    expect([after.person.status, after.handedOver]).toEqual(['active', false]);
  });
});
