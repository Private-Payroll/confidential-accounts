import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import { signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import type { Account, SealedAccount, SealedProposal } from '../../../src/core/types.js';
import type { CompanyKeys, KeysHeld } from '../../../src/core/company-key.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import {
  CompanyKeyNotOpened,
  companyKeyHere,
  keysInTheFilings,
  type CompanyKeyHere,
  type CompanyKeyHereOptions
} from './company-key-here.js';
import { vouchedRunsHere } from './run-rebuilt-here.js';
import {
  ROSTER_CHECK,
  rosterBelievedHere,
  RosterNotBelieved,
  seatsAdmittedHere,
  type BelievedAccount,
  type RosterReads
} from './roster-here.js';
import { NoIndexerToReadTheChain, seatsAskedTogether, type InvitedSeatsRead } from './seat-not-read-on-the-chain.js';
import { builderAnswersOf, type OpeningAsked } from './builder-answers-kept.js';
import {
  attestedIn,
  directoryHere,
  directoryJudge,
  directoryWithItsRecordsHere,
  type DirectoryHereDeps,
  type DirectoryRead
} from './vault-page-doors.js';
import type { FreshJudge } from './http-sealed-pool-store.js';
import { treeKeptInMemory, type TreeKept } from './tree-kept-here.js';
import type { AnchorDoors } from './records-anchored-here.js';
import { tagSeatsHere } from './seat-openings-here.js';
import { revokedAtHere } from './purpose-wraps.js';
import {
  heldReaderOver,
  heldThrough,
  inOrder,
  judgeReadsOf,
  type HeldDoorsHere,
  type JudgeReads,
  type JudgeView,
  type OpenedInOrder
} from './company-view-judges.js';
import type { HeldReader } from './company-view.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import type { AccountKeys } from './keyring-blob.js';
import type { RefusedEntry } from '../../../src/core/roster-record.js';
import type { ProposalIdentityOf } from '../../../src/core/invitation.js';

/*
 * WHO A DEVICE BELIEVES FILED A COMPANY'S RECORDS, the one way every reader
 * asks it, wherever it runs: the company's seat directory, who holds the
 * account as the device's own chain read says, and the records-key statements
 * in the roster it opened. Every record the service holds is taken as a claim
 * and judged here against the chain and the directory; the doors say where the
 * device reads the chain, the service and its own keys. Every read goes through
 * the company's view, so the judges of one step or one screen share one read of
 * each thing. The page and the wallet each build one set of these from their
 * own doors.
 */

/**
 * A company as a device believes it: its roster record opened and each entry held to its own signer's witnesses, with each
 * entry refused on its own. `waited` holds the seats the chain holds that the roster read waits for someone invited to be
 * admitted to; it is absent from a page's own opener that does not read them.
 */
export type OpenedAccount = BelievedAccount & {
  readonly refused: readonly RefusedEntry[];
  readonly waited?: readonly string[];
};

type Holders = (company: CompanyLabel, account: AccountAddress) => Promise<AccountHoldersRead>;
type Anchored = (accountId: string, company: CompanyLabel, account: AccountAddress) => DirectoryHereDeps['anchored'];
type Leaves = (company: CompanyLabel, account: AccountAddress) => DirectoryHereDeps['leaves'];
/** The seat each invitation's proposal took, as this device's own chain read says: what a seat taken by address is waited for and admitted by. */
type InvitedSeats = (company: CompanyLabel, account: AccountAddress) => NonNullable<RosterReads['invitedSeats']>;
type SealedWithRoster = SealedAccount & { readonly roster?: SealedCompanyRecord | null };

/** The seat the company's keys are opened for: what it opens them with, and its signing key's public half. */
interface SeatOpening {
  readonly material: { readonly signingSecret: string } | { readonly signingPublicKey: string };
  readonly signingPublicKey: string;
}

/** A seat as a judge sees it: its signer id and signing public key, nothing that signs or opens. */
interface SeatShownToAJudge {
  readonly signerId: string;
  readonly signingPublicKey: string;
}

/**
 * Who holds the company, as the view read it, when it is the account a judge was asked about: the view reads the
 * account its company's records name, so a judge asked about another account is refused, never answered with this one.
 */
const theAccountAsked = <T extends { readonly account: AccountAddress }>(held: T, account: AccountAddress): T => {
  if (String(held.account).toLowerCase() !== String(account).toLowerCase()) {
    throw new Error(
      `the company's view reads account ${held.account}, and a judge asked about account ${account}, so nothing is judged.`
    );
  }
  return held;
};

/** Where a device reads what a judgement needs: the service, the chain, its own builder and its own keys. */
interface CompanyJudgeDoors {
  /** The company's view for the step or screen reading it: every read of the company goes through it. */
  readonly view: (companyId: string) => JudgeView;
  /** The indexer this device reads the chain through, or null when it has none. */
  readonly indexer: (
    company: CompanyLabel,
    account: AccountAddress
  ) => Promise<{ readonly indexerUri: string; readonly indexerWsUri: string } | null>;
  readonly builder: () => Promise<VaultBuilderClient>;
  /**
   * This device's seat on a company, by its public halves only, or null: its signer id and signing public key. A judge
   * reads with these and never with a seat's secret, on the page and in the wallet alike.
   */
  readonly keysFor: (companyId: string) => SeatShownToAJudge | null;
  /** The company's key as the service's sealed account wraps it to this seat; throws when it cannot be opened here. */
  readonly servedKeyFor: (sealed: Pick<SealedAccount, 'id' | 'wrappedKeys'>) => Hex;
  /** The company key the person's wallet released for this company, if it did. */
  readonly released: (companyId: string) => Hex | null;
  /** Asks for the released company key when none is held yet; null when it cannot be had. */
  readonly askReleased: (companyId: string) => Promise<Hex | null>;
  /** This device's own copy of the records' tree as it anchored them. */
  readonly treeKept: () => TreeKept;
  /** Opens the company's roster as this device believes it (`openAccountWith`, or the page's own). */
  readonly openAccount: (
    rec: SealedWithRoster,
    holders: Holders,
    anchored: Anchored,
    leaves: Leaves,
    companyKeys?: (rec: SealedAccount) => Promise<KeysHeld>,
    invitedSeats?: InvitedSeats,
    identity?: ProposalIdentityOf
  ) => Promise<OpenedAccount | null>;
  /** The seats the company's roster admitted, read with the same doors (`seatsAdmittedWith`, or the page's own). */
  readonly seatsAdmittedFor: (
    rec: SealedWithRoster,
    holders: Holders,
    anchored: Anchored,
    leaves: Leaves,
    companyKeys?: (rec: SealedAccount) => Promise<KeysHeld>,
    invitedSeats?: InvitedSeats,
    identity?: ProposalIdentityOf
  ) => Promise<ReadonlySet<string>>;
  /** Throws what this device throws for a company that has no account on the chain yet. */
  readonly noAccount: () => never;
}

/** What a roster is opened with: the company's view, and this device's seat and served key. */
type RosterDoors = Pick<CompanyJudgeDoors, 'view' | 'keysFor' | 'servedKeyFor'>;

const NO_ACCOUNT_TO_READ_SIGNERS_BY =
  'This company has no account on the chain that names who holds its seats, so this ' +
  'device does not read its signers.';

/**
 * The arguments a roster is read with on this device. Without `invitedSeats` a seat the chain holds that was taken on an
 * invitation by address is a read not made, so the roster stops while it leaves that seat out until Finish adding admits it;
 * without `identity` no directory entry made on such an invitation is believed, nor is such a seat admitted.
 */
async function rosterReadWith(
  d: RosterDoors,
  rec: SealedWithRoster,
  holders: Holders,
  anchored: Anchored,
  leaves: Leaves,
  companyKeys?: (rec: SealedAccount) => Promise<KeysHeld>,
  invitedSeats?: InvitedSeats,
  identity?: ProposalIdentityOf
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
  if (label === null || account === null)
    throw new RosterNotBelieved(NO_ACCOUNT_TO_READ_SIGNERS_BY, null, null, { check: ROSTER_CHECK.noAccount });
  const viewingKey = companyKeys === undefined ? served : await companyKeys(rec);
  return [
    rec,
    viewingKey,
    {
      accountId: rec.id,
      label,
      account,
      reads: {
        filings: () => judgeReadsOf(d, rec.id).filings(),
        holders: () => holders(label, account),
        anchored: anchored(rec.id, label, account),
        leaves: leaves(label, account),
        ...(invitedSeats === undefined ? {} : { invitedSeats: invitedSeats(label, account) }),
        ...(identity === undefined ? {} : { proposalIdentity: identity })
      },
      own: { signerId: keys.signerId, signingPublicKey: keys.signingPublicKey.toLowerCase() as Hex },
      proposals: async () => judgeReadsOf(d, rec.id).list('proposals') as Promise<SealedProposal[]>
    }
  ];
}

/**
 * **THE COMPANY AS THIS DEVICE BELIEVES IT**, read from its roster record only
 * (`rosterBelievedHere`): filed by a seat the company's directory believes,
 * read with the chain as `holders` reads it, each entry held to its own
 * signer's witnesses, this device's own key among them for its own entry. A
 * refusal throws `RosterNotBelieved`; each entry refused on its own is handed
 * back beside the company, with why, and the seats the roster read waits for (`waited`). Null when this device holds no keys for
 * the company, or cannot open the company's key the service wrapped to it.
 */
export async function openAccountWith(
  d: RosterDoors,
  rec: SealedWithRoster,
  holders: Holders,
  anchored: Anchored,
  leaves: Leaves,
  companyKeys?: (rec: SealedAccount) => Promise<KeysHeld>,
  invitedSeats?: InvitedSeats,
  identity?: ProposalIdentityOf
): Promise<OpenedAccount | null> {
  const read = await rosterReadWith(d, rec, holders, anchored, leaves, companyKeys, invitedSeats, identity);
  if (read === null) return null;
  const believed = await rosterBelievedHere(...read);
  return { ...believed.account, refused: believed.refused, waited: [...believed.held.waited] };
}

/** The seats the company's roster admitted, read as `openAccountWith` reads them; throws when this device holds no keys for it. */
export async function seatsAdmittedWith(
  d: RosterDoors,
  rec: SealedWithRoster,
  holders: Holders,
  anchored: Anchored,
  leaves: Leaves,
  companyKeys?: (rec: SealedAccount) => Promise<KeysHeld>,
  invitedSeats?: InvitedSeats,
  identity?: ProposalIdentityOf
): Promise<ReadonlySet<string>> {
  const read = await rosterReadWith(d, rec, holders, anchored, leaves, companyKeys, invitedSeats, identity);
  if (read === null)
    throw new Error('this device holds no keys for the company, so it cannot read who its roster admitted.');
  return seatsAdmittedHere(...read);
}

/** Whether an error, or any error it was thrown from, is the refusal for a copy of the company's key the wallet has not released. */
const notOpenedIn = (e: unknown): boolean => {
  for (let at: unknown = e, depth = 0; at instanceof Error && depth < 8; at = at.cause, depth += 1)
    if (at instanceof CompanyKeyNotOpened) return true;
  return false;
};

/** The company's label and account on the chain, or null when its account names none yet. */
const whereOf = (
  sealed: SealedAccount
): { readonly company: CompanyLabel; readonly account: AccountAddress } | null => {
  const company = sealed.companyLabel as CompanyLabel | undefined | null;
  const account = sealed.contractAddress as AccountAddress | undefined | null;
  return company === undefined || company === null || account === undefined || account === null
    ? null
    : { company, account };
};

/** The judges' reads of a company and of the chain, every one built from `d`: what each judge below reads through. */
function chainReadsOf(d: CompanyJudgeDoors) {
  /**
   * The judges' reads of one company, through its view, so every judge of the step or screen shares one read of each
   * thing; with `where`, its held reads are proven against the chain's anchors of that account.
   */
  const readsFor = (
    companyId: string,
    where?: { readonly company: CompanyLabel; readonly account: AccountAddress }
  ): JudgeReads => {
    const reads = judgeReadsOf(d, companyId, where === undefined ? undefined : heldDoorsFor(companyId, where.account));
    return where === undefined
      ? reads
      : { ...reads, holders: async () => theAccountAsked(await reads.holders(), where.account) };
  };

  /** The company's key of each epoch, found in its directory's filings and each one checked there before it is used. */
  const keysFoundFor = async (
    companyId: string,
    sealed: SealedAccount,
    released: () => Promise<Hex | null> = async () => d.released(companyId)
  ): Promise<CompanyKeys> =>
    keysInTheFilings(companyId, await readsFor(companyId).filings(), {
      served: async () => d.servedKeyFor(sealed),
      released
    });

  /** How the anchor vouches for a run: its approved proposal, opened under the company's keys, and its identity worked out by the builder. */
  const vouchingFor = (companyId: string): NonNullable<AnchorDoors['vouching']> => ({
    runs: async (chainIds) => {
      const reads = readsFor(companyId);
      const sealed = (await reads.account()) as SealedAccount;
      const proposals = (await reads.list('proposals')) as SealedProposal[];
      return vouchedRunsHere(proposals, companyId, await keysFoundFor(companyId, sealed), chainIds);
    },
    identity: async (run) => (await d.builder()).vouchedRunIdentity(run)
  });

  /** Each seat of the directory told apart from its published opening, against the seats the chain holds. */
  const tagSeatsFor =
    (account: AccountAddress): NonNullable<AnchorDoors['tagSeats']> =>
    async (here) => {
      const answers = builderAnswersOf(await d.builder());
      const builder = {
        seatOpenings: async (ask: { account: string; openings: readonly OpeningAsked[] }) => ({
          openings: await answers.openings(ask.account, ask.openings)
        })
      };
      return tagSeatsHere({ account, builder }, here.dir.seats, here.holders.seats);
    };

  /** What a seat's read of the anchored records needs besides the company's reads: the device's kept heads, its builder, the runs that vouch and the seats' tags. */
  function heldDoorsFor(companyId: string, account: AccountAddress): HeldDoorsHere {
    return {
      kept: () => d.treeKept(),
      builder: d.builder,
      vouching: vouchingFor(companyId),
      tagSeats: tagSeatsFor(account)
    };
  }

  /** How a view of the company opened for these judges reads which records its anchor holds (`companyViewFor`'s held reader). */
  const heldReaderFor = (companyId: string, account: AccountAddress): HeldReader =>
    heldReaderOver(heldDoorsFor(companyId, account));

  /** Which records the company's anchor holds, read from the tree and the manifest the service keeps and checked against the chain's heads. */
  const anchoredHere =
    (companyId: string, company: CompanyLabel, account: AccountAddress): DirectoryHereDeps['anchored'] =>
    (directory, asked) =>
      readsFor(companyId, { company, account }).anchored(directory, asked);

  /*
   * The same records as a reader's wallet holds them: it has no seat and no company key, so it reads no run that vouched
   * for an anchor and tags no seat. An anchor this cannot reach is refused, never taken on the service's word; the next
   * act of any seat files a newer anchor that it reaches. **IT KEEPS NO CHECKPOINT BETWEEN READS**: a reader's act is
   * given its record id, label and account by the page, and nothing ties them together before the read, so the heads it
   * checks are held for that one read only and can never stand in for the heads this device keeps for the company.
   */
  const anchoredForAReader =
    (companyId: string, company: CompanyLabel, account: AccountAddress): DirectoryHereDeps['anchored'] =>
    async (directory, asked) =>
      heldThrough(
        readsFor(companyId, { company, account }),
        { kept: treeKeptInMemory, builder: d.builder },
        directory,
        asked
      );

  /**
   * The leaf of each published opening, worked out by the builder, so a directory entry is matched to the seat the chain
   * holds. An opening is asked of the builder once on this device, its answer kept with the builder (`builderAnswersOf`).
   */
  const leavesFor =
    (account: AccountAddress): DirectoryHereDeps['leaves'] =>
    async (openings) =>
      (await builderAnswersOf(await d.builder()).openings(account, openings)).map((o) => o.leaf);

  /** A proposal's identity from its change and salt, worked out by the builder with the account's own functions, asked once on this device. */
  const identityHere: ProposalIdentityOf = async (change, salt) =>
    builderAnswersOf(await d.builder()).proposalIdentity(change, salt);

  /**
   * The seat each invitation's proposal took, read through the indexer this device's own chain read names, and nowhere
   * else. Every reader asks it through `seatsTakenAsked`, which gives a failed read its one meaning. Given the company's
   * record id, the proposals are asked together and each answer is kept in that company's view, among its reads of the
   * chain, until the view writes anything or ends (`seatsAskedTogether`), so one read of the view asks the chain about a proposal once.
   */
  const invitedSeatsFor = (company: CompanyLabel, account: AccountAddress, companyId?: string): InvitedSeatsRead => {
    const read: InvitedSeatsRead = async (proposals) => {
      const indexer = await d.indexer(company, account);
      /* No indexer named by the person's own wallet is a read not made, never an answer that no proposal took a seat, and pressing again cannot make it. */
      if (indexer === null) throw new NoIndexerToReadTheChain();
      return (await d.builder()).invitedSeats({ account, indexer, proposals });
    };
    if (companyId === undefined) return read;
    return async (proposals) =>
      (
        await readsFor(companyId).layer(`chain-read:invited-seats:${String(account).toLowerCase()}`, async () =>
          seatsAskedTogether(read)
        )
      )(proposals);
  };

  return {
    readsFor,
    keysFoundFor,
    vouchingFor,
    tagSeatsFor,
    heldReaderFor,
    anchoredHere,
    anchoredForAReader,
    leavesFor,
    identityHere,
    invitedSeatsFor
  };
}

type ChainReads = ReturnType<typeof chainReadsOf>;

/** The seats invitations took, read for one company and kept in its view (`invitedSeatsFor` given the record id). */
const invitedSeatsIn =
  (c: ChainReads, companyId: string): InvitedSeats =>
  (company, account) =>
    c.invitedSeatsFor(company, account, companyId);

/** What a roster and a directory are read with, built on the chain's reads `c`. */
function directoryDepsOf(d: CompanyJudgeDoors, c: ChainReads) {
  /** What a roster is read with: the directory's filings, the chain's holders, what is anchored, each opening's leaf, and each invitation's seat. */
  const rosterReadsFor = (companyId: string, company: CompanyLabel, account: AccountAddress): RosterReads => ({
    filings: () => c.readsFor(companyId).filings(),
    holders: () => c.readsFor(companyId, { company, account }).holders(),
    anchored: c.anchoredHere(companyId, company, account),
    leaves: c.leavesFor(account),
    invitedSeats: c.invitedSeatsFor(company, account, companyId),
    proposalIdentity: c.identityHere
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
    companyId: string,
    company: CompanyLabel,
    account: AccountAddress,
    viewingKey: CompanyKeys,
    roster: () => Promise<Pick<Account, 'signers'>>
  ): DirectoryHereDeps => ({
    accountId: companyId,
    label: company,
    viewingKey,
    ...rosterReadsFor(companyId, company, account),
    attested: async () => attestedIn(await roster())
  });

  return { rosterReadsFor, releasedOnceHere, directoryDeps };
}

type DirectoryDeps = ReturnType<typeof directoryDepsOf>;

/** The company opened with the doors every read here shares, its keys read as `keysOf` reads them, and who holds it. */
function openedWithOf(d: CompanyJudgeDoors, c: ChainReads) {
  /** Who holds the company, read through the company's reads. */
  const holdersOf =
    (companyId: string): Holders =>
    (company, account) =>
      c.readsFor(companyId, { company, account }).holders();
  const openedWith = (
    sealed: SealedAccount,
    keysOf: (rec: SealedAccount) => Promise<CompanyKeyHere>
  ): Promise<OpenedAccount | null> =>
    d.openAccount(
      sealed,
      holdersOf(sealed.id),
      c.anchoredHere,
      (_company, account) => c.leavesFor(account),
      keysOf,
      invitedSeatsIn(c, sealed.id),
      c.identityHere
    );
  return { holdersOf, openedWith };
}

/**
 * What this seat builds on the company's directory, in the one order (`inOrder`): the directory with an empty roster,
 * the company's keys found in its filings and believed there, the roster opened with them, and the directory with the
 * roster. The seat is found by its signing key, or by that key's public half alone when the caller reads and signs
 * nothing; a quiet read (a page loading) never asks the wallet, and uses the key released on this visit, if any.
 */
const openingOfFor =
  (d: CompanyJudgeDoors, c: ChainReads, dd: DirectoryDeps, openedWith: ReturnType<typeof openedWithOf>['openedWith']) =>
  (
    companyId: string,
    sealed: SealedAccount,
    where: { readonly company: CompanyLabel; readonly account: AccountAddress },
    seat: SeatOpening,
    unreleased?: CompanyKeyHereOptions['unreleased']
  ): OpenedInOrder<OpenedAccount | null> => {
    const quietly = unreleased === 'not-opened';
    const released = quietly ? async (): Promise<Hex | null> => d.released(companyId) : dd.releasedOnceHere(companyId);
    const { material, signingPublicKey } = seat;
    const deps = (viewingKey: CompanyKeys, roster: () => Promise<Pick<Account, 'signers'>>) =>
      dd.directoryDeps(companyId, where.company, where.account, viewingKey, roster);
    return inOrder<OpenedAccount | null>(
      c.readsFor(companyId, where),
      `${unreleased ?? 'asked'}:${'signingPublicKey' in material ? 'shown' : 'signs'}:${signingPublicKey}`,
      {
        directoryForKeys: async () =>
          deps(await c.keysFoundFor(companyId, sealed, released), async () => ({ signers: [] })),
        companyKeys: (directory) =>
          companyKeyHere(
            {
              accountId: companyId,
              material,
              records: { directory },
              filings: () => c.readsFor(companyId).filings(),
              served: async () => d.servedKeyFor(sealed),
              released: () => d.released(companyId),
              askTheWallet: quietly ? async () => null : released,
              /* A press asks the wallet for the key the grants open with; a quiet read uses the one released, and pauses without it. */
              revoked: () =>
                revokedAtHere({
                  accountId: companyId,
                  versions: () => c.readsFor(companyId).grants(),
                  directory,
                  released,
                  signingPublicKey
                })
            },
            undefined,
            unreleased === undefined ? {} : { unreleased }
          ),
        roster: (companyKeys) => openedWith(sealed, () => companyKeys()),
        directory: (companyKeys, roster) =>
          deps(companyKeys, async () => {
            const opened = await roster();
            if (opened === null)
              throw new Error('this device holds no keys for the company, so it cannot read its roster.');
            return opened;
          })
      }
    );
  };

/** The judges that open the company for this device's seat: its keys, its roster and what is built on its directory in order. */
function seatJudgesOf(d: CompanyJudgeDoors, c: ChainReads, dd: DirectoryDeps) {
  const { holdersOf, openedWith } = openedWithOf(d, c);
  const openingOf = openingOfFor(d, c, dd, openedWith);

  /** The company's key of each epoch this device can use, every one found in the directory's filings and believed there. */
  const companyKeysFor = async (
    companyId: string,
    sealed: SealedAccount,
    keys: Pick<AccountKeys, 'signingSecret'> | { readonly signingPublicKey: Hex },
    unreleased?: CompanyKeyHereOptions['unreleased']
  ): Promise<CompanyKeyHere> => {
    const where = whereOf(sealed);
    if (where === null) return d.noAccount();
    const material =
      'signingPublicKey' in keys ? { signingPublicKey: keys.signingPublicKey } : { signingSecret: keys.signingSecret };
    const signingPublicKey =
      'signingPublicKey' in keys ? keys.signingPublicKey : signingPublicKeyOf(keys.signingSecret as Hex);
    return openingOf(companyId, sealed, where, { material, signingPublicKey }, unreleased).companyKeys();
  };

  /** The seat's public half this device holds for the company, or null. */
  const shownFor = (companyId: string): { readonly signingPublicKey: Hex } | null => {
    const keys = d.keysFor(companyId);
    return keys === null ? null : { signingPublicKey: keys.signingPublicKey.toLowerCase() as Hex };
  };

  const companyKeysOf = (
    rec: SealedAccount,
    unreleased?: CompanyKeyHereOptions['unreleased']
  ): Promise<CompanyKeyHere> => {
    const shown = shownFor(rec.id);
    if (shown === null) throw new Error('this device holds no keys for the company, so it cannot open its key.');
    return companyKeysFor(rec.id, rec, shown, unreleased);
  };

  /**
   * The roster opened in the one order when this device holds a seat on a company with an account; otherwise opened as
   * the roster's own read refuses or gives nothing for it.
   */
  const rosterOf = (
    sealed: SealedAccount,
    unreleased?: CompanyKeyHereOptions['unreleased']
  ): Promise<OpenedAccount | null> => {
    const shown = shownFor(sealed.id);
    const where = whereOf(sealed);
    if (shown === null || where === null) return openedWith(sealed, (rec) => companyKeysOf(rec, unreleased));
    return openingOf(
      sealed.id,
      sealed,
      where,
      { material: shown, signingPublicKey: shown.signingPublicKey },
      unreleased
    ).roster();
  };

  const openedHere = (sealed: SealedAccount): Promise<OpenedAccount | null> => rosterOf(sealed);

  /**
   * The company opened as a page load reads it: the wallet is never asked. A copy of the company's key the wallet has not
   * released on this visit is left unopened; when that is why the company cannot be read (the error, or one it was thrown
   * from, is `CompanyKeyNotOpened`), it is told as that. Any other error, a roster the device does not believe included, is told as itself.
   */
  const openedQuietlyHere = async (sealed: SealedAccount): Promise<OpenedAccount | null> => {
    try {
      return await rosterOf(sealed, 'not-opened');
    } catch (e) {
      if (notOpenedIn(e)) throw e instanceof CompanyKeyNotOpened ? e : new CompanyKeyNotOpened();
      throw e;
    }
  };

  /**
   * What this seat builds on the company's directory, in the one order, read through the company's view: the
   * directory used to open its keys, its keys, its roster, and the directory with the roster and its judge.
   * Null when this device holds no seat on the company; `d.noAccount` when the company has no account yet.
   */
  const openedInOrder = (
    sealed: SealedAccount,
    unreleased?: CompanyKeyHereOptions['unreleased']
  ): OpenedInOrder<OpenedAccount | null> | null => {
    const where = whereOf(sealed);
    if (where === null) return d.noAccount();
    const shown = shownFor(sealed.id);
    return shown === null
      ? null
      : openingOf(sealed.id, sealed, where, { material: shown, signingPublicKey: shown.signingPublicKey }, unreleased);
  };

  /** The seats the company's roster admitted, read with the same doors as `openedHere`. */
  const seatsAdmittedOn = (sealed: SealedAccount): Promise<ReadonlySet<string>> =>
    d.seatsAdmittedFor(
      sealed,
      holdersOf(sealed.id),
      c.anchoredHere,
      (_company, account) => c.leavesFor(account),
      companyKeysOf,
      invitedSeatsIn(c, sealed.id),
      c.identityHere
    );

  return { companyKeysFor, openedHere, openedQuietlyHere, openedInOrder, seatsAdmittedOn };
}

/** The judges of a company's directory, worked out at each call from the company's reads. */
function directoryJudgesOf(dd: DirectoryDeps) {
  /** Whether a filing's signer is one the company's directory believes, worked out for each filing judged from the company's reads. */
  const filingJudgeFor = (
    companyId: string,
    company: CompanyLabel,
    account: AccountAddress,
    viewingKey: CompanyKeys,
    roster: () => Promise<Pick<Account, 'signers'>>
  ): FreshJudge => directoryJudge(dd.directoryDeps(companyId, company, account, viewingKey, roster));

  /** The company's directory as this device believes it, worked out at each call from the company's reads. */
  function directoryHereFor(
    companyId: string,
    company: CompanyLabel,
    account: AccountAddress,
    viewingKey: CompanyKeys,
    roster: () => Promise<Pick<Account, 'signers'>>
  ): DirectoryRead {
    return (asked) => directoryHere(dd.directoryDeps(companyId, company, account, viewingKey, roster), asked);
  }

  /** The directory with every record it names read beside it, for a device that anchors them. */
  const directoryWithItsRecordsFor =
    (
      companyId: string,
      company: CompanyLabel,
      account: AccountAddress,
      viewingKey: CompanyKeys,
      roster: () => Promise<Pick<Account, 'signers'>>
    ): DirectoryRead =>
    (asked) =>
      directoryWithItsRecordsHere(dd.directoryDeps(companyId, company, account, viewingKey, roster), asked);

  return { filingJudgeFor, directoryHereFor, directoryWithItsRecordsFor };
}

/** The judges a device reads a company with, every one built from `d`. */
export function companyJudges(d: CompanyJudgeDoors) {
  const c = chainReadsOf(d);
  const dd = directoryDepsOf(d, c);
  const { readsFor: _reads, ...chain } = c;
  return Object.freeze({
    ...chain,
    rosterReadsFor: dd.rosterReadsFor,
    releasedOnceHere: dd.releasedOnceHere,
    ...seatJudgesOf(d, c, dd),
    ...directoryJudgesOf(dd)
  });
}
