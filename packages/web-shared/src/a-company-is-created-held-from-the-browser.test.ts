import { afterEach, describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { READY_PING } from 'midnight-identity/profile/channel';
import { parseAsk, type CreationRequest, type KeyringRequest } from 'midnight-identity/profile/request';
import { keyringReleaseFor } from 'midnight-identity/profile/unlock';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { CREATION_SIGNATURE_SCHEMA } from 'midnight-identity/profile/creation-sign';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import * as keyring from './keyring.js';
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

const builder = (): keyring.AccountCreationBuilder & { calls: Array<[string, unknown]> } => {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    accountDeploy: async (input: unknown) => {
      calls.push(['deploy', input]);
      return { account: ACCOUNT, tx: 'REVQTE9Z', insert: [{ circuit: 'payout', key: 'S0VZ' }] };
    },
    finishedCreation: async (input: unknown) => { calls.push(['insert', input]); return { tx: 'SU5TRVJU' }; },
  };
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; keyring.forgetLocally(); });

function aService(opts: { creationFails?: () => boolean; states?: Record<string, unknown> } = {}) {
  const posted: { route: string; body: any }[] = [];
  let saved: { bundle: unknown; version: number } = { bundle: null, version: 0 };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = `${String(init?.method ?? 'GET')} ${url}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    posted.push({ route, body });
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    switch (route) {
      case 'GET /api/me/keys': return json(200, { keyBundle: saved.bundle, version: saved.version });
      case 'PUT /api/me/keys': saved = { bundle: body.keyBundle, version: saved.version + 1 }; return json(200, { version: saved.version });
      case 'POST /api/accounts': return json(200, {
        account: { id: 'acc_new', signers: [{ leafCommitment: LEAF.toUpperCase() }] },
        secrets: [{ signerId: 'sgn_new', signingSecret: 'dd'.repeat(32), wrappingSecret: 'ee'.repeat(32), blinding: 'ff'.repeat(32), scope: 'ab'.repeat(32) }],
      });
      case 'POST /api/accounts/acc_new/creation':
        if (opts.creationFails?.()) return json(502, { nothingWasSent: false, error: 'the node did not answer' });
        return json(201, { account: ACCOUNT, state: 'deploy-sent', txRef: 'tx' });
      case 'POST /api/accounts/acc_new/creation/finish': return json(200, opts.states?.finish ?? { account: ACCOUNT, state: 'finish-sent' });
      case 'GET /api/accounts/acc_new/creation': return json(200, opts.states?.standing ?? { account: ACCOUNT, state: 'finish-owed' });
      default: return json(404, { error: `no route for ${route}` });
    }
  }) as typeof fetch;
  return { sent: (route: string) => posted.filter((p) => p.route === route) };
}

const signIn = () => keyring.signedInByAnotherScreen({ user: A, address: ADDRESS, created: true, session: {} });

describe('THE FIRST PRESS', () => {
  it('MAKES THE COMPANY WITH THE KEY THE WALLET GAVE FOR ITS LABEL, BUILDS THE DEPLOY HELD BY IT, AND SENDS NOTHING', async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    const b = builder();
    expect(await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US)).toEqual({ accountId: 'acc_new', account: ACCOUNT });
    const drew = wallet.drew!;
    const key = { tag: 'schnorr', value: committeeKeyFor(identity, drew).value };
    /* RED WHEN: the service is not told the key that holds the account, or is told another one than the wallet gave for the label it drew. */
    expect(service.sent('POST /api/accounts')[0]!.body).toMatchObject({ companyLabel: drew, foundingKey: key });
    /* RED WHEN: the deploy is built from anything but the founding signer's seat as the service named it, the drawn label and that key. */
    expect(b.calls).toEqual([['deploy', { foundingLeaf: LEAF, label: drew, foundingKey: key }]]);
    /* RED WHEN: anything is sent before the wallet has signed the second step. */
    expect(service.sent('POST /api/accounts/acc_new/creation')).toEqual([]);
    expect(keyring.companyAwaitingItsSecondPress()).toEqual({ accountId: 'acc_new', account: ACCOUNT });
    expect(keyring.keysFor('acc_new')).not.toBeNull();
  });

  it('THE COMPANY STEP AS IT IS TODAY SENDS NO KEY, SO ON A CHAIN THE SERVICE REFUSES IT BY NAME', async () => {
    const service = aService();
    signIn();
    await keyring.createCompanyWithWallet(A_COMPANY, WALLET, new Wallet(), US);
    /* RED WHEN: the step the web app calls today starts sending a key, which only the two presses may. */
    expect(service.sent('POST /api/accounts')[0]!.body.foundingKey).toBeUndefined();
  });
});

describe('THE SECOND PRESS', () => {
  it('HAS THE WALLET SIGN THE STEP THAT FINISHES THE ACCOUNT, AND SENDS THE DEPLOY AND THAT STEP TOGETHER', async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    const b = builder();
    await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    const done = await keyring.signCompanyCreationFromTheWallet(WALLET, b, wallet, US);
    expect(done).toEqual({ accountId: 'acc_new', account: ACCOUNT, state: 'deploy-sent' });
    const asked = wallet.asks.find((a) => a.kind === 'creation')!.body as CreationRequest;
    /* RED WHEN: the wallet is asked about anything but this company, this account, this deploy and these keys. */
    expect(asked).toMatchObject({ company: wallet.drew, account: ACCOUNT, deploy: 'REVQTE9Z', insert: [{ circuit: 'payout', key: 'S0VZ' }] });
    /* RED WHEN: the second step is built with anything but the wallet's signature. */
    expect(b.calls[1]).toEqual(['insert', { account: ACCOUNT, signature: { tag: 'schnorr', value: '5a'.repeat(64) } }]);
    /* RED WHEN: the two are sent apart, or other bytes than were built go. */
    expect(service.sent('POST /api/accounts/acc_new/creation').map((p) => p.body)).toEqual([{ deploy: 'REVQTE9Z', insert: 'SU5TRVJU' }]);
    expect(keyring.companyAwaitingItsSecondPress()).toBeNull();
  });

  it('A SEND THAT DID NOT ARRIVE IS PRESSED AGAIN WITH THE SAME BYTES, AND THE WALLET IS NOT ASKED TWICE', async () => {
    let fail = true;
    const service = aService({ creationFails: () => fail });
    signIn();
    const wallet = new Wallet();
    const b = builder();
    await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, b, wallet, US);
    await expect(keyring.signCompanyCreationFromTheWallet(WALLET, b, wallet, US)).rejects.toThrow('the node did not answer');
    expect(keyring.companyAwaitingItsSecondPress()).toEqual({ accountId: 'acc_new', account: ACCOUNT });
    fail = false;
    await keyring.signCompanyCreationFromTheWallet(WALLET, b, wallet, US);
    /* RED WHEN: a retry asks the wallet again or rebuilds the second step, so the bytes sent the second time differ. */
    expect(wallet.asks.filter((a) => a.kind === 'creation')).toHaveLength(1);
    expect(b.calls.filter(([k]) => k === 'insert')).toHaveLength(1);
    const bodies = service.sent('POST /api/accounts/acc_new/creation').map((p) => p.body);
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
    expect(service.sent('POST /api/accounts/acc_new/creation')).toEqual([]);
  });

  it('IS REFUSED BY NAME WHEN THIS TAB HAS NO COMPANY WAITING FOR IT', async () => {
    aService();
    signIn();
    /* RED WHEN: a second press with nothing started reaches the wallet or the service. */
    await expect(keyring.signCompanyCreationFromTheWallet(WALLET, builder(), new Wallet(), US))
      .rejects.toThrow('there is no company waiting to be finished in this tab.');
  });
});

describe('FINISHING, AND READING WHETHER A COMPANY IS FINISHED', () => {
  it('FINISHING ASKS THE SERVICE TO SEND THE STEP IT RECORDED, AND BUILDS NOTHING', async () => {
    const service = aService();
    signIn();
    /* RED WHEN: finishing goes anywhere but the route that sends the recorded step. */
    expect(await keyring.finishCompanyOnTheChain('acc_new')).toEqual({ account: ACCOUNT, state: 'finish-sent' });
    expect(service.sent('POST /api/accounts/acc_new/creation/finish')).toHaveLength(1);
  });

  it('READS WHERE IT STANDS, AND A STATE THIS PAGE DOES NOT KNOW IS UNKNOWN, NEVER FINISHED', async () => {
    aService();
    signIn();
    const standing: { state: keyring.CompanyCreationState } = await keyring.companyCreationStanding('acc_new');
    expect(standing).toEqual({ account: ACCOUNT, state: 'finish-owed' });
    aService({ states: { standing: { account: null, state: 'done' } } });
    /* RED WHEN: a state the service did not name as one of the known ones is taken as it came. */
    expect(await keyring.companyCreationStanding('acc_new')).toEqual({ account: null, state: 'unknown' });
  });
});
