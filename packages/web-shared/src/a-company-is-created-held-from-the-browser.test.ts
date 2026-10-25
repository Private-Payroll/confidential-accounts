import { afterEach, describe, expect, it, vi } from 'vitest';

/* Lets a test read the saved keys back in the shape an older build wrote them. Nothing is changed unless a test sets `rewrite`. */
const unsealing = vi.hoisted(() => ({ rewrite: null as null | ((plain: string) => string) }));
/* When set, the page is handed the wallet's answer as its reader checked it, with what the wallet founded the company with taken out. */
const answered = vi.hoisted(() => ({ withoutFounding: false }));
vi.mock('./wallet-unlock.js', async (original) => {
  const real = await original<typeof import('./wallet-unlock.js')>();
  return {
    ...real,
    askWalletForKeys: async (...a: Parameters<typeof real.askWalletForKeys>) => {
      const read = await real.askWalletForKeys(...a);
      return answered.withoutFounding ? { ...read, founding: null } : read;
    },
  };
});
vi.mock('../../../src/core/crypto.js', async (original) => {
  const real = await original<typeof import('../../../src/core/crypto.js')>();
  return { ...real, unseal: (...a: Parameters<typeof real.unseal>) => { const plain = real.unseal(...a); return unsealing.rewrite !== null && typeof plain === 'string' ? unsealing.rewrite(plain) : plain; } };
});
import { foundingStateRefusal } from '../../../src/core/founding-state.js';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { ACT_ENDED_SCHEMA, READY_PING } from 'midnight-identity/profile/channel';
import { parseAsk, type ActRequest, type HoldersRequest, type KeyringRequest } from 'midnight-identity/profile/request';
import { holdersAnswerFor, PAY_KEY_COMMITMENT_ENTRY, seatBarOf } from 'midnight-identity/profile/records-key';
import { keyringReleaseFor, type KeyringHandedIn } from 'midnight-identity/profile/unlock';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { seatKeysFor } from 'midnight-identity/profile/seat-keys';
import { x25519 } from '@noble/curves/ed25519.js';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { unwrapKey, unseal, parseCanonical, signingPublicKeyOf, toHex } from '../../../src/core/crypto.js';
import { openAccount, sealAccount } from '../../../src/core/account.js';
import { foundedAsTheWalletAnswers, keyringAsTheWalletAnswers, savedKeysSealKey } from '../../../src/testing/a-wallet-founds-a-company.js';
import { newSigningKeypair } from '../../../src/core/crypto.js';
import { signCompanyFiling, verifiedCompanyFiler } from '../../../src/midnight/sealed-record-wire.js';
import { NO_ROSTER_RECORD } from './roster-here.js';
import { secretCarried } from '../../../src/server/account-creation.js';
import * as keyring from './keyring.js';
import { openKeyring, sealKeyring, withCreation } from './keyring-blob.js';
import { storedSignerLeaf } from '../../../src/core/signer-leaf.js';
import { MidnightCommitments } from '../../../src/midnight/commitments.js';
import type { Openable } from './wallet-sign-in.js';
import { anchoredEntering } from '../../../src/testing/record-tree-double.js';
import { leavesOfTheContract } from '../../../src/testing/directory-seats.js';
import { seatBlinding } from '../../../src/core/seat-opening.js';

/**
 * **A COMPANY ON A CHAIN IS FOUNDED IN ITS FOUNDING SIGNER'S WALLET, IN ONE
 * PRESS, AND FINISHED THERE AS ONE ACTION, IN ANOTHER.**
 *
 * The first press has the wallet draw the label, make the founding seat from
 * its words, sign the founding roster and state and write the seat into the
 * saved keys it seals again; the page keeps those sealed keys and only then
 * sends the service what the company was founded with. No seat secret reaches
 * the page and nothing is sent to the chain. The second press is one action
 * the wallet runs whole (`finishCompanyInTheWallet`): the page hands it the
 * saved keys, keeps what it seals again, and sends each transaction where the
 * wallet says it goes.
 *
 * The wallet here founds a company as the wallet's own code does
 * (`apps/wallet/src/keyring/found-company.ts`, tested there with that code),
 * from the same parts: its words, the founding, and the saved keys sealed under
 * its key for the person.
 */
const US = 'https://payroll.example';
const WALLET = 'https://wallet.example';
const ADDRESS = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const A = { id: 'usr_a', email: null, name: 'Priya' };
const identity = identityFromWords(TEST_MNEMONIC);
const ACCOUNT = 'c0'.repeat(32);
const A_COMPANY = { name: 'Acme Ltd', signers: [{ name: 'Priya', role: 'admin' as const }], threshold: 1 };
const DEPLOY = 'REVQTE9Z';
const INSERT = 'SU5TRVJU';

/** The key a person's saved keys at this page are sealed under, as their wallet works it out. */
const savedKeysKey = (person: string): string =>
  (savedKeysSealKey(identity, { requester: { origin: US, name: 'x', rdns: 'x' }, person } as never));

class Wallet implements Openable {
  readonly asks: Array<{ kind: string; body: unknown }> = [];
  drew: CompanyLabel | null = null;
  /** The pay-record key commitment the wallet reads on each account, by address; an account not listed has none. */
  commits: Record<string, string> = {};
  /** While set, the wallet answers an ask for the account's holders with this refusal instead of a read. */
  refusesHolders: string | null = null;
  /** Whether the wallet's completed answers name the indexer it reads through. */
  namesIndexer = true;
  /* A wallet that starts a company without handing back what it founded it with. */
  givesNoFounding = false;
  /** Run while the wallet founds a company, before it answers. */
  whileFounding: (() => Promise<void>) | null = null;
  /** How an action the page asks for ends. */
  actEnds: Record<string, unknown> = { ended: 'done', step: 5, steps: 5, relayed: 0, unconfirmed: 0 };
  private handler: ((event: MessageEvent) => void) | null = null;
  private readonly tab = { postMessage: (m: unknown) => { void this.onAsk(m); } };
  open(): Window | null { return this.tab as unknown as Window; }
  addEventListener(_t: 'message', h: (e: MessageEvent) => void): void {
    this.handler = h;
    queueMicrotask(() => this.deliver({ schema: READY_PING }));
  }
  removeEventListener(): void { this.handler = null; }
  setTimeout(): number { return 0; }
  clearTimeout(): void { /* nothing to clear */ }
  /** Every message this wallet handed the page, in order. */
  readonly answered: unknown[] = [];
  private deliver(data: unknown): void { this.answered.push(data); this.handler?.({ origin: WALLET, source: this.tab, data } as unknown as MessageEvent); }
  private async onAsk(message: unknown): Promise<void> {
    let answer: unknown;
    try {
      const ask = parseAsk(message, US, Date.now());
      this.asks.push({ kind: ask.kind, body: ask });
      if (ask.kind === 'keyring') {
        const k = ask as KeyringRequest;
        if (k.drawLabel) {
          if (this.whileFounding !== null) await this.whileFounding();
          const founded = foundedAsTheWalletAnswers(identity, k, (a) => a === ADDRESS);
          this.drew = founded.company;
          answer = this.givesNoFounding ? keyringReleaseFor(identity, k, Date.now(), (a) => a === ADDRESS, () => founded.company!) : founded;
        } else {
          answer = keyringAsTheWalletAnswers(identity, k, (a) => a === ADDRESS);
        }
      } else if (ask.kind === 'act') {
        const a = ask as ActRequest;
        answer = { schema: ACT_ENDED_SCHEMA, nonce: a.nonce, intent: a.intent.name, ...this.actEnds };
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

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; keyring.forgetLocally(); unsealing.rewrite = null; answered.withoutFounding = false; });

/* The service the last test set up, so a creation can be put where the wallet would have put it. */
let current: { store: Map<string, { bundle: unknown; version: number }> } | null = null;
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
      case 'PUT /api/me/keys':
        /* As the service does: once saved keys exist, a write names the version it is written over. */
        if (saved.bundle !== null && body.ifVersion !== saved.version) return json(409, { error: 'your saved keys changed since they were read' });
        savedBy.set(as ?? '', { bundle: body.keyBundle, version: saved.version + 1 }); return json(200, { version: saved.version + 1 });
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
  current = { store: savedBy };
  return {
    store: savedBy,
    sent: (route: string) => posted.filter((p) => p.route.replace(/acc_[A-Za-z0-9_-]{12}/u, 'acc_X') === route),
    order,
    /** Every save of keys made on behalf of this person. */
    savesBy: (person: string) => posted.filter((p) => p.route === 'PUT /api/me/keys' && p.as === person),
  };
}

const signIn = () => keyring.signedInByAnotherScreen({ user: A, address: ADDRESS, created: true, session: {} });

/** The company the first press made, as the service was sent it. */
const madeOf = (service: ReturnType<typeof aService>) => service.sent('POST /api/accounts')[0]!.body;

/**
 * **WHAT THE WALLET'S ACTION KEEPS ONCE IT HAS SENT THE ACCOUNT**: the deploy and its signed second step, recorded,
 * written into the starter's saved keys as the wallet seals them, and read back by this tab.
 */
const plantSent = async (accountId: string, person = A.id): Promise<void> => {
  const saved = current!.store.get(person)!;
  const key = savedKeysKey(person);
  const held = openKeyring(saved.bundle as never, key as never);
  const c = held.creations![accountId]!;
  const at = Date.now();
  const next = withCreation(held, {
    ...c, made: true, recorded: true,
    deploy: { account: ACCOUNT as never, tx: DEPLOY, insert: [], builtAt: at },
    signed: { tx: INSERT, signature: { tag: 'schnorr', value: '5a'.repeat(64) }, builtAt: at },
  });
  const { sealed } = sealKeyring(next, key as never);
  current!.store.set(person, { bundle: sealed, version: saved.version + 1 });
  /* Read back as this tab reads saved keys: its wallet reads them for it. */
  await keyring.openKeysWithWallet(WALLET, new Wallet(), US);
};

/** The seat the starter's saved keys hold for a company, as only the wallet opens them; this test holds their key. */
const seatSavedFor = (accountId: string, person = A.id) => {
  const saved = current!.store.get(person)!;
  return openKeyring(saved.bundle as never, savedKeysKey(person) as never).accounts[accountId];
};

const reload = async (wallet: Wallet) => {
  keyring.forgetLocally();
  signIn();
  await keyring.openKeysWithWallet(WALLET, wallet, US);
};

const afterMinutes = (minutes: number): void => {
  const at = Date.now() + minutes * 60_000;
  vi.spyOn(Date, 'now').mockReturnValue(at);
};
afterEach(() => { vi.restoreAllMocks(); });

describe('THE FIRST PRESS', () => {
  it('HAS THE WALLET FOUND THE COMPANY FOR THE LABEL IT DREW, HELD BY ITS KEY FOR IT, AND BUILDS AND SENDS NOTHING TO THE CHAIN', async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    const started = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US);
    const made = madeOf(service);
    const drew = wallet.drew!;
    /* RED WHEN: the first press does not hand back the label the wallet drew, so the page cannot show the person the name their wallet gave the company. */
    expect(started).toEqual({ accountId: made.founding.account.id, label: drew });
    const key = { tag: 'schnorr', value: committeeKeyFor(identity, drew).value };
    /* RED WHEN: the service is not told the key that holds the account, or is told another one than the wallet gave for the label it drew. */
    expect(made).toMatchObject({ companyLabel: drew, foundingKey: key, name: 'Acme Ltd', threshold: 1 });
    /* RED WHEN: anything is sent to the chain, or any account is built, before the second press. */
    expect(service.sent('POST /api/accounts/acc_X/creation')).toEqual([]);
    expect(keyring.companyAwaitingItsSecondPress(started.accountId)).toEqual({ accountId: started.accountId, account: null });
    /* RED WHEN: the press opens more than the one window it always opened. */
    expect(wallet.asks.map((a) => a.kind)).toEqual(['keyring']);
  });

  it('HANDS THE WALLET THE COMPANY\'S NAMES AND THE SAVED KEYS, AND THE WALLET\'S ANSWER CARRIES NONE OF THE SEAT\'S SECRETS', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US);
    const ask = wallet.asks[0]!.body as KeyringRequest;
    /* RED WHEN: the wallet is not told what the company is called and who founds it, or is not handed the saved keys to keep the seat in. */
    expect(ask.founding).toEqual({ name: 'Acme Ltd', signer: { name: 'Priya', role: 'admin' } });
    expect(ask.keyring).toEqual({ sealed: null, version: 0 });
    /* RED WHEN: any part of the founding seat's keys is in anything the wallet handed the page. */
    const words = seatKeysFor(identity, wallet.drew!, 0);
    const handed = JSON.stringify(wallet.answered);
    for (const part of [words.signingSecret, words.wrappingSecret, words.salt]) {
      expect(handed).not.toContain(toHex(part));
      expect(handed).not.toContain(Buffer.from(part).toString('base64url'));
    }
  });

  it('KEEPS THE SAVED KEYS THE WALLET SEALED BEFORE ANYTHING IS SENT, OVER THE VERSION THE WALLET NAMED, AND SENDS NO SECRET', async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US);
    const made = madeOf(service);
    const id = made.founding.account.id as string;
    /* RED WHEN: the service is sent any secret, under any name, anywhere in the creation. */
    expect(secretCarried(made)).toBeNull();
    expect(Object.keys(made.founding).sort()).toEqual(['account', 'roster', 'seat', 'state']);
    /* RED WHEN: the first state is sent as anything but the record the founding seat signed for this company. */
    expect(foundingStateRefusal(made.founding.state, id, made.founding.seat.signingPublicKey)).toBeNull();
    /* RED WHEN: the company is sent before the saved keys holding its seat are kept, or the keys are written over another version. */
    expect(service.order.slice(0, 2)).toEqual(['PUT /api/me/keys', 'POST /api/accounts']);
    expect(service.sent('PUT /api/me/keys')[0]!.body.ifVersion).toBe(0);
    /* RED WHEN: the seat kept is not seat 0 of the wallet's words for the label it drew, so the words could not make it again. */
    const words = seatKeysFor(identity, wallet.drew!, 0);
    const mine = seatSavedFor(id)!;
    expect(mine.signingSecret).toBe(toHex(words.signingSecret));
    expect(made.founding.seat.signingPublicKey).toBe(signingPublicKeyOf(mine.signingSecret));
    expect(made.founding.seat.wrappingPublicKey).toBe(toHex(x25519.getPublicKey(words.wrappingSecret)));
    expect(mine.blinding).toBe(seatBlinding(made.foundingKey, toHex(words.salt)));
    expect(made.founding.seat.leaf).toBe(storedSignerLeaf({ signingSecret: mine.signingSecret, blinding: mine.blinding, scope: mine.scope as string }, MidnightCommitments).toLowerCase());
    /* RED WHEN: the viewing key is wrapped to anybody but this seat, or the signers are sent anywhere but in the first roster, signed by it. */
    const viewingKey = unwrapKey(made.founding.account.wrappedKeys[0], mine.wrappingSecret);
    expect(made.founding.account.sealedRoster).toBeUndefined();
    expect(verifiedCompanyFiler(made.founding.roster)).toBe(signingPublicKeyOf(mine.signingSecret));
    const opened = openAccount(made.founding.account, viewingKey, made.founding.roster);
    expect(opened.signers.map((x) => [x.id, x.userId, x.leafCommitment])).toEqual([[mine.signerId, A.id, made.founding.seat.leaf]]);
    const state = parseCanonical<{ blinding: Record<string, unknown> }>(unseal(made.founding.state.sealed, viewingKey));
    expect(Object.keys(state.blinding).sort()).toEqual(['assetBlinding', 'payRecordKey', 'payoutSeeds']);
  });

  it('A WALLET THAT STARTS A COMPANY WITHOUT WHAT IT FOUNDED IT WITH GETS NO COMPANY, AND THE PERSON IS TOLD TO START AGAIN', async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    wallet.givesNoFounding = true;
    /* RED WHEN: the wallet's answer with no founding is taken by the page's reader, so the page goes on without it. */
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US))
      .rejects.toThrow(/did not hand back what it founded the company with, so nothing was created\. Close the wallet's window, reload this page and start the company again\./u);
    expect(service.sent('POST /api/accounts')).toEqual([]);
    expect(service.sent('PUT /api/me/keys')).toEqual([]);
  });

  it('A FOUNDING HANDED NOTHING PAST THE READER IS REFUSED BY THE PAGE ITSELF, BEFORE ANYTHING IS KEPT OR SENT', async () => {
    const service = aService();
    signIn();
    answered.withoutFounding = true;
    /* RED WHEN: the page makes a founding of its own, or fails with something other than its own sentence, when it holds none for a new company. */
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, new Wallet(), US))
      .rejects.toThrow(/did not hand back what it founded it with, so nothing was created\. Close the wallet's window, reload this page and start the company again\./u);
    expect(service.sent('POST /api/accounts')).toEqual([]);
    expect(service.sent('PUT /api/me/keys')).toEqual([]);
  });

  it('SAVED KEYS THE SERVICE WOULD NOT KEEP MAKE NO COMPANY: NOTHING IS SENT', async () => {
    const service = aService({ refuses: { 'PUT /api/me/keys': () => ({ status: 409, body: { error: 'your saved keys changed since they were read' } }) } });
    signIn();
    /* RED WHEN: a company is sent whose founding seat is not in the saved keys the service keeps. */
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, new Wallet(), US)).rejects.toThrow(/were not kept by the service: they changed on another device since this page read them, or the service refused them\. Nothing was created/u);
    expect(service.sent('POST /api/accounts')).toEqual([]);
  });

  it('A COMPANY THE SERVICE DID NOT TAKE LEAVES ITS SEAT KEPT, AND NOTHING SENT TO THE CHAIN', async () => {
    const service = aService({ companyFails: () => true });
    signIn();
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, new Wallet(), US)).rejects.toThrow('the service did not answer');
    const id = madeOf(service).founding.account.id as string;
    /* RED WHEN: the seat is kept only once the service has answered. */
    expect(keyring.seatHeldHere(id)).not.toBeNull();
    expect(service.sent('POST /api/accounts/acc_X/creation')).toEqual([]);
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
      await expect(keyring.startCompanyHeldFromTheStart(spec, WALLET, wallet, US)).rejects.toThrow(/with you as its only signer/);
    }
    expect(wallet.asks).toEqual([]);
    expect(service.sent('POST /api/accounts')).toEqual([]);
  });
});

describe('THE SECOND PRESS IS ONE ACTION THE WALLET RUNS WHOLE', () => {
  it('ASKS THE WALLET ONCE, BY INTENT, FOR THE COMPANY\'S LABEL, HANDING IT THE PERSON AND THE SAVED KEYS, AND NO BYTES', async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    const { accountId, label } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US);
    const ended = await keyring.finishCompanyInTheWallet(accountId, WALLET, {}, wallet, US);
    expect(ended).toEqual({ of: 'done', steps: 5, relayed: 0 });
    const asks = wallet.asks.filter((a) => a.kind === 'act');
    /* RED WHEN: the press asks the wallet for more than one action, or names anything but the company's label. */
    expect(asks).toHaveLength(1);
    const ask = asks[0]!.body as ActRequest;
    expect(ask.intent).toEqual({ name: 'finish-company', fields: { company: label } });
    /* RED WHEN: the wallet is not handed the saved keys the service holds now, so it would act on an older copy. */
    const saved = service.store.get(A.id)!;
    expect(ask.person).toBe(A.id);
    expect(ask.keyring as KeyringHandedIn).toEqual({ sealed: saved.bundle, version: saved.version });
    /* RED WHEN: the page builds, proves or sends anything itself. */
    expect(service.sent('POST /api/accounts/acc_X/creation')).toEqual([]);
  });

  it('HANDS BACK WHERE THE WALLET STOPPED, FOR THE NEXT PRESS TO CARRY ON FROM', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    wallet.actEnds = { ended: 'stopped', step: 3, steps: 5, relayed: 2, unconfirmed: 0, why: 'stopped' };
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US);
    /* RED WHEN: a stopped action is taken as done, or its step is lost. */
    expect(await keyring.finishCompanyInTheWallet(accountId, WALLET, {}, wallet, US)).toEqual(expect.objectContaining({ of: 'stopped', step: 3, steps: 5 }));
  });

  it('IS REFUSED BY NAME FOR A COMPANY NOT KEPT HERE, OR ONE SOMEBODY ELSE STARTED', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    /* RED WHEN: a tab the wallet has not read for asks the wallet about a company the service does not name. */
    await expect(keyring.finishCompanyInTheWallet('acc_AAAAAAAAAAAA', WALLET, {}, wallet, US)).rejects.toThrow();
    expect(wallet.asks).toEqual([]);
    await keyring.openKeysWithWallet(WALLET, wallet, US);
    const asked = wallet.asks.length;
    /* RED WHEN: the wallet is opened for a company a tab it read the saved keys for keeps nothing of. */
    await expect(keyring.finishCompanyInTheWallet('acc_AAAAAAAAAAAA', WALLET, {}, wallet, US)).rejects.toBeInstanceOf(keyring.NoCreationKeptHere);
    expect(wallet.asks).toHaveLength(asked);
  });
});

describe('EACH TRANSACTION THE WALLET HANDS BACK GOES WHERE THE WALLET SAYS IT GOES, AND NOWHERE ELSE', () => {
  const kept = async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US);
    return { service, accountId };
  };

  it('SENDS THE ACCOUNT\'S DEPLOY AND ITS SECOND STEP TOGETHER, AND EACH LATER STEP TO ITS OWN ROUTE', async () => {
    const states: Record<string, unknown> = { standing: { account: null, state: 'not-created', replaceable: false } };
    const service = aService({ states });
    signIn();
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, new Wallet(), US);
    const relay = (tx: string, what: string, also?: string) => keyring.relayForTheCreation(accountId, tx, { what, ...(also === undefined ? {} : { also }) });
    expect(await relay(DEPLOY, 'creation', INSERT)).toBe(true);
    expect(service.sent('POST /api/accounts/acc_X/creation').map((p) => p.body)).toEqual([{ deploy: DEPLOY, insert: INSERT }]);
    states['standing'] = { account: ACCOUNT, state: 'deploy-expired', replaceable: true };
    expect(await relay('QUdBSU4=', 'creation-again', 'SU5BR0FJTg==')).toBe(true);
    expect(service.sent('POST /api/accounts/acc_X/creation/again').map((p) => p.body)).toEqual([{ deploy: 'QUdBSU4=', insert: 'SU5BR0FJTg==' }]);
    expect(await relay(INSERT, 'creation-finish')).toBe(true);
    expect(service.sent('POST /api/accounts/acc_X/creation/finish').map((p) => p.body)).toEqual([{ insert: INSERT }]);
    const payKeySteps: Array<[what: string, call: string]> = [['pay-key-propose', 'propose'], ['pay-key-approve', 'approve'], ['pay-key-seal', 'sealPayKey']];
    for (const [what, call] of payKeySteps) {
      expect(await relay(`VFgt${call.length}`.padEnd(8, 'A'), what)).toBe(true);
    }
    /* RED WHEN: a pay-record key step is sent as another call than the wallet named. */
    expect(service.sent('POST /api/accounts/acc_X/creation/pay-key').map((p) => p.body.call)).toEqual(['propose', 'approve', 'sealPayKey']);
  });

  it('A CREATION GOES WHERE THE SERVICE HOLDS IT, WHATEVER THE WALLET CALLS IT: A DEPLOY CARRIED AGAIN AFTER A RELAY ANSWERED LATE IS NEVER REFUSED AS ANOTHER ACCOUNT', async () => {
    /*
     * RED WHEN: a deploy carried again after a first relay the service did record goes to the first creation, which
     * refuses other bytes for good; or one the service never recorded goes to be carried again, which it refuses too.
     */
    const states: Record<string, unknown> = {};
    const service = aService({ states });
    signIn();
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, new Wallet(), US);
    const where = async (what: string, standing: Record<string, unknown>): Promise<string> => {
      states['standing'] = standing;
      const before = service.order.length;
      expect(await keyring.relayForTheCreation(accountId, DEPLOY, { what, also: INSERT })).toBe(true);
      return service.order.slice(before).filter((r) => r.startsWith('POST'))[0]!;
    };
    expect(await where('creation-again', { account: null, state: 'not-created', replaceable: false })).toBe('POST /api/accounts/acc_X/creation');
    expect(await where('creation', { account: ACCOUNT, state: 'deploy-sent', replaceable: true })).toBe('POST /api/accounts/acc_X/creation/again');
    expect(await where('creation', { account: ACCOUNT, state: 'deploy-expired', replaceable: true })).toBe('POST /api/accounts/acc_X/creation/again');
    expect(await where('creation-again', { account: ACCOUNT, state: 'deploy-sent', replaceable: false })).toBe('POST /api/accounts/acc_X/creation');
  });

  it('REFUSES A TRANSACTION FOR NOTHING IT KNOWS, OR A DEPLOY WITHOUT ITS SECOND STEP, AND SENDS NOTHING', async () => {
    const { service, accountId } = await kept();
    /* RED WHEN: the page guesses where a transaction goes. */
    expect(await keyring.relayForTheCreation(accountId, DEPLOY, { what: 'transfer' })).toBe(false);
    expect(await keyring.relayForTheCreation(accountId, DEPLOY, {})).toBe(false);
    expect(await keyring.relayForTheCreation(accountId, DEPLOY, { what: 'creation' })).toBe(false);
    expect(service.order.filter((r) => r.startsWith('POST /api/accounts/acc_X'))).toEqual([]);
  });

  it('TELLS THE SERVICE OF THE COMPANY FIRST WHEN IT NEVER TOOK IT, THEN SENDS THE ACCOUNT', async () => {
    let fail = true;
    let held = false;
    /* As the service answers: no creation route for a company it never took. */
    const service = aService({ companyFails: () => { if (fail) return true; held = true; return false; }, noRecord: () => !held });
    signIn();
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, new Wallet(), US)).rejects.toThrow('the service did not answer');
    const [stuck] = keyring.companiesBeingCreated();
    fail = false;
    /* RED WHEN: the account is sent for a company the service has no record of, which it refuses. */
    expect(await keyring.relayForTheCreation(stuck!, DEPLOY, { what: 'creation', also: INSERT })).toBe(true);
    expect(service.order.filter((r) => r.startsWith('POST'))).toEqual(['POST /api/accounts', 'POST /api/accounts', 'POST /api/accounts/acc_X/creation']);
  });

  it('DOES NOT SEND THE SECOND STEP AGAIN WHEN THE SERVICE ALREADY HAS IT: A STOPPED ACTION TAKEN UP AGAIN CARRIES ON', async () => {
    const states: Record<string, unknown> = { standing: { account: ACCOUNT, state: 'finish-sent' } };
    const service = aService({ states });
    signIn();
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, new Wallet(), US);
    /* RED WHEN: a second step already with the service is sent again, which it refuses and so stops the action. */
    expect(await keyring.relayForTheCreation(accountId, INSERT, { what: 'creation-finish' })).toBe(true);
    expect(service.sent('POST /api/accounts/acc_X/creation/finish')).toEqual([]);
    states['standing'] = { account: ACCOUNT, state: 'finish-owed' };
    expect(await keyring.relayForTheCreation(accountId, INSERT, { what: 'creation-finish' })).toBe(true);
    expect(service.sent('POST /api/accounts/acc_X/creation/finish')).toHaveLength(1);
  });
});

describe('ANY NUMBER OF COMPANIES ARE KEPT, EACH ON ITS OWN, AND NONE STOPS ANOTHER FROM BEING STARTED', () => {
  const OTHER = { ...A_COMPANY, name: 'Other Ltd' };

  /* RED WHEN: starting another company while this browser keeps one is refused, or replaces the one kept, before or after the keys open. */
  it('KEEPS EVERY ONE WHEN ANOTHER IS STARTED, WITH THE KEYS OPEN AND WITH THEM SHUT', async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    const first = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US);
    const second = await keyring.startCompanyHeldFromTheStart(OTHER, WALLET, wallet, US);
    expect(second.accountId).not.toBe(first.accountId);
    expect(keyring.companiesBeingCreated()).toEqual([first.accountId, second.accountId]);
    expect(service.sent('POST /api/accounts')).toHaveLength(2);
    keyring.forgetLocally();
    signIn();
    expect(keyring.canOpenCompanies()).toBe(false);
    const third = await keyring.startCompanyHeldFromTheStart({ ...A_COMPANY, name: 'Third Ltd' }, WALLET, wallet, US);
    /* RED WHEN: a creation started with the keys shut replaces what the saved keys already hold: the wallet seals over the newest copy. */
    expect(keyring.companiesBeingCreated()).toEqual([first.accountId, second.accountId, third.accountId]);
    expect([first, second, third].map((c) => keyring.companyNameKeptHere(c.accountId))).toEqual(['Acme Ltd', 'Other Ltd', 'Third Ltd']);
    /* RED WHEN: a reload loses a creation, or finds it under another company. */
    await reload(wallet);
    expect(keyring.companiesBeingCreated()).toEqual([first.accountId, second.accountId, third.accountId]);
    for (const c of [first, second, third]) expect(keyring.companyAwaitingItsSecondPress(c.accountId)).toEqual({ accountId: c.accountId, account: null });
    for (const c of [first, second, third]) expect(keyring.seatHeldHere(c.accountId)).not.toBeNull();
  });

  /* RED WHEN: starting one creation again drops, changes or sets aside another one, or one from which nothing was sent is not dropped alone. */
  it('STARTING ONE AGAIN LEAVES THE OTHER EXACTLY AS IT WAS', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    const first = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US);
    const second = await keyring.startCompanyHeldFromTheStart(OTHER, WALLET, wallet, US);
    await plantSent(second.accountId);
    expect(await keyring.startAnUnfinishedCreationAgain(first.accountId, WALLET, null, wallet, US)).toEqual({ of: 'dropped' });
    expect(keyring.companiesBeingCreated()).toEqual([second.accountId]);
    expect(keyring.companyNameKeptHere(second.accountId)).toBe('Other Ltd');
    expect(keyring.companyAwaitingItsSecondPress(second.accountId)).toEqual({ accountId: second.accountId, account: ACCOUNT });
    expect(keyring.seatHeldHere(first.accountId)).not.toBeNull();
    expect(keyring.seatHeldHere(second.accountId)).not.toBeNull();
    /* RED WHEN: the sent creation is dropped by the start again of the other, without its own chain read. */
    await expect(keyring.forgetAnUnsentCreation(second.accountId)).rejects.toThrow(/signed or sent/);
    expect(keyring.companiesBeingCreated()).toEqual([second.accountId]);
  });

  /* RED WHEN: a creation that fails to send leaves the next company unable to start, or no longer kept beside it. */
  it('KEEPS A CREATION WHOSE SEND FAILED BESIDE THE ONE STARTED AFTER IT', async () => {
    let fail = true;
    aService({ companyFails: () => fail });
    signIn();
    const wallet = new Wallet();
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US)).rejects.toThrow('the service did not answer');
    const [stuck] = keyring.companiesBeingCreated();
    fail = false;
    const next = await keyring.startCompanyHeldFromTheStart(OTHER, WALLET, wallet, US);
    expect(keyring.companiesBeingCreated()).toEqual([stuck, next.accountId]);
  });
});

describe('A CREATION FROM WHICH NOTHING REACHED THE CHAIN CAN BE STARTED AGAIN, AND ONLY SUCH A ONE', () => {
  it('FORGETS A KEPT CREATION NOTHING WAS SENT FOR, SO THE FIRST PRESS MAKES A NEW COMPANY, AND KEEPS THE FORGOTTEN COMPANY\'S KEYS', async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    const { accountId: id } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US);
    await keyring.forgetAnUnsentCreation(id);
    /* RED WHEN: the creation is still kept after it is forgotten, so Create stays shut. */
    expect(keyring.companiesBeingCreated()).toEqual([]);
    /* RED WHEN: forgetting the creation also drops the seat's keys of a company the service already lists. */
    const secretOfTheFirst = seatSavedFor(id)!.signingSecret;
    const again = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US);
    expect(again.accountId).not.toBe(id);
    expect(service.sent('POST /api/accounts')).toHaveLength(2);
    /* RED WHEN: a new company's seat is sealed over the seats this person already holds instead of beside them. */
    expect(seatSavedFor(id)?.signingSecret).toBe(secretOfTheFirst);
    expect(keyring.seatHeldHere(again.accountId)).not.toBeNull();
    await reload(wallet);
    expect(seatSavedFor(id)?.signingSecret).toBe(secretOfTheFirst);
    expect(keyring.seatHeldHere(again.accountId)).not.toBeNull();
  });

  it('REFUSES TO FORGET ONE WHOSE ACCOUNT WAS SENT, KEEPING IT', async () => {
    aService();
    signIn();
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, new Wallet(), US);
    await plantSent(accountId);
    /* RED WHEN: a creation already sent to the chain is forgotten, so it can never be carried on or finished. */
    await expect(keyring.forgetAnUnsentCreation(accountId)).rejects.toThrow(/signed or sent/);
    expect(keyring.companiesBeingCreated()).toEqual([accountId]);
  });

  it('REFUSES A COMPANY THIS TAB KEEPS NO CREATION OF', async () => {
    aService();
    signIn();
    /* RED WHEN: forgetting a company that is not kept here is taken as done. */
    await expect(keyring.forgetAnUnsentCreation('acc_AAAAAAAAAAAA')).rejects.toThrow(/keeps no creation/);
  });
});

describe('A COMPANY BEING CREATED IS WRITTEN ONLY INTO THE SAVED KEYS OF WHOEVER STARTED IT', () => {
  const B = { id: 'usr_b', email: null, name: 'Sam' };
  /** Somebody else is signed in on this tab by another screen and opens their own saved keys. */
  const somebodyElseSignsIn = async () => {
    keyring.signedInByAnotherScreen({ user: B, address: ADDRESS, created: true, session: {} });
    await keyring.openKeysWithWallet(WALLET, new Wallet(), US);
  };

  it('KEEPS NONE OF WHAT THE WALLET SEALED FOR THE STARTER IN THE KEYS OF SOMEBODY WHO SIGNS IN WHILE THE WALLET FOUNDS IT', async () => {
    const service = aService();
    signIn();
    const wallet = new Wallet();
    wallet.whileFounding = somebodyElseSignsIn;
    /* RED WHEN: the saved keys the wallet sealed for the starter are written as whoever is signed in by then, over their own. */
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US)).rejects.toThrow();
    expect(service.savesBy(B.id)).toEqual([]);
    expect(service.savesBy(A.id)).toEqual([]);
    expect(service.sent('POST /api/accounts')).toEqual([]);
  });

  it('LEAVES THE KEYS OF SOMEBODY WHO SIGNS IN WHILE THE COMPANY IS SENT UNTOUCHED, SO THEY CAN CREATE THEIR OWN', async () => {
    const service = aService({ during: { route: 'POST /api/accounts', run: somebodyElseSignsIn } });
    signIn();
    /* RED WHEN: the kept creation is written after the service answered into whoever's keys the tab holds then, leaving them holding a company that is not theirs. */
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, new Wallet(), US)).rejects.toBeInstanceOf(keyring.CompanyStartedBySomebodyElse);
    expect(service.savesBy(B.id)).toEqual([]);
    expect(keyring.companiesBeingCreated()).toEqual([]);
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
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US)).rejects.toThrow('the service did not answer');
    const id = keyring.companiesBeingCreated()[0]!;
    expect(await keyring.companyCreationStanding(id)).toEqual({ account: null, state: 'not-created' });
    await expect(keyring.companyCreationStanding('acc_AAAAAAAAAAAA')).rejects.toBeInstanceOf(keyring.NotOnTheService);
    await keyring.forgetAnUnsentCreation(id);
    expect(keyring.companiesBeingCreated()).toEqual([]);
  });
});


describe('THE LABEL THE WALLET DREW IS KEPT WITH THE CREATION, FOR THE SCREEN AFTER THE FIRST PRESS', () => {
  it('IS THE KEPT CREATION\'S OWN LABEL FOR ITS COMPANY, AND NOBODY\'S ELSE', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    const started = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US);
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
    const started = await keyring.startCompanyHeldFromTheStart({ ...A_COMPANY, name: 'Test-001' }, WALLET, wallet, US);
    /* RED WHEN: a company kept here and not finished is not given the name the person typed for it. */
    expect(keyring.companyNameKeptHere(started.accountId)).toBe('Test-001');
    /* RED WHEN: another company is given the kept creation's name. */
    expect(keyring.companyNameKeptHere('acc_AAAAAAAAAAAA')).toBeNull();
  });
});


describe('A FINISHED COMPANY\'S KEPT CREATION IS FORGOTTEN ONLY ON THE WALLET\'S OWN READ OF THE KEPT ACCOUNT, AND ITS KEYS KEPT', () => {
  const COMMITTED = 'c1'.repeat(32);
  const OTHER_ACCOUNT = '0b'.repeat(32);
  const sentAndKept = async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US);
    await plantSent(keyring.companiesBeingCreated()[0]!);
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
    expect(keyring.seatHeldHere(accountId)).not.toBeNull();
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
    expect(holdersAsks(wallet).map((a) => a.account)).toEqual([ACCOUNT]);
    expect(await keyring.keptCreationShowsItsKeyCommitted(accountId, WALLET, wallet, US)).toBe(false);
  });

  it('KEEPS A CREATION THAT BUILT NO DEPLOY WITHOUT ASKING THE WALLET, AND READS NOTHING FOR A COMPANY NOT KEPT', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US);
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
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US);
    keyring.forgetLocally();
    signIn();
    expect(keyring.canOpenCompanies()).toBe(false);
    expect(keyring.companiesBeingCreated()).toEqual([]);
    const posted = service.sent('POST /api/accounts').length;
    const writes = service.sent('PUT /api/me/keys').length;
    const second = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US);
    expect(service.sent('POST /api/accounts')).toHaveLength(posted + 1);
    expect(service.sent('PUT /api/me/keys').length).toBeGreaterThan(writes);
    expect(keyring.companiesBeingCreated()).toEqual([accountId, second.accountId]);
  });
});


describe('THE COMPANY\'S SIGNERS ARE READ ON THIS DEVICE FROM ITS ROSTER RECORD ONLY', () => {
  /** The company the first press made, as the service serves it once the account is deployed, with its first roster beside it. */
  const servedAfterTheFirstPress = async () => {
    const service = aService();
    signIn();
    await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, new Wallet(), US);
    const made = madeOf(service);
    return { made, served: { ...made.founding.account, contractAddress: ACCOUNT, roster: made.founding.roster } };
  };
  /** Who holds the account, as the founding signer's own wallet reads it: their seat, and the key the deploy held it by. */
  const holders = (leaf: string) => async () => ({
    committee: [{ tag: 'schnorr', value: '11'.repeat(32) }], threshold: 1, seats: [leaf], approvals: 1, adoptedVaults: [],
    founding: leaf, foundingCommittee: [{ tag: 'schnorr', value: '11'.repeat(32) }], account: ACCOUNT,
  }) as never;

  it('THE FOUNDING SIGNER\'S DEVICE READS THE FIRST ROSTER ON ITS OWN SIGNING KEY, BEFORE ITS DIRECTORY ENTRY IS FILED', async () => {
    const { made, served } = await servedAfterTheFirstPress();
    const opened = await keyring.openAccount(served, holders(made.founding.seat.leaf), (id) => anchoredEntering(id), () => leavesOfTheContract);
    /* RED WHEN: the founding signer cannot read their own company before their entry is filed - they could then never set up their vault keys. */
    expect(opened?.signers.map((x) => [x.id, x.leafCommitment])).toEqual([[made.founding.seat.signerId, made.founding.seat.leaf]]);
    expect(opened?.name).toBe('Acme Ltd');
    /* RED WHEN: the company opened is handed back without the entries this device refused and why, so no screen can say it. */
    expect(opened?.refused).toEqual([]);
  });

  it('A COMPANY WITH NO ROSTER RECORD IS REFUSED WITH THE FIXED SENTENCE, AND THE LIST ON ITS ACCOUNT RECORD IS NEVER READ', async () => {
    const { made, served } = await servedAfterTheFirstPress();
    const viewingKey = unwrapKey(made.founding.account.wrappedKeys[0], seatSavedFor(made.founding.account.id)!.wrappingSecret);
    const { roster: _filed, ...withoutIt } = served;
    /* The signers as an account record carried them before they were a record: a list that opens with the company's key. */
    const unsigned = sealAccount(openAccount(made.founding.account, viewingKey, made.founding.roster), viewingKey, []).sealedRoster!;
    /* RED WHEN: a device reads a company's signers from anything but a roster record a seat signed. */
    await expect(keyring.openAccount({ ...withoutIt, sealedRoster: unsigned }, holders(made.founding.seat.leaf), (id) => anchoredEntering(id), () => leavesOfTheContract)).rejects.toThrow(NO_ROSTER_RECORD);
    await expect(keyring.openAccount(withoutIt, holders(made.founding.seat.leaf), (id) => anchoredEntering(id), () => leavesOfTheContract)).rejects.toThrow(NO_ROSTER_RECORD);
  });

  it('A FIRST ROSTER NOT SIGNED BY THE FOUNDING SEAT IS REFUSED', async () => {
    const { made, served } = await servedAfterTheFirstPress();
    const { filedBy: _was, ...unsigned } = served.roster;
    const another = signCompanyFiling(unsigned, newSigningKeypair().secret);
    /* RED WHEN: a first roster signed by a key other than this device's own, with no founding entry to hold it to, is believed. */
    await expect(keyring.openAccount({ ...served, roster: another }, holders(made.founding.seat.leaf), (id) => anchoredEntering(id), () => leavesOfTheContract)).rejects.toThrow(/does not believe the company's roster/u);
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
    await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, new Wallet(), US);
    const id = madeOf(service).founding.account.id as string;
    const signed = { committeeKey: { tag: 'schnorr', value: 'aa'.repeat(32) }, entry: { seat: 'ab'.repeat(32) } } as never;
    /* RED WHEN: this page writes an owed directory entry into the saved keys. */
    await expect(keyring.oweDirectoryEntry(id, { person: A.id, company: A_COMPANY as never, signed })).rejects.toThrow(/no longer writes your saved keys/u);
    const inviter = { committeeKey: { tag: 'schnorr', value: 'bb'.repeat(32) }, statement: { seat: 'cc'.repeat(32) }, opening: { salt: 'dd'.repeat(32) } } as never;
    const invited = { terms: { person: A.id, leaf: 'ab'.repeat(32) }, signedBy: 'ee'.repeat(32), signature: 'ff'.repeat(64) } as never;
    /* RED WHEN: this page writes a re-issued invitation into the saved keys, which only the wallet changes now. */
    await expect(keyring.keepTheReissuedInvitation(id, { inviter, invited })).rejects.toThrow(/no longer writes your saved keys/u);
    expect([seatSavedFor(id)!.invitedBy, seatSavedFor(id)!.invited]).toEqual([undefined, undefined]);
    expect(service.savesBy(A.id)).toHaveLength(1);
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
    const asked: Array<{ account: string; indexer: unknown; transactions: string[] }> = [];
    const withPresence: keyring.AccountCreationBuilder = { accountPresence: async (input: { account: string; indexer: unknown; transactions: string[] }) => {
      asked.push(input);
      if (seen instanceof Error) throw seen;
      return seen;
    } };
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US);
    await plantSent(accountId);
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
    const { accountId } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, wallet, US);
    /* RED WHEN: a creation nothing was signed for cannot be started again, which is how the first press stays refused. */
    expect(await again(accountId, wallet, null)).toEqual({ of: 'dropped' });
    expect(keyring.companiesBeingCreated()).toEqual([]);
    expect(keyring.seatHeldHere(accountId)).not.toBeNull();
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
    expect(keyring.seatHeldHere(accountId)).not.toBeNull();
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
    void service;
    expect(await keyring.takeUpACreationSetAside(accountId)).toBe(true);
    expect(keyring.companiesBeingCreated()).toEqual([accountId]);
  });

  it('LEAVES A CREATION SET ASIDE ALONE WHILE ITS DEPLOY IS NOT ON THE CHAIN, AND TAKES IT UP BESIDE ANOTHER WITHOUT TOUCHING THAT ONE', async () => {
    const { states, accountId, wallet, b } = await sentWith(deploying, absentAt(TTL + FIVE));
    await walletCannotRead(wallet, accountId);
    expect(await again(accountId, wallet, b)).toEqual({ of: 'dropped' });
    /* RED WHEN: a creation set aside is taken up while the service reads its deploy as not landed. */
    expect(await keyring.takeUpACreationSetAside('acc_AAAAAAAAAAAA')).toBe(false);
    await keyring.startCompanyHeldFromTheStart({ ...A_COMPANY, name: 'Other Ltd' }, WALLET, wallet, US);
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
    const other = await keyring.startCompanyHeldFromTheStart({ ...A_COMPANY, name: 'Other Ltd' }, WALLET, wallet, US);
    /* RED WHEN: starting one again sets aside, drops or changes the other creation. */
    expect(await again(accountId, wallet, b)).toEqual({ of: 'dropped' });
    expect(keyring.companiesBeingCreated()).toEqual([other.accountId]);
    expect(keyring.companyAwaitingItsSecondPress(other.accountId)).toEqual({ accountId: other.accountId, account: null });
    expect(keyring.companyNameKeptHere(accountId)).toBe(A_COMPANY.name);
    expect(keyring.companyBeingCreatedLabel(accountId)).toBeNull();
    /* RED WHEN: the change this tab asked for is not carried in its next ask, or the wallet does not make it. */
    await keyring.openKeysWithWallet(WALLET, wallet, US);
    expect(keyring.companiesBeingCreated()).toEqual([other.accountId]);
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
    expect(await keyring.takeUpACreationSetAside(accountId)).toBe(true);
    expect(keyring.companiesBeingCreated().sort()).toEqual([accountId, other.accountId].sort());
  });

  it('NEVER DROPS A SIGNED CREATION BECAUSE ANOTHER ONE WAS STARTED AGAIN: EACH IS READ ON THE CHAIN FOR ITSELF', async () => {
    const { accountId, wallet, b } = await sentWith(deploying, absentAt(TTL + FIVE - 1));
    await walletCannotRead(wallet, accountId);
    const other = await keyring.startCompanyHeldFromTheStart({ ...A_COMPANY, name: 'Other Ltd' }, WALLET, wallet, US);
    /* RED WHEN: starting the unsent one again clears the sent one with it, or the sent one is dropped without its own chain read. */
    expect(await again(other.accountId, wallet, b)).toEqual({ of: 'dropped' });
    expect(keyring.companiesBeingCreated()).toEqual([accountId]);
    expect(await again(accountId, wallet, b)).toEqual({ of: 'may-still-land', minutes: 1 });
    expect(keyring.companiesBeingCreated()).toEqual([accountId]);
    expect(keyring.seatHeldHere(other.accountId)).not.toBeNull();
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
