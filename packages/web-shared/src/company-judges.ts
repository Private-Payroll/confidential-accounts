import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import type { Hex } from '../../../src/core/crypto.js';
import type { Account, SealedAccount } from '../../../src/core/types.js';
import type { CompanyKeys, KeysHeld } from '../../../src/core/company-key.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { companyKeyHere, keysInTheFilings, type CompanyKeyHere } from './company-key-here.js';
import { vouchedRunsHere } from './run-rebuilt-here.js';
import { governedCallServiceFor } from './governed-call-on-device.js';
import { rosterBelievedHere, RosterNotBelieved, seatsAdmittedHere, type BelievedAccount, type RosterReads } from './roster-here.js';
import {
  attestedIn, directoryFilingsFrom, directoryHere, directoryJudge, directoryWithItsRecordsHere, type DirectoryHereDeps, type DirectoryRead,
} from './vault-page-doors.js';
import type { FreshJudge } from './http-sealed-pool-store.js';
import { manifestServiceFor, treeServiceFor } from './record-entered-here.js';
import type { TreeKept } from './tree-kept-here.js';
import { anchorsOnChainAt, heldFor, type AnchorDoors } from './records-anchored-here.js';
import { tagSeatsHere } from './seat-openings-here.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import type { AccountKeys } from './keyring-blob.js';
import type { RefusedEntry } from '../../../src/core/roster-record.js';

/*
 * WHO A DEVICE BELIEVES FILED A COMPANY'S RECORDS, the one way every reader
 * asks it, wherever it runs: the company's seat directory read again, who
 * holds the account now as the device's own chain read says, and the
 * records-key statements in the roster it opened - all of it afresh for every
 * read, so no read rests on one made before it. Every record the service holds
 * is taken as a claim and judged here against the chain and the directory; the
 * doors say where the device reads the chain, the service and its own keys.
 * The page and the wallet each build one set of these from their own doors.
 */

type Api = (path: string, init?: RequestInit) => Promise<any>;

/** A company as a device believes it: its roster record opened and each entry held to its own signer's witnesses. */
export type OpenedAccount = BelievedAccount & { readonly refused: readonly RefusedEntry[] };

type Holders = (company: CompanyLabel, account: AccountAddress) => Promise<AccountHoldersRead>;
type Anchored = (accountId: string, company: CompanyLabel, account: AccountAddress) => DirectoryHereDeps['anchored'];
type Leaves = (company: CompanyLabel, account: AccountAddress) => DirectoryHereDeps['leaves'];
type SealedWithRoster = SealedAccount & { readonly roster?: SealedCompanyRecord | null };

/** A seat as a judge sees it: its signer id and signing public key, nothing that signs or opens. */
interface SeatShownToAJudge {
  readonly signerId: string;
  readonly signingPublicKey: string;
}

/** Where a device reads what a judgement needs: the service, the chain, its own builder and its own keys. */
interface CompanyJudgeDoors {
  /** The company's service, every answer a claim. */
  readonly api: Api;
  /** Who holds the company's account now, as this device's own chain read says. */
  readonly holders: Holders;
  /** The indexer this device reads the chain through, or null when it has none. */
  readonly indexer: (company: CompanyLabel, account: AccountAddress) => Promise<{ readonly indexerUri: string; readonly indexerWsUri: string } | null>;
  readonly builder: () => Promise<VaultBuilderClient>;
  /**
   * This device's seat on a company, by its public halves only, or null: its signer id and signing public key. A judge
   * reads with these and never with a seat's secret, on the page and in the wallet alike.
   */
  readonly keysFor: (companyId: string) => SeatShownToAJudge | null;
  /** The company's key as the service's sealed account wraps it to this seat; throws when it cannot be opened here. */
  readonly servedKeyFor: (sealed: { id: string; wrappedKeys: any[] }) => Hex;
  /** The company key the person's wallet released for this company, if it did. */
  readonly released: (companyId: string) => Hex | null;
  /** Asks for the released company key when none is held yet; null when it cannot be had. */
  readonly askReleased: (companyId: string) => Promise<Hex | null>;
  /** This device's own copy of the records' tree as it anchored them. */
  readonly treeKept: () => TreeKept;
  /** Opens the company's roster as this device believes it (`openAccountWith`, or the page's own). */
  readonly openAccount: (rec: SealedWithRoster, holders: Holders, anchored: Anchored, leaves: Leaves, companyKeys?: (rec: SealedAccount) => Promise<KeysHeld>) => Promise<OpenedAccount | null>;
  /** The seats the company's roster admitted, read with the same doors (`seatsAdmittedWith`, or the page's own). */
  readonly seatsAdmittedFor: (rec: SealedWithRoster, holders: Holders, anchored: Anchored, leaves: Leaves, companyKeys?: (rec: SealedAccount) => Promise<KeysHeld>) => Promise<ReadonlySet<string>>;
  /** Throws what this device throws for a company that has no account on the chain yet. */
  readonly noAccount: () => never;
}

const NO_ACCOUNT_TO_READ_SIGNERS_BY = 'This company has no account on the chain that names who holds its seats, so this '
  + 'device does not read its signers.';

async function rosterReadWith(
  d: Pick<CompanyJudgeDoors, 'api' | 'keysFor' | 'servedKeyFor'>, rec: SealedWithRoster, holders: Holders, anchored: Anchored, leaves: Leaves,
  companyKeys?: (rec: SealedAccount) => Promise<KeysHeld>,
): Promise<Parameters<typeof rosterBelievedHere> | null> {
  const keys = d.keysFor(rec.id);
  let served: Hex;
  try {
    if (keys === null) return null;
    served = d.servedKeyFor(rec);
  } catch {
    return null;
  }
  const label = readCompanyLabel(rec.companyLabel ?? null);
  const account = readAccountAddress(rec.contractAddress ?? null);
  if (label === null || account === null) throw new RosterNotBelieved(NO_ACCOUNT_TO_READ_SIGNERS_BY);
  const viewingKey = companyKeys === undefined ? served : await companyKeys(rec);
  return [rec, viewingKey, {
    accountId: rec.id, label, account,
    reads: {
      filings: () => directoryFilingsFrom(d.api, rec.id), holders: () => holders(label, account), anchored: anchored(rec.id, label, account),
      leaves: leaves(label, account),
    },
    own: { signerId: keys.signerId, signingPublicKey: keys.signingPublicKey.toLowerCase() as Hex },
    proposals: async () => d.api(`/api/accounts/${encodeURIComponent(rec.id)}/proposals`),
  }];
}

/**
 * **THE COMPANY AS THIS DEVICE BELIEVES IT**, read from its roster record only
 * (`rosterBelievedHere`): filed by a seat the company's directory believes,
 * read afresh with the chain as `holders` reads it, each entry held to its own
 * signer's witnesses, this device's own key among them for its own entry. A
 * refusal throws `RosterNotBelieved`; each entry refused on its own is handed
 * back beside the company, with why. Null when this device holds no keys for
 * the company, or cannot open the company's key the service wrapped to it.
 */
export async function openAccountWith(
  d: Pick<CompanyJudgeDoors, 'api' | 'keysFor' | 'servedKeyFor'>, rec: SealedWithRoster, holders: Holders, anchored: Anchored, leaves: Leaves,
  companyKeys?: (rec: SealedAccount) => Promise<KeysHeld>,
): Promise<OpenedAccount | null> {
  const read = await rosterReadWith(d, rec, holders, anchored, leaves, companyKeys);
  if (read === null) return null;
  const believed = await rosterBelievedHere(...read);
  return { ...believed.account, refused: believed.refused };
}

/** The seats the company's roster admitted, read as `openAccountWith` reads them; throws when this device holds no keys for it. */
export async function seatsAdmittedWith(
  d: Pick<CompanyJudgeDoors, 'api' | 'keysFor' | 'servedKeyFor'>, rec: SealedWithRoster, holders: Holders, anchored: Anchored, leaves: Leaves,
  companyKeys?: (rec: SealedAccount) => Promise<KeysHeld>,
): Promise<ReadonlySet<string>> {
  const read = await rosterReadWith(d, rec, holders, anchored, leaves, companyKeys);
  if (read === null) throw new Error('this device holds no keys for the company, so it cannot read who its roster admitted.');
  return seatsAdmittedHere(...read);
}

/** The judges a device reads a company with, every one built from `d`. */
export function companyJudges(d: CompanyJudgeDoors) {
  /**
   * Every head the company's account's history shows, one per block, read in
   * the device's builder at the indexer its own chain read names, and from
   * nowhere else: never from the company's service.
   */
  const anchorsOnChainFor = (company: CompanyLabel, account: AccountAddress): AnchorDoors['onChain'] => async () =>
    anchorsOnChainAt(await d.builder(), account, await d.indexer(company, account));

  /** The company's key of each epoch, found in its directory's filings and each one checked there before it is used. */
  const keysFoundFor = async (
    companyId: string, sealed: SealedAccount, released: () => Promise<Hex | null> = async () => d.released(companyId),
  ): Promise<CompanyKeys> =>
    keysInTheFilings(companyId, await directoryFilingsFrom(d.api, companyId), { served: async () => d.servedKeyFor(sealed), released });

  /** How the anchor vouches for a run: its approved proposal, opened under the company's keys, and its identity worked out by the builder. */
  const vouchingFor = (companyId: string): NonNullable<AnchorDoors['vouching']> => ({
    runs: async (chainIds) => {
      const sealed = await d.api(`/api/accounts/${encodeURIComponent(companyId)}`) as SealedAccount;
      const proposals = await governedCallServiceFor(d.api).sealedProposals!(companyId);
      return vouchedRunsHere(proposals, companyId, await keysFoundFor(companyId, sealed), chainIds);
    },
    identity: async (run) => (await d.builder()).vouchedRunIdentity(run),
  });

  /** Each seat of the directory told apart from its published opening, against the seats the chain holds. */
  const tagSeatsFor = (account: AccountAddress): NonNullable<AnchorDoors['tagSeats']> => async (here) =>
    tagSeatsHere({ account, builder: await d.builder() }, here.dir.seats, here.holders.seats);

  /** Which records the company's anchor holds, read from the tree and the manifest the service keeps and checked against the chain's heads. */
  const anchoredHere = (companyId: string, company: CompanyLabel, account: AccountAddress): DirectoryHereDeps['anchored'] => async (directory, asked) => heldFor({
    accountId: companyId, tree: treeServiceFor(d.api), manifest: manifestServiceFor(d.api), ...d.treeKept(), onChain: anchorsOnChainFor(company, account),
    builder: await d.builder(), vouching: vouchingFor(companyId), tagSeats: tagSeatsFor(account),
  })(directory, asked);

  /** The leaf of each published opening, worked out by the builder, so a directory entry is matched to the seat the chain holds. */
  const leavesFor = (account: AccountAddress): DirectoryHereDeps['leaves'] => async (openings) =>
    (await (await d.builder()).seatOpenings({
      account, openings: openings.map((o) => ({ publicKey: o.publicKey, scope: o.scope, blinding: o.blinding })),
    })).openings.map((o) => o.leaf);

  /** What a roster is read with: the directory's filings, the chain's holders, what is anchored, and each opening's leaf. */
  const rosterReadsFor = (companyId: string, company: CompanyLabel, account: AccountAddress): RosterReads => ({
    filings: () => directoryFilingsFrom(d.api, companyId),
    holders: () => d.holders(company, account),
    anchored: anchoredHere(companyId, company, account),
    leaves: leavesFor(account),
    invitedSeats: async (proposals) => {
      const indexer = await d.indexer(company, account);
      /* No indexer named by the person's own wallet: no seat taken by an invitation by address is believed on this read. */
      return indexer === null ? {} : (await d.builder()).invitedSeats({ account, indexer, proposals });
    },
  });

  /**
   * The company's key for each epoch held here: the released key when the
   * wallet released one, asked for once and kept for the read; never more than
   * one ask in one read.
   */
  const releasedOnceHere = (companyId: string): (() => Promise<Hex | null>) => {
    let asked: Promise<Hex | null> | null = null;
    return async () => {
      const held = d.released(companyId);
      if (held !== null) return held;
      asked ??= d.askReleased(companyId).catch(() => null);
      return asked;
    };
  };

  const directoryDeps = (
    companyId: string, company: CompanyLabel, account: AccountAddress, viewingKey: CompanyKeys, roster: () => Promise<Pick<Account, 'signers'>>,
  ): DirectoryHereDeps => ({
    accountId: companyId,
    label: company,
    viewingKey,
    ...rosterReadsFor(companyId, company, account),
    attested: async () => attestedIn(await roster()),
  });

  /**
   * The company's key of each epoch this device can use, every one found in the directory's filings and believed there.
   * The seat is found by its signing key, or by that key's public half alone when the caller reads and signs nothing.
   */
  const companyKeysFor = async (
    companyId: string, sealed: SealedAccount, keys: Pick<AccountKeys, 'signingSecret'> | { readonly signingPublicKey: Hex },
  ): Promise<CompanyKeyHere> => {
    const company = sealed.companyLabel as CompanyLabel | undefined | null;
    const account = sealed.contractAddress as AccountAddress | undefined | null;
    if (company === undefined || company === null || account === undefined || account === null) return d.noAccount();
    const released = releasedOnceHere(companyId);
    const found = await keysFoundFor(companyId, sealed, released);
    return companyKeyHere({
      accountId: companyId, material: 'signingPublicKey' in keys ? { signingPublicKey: keys.signingPublicKey } : { signingSecret: keys.signingSecret },
      records: { directory: directoryHereFor(companyId, company, account, found, async () => ({ signers: [] })) },
      filings: () => directoryFilingsFrom(d.api, companyId),
      served: async () => d.servedKeyFor(sealed),
      released: () => d.released(companyId),
      askTheWallet: released,
    });
  };

  const companyKeysOf = (rec: SealedAccount): Promise<CompanyKeyHere> => {
    const keys = d.keysFor(rec.id);
    if (keys === null) throw new Error('this device holds no keys for the company, so it cannot open its key.');
    return companyKeysFor(rec.id, rec, { signingPublicKey: keys.signingPublicKey.toLowerCase() as Hex });
  };

  /** The company as this device believes it, its signers read from its roster record only, under the keys its directory believes. */
  const openedHere = (sealed: SealedAccount): Promise<OpenedAccount | null> =>
    d.openAccount(sealed, d.holders, anchoredHere, (_company, account) => leavesFor(account), companyKeysOf);

  /** The seats the company's roster admitted, read afresh with the same doors as `openedHere`. */
  const seatsAdmittedOn = (sealed: SealedAccount): Promise<ReadonlySet<string>> =>
    d.seatsAdmittedFor(sealed, d.holders, anchoredHere, (_company, account) => leavesFor(account), companyKeysOf);

  /** Whether a filing's signer is one the company's directory believes, read afresh for each filing judged. */
  const filingJudgeFor = (
    companyId: string, company: CompanyLabel, account: AccountAddress, viewingKey: CompanyKeys, roster: () => Promise<Pick<Account, 'signers'>>,
  ): FreshJudge => directoryJudge(directoryDeps(companyId, company, account, viewingKey, roster));

  /** The company's directory as this device believes it, read afresh at each call. */
  function directoryHereFor(
    companyId: string, company: CompanyLabel, account: AccountAddress, viewingKey: CompanyKeys, roster: () => Promise<Pick<Account, 'signers'>>,
  ): DirectoryRead {
    return (asked) => directoryHere(directoryDeps(companyId, company, account, viewingKey, roster), asked);
  }

  /** The directory with every record it names read beside it, for a device that anchors them. */
  const directoryWithItsRecordsFor = (
    companyId: string, company: CompanyLabel, account: AccountAddress, viewingKey: CompanyKeys, roster: () => Promise<Pick<Account, 'signers'>>,
  ): DirectoryRead => (asked) => directoryWithItsRecordsHere(directoryDeps(companyId, company, account, viewingKey, roster), asked);

  return Object.freeze({
    anchorsOnChainFor, keysFoundFor, vouchingFor, tagSeatsFor, anchoredHere, leavesFor, rosterReadsFor, releasedOnceHere,
    companyKeysFor, openedHere, seatsAdmittedOn, filingJudgeFor, directoryHereFor, directoryWithItsRecordsFor,
  });
}

