import { afterEach, describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { READY_PING } from 'midnight-identity/profile/channel';
import { parseAsk } from 'midnight-identity/profile/request';
import type { KeyringRequest } from 'midnight-identity/profile/request';
import { keyringKeyFor, keyringReleaseFor } from 'midnight-identity/profile/unlock';
import { seal, toHex, unseal } from '../../../src/core/crypto.js';
import { keyringAsk, KEYRING_PURPOSE } from '../../../src/core/wallet-unlock.js';
import * as keyring from './keyring.js';
import type { Openable } from './wallet-sign-in.js';

/**
 * **A SIGN-IN PICKED UP AFTER A RELOAD CAN CARRY ITS ADDRESS BACK.**
 *
 * A reloaded tab knows who is signed in but not the address the sign-in was
 * for. A screen that kept it hands it back, and the keyring takes it only for
 * the person the service says is signed in, so that person's first keys are
 * saved under the account holding that address with no second sign-in. Handed
 * nothing, the keyring is as it always was.
 *
 * The wallet at the other end is the wallet's own code answering over the real
 * conversation; the company is made by the first press, with a builder that
 * stands in for the worker.
 */
const US = 'https://payroll.example';
const WALLET = 'https://wallet.example';
const ADDRESS_A = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const ADDRESS_B = 'mn_addr_test1zzzzzzzzzzzzzzzzzzzz';
const A = { id: 'usr_a', email: null, name: 'Priya' };
const B = { id: 'usr_b', email: null, name: 'Sam' };
const identity = identityFromWords(TEST_MNEMONIC);

/** A wallet that gives the keyring key only for the address it holds, and records the address each ask named. */
class WalletAtTheOtherEnd implements Openable {
  readonly askedFor: (string | null)[] = [];
  private handler: ((event: MessageEvent) => void) | null = null;
  private readonly tab = { postMessage: (m: unknown) => this.onAsk(m) };
  constructor(private readonly holds: string) {}
  open(): Window | null { return this.tab as unknown as Window; }
  addEventListener(_t: 'message', h: (e: MessageEvent) => void): void {
    this.handler = h;
    queueMicrotask(() => this.deliver({ schema: READY_PING }));
  }
  removeEventListener(): void { this.handler = null; }
  setTimeout(): number { return 0; }
  clearTimeout(): void { /* nothing to clear */ }
  private deliver(data: unknown): void {
    this.handler?.({ origin: WALLET, source: this.tab, data } as unknown as MessageEvent);
  }
  private onAsk(message: unknown): void {
    let answer: unknown;
    try {
      const ask = parseAsk(message, US, Date.now());
      if (ask.kind === 'keyring') this.askedFor.push((ask as KeyringRequest).signedInAs ?? null);
      answer = ask.kind === 'keyring'
        ? keyringReleaseFor(identity, ask as KeyringRequest, Date.now(), (address) => address === this.holds)
        : { schema: 'a-sign-in' };
    } catch {
      answer = { schema: 'nothing-given' };
    }
    queueMicrotask(() => this.deliver(answer));
  }
}

/** The keyring key the wallet above gives `person`. */
const keyringHexFor = (person: string) => toHex(keyringKeyFor(identity, parseAsk(keyringAsk({
  name: 'n', rdns: 'r', purpose: KEYRING_PURPOSE, nonce: 'n', expiresAt: Date.now() + 60_000,
  person, signedInAs: null, company: null, account: null,
}), US, Date.now()) as KeyringRequest));

const LEAF = 'ab'.repeat(32);
const ACCOUNT = 'c0'.repeat(32);

/** What builds the account's deploy, standing in for the worker: the first press needs only the seat and the deploy. */
const aBuilder = (): keyring.AccountCreationBuilder => ({
  foundingSeat: async () => ({ seat: LEAF, scope: 'cd'.repeat(32), publicKey: 'ef'.repeat(32) }),
  accountDeploy: async () => ({ account: ACCOUNT, tx: 'REVQTE9Z', insert: [{ circuit: 'payout', key: 'S0VZ' }] }),
} as unknown as keyring.AccountCreationBuilder);

const A_COMPANY = { name: 'Acme Ltd', signers: [{ name: 'Priya', role: 'admin' as const }], threshold: 1 };
const answerFor = (user: typeof A, address: string) => ({ user, address, created: true, session: {} });

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; keyring.forgetLocally(); });

/** A service keeping each person's saved keys apart, by who the request says it is for. */
function aService(opts: { signedIn: () => typeof A }) {
  const posted: { route: string; as: string | null; body: any }[] = [];
  const saved = new Map<string, { bundle: unknown; version: number }>();
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = `${String(init?.method ?? 'GET')} ${url}`;
    const as = (init?.headers as Record<string, string> | undefined)?.['x-signed-in-as'] ?? null;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    posted.push({ route, as, body });
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    const who = opts.signedIn().id;
    const mine = saved.get(who) ?? { bundle: null, version: 0 };
    switch (route) {
      case 'GET /api/me': return json(200, { user: opts.signedIn(), accounts: [] });
      case 'GET /api/me/keys': return json(200, { keyBundle: mine.bundle, version: mine.version });
      case 'PUT /api/me/keys':
        saved.set(who, { bundle: body.keyBundle, version: mine.version + 1 });
        return json(200, { version: mine.version + 1 });
      case 'POST /api/accounts': return json(201, { account: { id: body.founding.account.id }, state: 'made' });
      default: return json(404, { error: `no route for ${route}` });
    }
  }) as typeof fetch;
  return {
    all: () => posted,
    sent: (route: string) => posted.filter((p) => p.route === route),
    savedFor: (person: string) => saved.get(person)?.bundle ?? null,
    replaceSaved: (person: string, bundle: unknown) => { saved.set(person, { bundle, version: (saved.get(person)?.version ?? 0) + 1 }); },
  };
}

/** The companies whose keys are in `bundle`, opened with `person`'s key. */
const companiesIn = (bundle: unknown, person: string): string[] =>
  Object.keys(JSON.parse(unseal(bundle as never, keyringHexFor(person))).accounts);

describe('a sign-in picked up after a reload', () => {
  /* RED WHEN: the address handed back is not taken, so a person with nothing saved must sign in again to create their first company; or it is taken from anywhere but what was handed back. */
  it('carries the address handed back, so a first company needs no second sign-in', async () => {
    const service = aService({ signedIn: () => A });
    expect(await keyring.resumeSession({ personId: A.id, address: ADDRESS_A })).toEqual(A);
    expect(keyring.signedInWallet()).toBe(ADDRESS_A);
    const wallet = new WalletAtTheOtherEnd(ADDRESS_A);
    const started = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, aBuilder(), wallet, US);
    expect(wallet.askedFor).toEqual([ADDRESS_A]);
    expect(companiesIn(service.savedFor(A.id), A.id)).toEqual([started.accountId]);
  });

  /* RED WHEN: an address kept for somebody else is taken for the person signed in now, so their first keys could be saved under an account they did not sign in with. */
  it('takes no address kept for somebody else, and saves nothing', async () => {
    const service = aService({ signedIn: () => A });
    expect(await keyring.resumeSession({ personId: B.id, address: ADDRESS_B })).toEqual(A);
    expect(keyring.signedInWallet()).toBeNull();
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, aBuilder(), new WalletAtTheOtherEnd(ADDRESS_B), US))
      .rejects.toBeInstanceOf(keyring.FirstKeysNeedTheSignIn);
    expect(service.sent('POST /api/accounts')).toEqual([]);
  });

  /* RED WHEN: a wallet that does not hold the address handed back gives the key a person's first keys are saved under. */
  it('saves nothing when the wallet answering does not hold the address handed back', async () => {
    const service = aService({ signedIn: () => A });
    await keyring.resumeSession({ personId: A.id, address: ADDRESS_A });
    const elsewhere = new WalletAtTheOtherEnd(ADDRESS_B);
    await expect(keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, aBuilder(), elsewhere, US)).rejects.toThrow();
    expect(elsewhere.askedFor).toEqual([ADDRESS_A]);
    expect(service.sent('POST /api/accounts')).toEqual([]);
    expect(service.sent('PUT /api/me/keys')).toEqual([]);
  });

  /* RED WHEN: picking a sign-in up with nothing handed back, as the legacy page does, starts taking an address from anywhere. */
  it('takes no address when nothing is handed back', async () => {
    aService({ signedIn: () => A });
    expect(await keyring.resumeSession()).toEqual(A);
    expect(keyring.signedInWallet()).toBeNull();
    for (const bad of [{ personId: A.id, address: '' }, { personId: '', address: ADDRESS_A }]) {
      keyring.forgetLocally();
      await keyring.resumeSession(bad);
      expect(keyring.signedInWallet()).toBeNull();
    }
  });
});

describe('what a person\'s devices once kept of each company\'s roster', () => {
  /* RED WHEN: what devices believed of a roster before is written into the saved keys again - kept where the service can serve it older. */
  it('is not written into their saved keys again: the anchor on chain is what a later read is held to', async () => {
    const service = aService({ signedIn: () => A });
    service.replaceSaved(A.id, seal(JSON.stringify({
      accounts: {}, rostersBelieved: { acc_old: { version: 3, digest: 'ab'.repeat(32), wallets: {} } },
    }), keyringHexFor(A.id) as never));
    keyring.signedInByAnotherScreen(answerFor(A, ADDRESS_A));
    await keyring.openKeysWithWallet(WALLET, new WalletAtTheOtherEnd(ADDRESS_A), US);
    const started = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, aBuilder(), new WalletAtTheOtherEnd(ADDRESS_A), US);
    const written = JSON.parse(unseal(service.savedFor(A.id) as never, keyringHexFor(A.id)));
    expect(Object.keys(written.accounts)).toEqual([started.accountId]);
    expect(written).not.toHaveProperty('rostersBelieved');
  });
});

describe('what a person\'s devices kept of each company they have not finished', () => {
  const kept = (accountId: string, name: string) => ({
    accountId, person: A.id, label: `co_${accountId.slice(-2).repeat(32)}`, foundingKey: { tag: 'schnorr', value: 'ab'.repeat(32) },
    request: { name, signers: [], threshold: 1, companyLabel: 'x', foundingKey: { tag: 'schnorr', value: 'ab'.repeat(32) }, founding: {} },
    made: true, deploy: null, signed: null, recorded: false,
  });
  const IN_KEYS = (creations: unknown, setAside?: unknown) =>
    seal(JSON.stringify({ accounts: {}, creations, ...(setAside === undefined ? {} : { creationsSetAside: setAside }) }), keyringHexFor(A.id) as never);

  /* RED WHEN: a kept creation whose request holds no readable name (kept by older code) is listed with no name although the creation's own sealed roster, opened with the person's own seat key, still holds it; or a blank name is given back as a name; or the name is taken from anywhere but the device. */
  it('reads the name of a kept creation whose request holds none from its own sealed roster, and gives back no blank', async () => {
    const service = aService({ signedIn: () => A });
    keyring.signedInByAnotherScreen(answerFor(A, ADDRESS_A));
    const wallet = new WalletAtTheOtherEnd(ADDRESS_A);
    const started = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, aBuilder(), wallet, US);
    const mine = JSON.parse(unseal(service.savedFor(A.id) as never, keyringHexFor(A.id)));
    for (const request of [{ ...mine.creations[started.accountId].request, name: undefined }, { ...mine.creations[started.accountId].request, name: '   ' }]) {
      const older = { ...mine, creations: { [started.accountId]: { ...mine.creations[started.accountId], request } } };
      service.replaceSaved(A.id, seal(JSON.stringify(older), keyringHexFor(A.id) as never));
      keyring.forgetLocally();
      keyring.signedInByAnotherScreen(answerFor(A, ADDRESS_A));
      await keyring.openKeysWithWallet(WALLET, new WalletAtTheOtherEnd(ADDRESS_A), US);
      expect(keyring.companyNameKeptHere(started.accountId)).toBe(A_COMPANY.name);
    }
    expect(keyring.companyNameKeptHere('acc_NOTKEPTHERE')).toBeNull();
  });

  /* RED WHEN: a creation kept apart as set aside is lost, or read as one being finished, when saved keys written before every creation was kept in one record are read; or the older field is written again. */
  it('reads the one kept and the one set aside of an older save into one record, losing neither, and writes it so', async () => {
    const service = aService({ signedIn: () => A });
    service.replaceSaved(A.id, IN_KEYS({ acc_AAAAAAAAAAAA: kept('acc_AAAAAAAAAAAA', 'Acme Ltd') }, { acc_BBBBBBBBBBBB: kept('acc_BBBBBBBBBBBB', 'Brick Ltd') }));
    keyring.signedInByAnotherScreen(answerFor(A, ADDRESS_A));
    await keyring.openKeysWithWallet(WALLET, new WalletAtTheOtherEnd(ADDRESS_A), US);
    expect(keyring.companiesBeingCreated()).toEqual(['acc_AAAAAAAAAAAA']);
    expect(keyring.companyNameKeptHere('acc_AAAAAAAAAAAA')).toBe('Acme Ltd');
    expect(keyring.companyNameKeptHere('acc_BBBBBBBBBBBB')).toBe('Brick Ltd');
    const started = await keyring.startCompanyHeldFromTheStart({ ...A_COMPANY, name: 'Third Ltd' }, WALLET, aBuilder(), new WalletAtTheOtherEnd(ADDRESS_A), US);
    const written = JSON.parse(unseal(service.savedFor(A.id) as never, keyringHexFor(A.id)));
    expect(Object.keys(written.creations).sort()).toEqual(['acc_AAAAAAAAAAAA', 'acc_BBBBBBBBBBBB', started.accountId].sort());
    expect(written.creations.acc_BBBBBBBBBBBB.setAside).toBe(true);
    expect(written.creations.acc_AAAAAAAAAAAA.setAside).toBeUndefined();
    expect(written).not.toHaveProperty('creationsSetAside');
  });

  /* RED WHEN: the same company in both fields of an older save loses the one that is further on. */
  it('keeps the one further on when the same company is in both fields of an older save', () => {
    const further = { ...kept('acc_AAAAAAAAAAAA', 'Acme Ltd'), recorded: true, signed: { tx: 'x', signature: { tag: 'schnorr', value: 'y' } }, deploy: { account: 'a', tx: 't', insert: [] } };
    const both = keyring.creationsInOneRecord({ accounts: {}, creations: { acc_AAAAAAAAAAAA: kept('acc_AAAAAAAAAAAA', 'Acme Ltd') } as never, creationsSetAside: { acc_AAAAAAAAAAAA: further } as never });
    expect(both.creations!.acc_AAAAAAAAAAAA).toEqual(further);
    expect(both).not.toHaveProperty('creationsSetAside');
  });

  /* RED WHEN: a company started in this tab replaces one another tab kept meanwhile, because the saved keys are not read again before the write. */
  it('reads the saved keys again before a new company is written, so a creation another tab kept is not lost', async () => {
    const service = aService({ signedIn: () => A });
    keyring.signedInByAnotherScreen(answerFor(A, ADDRESS_A));
    const wallet = new WalletAtTheOtherEnd(ADDRESS_A);
    const first = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, aBuilder(), wallet, US);
    const mine = JSON.parse(unseal(service.savedFor(A.id) as never, keyringHexFor(A.id)));
    const otherTabs = { ...mine, creations: { ...mine.creations, acc_CCCCCCCCCCCC: kept('acc_CCCCCCCCCCCC', 'Kept by another tab') } };
    service.replaceSaved(A.id, seal(JSON.stringify(otherTabs), keyringHexFor(A.id) as never));
    const second = await keyring.startCompanyHeldFromTheStart({ ...A_COMPANY, name: 'Second Ltd' }, WALLET, aBuilder(), wallet, US);
    const written = JSON.parse(unseal(service.savedFor(A.id) as never, keyringHexFor(A.id)));
    expect(Object.keys(written.creations).sort()).toEqual([first.accountId, 'acc_CCCCCCCCCCCC', second.accountId].sort());
  });
});
