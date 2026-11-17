import type express from 'express';
import type { Hex } from '../core/crypto.js';
import type { FileStore } from '../core/store-file.js';
import type { Ledger } from '../core/ledger.js';
import type { Startup } from '../wiring/product.js';
import { storeDir } from '../wiring/deployment.js';
import type { HandedInWiring } from '../wiring/handed-in.js';
import type { ContractBook } from '../wiring/account-contract.js';
import type { WriteCapability } from '../wiring/write-capability.js';
import type { theNetwork } from '../midnight/network.js';
import { appendRefusal } from './refusal-log.js';
import {
  mountVaultRecords, openedOnFirstUse, vaultAccountFromTheIndexer, type VaultAccountReader,
} from './vault-records-authority.js';
import { openVaultRecords, refuseVaultsTheOperatorToolsKeep, type RecordsSql } from '../db/vault-records.js';
import { readersRoutes } from './readers-route.js';
import { companyRecordsRoutes, type withTheRosterIn } from './company-records-route.js';
import { invitationRoutes } from './invitations-route.js';
import { peopleRoutes } from './people-route.js';
import { closedOnChain } from './proposal-closed-on-chain.js';
import { proposalRelayRoutes } from './proposal-relays.js';
import { runRoutes } from './run-routes.js';
import { filedAsIn, recordManifestRoutes } from './record-manifest-route.js';
import { signerRoutes } from './signer-routes.js';
import { MemorySealedPoolStore, type SealedPoolStore } from '../midnight/vault-pool.js';
import type { CompanyRecordStore, PeopleRecords, WireRecord } from '../midnight/sealed-record-wire.js';
import { accountCreationRoutes } from './account-creation.js';
import { companyVaultRoutes, type VaultChain } from './company-vaults.js';
import {
  directoryChainFromTheContract, directoryOf, filerSeatNow, seatDirectoryRoutes, type AccountHolds, type DirectoryChainRead,
} from './seat-directory-route.js';
import { ledger as readAccountLedger, pureCircuits as accountPure } from '../../contracts/managed/contract/index.js';
import { adoptionRoundOf, firstSecretRunCarriedOf, type AccountStartPure, type VaultStartPure } from '../midnight/vault-start.js';
import { pureCircuits as vaultPure } from '../../contracts/managed-vault/contract/index.js';
import { vaultArtefactPlaces, vaultArtefactRoutes } from './vault-artefacts.js';
import {
  accountCreationExpectationsIn, accountTemporaryVerifyingKey, accountVerifierKeysIn, committeeChangeWith, vaultChainFromTheIndexer,
  vaultVerifierKeysIn,
} from './vault-chain.js';
import { DEPLOYED_CIRCUITS } from '../midnight/deferral.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { publicDataProviderAt } from '../midnight/providers.js';
import { readProvenTransaction, readFinishedTransaction } from '../wiring/proven-submission.js';

/** What the routes below are built from: the parts the server made at start, and its sign-in and membership gates. */
export interface RecordsAndChainParts {
  readonly recordsSql: RecordsSql | null;
  readonly startup: Startup;
  readonly handed: HandedInWiring | null;
  readonly ledger: Ledger;
  readonly store: FileStore;
  readonly book: ContractBook;
  readonly companyRecords: CompanyRecordStore & PeopleRecords;
  readonly companyRecordStore: ReturnType<typeof withTheRosterIn>;
  readonly writeCapability: WriteCapability | undefined;
  readonly NETWORK: ReturnType<typeof theNetwork>;
  readonly authed: express.RequestHandler;
  readonly member: express.RequestHandler;
  readonly ownsPerson: express.RequestHandler;
  readonly ownsProposal: express.RequestHandler;
  readonly refuseSigningSecret: express.RequestHandler;
  readonly meteredOfferLookup: (req: express.Request, res: express.Response) => Promise<boolean>;
}

/** What the chain and the records are read through, made once and shared by every route below. */
interface ChainReads {
  readonly records: { of(record: WireRecord): SealedPoolStore };
  readonly accountOf: VaultAccountReader;
  readonly theChain: VaultChain;
  readonly directoryChain: DirectoryChainRead;
  readonly directoryNow: (accountId: string, also?: readonly string[]) => ReturnType<typeof directoryOf>;
}

/*
 * **A VAULT'S SEALED RECORDS: ITS NOTE POOL, ITS TWO JOURNALS AND ITS NONCE
 * SECRET, KEPT HERE AND OPENED ONLY ON A SIGNER'S DEVICE.**
 *
 * Who may read and file them is answered by the chain and the account records:
 * the vault's ledger names the company's account, and the person must be an
 * active signer of the company with that address. Every filing is signed.
 * Without a database the records are kept in this process only, which is for
 * development and says so.
 */
export async function mountRecordsAndChainRoutes(app: express.Express, parts: RecordsAndChainParts): Promise<void> {
  const reads = await chainReadsOf(parts);
  companyRecordRoutes(app, parts, reads);
  proposalRoutes(app, parts, reads);
  await vaultRoutes(app, parts, reads);
}

async function chainReadsOf(parts: RecordsAndChainParts): Promise<ChainReads> {
  const { recordsSql, startup, handed, ledger, store, NETWORK } = parts;
  /*
   * Opened at the first request rather than at start, so a database that is not
   * answering refuses the records it holds and does not stop the server; and
   * asked about its durability on that first open, as the store requires.
   */
  const sqlForRecords = recordsSql;
  if (!sqlForRecords) {
    console.warn('     A vault\'s sealed records are in memory too, and a restart loses them.\n');
  }
  const records: { of(record: WireRecord): SealedPoolStore } = sqlForRecords
    ? openedOnFirstUse(() => openVaultRecords(sqlForRecords, {
      refuseToCreate: refuseVaultsTheOperatorToolsKeep(storeDir(process.cwd(), NETWORK)),
    }))
    : (() => {
      const kept = new Map<WireRecord, SealedPoolStore>();
      return { of: (record: WireRecord) => kept.get(record) ?? kept.set(record, new MemorySealedPoolStore()).get(record)! };
    })();
  const accountOf: VaultAccountReader = startup.started
    ? vaultAccountFromTheIndexer(await publicDataProviderAt(startup.deployment))
    : async () => { throw new Error(startup.refusal); };
  const refusingChain: VaultChain = {
    contractState: async () => { throw new Error(startup.started ? 'unreachable' : startup.refusal); },
    serialize: () => { throw new Error('no chain'); },
    notesOf: () => { throw new Error('no chain'); },
    startingLedgerOf: () => { throw new Error('no chain'); },
    everCreated: async () => { throw new Error(startup.started ? 'unreachable' : startup.refusal); },
  };
  const theChain = startup.started
    ? await vaultChainFromTheIndexer({ url: startup.deployment.indexerUrl, wsUrl: startup.deployment.indexerWsUrl })
    : refusingChain;
  /*
   * WHAT THE CHAIN SAYS OF A COMPANY'S ACCOUNT NOW, read by this server: its committee, the seats it holds of those
   * asked about, and its approval threshold. Every seat directory this server believes is replayed against it. A
   * test that hands in a simulated ledger hands in this read with it (`handInWiring`); nothing shipped can.
   */
  const directoryChain: DirectoryChainRead = handed?.directoryChain ?? directoryChainFromTheContract({
    addressOf: async (accountId) => (await ledger.address(accountId))?.value ?? null,
    contractState: (address) => theChain.contractState(address as Hex),
    readLedger: (data) => readAccountLedger(data as never) as unknown as AccountHolds,
  });
  const directoryNow = (accountId: string, also?: readonly string[]) => directoryOf(store, directoryChain, accountId, also);
  return { records, accountOf, theChain, directoryChain, directoryNow };
}

function companyRecordRoutes(app: express.Express, parts: RecordsAndChainParts, reads: ChainReads): void {
  const { authed, member, ownsPerson, meteredOfferLookup, store, ledger, companyRecords, companyRecordStore } = parts;
  const { records, accountOf, directoryNow } = reads;
  mountVaultRecords(app, {
    signedIn: (req, res, next) => authed(req, res, next),
    records, accountOf, companies: () => store.listAccounts(),
    mayFileUnder: async (companyId, person, filer) =>
      typeof filerSeatNow(await directoryNow(companyId), person, filer) !== 'string',
  });

  app.use(companyRecordsRoutes({
    signedIn: (req, res, next) => authed(req, res, next),
    member: (req, res, next) => member(req, res, next),
    records: companyRecordStore,
    accountOf: (accountId) => store.getAccount(accountId),
    directoryOf: directoryNow,
  }));
  /* A company's readers, kept only when its signers at the seat bar signed them (`readers-route.ts`). */
  app.use(readersRoutes({ signedIn: (req, res, next) => authed(req, res, next), member: (req, res, next) => member(req, res, next), store, directoryOf: directoryNow }));
  app.use(invitationRoutes({
    signedIn: (req, res, next) => authed(req, res, next),
    member: (req, res, next) => member(req, res, next),
    store, records: () => companyRecordStore,
    directoryOf: directoryNow,
    meterOffer: (req, res) => meteredOfferLookup(req, res),
    recordRefusal: appendRefusal,
  }));
  app.use(peopleRoutes({
    signedIn: (req, res, next) => authed(req, res, next),
    member: (req, res, next) => member(req, res, next),
    ownsPerson: (req, res, next) => ownsPerson(req, res, next),
    store, records: () => companyRecordStore, people: () => companyRecords,
    directoryOf: directoryNow,
  }));
  /* A COMPANY'S SIGNERS: admitted, their vault keys offered, and the roster filed, each from a seat's own device. */
  app.use(signerRoutes({
    signedIn: (req, res, next) => authed(req, res, next),
    member: (req, res, next) => member(req, res, next),
    store, records: () => companyRecordStore, ledger, directoryOf: directoryNow,
  }));
  /* A COMPANY'S PAYROLL RUNS: drawn, sealed and signed on a signer's own device, and kept as they are given. */
  app.use(runRoutes({
    signedIn: (req, res, next) => authed(req, res, next),
    member: (req, res, next) => member(req, res, next),
    store, directoryOf: directoryNow, wiring: () => ledger.wiring ?? null,
  }));
}

function proposalRoutes(app: express.Express, parts: RecordsAndChainParts, reads: ChainReads): void {
  const { authed, member, ownsProposal, refuseSigningSecret, store, ledger, startup } = parts;
  const { theChain, directoryNow } = reads;
  /*
   * A COMPANY'S PROPOSALS: a raise, an approval or a withdrawal a signer's device proved, relayed for a seat that may act,
   * and where each stands read off the chain. Nothing here holds a key.
   */
  app.use(proposalRelayRoutes({
    signedIn: (req, res, next) => authed(req, res, next),
    ownsProposal: (req, res, next) => ownsProposal(req, res, next),
    refuseSigningSecret: (req, res, next) => refuseSigningSecret(req, res, next),
    member: (req, res, next) => member(req, res, next),
    store, ledger, directoryOf: directoryNow, recordRefusal: appendRefusal,
    wiring: () => ledger.wiring ?? null,
    /* A proposal's identity is the contract's on every wiring, as the device that raised it made it. */
    proposalIdOf: (payloadHash, salt, vault) => MidnightCommitments.proposalId(payloadHash as Hex, salt as Hex, vault as Hex | undefined),
    /* A vault's adoption, as the account's own functions make it, and the vaults its account lists on the chain now. */
    adoptionOf: (vault, again) => adoptionRoundOf(accountPure as unknown as AccountStartPure, vault, again),
    /* How the chain closed a proposal, read from the account's own history at this deployment's indexer. */
    closedOnChain: async (accountId, chainId) => {
      if (!startup.started) return 'unknown';
      const address = (await ledger.address(accountId))?.value ?? null;
      if (address === null) return 'unknown';
      const [{ indexerContractHistory }, runtime, chainLedger] = await Promise.all([
        import('../midnight/contract-history.js'), import('@midnight-ntwrk/compact-runtime'), import('@midnightntwrk/ledger-v9'),
      ]);
      const history = indexerContractHistory(startup.deployment.indexerUrl, startup.deployment.indexerWsUrl);
      return closedOnChain({
        accountPure, accountLedger: (data) => readAccountLedger(data as Parameters<typeof readAccountLedger>[0]), runtimeState: (runtime as { ContractState: unknown }).ContractState, ledger: chainLedger,
        history: (account) => history.of(account),
      }, String(address).toLowerCase().replace(/^0x/u, ''), chainId);
    },
    /* The chain's own time: the newest block this deployment's indexer names, read with the account, in milliseconds. */
    chainTimeOf: async (accountId) => {
      if (!startup.started) throw new Error(startup.refusal);
      const address = (await ledger.address(accountId))?.value ?? null;
      if (address === null) throw new Error('this company has no account on the chain');
      const { accountPresenceAt } = await import('../../packages/web-shared/src/vault-on-chain-here.js');
      return (await accountPresenceAt(startup.deployment.indexerUrl, String(address).toLowerCase().replace(/^0x/u, ''))).blockTime;
    },
    vaultsAdopted: async (accountId) => {
      const address = (await ledger.address(accountId))?.value ?? null;
      if (address === null) return null;
      if (theChain.accountVaults === undefined) return null;
      try { return await theChain.accountVaults(address as Hex); } catch { return null; }
    },
    /* A vault's first secret run made again from its public parts, and the secret a vault holds on the chain now. */
    firstSecretRunOf: (vault, parts) => firstSecretRunCarriedOf(
      { vault: vaultPure as unknown as VaultStartPure, account: accountPure as unknown as AccountStartPure }, vault, parts),
    vaultSecretOf: async (vault) => {
      try {
        const state = await theChain.contractState(vault);
        if (state === null || state === undefined) return { commitment: '00'.repeat(32), started: false };
        const held = theChain.startingLedgerOf(state);
        return { commitment: held.nonceCommitment, started: held.started };
      } catch { return null; }
    },
  }));
}

async function vaultRoutes(app: express.Express, parts: RecordsAndChainParts, reads: ChainReads): Promise<void> {
  const { authed, member, store, ledger, startup, book, companyRecordStore, writeCapability, NETWORK } = parts;
  const { records, theChain, directoryChain, directoryNow } = reads;
  /*
   * A COMPANY'S VAULTS: created, handed to the company's committee and funded
   * from its signers' own devices. Mounted before the general parser for the
   * same reason as the records above: a deploy is larger than most bodies.
   */
  app.use(vaultArtefactRoutes(vaultArtefactPlaces(process.cwd(), process.env)));
  /*
   * A COMPANY'S SEAT DIRECTORY: every filing served whole, each new one checked against this server's own read of
   * the account on the chain - its committee, the seats it holds now and its approval threshold.
   */
  app.use(seatDirectoryRoutes({
    signedIn: (req, res, next) => authed(req, res, next),
    member: (req, res, next) => member(req, res, next),
    store,
    chain: directoryChain,
  }));
  /*
   * A COMPANY'S MANIFEST: an entry for every filing and a header for every batch a seat anchored, each signed by its
   * seat and served whole, for every device to fold into the anchor the chain holds.
   */
  app.use(recordManifestRoutes({
    signedIn: (req, res, next) => authed(req, res, next),
    member: (req, res, next) => member(req, res, next),
    store, directoryOf: directoryNow,
    filedAs: filedAsIn({
      company: companyRecordStore, vault: records,
      runs: (company) => store.listRuns(company), proposals: (company) => store.listProposals(company),
    }),
  }));
  /*
   * A COMPANY'S ACCOUNT, deployed by its founding signer's device held by their own key, and paid for here: read
   * against what was recorded when the company was made, recorded before it is sent, and finished by its second step.
   */
  const creationExpected = accountCreationExpectationsIn(process.cwd());
  app.use(accountCreationRoutes({
    signedIn: (req, res, next) => authed(req, res, next),
    member: (req, res, next) => member(req, res, next),
    store,
    ledger,
    contractState: (address) => theChain.contractState(address),
    register: (accountId, address) => book.record(accountId, address),
    readers: { proven: readProvenTransaction },
    expected: creationExpected,
    records: companyRecordStore,
    proposalIdOf: (payload, salt) => MidnightCommitments.proposalId(payload, salt),
  }));
  app.use(companyVaultRoutes({
    signedIn: (req, res, next) => authed(req, res, next),
    member: (req, res, next) => member(req, res, next),
    store,
    company: async (accountId) => {
      const [address, status] = await Promise.all([ledger.address(accountId), ledger.status(accountId)]);
      if (!address || !status) return null;
      return {
        address: address.value as Hex,
        threshold: status.threshold,
        seats: status.signerCount,
        vaultThresholds: status.vaultThresholds.map((v) => ({ vault: v.vault as Hex, threshold: v.threshold })),
      };
    },
    ledger,
    chain: theChain,
    verifierKeys: vaultVerifierKeysIn(process.cwd()),
    /* The temporary key this deployment once created accounts under, so a seat it still holds is named as this service's. */
    account: {
      circuits: DEPLOYED_CIRCUITS,
      verifierKeys: accountVerifierKeysIn(process.cwd()),
      temporaryKey: startup.started ? await accountTemporaryVerifyingKey(writeCapability?.maintenanceAuthority) : undefined,
    },
    readers: { proven: readProvenTransaction, finished: readFinishedTransaction },
    /* A change of the super admins is signed on their own devices; this deployment signs none of it. */
    committeeChange: startup.started ? committeeChangeWith(NETWORK) : undefined,
  }));
}
