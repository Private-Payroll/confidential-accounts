import { afterEach, describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { READY_PING } from 'midnight-identity/profile/channel';
import { parseAsk, type CreationRequest, type KeyringRequest } from 'midnight-identity/profile/request';
import { keyringReleaseFor } from 'midnight-identity/profile/unlock';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { CREATION_SIGNATURE_SCHEMA } from 'midnight-identity/profile/creation-sign';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { unwrapKey, unseal, parseCanonical, signingPublicKeyOf } from '../../../src/core/crypto.js';
import { openAccount } from '../../../src/core/account.js';
import { secretCarried } from '../../../src/server/account-creation.js';
import * as keyring from './keyring.js';
import type { PayKeyStandingOnTheWire } from './vault-worker-client.js';
import { answerVaultAsk } from './vault-worker-entry.js';
import { storedSignerLeaf } from '../../../src/core/signer-leaf.js';
import { MidnightCommitments } from '../../../src/midnight/commitments.js';
import { WalletDidNotSign } from './wallet-committee.js';
import type { Openable } from './wallet-sign-in.js';

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
    foundingSeat: async (material: unknown) => { calls.push(['seat', material]); return { seat: LEAF.toUpperCase(), scope: 'cd'.repeat(32) }; },
    accountDeploy: async (input: unknown) => {
      calls.push(['deploy', input]);
      return { account: ACCOUNT, tx: 'REVQTE9Z', insert: [{ circuit: 'payout', key: 'S0VZ' }] };
    },
    finishedCreation: async (input: unknown) => { calls.push(['insert', input]); return { tx: 'SU5TRVJU' }; },
  };
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; keyring.forgetLocally(); });

function aService(opts: { creationFails?: () => boolean; companyFails?: () => boolean; states?: Record<string, unknown> } = {}) {
  const posted: { route: string; body: any }[] = [];
  /* Every write, in order, so a test can say what was saved before what was sent. */
  const order: string[] = [];
  let saved: { bundle: unknown; version: number } = { bundle: null, version: 0 };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = `${String(init?.method ?? 'GET')} ${url}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    posted.push({ route, body });
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    const generic = route.replace(/acc_[A-Za-z0-9_-]{12}/u, 'acc_X');
    if (route !== 'GET /api/me/keys') order.push(generic);
    switch (generic) {
      case 'GET /api/me/keys': return json(200, { keyBundle: saved.bundle, version: saved.version });
      case 'PUT /api/me/keys': saved = { bundle: body.keyBundle, version: saved.version + 1 }; return json(200, { version: saved.version });
      case 'POST /api/accounts':
        if (opts.companyFails?.()) return json(502, { error: 'the service did not answer' });
        return json(201, { account: { id: body.founding.account.id }, state: 'made' });
      case 'POST /api/accounts/acc_X/creation':
        if (opts.creationFails?.()) return json(502, { nothingWasSent: false, error: 'the node did not answer' });
        return json(201, { account: ACCOUNT, state: 'deploy-sent', txRef: 'tx' });
      case 'POST /api/accounts/acc_X/creation/finish': return json(200, opts.states?.finish ?? { account: ACCOUNT, state: 'finish-sent' });
      case 'GET /api/accounts/acc_X/creation': return json(200, opts.states?.standing ?? { account: ACCOUNT, state: 'finish-owed' });
      case 'POST /api/accounts/acc_X/creation/again': return json(200, { account: ACCOUNT, state: 'deploy-sent' });
      case 'GET /api/accounts/acc_X/call-state': return json(200, { account: ACCOUNT, blockHash: '00'.repeat(32), accountState: 'U1RBVEU=', parameters: 'UEFSQU1T' });
      case 'POST /api/accounts/acc_X/creation/pay-key': return json(200, { txRef: 'tx' });
      default: return json(404, { error: `no route for ${route}` });
    }
  }) as typeof fetch;
  return {
    sent: (route: string) => posted.filter((p) => p.route.replace(/acc_[A-Za-z0-9_-]{12}/u, 'acc_X') === route),
    order,
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
    expect(started).toEqual({ accountId: made.founding.account.id, account: ACCOUNT });
    const drew = wallet.drew!;
    const key = { tag: 'schnorr', value: committeeKeyFor(identity, drew).value };
    /* RED WHEN: the service is not told the key that holds the account, or is told another one than the wallet gave for the label it drew. */
    expect(made).toMatchObject({ companyLabel: drew, foundingKey: key });
    /* RED WHEN: the deploy is built from anything but the seat this device worked out, the drawn label and that key. */
    expect(b.calls.find(([k]) => k === 'deploy')).toEqual(['deploy', { foundingLeaf: LEAF, label: drew, foundingKey: key }]);
    /* RED WHEN: anything is sent before the wallet has signed the second step. */
    expect(service.sent('POST /api/accounts/acc_X/creation')).toEqual([]);
    expect(keyring.companyAwaitingItsSecondPress()).toEqual({ accountId: made.founding.account.id, account: ACCOUNT });
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
    expect(Object.keys(made.founding).sort()).toEqual(['account', 'sealedState', 'seat']);
    /* RED WHEN: the seat's secrets are kept after the company is sent, or not at all: a company would exist whose keys were never kept. */
    expect(service.order.slice(0, 2)).toEqual(['PUT /api/me/keys', 'POST /api/accounts']);
    const mine = keyring.keysFor(id)!;
    /* RED WHEN: the seat sent is not the one made from the keys kept here. */
    expect(made.founding.seat.signingPublicKey).toBe(signingPublicKeyOf(mine.signingSecret));
    expect(mine.signerId).toBe(made.founding.seat.signerId);
    expect(made.founding.seat.leaf).toBe(LEAF);
    expect(mine.scope).toBe('cd'.repeat(32));
    /* RED WHEN: the leaf is worked out from anything but the keys kept here. */
    expect(b.calls[0]).toEqual(['seat', { signingSecret: mine.signingSecret, blinding: mine.blinding }]);
    /* RED WHEN: the viewing key is wrapped to anybody but this seat, or the record does not open with it. */
    const viewingKey = unwrapKey(made.founding.account.wrappedKeys[0], mine.wrappingSecret);
    const opened = openAccount(made.founding.account, viewingKey);
    expect(opened.signers.map((x) => [x.id, x.userId, x.leafCommitment])).toEqual([[mine.signerId, A.id, LEAF]]);
    expect(opened.policy.threshold).toBe(1);
    /* RED WHEN: the first state is not sealed under the same viewing key, or carries no asset blinding, payout seed or pay-record key. */
    const state = parseCanonical<{ blinding: Record<string, unknown> }>(unseal(made.founding.sealedState.sealed, viewingKey));
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

  it('THE COMPANY STEP AS IT IS TODAY SENDS NO KEY, SO ON A CHAIN THE SERVICE REFUSES IT BY NAME', async () => {
    const service = aService();
    signIn();
    await keyring.createCompanyWithWallet(A_COMPANY, WALLET, new Wallet(), US).catch(() => undefined);
    /* RED WHEN: the step the web app calls today starts sending a key or a company made here, which only the two presses may. */
    expect(service.sent('POST /api/accounts')[0]!.body.foundingKey).toBeUndefined();
    expect(service.sent('POST /api/accounts')[0]!.body.founding).toBeUndefined();
  });
});

describe('THE SECOND PRESS', () => {
  it('HAS THE WALLET SIGN THE STEP THAT FINISHES THE ACCOUNT, AND SENDS THE DEPLOY AND THAT STEP TOGETHER', async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    const b = builder();
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    const done = await keyring.signCompanyCreationFromTheWallet(WALLET, b, wallet, US);
    expect(done).toEqual({ accountId, account: ACCOUNT, state: 'deploy-sent' });
    const asked = wallet.asks.find((a) => a.kind === 'creation')!.body as CreationRequest;
    /* RED WHEN: the wallet is asked about anything but this company, this account, this deploy and these keys. */
    expect(asked).toMatchObject({ company: wallet.drew, account: ACCOUNT, deploy: 'REVQTE9Z', insert: [{ circuit: 'payout', key: 'S0VZ' }] });
    /* RED WHEN: the second step is built with anything but the wallet's signature. */
    expect(b.calls.find(([k]) => k === 'insert')).toEqual(['insert', { account: ACCOUNT, signature: { tag: 'schnorr', value: '5a'.repeat(64) } }]);
    /* RED WHEN: the two are sent apart, or other bytes than were built go. */
    expect(service.sent('POST /api/accounts/acc_X/creation').map((p) => p.body)).toEqual([{ deploy: 'REVQTE9Z', insert: 'SU5TRVJU' }]);
    expect(keyring.companyAwaitingItsSecondPress()).toBeNull();
  });

  it('A SEND THAT DID NOT ARRIVE IS PRESSED AGAIN WITH THE SAME BYTES, AND THE WALLET IS NOT ASKED TWICE', async () => {
    let fail = true;
    const service = aService({ creationFails: () => fail });
    signIn();
    const wallet = new Wallet();
    const b = builder();
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    await expect(keyring.signCompanyCreationFromTheWallet(WALLET, b, wallet, US)).rejects.toThrow('the node did not answer');
    expect(keyring.companyAwaitingItsSecondPress()).toEqual({ accountId, account: ACCOUNT });
    fail = false;
    await keyring.signCompanyCreationFromTheWallet(WALLET, b, wallet, US);
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
    await expect(keyring.signCompanyCreationFromTheWallet(WALLET, b, new Wallet('another-key'), US)).rejects.toBeInstanceOf(WalletDidNotSign);
    expect(b.calls.filter(([k]) => k === 'insert')).toEqual([]);
    expect(service.sent('POST /api/accounts/acc_X/creation')).toEqual([]);
  });

  it('IS REFUSED BY NAME WHEN NOTHING IS WAITING, OR THE SAVED KEYS WHERE IT IS KEPT ARE NOT OPEN', async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    /* RED WHEN: a second press is taken with the saved keys, where a company being created is kept, not open. */
    await expect(keyring.signCompanyCreationFromTheWallet(WALLET, builder(), wallet, US)).rejects.toThrow(/open your saved keys first/);
    await keyring.openKeysWithWallet(WALLET, wallet, US);
    /* RED WHEN: a second press with nothing started reaches the wallet or the service. */
    await expect(keyring.signCompanyCreationFromTheWallet(WALLET, builder(), wallet, US))
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
    expect(keyring.companyAwaitingItsSecondPress()).toEqual({ accountId, account: ACCOUNT });
    /* RED WHEN: a first press while one is kept makes a second company. */
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US)).rejects.toThrow(/not finished yet/);
    const done = await keyring.signCompanyCreationFromTheWallet(WALLET, b, wallet, US);
    expect(done).toEqual({ accountId, account: ACCOUNT, state: 'deploy-sent' });
    /* RED WHEN: the second press makes the company again, or builds another deploy - another account. */
    expect(service.sent('POST /api/accounts')).toHaveLength(1);
    expect(b.calls.filter(([k]) => k === 'deploy')).toHaveLength(1);
    expect(service.sent('POST /api/accounts/acc_X/creation').map((p) => p.body)).toEqual([{ deploy: 'REVQTE9Z', insert: 'SU5TRVJU' }]);
    expect(keyring.companyBeingCreated()).toBe(accountId);
    expect(keyring.companyAwaitingItsSecondPress()).toBeNull();
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
    await keyring.signCompanyCreationFromTheWallet(WALLET, b, wallet, US);
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
    await keyring.signCompanyCreationFromTheWallet(WALLET, b, wallet, US);
    const expired = aService({ states: { standing: { account: ACCOUNT, state: 'deploy-expired' } } });
    expect(await keyring.finishCompanyOnTheChain(accountId, b)).toEqual({ account: ACCOUNT, state: 'deploy-sent' });
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
    await keyring.signCompanyCreationFromTheWallet(WALLET, b, wallet, US);
    const expired = aService({ states: { standing: { account: ACCOUNT, state: 'deploy-expired' } } });
    /* RED WHEN: a deploy for another account is sent in place of the one the founding signer's wallet pinned. */
    await expect(keyring.finishCompanyOnTheChain(accountId, b)).rejects.toThrow(/another account than the one your wallet signed for/);
    expect(expired.sent('POST /api/accounts/acc_X/creation/again')).toEqual([]);
  });
});

describe('THE PAY-RECORD KEY, COMMITTED AND SEALED FROM THE FOUNDING SIGNER\'S DEVICE', () => {
  const made = async (steps: PayKeyStandingOnTheWire[]) => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    const b = builder(steps);
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    await keyring.signCompanyCreationFromTheWallet(WALLET, b, wallet, US);
    return { service, b, accountId, founding: madeOf(service).founding };
  };
  const wait = async () => {};

  it('RAISES THE PROPOSAL, APPROVES IT AND SEALS THE KEY OPENED HERE, EACH ONCE THE CHAIN SHOWS THE ONE BEFORE, THEN DROPS WHAT WAS KEPT', async () => {
    const { service, b, accountId, founding } = await made([
      payKeyAt(), payKeyAt({ open: true }), payKeyAt({ open: true, approvals: 1 }),
      payKeyAt({ committed: PAY_KEY.commitment, sealedMine: true }),
    ]);
    expect(await keyring.sealThePayRecordKey(accountId, b, { wait })).toEqual({ state: 'finished' });
    const mine = keyring.keysFor(accountId)!;
    const viewingKey = unwrapKey(founding.account.wrappedKeys[0], mine.wrappingSecret);
    const key = parseCanonical<any>(unseal(founding.sealedState.sealed, viewingKey)).blinding.payRecordKey;
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
    /* RED WHEN: what was kept of the creation outlives it. */
    expect(keyring.companyBeingCreated()).toBeNull();
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
    expect(keyring.companyBeingCreated()).toBe(other.accountId);
  });
});
