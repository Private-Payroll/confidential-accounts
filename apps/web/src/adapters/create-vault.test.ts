// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newSigningKeypair, signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';
import { signVaultKeys } from '../../../../src/core/vault-keys.js';
import { MemorySealedPoolStore, SealedNotePool } from '../../../../src/midnight/vault-pool.js';
import { recordsKeypairFrom } from '../../../../src/midnight/company-nonce-secret.js';
import { fromHex } from '../../../../src/core/crypto.js';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signDirectoryEntry, signRecordsKey } from 'midnight-identity/profile/records-key';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';

/*
 * CREATING A VAULT THROUGH THE ADAPTER, WITH THE SHARED OPERATION RUNNING AS
 * IT IS. The keyring, the service and the part of the page that builds vault
 * transactions are stood in for; a vault is born held by the company's
 * committee, so no temporary key is made, kept or forgotten;
 * `createCompanyVault` and the company's vault routes, with their checks
 * against the roster, are the shared code's own. The vault's start is stood in
 * for as the chain would show it: each step the page sends moves it on.
 */
const K = (n: number) => ({ tag: 'schnorr', value: n.toString(16).padStart(2, '0').repeat(32) });
/* This signer's records key, as their released company key gives it: the key their copy of a vault's secret is sealed to. */
const MY_RECORDS_KEY = recordsKeypairFrom(fromHex('11'.repeat(32))).publicKey as Hex;
/*
 * This signer's committee key for the company, and their wallet's statement over their records key: what the
 * account releases with the company key, and what every key a vault's secret is sealed to is checked against.
 */
const LABEL = `co_${'c1'.repeat(32)}` as CompanyLabel;
const ME = identityFromSecret(new Uint8Array(32).fill(1));
const MINE = committeeKeyFor(ME, LABEL) as { tag: string; value: string };
/* The seat this signer holds on the company's account. */
const SEAT = '5a'.repeat(32);
const STATEMENT = signRecordsKey(ME, LABEL, 'c0'.repeat(32) as never, fromHex('11'.repeat(32)), SEAT);
const SIGNER = newSigningKeypair();
/* This signer's entry in the company's seat directory, signed by their wallet: the seat and the records key a vault's pool and journals are wrapped to. */
const ENTRY = { person: 'u1', committeeKey: MINE, statement: signDirectoryEntry(ME, LABEL, 'c0'.repeat(32) as never, fromHex('11'.repeat(32)), signingPublicKeyOf('aa'.repeat(32)), SEAT) };
const COMPANY = 'c0'.repeat(32);
const VAULT = 'ab'.repeat(32);
const kr = vi.hoisted(() => ({
  log: [] as string[],
  answers: {} as Record<string, unknown>,
  keys: { signerId: 's1', signingSecret: 'aa'.repeat(32), wrappingSecret: 'bb', blinding: 'cc' } as Record<string, string> | null,
  roster: null as unknown,
  kept: new Map<string, unknown>(),
  canOpen: true,
  keysFail: null as Error | null,
  /* Whether the company's account, as the wallet reads it, is held by its committee or still by the temporary key. */
  accountHeld: true,
  /* Who holds the vault, as the wallet reads it off the vault: the company's committee, another key, or nothing read. */
  vaultHeld: 'company' as 'company' | 'temporary' | 'unread',
  /* Where the vault's start stands on the stand-in chain, and the approvals each round needs. */
  start: { adopted: false, open: false, approvals: 0, set: false, run: false, runApprovals: 0, written: false, needed: 1 },
  records: new Map<string, unknown>(),
  /* The seat this device's own key material makes, as the vault worker works it out. */
  ownSeat: '5a'.repeat(32),
  /* What the vault worker reads in a vault's deploy: born held, or the sentence that says it was not. */
  bornRefusal: null as string | null,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  /* This signer's signed directory entry, kept until it is filed; what becomes of it is `hand-over`'s own test's. */
  oweDirectoryEntry: async () => {},
  directoryEntryOwed: () => ({ read: () => null, settle: async () => {} }),
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
    /* The same identity the test names at the top, worked out here because this stand-in is hoisted above it. */
    const { identityFromSecret: fromSecret } = await import('midnight-identity');
    const { committeeKeyFor: committeeOf } = await import('midnight-identity/profile/committee-key');
    return { companyKey: '11'.repeat(32), committeeKey: committeeOf(fromSecret(new Uint8Array(32).fill(1)), `co_${'c1'.repeat(32)}` as never), company: `co_${'c1'.repeat(32)}`, account: COMPANY };
  },
  /* The person's account signs their records key for the seat the page names, and says who holds the company. */
  recordsKeyFromTheWallet: async (_origin: string, ask: { company: string; account: string; seat: string; vault?: string; signingKey?: string }) => {
    kr.log.push(`records key signed for ${ask.seat.slice(0, 4)}${ask.vault === undefined ? '' : ` with vault ${ask.vault.slice(0, 4)}`}`);
    const { identityFromSecret: fromSecret } = await import('midnight-identity');
    const { committeeKeyFor: committeeOf } = await import('midnight-identity/profile/committee-key');
    const { signRecordsKey: sign, signDirectoryEntry: signEntry } = await import('midnight-identity/profile/records-key');
    const me = fromSecret(new Uint8Array(32).fill(1));
    const committeeKey = committeeOf(me, ask.company as never);
    return {
      committeeKey, statement: sign(me, ask.company as never, ask.account as never, new Uint8Array(32).fill(0x11), ask.seat),
      /* The directory entry, signed in the same press when the page names its filing key. */
      entry: ask.signingKey === undefined ? null : signEntry(me, ask.company as never, ask.account as never, new Uint8Array(32).fill(0x11), ask.signingKey, ask.seat),
      seats: { committee: kr.accountHeld ? [committeeKey] : [{ tag: 'schnorr', value: '77'.repeat(32) }], threshold: 1, seats: [ask.seat] },
      vault: ask.vault === undefined || kr.vaultHeld === 'unread' ? null : {
        vault: ask.vault, account: 'c0'.repeat(32), threshold: 1,
        committee: kr.vaultHeld === 'company' ? [committeeKey] : [{ tag: 'schnorr', value: '77'.repeat(32) }],
      },
    };
  },
  /* Who holds the company, as the wallet reads it with no press: the vault adopted once the stand-in chain says so. */
  holdersFromTheWallet: async (_origin: string, ask: { company: string }) => {
    const { identityFromSecret: fromSecret } = await import('midnight-identity');
    const { committeeKeyFor: committeeOf } = await import('midnight-identity/profile/committee-key');
    const committeeKey = committeeOf(fromSecret(new Uint8Array(32).fill(1)), ask.company as never);
    return {
      holders: { committee: [committeeKey], threshold: 1, seats: ['5a'.repeat(32)], approvals: 1, adoptedVaults: kr.start.adopted ? ['ab'.repeat(32)] : [], founding: '5a'.repeat(32), foundingCommittee: [{ tag: 'schnorr', value: '11'.repeat(32) }], account: 'c0'.repeat(32) },
    };
  },
  api: async (path: string, opts?: RequestInit) => {
    const method = String(opts?.method ?? 'GET');
    kr.log.push(`${method} ${path}`);
    const a = kr.answers[`${method} ${path}`] ?? kr.answers[path];
    if (a === undefined) throw new Error(`no answer for ${method} ${path}`);
    if (a instanceof Error) throw a;
    if (typeof a === 'function') return a(opts?.body === undefined ? undefined : JSON.parse(String(opts.body)));
    return Array.isArray(a) ? (a.length > 1 ? a.shift() : a[0]) : a;
  },
}));
/* Offering and folding vault keys are their own tests' (`vault-keys-are-offered-and-folded.test.ts`); here each is written down. */
vi.mock('vaults-web-shared/roster-here.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/roster-here.js')>()),
  offerVaultKeysHere: async () => { kr.log.push('keys offered'); },
  foldOffersHere: async () => { kr.log.push('offers folded'); return { folded: [], refused: [] }; },
}));
vi.mock('vaults-web-shared/vault-page-doors.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/vault-page-doors.js')>()),
  /* This signer's entry in the seat directory; whether it is filed is `vault-keys`' own test's. */
  fileTheOwedDirectoryEntry: async () => 'filed',
  /* The company's records, kept here for the length of one test. */
  deviceRecordsFor: () => (record: string) => {
    if (!kr.records.has(record)) kr.records.set(record, new MemorySealedPoolStore());
    return kr.records.get(record);
  },
  browserTemporaryKeys: () => ({
    put: async (vault: string, key: unknown) => { kr.log.push(`key kept ${vault}`); kr.kept.set(vault, key); },
    get: async (vault: string) => kr.kept.get(vault) ?? null,
    forget: async (vault: string) => { kr.log.push(`key forgotten ${vault}`); kr.kept.delete(vault); },
  }),
}));
vi.mock('vaults-web-shared/vault-worker-client.js', () => ({
  startVaultBuilder: async () => ({
    ownSeat: async (material: { blinding: string }) => { kr.log.push(`own seat from ${material.blinding}`); return kr.ownSeat; },
    /* The value a company-wide run names, which the vault check counts as one of the company's vaults. */
    companyWide: async () => 'cc'.repeat(32),
    deploy: async (account: string) => { kr.log.push(`built for ${account}`); return { vault: VAULT, temporaryKey: K(0x77), tx: 'deploy-tx' }; },
    bornHeldVault: async (input: { account: string; holders: { committee: unknown[]; threshold: number } }) => {
      kr.log.push(`built held for ${input.account} by ${input.holders.committee.length} at ${input.holders.threshold}`);
      return { vault: VAULT, tx: 'deploy-tx' };
    },
    vaultAsDeployed: async (input: { vault: string; deploy: string }) => { kr.log.push(`read as born ${input.vault} from ${input.deploy}`); return { refusal: kr.bornRefusal }; },
    handover: async (input: { vault: string; counter: bigint; to: unknown }) => { kr.log.push(`handover built ${input.vault} ${input.counter}`); return { tx: 'handover-tx' }; },
    startStanding: async (input: { secret?: string; window?: unknown }) => {
      const st = kr.start;
      /* This signer's own copy, sealed as the vault worker seals it, so the press finds a copy its own key opens. */
      const { sealSecretCopy } = await import('../../../../src/midnight/sealed-secret-copy.js');
      const { recordsKeypairFrom: keysOf } = await import('../../../../src/midnight/company-nonce-secret.js');
      const { fromHex: bytes, toHex: hexOf } = await import('../../../../src/core/crypto.js');
      const reader = keysOf(bytes('11'.repeat(32))).publicKey;
      const parts = input.secret === undefined ? [] : sealSecretCopy({ vault: VAULT, secret: input.secret as Hex, reader: reader as Hex }).map((p) => hexOf(p));
      const round = { proposal: 'a1'.repeat(32), payload: 'a2'.repeat(32), named: 'a3'.repeat(32), salt: 'a4'.repeat(32), stale: false };
      const run = { proposal: 'b1'.repeat(32), payload: 'b2'.repeat(32), named: VAULT, salt: 'b4'.repeat(32), opensAt: '1', closesAt: '9', inWindow: true };
      return {
        standing: {
          adopted: st.adopted,
          adoption: { ...round, open: st.open, approvals: st.approvals, needed: st.needed },
          ...(input.secret === undefined ? {} : {
            secret: {
              set: st.set, another: false, rootIsThisRuns: st.set, written: [st.written], started: st.set && st.written,
              run: st.run ? { ...run, open: true, approvals: st.runApprovals, needed: st.needed, stale: false } : null,
              ...(input.window === undefined ? {} : { raise: { ...run, opensAt: '1', closesAt: '9' } }),
            },
          }),
        },
        ...(input.secret === undefined ? {} : {
          run: { vault: VAULT, root: 'c1'.repeat(32), payees: '1', asset: 'c2'.repeat(32), copies: [{ reader, parts, path: [] }] },
        }),
      };
    },
    governedCall: async (input: { order: { circuit: string } }) => { kr.log.push(`account ${input.order.circuit} proved`); return { tx: 'call-tx' }; },
    setNonceSecret: async () => { kr.log.push('secret proved'); return { tx: 'secret-tx' }; },
    /* The stand-in vault holds the secret the company's records hold once it is set. */
    secretIsTheVaults: async () => true,
    writeSecretCopy: async (input: { place: number }) => { kr.log.push(`copy ${input.place} proved`); return { tx: 'copy-tx' }; },
  }),
}));

const ROUTE = (r = '') => `/api/accounts/c1${r}`;
/** A roster naming signer `s1` with committee key `mine`. */
const rosterWith = (mine: { tag: string; value: string } | null) => ({ id: 'c1', signers: [{
  id: 's1', userId: 'u1', name: 'Priya', status: 'active', signingPublicKey: SIGNER.publicKey, wrappingPublicKey: 'ee'.repeat(32), leafCommitment: SEAT,
  ...(mine === null ? {} : {
    vaultKeys: signVaultKeys('c1', 's1', {
      committeeKey: mine, recordsKey: MY_RECORDS_KEY, recordsKeyStatement: STATEMENT.signature as Hex, recordsKeySeat: SEAT as Hex,
    }, SIGNER.secret),
  }),
}], notBelieved: [] as string[] });
const COMMITTEE = { committee: [MINE], threshold: 1 };
const ONE_KEY = { committee: [K(0x77)], threshold: 1, counter: '1', shape: 'one-key' };
const onChain = (held: boolean) => ({
  vault: VAULT, onChain: true, heldByCommittee: held, authority: held ? { ...COMMITTEE, counter: '2', shape: 'committee' } : ONE_KEY, committee: COMMITTEE,
  /* The deploy the vault was born from, as the service kept it. */
  deployed: 'deploy-tx',
});

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  return import('./create-vault.js');
}
/** The service's start routes over the stand-in chain: each step it is sent moves the start on. */
const startRoutes = () => {
  kr.answers[`GET ${ROUTE(`/vaults/${VAULT}/payout-state`)}`] = {
    vault: VAULT, account: COMPANY, blockHash: 'b', vaultState: 'v', zswapState: 'z', parameters: 'p', accountState: 'a',
  };
  kr.answers[`POST ${ROUTE(`/vaults/${VAULT}/start/account`)}`] = (body: { step: string; call: string }) => {
    const st = kr.start;
    if (body.step === 'adoption') {
      if (body.call === 'propose') st.open = true;
      if (body.call === 'approve') st.approvals += 1;
      if (body.call === 'adopt') st.adopted = true;
    } else {
      if (body.call === 'propose') st.run = true;
      if (body.call === 'approve') st.runApprovals += 1;
    }
    return { txRef: `${body.step} ${body.call}` };
  };
  kr.answers[`POST ${ROUTE(`/vaults/${VAULT}/start/secret`)}`] = () => { kr.start.set = true; return { txRef: 'secret' }; };
  kr.answers[`POST ${ROUTE(`/vaults/${VAULT}/start/copy`)}`] = () => { kr.start.written = true; return { txRef: 'copy' }; };
};
beforeEach(() => {
  kr.log = []; kr.answers = {}; kr.kept = new Map(); kr.canOpen = true; kr.keysFail = null; kr.accountHeld = true; kr.vaultHeld = 'company';
  kr.start = { adopted: false, open: false, approvals: 0, set: false, run: false, runApprovals: 0, written: false, needed: 1 };
  kr.records = new Map();
  kr.ownSeat = SEAT;
  kr.bornRefusal = null;
  startRoutes();
  kr.keys = { signerId: 's1', signingSecret: 'aa'.repeat(32), wrappingSecret: 'bb', blinding: 'cc' };
  kr.roster = rosterWith(MINE);
  kr.answers[ROUTE()] = { id: 'c1' };
  kr.answers[ROUTE('/directory')] = { filings: [{ company: 'c1', version: 1, change: { kind: 'claim', entry: ENTRY } }] };
  kr.answers[`PUT ${ROUTE('/vault-keys')}`] = { given: true };
  kr.answers[`GET ${ROUTE('/vault-keys')}`] = { committee: COMMITTEE, why: null, readers: [MY_RECORDS_KEY] };
  /* The approvals the account and its vaults need, as the chain holds them: one, everywhere. */
  kr.answers[ROUTE('/ledger')] = { threshold: 1, vaultThresholds: [] };
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('creating a vault', () => {
  /*
   * RED WHEN: the vault is not built for the company's address the account
   * gave, held by the company's committee; a temporary key is made or a
   * hand-over built; the vault is carried on before this device has read it as
   * it was born; the operation ends before the vault is started; or its stages
   * are not told.
   */
  it('runs the shared operation in its order, and ends only when the vault, born held, is started', async () => {
    const m = await load();
    kr.answers[`POST ${ROUTE('/vaults')}`] = { vault: VAULT, txRef: 'r1', state: 'deploy-sent' };
    kr.answers[`GET ${ROUTE(`/vaults/${VAULT}/chain`)}`] = onChain(true);
    const stages: string[] = [];
    expect(await m.createVault('u1', 'c1', (s) => stages.push(s))).toEqual({ of: 'done', vault: VAULT });
    /* RED WHEN: the vault's pool is filed under this signer's roster id, or wrapped to a key their directory entry does not name. */
    const pool = await (kr.records.get('pool') as MemorySealedPoolStore).get(VAULT);
    expect(pool?.wrapped.map((w) => w.signerId)).toEqual([SEAT]);
    await expect(new SealedNotePool(kr.records.get('pool') as MemorySealedPoolStore, { signerId: SEAT, wrappingSecret: recordsKeypairFrom(fromHex('11'.repeat(32))).secret }, async () => []).load(VAULT)).resolves.toBeDefined();
    /* Every step but the reads of the company's record and its committee, in the order it was taken. */
    expect(kr.log.filter((l) => !l.startsWith('GET /api/accounts/c1') || l.endsWith('/chain'))
      .filter((l, i, all) => !(l.endsWith('/chain') && all[i - 1]?.endsWith('/chain')))).toEqual([
      /* The seat is worked out on this device before the account is asked for anything. */
      'own seat from cc', 'account asked', 'records key signed for 5a5a', 'keys offered', 'offers folded',
      `built held for ${COMPANY} by 1 at 1`, `POST ${ROUTE('/vaults')}`,
      `GET ${ROUTE(`/vaults/${VAULT}/chain`)}`, `read as born ${VAULT} from deploy-tx`,
      /* The start, each step sent only once the stand-in chain showed the one before. */
      'account propose proved', `POST ${ROUTE(`/vaults/${VAULT}/start/account`)}`,
      'account approve proved', `POST ${ROUTE(`/vaults/${VAULT}/start/account`)}`,
      'account adopt proved', `POST ${ROUTE(`/vaults/${VAULT}/start/account`)}`,
      `GET ${ROUTE(`/vaults/${VAULT}/chain`)}`,
      /* Who holds the company and this vault, read by the account afresh: before the secret is filed, and before its run. */
      `records key signed for 5a5a with vault ${VAULT.slice(0, 4)}`, `records key signed for 5a5a with vault ${VAULT.slice(0, 4)}`,
      'account propose proved', `POST ${ROUTE(`/vaults/${VAULT}/start/account`)}`,
      'account approve proved', `POST ${ROUTE(`/vaults/${VAULT}/start/account`)}`,
      /* And afresh again right before the secret is set, so a signer who left during the approvals is caught. */
      `records key signed for 5a5a with vault ${VAULT.slice(0, 4)}`,
      'secret proved', `POST ${ROUTE(`/vaults/${VAULT}/start/secret`)}`,
      'copy 0 proved', `POST ${ROUTE(`/vaults/${VAULT}/start/copy`)}`,
    ]);
    /* The pool and the secret were filed before the secret run was raised from it. */
    expect(kr.records.has('pool') && kr.records.has('nonce-secret')).toBe(true);
    /* RED WHEN a stage is said out of the operation's order, or a stage of the start is not said at all. */
    expect(stages).toEqual([
      'checking', 'building', 'sending', 'waiting-for-chain',
      /* The secret is made on this device in this press, so it is never read back to be built on. */
      'adopting', 'opening-the-pool', 'setting-the-secret', 'writing-the-copies', 'done',
    ]);
  });

  /*
   * RED WHEN: a signer whose device did not create the vault cannot carry its set up on - approving its adoption and
   * its first secret with their own keys - or does so by building or handing over anything.
   */
  it('carries a held vault\'s set up on from a device that did not create it, approving with this signer\'s own keys', async () => {
    const m = await load();
    kr.answers[`GET ${ROUTE(`/vaults/${VAULT}/chain`)}`] = onChain(true);
    expect(await m.finishHandingOver('u1', 'c1', VAULT, () => {})).toEqual({ of: 'done', vault: VAULT });
    expect(kr.log.filter((l) => l.startsWith('built') || l.startsWith('handover built'))).toEqual([]);
    /* RED WHEN: a vault this device did not create is carried on without being read as it was born. */
    expect(kr.log.indexOf(`read as born ${VAULT} from deploy-tx`)).toBeLessThan(kr.log.indexOf('account propose proved'));
    expect(kr.log.filter((l) => l === 'account approve proved')).toHaveLength(2);
    /*
     * RED WHEN: who holds the company and this vault is not read afresh by the person's account for each check before
     * the secret is approved - once when the keys are given, once for each of the two checks of the secret's readers, and
     * once more right before the secret is set.
     */
    expect(kr.log.filter((l) => l.startsWith('records key signed'))).toEqual([
      'records key signed for 5a5a', `records key signed for 5a5a with vault ${VAULT.slice(0, 4)}`, `records key signed for 5a5a with vault ${VAULT.slice(0, 4)}`,
      `records key signed for 5a5a with vault ${VAULT.slice(0, 4)}`,
    ]);
    /* The two checks of the secret's readers come before its run is raised; the third, before the secret is set. */
    const vaultReads = kr.log.flatMap((l, i) => (l === `records key signed for 5a5a with vault ${VAULT.slice(0, 4)}` ? [i] : []));
    expect(vaultReads[1]).toBeLessThan(kr.log.indexOf('account propose proved', kr.log.indexOf('account adopt proved')));
    expect(vaultReads[2]).toBeLessThan(kr.log.indexOf('secret proved'));
    expect(vaultReads[2]).toBeGreaterThan(kr.log.lastIndexOf('account approve proved'));
    await m.finishHandingOver('u1', 'c1', VAULT, () => {});
    /* Started: nothing about the secret is approved, so only the keys are given again. */
    expect(kr.log.filter((l) => l.startsWith('records key signed'))).toHaveLength(5);
  });

  /*
   * RED WHEN: a set up stopped at the check of who its secret is sealed to is said without what resolves it, or the
   * first secret is raised or approved before that check passes.
   */
  it('says a set up stopped before its secret was approved, with what resolves it, and raises nothing for the secret', async () => {
    const m = await load();
    kr.accountHeld = false;
    kr.answers[`GET ${ROUTE(`/vaults/${VAULT}/chain`)}`] = onChain(true);
    expect(await m.finishHandingOver('u1', 'c1', VAULT, () => {})).toEqual({ of: 'start-owed', vault: VAULT, stopped: 'hand-over' });
    /* The adoption was raised, approved and carried out; nothing about the secret was. */
    expect(kr.log.filter((l) => l.endsWith(' proved'))).toEqual(['account propose proved', 'account approve proved', 'account adopt proved']);
  });

  /* RED WHEN: the vault's committee is taken from the service's report: it says the signers hold it, the account reads the temporary key. */
  it('stops before anything about the secret, when the account reads the vault still held by its temporary key, and says it as the vault\'s', async () => {
    const m = await load();
    kr.vaultHeld = 'temporary';
    kr.answers[`GET ${ROUTE(`/vaults/${VAULT}/chain`)}`] = onChain(true);
    expect(await m.finishHandingOver('u1', 'c1', VAULT, () => {})).toEqual({ of: 'start-owed', vault: VAULT, stopped: 'vault' });
    expect(kr.records.get('nonce-secret') === undefined || await (kr.records.get('nonce-secret') as MemorySealedPoolStore).get(VAULT) === null).toBe(true);
    kr.vaultHeld = 'unread';
    expect(await m.finishHandingOver('u1', 'c1', VAULT, () => {})).toEqual({ of: 'start-owed', vault: VAULT, stopped: 'wallet' });
  });

  /* RED WHEN: a kind of refusal is said with a remedy that is not its own - a vault already handed over told to hand over again, say. */
  it('says every kind of refusal of the secret\'s readers with the one thing that resolves it', async () => {
    const m = await load();
    const { READER_REFUSAL } = await import('../../../../src/midnight/secret-readers.js');
    expect(m.STOPPED_BY).toEqual({
      [READER_REFUSAL.walletReadNothing]: 'wallet',
      [READER_REFUSAL.accountNotHeld]: 'hand-over',
      [READER_REFUSAL.vaultNotHeld]: 'vault',
      [READER_REFUSAL.committeeOutOfDate]: 'signers',
      [READER_REFUSAL.keysNotGiven]: 'signers',
      [READER_REFUSAL.notSigned]: 'mismatch',
      [READER_REFUSAL.seatNotHeld]: 'signers',
      [READER_REFUSAL.rosterNotTheChains]: 'mismatch',
      [READER_REFUSAL.readerNotASigner]: 'mismatch',
      [READER_REFUSAL.signerLeftOut]: 'mismatch',
      [READER_REFUSAL.vaultNotTheCompanys]: 'mismatch',
    });
    /* Every kind the check can give has a remedy, and every remedy is one a screen says. */
    expect(Object.keys(m.STOPPED_BY).sort()).toEqual(Object.values(READER_REFUSAL).sort());
    expect(new Set(Object.values(m.STOPPED_BY))).toEqual(new Set(Object.values(m.STOPPED)));
  });

  /* RED WHEN: a vault the service refused before sending anything is said as anything but nothing sent, or any key is kept. */
  it('says nothing was sent when the service sent nothing, and keeps no key', async () => {
    const m = await load();
    kr.answers[`POST ${ROUTE('/vaults')}`] = Object.assign(new Error('the committee is not complete. Nothing was sent.'), { nothingWasSent: true });
    expect(await m.createVault('u1', 'c1', () => {})).toEqual({ of: 'refused', why: 'nothing-sent' });
    expect(kr.kept.size).toBe(0);
    expect(kr.log.filter((l) => l.startsWith('key '))).toEqual([]);
  });

  /* RED WHEN: a vault that may have been sent is said as refused or as nothing sent, or is not named. */
  it('names a vault that may have been sent, as one whose set-up is not finished', async () => {
    const m = await load();
    kr.answers[`POST ${ROUTE('/vaults')}`] = new Error('the network did not answer');
    expect(await m.createVault('u1', 'c1', () => {})).toEqual({ of: 'start-owed', vault: VAULT });
    expect(kr.kept.size).toBe(0);
  });

  /* RED WHEN: a vault this device reads as not born held - held by other keys, other circuits, something written - is adopted or set up from here. */
  it('carries nothing on with a vault not born held, and says it as refused', async () => {
    const m = await load();
    kr.bornRefusal = 'this is not a vault this company can use: held by other keys. Nothing was sent.';
    kr.answers[`GET ${ROUTE(`/vaults/${VAULT}/chain`)}`] = onChain(true);
    expect((await m.finishHandingOver('u1', 'c1', VAULT, () => {})).of).toBe('refused');
    expect(kr.log.filter((l) => l.endsWith(' proved') || l.startsWith('POST'))).toEqual([]);
  });

  /* RED WHEN: a committee the roster this device opened does not name is built for, or a vault is built on a device holding no keys for the company. */
  it('builds nothing for a committee the roster does not name, nor without this person\'s keys', async () => {
    const m = await load();
    kr.answers[`GET ${ROUTE('/vault-keys')}`] = { committee: { committee: [K(5)], threshold: 1 }, why: null, readers: [] };
    expect(await m.createVault('u1', 'c1', () => {})).toEqual({ of: 'refused', why: 'did-not-finish' });
    kr.keys = null;
    expect(await m.createVault('u1', 'c1', () => {})).toEqual({ of: 'refused', why: 'no-keys-here' });
    expect(kr.log.filter((l) => l.startsWith('built') || l.startsWith(`POST ${ROUTE('/vaults')}`))).toEqual([]);
  });
});

describe('a vault whose start is not finished', () => {
  /* RED WHEN: an adoption is raised, approved or carried out for a vault that would join the company needing more approvals than its seated signers could give. */
  it('takes no step to adopt a vault that would join the company unable to pay', async () => {
    const m = await load();
    kr.answers[`GET ${ROUTE(`/vaults/${VAULT}/chain`)}`] = onChain(true);
    kr.answers[ROUTE('/ledger')] = { threshold: 1, vaultThresholds: [{ vault: VAULT, threshold: 2 }] };
    expect(await m.finishHandingOver('u1', 'c1', VAULT, () => {})).toEqual({ of: 'start-owed', vault: VAULT });
    expect(kr.log.filter((l) => l.endsWith(' proved') || l.startsWith('POST'))).toEqual([]);
  });

  /* RED WHEN: a round waiting on other signers is said as done, or as a failure, or without what it waits for. */
  it('says which round waits for other signers, with its approvals, and creating it again carries on', async () => {
    const m = await load();
    kr.kept.set(VAULT, K(0x77));
    kr.answers[`GET ${ROUTE(`/vaults/${VAULT}/chain`)}`] = onChain(true);
    kr.start.needed = 2;
    const stages: string[] = [];
    expect(await m.finishHandingOver('u1', 'c1', VAULT, (s) => { stages.push(s); })).toEqual({
      of: 'awaiting-approvals', vault: VAULT, round: 'adoption', proposal: 'a1'.repeat(32), approvals: 1, needed: 2,
    });
    /* RED WHEN a stage of the start is not passed on to the screen, so a person waits on a step nothing names. */
    expect(stages).toEqual(expect.arrayContaining(['adopting', 'waiting-for-approvals']));
    /* Another signer approves; pressing again carries the adoption out and goes on to the secret, which waits too. */
    kr.start.approvals = 2;
    kr.log = [];
    stages.length = 0;
    expect(await m.finishHandingOver('u1', 'c1', VAULT, (s) => { stages.push(s); })).toMatchObject({ of: 'awaiting-approvals', round: 'first-secret', approvals: 1, needed: 2 });
    /* RED WHEN the secret's own steps are not passed on: opening the pool, reading the secret back, setting it. */
    expect(stages).toEqual(expect.arrayContaining(['opening-the-pool', 'setting-the-secret', 'waiting-for-approvals']));
    expect(kr.log.filter((l) => l.endsWith('proved'))).toEqual(['account adopt proved', 'account propose proved', 'account approve proved']);
  });

  /* RED WHEN: a start the service refused is said as done, or without the vault it is for. */
  it('names the vault whose start did not finish', async () => {
    const m = await load();
    kr.answers[`GET ${ROUTE(`/vaults/${VAULT}/chain`)}`] = onChain(true);
    kr.answers[`POST ${ROUTE(`/vaults/${VAULT}/start/account`)}`] = new Error('the chain could not be asked. Nothing was sent.');
    expect(await m.finishHandingOver('u1', 'c1', VAULT, () => {})).toEqual({ of: 'start-owed', vault: VAULT });
  });
});

describe('giving your vault keys where a vault is created', () => {
  /* RED WHEN: the keys are given without the company's keys released by the account first, when this device holds no keys, or when the account refused; or anything is built or sent but the keys. */
  it('gives this signer\'s vault keys, after the account releases the company\'s, and nothing else', async () => {
    const m = await load();
    expect(await m.giveYourVaultKeys('u1', 'c1')).toEqual({ of: 'done' });
    expect(kr.log.filter((l) => l === 'account asked' || l === 'keys offered')).toEqual(['account asked', 'keys offered']);
    expect(kr.log.filter((l) => l.startsWith('built') || l.startsWith('POST'))).toEqual([]);
    kr.log = [];
    kr.keys = null;
    expect(await m.giveYourVaultKeys('u1', 'c1')).toEqual({ of: 'refused', why: 'no-keys-here' });
    expect(kr.log).not.toContain('keys offered');
    kr.keys = { signerId: 's1', signingSecret: 'aa'.repeat(32), wrappingSecret: 'bb', blinding: 'cc' };
    kr.keysFail = new Error('the account said no');
    expect((await m.giveYourVaultKeys('u1', 'c1')).of).toBe('refused');
    expect(kr.log).not.toContain('keys offered');
  });

  /* RED WHEN: the account is asked to sign for the seat the service's records name rather than the one this device's own key makes. */
  it('signs for the seat this device\'s own key makes, and for no other the records name', async () => {
    const m = await load();
    kr.ownSeat = '6b'.repeat(32);
    expect(await m.giveYourVaultKeys('u1', 'c1')).toEqual({ of: 'refused', why: 'not-your-seat' });
    expect(kr.log).toContain('own seat from cc');
    expect(kr.log.filter((l) => l.startsWith('records key signed'))).toEqual([]);
    expect(kr.log).not.toContain('keys offered');
    /* RED WHEN: the account is asked to release the company's keys before this device has checked its own seat. */
    expect(kr.log).not.toContain('account asked');
    kr.log = [];
    expect(await m.createVault('u1', 'c1', () => {})).toEqual({ of: 'refused', why: 'not-your-seat' });
    expect(kr.log.filter((l) => l.startsWith('records key signed') || l.startsWith('built') || l.startsWith('POST'))).toEqual([]);
  });

  /* RED WHEN: keys are given, or anything signed, built or sent, when the records name no seat for this signer; or that is said as anything but a missing seat. */
  it('gives nothing and signs nothing when the records name no seat for this signer', async () => {
    const m = await load();
    const roster = rosterWith(MINE);
    kr.roster = { ...roster, signers: roster.signers.map((x) => ({ ...x, leafCommitment: null })) };
    expect(await m.giveYourVaultKeys('u1', 'c1')).toEqual({ of: 'refused', why: 'no-seat' });
    expect(await m.createVault('u1', 'c1', () => {})).toEqual({ of: 'refused', why: 'no-seat' });
    expect(kr.log.filter((l) => l.startsWith('records key signed') || l === 'keys offered' || l.startsWith('built') || l.startsWith('POST'))).toEqual([]);
    /* RED WHEN: a signer with no seat is shown an account prompt to release the company's keys before being refused. */
    expect(kr.log).not.toContain('account asked');
  });
});

describe('what is said when it does not finish', () => {
  /*
   * RED WHEN: a failure the service did not mark as having sent nothing is
   * said as "nothing was sent and nothing was spent": one before anything is
   * built, one marked false, or one after the vault was sent, which must then
   * be named.
   */
  it('says nothing was sent only when the service said so', async () => {
    const m = await load();
    kr.keysFail = new Error('the account did not give the keys. Nothing was sent.');
    expect(await m.createVault('u1', 'c1', () => {})).toEqual({ of: 'refused', why: 'did-not-finish' });
    kr.keysFail = Object.assign(new Error('refused'), { nothingWasSent: false });
    expect(await m.createVault('u1', 'c1', () => {})).toEqual({ of: 'refused', why: 'did-not-finish' });
    kr.keysFail = null;
    kr.answers[`POST ${ROUTE('/vaults')}`] = { vault: VAULT, txRef: 'r1', state: 'deploy-sent' };
    kr.answers[`GET ${ROUTE(`/vaults/${VAULT}/chain`)}`] = new TypeError('fetch failed');
    const after = await m.createVault('u1', 'c1', () => {});
    expect(after).not.toEqual({ of: 'refused', why: 'nothing-sent' });
    /* The vault was sent, so a read of the chain that fails after is the vault not finished, named. */
    expect(after).toEqual({ of: 'start-owed', vault: VAULT });
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
