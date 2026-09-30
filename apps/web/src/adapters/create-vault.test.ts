// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newSigningKeypair, type Hex } from '../../../../src/core/crypto.js';
import { signVaultKeys } from '../../../../src/core/vault-keys.js';

/*
 * CREATING A VAULT THROUGH THE ADAPTER, WITH THE SHARED OPERATION RUNNING AS
 * IT IS. The keyring, the service, this browser's store for the temporary key
 * and the part of the page that builds vault transactions are stood in for;
 * `createCompanyVault` and the company's vault routes, with their checks
 * against the roster, are the shared code's own.
 */
const K = (n: number) => ({ tag: 'schnorr', value: n.toString(16).padStart(2, '0').repeat(32) });
const SIGNER = newSigningKeypair();
const COMPANY = 'c0'.repeat(32);
const VAULT = 'ab'.repeat(32);
const kr = vi.hoisted(() => ({
  log: [] as string[],
  answers: {} as Record<string, unknown>,
  keys: { signerId: 's1', signingSecret: 'aa', wrappingSecret: 'bb', blinding: 'cc' } as Record<string, string> | null,
  roster: null as unknown,
  kept: new Map<string, unknown>(),
  canOpen: true,
  keysFail: null as Error | null,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => ({ id: 'u1' }),
  forgetLocally: () => {},
  resumeSession: async () => null,
  canOpenCompanies: () => kr.canOpen,
  openKeysWithWallet: async () => { kr.log.push('keys opened with the account'); kr.canOpen = true; },
  reopenSavedKeys: async () => {},
  pendingSeatsFor: () => [],
  keysFor: () => kr.keys,
  viewingKeyFor: () => 'vk',
  openAccount: () => kr.roster,
  companyKeysForVaults: async () => {
    kr.log.push('account asked');
    if (kr.keysFail !== null) throw kr.keysFail;
    return { companyKey: '11'.repeat(32), committeeKey: K(1), company: 'co_' + 'c1'.repeat(32), account: COMPANY };
  },
  api: async (path: string, opts?: RequestInit) => {
    const method = String(opts?.method ?? 'GET');
    kr.log.push(`${method} ${path}`);
    const a = kr.answers[`${method} ${path}`] ?? kr.answers[path];
    if (a === undefined) throw new Error(`no answer for ${method} ${path}`);
    if (a instanceof Error) throw a;
    return Array.isArray(a) ? (a.length > 1 ? a.shift() : a[0]) : a;
  },
}));
vi.mock('vaults-web-shared/vault-page-doors.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/vault-page-doors.js')>()),
  giveVaultKeys: async () => { kr.log.push('keys given'); },
  browserTemporaryKeys: () => ({
    put: async (vault: string, key: unknown) => { kr.log.push(`key kept ${vault}`); kr.kept.set(vault, key); },
    get: async (vault: string) => kr.kept.get(vault) ?? null,
    forget: async (vault: string) => { kr.log.push(`key forgotten ${vault}`); kr.kept.delete(vault); },
  }),
}));
vi.mock('vaults-web-shared/vault-worker-client.js', () => ({
  startVaultBuilder: async () => ({
    deploy: async (account: string) => { kr.log.push(`built for ${account}`); return { vault: VAULT, temporaryKey: K(0x77), tx: 'deploy-tx' }; },
    handover: async (input: { vault: string; counter: bigint; to: unknown }) => { kr.log.push(`handover built ${input.vault} ${input.counter}`); return { tx: 'handover-tx' }; },
  }),
}));

const ROUTE = (r = '') => `/api/accounts/c1${r}`;
/** A roster naming signer `s1` with committee key `mine`. */
const rosterWith = (mine: { tag: string; value: string } | null) => ({ id: 'c1', signers: [{
  id: 's1', userId: 'u1', name: 'Priya', status: 'active', signingPublicKey: SIGNER.publicKey, wrappingPublicKey: 'ee'.repeat(32),
  ...(mine === null ? {} : { vaultKeys: signVaultKeys('c1', 's1', { committeeKey: mine, recordsKey: K(0x40).value as Hex }, SIGNER.secret) }),
}] });
const COMMITTEE = { committee: [K(1)], threshold: 1 };
const ONE_KEY = { committee: [K(0x77)], threshold: 1, counter: '1', shape: 'one-key' };
const onChain = (held: boolean) => ({ vault: VAULT, onChain: true, heldByCommittee: held, authority: held ? { ...COMMITTEE, counter: '2', shape: 'committee' } : ONE_KEY, committee: COMMITTEE });

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  return import('./create-vault.js');
}
beforeEach(() => {
  kr.log = []; kr.answers = {}; kr.kept = new Map(); kr.canOpen = true; kr.keysFail = null;
  kr.keys = { signerId: 's1', signingSecret: 'aa', wrappingSecret: 'bb', blinding: 'cc' };
  kr.roster = rosterWith(K(1));
  kr.answers[ROUTE()] = { id: 'c1' };
  kr.answers[`PUT ${ROUTE('/vault-keys')}`] = { given: true };
  kr.answers[`GET ${ROUTE('/vault-keys')}`] = { committee: COMMITTEE, why: null, readers: [K(0x40).value] };
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('creating a vault', () => {
  /*
   * RED WHEN: the vault is not built for the company's address the account
   * gave; its temporary key is not kept before the vault is sent; the handover
   * is not built against the counter the chain reports; the operation ends
   * before the chain says the signers hold it; or its stages are not told.
   */
  it('runs the shared operation in its order, and ends only when the signers hold the vault', async () => {
    const m = await load();
    kr.answers[`POST ${ROUTE('/vaults')}`] = { vault: VAULT, txRef: 'r1', state: 'handover-owed' };
    kr.answers[`GET ${ROUTE(`/vaults/${VAULT}/chain`)}`] = [onChain(false), onChain(true)];
    kr.answers[`POST ${ROUTE(`/vaults/${VAULT}/handover`)}`] = { txRef: 'r2', state: 'handover-sent' };
    const stages: string[] = [];
    expect(await m.createVault('u1', 'c1', (s) => stages.push(s))).toEqual({ of: 'done', vault: VAULT });
    /* Every step but the reads of the company's record and its committee, in the order it was taken. */
    expect(kr.log.filter((l) => !l.startsWith('GET /api/accounts/c1') || l.includes('/chain'))).toEqual([
      'account asked', 'keys given',
      `built for ${COMPANY}`, `key kept ${VAULT}`, `POST ${ROUTE('/vaults')}`,
      `GET ${ROUTE(`/vaults/${VAULT}/chain`)}`, `handover built ${VAULT} 1`, `POST ${ROUTE(`/vaults/${VAULT}/handover`)}`,
      `GET ${ROUTE(`/vaults/${VAULT}/chain`)}`, `key forgotten ${VAULT}`,
    ]);
    expect(stages).toEqual(['checking', 'building', 'sending', 'waiting-for-chain', 'handing-over', 'waiting-for-handover', 'done']);
  });

  /* RED WHEN: a vault the service refused before sending anything is said as anything but nothing sent, or its temporary key is kept. */
  it('says nothing was sent when the service sent nothing, and keeps no key', async () => {
    const m = await load();
    kr.answers[`POST ${ROUTE('/vaults')}`] = new Error('the committee is not complete. Nothing was sent.');
    expect(await m.createVault('u1', 'c1', () => {})).toEqual({ of: 'refused', why: 'nothing-sent' });
    expect(kr.kept.size).toBe(0);
    expect(kr.log).toContain(`key forgotten ${VAULT}`);
  });

  /* RED WHEN: a vault that may have been sent is said as refused or as nothing sent, is not named, or its temporary key is dropped. */
  it('names a vault that may have been sent and is not handed over, and keeps its key', async () => {
    const m = await load();
    kr.answers[`POST ${ROUTE('/vaults')}`] = new Error('the network did not answer');
    expect(await m.createVault('u1', 'c1', () => {})).toEqual({ of: 'handover-owed', vault: VAULT });
    expect(kr.kept.has(VAULT)).toBe(true);
  });

  /* RED WHEN: finishing a handover sends another vault, or a vault whose key is not in this browser is not said as one only its own device can finish. */
  it('finishes handing over the vault named, and says when only another device can', async () => {
    const m = await load();
    kr.answers[`GET ${ROUTE(`/vaults/${VAULT}/chain`)}`] = [onChain(false), onChain(true)];
    kr.answers[`POST ${ROUTE(`/vaults/${VAULT}/handover`)}`] = { txRef: 'r2', state: 'handover-sent' };
    expect(await m.finishHandingOver('u1', 'c1', VAULT, () => {})).toEqual({ of: 'handover-owed-elsewhere', vault: VAULT });
    expect(kr.log.filter((l) => l.startsWith('built') || l.startsWith(`POST ${ROUTE('/vaults')}`))).toEqual([]);
    kr.kept.set(VAULT, K(0x77));
    kr.answers[`GET ${ROUTE(`/vaults/${VAULT}/chain`)}`] = [onChain(false), onChain(true)];
    expect(await m.finishHandingOver('u1', 'c1', VAULT, () => {})).toEqual({ of: 'done', vault: VAULT });
    expect(kr.log.filter((l) => l.startsWith('built'))).toEqual([]);
    expect(kr.log).toContain(`handover built ${VAULT} 1`);
  });

  /* RED WHEN: a committee the roster this device opened does not name is built for, or a vault is built on a device holding no keys for the company. */
  it('builds nothing for a committee the roster does not name, nor without this person\'s keys', async () => {
    const m = await load();
    kr.answers[`GET ${ROUTE('/vault-keys')}`] = { committee: { committee: [K(5)], threshold: 1 }, why: null, readers: [] };
    expect(await m.createVault('u1', 'c1', () => {})).toEqual({ of: 'refused', why: 'did-not-finish' });
    kr.keys = null;
    expect(await m.createVault('u1', 'c1', () => {})).toEqual({ of: 'refused', why: 'no-keys-here' });
    expect(kr.log.filter((l) => l.startsWith('built') || l.startsWith('key kept') || l.startsWith(`POST ${ROUTE('/vaults')}`))).toEqual([]);
  });
});

describe('giving your vault keys where a vault is created', () => {
  /* RED WHEN: the keys are given without the company's keys released by the account first, when this device holds no keys, or when the account refused; or anything is built or sent but the keys. */
  it('gives this signer\'s vault keys, after the account releases the company\'s, and nothing else', async () => {
    const m = await load();
    expect(await m.giveYourVaultKeys('u1', 'c1')).toEqual({ of: 'done' });
    expect(kr.log.filter((l) => l === 'account asked' || l === 'keys given')).toEqual(['account asked', 'keys given']);
    expect(kr.log.filter((l) => l.startsWith('built') || l.startsWith('POST'))).toEqual([]);
    kr.log = [];
    kr.keys = null;
    expect(await m.giveYourVaultKeys('u1', 'c1')).toEqual({ of: 'refused', why: 'no-keys-here' });
    expect(kr.log).not.toContain('keys given');
    kr.keys = { signerId: 's1', signingSecret: 'aa', wrappingSecret: 'bb', blinding: 'cc' };
    kr.keysFail = new Error('the account said no');
    expect((await m.giveYourVaultKeys('u1', 'c1')).of).toBe('refused');
    expect(kr.log).not.toContain('keys given');
  });
});

describe('what is said when it does not finish', () => {
  /*
   * RED WHEN: a failure the service did not mark as having sent nothing is
   * said as "nothing was sent and nothing was spent": one before anything is
   * built, one marked false, or one after the vault was sent, whose key must
   * then stay in this browser.
   */
  it('says nothing was sent only when the service said so', async () => {
    const m = await load();
    kr.keysFail = new Error('the account did not give the keys. Nothing was sent.');
    expect(await m.createVault('u1', 'c1', () => {})).toEqual({ of: 'refused', why: 'did-not-finish' });
    kr.keysFail = Object.assign(new Error('refused'), { nothingWasSent: false });
    expect(await m.createVault('u1', 'c1', () => {})).toEqual({ of: 'refused', why: 'did-not-finish' });
    kr.keysFail = null;
    kr.answers[`POST ${ROUTE('/vaults')}`] = { vault: VAULT, txRef: 'r1', state: 'handover-owed' };
    kr.answers[`GET ${ROUTE(`/vaults/${VAULT}/chain`)}`] = new TypeError('fetch failed');
    const after = await m.createVault('u1', 'c1', () => {});
    expect(after).not.toEqual({ of: 'refused', why: 'nothing-sent' });
    /* The vault was sent, so a read of the chain that fails after is the vault not finished, named, with its key here. */
    expect(after).toEqual({ of: 'handover-owed', vault: VAULT });
    expect(kr.kept.has(VAULT)).toBe(true);
  });

  /* RED WHEN: a vault whose committee the roster refuses is said as one not finished yet, with a Finish that can never work, or the refusal is said without the vault's key kept. */
  it('says when the roster refuses the committee reported for a vault sent, and keeps its key', async () => {
    const m = await load();
    kr.kept.set(VAULT, K(0x77));
    const refused = { ...onChain(false), committee: { committee: [K(5)], threshold: 1 } };
    kr.answers[`GET ${ROUTE(`/vaults/${VAULT}/chain`)}`] = refused;
    expect(await m.finishHandingOver('u1', 'c1', VAULT, () => {})).toEqual({ of: 'handover-owed-roster-disagrees', vault: VAULT });
    expect(kr.kept.has(VAULT)).toBe(true);
    expect(kr.log.filter((l) => l.startsWith('handover built'))).toEqual([]);
  });
});

describe('the vaults not finished, and keys not open', () => {
  /* RED WHEN: a vault not finished is not listed with its number among the company's vaults, or is said to be finishable from a browser without its key, or one that is. */
  it('lists each vault not finished with whether this browser can finish it', async () => {
    const m = await load();
    kr.answers[`GET ${ROUTE('/vaults')}`] = { rows: [
      { vault: 'aa'.repeat(32), deployedAt: 'x', state: 'held-by-committee' },
      { vault: VAULT, deployedAt: 'x', state: 'handover-owed' },
      { vault: 'ee'.repeat(32), deployedAt: 'x', state: 'handover-owed' },
    ] };
    kr.kept.set(VAULT, K(0x77));
    expect(await m.readOwedVaults('u1', 'c1')).toEqual([{ vault: VAULT, number: 2, here: true }, { vault: 'ee'.repeat(32), number: 3, here: false }]);
  });

  /*
   * RED WHEN: keys not open in this tab are said as keys on another device, a
   * read asks the account, or pressing Create does not open them with the
   * account first; or opening them is said as done when it was refused.
   */
  it('says the keys are not open yet, asks the account only when the person acts, and opens them', async () => {
    const m = await load();
    kr.canOpen = false; kr.keys = null;
    expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'locked' });
    expect(kr.log).not.toContain('keys opened with the account');
    expect(await m.openYourKeys('u1')).toEqual({ of: 'done' });
    expect(kr.log).toContain('keys opened with the account');
    kr.canOpen = false; kr.log = [];
    await m.createVault('u1', 'c1', () => {});
    expect(kr.log[0]).toBe('keys opened with the account');
  });
});

describe('whether a vault can be created', () => {
  /* RED WHEN: a committee is read as ready when the roster does not name it, or who is missing their vault keys is told wrong, or a company not on the chain is said as waiting on keys. */
  it('reads each state from the committee, the roster and the chain', async () => {
    const m = await load();
    expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'ready' });
    kr.answers[`GET ${ROUTE('/vault-keys')}`] = { committee: { committee: [K(5)], threshold: 1 }, why: null, readers: [] };
    expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'roster-disagrees' });
    kr.answers[`GET ${ROUTE('/vault-keys')}`] = { committee: null, why: 'not every signer', readers: [] };
    kr.answers[ROUTE('/authority')] = { company: { threshold: 1, signerCount: 2 } };
    expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'others-missing' });
    kr.roster = rosterWith(null);
    expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'yours-missing' });
    kr.answers[ROUTE('/authority')] = { company: null };
    expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'not-on-chain' });
    /* An answer that does not say the company is off the chain is not taken for one that does. */
    kr.answers[ROUTE('/authority')] = {};
    expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'yours-missing' });
    kr.answers[ROUTE()] = new TypeError('fetch failed');
    expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'refused', why: 'unreachable' });
  });
});
