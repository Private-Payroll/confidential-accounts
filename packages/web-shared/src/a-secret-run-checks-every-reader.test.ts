import { describe, expect, it } from 'vitest';
import { approverRosterFrom } from '../../../src/core/vault-approvers.js';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signRecordsKey } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { createCompanyVault, VaultStartOwed, type VaultChainView, type VaultService } from './vault-operation.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import { MemorySealedPoolStore } from '../../../src/midnight/vault-pool.js';
import type { WireRecord } from '../../../src/midnight/sealed-record-wire.js';
import { newWrappingKeypair, toHex } from '../../../src/core/crypto.js';
import { openNonceSecrets, recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { sealSecretCopy } from '../../../src/midnight/sealed-secret-copy.js';
import type { RosterVaultKeys } from '../../../src/core/vault-keys.js';

/*
 * **THE PRESS THAT STARTS A VAULT CHECKS EVERY READER OF ITS FIRST SECRET
 * BEFORE IT RAISES OR APPROVES THE RUN**, and this signer's own copy opens. The
 * service and the worker are stood in: the worker hands back the run whose
 * copies each test chooses, and the first thing a raise or an approval would do
 * is ask the worker for a governed call, so a check that let a run through is
 * seen as that ask.
 */
const VAULT = 'ab'.repeat(32);
const ACCOUNT = 'c0'.repeat(32) as AccountAddress;
const CO = `co_${'c1'.repeat(32)}` as CompanyLabel;
/*
 * The company as a device counts it for the vault check, beside the pacing every operation takes: three seats with every
 * right and one approval needed, so no vault here is left short. The check is driven in
 * `src/core/a-vault-keeps-as-many-approvers-as-its-bar.test.ts` and `apps/web/src/adapters/create-vault.test.ts`.
 */
const nobodyShort = {
  approvers: async () => approverRosterFrom({
    threshold: 1, vaultThresholds: [], seated: ['e1', 'e2', 'e3'].map((leaf) => ({ leaf })), adoptedVaults: [], companyWide: 'cc'.repeat(32),
  }),
  vaultName: (v: string) => v,
};
const pacing = { sleep: async () => {}, waitMs: 3, everyMs: 1, ...nobodyShort };

const signer = (n: number, name: string) => {
  const identity = identityFromSecret(new Uint8Array(32).fill(n));
  const companyKey = new Uint8Array(32).fill(n + 100);
  const committeeKey = committeeKeyFor(identity, CO) as { tag: string; value: string };
  const seat = (0x40 + n).toString(16).repeat(32);
  const statement = signRecordsKey(identity, CO, ACCOUNT, companyKey, seat);
  const entry: RosterVaultKeys = {
    signerId: name.toLowerCase(), userId: name.toLowerCase(), name, filingKey: '00'.repeat(32) as never,
    keys: {
      committeeKey, recordsKey: statement.recordsKey as never,
      recordsKeyStatement: statement.signature as never, recordsKeySeat: statement.seat as never,
    },
  };
  return { companyKey, committeeKey, recordsKey: statement.recordsKey, entry, seat };
};
const ada = signer(1, 'Ada');
const bo = signer(2, 'Bo');
const theServices = recordsKeypairFrom(new Uint8Array(32).fill(0x5e)).publicKey;

/** One press, with the readers the service reports, the copies the run would write, and the roster and chain as given. */
const press = async (o: {
  readers: string[];
  copies: (secret: string) => { reader: string; parts: string[] }[];
  roster?: RosterVaultKeys[];
  /** The seats the account holds now, as the wallet read them, when not Ada's and Bo's. */
  seats?: string[];
  /** The committee the signer's wallet reads holding the vault, when it is not the account's. The service always reports the account's. */
  vaultHeldBy?: { tag: string; value: string }[];
  /** The run already raised and approved on the chain, so the press goes on to set the secret. */
  approved?: boolean;
  /** The seats the wallet reads on its nth read, counted from one, when they change during the press. */
  seatsOnRead?: (n: number) => string[];
}) => {
  let reads = 0;
  const asked: string[] = [];
  const committee = [ada.committeeKey, bo.committeeKey];
  const view: VaultChainView = {
    vault: VAULT, onChain: true, heldByCommittee: true, why: null, notes: [], everCreated: [],
    committee: { committee, threshold: 2 } as never,
    authority: { committee, threshold: 2, counter: '1', shape: 'committee' },
    /* What the service would say of the vault; nothing in a start asks it - the vault is read on the device (`vaultOnChain` below). */
    deployed: 'D',
  };
  const stores = new Map<WireRecord, MemorySealedPoolStore>();
  const records = (r: WireRecord) => stores.get(r) ?? stores.set(r, new MemorySealedPoolStore()).get(r)!;
  const wrapping = newWrappingKeypair();
  const me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: ada.companyKey };
  const service: VaultService = {
    keys: async () => ({ committee: { committee, threshold: 2 } as never, why: null, readers: o.readers as never }),
    deploy: async () => { throw new Error('not deployed here'); },
    handover: async () => { throw new Error('not handed over here'); },
    chain: async () => view,
    deposit: async () => { throw new Error('no deposit'); },
    payoutState: async (v) => ({ vault: v, account: ACCOUNT, blockHash: 'B', vaultState: 'V', zswapState: 'Z', parameters: 'P', accountState: 'A' }),
    events: async () => ({ events: [] }),
    createdBy: async () => null,
    payout: async () => { throw new Error('no payout'); },
    payoutPublicly: async () => { throw new Error('no payout'); },
    startAccountCall: async () => { asked.push('sent a step'); return { txRef: 't' }; },
    startSecret: async () => { asked.push('sent the secret'); return { txRef: 't' }; },
    startCopy: async () => { asked.push('sent a copy'); return { txRef: 't' }; },
  };
  const filedSecret = async (): Promise<string> => {
    const opened = openNonceSecrets((await records('nonce-secret').get(VAULT))!, VAULT, recordsKeypairFrom(ada.companyKey));
    return opened.secrets[opened.secrets.length - 1]!;
  };
  const builder = {
    startStanding: async (i: { secret?: string }) => ({
      standing: {
        adopted: true,
        adoption: { proposal: 'a1'.repeat(32), payload: 'a2'.repeat(32), named: 'a3'.repeat(32), salt: 'a4'.repeat(32), open: false, approvals: 1, needed: 1, stale: false },
        ...(i.secret === undefined ? {} : { secret: {
          set: false, another: false, rootIsThisRuns: true, written: [], started: false,
          run: o.approved === true ? {
            proposal: 'b1'.repeat(32), payload: 'b2'.repeat(32), named: 'b3'.repeat(32), salt: 'b4'.repeat(32),
            open: true, inWindow: true, approvals: 2, needed: 2, opensAt: '0', closesAt: '9',
          } : null,
          raise: { proposal: 'b1'.repeat(32), payload: 'b2'.repeat(32), named: 'b3'.repeat(32), salt: 'b4'.repeat(32), opensAt: '0', closesAt: '9' },
        } }),
      },
      ...(i.secret === undefined ? {} : { run: { root: 'r', payees: '0', asset: '00'.repeat(32), copies: o.copies(await filedSecret()) } as never }),
    }),
    vaultAsDeployed: async () => ({ refusal: null }),
    /* The vault as this device's worker reads it at the wallet's indexer: held by the account's committee, pinned to the account, empty. */
    vaultOnChain: async () => ({
      onChain: true, state: 'QUJD', notes: [], notesFromThisBuild: true, everCreated: [],
      authority: { committee, threshold: 2 }, account: ACCOUNT, started: false,
    }),
    governedCall: async () => { asked.push('asked to raise or approve'); throw new Error('stop here'); },
    setNonceSecret: async () => { asked.push('built the set'); throw new Error('stop here'); },
  } as unknown as VaultBuilderClient;
  const result = await createCompanyVault({
    ...pacing, account: ACCOUNT, service, builder,
    indexer: async () => ({ indexerUri: 'https://indexer.example/api/v3/graphql', indexerWsUri: 'wss://indexer.example/api/v3/graphql/ws' }),
    onChain: async (v: string) => ({
      /* The account held by the company's committee, which the vault was born held by. */
      holders: { committee, threshold: 2, seats: [], approvals: 1, adoptedVaults: [v], founding: '4a'.repeat(32), foundingCommittee: [{ tag: 'schnorr', value: '11'.repeat(32) }] },
    }),
    keys: { put: async () => {}, get: async () => null, forget: async () => {} },
    me, myRecordsKey: ada.recordsKey as never, records,
    signers: async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }],
    material: { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) },
    secretReaders: {
      company: CO, committeeKey: ada.committeeKey,
      /* Who holds the account and the vault, as Ada's own wallet read them for this check: the vault read off the vault itself. */
      read: async () => ({
        committee, threshold: 2, seats: o.seatsOnRead?.(++reads) ?? o.seats ?? [ada.seat, bo.seat],
        vault: { vault: VAULT, account: ACCOUNT, committee: o.vaultHeldBy ?? committee, threshold: 2 },
      }),
      roster: async () => o.roster ?? [ada.entry, bo.entry],
    },
  }, VAULT as never).catch((e: unknown) => e);
  return { result, asked };
};

const copyFor = (reader: string) => (secret: string) => ({ reader, parts: sealSecretCopy({ vault: VAULT, secret, reader }).map((p) => toHex(p)) });
const run = (...readers: string[]) => (secret: string) => readers.map((r) => copyFor(r)(secret));

describe('A SECRET RUN IS CHECKED, READER BY READER, BEFORE THIS DEVICE RAISES OR APPROVES IT', () => {
  it('a run sealed to exactly the company\'s signers goes on to be raised', async () => {
    const { result, asked } = await press({ readers: [ada.recordsKey, bo.recordsKey], copies: run(ada.recordsKey, bo.recordsKey) });
    /* The positive control: everything checked out, so the press asked the worker to raise the run. */
    expect(asked).toEqual(['asked to raise or approve']);
    expect(result).toBeInstanceOf(VaultStartOwed);
  });

  it('A KEY THE SERVICE SUBSTITUTES IS REFUSED BEFORE ANYTHING IS RAISED OR APPROVED', async () => {
    const { result, asked } = await press({ readers: [ada.recordsKey, theServices], copies: run(ada.recordsKey, theServices) });
    /* RED WHEN: the press checks only this signer's own key, as it did before. */
    expect(asked).toEqual([]);
    expect(result).toBeInstanceOf(VaultStartOwed);
    expect((result as Error).message).toMatch(/no signer of this company signed for/);
    /* RED WHEN: the readers checked are a list beside the run rather than the copies the run itself would write. */
    const honestList = await press({ readers: [ada.recordsKey, bo.recordsKey], copies: run(ada.recordsKey, theServices) });
    expect(honestList.asked).toEqual([]);
    expect((honestList.result as Error).message).toMatch(/no signer of this company signed for/);
  });

  it('A COPY TO A KEY THE WALLET DID NOT SIGN IS REFUSED, even when the service rewrote the roster to name it', async () => {
    const rewritten = { ...bo.entry, keys: { ...bo.entry.keys!, recordsKey: theServices as never } };
    const { result, asked } = await press({
      readers: [ada.recordsKey, theServices], copies: run(ada.recordsKey, theServices), roster: [ada.entry, rewritten],
    });
    /* RED WHEN: the roster's word for a records key is taken without the wallet's signature over it. */
    expect(asked).toEqual([]);
    expect((result as Error).message).toMatch(/was not signed by Bo's own wallet/);
  });

  it('a run that leaves a signer out is refused, naming them', async () => {
    const { result, asked } = await press({ readers: [ada.recordsKey], copies: run(ada.recordsKey) });
    expect(asked).toEqual([]);
    expect((result as Error).message).toMatch(/would not be sealed to Bo/);
  });

  it('A SIGNER WHOSE OWN COPY DOES NOT OPEN IS TOLD SO, and nothing is raised', async () => {
    /* Every reader checks out; this signer's own copy in the run is sealed for another vault. */
    const wrongVault = (secret: string) => [
      { reader: ada.recordsKey, parts: sealSecretCopy({ vault: 'cd'.repeat(32), secret, reader: ada.recordsKey }).map((p) => toHex(p)) },
      copyFor(bo.recordsKey)(secret),
    ];
    const { result, asked } = await press({ readers: [ada.recordsKey, bo.recordsKey], copies: wrongVault });
    /* RED WHEN: this device approves a run whose copy for it does not open with its own key. */
    expect(asked).toEqual([]);
    expect((result as Error).message).toMatch(/does not open with the key your own recovery words give/);
  });

  it('A VAULT THE SIGNER\'S OWN WALLET READS HELD BY ANY OTHER COMMITTEE THAN THE ACCOUNT\'S IS REFUSED, WHATEVER THE SERVICE REPORTS', async () => {
    const temporary = { tag: 'schnorr', value: '77'.repeat(32) };
    const { result, asked } = await press({
      readers: [ada.recordsKey, bo.recordsKey], copies: run(ada.recordsKey, bo.recordsKey), vaultHeldBy: [ada.committeeKey, temporary],
    });
    /* RED WHEN: the vault's own committee, as the chain shows it, is not what the account's committee is held to. */
    expect(asked).toEqual([]);
    expect((result as Error).message).toMatch(/vault is not held by the same committee/);
  });

  it('A SIGNER REPLACED AT THE SAME COUNT, WHOSE OLD STATEMENT THE SERVICE SERVES, IS REFUSED, AND NOTHING IS RAISED', async () => {
    /* Bo was replaced by Dee; the committee still lists Ada and Bo, and the service serves Bo's old entry. */
    const dee = 'de'.repeat(32);
    const { result, asked } = await press({ readers: [ada.recordsKey, bo.recordsKey], copies: run(ada.recordsKey, bo.recordsKey), seats: [ada.seat, dee] });
    /* RED WHEN: the device counts seats and does not hold Bo's signed seat to the seats the account holds now. */
    expect(asked).toEqual([]);
    expect((result as Error).message).toMatch(/the seat Bo's wallet signed their records key for is not one the company's account holds now/);
    expect((result as { stoppedAt?: string }).stoppedAt).toBe('seat-not-held');
  });

  it('a committee still holding a seat for somebody who has left is refused', async () => {
    const { result, asked } = await press({ readers: [ada.recordsKey, bo.recordsKey], copies: run(ada.recordsKey, bo.recordsKey), seats: [ada.seat] });
    expect(asked).toEqual([]);
    expect((result as Error).message).toMatch(/committee on the chain has 2 keys and its account seats 1 signer/);
  });
});

describe('THE READERS ARE READ AGAIN RIGHT BEFORE THE SECRET IS SET, NOT ONLY BEFORE THE RUN WAS RAISED', () => {
  it('an approved run whose readers still check out goes on to set the secret', async () => {
    const { asked } = await press({ readers: [ada.recordsKey, bo.recordsKey], copies: run(ada.recordsKey, bo.recordsKey), approved: true });
    /* The positive control: every read checked out, so the press built the set. */
    expect(asked).toEqual(['built the set']);
  });

  it('A SIGNER WHO LEFT AFTER THE RUN WAS CHECKED IS CAUGHT BY THE READ RIGHT BEFORE THE SET, AND NOTHING IS SET', async () => {
    const dee = 'de'.repeat(32);
    const { result, asked } = await press({
      readers: [ada.recordsKey, bo.recordsKey], copies: run(ada.recordsKey, bo.recordsKey), approved: true,
      /* Bo is seated for the check before the secret is filed and the check of the run's copies; he has left by the next read. */
      seatsOnRead: (n) => (n <= 2 ? [ada.seat, bo.seat] : [ada.seat, dee]),
    });
    /* RED WHEN: the check before the set is skipped, so a secret is set for a reader who has left. */
    expect(asked).toEqual([]);
    expect((result as { stoppedAt?: string }).stoppedAt).toBe('seat-not-held');
  });
});
