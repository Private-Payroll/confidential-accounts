/**
 * **A COMPANY FOUNDED ONE OF ONE SEATS A SECOND SIGNER, CHANGES ITS AND A
 * VAULT'S THRESHOLD, SEATS A THIRD SIGNER BEYOND IT AND WITHDRAWS A PROPOSAL -
 * THROUGH THE PAGE'S OWN MODULE AND THE SERVED ROUTES, WITH EVERY GOVERNED CALL
 * MADE, AND EVERY PROPOSAL AND ROSTER WRITTEN, ON A SIGNER'S DEVICE.**
 *
 * What runs is the page's device module - `seatSignerOnDevice`,
 * `changeThresholdOnDevice`, `changeVaultThresholdOnDevice`, `withdrawOnDevice`
 * and `governedCallServiceFor` - talking over real HTTP to this server's
 * routes, with signed-in people whose wallets signed their directory entries.
 * The service is handed no viewing key anywhere. **Three pieces are doubles,
 * and they are named here**:
 *
 *   - the ledger under the server is the simulated one. **Its governed calls
 *     refuse unless they arrive through the door for a device's transaction**,
 *     which is what the chain does to this service: it holds no signer's
 *     secret. The door records what it was handed and then does to the
 *     simulated chain what the transaction would have done;
 *   - the worker that builds and proves a call on the device, and the page's
 *     read of the account's on-chain state, are stand-ins. The stand-in builder
 *     checks what it is asked against what the device opened, with the
 *     contract's own pure circuits, and writes down which call it was asked for;
 *   - the chain's read of who holds the account (its committee and seats, as
 *     the server and each wallet read them) is a list this test keeps: a seat is
 *     added to it when the test says its wallet joined the committee.
 *
 * The real circuits are driven by the device's own builder in
 * `contracts/test/a-company-seats-its-signers-from-the-page.test.ts`.
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
const { AccountService, openAccount } = await import('../core/account.js');
const { NO_ASSET } = await import('../core/assets.js');
const { addressOfSlot, signInWithAWallet } = await import('../testing/wallet-session.js');
const { theNetwork } = await import('../midnight/network.js');
const { newSigningKeypair, newWrappingKeypair, newBlinding, signingPublicKeyOf, toHex, unwrapKey, unseal, parseCanonical } = await import('../core/crypto.js');
const { storedSignerLeaf } = await import('../core/signer-leaf.js');
const { newProposalId } = await import('../core/proposal-filing.js');
const { approverRosterFrom } = await import('../core/vault-approvers.js');
const { signedFoundingState } = await import('../core/founding-state.js');
const { signedFoundingRoster } = await import('../core/roster-record.js');
const { signVaultKeys } = await import('../core/vault-keys.js');
const { invitePayeeHere, inviteSignerHere, openInvitationHere, acceptAsSignerHere, FingerprintsDiffer } = await import('vaults-web-shared/invitation-on-device.js');
const { admitSignerHere, foldOffersHere, offerVaultKeysHere, rosterHere } = await import('vaults-web-shared/roster-here.js');
const { directoryHere } = await import('vaults-web-shared/vault-page-doors.js');
const { aDevicesRosterMemory } = await import('../testing/a-roster-a-seat-filed.js');
const { identityFromSecret } = await import('midnight-identity');
const { committeeKeyFor } = await import('midnight-identity/profile/committee-key');
const { signDirectoryEntry, signRecordsKey } = await import('midnight-identity/profile/records-key');
type CompanyLabel = import('midnight-identity/profile/company-label').CompanyLabel;
type PendingSeat = import('vaults-web-shared/keyring.js').PendingSeat;
const device = await import('vaults-web-shared/governed-call-on-device.js');
const { refuseARaiseThatIsNotTheRecordedOne, refuseWhatThisDeviceDidNotOpen, recordForOneCall, identityOfAChange } =
  await import('vaults-web-shared/governed-call-builder.js');
const { pureCircuits } = await import('../../contracts/managed/contract/index.js');
type Hex = import('../core/crypto.js').Hex;
type Order = import('vaults-web-shared/governed-call-builder.js').GovernedCallOrder;
type Doors = import('vaults-web-shared/governed-call-on-device.js').GovernanceDoors & { roster: import('vaults-web-shared/roster-here.js').RosterDoors };

const NETWORK = theNetwork();
const SLOTS = { ada: 81, blake: 82, cleo: 83, vic: 84, dora: 85 } as const;
const USERS = {
  ada: 'usr_seats_ada', blake: 'usr_seats_blake', cleo: 'usr_seats_cleo', vic: 'usr_seats_vic', dora: 'usr_seats_dora',
} as const;
type Who = keyof typeof USERS;

/* ── the chain: every governed call is refused unless a device's transaction carries it ── */

const ledger = new SimulatedLedger(MidnightCommitments);
/** Each signer's leaf on the simulated chain, by company and roster id: what the door acts as. */
const leaves = new Map<string, Hex>();
const sent: Array<{ circuit: string; signer: string }> = [];
let throughTheDoor = false;
const refusedHere: string[] = [];
for (const name of ['propose', 'approve', 'addSigner', 'setThreshold', 'setVaultThreshold', 'cancel'] as const) {
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
      if (o.circuit === 'cancel') return await ledger.cancel(accountId, o.proposal as Hex, by);
      if (o.circuit === 'amendSigner') return await ledger.addSigner(accountId, o.leaf as Hex, o.proposal as Hex, by);
      if (o.circuit === 'setThreshold') return await ledger.setThreshold(accountId, Number(o.threshold), o.proposal as Hex, by);
      if (o.circuit === 'setVaultThreshold') {
        return await ledger.setVaultThreshold(accountId, o.vault as Hex, Number(o.threshold), o.proposal as Hex, by);
      }
      if (o.circuit === 'propose' && 'governance' in o) {
        const g = o.governance;
        const payload = g.kind === 'add-signer' ? MidnightCommitments.signerAddPayload(g.leaf as Hex)
          : g.kind === 'vault-threshold' ? MidnightCommitments.vaultThresholdPayload(g.vault as Hex, Number(g.threshold))
            : MidnightCommitments.signerThresholdPayload(Number((g as { threshold: string }).threshold));
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

/* ── who holds each company's account, as the chain answers the server and each wallet ── */

const holding = new Map<string, { committee: Array<{ tag: string; value: string }>; seats: Set<string> }>();
const holds = (company: string, wallet: Wallet) => {
  const h = holding.get(company) ?? { committee: [], seats: new Set<string>() };
  h.committee.push(wallet.committeeKey);
  h.seats.add(wallet.seat);
  holding.set(company, h);
};

/** One person's wallet on one company: its committee key, the records key it attests, its seat and its entry. */
interface Wallet {
  readonly identity: ReturnType<typeof identityFromSecret>;
  readonly companyKey: Uint8Array;
  readonly committeeKey: { tag: string; value: string };
  readonly seat: string;
  readonly signing: { secret: Hex; publicKey: Hex };
  /** The blinding the person's device makes their leaf with: their seat is that leaf, as the chain holds it. */
  readonly blinding: Hex;
}
const walletOf = (n: number, label: CompanyLabel, signingSecret?: Hex, seat?: string): Wallet => {
  const identity = identityFromSecret(new Uint8Array(32).fill(n));
  const secret = signingSecret ?? newSigningKeypair().secret;
  const blinding = newBlinding();
  return {
    identity, companyKey: new Uint8Array(32).fill(100 + n), committeeKey: committeeKeyFor(identity, label) as never,
    seat: (seat ?? storedSignerLeaf({ signingSecret: secret, blinding }, MidnightCommitments)).toLowerCase(),
    signing: { secret, publicKey: signingPublicKeyOf(secret) }, blinding,
  };
};
const entryOf = (w: Wallet, label: CompanyLabel, account: never) =>
  signDirectoryEntry(w.identity, label, account, w.companyKey, w.signing.publicKey, w.seat);

/* ── one company, founded one of one before the server starts ─────────────── */

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
const viewingKey = created.viewingKey as Hex;
const ada = created.secrets[0]!;
const LABEL = store.getAccount(company)!.companyLabel as CompanyLabel;
const ACCOUNT = store.getAccount(company)!.contractAddress as never;
leaves.set(`${company} ${ada.signerId}`, created.account.signers[0]!.leafCommitment as Hex);

/*
 * Each person's wallet signs their directory entry for the key their device
 * files with, before the server starts (it reads the store file once). Ada's
 * filing key is the one her device made at the founding; the others' are the
 * keys their devices will make when they accept their invitations.
 */
const wallets = {
  ada: walletOf(0x41, LABEL, ada.signingSecret as Hex, created.account.signers[0]!.leafCommitment as string),
  blake: walletOf(0x42, LABEL), cleo: walletOf(0x43, LABEL), dora: walletOf(0x45, LABEL), vic: walletOf(0x44, LABEL),
};
for (const [i, who] of (['ada', 'blake', 'cleo', 'dora', 'vic'] as const).entries()) {
  const w = wallets[who];
  store.fileDirectory(company, { company, version: i + 1, change: { kind: 'claim', entry: { person: USERS[who], committeeKey: w.committeeKey, statement: entryOf(w, LABEL, ACCOUNT) } } });
}
holds(company, wallets.ada);
/*
 * Ada's seat files the company's first roster, as the founding device files it
 * with the company: her entry, with the vault keys and records-key statement her wallet signed, which is what her
 * later filings are believed by.
 */
{
  const w = wallets.ada;
  const statement = signRecordsKey(w.identity, LABEL, ACCOUNT, w.companyKey, w.seat);
  const opened = openAccount(store.getAccount(company)!, viewingKey, null);
  const signers = opened.signers.map((x) => (x.id !== ada.signerId ? x : {
    ...x,
    vaultKeys: signVaultKeys(company, ada.signerId, {
      committeeKey: w.committeeKey, recordsKey: statement.recordsKey as Hex, recordsKeyStatement: statement.signature as Hex, recordsKeySeat: w.seat as Hex,
    }, w.signing.secret),
  }));
  expect(store.fileRoster(signedFoundingRoster(company, { name: opened.name, signers }, viewingKey, w.signing.secret))).toBeNull();
}

/** The state the founding seat signed, as the company's records hold it: the asset blinding every raise is composed with. */
const foundingState = signedFoundingState(company, { keyEpoch: 0, sealed: (await ledger.fetch(company, 0))!.sealedState }, ada.signingSecret as Hex);

/* A second company, two of two, where people are invited and admitted as payees. */
const joined = await accounts.create('Joined', [
  { name: 'Ada', role: 'admin', userId: USERS.ada }, { name: 'Blake', role: 'approver', userId: USERS.blake },
], 2, undefined, drawCompanyLabel());
const adaInJoined = (() => {
  const label = store.getAccount(joined.account.id)!.companyLabel as CompanyLabel;
  const account = store.getAccount(joined.account.id)!.contractAddress as never;
  const w = walletOf(0x41, label, joined.secrets[0]!.signingSecret as Hex);
  const statement = entryOf(w, label, account);
  store.fileDirectory(joined.account.id, { company: joined.account.id, version: 1, change: { kind: 'claim', entry: { person: USERS.ada, committeeKey: w.committeeKey, statement } } });
  holds(joined.account.id, w);
  return { committeeKey: w.committeeKey, statement, signingSecret: w.signing.secret, label, account, wallet: w };
})();

handInWiring({
  name: 'simulated',
  commitments: MidnightCommitments,
  createLedger: () => ledger,
  createProofSystem: () => new SimulatedProofSystem(),
  directoryChain: async (accountId, seats) => {
    const h = holding.get(accountId);
    return h === undefined ? null : { seats: { committee: [...h.committee], threshold: 1, seats: seats.filter((x) => h.seats.has(x)) }, approvals: 1 };
  },
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
const sendAs = (who: Who) => async (path: string, init: { method: string; body?: string }) => {
  const r = await fetch(base + path, { method: init.method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` }, ...(init.body === undefined ? {} : { body: init.body }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

/** The account's asset blinding each raise was composed with, in order, as the worker's record holds it. */
const blindingsProvedWith: string[] = [];
const COMPANY_WIDE = 'cc'.repeat(32);

/** The company's records as one person's device reads them: the directory against their wallet's read of the chain. */
/** What one person's device reads to believe the company's records: its directory, and their wallet's read of the chain. */
/** What each person's device keeps of the roster between its reads. */
const memories = new Map<Who, ReturnType<typeof aDevicesRosterMemory>>();
const memoryOf = (who: Who) => memories.get(who) ?? memories.set(who, aDevicesRosterMemory()).get(who)!;
const readsOf = (who: Who) => ({
  believed: memoryOf(who),
  filings: async () => (await call('GET', `/api/accounts/${company}/directory`, { token: tokens[who] })).body.filings,
  holders: async () => {
    const h = holding.get(company)!;
    return { committee: [...h.committee], threshold: 1, seats: [...h.seats], approvals: 1, adoptedVaults: [], founding: wallets.ada.seat,
      foundingCommittee: [wallets.ada.committeeKey], account: ACCOUNT } as never;
  },
});
const recordsOf = (who: Who) => ({
  directory: () => directoryHere({
    accountId: company, label: LABEL,
    ...readsOf(who),
    attested: async () => (Object.values(wallets)).map((w) => ({ committeeKey: w.committeeKey, statement: signRecordsKey(w.identity, LABEL, ACCOUNT, w.companyKey, w.seat) })),
  }),
  state: async (id: string) => (id === '0' ? foundingState : null),
  people: async () => { throw new Error('no person is read in this test'); },
  runs: async () => { throw new Error('no run is read in this test'); },
});

/**
 * One person's device. The builder is a stand-in for the worker, and it asks
 * the questions the worker's builder asks before it builds anything, with the
 * contract's own pure circuits: is every value the one this device opened from
 * the company's own sealed records, and is a raise the proposal its own parts
 * and salt make. `refuse` names circuits this device fails to build, as a
 * device that stops part-way would. `adopted` is the vaults its wallet read the
 * account as having adopted.
 */
const aDevice = (who: Who, signerId: string, o: { refuse?: string[]; adopted?: string[]; service?: (s: any) => any } = {}): Doors => {
  const w = wallets[who as keyof typeof wallets];
  const records = recordsOf(who);
  const service = { ...device.governedCallServiceFor(apiAs(who)), callState: async () => ({ account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }) };
  const roster = {
    api: apiAs(who), accountId: company, viewingKey, signingSecret: w.signing.secret, label: LABEL, account: ACCOUNT,
    reads: readsOf(who),
  };
  return {
    service: o.service ? o.service(service) : service,
    builder: {
      governedCall: async ({ order, opened }) => {
        refuseWhatThisDeviceDidNotOpen({ accountPure: pureCircuits as never }, order, opened);
        refuseARaiseThatIsNotTheRecordedOne({ accountPure: pureCircuits as never }, order);
        const record = recordForOneCall(order, { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) }, opened);
        if (order.circuit === 'propose') blindingsProvedWith.push(Buffer.from(record.assetBlinding).toString('hex'));
        if (o.refuse?.includes(order.circuit)) throw new Error(`this device could not build ${order.circuit}`);
        return { tx: Buffer.from(JSON.stringify({ signer: signerId, order })).toString('base64') };
      },
      proposalIdentity: async (change, salt) => identityOfAChange({ accountPure: pureCircuits as never }, change, salt),
    },
    material: { signingSecret: w.signing.secret, blinding: '22'.repeat(32), scope: '33'.repeat(32) },
    accountId: company,
    records: records as never,
    filing: { seat: w.seat, keyEpoch: 0, salt: () => newBlinding(), newId: () => newProposalId() },
    approvers: async () => {
      const status = (await ledger.status(company))!;
      const { account } = await rosterHere(roster);
      return approverRosterFrom({
        threshold: status.threshold, vaultThresholds: status.vaultThresholds,
        seated: account.signers.filter((x) => x.status === 'active').map((x) => ({ leaf: x.leafCommitment! })),
        adoptedVaults: o.adopted ?? [], companyWide: COMPANY_WIDE,
      });
    },
    vaultName: (v) => (v === COMPANY_WIDE ? 'company-wide runs' : v),
    roster,
    sleep: async () => {}, waitMs: 40, everyMs: 1,
  };
};

/** A person invited from Ada's device and accepting on their own, signed in as `as`, with what their device sealed. */
const invited = async (who: 'blake' | 'cleo' | 'dora' | 'vic', as: Who = who, person: string = USERS[as]) => {
  const opened = await call('GET', `/api/accounts/${company}`, { token: tokens.ada });
  const made = await inviteSignerHere({
    id: company, name: 'Seats', label: LABEL, account: ACCOUNT, inboxPublicKey: opened.body.inboxPublicKey,
    keyEpoch: opened.body.keyEpoch, viewingKey,
  }, { committeeKey: wallets.ada.committeeKey as never, statement: entryOf(wallets.ada, LABEL, ACCOUNT), signingSecret: wallets.ada.signing.secret }, { name: who, role: 'approver' }, ORIGIN, sendAs('ada'));
  const sealedThere: PendingSeat[] = [];
  const accepted = await acceptAsSignerHere(await openInvitationHere(made.link, sendAs(as)), MidnightCommitments, {
    /* The keys this person's device makes: its filing key is the one their wallet's directory entry names. */
    newKeys: () => {
      const wrapping = newWrappingKeypair();
      return { signingSecret: wallets[who].signing.secret, signingPublicKey: wallets[who].signing.publicKey,
        wrappingSecret: wrapping.secret, wrappingPublicKey: wrapping.publicKey, blinding: wallets[who].blinding };
    },
    seal: async (seat) => { sealedThere.push(seat as PendingSeat); },
    promote: async () => {},
  }, sendAs(as), person);
  const seat = sealedThere[0]!;
  leaves.set(`${company} ${accepted.signerId}`, storedSignerLeaf(seat, MidnightCommitments));
  return { signerId: accepted.signerId!, fingerprint: accepted.fingerprint, seat };
};

/**
 * A seated person giving their vault keys from their own device, folded into
 * the roster from Ada's: their wallet's statement over their records key is
 * then in their entry, which is what their own filings are believed by.
 */
const givesVaultKeys = async (who: 'blake' | 'cleo', signerId: string) => {
  const w = wallets[who];
  await offerVaultKeysHere(apiAs(who), company, {
    signerId, signingSecret: w.signing.secret, companyKey: toHex(w.companyKey) as Hex, committeeKey: w.committeeKey as never,
    recordsKey: signRecordsKey(w.identity, LABEL, ACCOUNT, w.companyKey, w.seat), entry: entryOf(w, LABEL, ACCOUNT),
  });
  const folded = await foldOffersHere(aDevice('ada', ada.signerId).roster);
  expect(folded).toEqual({ folded: [w.seat], refused: [] });
};

/** The company as the server holds it now, opened here with the viewing key as a page opens it. */
const companyNow = async () => {
  const rec = (await call('GET', `/api/accounts/${company}`, { token: tokens.ada })).body;
  return openAccount(rec, viewingKey, rec.roster ?? null);
};
const signersNow = async () => (await companyNow()).signers.map(s => ({ name: s.name, status: s.status }));
const circuits = () => sent.map((x) => x.circuit);

describe('A COMPANY SEATS ITS SIGNERS FROM THEIR OWN DEVICES, ON THE PRODUCT\'S ROUTES', () => {
  let blake: Awaited<ReturnType<typeof invited>>;

  it('THE SERVICE CANNOT SEAT ANYBODY ITSELF: the routes that did are gone, and an admission the chain does not hold files nothing', async () => {
    blake = await invited('blake');
    /* RED WHEN: any route by which the service raised, approved or carried out a seat or a threshold with a key it held is served again. */
    for (const path of ['grant', `signers/${blake.signerId}/round`, `signers/${blake.signerId}/seat`, 'threshold/round', 'threshold', 'vault-threshold', 'vault-threshold/propose']) {
      const r = await call('POST', `/api/accounts/${company}/${path}`, { token: tokens.ada, body: { viewingKey, signerId: blake.signerId, newThreshold: 1 } });
      expect(r.status, path).toBe(404);
    }
    /* RED WHEN: a person is admitted to the roster, and the company's key wrapped to them, before the chain holds their seat. */
    await expect(admitSignerHere(aDevice('ada', ada.signerId).roster, { signerId: blake.signerId, readOut: blake.fingerprint }))
      .rejects.toThrow(/does not hold this seat yet/u);
    expect(await signersNow()).toEqual([{ name: 'Ada', status: 'active' }, { name: 'blake', status: 'pending' }]);
    expect(refusedHere).toEqual([]);
  });

  it('A SEAT IS REFUSED ON THE DEVICE, BEFORE ANYTHING IS SENT, FOR A FINGERPRINT NOT READ OUT BY THE JOINER, AND FOR A REQUEST NOT SEALED FOR ITS SIGN-IN', async () => {
    sent.length = 0;
    const doors = aDevice('ada', ada.signerId);
    /* RED WHEN: a seat is raised for keys whose fingerprint the person seating them was not read out. */
    await expect(device.seatSignerOnDevice(doors, { viewingKey, signerId: blake.signerId, readOut: 'not the joiner\'s' }))
      .rejects.toBeInstanceOf(FingerprintsDiffer);
    /* Vic accepts Dora's invitation, signed in as himself, with Dora's sign-in sealed into the request. */
    const borrowed = await invited('dora', 'vic', USERS.dora);
    /* RED WHEN: a request sealed for one sign-in makes another a member when it is seated. */
    await expect(device.seatSignerOnDevice(doors, { viewingKey, signerId: borrowed.signerId, readOut: borrowed.fingerprint }))
      .rejects.toThrow(/not sealed for the sign-in it would make a member/u);
    expect(sent).toEqual([]);
  });

  it('THE SECOND SIGNER, ONE BEYOND A THRESHOLD OF ONE, IS SEATED AND ADMITTED FROM THE FIRST SIGNER\'S DEVICE', async () => {
    sent.length = 0;
    const out = await device.seatSignerOnDevice(aDevice('ada', ada.signerId), { viewingKey, signerId: blake.signerId, readOut: blake.fingerprint });
    /* RED WHEN: the page cannot raise, approve or carry out a seat - the company then stays one of one. */
    expect(out.state).toBe('done');
    expect(circuits()).toEqual(['propose', 'approve', 'amendSigner']);
    expect(refusedHere).toEqual([]);
    /* RED WHEN: the seat carried out is not admitted to the roster the devices file. */
    expect(await signersNow()).toEqual([{ name: 'Ada', status: 'active' }, { name: 'blake', status: 'active' }, { name: 'dora', status: 'pending' }]);
    expect((await ledger.status(company))!.signerCount).toBe(2);
    /* RED WHEN: the company's key is wrapped to anything but the key made on Blake's own device. */
    const rec = (await call('GET', `/api/accounts/${company}`, { token: tokens.blake }));
    expect(rec.status).toBe(200);
    expect(unwrapKey(rec.body.wrappedKeys.find((k: any) => k.signerId === blake.signerId), blake.seat.wrappingSecret)).toBe(viewingKey);
    /* The roster is a record the company's seats file, and no longer part of the account record. */
    expect(rec.body.sealedRoster).toBeUndefined();
    expect(rec.body.roster.kind).toBe('roster');
    /* Blake's wallet joins the company's committee, and he gives his vault keys from his own device. */
    holds(company, wallets.blake);
    await givesVaultKeys('blake', blake.signerId);
  });

  it('ONE VAULT\'S APPROVALS ARE CHANGED FROM A DEVICE, AND A CHANGE THAT WOULD LEAVE A VAULT UNABLE TO PAY IS REFUSED THERE', async () => {
    sent.length = 0;
    const VAULT = 'a1'.repeat(32);
    const adaDevice = aDevice('ada', ada.signerId);
    /* RED WHEN: a vault's own threshold cannot be changed from a device. */
    expect((await device.changeVaultThresholdOnDevice(adaDevice, { viewingKey, vault: VAULT, newThreshold: 2, seated: 2 })).state).toBe('done');
    expect(circuits()).toEqual(['propose', 'approve', 'setVaultThreshold']);
    expect((await ledger.status(company))!.vaultThresholds).toEqual([{ vault: VAULT, threshold: 2 }]);
    sent.length = 0;
    /* RED WHEN: a threshold no two signers can meet is raised: company-wide runs could then never be paid. */
    await expect(device.changeThresholdOnDevice(aDevice('ada', ada.signerId, { adopted: [VAULT] }), { viewingKey, newThreshold: 3, seated: 2 }))
      .rejects.toThrow(/would leave a vault unable to pay: company-wide runs \(its runs need 3 approvals and 2 signers could give them\)\. /u);
    expect(sent).toEqual([]);
  });

  it('THE THRESHOLD IS RAISED TO TWO FROM A DEVICE, AND THE THIRD SIGNER, BEYOND IT, IS FINISHED FROM A SECOND DEVICE', async () => {
    sent.length = 0;
    const adaDevice = aDevice('ada', ada.signerId);
    /* RED WHEN: the threshold cannot be changed from a device - the company can then never require more than one approval. */
    expect((await device.changeThresholdOnDevice(adaDevice, { viewingKey, newThreshold: 2, seated: 2 })).state).toBe('done');
    expect((await ledger.status(company))!.threshold).toBe(2);

    const cleo = await invited('cleo');
    sent.length = 0;
    const first = await device.seatSignerOnDevice(adaDevice, { viewingKey, signerId: cleo.signerId, readOut: cleo.fingerprint });
    /* One approval of two: nothing is carried out, and the page is told the proposal waits for the others. */
    expect(first.state).toBe('waiting-for-approvals');
    expect(circuits()).toEqual(['propose', 'approve']);
    expect((await signersNow()).find(s => s.name === 'cleo')!.status).toBe('pending');

    /* RED WHEN: the second signer's device cannot approve, carry out or admit a seat - a company larger than its threshold is never finished. */
    const second = await device.seatSignerOnDevice(aDevice('blake', blake.signerId), { viewingKey, signerId: cleo.signerId, readOut: cleo.fingerprint });
    expect(second.state).toBe('done');
    expect(sent.map(s => `${s.circuit} ${s.signer === blake.signerId ? 'blake' : 'ada'}`))
      .toEqual(['propose ada', 'approve ada', 'approve blake', 'amendSigner blake']);
    expect((await signersNow()).filter((x) => x.name !== 'dora').map(s => s.status)).toEqual(['active', 'active', 'active']);
    expect((await ledger.status(company))!.signerCount).toBe(3);
    expect(refusedHere).toEqual([]);
    /* The chain holds Cleo's seat, and her wallet joins the committee. */
    holds(company, wallets.cleo);
  });

  it('A SIGNER SEATED AFTER THE COMPANY WAS CREATED RAISES A CHANGE FROM THEIR OWN DEVICE, A RECORD THE SERVICE ALTERED IS NOT APPROVED, AND THE COMPANY FINISHES IT', async () => {
    sent.length = 0;
    blindingsProvedWith.length = 0;
    /* RED WHEN: a signer seated after the deploy cannot raise or approve - their seat then acts on nothing. */
    expect((await device.changeThresholdOnDevice(aDevice('blake', blake.signerId), { viewingKey, newThreshold: 3, seated: 3 })).state)
      .toBe('waiting-for-approvals');
    expect(sent.map(s => `${s.circuit} ${s.signer === blake.signerId ? 'blake' : 'other'}`)).toEqual(['propose blake', 'approve blake']);
    /* RED WHEN: the raise is composed with anything but the asset blinding in the state the founding seat signed. */
    const kept = await ledger.fetch(company, 0);
    expect(blindingsProvedWith).toEqual([parseCanonical<any>(unseal(kept!.sealedState, viewingKey)).blinding.assetBlinding]);

    sent.length = 0;
    /* The service hands Ada's device Blake's proposal under another identity than the one he signed. */
    const altered = aDevice('ada', ada.signerId, { service: (s) => ({ ...s, sealedProposals: async (id: string) =>
      (await s.sealedProposals(id)).map((p: any) => (p.status === 'open' ? { ...p, chainId: 'ee'.repeat(32) } : p)) }) });
    /* RED WHEN: a device approves a proposal whose filing does not verify for the seat that signed it. */
    await expect(device.changeThresholdOnDevice(altered, { viewingKey, newThreshold: 3, seated: 3 })).rejects.toThrow(/already holds proposal/u);
    expect(sent).toEqual([]);

    /* RED WHEN: an honest company cannot finish a change a late signer raised. */
    expect((await device.changeThresholdOnDevice(aDevice('ada', ada.signerId), { viewingKey, newThreshold: 3, seated: 3 })).state).toBe('done');
    expect(circuits()).toEqual(['approve', 'setThreshold']);
    expect((await ledger.status(company))!.threshold).toBe(3);
    expect(refusedHere).toEqual([]);
  });

  it('A PROPOSAL RAISED FROM A DEVICE IS WITHDRAWN FROM IT, BY THE CALL IT PROVES', async () => {
    sent.length = 0;
    const adaDevice = aDevice('ada', ada.signerId);
    const raised = await device.changeThresholdOnDevice(adaDevice, { viewingKey, newThreshold: 2, seated: 3 });
    expect(raised.state).toBe('waiting-for-approvals');
    const round = raised.round!;
    /* RED WHEN: a proposal the chain holds cannot be withdrawn from the device that raised it, or is withdrawn with no call. */
    expect((await device.withdrawOnDevice(adaDevice, { round, viewingKey })).status).toBe('cancelled');
    expect(circuits()).toEqual(['propose', 'approve', 'cancel']);
    expect((await ledger.status(company))!.openProposals.map((p) => p.id)).not.toContain(round.chainId);
    expect(refusedHere).toEqual([]);
  });

  it('SOMEBODY WHO IS NOT A MEMBER IS NOT ANSWERED ON ANY ROUTE A DEVICE SEATS OR RELAYS THROUGH, AND A PERSON NOT WAITING IS NOT ADMITTED', async () => {
    const tx = Buffer.from('{}').toString('base64');
    const proposal = (await call('GET', `/api/accounts/${company}/proposals`, { token: tokens.ada })).body[0].id;
    for (const [method, path] of [
      ['POST', `/api/accounts/${company}/signers/${blake.signerId}/admit`], ['POST', `/api/accounts/${company}/roster`],
      ['PUT', `/api/accounts/${company}/vault-keys`], ['GET', `/api/accounts/${company}/vault-keys/offers`],
      ['POST', `/api/accounts/${company}/proposals`], ['POST', `/api/proposals/${proposal}/approve`],
      ['POST', `/api/proposals/${proposal}/cancel`], ['POST', `/api/proposals/${proposal}/carry`],
    ] as const) {
      /* RED WHEN: a route a seat's device uses answers somebody who is not a member of the company. */
      expect((await call(method, path, { token: tokens.vic, ...(method === 'GET' ? {} : { body: { tx } }) })).status, path).toBe(404);
    }
    /* RED WHEN: a signer already seated is admitted again. */
    const again = await call('POST', `/api/accounts/${company}/signers/${blake.signerId}/admit`, { token: tokens.ada, body: {
      roster: { version: 9, message: {} }, leaf: 'ab'.repeat(32), wrap: { ephemeral: 'ab'.repeat(32), iv: '', tag: '', body: '' },
      index: { accountId: company, signerCount: 3, committeeKeys: [], readers: [], filers: [] },
    } });
    expect(again.status).toBe(409);
    expect(again.body.refused).toBe('not-waiting');
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
        holders: async () => ({ committee: [adaInJoined.committeeKey], threshold: 1, seats: [seatOfAda], approvals: 1, adoptedVaults: [], founding: seatOfAda, foundingCommittee: [adaInJoined.committeeKey], account: adaInJoined.account }),
        attested: async () => [{ committeeKey: adaInJoined.committeeKey, statement: signRecordsKey(adaInJoined.wallet.identity, adaInJoined.label, adaInJoined.account, adaInJoined.wallet.companyKey, seatOfAda) }],
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
