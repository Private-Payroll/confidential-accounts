import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import { signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import type { Account, SealedAccount } from '../../../src/core/types.js';
import type { CompanyKeys, KeysHeld } from '../../../src/core/company-key.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { CompanyKeyNotOpened, companyKeyHere, keysInTheFilings, type CompanyKeyHere, type CompanyKeyHereOptions } from './company-key-here.js';
import { vouchedRunsHere } from './run-rebuilt-here.js';
import { governedCallServiceFor } from './governed-call-on-device.js';
import { ROSTER_CHECK, rosterBelievedHere, RosterNotBelieved, seatsAdmittedHere, type BelievedAccount, type RosterReads } from './roster-here.js';
import { NoIndexerToReadTheChain } from './seat-not-read-on-the-chain.js';
import {
  attestedIn, directoryFilingsFrom, directoryHere, directoryJudge, directoryWithItsRecordsHere, type DirectoryHereDeps, type DirectoryRead,
} from './vault-page-doors.js';
import type { FreshJudge } from './http-sealed-pool-store.js';
import { manifestServiceFor, treeServiceFor } from './record-entered-here.js';
import { treeKeptInMemory, type TreeKept } from './tree-kept-here.js';
import { anchorsOnChainAt, heldFor, type AnchorDoors } from './records-anchored-here.js';
import { tagSeatsHere } from './seat-openings-here.js';
import { grantsServedBy, revokedAtHere } from './purpose-wraps.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import type { AccountKeys } from './keyring-blob.js';
import type { RefusedEntry } from '../../../src/core/roster-record.js';
import type { ProposalIdentityOf } from '../../../src/core/invitation.js';

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

/**
 * A company as a device believes it: its roster record opened and each entry held to its own signer's witnesses, with each
 * entry refused on its own. `waited` holds the seats the chain holds that the roster read waits for someone invited to be
 * admitted to; it is absent from a page's own opener that does not read them.
 */
export type OpenedAccount = BelievedAccount & { readonly refused: readonly RefusedEntry[]; readonly waited?: readonly string[] };

type Holders = (company: CompanyLabel, account: AccountAddress) => Promise<AccountHoldersRead>;
type Anchored = (accountId: string, company: CompanyLabel, account: AccountAddress) => DirectoryHereDeps['anchored'];
type Leaves = (company: CompanyLabel, account: AccountAddress) => DirectoryHereDeps['leaves'];
/** The seat each invitation's proposal took, as this device's own chain read says: what a seat taken by address is waited for and admitted by. */
type InvitedSeats = (company: CompanyLabel, account: AccountAddress) => NonNullable<RosterReads['invitedSeats']>;
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
  readonly openAccount: (
    rec: SealedWithRoster, holders: Holders, anchored: Anchored, leaves: Leaves, companyKeys?: (rec: SealedAccount) => Promise<KeysHeld>, invitedSeats?: InvitedSeats,
    identity?: ProposalIdentityOf,
  ) => Promise<OpenedAccount | null>;
  /** The seats the company's roster admitted, read with the same doors (`seatsAdmittedWith`, or the page's own). */
  readonly seatsAdmittedFor: (
    rec: SealedWithRoster, holders: Holders, anchored: Anchored, leaves: Leaves, companyKeys?: (rec: SealedAccount) => Promise<KeysHeld>, invitedSeats?: InvitedSeats,
    identity?: ProposalIdentityOf,
  ) => Promise<ReadonlySet<string>>;
  /** Throws what this device throws for a company that has no account on the chain yet. */
  readonly noAccount: () => never;
}

const NO_ACCOUNT_TO_READ_SIGNERS_BY = 'This company has no account on the chain that names who holds its seats, so this '
  + 'device does not read its signers.';

/**
 * The arguments a roster is read with on this device. Without `invitedSeats` a seat the chain holds that was taken on an
 * invitation by address is a read not made, so the roster stops while it leaves that seat out until Finish adding admits it;
 * without `identity` no directory entry made on such an invitation is believed, nor is such a seat admitted.
 */
async function rosterReadWith(
  d: Pick<CompanyJudgeDoors, 'api' | 'keysFor' | 'servedKeyFor'>, rec: SealedWithRoster, holders: Holders, anchored: Anchored, leaves: Leaves,
  companyKeys?: (rec: SealedAccount) => Promise<KeysHeld>, invitedSeats?: InvitedSeats, identity?: ProposalIdentityOf,
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
  if (label === null || account === null) throw new RosterNotBelieved(NO_ACCOUNT_TO_READ_SIGNERS_BY, null, null, { check: ROSTER_CHECK.noAccount });
  const viewingKey = companyKeys === undefined ? served : await companyKeys(rec);
  return [rec, viewingKey, {
    accountId: rec.id, label, account,
    reads: {
      filings: () => directoryFilingsFrom(d.api, rec.id), holders: () => holders(label, account), anchored: anchored(rec.id, label, account),
      leaves: leaves(label, account),
      ...(invitedSeats === undefined ? {} : { invitedSeats: invitedSeats(label, account) }),
      ...(identity === undefined ? {} : { proposalIdentity: identity }),
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
 * back beside the company, with why, and the seats the roster read waits for (`waited`). Null when this device holds no keys for
 * the company, or cannot open the company's key the service wrapped to it.
 */
export async function openAccountWith(
  d: Pick<CompanyJudgeDoors, 'api' | 'keysFor' | 'servedKeyFor'>, rec: SealedWithRoster, holders: Holders, anchored: Anchored, leaves: Leaves,
  companyKeys?: (rec: SealedAccount) => Promise<KeysHeld>, invitedSeats?: InvitedSeats, identity?: ProposalIdentityOf,
): Promise<OpenedAccount | null> {
  const read = await rosterReadWith(d, rec, holders, anchored, leaves, companyKeys, invitedSeats, identity);
  if (read === null) return null;
  const believed = await rosterBelievedHere(...read);
  return { ...believed.account, refused: believed.refused, waited: [...believed.held.waited] };
}

/** The seats the company's roster admitted, read as `openAccountWith` reads them; throws when this device holds no keys for it. */
export async function seatsAdmittedWith(
  d: Pick<CompanyJudgeDoors, 'api' | 'keysFor' | 'servedKeyFor'>, rec: SealedWithRoster, holders: Holders, anchored: Anchored, leaves: Leaves,
  companyKeys?: (rec: SealedAccount) => Promise<KeysHeld>, invitedSeats?: InvitedSeats, identity?: ProposalIdentityOf,
): Promise<ReadonlySet<string>> {
  const read = await rosterReadWith(d, rec, holders, anchored, leaves, companyKeys, invitedSeats, identity);
  if (read === null) throw new Error('this device holds no keys for the company, so it cannot read who its roster admitted.');
  return seatsAdmittedHere(...read);
}

/** Whether an error, or any error it was thrown from, is the refusal for a copy of the company's key the wallet has not released. */
const notOpenedIn = (e: unknown): boolean => {
  for (let at: unknown = e, depth = 0; at instanceof Error && depth < 8; at = at.cause, depth += 1) if (at instanceof CompanyKeyNotOpened) return true;
  return false;
};

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

  /*
   * The same records as a reader's wallet holds them: it has no seat and no company key, so it reads no run that vouched
   * for an anchor and tags no seat. An anchor this cannot reach is refused, never taken on the service's word; the next
   * act of any seat files a newer anchor that it reaches. **IT KEEPS NO CHECKPOINT BETWEEN READS**: a reader's act is
   * given its record id, label and account by the page, and nothing ties them together before the read, so the heads it
   * checks are held for that one read only and can never stand in for the heads this device keeps for the company.
   */
  const anchoredForAReader = (companyId: string, company: CompanyLabel, account: AccountAddress): DirectoryHereDeps['anchored'] => async (directory, asked) => heldFor({
    accountId: companyId, tree: treeServiceFor(d.api), manifest: manifestServiceFor(d.api), ...treeKeptInMemory(), onChain: anchorsOnChainFor(company, account),
    builder: await d.builder(),
  })(directory, asked);

  /** The leaf of each published opening, worked out by the builder, so a directory entry is matched to the seat the chain holds. */
  const leavesFor = (account: AccountAddress): DirectoryHereDeps['leaves'] => async (openings) =>
    (await (await d.builder()).seatOpenings({
      account, openings: openings.map((o) => ({ publicKey: o.publicKey, scope: o.scope, blinding: o.blinding })),
    })).openings.map((o) => o.leaf);

  /** A proposal's identity from its change and salt, worked out by the builder with the account's own functions. */
  const identityHere: ProposalIdentityOf = async (change, salt) => (await d.builder()).proposalIdentity(change, salt);

  /**
   * The seat each invitation's proposal took, read through the indexer this device's own chain read names, and nowhere
   * else. Every reader asks it through `seatsTakenAsked`, which gives a failed read its one meaning.
   */
  const invitedSeatsFor: InvitedSeats = (company, account) => async (proposals) => {
    const indexer = await d.indexer(company, account);
    /* No indexer named by the person's own wallet is a read not made, never an answer that no proposal took a seat, and pressing again cannot make it. */
    if (indexer === null) throw new NoIndexerToReadTheChain();
    return (await d.builder()).invitedSeats({ account, indexer, proposals });
  };

  /** What a roster is read with: the directory's filings, the chain's holders, what is anchored, each opening's leaf, and each invitation's seat. */
  const rosterReadsFor = (companyId: string, company: CompanyLabel, account: AccountAddress): RosterReads => ({
    filings: () => directoryFilingsFrom(d.api, companyId),
    holders: () => d.holders(company, account),
    anchored: anchoredHere(companyId, company, account),
    leaves: leavesFor(account),
    invitedSeats: invitedSeatsFor(company, account),
    proposalIdentity: identityHere,
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
    unreleased?: CompanyKeyHereOptions['unreleased'],
  ): Promise<CompanyKeyHere> => {
    const quietly = unreleased === 'not-opened';
    const company = sealed.companyLabel as CompanyLabel | undefined | null;
    const account = sealed.contractAddress as AccountAddress | undefined | null;
    if (company === undefined || company === null || account === undefined || account === null) return d.noAccount();
    /* A quiet read (a page loading) never asks the wallet: it uses the key released on this visit, if any. */
    const released = quietly ? async (): Promise<Hex | null> => d.released(companyId) : releasedOnceHere(companyId);
    const found = await keysFoundFor(companyId, sealed, released);
    const material = 'signingPublicKey' in keys ? { signingPublicKey: keys.signingPublicKey } : { signingSecret: keys.signingSecret };
    const signingPublicKey = 'signingPublicKey' in keys ? keys.signingPublicKey : signingPublicKeyOf(keys.signingSecret as Hex);
    const directory = directoryHereFor(companyId, company, account, found, async () => ({ signers: [] }));
    return companyKeyHere({
      accountId: companyId, material, records: { directory },
      filings: () => directoryFilingsFrom(d.api, companyId),
      served: async () => d.servedKeyFor(sealed),
      released: () => d.released(companyId),
      askTheWallet: quietly ? async () => null : released,
      /* A press asks the wallet for the key the grants open with; a quiet read uses the one released, and pauses without it. */
      revoked: () => revokedAtHere({ accountId: companyId, versions: grantsServedBy(d.api, companyId), directory, released, signingPublicKey }),
    }, undefined, unreleased === undefined ? {} : { unreleased });
  };

  const companyKeysOf = (rec: SealedAccount, unreleased?: CompanyKeyHereOptions['unreleased']): Promise<CompanyKeyHere> => {
    const keys = d.keysFor(rec.id);
    if (keys === null) throw new Error('this device holds no keys for the company, so it cannot open its key.');
    return companyKeysFor(rec.id, rec, { signingPublicKey: keys.signingPublicKey.toLowerCase() as Hex }, unreleased);
  };


  /** The company opened with the doors every read here shares, its keys read as `keysOf` reads them. */
  const openedWith = (sealed: SealedAccount, keysOf: (rec: SealedAccount) => Promise<CompanyKeyHere>): Promise<OpenedAccount | null> =>
    d.openAccount(sealed, d.holders, anchoredHere, (_company, account) => leavesFor(account), keysOf, invitedSeatsFor, identityHere);

  const openedHere = (sealed: SealedAccount): Promise<OpenedAccount | null> => openedWith(sealed, companyKeysOf);

  /**
   * The company opened as a page load reads it: the wallet is never asked. A copy of the company's key the wallet has not
   * released on this visit is left unopened; when that is why the company cannot be read (the error, or one it was thrown
   * from, is `CompanyKeyNotOpened`), it is told as that. Any other error, a roster the device does not believe included, is told as itself.
   */
  const openedQuietlyHere = async (sealed: SealedAccount): Promise<OpenedAccount | null> => {
    try {
      return await openedWith(sealed, (rec) => companyKeysOf(rec, 'not-opened'));
    } catch (e) {
      if (notOpenedIn(e)) throw e instanceof CompanyKeyNotOpened ? e : new CompanyKeyNotOpened();
      throw e;
    }
  };


  /** The seats the company's roster admitted, read afresh with the same doors as `openedHere`. */
  const seatsAdmittedOn = (sealed: SealedAccount): Promise<ReadonlySet<string>> =>
    d.seatsAdmittedFor(sealed, d.holders, anchoredHere, (_company, account) => leavesFor(account), companyKeysOf, invitedSeatsFor, identityHere);

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
    anchorsOnChainFor, keysFoundFor, vouchingFor, tagSeatsFor, anchoredHere, anchoredForAReader, leavesFor, invitedSeatsFor, identityHere, rosterReadsFor, releasedOnceHere,
    companyKeysFor, openedHere, openedQuietlyHere, seatsAdmittedOn, filingJudgeFor, directoryHereFor, directoryWithItsRecordsFor,
  });
}

