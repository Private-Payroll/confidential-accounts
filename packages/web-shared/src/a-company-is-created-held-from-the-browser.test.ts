import { afterEach, describe, expect, it, vi } from 'vitest';

/* Lets a test read the saved keys back in the shape an older build wrote them. Nothing is changed unless a test sets `rewrite`. */
const unsealing = vi.hoisted(() => ({ rewrite: null as null | ((plain: string) => string) }));
vi.mock('../../../src/core/crypto.js', async (original) => {
  const real = await original<typeof import('../../../src/core/crypto.js')>();
  return { ...real, unseal: (...a: Parameters<typeof real.unseal>) => { const plain = real.unseal(...a); return unsealing.rewrite !== null && typeof plain === 'string' ? unsealing.rewrite(plain) : plain; } };
});
import { foundingStateRefusal } from '../../../src/core/founding-state.js';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { READY_PING } from 'midnight-identity/profile/channel';
import { parseAsk, type CreationRequest, type HoldersRequest, type KeyringRequest } from 'midnight-identity/profile/request';
import { holdersAnswerFor, PAY_KEY_COMMITMENT_ENTRY, seatBarOf } from 'midnight-identity/profile/records-key';
import { keyringReleaseFor } from 'midnight-identity/profile/unlock';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { CREATION_SIGNATURE_SCHEMA } from 'midnight-identity/profile/creation-sign';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { unwrapKey, unseal, parseCanonical, signingPublicKeyOf } from '../../../src/core/crypto.js';
import { openAccount, sealAccount } from '../../../src/core/account.js';
import { newSigningKeypair } from '../../../src/core/crypto.js';
import { signCompanyFiling, verifiedCompanyFiler } from '../../../src/midnight/sealed-record-wire.js';
import { NO_ROSTER_RECORD } from './roster-here.js';
import { secretCarried } from '../../../src/server/account-creation.js';
import * as keyring from './keyring.js';
import type { PayKeyStandingOnTheWire } from './vault-worker-client.js';
import { answerVaultAsk } from './vault-worker-entry.js';
import { storedSignerLeaf } from '../../../src/core/signer-leaf.js';
import { MidnightCommitments } from '../../../src/midnight/commitments.js';
import { WalletDidNotSign } from './wallet-committee.js';
import type { Openable } from './wallet-sign-in.js';
import { anchoredEntering } from '../../../src/testing/record-tree-double.js';
import { leavesOfTheContract } from '../../../src/testing/directory-seats.js';
import { seatBlinding } from '../../../src/core/seat-opening.js';

/**
 * **A COMPANY ON A CHAIN IS CREATED FROM ITS FOUNDING SIGNER'S BROWSER IN TWO
 * PRESSES, AND ITS ACCOUNT IS HELD BY THEIR OWN KEY FROM ITS FIRST TRANSACTION.**
 *
 * The first press makes the company and builds the account's deploy here,
 * held by the key the wallet gave beside the label it drew, and sends nothing.
 * The second press has the wallet sign the step that finishes the account, and
 * sends the deploy and that step together. A send that did not arrive is sent
 * again with the same bytes, and the wallet is not asked twice. Finishing and
 * reading where a company stands are each their own call.
 *
 * **AND THE COMPANY ITSELF IS MADE HERE.** Its founding signer's seat and
 * every secret it starts with are made in this browser, the seat's secrets are
 * saved before anything is sent, and the service is sent only public halves, a
 * leaf, and what is sealed under a key that does not leave.
 *
 * The wallet answers the keyring ask with its own code; the builder stands in
 * for the worker, which `contracts/test/a-company-born-held-from-the-browser.test.ts`
 * drives for real.
 */
const US = 'https://payroll.example';
const WALLET = 'https://wallet.example';
const ADDRESS = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const A = { id: 'usr_a', email: null, name: 'Priya' };
const identity = identityFromWords(TEST_MNEMONIC);
const LEAF = 'ab'.repeat(32);
const ACCOUNT = 'c0'.repeat(32);
const A_COMPANY = { name: 'Acme Ltd', signers: [{ name: 'Priya', role: 'admin' as const }], threshold: 1 };

class Wallet implements Openable {
  readonly asks: Array<{ kind: string; body: unknown }> = [];
  drew: CompanyLabel | null = null;
  /** The pay-record key commitment the wallet reads on each account, by address; an account not listed has none. */
  commits: Record<string, string> = {};
  /** While set, the wallet answers an ask for the account's holders with this refusal instead of a read. */
  refusesHolders: string | null = null;
  /** Whether the wallet's completed answers name the indexer it reads through. */
  namesIndexer = true;
  private handler: ((event: MessageEvent) => void) | null = null;
  private readonly tab = { postMessage: (m: unknown) => this.onAsk(m) };
  constructor(private readonly signAs: 'own-key' | 'another-key' = 'own-key') {}
  open(): Window | null { return this.tab as unknown as Window; }
  addEventListener(_t: 'message', h: (e: MessageEvent) => void): void {
    this.handler = h;
    queueMicrotask(() => this.deliver({ schema: READY_PING }));
  }
  removeEventListener(): void { this.handler = null; }
  setTimeout(): number { return 0; }
  clearTimeout(): void { /* nothing to clear */ }
  private deliver(data: unknown): void { this.handler?.({ origin: WALLET, source: this.tab, data } as unknown as MessageEvent); }
  private onAsk(message: unknown): void {
    let answer: unknown;
    try {
      const ask = parseAsk(message, US, Date.now());
      this.asks.push({ kind: ask.kind, body: ask });
      if (ask.kind === 'keyring') {
        const released = keyringReleaseFor(identity, ask as KeyringRequest, Date.now(), (a) => a === ADDRESS);
        this.drew = (released as { company: CompanyLabel | null }).company;
        answer = released;
      } else if (ask.kind === 'creation') {
        const c = ask as CreationRequest;
        const signer = this.signAs === 'own-key' ? committeeKeyFor(identity, c.company)
          : committeeKeyFor(identity, `co_${'99'.repeat(32)}` as CompanyLabel);
        answer = {
          schema: CREATION_SIGNATURE_SCHEMA, origin: US, company: c.company, account: c.account, nonce: c.nonce,
          at: Date.now(), signer: { tag: 'schnorr', value: signer.value }, signature: { tag: 'schnorr', value: '5a'.repeat(64) },
        };
      } else if (ask.kind === 'holders' && this.refusesHolders !== null) {
        answer = { schema: 'midnight-identity/disclosure-refused/v1', reason: this.refusesHolders };
      } else if (ask.kind === 'holders') {
        const h = ask as HoldersRequest;
        const key = committeeKeyFor(identity, h.company) as { tag: string; value: string };
        answer = holdersAnswerFor(h, {
          committee: [key], threshold: 1, seats: ['5e'.repeat(32)], approvals: 1, adoptedVaults: [], vaultThresholds: [], policyBar: null,
          seatBar: seatBarOf(1, null), founding: '5f'.repeat(32), foundingCommittee: [key],
        }, Date.now(), h.movements === undefined ? undefined : {
          payKeyCommitment: this.commits[h.account] ?? null, held: [], openRounds: [], entries: 0,
        }, this.namesIndexer ? { indexerUri: 'https://indexer.example/api/v4/graphql', indexerWsUri: 'wss://indexer.example/api/v4/graphql/ws' } : undefined);
      } else answer = { schema: 'nothing-given' };
    } catch {
      answer = { schema: 'nothing-given' };
    }
    queueMicrotask(() => this.deliver(answer));
  }
}

/** Where the pay-record key stands, as the worker would read it, step by step. */
const PAY_KEY = { commitment: 'c1'.repeat(32), payload: 'c2'.repeat(32), salt: 'c3'.repeat(32), proposal: 'c4'.repeat(32) };
const payKeyAt = (over: { open?: boolean; approvals?: number; committed?: string | null; sealedMine?: boolean } = {}): PayKeyStandingOnTheWire => ({
  committed: over.committed ?? null, isThisKey: (over.committed ?? null) === PAY_KEY.commitment, sealedMine: over.sealedMine ?? false,
  round: { ...PAY_KEY, open: over.open ?? false, approvals: over.approvals ?? 0, needed: 1, stale: false },
  noVault: 'fe'.repeat(32), wrap: ['d1', 'd2', 'd3', 'd4'].map((b) => b.repeat(32)),
});

const builder = (payKeySteps: PayKeyStandingOnTheWire[] = [payKeyAt()]): keyring.AccountCreationBuilder & { calls: Array<[string, unknown]> } => {
  const calls: Array<[string, unknown]> = [];
  let step = 0;
  return {
    calls,
    creationAgain: async (input: unknown) => { calls.push(['again', input]); return { account: ACCOUNT, deploy: 'QUdBSU4=', insert: 'SU5BR0FJTg==' }; },
    payKeyStanding: async (input: unknown) => {
      calls.push(['standing', input]);
      return payKeySteps[Math.min(step++, payKeySteps.length - 1)]!;
    },
    governedCall: async (input: any) => { calls.push(['call', input]); return { tx: `TX-${String(input.order.circuit)}` }; },
    foundingSeat: async (material: unknown) => { calls.push(['seat', material]); return { seat: LEAF.toUpperCase(), scope: 'cd'.repeat(32), publicKey: 'EF'.repeat(32) }; },
    accountDeploy: async (input: unknown) => {
      calls.push(['deploy', input]);
      return { account: ACCOUNT, tx: 'REVQTE9Z', insert: [{ circuit: 'payout', key: 'S0VZ' }] };
    },
    finishedCreation: async (input: unknown) => { calls.push(['insert', input]); return { tx: 'SU5TRVJU' }; },
  };
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; keyring.forgetLocally(); unsealing.rewrite = null; });

function aService(opts: {
  creationFails?: () => boolean; companyFails?: () => boolean; noRecord?: () => boolean; states?: Record<string, unknown>;
  /** Run when this route is asked, before it is answered: another person signs in on the same tab here. */
  during?: { route: string; run: () => Promise<void> };
  /** A refusal a route answers with, asked each time it is asked: null answers as usual. */
  refuses?: Record<string, () => { status: number; body: unknown } | null>;
} = {}) {
  const posted: { route: string; body: any; as: string | null }[] = [];
  /* Every write, in order, so a test can say what was saved before what was sent. */
  const order: string[] = [];
  /* Each person's saved keys apart, by who the request says it is for. */
  const savedBy = new Map<string, { bundle: unknown; version: number }>();
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = `${String(init?.method ?? 'GET')} ${url}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const as = (init?.headers as Record<string, string> | undefined)?.['x-signed-in-as'] ?? null;
    posted.push({ route, body, as });
    const saved = savedBy.get(as ?? '') ?? { bundle: null, version: 0 };
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    const generic = route.replace(/acc_[A-Za-z0-9_-]{12}/u, 'acc_X');
    if (route !== 'GET /api/me/keys') order.push(generic);
    if (opts.during?.route === generic) await opts.during.run();
    const refusal = opts.refuses?.[generic]?.() ?? null;
    if (refusal !== null) return json(refusal.status, refusal.body);
    switch (generic) {
      case 'GET /api/me/keys': return json(200, { keyBundle: saved.bundle, version: saved.version });
      case 'PUT /api/me/keys': savedBy.set(as ?? '', { bundle: body.keyBundle, version: saved.version + 1 }); return json(200, { version: saved.version + 1 });
      case 'POST /api/accounts':
        if (opts.companyFails?.()) return json(502, { error: 'the service did not answer' });
        return json(201, { account: { id: body.founding.account.id }, state: 'made' });
      case 'POST /api/accounts/acc_X/creation':
        if (opts.creationFails?.()) return json(502, { nothingWasSent: false, error: 'the node did not answer' });
        return json(201, { account: ACCOUNT, state: 'deploy-sent', txRef: 'tx' });
      case 'POST /api/accounts/acc_X/creation/finish': return json(200, opts.states?.finish ?? { account: ACCOUNT, state: 'finish-sent' });
      case 'GET /api/accounts/acc_X/creation':
        if (opts.noRecord?.()) return json(404, { error: 'no such company' });
        return json(200, opts.states?.standing ?? { account: ACCOUNT, state: 'finish-owed' });
      case 'POST /api/accounts/acc_X/creation/again': return json(200, { account: ACCOUNT, state: 'deploy-sent' });
      case 'GET /api/accounts/acc_X/call-state': return json(200, { account: ACCOUNT, blockHash: '00'.repeat(32), accountState: 'U1RBVEU=', parameters: 'UEFSQU1T' });
      case 'POST /api/accounts/acc_X/creation/pay-key': return json(200, { txRef: 'tx' });
      case 'GET /api/accounts/acc_X/directory': return json(200, { filings: [] });
      default: return json(404, { error: `no route for ${route}` });
    }
  }) as typeof fetch;
  return {
    sent: (route: string) => posted.filter((p) => p.route.replace(/acc_[A-Za-z0-9_-]{12}/u, 'acc_X') === route),
    order,
    /** Every save of keys made on behalf of this person. */
    savesBy: (person: string) => posted.filter((p) => p.route === 'PUT /api/me/keys' && p.as === person),
  };
}

const signIn = () => keyring.signedInByAnotherScreen({ user: A, address: ADDRESS, created: true, session: {} });

/** The company the first press made, as the service was sent it. */
const madeOf = (service: ReturnType<typeof aService>) => service.sent('POST /api/accounts')[0]!.body;

describe('THE FIRST PRESS', () => {
  it('MAKES THE COMPANY WITH THE KEY THE WALLET GAVE FOR ITS LABEL, BUILDS THE DEPLOY HELD BY IT, AND SENDS NOTHING', async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    const b = builder();
    const started = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    const made = madeOf(service);
    const drew = wallet.drew!;
    /* RED WHEN: the first press does not hand back the label the wallet drew, so the page cannot show the person the name their wallet gave the company. */
    expect(started).toEqual({ accountId: made.founding.account.id, account: ACCOUNT, label: drew });
    const key = { tag: 'schnorr', value: committeeKeyFor(identity, drew).value };
    /* RED WHEN: the service is not told the key that holds the account, or is told another one than the wallet gave for the label it drew. */
    expect(made).toMatchObject({ companyLabel: drew, foundingKey: key });
    /* RED WHEN: the deploy is built from anything but the seat this device worked out, the drawn label and that key. */
    expect(b.calls.find(([k]) => k === 'deploy')).toEqual(['deploy', { foundingLeaf: LEAF, label: drew, foundingKey: key }]);
    /* RED WHEN: anything is sent before the wallet has signed the second step. */
    expect(service.sent('POST /api/accounts/acc_X/creation')).toEqual([]);
    expect(keyring.companyAwaitingItsSecondPress(keyring.companiesBeingCreated()[0] ?? 'acc_none')).toEqual({ accountId: made.founding.account.id, account: ACCOUNT });
  });

  it('MAKES THE SEAT AND EVERY SECRET HERE, KEEPS THE SEAT\'S SECRETS BEFORE ANYTHING IS SENT, AND SENDS NONE OF THEM', async () => {
    const service = aService();
    signIn();
    const b = builder();
    await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, new Wallet(), US);
    const made = madeOf(service);
    const id = made.founding.account.id as string;
    /* RED WHEN: the service is sent any secret, under any name, anywhere in the creation. */
    expect(secretCarried(made)).toBeNull();
    expect(Object.keys(made.founding).sort()).toEqual(['account', 'roster', 'seat', 'state']);
    /* RED WHEN: the first state is sent as anything but the record this seat signed for this company. */
    expect(foundingStateRefusal(made.founding.state, made.founding.account.id, made.founding.seat.signingPublicKey)).toBeNull();
    /* RED WHEN: the seat's secrets are kept after the company is sent, or not at all: a company would exist whose keys were never kept. */
    expect(service.order.slice(0, 2)).toEqual(['PUT /api/me/keys', 'POST /api/accounts']);
    const mine = keyring.keysFor(id)!;
    /* RED WHEN: the seat sent is not the one made from the keys kept here. */
    expect(made.founding.seat.signingPublicKey).toBe(signingPublicKeyOf(mine.signingSecret));
    expect(mine.signerId).toBe(made.founding.seat.signerId);
    expect(made.founding.seat.leaf).toBe(LEAF);
    expect(mine.scope).toBe('cd'.repeat(32));
    /* RED WHEN: the founding seat's leaf is made with a blinding that does not commit to the key the account is born held by. */
    const salt = mine.opening?.salt ?? '';
    expect(mine.blinding).toBe(seatBlinding(made.foundingKey, salt));
    /* RED WHEN: the opening kept beside the keys is not of the leaf they make, so the founding seat's entry would prove nothing. */
    expect(mine.opening).toEqual({ publicKey: 'ef'.repeat(32), scope: 'cd'.repeat(32), blinding: mine.blinding, walletKey: made.foundingKey, salt });
    expect(salt).toMatch(/^[0-9a-f]{64}$/u);
    /* RED WHEN: the leaf is worked out from anything but the keys kept here. */
    expect(b.calls[0]).toEqual(['seat', { signingSecret: mine.signingSecret, blinding: mine.blinding }]);
    /* RED WHEN: the viewing key is wrapped to anybody but this seat, or the record does not open with it. */
    const viewingKey = unwrapKey(made.founding.account.wrappedKeys[0], mine.wrappingSecret);
    /* RED WHEN: the signers are sent anywhere but in the first roster, signed by this seat. */
    expect(made.founding.account.sealedRoster).toBeUndefined();
    expect(verifiedCompanyFiler(made.founding.roster)).toBe(signingPublicKeyOf(mine.signingSecret));
    const opened = openAccount(made.founding.account, viewingKey, made.founding.roster);
    expect(opened.signers.map((x) => [x.id, x.userId, x.leafCommitment])).toEqual([[mine.signerId, A.id, LEAF]]);
    /* RED WHEN: the founding record carries a threshold of its own, readable or sealed. */
    expect(Object.keys(opened.policy)).toEqual(['limitsByRole']);
    expect(Object.keys(made.founding.account)).not.toContain('threshold');
    /* RED WHEN: the first state is not sealed under the same viewing key, or carries no asset blinding, payout seed or pay-record key. */
    const state = parseCanonical<{ blinding: Record<string, unknown> }>(unseal(made.founding.state.sealed, viewingKey));
    expect(Object.keys(state.blinding).sort()).toEqual(['assetBlinding', 'payRecordKey', 'payoutSeeds']);
  });

  it('A COMPANY THE SERVICE DID NOT TAKE LEAVES ITS SEAT\'S SECRETS KEPT, AND BUILDS NO DEPLOY', async () => {
    const service = aService({ companyFails: () => true });
    signIn();
    const b = builder();
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, new Wallet(), US)).rejects.toThrow('the service did not answer');
    const id = madeOf(service).founding.account.id as string;
    /* RED WHEN: the secrets are kept only once the service has answered. */
    expect(keyring.keysFor(id)).not.toBeNull();
    expect(b.calls.filter(([k]) => k === 'deploy')).toEqual([]);
  });

  it('A COMPANY IS CREATED WITH ITS FOUNDING SIGNER ONLY: ANOTHER SIGNER OR THRESHOLD IS REFUSED BEFORE THE WALLET OPENS', async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    for (const spec of [
      { ...A_COMPANY, signers: [...A_COMPANY.signers, { name: 'Sam', role: 'approver' as const }] },
      { ...A_COMPANY, threshold: 2 },
    ]) {
      /* RED WHEN: a second signer, or a threshold above one, reaches the wallet or the service. */
      await expect(keyring.startCompanyHeldFromTheStart(spec, WALLET, builder(), wallet, US)).rejects.toThrow(/with you as its only signer/);
    }
    expect(wallet.asks).toEqual([]);
    expect(service.sent('POST /api/accounts')).toEqual([]);
  });
});

describe('A COMPANY KEPT HERE THAT THE SERVICE NEVER STORED', () => {
  /*
   * RED WHEN: a first press whose send to the service failed leaves a creation that reads as no answer, so the second step waits for ever
   * and start again is never offered; or a company this browser keeps nothing of reads as not created.
   */
  it('READS AS NOT CREATED WHEN THE SERVICE HAS NO RECORD, AND CAN BE DROPPED', async () => {
    aService({ companyFails: () => true, noRecord: () => true });
    signIn();
    const wallet = new Wallet();
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, builder(), wallet, US)).rejects.toThrow('the service did not answer');
    const id = keyring.companiesBeingCreated()[0]!;
    expect(await keyring.companyCreationStanding(id)).toEqual({ account: null, state: 'not-created' });
    expect(keyring.companyKeptWithNoDeploy(keyring.companiesBeingCreated()[0] ?? 'acc_none')).toBe(id);
    await expect(keyring.companyCreationStanding('acc_AAAAAAAAAAAA')).rejects.toBeInstanceOf(keyring.NotOnTheService);
    await keyring.forgetAnUnsentCreation(id);
    expect(keyring.companiesBeingCreated()).toEqual([]);
  });
});

describe('ANY NUMBER OF COMPANIES ARE KEPT, EACH ON ITS OWN, AND NONE STOPS ANOTHER FROM BEING STARTED', () => {
  const OTHER = { ...A_COMPANY, name: 'Other Ltd' };

  /* RED WHEN: starting another company while this browser keeps one is refused, or replaces the one kept, before or after the keys open. */
  it('KEEPS BOTH WHEN A SECOND COMPANY IS STARTED, WITH THE KEYS OPEN AND WITH THEM SHUT', async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    const first = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, builder(), wallet, US);
    const second = await keyring.startCompanyHeldFromTheStart(OTHER, WALLET, builder(), wallet, US);
    expect(second.accountId).not.toBe(first.accountId);
    expect(keyring.companiesBeingCreated()).toEqual([first.accountId, second.accountId]);
    expect(service.sent('POST /api/accounts')).toHaveLength(2);
    keyring.forgetLocally();
    signIn();
    expect(keyring.canOpenCompanies()).toBe(false);
    const third = await keyring.startCompanyHeldFromTheStart({ ...A_COMPANY, name: 'Third Ltd' }, WALLET, builder(), wallet, US);
    /* RED WHEN: a creation started with the keys shut replaces what the saved keys already hold. */
    expect(keyring.companiesBeingCreated()).toEqual([first.accountId, second.accountId, third.accountId]);
    expect([first, second, third].map((c) => keyring.companyNameKeptHere(c.accountId))).toEqual(['Acme Ltd', 'Other Ltd', 'Third Ltd']);
    expect(service.sent('POST /api/accounts')).toHaveLength(3);
    /* RED WHEN: a reload loses a creation, or finds it under another company. */
    await reload(wallet);
    expect(keyring.companiesBeingCreated()).toEqual([first.accountId, second.accountId, third.accountId]);
    expect(keyring.companyNameKeptHere(second.accountId)).toBe('Other Ltd');
    for (const c of [first, second, third]) expect(keyring.companyAwaitingItsSecondPress(c.accountId)).toEqual({ accountId: c.accountId, account: ACCOUNT });
  });

  /* RED WHEN: finishing one company signs, sends or marks another, or the label shown for one is another's. */
  it('FINISHES EACH ON ITS OWN: ONLY THE ONE NAMED IS SIGNED AND RECORDED', async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    const b = builder();
    const first = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    const second = await keyring.startCompanyHeldFromTheStart(OTHER, WALLET, b, wallet, US);
    const done = await keyring.signCompanyCreationFromTheWallet(second.accountId, WALLET, b, wallet, US);
    expect(done.accountId).toBe(second.accountId);
    expect(service.sent('POST /api/accounts/acc_X/creation')).toHaveLength(1);
    expect(b.calls.filter(([k]) => k === 'insert')).toHaveLength(1);
    expect(keyring.companyAwaitingItsSecondPress(second.accountId)).toBeNull();
    expect(keyring.companyAwaitingItsSecondPress(first.accountId)).toEqual({ accountId: first.accountId, account: ACCOUNT });
    expect(keyring.companyBeingCreatedLabel(first.accountId)).toBe(first.label);
    expect(keyring.companyBeingCreatedLabel(second.accountId)).toBe(second.label);
    const asks = wallet.asks.filter((a) => a.kind === 'creation');
    expect(asks).toHaveLength(1);
    expect((asks[0]!.body as { company: string }).company).toBe(second.label);
    await keyring.signCompanyCreationFromTheWallet(first.accountId, WALLET, b, wallet, US);
    expect(service.sent('POST /api/accounts/acc_X/creation')).toHaveLength(2);
    expect(keyring.companyAwaitingItsSecondPress(first.accountId)).toBeNull();
    await expect(keyring.signCompanyCreationFromTheWallet('acc_AAAAAAAAAAAA', WALLET, b, wallet, US)).rejects.toThrow(/no company waiting/);
    expect(keyring.companiesBeingCreated()).toEqual([first.accountId, second.accountId]);
  });

  /* RED WHEN: starting one creation again drops, changes or sets aside another one, or one that is kept with no deploy is not dropped alone. */
  it('STARTING ONE AGAIN LEAVES THE OTHER EXACTLY AS IT WAS', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    const b = builder();
    const first = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    const second = await keyring.startCompanyHeldFromTheStart(OTHER, WALLET, b, wallet, US);
    await keyring.signCompanyCreationFromTheWallet(second.accountId, WALLET, b, wallet, US);
    expect(await keyring.startAnUnfinishedCreationAgain(first.accountId, WALLET, null, wallet, US)).toEqual({ of: 'dropped' });
    expect(keyring.companiesBeingCreated()).toEqual([second.accountId]);
    expect(keyring.companyNameKeptHere(second.accountId)).toBe('Other Ltd');
    expect(keyring.companyAwaitingItsSecondPress(second.accountId)).toBeNull();
    expect(keyring.companyKeptWithNoDeploy(second.accountId)).toBeNull();
    expect(keyring.keysFor(first.accountId)).not.toBeNull();
    expect(keyring.keysFor(second.accountId)).not.toBeNull();
    /* RED WHEN: the sent creation is dropped by the start again of the other, without its own chain read. */
    await expect(keyring.forgetAnUnsentCreation(second.accountId)).rejects.toThrow(/signed or sent/);
    expect(keyring.companiesBeingCreated()).toEqual([second.accountId]);
  });

  /* RED WHEN: a creation whose first post never arrived cannot be carried on after a reload, or carrying it on sends anything to the chain or posts it twice. */
  it('CARRIES ON, AFTER A RELOAD, A CREATION THE SERVICE NEVER TOOK: THE POST IS TRIED AGAIN AND THE DEPLOY BUILT, NOTHING SENT TO THE CHAIN', async () => {
    let fail = true;
    const service = aService({ companyFails: () => fail });
    signIn();
    const wallet = new Wallet();
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, builder(), wallet, US)).rejects.toThrow('the service did not answer');
    const [stuck] = keyring.companiesBeingCreated();
    await reload(wallet);
    expect(keyring.companiesBeingCreated()).toEqual([stuck]);
    expect(keyring.companyKeptWithNoDeploy(stuck!)).toBe(stuck);
    fail = false;
    const b = builder();
    expect(await keyring.carryTheFirstPressOn('acc_AAAAAAAAAAAA', b)).toBe(false);
    expect(await keyring.carryTheFirstPressOn(stuck!, b)).toBe(true);
    expect(service.sent('POST /api/accounts')).toHaveLength(2);
    expect(keyring.companyAwaitingItsSecondPress(stuck!)).toEqual({ accountId: stuck, account: ACCOUNT });
    expect(service.sent('POST /api/accounts/acc_X/creation')).toEqual([]);
    await keyring.carryTheFirstPressOn(stuck!, b);
    expect(service.sent('POST /api/accounts')).toHaveLength(2);
    expect(b.calls.filter(([k]) => k === 'deploy')).toHaveLength(1);
  });

  /* RED WHEN: a creation that fails to send leaves the next company unable to start, or no longer kept beside it. */
  it('KEEPS A CREATION WHOSE SEND FAILED BESIDE THE ONE STARTED AFTER IT', async () => {
    let fail = true;
    aService({ companyFails: () => fail });
    signIn();
    const wallet = new Wallet();
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, builder(), wallet, US)).rejects.toThrow('the service did not answer');
    const [stuck] = keyring.companiesBeingCreated();
    fail = false;
    const next = await keyring.startCompanyHeldFromTheStart(OTHER, WALLET, builder(), wallet, US);
    expect(keyring.companiesBeingCreated()).toEqual([stuck, next.accountId]);
    expect(keyring.companyKeptWithNoDeploy(stuck!)).toBe(stuck);
  });
});

describe('THE LABEL THE WALLET DREW IS KEPT WITH THE CREATION, FOR THE SCREEN AFTER THE FIRST PRESS', () => {
  it('IS THE KEPT CREATION\'S OWN LABEL FOR ITS COMPANY, AND NOBODY\'S ELSE', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    const started = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, builder(), wallet, US);
    /* RED WHEN: the label shown after the first press is not the one the wallet drew and the creation kept. */
    expect(keyring.companyBeingCreatedLabel(started.accountId)).toBe(started.label);
    /* RED WHEN: another company's step is shown this company's label. */
    expect(keyring.companyBeingCreatedLabel('acc_AAAAAAAAAAAA')).toBeNull();
  });
});

describe('THE NAME THE PERSON GAVE A COMPANY IS KEPT WITH ITS CREATION, FOR EVERY LIST OF COMPANIES', () => {
  it('IS THE KEPT CREATION\'S OWN NAME FOR ITS COMPANY, AND NOBODY\'S ELSE', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    expect(keyring.companyNameKeptHere('acc_AAAAAAAAAAAA')).toBeNull();
    const started = await keyring.startCompanyHeldFromTheStart({ ...A_COMPANY, name: 'Test-001' }, WALLET, builder(), wallet, US);
    /* RED WHEN: a company kept here and not finished is not given the name the person typed for it. */
    expect(keyring.companyNameKeptHere(started.accountId)).toBe('Test-001');
    /* RED WHEN: another company is given the kept creation's name. */
    expect(keyring.companyNameKeptHere('acc_AAAAAAAAAAAA')).toBeNull();
  });
});

describe('A CREATION FROM WHICH NOTHING REACHED THE CHAIN CAN BE STARTED AGAIN, AND ONLY SUCH A ONE', () => {
  /** A first press that made the company and stopped before any deploy was built. */
  const stoppedBeforeTheDeploy = async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    const b = { ...builder(), accountDeploy: async () => { throw new Error('the deploy could not be built'); } };
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US)).rejects.toThrow('the deploy could not be built');
    return { service, wallet, id: madeOf(service).founding.account.id as string };
  };

  it('FORGETS A KEPT CREATION WITH NO DEPLOY, SO THE FIRST PRESS MAKES A NEW COMPANY, AND KEEPS THE FORGOTTEN COMPANY\'S KEYS', async () => {
    const { service, wallet, id } = await stoppedBeforeTheDeploy();
    expect(keyring.companiesBeingCreated()).toEqual([id]);
    /* RED WHEN: a kept creation that built no deploy is not told apart from one that holds a deploy, so the page offers to start again over a deploy, or never offers it. */
    expect(keyring.companyKeptWithNoDeploy(keyring.companiesBeingCreated()[0] ?? 'acc_none')).toBe(id);
    await keyring.forgetAnUnsentCreation(id);
    expect(keyring.companyKeptWithNoDeploy(keyring.companiesBeingCreated()[0] ?? 'acc_none')).toBeNull();
    /* RED WHEN: the creation is still kept after it is forgotten, so Create stays shut. */
    expect(keyring.companiesBeingCreated()).toEqual([]);
    /* RED WHEN: forgetting the creation also drops the seat's keys of a company the service already lists. */
    expect(keyring.keysFor(id)).not.toBeNull();
    const secretOfTheFirst = keyring.keysFor(id)!.signingSecret;
    const again = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, builder(), wallet, US);
    expect(again.accountId).not.toBe(id);
    expect(service.sent('POST /api/accounts')).toHaveLength(2);
    /* RED WHEN: a new company's keys are saved over the companies this person already holds instead of beside them, so a seat's secrets, which cannot be made again, are lost. */
    expect(keyring.keysFor(id)?.signingSecret).toBe(secretOfTheFirst);
    expect(keyring.keysFor(again.accountId)).not.toBeNull();
    keyring.forgetLocally();
    signIn();
    await keyring.openKeysWithWallet(WALLET, wallet, US);
    expect(keyring.keysFor(id)?.signingSecret).toBe(secretOfTheFirst);
    expect(keyring.keysFor(again.accountId)).not.toBeNull();
  });

  it('FORGETS A BUILT DEPLOY NOBODY SIGNED FOR, AND REFUSES ONE SIGNED OR SENT, KEEPING IT', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    const b = builder();
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    /* RED WHEN: a creation that holds a built deploy is not told apart from one without, so the page offers to start again over a deploy. */
    expect(keyring.companyKeptWithNoDeploy(keyring.companiesBeingCreated()[0] ?? 'acc_none')).toBeNull();
    expect(keyring.companyAwaitingItsSecondPress(keyring.companiesBeingCreated()[0] ?? 'acc_none')).toEqual({ accountId, account: ACCOUNT });
    await keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US);
    /* RED WHEN: a creation already signed for and sent to the chain is forgotten, so it can never be carried on or finished. */
    await expect(keyring.forgetAnUnsentCreation(accountId)).rejects.toThrow(/signed or sent/);
    expect(keyring.companiesBeingCreated()).toEqual([accountId]);
  });

  it('DROPS A BUILT DEPLOY NOTHING WAS SIGNED FOR, SO A COMPANY WHOSE SEND FAILED CAN BE MADE AGAIN', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, builder(), wallet, US);
    /* RED WHEN: a deploy that was built but never signed or sent keeps this browser from ever creating another company. */
    await keyring.forgetAnUnsentCreation(accountId);
    expect(keyring.companiesBeingCreated()).toEqual([]);
    expect(keyring.keysFor(accountId)).not.toBeNull();
  });

  it('REFUSES A COMPANY THIS TAB KEEPS NO CREATION OF', async () => {
    aService();
    signIn();
    /* RED WHEN: forgetting a company that is not kept here is taken as done. */
    await expect(keyring.forgetAnUnsentCreation('acc_AAAAAAAAAAAA')).rejects.toThrow(/keeps no creation/);
  });
});

describe('A FINISHED COMPANY\'S KEPT CREATION IS FORGOTTEN ONLY ON THE WALLET\'S OWN READ OF THE KEPT ACCOUNT, AND ITS KEYS KEPT', () => {
  const COMMITTED = 'c1'.repeat(32);
  const OTHER_ACCOUNT = '0b'.repeat(32);
  const sentAndKept = async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    const b = builder();
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    await keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US);
    return { accountId, wallet };
  };
  const holdersAsks = (w: Wallet) => w.asks.filter((a) => a.kind === 'holders').map((a) => a.body as HoldersRequest);

  it('DROPS WHAT WAS KEPT ONCE THE WALLET SHOWS THE KEY COMMITTED ON THE KEPT ACCOUNT, AND SAYS NOTHING WAS KEPT WHEN IT WAS NOT', async () => {
    const { accountId, wallet } = await sentAndKept();
    wallet.commits[ACCOUNT] = COMMITTED;
    /* RED WHEN: a company the wallet confirms finished stays kept as a creation, so the person is stranded on its step. */
    expect(await keyring.forgetAFinishedCreation(accountId, WALLET, wallet, US)).toBe(true);
    expect(keyring.companiesBeingCreated()).toEqual([]);
    /* RED WHEN: forgetting the creation drops the company's keys with it. */
    expect(keyring.keysFor(accountId)).not.toBeNull();
    const asked = holdersAsks(wallet);
    /* RED WHEN: the wallet is asked about any label or account but the ones this device kept for the creation. */
    expect(asked).toHaveLength(1);
    expect(asked[0]!.company).toBe(wallet.drew);
    expect(asked[0]!.account).toBe(ACCOUNT);
    /* RED WHEN: the wallet is not asked for the pay-record key's entry, the one fact that says the company is finished. */
    expect(asked[0]!.movements).toEqual([PAY_KEY_COMMITMENT_ENTRY]);
    const before = holdersAsks(wallet).length;
    /* RED WHEN: the wallet is asked, or an error thrown, for a company nothing is kept for. */
    expect(await keyring.forgetAFinishedCreation(accountId, WALLET, wallet, US)).toBe(false);
    expect(holdersAsks(wallet)).toHaveLength(before);
  });

  it('KEEPS THE CREATION WHEN THE WALLET SHOWS ANOTHER ACCOUNT COMMITTED BUT NOT THE KEPT ONE', async () => {
    const { accountId, wallet } = await sentAndKept();
    wallet.commits[OTHER_ACCOUNT] = COMMITTED;
    /* RED WHEN: a creation is forgotten on the word of anything but the wallet's read of the kept account, so a service that names another finished account strands an unfinished company. */
    await expect(keyring.forgetAFinishedCreation(accountId, WALLET, wallet, US)).rejects.toThrow(/does not show/);
    expect(keyring.companiesBeingCreated()).toEqual([accountId]);
    expect(keyring.companyAwaitingItsSecondPress(keyring.companiesBeingCreated()[0] ?? 'acc_none')).toBeNull();
    expect(holdersAsks(wallet).map((a) => a.account)).toEqual([ACCOUNT]);
    expect(await keyring.keptCreationShowsItsKeyCommitted(accountId, WALLET, wallet, US)).toBe(false);
  });

  it('KEEPS A CREATION THAT BUILT NO DEPLOY WITHOUT ASKING THE WALLET, AND READS NOTHING FOR A COMPANY NOT KEPT', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    const b = { ...builder(), accountDeploy: async () => { throw new Error('the deploy could not be built'); } };
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US)).rejects.toThrow('the deploy could not be built');
    const id = keyring.companiesBeingCreated()[0]!;
    /* RED WHEN: a creation with no deploy is read at the wallet on an account the page made up, or counted as committed. */
    expect(await keyring.keptCreationShowsItsKeyCommitted(id, WALLET, wallet, US)).toBe(false);
    await expect(keyring.forgetAFinishedCreation(id, WALLET, wallet, US)).rejects.toThrow(/does not show/);
    expect(holdersAsks(wallet)).toEqual([]);
    expect(keyring.companiesBeingCreated()).toEqual([id]);
    /* RED WHEN: a company nothing is kept for is taken as read. */
    expect(await keyring.keptCreationShowsItsKeyCommitted('acc_AAAAAAAAAAAA', WALLET, wallet, US)).toBeNull();
  });
});

describe('A CREATION IS KEPT, ALSO WHEN THE SAVED KEYS WERE SHUT AT THE NEXT FIRST PRESS', () => {
  /*
   * RED WHEN: a first press that begins with the saved keys shut, where a creation is kept, is refused, or opens the keys and
   * writes over the creation kept instead of beside it.
   */
  it('KEEPS THE FIRST CREATION AS IT WAS WHEN A SECOND IS STARTED AFTER THE KEYS OPEN', async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, builder(), wallet, US);
    keyring.forgetLocally();
    signIn();
    expect(keyring.canOpenCompanies()).toBe(false);
    expect(keyring.companiesBeingCreated()).toEqual([]);
    const posted = service.sent('POST /api/accounts').length;
    const writes = service.sent('PUT /api/me/keys').length;
    const second = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, builder(), wallet, US);
    expect(service.sent('POST /api/accounts')).toHaveLength(posted + 1);
    expect(service.sent('PUT /api/me/keys').length).toBeGreaterThan(writes);
    expect(keyring.companiesBeingCreated()).toEqual([accountId, second.accountId]);
  });
});

describe('THE SECOND PRESS', () => {
  it('HAS THE WALLET SIGN THE STEP THAT FINISHES THE ACCOUNT, AND SENDS THE DEPLOY AND THAT STEP TOGETHER', async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    const b = builder();
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    const done = await keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US);
    expect(done).toEqual({ accountId, account: ACCOUNT, state: 'deploy-sent' });
    const asked = wallet.asks.find((a) => a.kind === 'creation')!.body as CreationRequest;
    /* RED WHEN: the wallet is asked about anything but this company, this account, this deploy and these keys. */
    expect(asked).toMatchObject({ company: wallet.drew, account: ACCOUNT, deploy: 'REVQTE9Z', insert: [{ circuit: 'payout', key: 'S0VZ' }] });
    /* RED WHEN: the second step is built with anything but the wallet's signature. */
    expect(b.calls.find(([k]) => k === 'insert')).toEqual(['insert', { account: ACCOUNT, signature: { tag: 'schnorr', value: '5a'.repeat(64) } }]);
    /* RED WHEN: the two are sent apart, or other bytes than were built go. */
    expect(service.sent('POST /api/accounts/acc_X/creation').map((p) => p.body)).toEqual([{ deploy: 'REVQTE9Z', insert: 'SU5TRVJU' }]);
    expect(keyring.companyAwaitingItsSecondPress(keyring.companiesBeingCreated()[0] ?? 'acc_none')).toBeNull();
  });

  it('A SEND THAT DID NOT ARRIVE IS PRESSED AGAIN WITH THE SAME BYTES, AND THE WALLET IS NOT ASKED TWICE', async () => {
    let fail = true;
    const service = aService({ creationFails: () => fail });
    signIn();
    const wallet = new Wallet();
    const b = builder();
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    await expect(keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US)).rejects.toThrow('the node did not answer');
    expect(keyring.companyAwaitingItsSecondPress(keyring.companiesBeingCreated()[0] ?? 'acc_none')).toEqual({ accountId, account: ACCOUNT });
    fail = false;
    await keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US);
    /* RED WHEN: a retry asks the wallet again or rebuilds the second step, so the bytes sent the second time differ. */
    expect(wallet.asks.filter((a) => a.kind === 'creation')).toHaveLength(1);
    expect(b.calls.filter(([k]) => k === 'insert')).toHaveLength(1);
    const bodies = service.sent('POST /api/accounts/acc_X/creation').map((p) => p.body);
    expect(bodies).toEqual([bodies[0], bodies[0]]);
  });

  it('REFUSES A SIGNATURE BY ANY KEY BUT THE ONE THAT HOLDS THE ACCOUNT, AND SENDS NOTHING', async () => {
    const service = aService();
    signIn();
    const b = builder();
    await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, new Wallet(), US);
    /* RED WHEN: the answer's signer is not compared with the key the account is held by. */
    await expect(keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, new Wallet('another-key'), US)).rejects.toBeInstanceOf(WalletDidNotSign);
    expect(b.calls.filter(([k]) => k === 'insert')).toEqual([]);
    expect(service.sent('POST /api/accounts/acc_X/creation')).toEqual([]);
  });

  it('IS REFUSED BY NAME WHEN NOTHING IS WAITING, OR THE SAVED KEYS WHERE IT IS KEPT ARE NOT OPEN', async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    /* RED WHEN: a second press is taken with the saved keys, where a company being created is kept, not open. */
    await expect(keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, builder(), wallet, US)).rejects.toThrow(/open your saved keys first/);
    await keyring.openKeysWithWallet(WALLET, wallet, US);
    /* RED WHEN: a second press with nothing started reaches the wallet or the service. */
    await expect(keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, builder(), wallet, US))
      .rejects.toThrow('there is no company waiting to be finished.');
    expect(wallet.asks.filter((a) => a.kind === 'creation')).toEqual([]);
    expect(service.sent('POST /api/accounts/acc_X/creation')).toEqual([]);
  });
});

describe('FINISHING, AND READING WHETHER A COMPANY IS FINISHED', () => {
  const ID = 'acc_AAAAAAAAAAAA';
  it('FINISHING ASKS THE SERVICE TO SEND THE STEP IT RECORDED, AND BUILDS NOTHING', async () => {
    const service = aService();
    signIn();
    /* RED WHEN: finishing goes anywhere but the route that sends the recorded step. */
    expect(await keyring.finishCompanyOnTheChain(ID)).toEqual({ account: ACCOUNT, state: 'finish-sent' });
    expect(service.sent('POST /api/accounts/acc_X/creation/finish')).toHaveLength(1);
  });

  it('READS WHERE IT STANDS, AND A STATE THIS PAGE DOES NOT KNOW IS UNKNOWN, NEVER FINISHED', async () => {
    aService();
    signIn();
    const standing: { state: keyring.CompanyCreationState } = await keyring.companyCreationStanding(ID);
    expect(standing).toEqual({ account: ACCOUNT, state: 'finish-owed' });
    aService({ states: { standing: { account: null, state: 'done' } } });
    /* RED WHEN: a state the service did not name as one of the known ones is taken as it came. */
    expect(await keyring.companyCreationStanding(ID)).toEqual({ account: null, state: 'unknown' });
  });
});

describe('THE FOUNDING SEAT, AS THE WORKER WORKS IT OUT', () => {
  it('IS THE LEAF EVERY WRITER OF A SEAT MAKES, UNDER THE SCOPE EVERY NEW SEAT TAKES, FROM THE KEYS MADE HERE', async () => {
    const material = { signingSecret: '1c'.repeat(32), blinding: '2d'.repeat(32) };
    const a = await answerVaultAsk(async () => ({}) as never, { id: 1, network: 'undeployed', ask: 'founding-seat', material });
    if (!a.ok || a.ask !== 'founding-seat') throw new Error(a.ok ? 'another answer' : a.error);
    /* RED WHEN: the scope is anything but the chain's own scope for every vault, or the leaf is not the one definition's over it. */
    expect(a.scope).toBe(MidnightCommitments.allVaults().toLowerCase());
    expect(a.seat).toBe(storedSignerLeaf({ ...material, scope: a.scope }, MidnightCommitments).toLowerCase());
    const other = await answerVaultAsk(async () => ({}) as never, { id: 2, network: 'undeployed', ask: 'founding-seat', material: { ...material, blinding: '2e'.repeat(32) } });
    /* RED WHEN: the blinding made here is not part of the leaf. */
    expect(other.ok && other.ask === 'founding-seat' ? other.seat : null).not.toBe(a.seat);
    /* RED WHEN: material that is not a key is worked into a seat rather than refused. */
    await expect(answerVaultAsk(async () => ({}) as never, { id: 3, network: 'undeployed', ask: 'founding-seat', material: { signingSecret: 'zz', blinding: '2d'.repeat(32) } }))
      .rejects.toThrow('this device made no usable key for its seat');
  });
});

/** A reload: everything in the tab is gone, the person is signed in again and opens their saved keys. */
const reload = async (wallet: Wallet) => {
  keyring.forgetLocally();
  signIn();
  await keyring.openKeysWithWallet(WALLET, wallet, US);
};

describe('A COMPANY BEING CREATED IS KEPT WITH THE SAVED KEYS, AND CARRIED ON FROM WHERE IT STOPPED', () => {
  it('A RELOAD BETWEEN THE PRESSES CARRIES ON: THE SAME COMPANY, ITS DEPLOY AS BUILT, AND NOTHING MADE TWICE', async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    const b = builder();
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    await reload(wallet);
    /* RED WHEN: what the first press made lives only in the tab, so a reload loses the company. */
    expect(keyring.companyAwaitingItsSecondPress(keyring.companiesBeingCreated()[0] ?? 'acc_none')).toEqual({ accountId, account: ACCOUNT });
    const done = await keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US);
    expect(done).toEqual({ accountId, account: ACCOUNT, state: 'deploy-sent' });
    /* RED WHEN: the second press makes the company again, or builds another deploy - another account. */
    expect(service.sent('POST /api/accounts')).toHaveLength(1);
    expect(b.calls.filter(([k]) => k === 'deploy')).toHaveLength(1);
    expect(service.sent('POST /api/accounts/acc_X/creation').map((p) => p.body)).toEqual([{ deploy: 'REVQTE9Z', insert: 'SU5TRVJU' }]);
    expect(keyring.companiesBeingCreated()).toEqual([accountId]);
    expect(keyring.companyAwaitingItsSecondPress(keyring.companiesBeingCreated()[0] ?? 'acc_none')).toBeNull();
  });

  it('A COMPANY SENT AND NOT ANSWERED IS SENT AGAIN EXACTLY AS IT WAS, NEVER MADE AGAIN', async () => {
    let fail = true;
    const service = aService({ companyFails: () => fail });
    signIn();
    const wallet = new Wallet();
    const b = builder();
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US)).rejects.toThrow('the service did not answer');
    await reload(wallet);
    fail = false;
    await keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US);
    const bodies = service.sent('POST /api/accounts').map((p) => p.body);
    /* RED WHEN: a company that may already exist is made again rather than sent again as it was. */
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(b.calls.filter(([k]) => k === 'seat')).toHaveLength(1);
    expect(service.sent('POST /api/accounts/acc_X/creation')).toHaveLength(1);
  });

  it('A DEPLOY THAT RAN OUT, OR A SECOND STEP, IS CARRIED AGAIN FROM WHAT WAS KEPT, AND THE WALLET IS NOT ASKED AGAIN', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    const b = builder();
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    await keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US);
    const expired = aService({ states: { standing: { account: ACCOUNT, state: 'deploy-expired' } } });
    expect(await keyring.finishCompanyOnTheChain(accountId, b)).toEqual({ account: ACCOUNT, state: 'deploy-sent', builtAgain: true });
    /* RED WHEN: what is carried again is not the deploy and the second step as they were kept and recorded. */
    expect(b.calls.find(([k]) => k === 'again')).toEqual(['again', { deploy: 'REVQTE9Z', insert: 'SU5TRVJU' }]);
    expect(expired.sent('POST /api/accounts/acc_X/creation/again').map((p) => p.body)).toEqual([{ deploy: 'QUdBSU4=', insert: 'SU5BR0FJTg==' }]);
    const ranOut = aService({ states: { standing: { account: ACCOUNT, state: 'finish-expired' } } });
    await keyring.finishCompanyOnTheChain(accountId, b);
    /* RED WHEN: a second step that ran out is sent as it was, or carried from anything but what was kept since. */
    expect(b.calls.filter(([k]) => k === 'again')[1]).toEqual(['again', { deploy: 'QUdBSU4=', insert: 'SU5BR0FJTg==' }]);
    expect(ranOut.sent('POST /api/accounts/acc_X/creation/finish').map((p) => p.body)).toEqual([{ insert: 'SU5BR0FJTg==' }]);
    expect(wallet.asks.filter((a) => a.kind === 'creation')).toHaveLength(1);
  });

  it('REFUSES WHAT CARRIED AGAIN WOULD CREATE ANOTHER ACCOUNT THAN THE WALLET SIGNED FOR, AND SENDS NOTHING', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    const b = { ...builder(), creationAgain: async () => ({ account: 'c9'.repeat(32), deploy: 'QQ==', insert: 'Qg==' }) };
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    await keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US);
    const expired = aService({ states: { standing: { account: ACCOUNT, state: 'deploy-expired' } } });
    /* RED WHEN: a deploy for another account is sent in place of the one the founding signer's wallet pinned. */
    await expect(keyring.finishCompanyOnTheChain(accountId, b)).rejects.toThrow(/another account than the one your wallet signed for/);
    expect(expired.sent('POST /api/accounts/acc_X/creation/again')).toEqual([]);
  });
});

/** The minutes the tab's clock is put forward, as the time between one press and the next: every other time in the test goes by it. */
const afterMinutes = (minutes: number): void => {
  const at = Date.now() + minutes * 60_000;
  vi.spyOn(Date, 'now').mockReturnValue(at);
};
afterEach(() => { vi.restoreAllMocks(); });

describe('A CREATION THAT HAS RUN OUT, OR IS ABOUT TO, IS BUILT AGAIN BEFORE IT IS SENT, AND NEVER SENT AS IT WAS', () => {
  /** Press one, then `minutes` later press two; hands back what the builder was asked and what the service was sent. */
  const pressTwoAfter = async (minutes: number, over: Parameters<typeof aService>[0] = {}) => {
    /* The service holds nothing for the company yet, unless a test says what it holds. */
    const service = aService({ states: { standing: { account: null, state: 'not-created' } }, ...over });
    signIn();
    const wallet = new Wallet();
    const b = builder();
    const sentWhenBuiltAgain: number[] = [];
    const again = b.creationAgain;
    b.creationAgain = async (input) => {
      sentWhenBuiltAgain.push(service.sent('POST /api/accounts/acc_X/creation').length);
      return again(input);
    };
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    afterMinutes(minutes);
    const done = await keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US);
    return { service, wallet, b, accountId, done, sentWhenBuiltAgain };
  };

  it('A SECOND PRESS HOURS AFTER THE FIRST BUILDS THE DEPLOY AND THE SECOND STEP AGAIN, AND SENDS THOSE: THE WALLET IS NOT ASKED TWICE', async () => {
    const { service, wallet, b, accountId, done, sentWhenBuiltAgain } = await pressTwoAfter(125);
    /* RED WHEN: the deploy built at the first press goes to the service two hours later, where the node answers "Custom error: 228". */
    expect(service.sent('POST /api/accounts/acc_X/creation').map((p) => p.body)).toEqual([{ deploy: 'QUdBSU4=', insert: 'SU5BR0FJTg==' }]);
    /* RED WHEN: what is built again is anything but the deploy and the second step as they were kept. */
    expect(b.calls.filter(([k]) => k === 'again')).toEqual([['again', { deploy: 'REVQTE9Z', insert: 'SU5TRVJU' }]]);
    /* RED WHEN: it is sent before it is built again, or built again after the service already holds the old one. */
    expect(sentWhenBuiltAgain).toEqual([0]);
    /* RED WHEN: a ran-out step costs the person another press, though the signature names no time. */
    expect(wallet.asks.filter((a) => a.kind === 'creation')).toHaveLength(1);
    expect(b.calls.filter(([k]) => k === 'insert')).toHaveLength(1);
    /* RED WHEN: the page is not told a step was built again, so it cannot say so. */
    expect(done).toEqual({ accountId, account: ACCOUNT, state: 'deploy-sent', builtAgain: true });
    expect(keyring.companyAwaitingItsSecondPress(keyring.companiesBeingCreated()[0] ?? 'acc_none')).toBeNull();
  });

  it('A SECOND PRESS WITHIN TWELVE MINUTES BUILDS NOTHING AGAIN, AND ONE AFTER FOURTEEN DOES: SEVENTEEN OF THE THIRTY MUST BE LEFT', async () => {
    const soon = await pressTwoAfter(12);
    /* RED WHEN: a deploy with plenty of life left is built again at every press. */
    expect(soon.b.calls.filter(([k]) => k === 'again')).toEqual([]);
    expect(soon.service.sent('POST /api/accounts/acc_X/creation').map((p) => p.body)).toEqual([{ deploy: 'REVQTE9Z', insert: 'SU5TRVJU' }]);
    expect(soon.done).toEqual({ accountId: soon.accountId, account: ACCOUNT, state: 'deploy-sent' });
    keyring.forgetLocally();
    vi.restoreAllMocks();
    const late = await pressTwoAfter(14);
    /* RED WHEN: a deploy with less than half its life left is sent. */
    expect(late.b.calls.filter(([k]) => k === 'again')).toHaveLength(1);
    expect(late.service.sent('POST /api/accounts/acc_X/creation').map((p) => p.body)).toEqual([{ deploy: 'QUdBSU4=', insert: 'SU5BR0FJTg==' }]);
  });

  it('A SERVICE THAT ALREADY HOLDS THE OLD DEPLOY IS GIVEN THE NEW ONE IN ITS PLACE, NEVER AS A SECOND ACCOUNT', async () => {
    let fail = true;
    const service = aService({ creationFails: () => fail, states: { standing: { account: ACCOUNT, state: 'deploy-sent' } } });
    signIn();
    const wallet = new Wallet();
    const b = builder();
    await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    /* The first send reached the service, which recorded it, and the answer was lost. */
    await expect(keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US)).rejects.toThrow('the node did not answer');
    fail = false;
    afterMinutes(125);
    const done = await keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US);
    /* RED WHEN: the new deploy is posted where the old one is recorded, which the service refuses as another deploy for the same company. */
    expect(service.sent('POST /api/accounts/acc_X/creation')).toHaveLength(1);
    expect(service.sent('POST /api/accounts/acc_X/creation/again').map((p) => p.body)).toEqual([{ deploy: 'QUdBSU4=', insert: 'SU5BR0FJTg==' }]);
    expect(done).toMatchObject({ state: 'deploy-sent', builtAgain: true });
    expect(wallet.asks.filter((a) => a.kind === 'creation')).toHaveLength(1);
  });

  it('A SERVICE THAT CANNOT SAY WHERE THE COMPANY STANDS GETS NOTHING SENT FOR A DEPLOY BUILT AGAIN', async () => {
    const service = aService({ states: { standing: { account: ACCOUNT, state: 'surprising' } } });
    signIn();
    const wallet = new Wallet();
    const b = builder();
    await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    afterMinutes(125);
    /* RED WHEN: a deploy built again is sent without knowing whether the service holds another. */
    await expect(keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US)).rejects.toThrow(/could not say where the company stands/);
    expect(service.sent('POST /api/accounts/acc_X/creation')).toEqual([]);
    expect(service.sent('POST /api/accounts/acc_X/creation/again')).toEqual([]);
  });

  it('A COMPANY WHOSE DEPLOY LANDED WHILE IT WAITED IS NOT SENT A SECOND DEPLOY: ITS STANDING IS HANDED BACK', async () => {
    const service = aService({ states: { standing: { account: ACCOUNT, state: 'finish-owed' } } });
    signIn();
    const wallet = new Wallet();
    const b = builder();
    await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    afterMinutes(125);
    const done = await keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US);
    /* RED WHEN: a deploy is sent for an account the chain already shows. */
    expect(service.sent('POST /api/accounts/acc_X/creation')).toEqual([]);
    expect(service.sent('POST /api/accounts/acc_X/creation/again')).toEqual([]);
    expect(done).toMatchObject({ state: 'finish-owed', builtAgain: true });
  });

  it('A SECOND STEP ABOUT TO RUN OUT IS CARRIED AGAIN WHILE THE SERVICE STILL READS IT AS OWED, AND A DEPLOY SENT AND NOT LANDED IS TOO', async () => {
    const owed = await pressTwoAfter(0, { states: { standing: { account: ACCOUNT, state: 'finish-owed' } } });
    expect(keyring.keptCreationRunsOutSoon(owed.accountId, 'finish-owed')).toBe(false);
    afterMinutes(20);
    /* RED WHEN: the page cannot tell that the kept second step is short of life, so it asks the service to send the recorded one. */
    expect(keyring.keptCreationRunsOutSoon(owed.accountId, 'finish-owed')).toBe(true);
    expect(keyring.keptCreationRunsOutSoon(owed.accountId, 'deploy-sent')).toBe(true);
    expect(keyring.keptCreationRunsOutSoon(owed.accountId, 'pay-key-owed')).toBe(false);
    const finishing = aService({ states: { standing: { account: ACCOUNT, state: 'finish-owed' } } });
    /* RED WHEN: the recorded second step is sent as it is with ten minutes of life left. */
    expect(await keyring.finishCompanyOnTheChain(owed.accountId, owed.b)).toEqual({ account: ACCOUNT, state: 'finish-sent', builtAgain: true });
    expect(finishing.sent('POST /api/accounts/acc_X/creation/finish').map((p) => p.body)).toEqual([{ insert: 'SU5BR0FJTg==' }]);
    /* RED WHEN: what was built again is not kept as built just now, so it is built again at every look. */
    expect(keyring.keptCreationRunsOutSoon(owed.accountId, 'finish-owed')).toBe(false);
    const waiting = aService({ states: { standing: { account: ACCOUNT, state: 'deploy-sent' } } });
    afterMinutes(60);
    expect(await keyring.finishCompanyOnTheChain(owed.accountId, owed.b)).toEqual({ account: ACCOUNT, state: 'deploy-sent', builtAgain: true });
    expect(waiting.sent('POST /api/accounts/acc_X/creation/again').map((p) => p.body)).toEqual([{ deploy: 'QUdBSU4=', insert: 'SU5BR0FJTg==' }]);
    expect(owed.wallet.asks.filter((a) => a.kind === 'creation')).toHaveLength(1);
  });

  it('A SECOND STEP WITH PLENTY OF LIFE LEFT IS SENT AS IT WAS RECORDED, AND NOTHING IS BUILT', async () => {
    const owed = await pressTwoAfter(0, { states: { standing: { account: ACCOUNT, state: 'finish-owed' } } });
    afterMinutes(5);
    const finishing = aService({ states: { standing: { account: ACCOUNT, state: 'finish-owed' } } });
    expect(await keyring.finishCompanyOnTheChain(owed.accountId, owed.b)).toEqual({ account: ACCOUNT, state: 'finish-sent' });
    expect(finishing.sent('POST /api/accounts/acc_X/creation/finish').map((p) => p.body)).toEqual([undefined]);
    expect(owed.b.calls.filter(([k]) => k === 'again')).toEqual([]);
  });

  const realNow = () => new Date(Date.now()).toISOString();

  it('A DEVICE CLOCK THAT RUNS SLOW IS NOT STUCK: THE REFUSAL TEACHES IT THE SERVICE\'S TIME, AND THE NEXT PRESS BUILDS BY IT, WITH NO SECOND SIGNATURE', async () => {
    const trueNow = Date.now();
    const SLOW_MS = 25 * 60_000;
    let refused = true;
    const service = aService({
      states: { standing: { account: null, state: 'not-created' } },
      refuses: {
        'POST /api/accounts/acc_X/creation': () => (refused ? {
          status: 422, body: { nothingWasSent: true, runsOutSoon: true, now: new Date(trueNow).toISOString(), error: 'this deploy has run out already, or is about to. Nothing was sent.' },
        } : null),
      },
    });
    signIn();
    const wallet = new Wallet();
    const b = builder();
    /* The tab's clock is twenty-five minutes behind the service's, from the first press on. */
    vi.spyOn(Date, 'now').mockReturnValue(trueNow - SLOW_MS);
    await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    /* RED WHEN: a step short of life by the service's clock is judged fresh by the device's own, and the press ends here for good. */
    await expect(keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US)).rejects.toThrow(/has run out already, or is about to/);
    expect(b.calls.filter(([k]) => k === 'again')).toEqual([]);
    refused = false;
    const done = await keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US);
    /* RED WHEN: a refusal for the step's life does not make the next press build it again. */
    expect(b.calls.filter(([k]) => k === 'again')).toHaveLength(1);
    /* RED WHEN: the step is built again by the same slow clock, so it is refused again and again. */
    const input = b.calls.find(([k]) => k === 'again')![1] as { clockOffsetMs?: number };
    expect(input.clockOffsetMs).toBe(SLOW_MS);
    expect(done).toMatchObject({ state: 'deploy-sent', builtAgain: true });
    expect(service.sent('POST /api/accounts/acc_X/creation').map((p) => p.body)).toEqual([
      { deploy: 'REVQTE9Z', insert: 'SU5TRVJU' }, { deploy: 'QUdBSU4=', insert: 'SU5BR0FJTg==' },
    ]);
    /* RED WHEN: a step built again costs the person another press of their wallet. */
    expect(wallet.asks.filter((a) => a.kind === 'creation')).toHaveLength(1);
    expect(keyring.companyAwaitingItsSecondPress(keyring.companiesBeingCreated()[0] ?? 'acc_none')).toBeNull();
  });

  it('A REFUSAL OF THE POSTED STEP FOR ITS LIFE MAKES THE NEXT PRESS BUILD IT AGAIN, THOUGH THE DEVICE\'S OWN COPY LOOKS FRESH AND THE REFUSAL NAMED NO TIME', async () => {
    let refused = true;
    const service = aService({
      states: { standing: { account: null, state: 'not-created' } },
      refuses: { 'POST /api/accounts/acc_X/creation': () => (refused ? { status: 422, body: { nothingWasSent: true, runsOutSoon: true, error: 'this deploy has run out already, or is about to.' } } : null) },
    });
    signIn();
    const wallet = new Wallet();
    const b = builder();
    await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    await expect(keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US)).rejects.toThrow(/about to/);
    refused = false;
    const done = await keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US);
    /* RED WHEN: a refusal for time left is answered by sending the same step again, which is refused the same way. */
    expect(b.calls.filter(([k]) => k === 'again')).toHaveLength(1);
    expect(done).toMatchObject({ state: 'deploy-sent', builtAgain: true });
    expect(service.sent('POST /api/accounts/acc_X/creation').map((p) => p.body)).toEqual([
      { deploy: 'REVQTE9Z', insert: 'SU5TRVJU' }, { deploy: 'QUdBSU4=', insert: 'SU5BR0FJTg==' },
    ]);
  });

  it('A DEVICE ON TIME IS TOLD NOTHING OF ANY OFFSET: ITS BUILDS CARRY NONE', async () => {
    aService({ states: { standing: { account: null, state: 'not-created' } } });
    signIn();
    const wallet = new Wallet();
    const b = builder();
    await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    afterMinutes(125);
    await keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US);
    /* RED WHEN: a clock offset of zero is sent as if it were one. */
    expect(b.calls.filter(([k]) => k === 'again' || k === 'deploy' || k === 'insert').map(([, i]) => Object.keys(i as object).includes('clockOffsetMs'))).toEqual([false, false, false]);
  });

  it('THE STANDING\'S OWN READING OF THE RECORDED STEP LEADS: A COPY KEPT HERE THAT LOOKS FRESH IS STILL CARRIED AGAIN WHEN THE RECORDED ONE MAY BE REPLACED', async () => {
    const owed = await pressTwoAfter(0, { states: { standing: { account: ACCOUNT, state: 'finish-owed' } } });
    expect(keyring.keptCreationRunsOutSoon(owed.accountId, 'finish-owed')).toBe(false);
    const finishing = aService({ states: { standing: { account: ACCOUNT, state: 'finish-owed', replaceable: true, now: realNow() } } });
    /* RED WHEN: the device judges by the age of its own copy, though the copy the service recorded is the one about to run out. */
    expect(await keyring.finishCompanyOnTheChain(owed.accountId, owed.b)).toEqual({ account: ACCOUNT, state: 'finish-sent', builtAgain: true });
    expect(finishing.sent('POST /api/accounts/acc_X/creation/finish').map((p) => p.body)).toEqual([{ insert: 'SU5BR0FJTg==' }]);
  });

  it('A RECORDED STEP WITH PLENTY OF LIFE IS SENT AS IT IS, THOUGH THIS DEVICE\'S COPY IS OLD: THE SERVICE\'S READING LEADS BOTH WAYS', async () => {
    const owed = await pressTwoAfter(0, { states: { standing: { account: ACCOUNT, state: 'finish-owed' } } });
    afterMinutes(20);
    const finishing = aService({ states: { standing: { account: ACCOUNT, state: 'finish-owed', replaceable: false, now: realNow() } } });
    /* RED WHEN: a step the service says is fine is built again and replaced by this device because its copy is old. */
    expect(await keyring.finishCompanyOnTheChain(owed.accountId, owed.b)).toEqual({ account: ACCOUNT, state: 'finish-sent' });
    expect(owed.b.calls.filter(([k]) => k === 'again')).toEqual([]);
    expect(finishing.sent('POST /api/accounts/acc_X/creation/finish').map((p) => p.body)).toEqual([undefined]);
  });

  it('A REFUSAL OF THE RECORDED SECOND STEP FOR ITS LIFE MAKES THE NEXT CARRY BUILD IT AGAIN, WHATEVER THE DEVICE\'S COPY LOOKS LIKE, ONCE', async () => {
    const owed = await pressTwoAfter(0, { states: { standing: { account: ACCOUNT, state: 'finish-owed' } } });
    let refuses = true;
    const finishing = aService({
      states: { standing: { account: ACCOUNT, state: 'finish-owed' } },
      refuses: {
        'POST /api/accounts/acc_X/creation/finish': () => (refuses && finishing.sent('POST /api/accounts/acc_X/creation/finish').length <= 1 ? {
          status: 409, body: { nothingWasSent: true, runsOutSoon: true, state: 'finish-expired', now: realNow(), error: 'the second step recorded for this company ran out before it was sent.' },
        } : null),
      },
    });
    await expect(keyring.finishCompanyOnTheChain(owed.accountId, owed.b)).rejects.toThrow(/ran out before it was sent/);
    /* RED WHEN: the refusal changes nothing, so the same refusal is answered every ten seconds for as long as the recorded step lives. */
    expect(keyring.keptCreationRunsOutSoon(owed.accountId, 'finish-owed')).toBe(true);
    refuses = false;
    expect(await keyring.finishCompanyOnTheChain(owed.accountId, owed.b)).toEqual({ account: ACCOUNT, state: 'finish-sent', builtAgain: true });
    expect(owed.b.calls.filter(([k]) => k === 'again')).toHaveLength(1);
    /* RED WHEN: the mark is kept after the step was built again, so it is built again at every look. */
    expect(keyring.keptCreationRunsOutSoon(owed.accountId, 'finish-owed')).toBe(false);
  });

  it('A REFUSAL FOR ANYTHING BUT TIME MARKS NOTHING', async () => {
    const owed = await pressTwoAfter(0, { states: { standing: { account: ACCOUNT, state: 'finish-owed' } } });
    aService({
      states: { standing: { account: ACCOUNT, state: 'finish-owed' } },
      refuses: { 'POST /api/accounts/acc_X/creation/finish': () => ({ status: 503, body: { nothingWasSent: true, error: 'the chain could not be asked.' } }) },
    });
    await expect(keyring.finishCompanyOnTheChain(owed.accountId, owed.b)).rejects.toThrow(/chain could not be asked/);
    /* RED WHEN: any refusal that says nothing was sent is taken for one about time. */
    expect(keyring.keptCreationRunsOutSoon(owed.accountId, 'finish-owed')).toBe(false);
  });

  it('A POST THAT FAILED AND A RECORDED DEPLOY THAT THEN RAN OUT ARE CARRIED AGAIN, WHATEVER THE DEVICE\'S OWN COPY SAYS OF ITS AGE', async () => {
    let fails = true;
    aService({ creationFails: () => fails, states: { standing: { account: null, state: 'not-created' } } });
    signIn();
    const wallet = new Wallet();
    const b = builder();
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    afterMinutes(125);
    /* The press builds the pair again, and the post fails after the service recorded it: the answer was lost. */
    await expect(keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US)).rejects.toThrow('the node did not answer');
    fails = false;
    expect(b.calls.filter(([k]) => k === 'again')).toHaveLength(1);
    /* The service's record is the deploy it was first sent, which ran out; the copy here is five minutes old. */
    afterMinutes(130);
    const expired = aService({ states: { standing: { account: ACCOUNT, state: 'deploy-expired', replaceable: true, now: realNow() } } });
    /* RED WHEN: a recorded deploy that ran out waits for the device's own copy to age, so the company is never carried. */
    expect(await keyring.finishCompanyOnTheChain(accountId, b)).toEqual({ account: ACCOUNT, state: 'deploy-sent', builtAgain: true });
    expect(b.calls.filter(([k]) => k === 'again')).toHaveLength(2);
    expect(expired.sent('POST /api/accounts/acc_X/creation/again')).toHaveLength(1);
  });
});

describe('THE PAY-RECORD KEY, COMMITTED AND SEALED FROM THE FOUNDING SIGNER\'S DEVICE', () => {
  const made = async (steps: PayKeyStandingOnTheWire[]) => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    const b = builder(steps);
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    await keyring.signCompanyCreationFromTheWallet(keyring.companiesBeingCreated()[0]!, WALLET, b, wallet, US);
    return { service, b, accountId, founding: madeOf(service).founding };
  };
  const wait = async () => {};

  it('RAISES THE PROPOSAL, APPROVES IT AND SEALS THE KEY OPENED HERE, EACH ONCE THE CHAIN SHOWS THE ONE BEFORE, AND DROPS NOTHING', async () => {
    const { service, b, accountId, founding } = await made([
      payKeyAt(), payKeyAt({ open: true }), payKeyAt({ open: true, approvals: 1 }),
      payKeyAt({ committed: PAY_KEY.commitment, sealedMine: true }),
    ]);
    expect(await keyring.sealThePayRecordKey(accountId, b, { wait })).toEqual({ state: 'finished' });
    const mine = keyring.keysFor(accountId)!;
    const viewingKey = unwrapKey(founding.account.wrappedKeys[0], mine.wrappingSecret);
    const key = parseCanonical<any>(unseal(founding.state.sealed, viewingKey)).blinding.payRecordKey;
    /* RED WHEN: the key read on the chain's behalf is not the one the company was made with, or is read for another signer. */
    expect(b.calls.find(([k]) => k === 'standing')![1]).toEqual({
      account: ACCOUNT, accountState: 'U1RBVEU=', key, signingSecret: mine.signingSecret, wrappingPublicKey: founding.seat.wrappingPublicKey,
    });
    /* RED WHEN: the steps are sent in another order, more than once, or as other calls. */
    expect(service.sent('POST /api/accounts/acc_X/creation/pay-key').map((p) => p.body)).toEqual([
      { call: 'propose', tx: 'TX-propose' }, { call: 'approve', tx: 'TX-approve' }, { call: 'sealPayKey', tx: 'TX-sealPayKey' },
    ]);
    const orders = b.calls.filter(([k]) => k === 'call').map(([, i]) => (i as any).order);
    const payKey = { kind: 'pay-key', commitment: PAY_KEY.commitment };
    /* RED WHEN: the proposal raised, approved or carried out is not the one for the key's commitment, with its own salt. */
    expect(orders[0]).toMatchObject({ circuit: 'propose', payKey, proposal: PAY_KEY.proposal, half: { proposalSalt: PAY_KEY.salt, changeAmount: '0' } });
    expect(orders[1]).toEqual({ circuit: 'approve', proposal: PAY_KEY.proposal, of: { governance: payKey, proposalSalt: PAY_KEY.salt } });
    expect(orders[2]).toEqual({
      circuit: 'sealPayKey', wrap: ['d1', 'd2', 'd3', 'd4'].map((x) => x.repeat(32)), commitment: PAY_KEY.commitment,
      proposal: PAY_KEY.proposal, proposalSalt: PAY_KEY.salt,
    });
    /* RED WHEN: a call is proved with anybody's material but the founding signer's own. */
    expect((b.calls.find(([k]) => k === 'call')![1] as any).material).toEqual({ signingSecret: mine.signingSecret, blinding: mine.blinding, scope: mine.scope });
    /* RED WHEN: a step is built before the chain shows the one before it. */
    expect(b.calls.map(([k]) => k).filter((k) => k === 'standing' || k === 'call'))
      .toEqual(['standing', 'call', 'standing', 'call', 'standing', 'call', 'standing']);
    /* RED WHEN: sealing drops the kept creation on the service's own read of the chain, so a service that is ahead of the chain strands the company; only the wallet's read may. */
    expect(keyring.companiesBeingCreated()).toEqual([accountId]);
  });

  it('CARRIES ON FROM WHAT THE CHAIN SHOWS: NOTHING ALREADY ON IT IS SENT AGAIN', async () => {
    const open = await made([payKeyAt({ open: true, approvals: 1 }), payKeyAt({ committed: PAY_KEY.commitment, sealedMine: true })]);
    await keyring.sealThePayRecordKey(open.accountId, open.b, { wait });
    /* RED WHEN: a round already raised and approved is raised or approved again. */
    expect(open.service.sent('POST /api/accounts/acc_X/creation/pay-key').map((p) => p.body.call)).toEqual(['sealPayKey']);
  });

  it('REFUSES TO SEAL WHEN THE ACCOUNT IS COMMITTED TO ANOTHER KEY, AND SENDS NOTHING', async () => {
    const other = await made([payKeyAt({ committed: 'ee'.repeat(32) })]);
    /* RED WHEN: a copy is sealed for an account committed to a key this company was not made with. */
    await expect(keyring.sealThePayRecordKey(other.accountId, other.b, { wait })).rejects.toThrow(/committed to another pay-record key/);
    expect(other.service.sent('POST /api/accounts/acc_X/creation/pay-key')).toEqual([]);
    expect(keyring.companiesBeingCreated()).toEqual([other.accountId]);
  });
});

describe('THE COMPANY\'S SIGNERS ARE READ ON THIS DEVICE FROM ITS ROSTER RECORD ONLY', () => {
  /** The company the first press made, as the service serves it once the account is deployed, with its first roster beside it. */
  const servedAfterTheFirstPress = async () => {
    const service = aService();
    signIn();
    await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, builder(), new Wallet(), US);
    const made = madeOf(service);
    return { made, served: { ...made.founding.account, contractAddress: ACCOUNT, roster: made.founding.roster } };
  };
  /** Who holds the account, as the founding signer's own wallet reads it: their seat, and the key the deploy held it by. */
  const holders = (founding = LEAF) => async () => ({
    committee: [{ tag: 'schnorr', value: '11'.repeat(32) }], threshold: 1, seats: [LEAF], approvals: 1, adoptedVaults: [],
    founding, foundingCommittee: [{ tag: 'schnorr', value: '11'.repeat(32) }], account: ACCOUNT,
  }) as never;

  it('THE FOUNDING SIGNER\'S DEVICE READS THE FIRST ROSTER ON ITS OWN SIGNING KEY, BEFORE ITS DIRECTORY ENTRY IS FILED', async () => {
    const { made, served } = await servedAfterTheFirstPress();
    const opened = await keyring.openAccount(served, holders(), (id) => anchoredEntering(id), () => leavesOfTheContract);
    /* RED WHEN: the founding signer cannot read their own company before their entry is filed - they could then never set up their vault keys. */
    expect(opened?.signers.map((x) => [x.id, x.leafCommitment])).toEqual([[made.founding.seat.signerId, LEAF]]);
    expect(opened?.name).toBe('Acme Ltd');
  });

  it('A COMPANY WITH NO ROSTER RECORD IS REFUSED WITH THE FIXED SENTENCE, AND THE LIST ON ITS ACCOUNT RECORD IS NEVER READ', async () => {
    const { made, served } = await servedAfterTheFirstPress();
    const viewingKey = unwrapKey(made.founding.account.wrappedKeys[0], keyring.keysFor(made.founding.account.id)!.wrappingSecret);
    const { roster: _filed, ...withoutIt } = served;
    /* The signers as an account record carried them before they were a record: a list that opens with the company's key. */
    const unsigned = sealAccount(openAccount(made.founding.account, viewingKey, made.founding.roster), viewingKey, []).sealedRoster!;
    /* RED WHEN: a device reads a company's signers from anything but a roster record a seat signed. */
    await expect(keyring.openAccount({ ...withoutIt, sealedRoster: unsigned }, holders(), (id) => anchoredEntering(id), () => leavesOfTheContract)).rejects.toThrow(NO_ROSTER_RECORD);
    await expect(keyring.openAccount(withoutIt, holders(), (id) => anchoredEntering(id), () => leavesOfTheContract)).rejects.toThrow(NO_ROSTER_RECORD);
  });

  it('A FIRST ROSTER NOT SIGNED BY THE FOUNDING SEAT IS REFUSED', async () => {
    const { served } = await servedAfterTheFirstPress();
    const { filedBy: _was, ...unsigned } = served.roster;
    const another = signCompanyFiling(unsigned, newSigningKeypair().secret);
    /* RED WHEN: a first roster signed by a key other than this device's own, with no founding entry to hold it to, is believed. */
    await expect(keyring.openAccount({ ...served, roster: another }, holders(), (id) => anchoredEntering(id), () => leavesOfTheContract)).rejects.toThrow(/does not believe the company's roster/u);
  });
});

describe('AN INVITEE\'S DEVICE ASKS ITS OWN WALLET FOR ITS KEY FOR THE COMPANY ITS INVITATION NAMES', () => {
  it('the key comes back on a first open, the one the wallet works out from the invitation\'s label, so the seat\'s leaf can commit to it', async () => {
    aService();
    signIn();
    const label = `co_${'d4'.repeat(32)}` as CompanyLabel;
    const wallet = new Wallet();
    const key = await keyring.walletKeyForAnInvitation({ accountId: 'acc_invited', label, account: ACCOUNT as never }, WALLET, wallet, US);
    /* RED WHEN: on a first open the wallet's key for a named company is not handed back, so no invitee's leaf could commit to it. */
    expect(key).toEqual({ tag: 'schnorr', value: committeeKeyFor(identity, label).value.toLowerCase() });
    /* RED WHEN: the wallet is asked for any company but the one the invitation names. */
    expect(wallet.asks.map((a) => [a.kind, (a.body as { company?: unknown }).company, (a.body as { account?: unknown }).account]))
      .toEqual([['keyring', label, ACCOUNT]]);
  });
});

describe('AN INVITATION RE-ISSUED FOR A SEAT IS KEPT WITH ITS KEYS, IN PLACE OF THE ONE IT JOINED BY', () => {
  it('KEEPS THE SEAT THAT RE-ISSUED IT AND THE INVITATION TOGETHER, FOR THE WALLET AND FOR THE ENTRY STILL OWED', async () => {
    const service = aService();
    signIn();
    await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, builder(), new Wallet(), US);
    const id = madeOf(service).founding.account.id as string;
    const signed = { committeeKey: { tag: 'schnorr', value: 'aa'.repeat(32) }, entry: { seat: LEAF } } as never;
    await keyring.oweDirectoryEntry(id, { person: A.id, company: A_COMPANY as never, signed });
    const inviter = { committeeKey: { tag: 'schnorr', value: 'bb'.repeat(32) }, statement: { seat: 'cc'.repeat(32) }, opening: { salt: 'dd'.repeat(32) } } as never;
    const invited = { terms: { person: A.id, leaf: LEAF }, signedBy: 'ee'.repeat(32), signature: 'ff'.repeat(64) } as never;
    await keyring.keepTheReissuedInvitation(id, { inviter, invited });
    /* RED WHEN: the device keeps the re-issued invitation without the seat that signed it, or the other way round, so the wallet and the entry name two inviters. */
    expect([keyring.keysFor(id)!.invitedBy, keyring.keysFor(id)!.invited]).toEqual([inviter, invited]);
    /* RED WHEN: an entry still owed is filed under the invitation of the inviter who left. */
    expect(keyring.directoryEntryOwed(id).read()!.invited).toEqual(invited);
    /* RED WHEN: a re-issue is kept for a company this device holds no seat's keys for. */
    await expect(keyring.keepTheReissuedInvitation('acc_nobodyhere1', { inviter, invited })).rejects.toThrow(/holds no seat of yours/u);
  });
});

describe('A COMPANY BEING CREATED IS WRITTEN ONLY INTO THE SAVED KEYS OF WHOEVER STARTED IT', () => {
  const B = { id: 'usr_b', email: null, name: 'Sam' };
  /** Somebody else is signed in on this tab by another screen and opens their own saved keys. */
  const somebodyElseSignsIn = async () => {
    keyring.signedInByAnotherScreen({ user: B, address: ADDRESS, created: true, session: {} });
    await keyring.openKeysWithWallet(WALLET, new Wallet(), US);
  };

  it('SAVES NONE OF THE SEAT\'S SECRETS INTO THE KEYS OF SOMEBODY WHO SIGNS IN WHILE THE SEAT IS WORKED OUT', async () => {
    const service = aService();
    signIn();
    const b = { ...builder(), foundingSeat: async () => { await somebodyElseSignsIn(); return { seat: LEAF, scope: 'cd'.repeat(32), publicKey: 'ef'.repeat(32) }; } };
    /* RED WHEN: the person who started the company is not asked again after the seat is worked out, so their seat's secrets are sealed into the keys of whoever is signed in by then. */
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, new Wallet(), US)).rejects.toBeInstanceOf(keyring.CompanyStartedBySomebodyElse);
    expect(service.savesBy(B.id)).toEqual([]);
    expect(service.savesBy(A.id)).toEqual([]);
    expect(service.sent('POST /api/accounts')).toEqual([]);
  });

  it('LEAVES THE KEYS OF SOMEBODY WHO SIGNS IN WHILE THE COMPANY IS SENT UNTOUCHED, SO THEY CAN CREATE THEIR OWN', async () => {
    const service = aService({ during: { route: 'POST /api/accounts', run: somebodyElseSignsIn } });
    signIn();
    /* RED WHEN: the kept creation is written after the service answered into whoever's keys the tab holds then, leaving them holding a company that is not theirs. */
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, builder(), new Wallet(), US)).rejects.toBeInstanceOf(keyring.CompanyStartedBySomebodyElse);
    expect(service.savesBy(B.id)).toEqual([]);
    expect(keyring.companiesBeingCreated()).toEqual([]);
  });

  it('LEAVES THE KEYS OF SOMEBODY WHO SIGNS IN WHILE THE DEPLOY IS BUILT UNTOUCHED', async () => {
    const service = aService();
    signIn();
    const b = { ...builder(), accountDeploy: async () => { await somebodyElseSignsIn(); return { account: ACCOUNT, tx: 'REVQTE9Z', insert: [{ circuit: 'payout', key: 'S0VZ' }] }; } };
    /* RED WHEN: the built deploy is kept into whoever's keys the tab holds when the build returns. */
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, new Wallet(), US)).rejects.toBeInstanceOf(keyring.CompanyStartedBySomebodyElse);
    expect(service.savesBy(B.id)).toEqual([]);
    expect(keyring.companiesBeingCreated()).toEqual([]);
  });
});

describe('STARTING AN UNFINISHED CREATION AGAIN SETS IT ASIDE ONLY WHEN THE CHAIN, READ ON THIS DEVICE, SHOWS NO ACCOUNT AND NOTHING SENT CAN STILL LAND', () => {
  const TTL = Date.UTC(2026, 9, 20, 12, 0, 0);
  const FIVE = 5 * 60_000;
  type Seen = { held: boolean; blockHeight: number; blockTime: number; ttl: number | null };
  const absentAt = (blockTime: number, ttl: number | null = TTL): Seen => ({ held: false, blockHeight: 10, blockTime, ttl });
  /** A creation signed and sent; the service reads it at `standing`; the device's chain read says `seen`. */
  const sentWith = async (standing: Record<string, unknown>, seen: Seen | Error = absentAt(TTL + FIVE)) => {
    const states = { standing };
    const service = aService({ states });
    signIn();
    const wallet = new Wallet();
    const b = builder();
    const asked: Array<{ account: string; indexer: unknown; transactions: string[] }> = [];
    const withPresence = { ...b, accountPresence: async (input: { account: string; indexer: unknown; transactions: string[] }) => {
      asked.push(input);
      if (seen instanceof Error) throw seen;
      return seen;
    } } as keyring.AccountCreationBuilder & { calls: Array<[string, unknown]> };
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, withPresence, wallet, US);
    await keyring.signCompanyCreationFromTheWallet(accountId, WALLET, withPresence, wallet, US);
    return { service, states, wallet, accountId, b: withPresence, asked };
  };
  /** The wallet has named its indexer in an answer it completed, then cannot read the account. */
  const walletCannotRead = async (wallet: Wallet, accountId: string) => {
    await keyring.holdersFromTheWallet(WALLET, { company: wallet.drew!, account: ACCOUNT as never }, wallet, US);
    wallet.refusesHolders = 'unreadable';
    void accountId;
  };
  const again = (id: string, wallet: Wallet, b: keyring.AccountCreationBuilder | null) => keyring.startAnUnfinishedCreationAgain(id, WALLET, b, wallet, US);
  const deploying = { account: null, state: 'deploy-expired' };

  it('DROPS A CREATION THAT WAS NEVER SIGNED OR SENT, WITHOUT ASKING THE CHAIN, KEEPING THE COMPANY\'S KEYS', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, builder(), wallet, US);
    /* RED WHEN: a creation nothing was signed for cannot be started again, which is how the first press stays refused. */
    expect(await again(accountId, wallet, null)).toEqual({ of: 'dropped' });
    expect(keyring.companiesBeingCreated()).toEqual([]);
    expect(keyring.keysFor(accountId)).not.toBeNull();
    expect(wallet.asks.filter((a) => a.kind === 'holders')).toHaveLength(0);
  });

  for (const state of ['finish-owed', 'finish-expired', 'finish-sent', 'pay-key-owed', 'finished']) {
    it(`NEVER SETS ASIDE A CREATION WHOSE DEPLOY LANDED: THE SERVICE SAYS ${state.toUpperCase()}`, async () => {
      const { accountId, wallet, b, asked } = await sentWith({ account: ACCOUNT, state });
      /* RED WHEN: a company whose deploy is on the chain is set aside, and its account is left unfinished. */
      expect(await again(accountId, wallet, b)).toEqual({ of: 'on-the-chain' });
      expect(keyring.companiesBeingCreated()).toEqual([accountId]);
      expect(asked).toEqual([]);
    });
  }

  it('NEVER SETS ASIDE A CREATION THE WALLET READS AN ACCOUNT FOR, THOUGH THE SERVICE SAYS ITS DEPLOY NEVER LANDED', async () => {
    const { accountId, wallet, b, asked } = await sentWith(deploying);
    /* RED WHEN: the service's word alone that the deploy never landed is enough. */
    expect(await again(accountId, wallet, b)).toEqual({ of: 'on-the-chain' });
    expect(keyring.companiesBeingCreated()).toEqual([accountId]);
    expect(asked).toEqual([]);
  });

  it('NEVER SETS ASIDE ON AN INDEXER THAT IS UNREACHABLE: THE READ THROWS, SO THE CREATION IS KEPT', async () => {
    const { accountId, wallet, b, asked } = await sentWith(deploying, new Error('the indexer answered 503.'));
    await walletCannotRead(wallet, accountId);
    /* RED WHEN: a failed read of the chain is taken for an account that is not there. */
    expect(await again(accountId, wallet, b)).toEqual({ of: 'not-confirmed' });
    expect(asked).toHaveLength(1);
    expect(keyring.companiesBeingCreated()).toEqual([accountId]);
  });

  it('READS THE CHAIN AT THE INDEXER THE WALLET NAMED, WITH THE ACCOUNT AND BOTH KEPT TRANSACTIONS', async () => {
    const { accountId, wallet, b, asked } = await sentWith(deploying, { held: true, blockHeight: 10, blockTime: TTL, ttl: TTL });
    await walletCannotRead(wallet, accountId);
    /* RED WHEN: the read goes to an indexer the wallet did not name, or leaves out the transactions the time to live is read from. */
    expect(await again(accountId, wallet, b)).toEqual({ of: 'on-the-chain' });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.indexer).toEqual({ indexerUri: 'https://indexer.example/api/v4/graphql', indexerWsUri: 'wss://indexer.example/api/v4/graphql/ws' });
    expect(asked[0]!.account).toBe(ACCOUNT);
    expect(asked[0]!.transactions).toHaveLength(2);
    expect(keyring.companiesBeingCreated()).toEqual([accountId]);
  });

  it('KEEPS THE CREATION WHEN THE WALLET NEVER NAMED AN INDEXER: THERE IS NOWHERE TO READ THE CHAIN FROM', async () => {
    const { accountId, wallet, b, asked } = await sentWith(deploying);
    wallet.refusesHolders = 'unreadable';
    /* RED WHEN: the chain is read at an indexer nobody the person trusts named. */
    expect(await again(accountId, wallet, b)).toEqual({ of: 'not-confirmed' });
    expect(await again(accountId, wallet, null)).toEqual({ of: 'not-confirmed' });
    expect(asked).toEqual([]);
    expect(keyring.companiesBeingCreated()).toEqual([accountId]);
  });

  it('KEEPS A DEPLOY THE CHAIN\'S OWN TIME SAYS CAN STILL LAND, THOUGH THE DEVICE CLOCK IS FAR AHEAD, AND SAYS HOW LONG TO WAIT', async () => {
    const { accountId, wallet, b } = await sentWith(deploying, absentAt(TTL - 60_000));
    await walletCannotRead(wallet, accountId);
    afterMinutes(24 * 60);
    const r = await again(accountId, wallet, b);
    /* RED WHEN: the device's clock decides, so a clock that is far ahead sets aside a deploy that is still live. */
    expect(r).toEqual({ of: 'may-still-land', minutes: 6 });
    expect(keyring.companiesBeingCreated()).toEqual([accountId]);
  });

  it('KEEPS THE CREATION ONE MILLISECOND BEFORE THE SERVICE\'S MARGIN, AND SETS IT ASIDE AT IT', async () => {
    const early = await sentWith(deploying, absentAt(TTL + FIVE - 1));
    await walletCannotRead(early.wallet, early.accountId);
    /* RED WHEN: the margin is shorter than the service's five minutes. */
    expect(await again(early.accountId, early.wallet, early.b)).toEqual({ of: 'may-still-land', minutes: 1 });
    expect(keyring.companiesBeingCreated()).toEqual([early.accountId]);
  });

  it('KEEPS THE CREATION WHEN A KEPT TRANSACTION\'S TIME TO LIVE CANNOT BE READ', async () => {
    const { accountId, wallet, b } = await sentWith(deploying, absentAt(TTL + 10 * FIVE, null));
    await walletCannotRead(wallet, accountId);
    /* RED WHEN: a transaction that cannot be read is taken for one that has run out. */
    expect(await again(accountId, wallet, b)).toEqual({ of: 'not-confirmed' });
    expect(keyring.companiesBeingCreated()).toEqual([accountId]);
  });

  it('SETS A CREATION ASIDE, NOT DELETES IT, ONCE A CLEAN READ SHOWS NO ACCOUNT PAST THE TIME TO LIVE AND THE MARGIN, KEEPING THE KEYS', async () => {
    const { accountId, wallet, b } = await sentWith(deploying, absentAt(TTL + FIVE));
    await walletCannotRead(wallet, accountId);
    /* RED WHEN: a deploy that cannot land and shows no account keeps the person from creating another company. */
    expect(await again(accountId, wallet, b)).toEqual({ of: 'dropped' });
    expect(keyring.companiesBeingCreated()).toEqual([]);
    expect(keyring.keysFor(accountId)).not.toBeNull();
    /* RED WHEN: a creation set aside loses the name the person gave the company, so it is listed with no name. */
    expect(keyring.companyNameKeptHere(accountId)).toBe(A_COMPANY.name);
  });

  it('FINISHES A CREATION SET ASIDE IF ITS ACCOUNT LATER APPEARS: THE SERVICE READS THE DEPLOY LANDED AND THE CREATION COMES BACK', async () => {
    const { states, accountId, wallet, b, service } = await sentWith(deploying, absentAt(TTL + FIVE));
    await walletCannotRead(wallet, accountId);
    expect(await again(accountId, wallet, b)).toEqual({ of: 'dropped' });
    expect(keyring.companiesBeingCreated()).toEqual([]);
    /* RED WHEN: a creation set aside is lost, so an account that landed late can never be finished. */
    states.standing = { account: ACCOUNT, state: 'finish-owed' };
    await keyring.finishCompanyOnTheChain(accountId);
    expect(keyring.companiesBeingCreated()).toEqual([accountId]);
    expect(service.sent('POST /api/accounts/acc_X/creation/finish')).toHaveLength(1);
  });

  it('LEAVES A CREATION SET ASIDE ALONE WHILE ITS DEPLOY IS NOT ON THE CHAIN, AND TAKES IT UP BESIDE ANOTHER WITHOUT TOUCHING THAT ONE', async () => {
    const { states, accountId, wallet, b } = await sentWith(deploying, absentAt(TTL + FIVE));
    await walletCannotRead(wallet, accountId);
    expect(await again(accountId, wallet, b)).toEqual({ of: 'dropped' });
    /* RED WHEN: a creation set aside is taken up while the service reads its deploy as not landed. */
    expect(await keyring.takeUpACreationSetAside('acc_AAAAAAAAAAAA')).toBe(false);
    await keyring.startCompanyHeldFromTheStart({ ...A_COMPANY, name: 'Other Ltd' }, WALLET, b, wallet, US);
    const other = keyring.companiesBeingCreated()[0]!;
    expect(other).not.toBe(accountId);
    states.standing = { account: ACCOUNT, state: 'finish-owed' };
    /* RED WHEN: taking one up is refused because another is kept, or replaces it. */
    expect(await keyring.takeUpACreationSetAside(accountId)).toBe(true);
    expect(keyring.companiesBeingCreated()).toEqual([accountId, other]);
    expect(keyring.companyNameKeptHere(other)).toBe('Other Ltd');
    expect(keyring.companyNameKeptHere(accountId)).toBe(A_COMPANY.name);
  });

  it('SETS ONE CREATION ASIDE WITHOUT TOUCHING THE OTHER, AND READS BACK SAVED KEYS WRITTEN IN THE OLDER SHAPE WITH BOTH', async () => {
    const { states, accountId, wallet, b } = await sentWith(deploying, absentAt(TTL + FIVE));
    await walletCannotRead(wallet, accountId);
    const other = await keyring.startCompanyHeldFromTheStart({ ...A_COMPANY, name: 'Other Ltd' }, WALLET, b, wallet, US);
    /* RED WHEN: starting one again sets aside, drops or changes the other creation. */
    expect(await again(accountId, wallet, b)).toEqual({ of: 'dropped' });
    expect(keyring.companiesBeingCreated()).toEqual([other.accountId]);
    expect(keyring.companyAwaitingItsSecondPress(other.accountId)).toEqual({ accountId: other.accountId, account: ACCOUNT });
    expect(keyring.companyNameKeptHere(accountId)).toBe(A_COMPANY.name);
    expect(keyring.companyKeptWithNoDeploy(accountId)).toBeNull();
    expect(keyring.companyBeingCreatedLabel(accountId)).toBeNull();
    /* The saved keys, as a build that kept the one set aside apart wrote them. */
    unsealing.rewrite = (plain) => {
      const k = JSON.parse(plain);
      if (k.creations === undefined) return plain;
      const active: Record<string, unknown> = {}; const aside: Record<string, unknown> = {};
      for (const [id, c] of Object.entries<any>(k.creations)) { const { setAside, ...rest } = c; (setAside === true ? aside : active)[id] = rest; }
      return JSON.stringify({ ...k, creations: active, creationsSetAside: aside });
    };
    await reload(wallet);
    /* RED WHEN: a creation set aside in the older shape is lost when the keys are read, or read as one being finished. */
    expect(keyring.companiesBeingCreated()).toEqual([other.accountId]);
    expect(keyring.companyNameKeptHere(accountId)).toBe(A_COMPANY.name);
    expect(keyring.companyNameKeptHere(other.accountId)).toBe('Other Ltd');
    states.standing = { account: ACCOUNT, state: 'finish-owed' };
    await keyring.finishCompanyOnTheChain(accountId);
    expect(keyring.companiesBeingCreated().sort()).toEqual([accountId, other.accountId].sort());
  });

  it('NEVER DROPS A SIGNED CREATION BECAUSE ANOTHER ONE WAS STARTED AGAIN: EACH IS READ ON THE CHAIN FOR ITSELF', async () => {
    const { accountId, wallet, b } = await sentWith(deploying, absentAt(TTL + FIVE - 1));
    await walletCannotRead(wallet, accountId);
    const other = await keyring.startCompanyHeldFromTheStart({ ...A_COMPANY, name: 'Other Ltd' }, WALLET, b, wallet, US);
    /* RED WHEN: starting the unsent one again clears the sent one with it, or the sent one is dropped without its own chain read. */
    expect(await again(other.accountId, wallet, b)).toEqual({ of: 'dropped' });
    expect(keyring.companiesBeingCreated()).toEqual([accountId]);
    expect(await again(accountId, wallet, b)).toEqual({ of: 'may-still-land', minutes: 1 });
    expect(keyring.companiesBeingCreated()).toEqual([accountId]);
    expect(keyring.keysFor(other.accountId)).not.toBeNull();
  });

  it('SENDS NOTHING FOR A CREATION SET ASIDE WHILE ITS STEP WAS BEING BUILT AGAIN', async () => {
    const { accountId, wallet, b, service } = await sentWith(deploying, absentAt(TTL + FIVE));
    await walletCannotRead(wallet, accountId);
    let finishBuilding!: () => void;
    const building = new Promise<void>((r) => { finishBuilding = r; });
    const slow = { ...b, creationAgain: async (input: Parameters<typeof b.creationAgain>[0]) => { await building; return b.creationAgain(input); } };
    const carrying = keyring.finishCompanyOnTheChain(accountId, slow);
    await vi.waitFor(() => expect(service.sent('GET /api/accounts/acc_X/creation').length).toBeGreaterThan(0));
    expect(await again(accountId, wallet, b)).toEqual({ of: 'dropped' });
    finishBuilding();
    /* RED WHEN: a step built after the creation was set aside puts it back and sends a deploy nobody wants. */
    await expect(carrying).rejects.toThrow(/started again/);
    expect(service.sent('POST /api/accounts/acc_X/creation/again')).toHaveLength(0);
    expect(keyring.companiesBeingCreated()).toEqual([]);
  });

  it('REFUSES A COMPANY THIS TAB KEEPS NO CREATION OF, AND DROPS NOTHING OF A COMPANY SOMEBODY ELSE STARTED', async () => {
    const { accountId, wallet, b } = await sentWith(deploying, absentAt(TTL + FIVE));
    await walletCannotRead(wallet, accountId);
    /* RED WHEN: starting again a company that is not kept here is taken as done. */
    await expect(keyring.startAnUnfinishedCreationAgain('acc_AAAAAAAAAAAA', WALLET, b, wallet, US)).rejects.toThrow(/keeps no creation/);
    keyring.signedInByAnotherScreen({ user: { id: 'usr_b', email: null, name: 'Sam' }, address: ADDRESS, created: true, session: {} });
    await keyring.openKeysWithWallet(WALLET, new Wallet(), US);
    /* RED WHEN: a person sets aside the creation another person started on the same browser. */
    await expect(again(accountId, wallet, b)).rejects.toThrow();
  });
});
