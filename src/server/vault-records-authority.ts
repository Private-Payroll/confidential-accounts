/**
 * **WHO MAY READ AND FILE A VAULT'S SEALED RECORDS: THE SIGNERS OF THE COMPANY
 * THE VAULT IS MARRIED TO, AS THE CHAIN SAYS IT IS.**
 *
 * This product keeps no list of which vault belongs to which company, on
 * purpose. It does not need one. A vault's ledger pins the company's account
 * contract when the vault is created, and nothing can change it afterwards, so
 * the chain answers *which company is this vault's*. This product's own store
 * answers *which company has that account address* and *who its signers are*.
 *
 *   · **read** and **file**: the person is an active signer of that company
 *     (`memberUserIds`, the one list of signers this server can read);
 *   · **file** also carries a valid signature, checked before this is asked.
 *
 * **WHICH SIGNING KEY IS A SIGNER'S IS NOT A QUESTION THIS SERVER CAN ANSWER.**
 * The company's roster, with each signer's signing key, is sealed under the
 * company's viewing key, and this server does not hold it. So the check that a
 * filing's key is on the roster is made where the roster opens: on the device
 * that reads the record (`HttpSealedPoolStore`, `trustFiledBy`). What this
 * server refuses is anybody who is not a signer of the vault's company, and
 * any filing that is not signed over exactly what it is.
 *
 * **EVERY OTHER ANSWER IS NO**, and a chain that cannot be read is not a no: it
 * is thrown, so the route says the decision could not be made rather than that
 * the person may not act. A vault the chain does not know, a vault married to
 * an account no company here has, a person on no roster, a filing with no
 * checked signature: each is refused. An address whose state is not a vault's
 * cannot be read as one, and is answered as a decision that could not be made.
 *
 * Nothing here opens a record or holds anything that could.
 */
import express from 'express';
import type { Hex } from '../core/crypto.js';
import type { WireRecord } from '../midnight/sealed-record-wire.js';
import type { SealedPoolStore } from '../midnight/vault-pool.js';
import { vaultRecordsRoutes, VAULT_RECORD_BODY_LIMIT, type MayTouchVaultRecords } from './vault-records-route.js';

/** The account a vault's ledger is pinned to, read from the chain; `null` when the chain has no such vault. */
export type VaultAccountReader = (vault: Hex) => Promise<Hex | null>;

/** What this product's store says about a company, as this decision needs it. */
export interface CompanyRoster {
  readonly id: string;
  readonly contractAddress?: string | null;
  /** The people who are active signers of the company. */
  readonly memberUserIds: readonly string[];
}

const HEX64 = /^[0-9a-f]{64}$/u;
const fold = (h: string): string => h.trim().toLowerCase().replace(/^0x/u, '');

/**
 * **THE ANSWER TO WHO MAY TOUCH WHICH VAULT'S RECORDS**, from the chain's pin and
 * this product's rosters.
 */
/**
 * The filing key a person gave for a company (`VaultKeysOfASigner.filingKey`),
 * or null when they have given none.
 */
export type FilingKeyOf = (companyId: string, person: string) => Hex | null;

export const signersOfTheVaultsCompany = (deps: {
  readonly accountOf: VaultAccountReader;
  readonly companies: () => readonly CompanyRoster[];
  /**
   * **WHO A FILING IS FROM, BOUND TO WHO SENT IT.** When given, a person may
   * file only records signed with the one filing key they gave for that
   * company, so a version on record is always attributable to the member who
   * filed it, and no member files under a key they did not give.
   */
  readonly filingKeyOf?: FilingKeyOf;
}): MayTouchVaultRecords => async (person: string, vault: string, _record: WireRecord, act, filer?: Hex) => {
  if (typeof person !== 'string' || person.length === 0) return false;
  if (!HEX64.test(vault)) return false;
  if (act === 'file' && (typeof filer !== 'string' || !HEX64.test(filer))) return false;
  let pinned: string | null;
  try {
    pinned = await deps.accountOf(vault);
  } catch (e) {
    /*
     * A contract the chain holds that is not a vault belongs to no company, so
     * nobody may touch records under it: that is a refusal, not a question
     * left undecided. Every other failure still is one.
     */
    if (e instanceof NotAVaultsState) return false;
    throw e;
  }
  if (pinned === null) return false;
  if (typeof pinned !== 'string' || !HEX64.test(fold(pinned))) {
    throw new Error('the chain answered for this vault\x27s account with something that is not an address');
  }
  const matches = deps.companies().filter((c) => typeof c.contractAddress === 'string'
    && fold(c.contractAddress) === fold(pinned));
  /* Two companies claiming one account is this store disagreeing with itself; nobody is let in on it. */
  if (matches.length !== 1) return false;
  const company = matches[0]!;
  if (!company.memberUserIds.includes(person)) return false;
  if (act !== 'file' || deps.filingKeyOf === undefined) return true;
  const given = deps.filingKeyOf(company.id, person);
  return typeof given === 'string' && fold(given) === fold(filer!);
};

/** A contract state the chain holds and the vault's ledger cannot read: not a vault. */
export class NotAVaultsState extends Error {}

/**
 * **THE CHAIN READER THE PRODUCT USES**: the vault's contract state from the
 * indexer, read through the vault's own compiled ledger. A state the indexer
 * does not have is `null`; one it has and cannot be read is thrown.
 */
export const vaultAccountFromTheIndexer = (query: {
  queryContractState(address: string): Promise<{ data: unknown } | null | undefined>;
}, readLedger?: (data: unknown) => { account: { bytes: Uint8Array } }): VaultAccountReader => async (vault) => {
  const state = await query.queryContractState(vault);
  if (state === null || state === undefined) return null;
  const read = readLedger ?? (await import('../../contracts/managed-vault/contract/index.js')).ledger as never as
    (data: unknown) => { account: { bytes: Uint8Array } };
  let bytes: Uint8Array;
  try {
    bytes = read(state.data).account.bytes;
  } catch (cause) {
    throw new NotAVaultsState('this contract\x27s state could not be read as a vault\x27s, so which company it belongs to is not known', { cause });
  }
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new NotAVaultsState('this vault\x27s pinned account is not thirty-two bytes');
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * **MOUNTS A VAULT'S SEALED RECORDS ON THE PRODUCT'S SERVER**: behind the
 * sign-in, and answering who may read and file from the chain's pin and the
 * company rosters. The one place the server does it, so what is tested is what
 * runs.
 *
 * **MOUNTED BEFORE THE API'S GENERAL BODY PARSER, AND IT PARSES ITS OWN BODIES
 * AFTER THE SIGN-IN.** A journal is sent whole and grows by one line per
 * attempt, so these bodies may be far larger than the rest of the API allows;
 * a body parsed here is left alone by the general parser after it. Parsing
 * after the sign-in means nobody who is not signed in can make this server read
 * a large body.
 */
export const mountVaultRecords = (app: express.Express, deps: {
  /** The sign-in: sets the person, or answers the request itself. */
  readonly signedIn: express.RequestHandler;
  readonly records: { of(record: WireRecord): SealedPoolStore };
  readonly accountOf: VaultAccountReader;
  readonly companies: () => readonly CompanyRoster[];
  /** Required on the product's mount: every filing is bound to the key its filer gave. */
  readonly filingKeyOf: FilingKeyOf;
}): void => {
  app.use('/api/vaults', deps.signedIn, express.json({ limit: VAULT_RECORD_BODY_LIMIT }));
  app.use(vaultRecordsRoutes({
    records: deps.records,
    mayTouch: signersOfTheVaultsCompany({
      accountOf: deps.accountOf, companies: deps.companies, filingKeyOf: deps.filingKeyOf,
    }),
  }));
};

/**
 * **A STORE OF VAULT RECORDS OPENED WHEN IT IS FIRST USED.** Opening asks the
 * database a question; a database that does not answer refuses the request that
 * needed it, and the next request asks again.
 */
export const openedOnFirstUse = (
  open: () => Promise<{ of(record: WireRecord): SealedPoolStore }>,
): { of(record: WireRecord): SealedPoolStore } => {
  let opened: Promise<{ of(record: WireRecord): SealedPoolStore }> | null = null;
  const store = () => {
    if (opened === null) {
      opened = open();
      opened.catch(() => { opened = null; });
    }
    return opened;
  };
  return {
    of: (record) => ({
      get: async (vault) => (await store()).of(record).get(vault),
      versions: async (vault) => (await store()).of(record).versions(vault),
      put: async (vault, rec) => (await store()).of(record).put(vault, rec),
      at: async (vault, version) => {
        const s = (await store()).of(record);
        return s.at ? s.at(vault, version) : (await s.versions(vault)).find((v) => v.version === version)?.sealed ?? null;
      },
    }),
  };
};

/**
 * **A SERVER THAT WRITES TO A REAL CHAIN DOES NOT KEEP A VAULT'S RECORDS IN
 * MEMORY.** A vault's note pool, journals and nonce secret are filed here; in
 * memory they are gone at the next restart, and every deposit the lost nonce
 * secret named is then named by nothing. So a process whose deployment reaches
 * a chain refuses to start without a database, and says why.
 */
export function whyVaultRecordsCannotBeKept(input: {
  readonly reachesAChain: boolean;
  readonly database: boolean;
}): string | null {
  if (!input.reachesAChain || input.database) return null;
  return 'this server writes to a chain and has no database, so a vault\'s records - its note pool, '
    + 'its journals and the secret its deposits are named by - would be held in memory and lost at the '
    + 'next restart, and money deposited under them would be named by nothing. Set DATABASE_URL and '
    + 'start again.';
}
