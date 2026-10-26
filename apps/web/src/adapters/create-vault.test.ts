// @vitest-environment jsdom
import { seatOpenedFor } from '../../../../src/testing/directory-seats.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_ROOT } from '../../../../src/midnight/record-tree.js';
import { newSigningKeypair, signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';
import { sealVaultKeysOffer, signVaultKeys } from '../../../../src/core/vault-keys.js';
import { MemorySealedPoolStore } from '../../../../src/midnight/vault-pool.js';
import { directoryEntryMade } from '../../../../src/midnight/seat-directory.js';
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
/* The seat this signer holds on the company's account, made for their wallet's key, and the opening their entry carries. */
const { seat: SEAT, opening: OPENING } = seatOpenedFor(MINE, 1);
const STATEMENT = signRecordsKey(ME, LABEL, 'c0'.repeat(32) as never, fromHex('11'.repeat(32)), SEAT);
const SIGNER = newSigningKeypair();
/* This signer's entry in the company's seat directory, signed by their wallet: the seat and the records key a vault's pool and journals are wrapped to. */
const ENTRY = directoryEntryMade({
  company: 'c1', person: 'u1', committeeKey: MINE, opening: OPENING, signingSecret: 'aa'.repeat(32) as Hex, viewingKey: '5e'.repeat(32) as Hex,
  signed: signDirectoryEntry(ME, LABEL, 'c0'.repeat(32) as never, fromHex('11'.repeat(32)), signingPublicKeyOf('aa'.repeat(32)), SEAT),
});
const COMPANY = 'c0'.repeat(32);
const VAULT = 'ab'.repeat(32);
const kr = vi.hoisted(() => ({
  log: [] as string[],
  answers: {} as Record<string, unknown>,
  keys: { signerId: 's1', signingSecret: 'aa'.repeat(32), wrappingSecret: 'bb', blinding: 'cc' } as Record<string, string> | null,
  roster: null as unknown,
  canOpen: true,
  keysFail: null as Error | null,
  /* What the page asked the wallet to run, how the action ended, and a press that did not reach the wallet. */
  acts: [] as unknown[],
  ended: { of: 'done', steps: 1, relayed: 0 } as unknown,
  actFails: null as Error | null,
  /** The steps the wallet's action reports, in order, before it ends. */
  steps: [] as Array<{ step: number; steps: number }>,
  /* Whether the company's account, as the wallet reads it, holds this signer's seat. */
  seatHeld: true,
  /* Who holds the vault, as the wallet reads it off the vault: the company's committee, another key, or nothing read. */
  vaultHeld: 'company' as 'company' | 'temporary' | 'unread',
  /* Where the vault's start stands on the stand-in chain, and the approvals each round needs. */
  start: { adopted: false, open: false, approvals: 0, set: false, run: false, runApprovals: 0, written: false, needed: 1 },
  records: new Map<string, unknown>(),
  /* Each version of the new vault's name this device filed. */
  info: [] as unknown[],
  /* Whether the service refuses the vault's name. */
  infoRefused: false,
  /* The seat this device's own key material makes, as the vault worker works it out. */
  ownSeat: '5a'.repeat(32),
  /* What the vault worker reads in a vault's deploy: born held, or the sentence that says it was not. */
  bornRefusal: null as string | null,
  /* The vault on the stand-in chain, as this device's vault worker reads it at the wallet's indexer, or why it could not be. */
  chain: null as unknown,
  /* Vaults the account adopted before this test's own, as the wallet reads the chain. */
  adoptedAlso: [] as string[],
  /* Each vault's own approvals needed, as the wallet reads the account's map of thresholds: none set unless a test says. */
  vaultThresholds: [] as { vault: string; threshold: number }[],
  /* Seats the account holds on the chain beyond this signer's own, as the wallet reads it. */
  seatsAlso: [] as string[],
  /* From the fourth read of who holds the account - the vault operation's own, after the keys are given and the directory read - the wallet cannot say, or says a threshold no committee can meet. */
  holdersFail: null as Error | null,
  walletAskFails: false,
  holdersThreshold: 1,
  holdersReads: 0,
  /* The page's vault builder has no way to build a vault held from the start. */
  noBornHeld: false,
  /* The worker fails when it reads how the sent vault was created. */
  readAsBornFails: false,
}));
vi.mock('./filing-judge.js', async (real) => ({
  ...(await real<typeof import('./filing-judge.js')>()),
  /* The company's keys as its directory gives them (`companyKeysFor`), stood in for by the one key of a company never changed. */
  companyKeysFor: async () => ({ epoch: 0, newest: 0, key: '5e'.repeat(32), keyAt: () => '5e'.repeat(32), sealing: () => ({ key: '5e'.repeat(32), epoch: 0 }) }),
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  /* This signer's signed directory entry, kept until it is filed; what becomes of it is `vault-keys.test.ts`'s. */
  oweDirectoryEntry: async () => {},
  directoryEntryOwed: () => ({ read: () => null, settle: async () => {} }),
  currentUser: () => ({ id: 'u1' }),
  forgetLocally: () => {},
  resumeSession: async () => null,
  canOpenCompanies: () => kr.canOpen,
  actOnACompanyInTheWallet: async (intent: unknown, _origin: string, opts?: { onStep?: (at: { step: number; steps: number }) => void }) => {
    kr.acts.push(intent);
    for (const at of kr.steps) opts?.onStep?.(at);
    if (kr.actFails !== null) throw kr.actFails;
    return kr.ended;
  },
  openKeysWithWallet: async () => { kr.log.push('keys opened with the account'); kr.canOpen = true; },
  pendingSeatsFor: () => [],
  /* This seat as the wallet read it for the tab: its public halves only, worked out here from the test's seat. */
  seatHeldHere: () => (kr.keys === null ? null : {
    signerId: kr.keys['signerId'], signingPublicKey: kr.keys['signingSecret'] === 'aa'.repeat(32) ? 'e734ea6c2b6257de72355e472aa05a4c487e6b463c029ed306df2f01b5636b58' : 'ff'.repeat(32), wrappingPublicKey: 'a2'.repeat(32), scope: 'a3'.repeat(32),
  }),
  /* The company's viewing key, which opens every directory entry's proof here. */
  viewingKeyFor: () => '5e'.repeat(32),
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
  recordsKeyFromTheWallet: async (_origin: string, ask: {
    company: string; account: string; seat: string; vault?: string; signingKey?: string;
    firstSecret?: { readers: readonly { key: string; name?: string }[] };
  }) => {
    /* What the wallet would show for a vault's first secret: each reader, by the name the page holds, else by its key. */
    if (kr.walletAskFails && ask.vault !== undefined) throw new Error('the person closed the wallet');
    const shown = ask.firstSecret === undefined ? ''
      : ` showing ${ask.firstSecret.readers.map((r) => r.name ?? r.key.slice(0, 4)).join(', ')}`;
    kr.log.push(`records key signed for ${ask.seat.slice(0, 4)}${ask.vault === undefined ? '' : ` with vault ${ask.vault.slice(0, 4)}`}${shown}`);
    const { identityFromSecret: fromSecret } = await import('midnight-identity');
    const { committeeKeyFor: committeeOf } = await import('midnight-identity/profile/committee-key');
    const { signRecordsKey: sign, signDirectoryEntry: signEntry } = await import('midnight-identity/profile/records-key');
    const me = fromSecret(new Uint8Array(32).fill(1));
    const committeeKey = committeeOf(me, ask.company as never);
    return {
      committeeKey, statement: sign(me, ask.company as never, ask.account as never, new Uint8Array(32).fill(0x11), ask.seat),
      /* The directory entry, signed in the same press when the page names its filing key. */
      entry: ask.signingKey === undefined ? null : signEntry(me, ask.company as never, ask.account as never, new Uint8Array(32).fill(0x11), ask.signingKey, ask.seat),
      seats: { committee: [committeeKey], threshold: 1, seats: kr.seatHeld ? [ask.seat] : ['77'.repeat(32)] },
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
    kr.holdersReads += 1;
    const late = kr.holdersReads >= 4;
    if (late && kr.holdersFail !== null) throw kr.holdersFail;
    return {
      holders: { committee: [committeeKey], threshold: late ? kr.holdersThreshold : 1, seats: [kr.ownSeat, ...kr.seatsAlso], approvals: 1, vaultThresholds: kr.vaultThresholds, policyBar: null, seatBar: 1, adoptedVaults: [...kr.adoptedAlso, ...(kr.start.adopted ? ['ab'.repeat(32)] : [])], founding: kr.ownSeat, foundingCommittee: [{ tag: 'schnorr', value: '11'.repeat(32) }], account: 'c0'.repeat(32) },
      /* The indexer the wallet reads through, which the page reads the vault through too. */
      indexer: { indexerUri: 'https://indexer.wallet.example/api/v3/graphql', indexerWsUri: 'wss://indexer.wallet.example/api/v3/graphql/ws' },
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
}));
/* The company's records a vault's name is filed in: every version this device filed, kept for the length of one test. */
vi.mock('vaults-web-shared/vault-info-here.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/vault-info-here.js')>()),
  vaultInfoRecordsFor: () => ({
    get: async () => kr.info[kr.info.length - 1] ?? null,
    served: async () => kr.info[kr.info.length - 1] ?? null,
    put: async (rec: { version: number }) => {
      if (kr.infoRefused) throw new Error('the service refused it');
      kr.info.push(rec);
    },
  }),
}));
vi.mock('vaults-web-shared/vault-worker-client.js', () => ({
  startVaultBuilder: async () => ({
    ownSeat: async (material: { blinding: string }) => { kr.log.push(`own seat from ${material.blinding}`); return kr.ownSeat; },
    /* The leaf each directory entry's opening makes, as the worker works it out with the account's own compiled `signerLeaf`. */
    seatOpenings: async (input: { openings: readonly { publicKey: string; scope: string; blinding: string }[] }) => {
      const { leafOfTheContract } = await import('../../../../src/testing/directory-seats.js');
      return { openings: input.openings.map((o) => ({ leaf: leafOfTheContract(o as never), tag: null })) };
    },
    /* The account's own heads, and its history at the wallet's indexer: the stand-in chain holds no anchor. */
    anchorHeads: async (i: { after: unknown[] }) => ({ after: i.after.map(() => '00'.repeat(32)), seats: i.after.map(() => null) }),
    /* A chain holding no anchor: no head landed, and who holds the account named for an anchor nobody here sends. */
    anchorsOnChain: async () => ({ landed: [], now: { approvals: 1, signerRoot: '00'.repeat(32), signers: ['00'.repeat(32)] }, seatsNow: ['00'.repeat(32)] }),
    /* The value a company-wide run names, which the vault check counts as one of the company's vaults. */
    companyWide: async () => 'cc'.repeat(32),
    deploy: async (account: string) => { kr.log.push(`built for ${account}`); return { vault: VAULT, temporaryKey: K(0x77), tx: 'deploy-tx' }; },
    ...(kr.noBornHeld ? {} : {
      bornHeldVault: async (input: { account: string; holders: { committee: unknown[]; threshold: number } }) => {
        kr.log.push(`built held for ${input.account} by ${input.holders.committee.length} at ${input.holders.threshold}`);
        return { vault: VAULT, tx: 'deploy-tx' };
      },
    }),
    vaultAsDeployed: async (input: { vault: string; indexer: { indexerUri: string } }) => { if (kr.readAsBornFails) throw new Error('the worker failed'); kr.log.push(`read as born ${input.vault} at ${input.indexer.indexerUri}`); return { refusal: kr.bornRefusal }; },
    /* The vault as this device's worker reads it on the stand-in chain, at the indexer the wallet named: held as the chain shows it, pinned to the company. */
    vaultOnChain: async (input: { vault: string; account?: string; indexer: { indexerUri: string } }) => {
      kr.log.push(`vault read here at ${input.indexer.indexerUri}`);
      const v = kr.chain as { onChain?: boolean; authority?: { committee: unknown[]; threshold: number } } | Error | null;
      if (v instanceof Error) throw v;
      if (v === null || v.onChain !== true) return { onChain: false };
      return {
        onChain: true, state: 'QUJD', notes: [], notesFromThisBuild: true, everCreated: [], authority: v.authority ?? null, account: COMPANY, started: false,
        /* The circuits of the vault, and of the account when the read names it, are this app's. */
        circuits: null, ...(input.account === undefined ? {} : { accountCircuits: null }),
      };
    },
    /* Both contracts at one block, as this device's worker reads them at the indexer the wallet named. */
    chainAtOneBlock: async (input: { indexer: { indexerUri: string } }) => {
      kr.log.push(`block read here at ${input.indexer.indexerUri}`);
      return { blockHash: 'b', vaultState: 'v', zswapState: 'z', parameters: 'p', accountState: 'a' };
    },
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

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  return import('./create-vault.js');
}
/** The service's start routes over the stand-in chain: each step it is sent moves the start on. */
const startRoutes = () => {
  kr.answers[`POST ${ROUTE(`/vaults/${VAULT}/start/account`)}`] = (body: { step: string; call: string }) => {
    const st = kr.start;
    if (body.step === 'adoption') {
      if (body.call === 'approve') st.approvals += 1;
      if (body.call === 'adopt') st.adopted = true;
    } else if (body.call === 'approve') st.runApprovals += 1;
    return { txRef: `${body.step} ${body.call}` };
  };
  /*
   * The company's proposals: the adoption and the first secret run are each written down there, raised with it, and
   * entered in the company's records. A raise names the vault only for the run, which pays nobody.
   */
  const proposals: Array<Record<string, unknown>> = [];
  kr.answers[`GET ${ROUTE('/proposals')}`] = () => proposals;
  kr.answers[`POST ${ROUTE('/proposals')}`] = (body: { proposal: { id: string; chainId: string }; tx?: string; vault?: string }) => {
    const rec = { ...body.proposal, accountId: 'c1', status: 'open', approvalCount: 0 };
    proposals.push(rec);
    /* The service writes a proposal down as carried out once its own read of the chain no longer holds it open. */
    kr.answers[`POST /api/proposals/${rec.id}/carried`] = (asked: { vault?: string; filer?: string }) => {
      if (asked.vault !== VAULT || typeof asked.filer !== 'string') throw new Error('this request does not name the vault and this seat\'s filing key');
      if (body.vault === undefined ? kr.start.open && !kr.start.adopted : !kr.start.set) throw new Error('the chain still holds this proposal open');
      rec.status = 'executed';
      return { id: rec.id, status: 'executed' };
    };
    if (body.tx !== undefined) {
      /* The raise counts at once as the raiser's own approval, as the chain does. */
      if (body.vault === undefined) { kr.start.open = true; kr.start.approvals = 1; }
      else { kr.start.run = true; kr.start.runApprovals = 1; }
    }
    return { id: rec.id, chainId: rec.chainId, status: 'open', approvalCount: 0 };
  };
  kr.answers[`POST ${ROUTE('/manifest/entries')}`] = {};
  kr.answers[`POST ${ROUTE(`/vaults/${VAULT}/start/secret`)}`] = () => { kr.start.set = true; return { txRef: 'secret' }; };
  kr.answers[`POST ${ROUTE(`/vaults/${VAULT}/start/copy`)}`] = () => { kr.start.written = true; return { txRef: 'copy' }; };
};
beforeEach(() => {
  kr.log = []; kr.answers = {}; kr.canOpen = true; kr.keysFail = null; kr.acts = []; kr.actFails = null; kr.steps = []; kr.ended = { of: 'done', steps: 1, relayed: 0 }; kr.seatHeld = true; kr.vaultHeld = 'company';
  kr.start = { adopted: false, open: false, approvals: 0, set: false, run: false, runApprovals: 0, written: false, needed: 1 };
  kr.records = new Map();
  kr.ownSeat = SEAT;
  kr.bornRefusal = null;
  kr.chain = null;
  kr.adoptedAlso = [];
  kr.seatsAlso = [];
  kr.holdersFail = null; kr.walletAskFails = false; kr.holdersThreshold = 1; kr.holdersReads = 0; kr.noBornHeld = false; kr.readAsBornFails = false;
  startRoutes();
  kr.keys = { signerId: 's1', signingSecret: 'aa'.repeat(32), wrappingSecret: 'bb', blinding: 'cc' };
  kr.roster = rosterWith(MINE);
  kr.answers[ROUTE()] = { id: 'c1' };
  kr.answers[ROUTE('/directory')] = { filings: [{ company: 'c1', version: 1, change: { kind: 'claim', entry: ENTRY } }] };
  /* The company's records hold no entry, and the stand-in chain no anchor: creating a vault reads no record through them. */
  kr.answers[`GET ${ROUTE(`/manifest/tree/pending?root=${EMPTY_ROOT}`)}`] = { entries: [] };
  kr.answers[`POST ${ROUTE('/manifest/tree/proofs')}`] = (b: { records: unknown[]; kinds: unknown[] }) =>
    ({ records: b.records.map(() => null), kinds: b.kinds.map(() => []), older: [], proof: { siblings: [] } });
  kr.answers[ROUTE('/call-state')] = { account: 'c0'.repeat(32), accountState: '00'.repeat(32), parameters: '', blockHash: 'b' };
  kr.answers[`PUT ${ROUTE('/vault-keys')}`] = { given: true };
  kr.answers[`GET ${ROUTE('/vault-keys')}`] = { committee: COMMITTEE, why: null, readers: [MY_RECORDS_KEY] };
  /* The approvals the account and its vaults need, as the wallet reads the account: one, everywhere. */
  kr.vaultThresholds = [];
});
afterEach(() => { vi.unstubAllEnvs(); });

const LABEL_C1 = `co_${'c1'.repeat(32)}`;
const ACCOUNT_C1 = 'c0'.repeat(32);
const VAULT_C1 = 'd1'.repeat(32);
const named = () => { kr.answers[ROUTE()] = { id: 'c1', companyLabel: LABEL_C1, contractAddress: ACCOUNT_C1 }; };

describe('creating a vault is one action in the person\'s wallet', () => {
  /* RED WHEN: the page names the company to the wallet by anything but its record, label and account, or adds what the action does not take, or opens the person's keys itself. */
  it('names the company, the vault to carry on and the vault\'s name to the wallet, and nothing else', async () => {
    const m = await load();
    named();
    kr.ended = { of: 'done', steps: 3, relayed: 7, outcome: { vault: VAULT_C1 } };
    expect(await m.createVault('u1', 'c1', () => {}, { name: ' Payroll ', description: 'Monthly ' })).toEqual({ of: 'done', vault: VAULT_C1 });
    expect(kr.acts).toEqual([{ name: 'create-vault', record: 'c1', company: LABEL_C1, account: ACCOUNT_C1, title: 'Payroll', about: 'Monthly' }]);
    expect(await m.finishStarting('u1', 'c1', VAULT_C1.toUpperCase(), () => {})).toEqual({ of: 'done', vault: VAULT_C1 });
    expect(kr.acts[1]).toEqual({ name: 'create-vault', record: 'c1', company: LABEL_C1, account: ACCOUNT_C1, vault: VAULT_C1 });
    expect(kr.log).not.toContain('keys opened with the account');
  });

  /* RED WHEN: a vault waiting for other signers' approvals is said as created, or its round and counts are lost. */
  it('says which round waits for other signers, with its approvals, and what was said along the way', async () => {
    const m = await load();
    named();
    kr.ended = { of: 'done', steps: 3, relayed: 4, outcome: { vault: VAULT_C1, round: 'first-secret', approvals: 1, needed: 2, said: 'proposal-not-written-down,not-a-code' } };
    expect(await m.createVault('u1', 'c1', () => {})).toEqual({
      of: 'awaiting-approvals', vault: VAULT_C1, round: 'first-secret', approvals: 1, needed: 2, said: ['proposal-not-written-down'],
    });
  });

  /*
   * RED WHEN: the screen says the vault is being built while the wallet files keys or records, or says keys and records
   * are being filed while the wallet builds the vault: the wallet's steps are its records, entry, offer, the vault, and
   * its records again.
   */
  it('says the vault is being built only while the wallet is on the vault\'s own step', async () => {
    const m = await load();
    named();
    kr.steps = [1, 2, 3, 4, 5].map((step) => ({ step, steps: 5 }));
    kr.ended = { of: 'done', steps: 5, relayed: 3, outcome: { vault: VAULT_C1 } };
    const seen: string[] = [];
    await m.createVault('u1', 'c1', (stage) => { seen.push(stage); });
    expect(seen).toEqual(['checking', 'checking', 'checking', 'checking', 'building', 'checking', 'done']);
  });

  /* RED WHEN: an action stopped after the vault was built is said as a refusal that names no vault, so a second one is created instead of carrying this one on. */
  it('names the vault when the action stopped after it was built, with why where the wallet said', async () => {
    const m = await load();
    named();
    kr.ended = { of: 'stopped', step: 3, steps: 3, relayed: 2, unconfirmed: 0, why: 'check-failed', outcome: { vault: VAULT_C1, stopped: 'signer-left-out' } };
    expect(await m.createVault('u1', 'c1', () => {})).toEqual({ of: 'start-owed', vault: VAULT_C1, stopped: 'mismatch' });
    kr.ended = { of: 'stopped', step: 3, steps: 3, relayed: 2, unconfirmed: 0, why: 'stopped', outcome: { vault: VAULT_C1, stopped: 'made-up' } };
    /* RED WHEN: a reason the wallet named that this page has no words for is passed on as one. */
    expect(await m.createVault('u1', 'c1', () => {})).toStrictEqual({ of: 'start-owed', vault: VAULT_C1 });
    kr.ended = { of: 'stopped', step: 1, steps: 3, relayed: 0, unconfirmed: 0, why: 'check-failed' };
    expect(await m.createVault('u1', 'c1', () => {})).toEqual({ of: 'refused', why: 'did-not-finish' });
  });

  /* RED WHEN: a company with no account on the chain is put to the wallet, or a wallet that could not be reached is said as anything but that. */
  it('asks nothing of a company not on the chain, and says a press that did not reach the wallet as such', async () => {
    const m = await load();
    kr.answers[ROUTE()] = { id: 'c1' };
    expect(await m.createVault('u1', 'c1', () => {})).toEqual({ of: 'refused', why: 'did-not-finish' });
    expect(kr.acts).toEqual([]);
    named();
    kr.actFails = new Error('the wallet window was closed');
    expect((await m.createVault('u1', 'c1', () => {})).of).toBe('refused');
  });

  /* RED WHEN: giving your vault keys on its own is anything but the one action, naming only the company. */
  it('gives your vault keys on their own as one action naming only the company', async () => {
    const m = await load();
    named();
    kr.ended = { of: 'done', steps: 2, relayed: 0 };
    expect(await m.giveYourVaultKeys('u1', 'c1')).toEqual({ of: 'done' });
    expect(kr.acts).toEqual([{ name: 'give-vault-keys', record: 'c1', company: LABEL_C1, account: ACCOUNT_C1 }]);
    kr.ended = { of: 'stopped', step: 1, steps: 2, relayed: 0, unconfirmed: 0, why: 'call-refused' };
    expect(await m.giveYourVaultKeys('u1', 'c1')).toEqual({ of: 'refused', why: 'did-not-finish' });
  });
});

describe('keys not open', () => {
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
    named();
    await m.createVault('u1', 'c1', () => {});
    /* The press is the wallet's one action: this page does not open the person's keys for it. */
    expect(kr.log).not.toContain('keys opened with the account');
  });
});

describe('whether a vault can be created', () => {
  const OTHER = newSigningKeypair();
  /* The filing key this signer's wallet signed their directory entry for: the key their roster entry holds when it is believed. */
  const FILING = { secret: 'aa'.repeat(32), publicKey: signingPublicKeyOf('aa'.repeat(32)) };
  /* An offer of vault keys as a signer's device files it: sealed under the company's roster key, the entry their wallet signed beside the keys. */
  const offerOf = (signerId: string, seat: string, filer: { publicKey: string; secret: string }, sealedUnder = '5e'.repeat(32), entryWrapped = '11'.repeat(32)) => ({
    person: 'u1',
    ...sealVaultKeysOffer('c1', {
      signerId,
      entry: { committeeKey: MINE, statement: signDirectoryEntry(ME, LABEL, COMPANY as never, fromHex(entryWrapped), filer.publicKey as Hex, seat) },
      keys: signVaultKeys('c1', signerId, {
        committeeKey: MINE, recordsKey: MY_RECORDS_KEY, recordsKeyStatement: STATEMENT.signature as Hex, recordsKeySeat: seat as Hex,
      }, filer.secret as Hex),
    }, sealedUnder as Hex),
  });
  /* This signer's offer still open on the service, their roster entry holding no keys yet; and a second active signer on the roster. */
  const mineUnfolded = (userId = 'u1') => ({ ...rosterWith(null), signers: rosterWith(null).signers.map((x) => ({ ...x, userId, signingPublicKey: FILING.publicKey })) });
  const withOther = (roster: ReturnType<typeof rosterWith>) => ({
    ...roster, signers: [...roster.signers, {
      id: 's2', userId: 'u2', name: 'Sam', status: 'active', signingPublicKey: OTHER.publicKey, wrappingPublicKey: 'ee'.repeat(32), leafCommitment: '99'.repeat(32),
    }],
  });
  beforeEach(() => {
    kr.answers[ROUTE()] = { id: 'c1', companyLabel: LABEL, contractAddress: COMPANY };
    kr.answers[ROUTE('/authority')] = { company: { threshold: 1, signerCount: 1 } };
    kr.answers[`GET ${ROUTE('/vault-keys/offers')}`] = { offers: [] };
  });

  /* RED WHEN: a committee the service reports makes a vault ready while a signer's own vault-key offer is not there (the committee exists from the day the company is made), or one that is there is not counted. */
  it('is ready when every signer has an offer the device can open, whatever committee the service reports', async () => {
    const m = await load();
    kr.answers[`GET ${ROUTE('/vault-keys')}`] = { committee: COMMITTEE, why: null, readers: [] };
    /* Folded into the roster: the offer this signer made earlier. */
    expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'ready' });
    /* Still open on the service. */
    kr.roster = mineUnfolded();
    kr.answers[`GET ${ROUTE('/vault-keys/offers')}`] = { offers: [offerOf('s1', SEAT, FILING)] };
    expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'ready' });
    /* A committee reported with this signer's offer nowhere: their keys are missing, not the vault ready. */
    kr.answers[`GET ${ROUTE('/vault-keys/offers')}`] = { offers: [] };
    expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'yours-missing' });
  });

  /* RED WHEN: an offer this device cannot open or that is not the signer's own counts as given: one sealed under another key, one signed by another key than the roster's for the signer, one for another seat, or one whose directory entry names another records key than its keys. */
  it('counts no offer this device cannot open, or that is not the roster signer\'s own', async () => {
    const m = await load();
    kr.roster = mineUnfolded();
    for (const offer of [
      offerOf('s1', SEAT, FILING, '77'.repeat(32)),
      offerOf('s1', SEAT, OTHER),
      offerOf('s1', '98'.repeat(32), FILING),
      offerOf('s9', SEAT, FILING),
      /* Its directory entry names another records key than its vault keys do. */
      offerOf('s1', SEAT, FILING, '5e'.repeat(32), '22'.repeat(32)),
    ]) {
      kr.answers[`GET ${ROUTE('/vault-keys/offers')}`] = { offers: [offer] };
      expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'yours-missing' });
    }
  });

  /* RED WHEN: a vault is ready while another active signer the device believes has given no keys, or whose offer names a seat the device does not believe in the company's directory, or is told as this signer's own missing. */
  it('is not ready while another signer has no offer it can open, or none on a seat it believes', async () => {
    const m = await load();
    kr.roster = withOther(rosterWith(MINE));
    expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'others-missing' });
    /* An offer that opens and is theirs, on a seat the company's directory holds no entry for. */
    kr.answers[`GET ${ROUTE('/vault-keys/offers')}`] = { offers: [offerOf('s2', '99'.repeat(32), OTHER)] };
    expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'others-missing' });
    /* This signer's own are missing too: it is theirs that is said. */
    kr.roster = withOther(mineUnfolded());
    expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'yours-missing' });
  });

  /* RED WHEN: a signer's keys count as given while the company's directory holds no entry for their seat, which makes no reader of it. */
  it('is not ready for keys whose seat the company\'s directory does not hold', async () => {
    const m = await load();
    kr.answers[ROUTE('/directory')] = { filings: [] };
    expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'yours-missing' });
  });

  /* RED WHEN: a vault is said ready while the first secret's own check of the signers against the account would refuse: the account seats a signer the roster does not name (a); an open offer the fold would refuse counts (b); a signer's records key is signed for a seat the account no longer holds, though another row attests the seat (c). */
  describe('says ready only when the first secret\'s own check would pass', () => {
    it('(a) is not ready while the account seats a signer the roster does not name', async () => {
      const m = await load();
      expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'ready' });
      kr.seatsAlso = ['98'.repeat(32)];
      expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'others-missing' });
    });

    it('(b) counts no open offer the fold would refuse, here one for a seat the directory holds for another person', async () => {
      const m = await load();
      kr.roster = mineUnfolded('u9');
      kr.answers[`GET ${ROUTE('/vault-keys/offers')}`] = { offers: [offerOf('s1', SEAT, FILING)] };
      expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'yours-missing' });
      kr.roster = mineUnfolded();
      expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'ready' });
    });

    it('(c) is not ready when a signer\'s records key is signed for a seat the account no longer holds, though another row attests the seat', async () => {
      const m = await load();
      const OLD = '97'.repeat(32);
      const oldStatement = signRecordsKey(ME, LABEL, 'c0'.repeat(32) as never, fromHex('11'.repeat(32)), OLD);
      const roster = rosterWith(MINE);
      kr.roster = { ...roster, signers: [
        { ...roster.signers[0]!, vaultKeys: signVaultKeys('c1', 's1', {
          committeeKey: MINE, recordsKey: MY_RECORDS_KEY, recordsKeyStatement: oldStatement.signature as Hex, recordsKeySeat: OLD as Hex,
        }, SIGNER.secret) },
        { ...roster.signers[0]!, id: 's0', status: 'removed', leafCommitment: null },
      ] };
      expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'others-missing' });
    });
  });

  /* RED WHEN: a company not on the chain is said as waiting on keys, or a read that fails is said as ready or missing keys. */
  it('says a company not on the chain, and a read that fails, as what they are', async () => {
    const m = await load();
    kr.answers[ROUTE('/authority')] = { company: null };
    expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'not-on-chain' });
    /* An answer that does not say the company is off the chain is not taken for one that does. */
    kr.answers[ROUTE('/authority')] = {};
    expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'ready' });
    kr.answers[ROUTE()] = new TypeError('fetch failed');
    expect(await m.readVaultReadiness('u1', 'c1')).toEqual({ of: 'refused', why: 'unreachable' });
  });
});
