import { unlockKeyFor } from 'midnight-identity/profile/unlock';
import type { UnlockRequest } from 'midnight-identity/profile/request';
import type { Identity } from 'midnight-identity/keys/derivation';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountHoldersRead, AccountPaymentFacts, AccountRoleEntry } from 'midnight-identity/profile/records-key';
import { randomBytes, signingPublicKeyOf, toHex, unwrapKey, type Hex } from '../../../../src/core/crypto.js';
import type { SealedAccount, SealedProposal, SealedRun } from '../../../../src/core/types.js';
import { newProposalId } from '../../../../src/core/proposal-filing.js';
import { approversHere, runsOutrunHere } from './approvers-here.js';
import { policiesInTheWallet } from './policy-doors-in-the-wallet.js';
import { withCompanyKeys } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { governedCallServiceThrough } from '../../../../packages/web-shared/src/governed-call-through-the-view.js';
import { firstFiledThrough } from '../../../../packages/web-shared/src/roster-through-the-view.js';
import {
  vaultsReadInTheView,
  type VaultsReadOnce
} from '../../../../packages/web-shared/src/vaults-read-in-the-view.js';
import { anchorHeadsKept } from '../../../../packages/web-shared/src/builder-answers-kept.js';
import type { GovernanceDoors } from '../../../../packages/web-shared/src/company-change-on-device.js';
import { RosterNotBelieved, type RosterDoors } from '../../../../packages/web-shared/src/roster-here.js';
import type { CompanyRecordsHere } from '../../../../packages/web-shared/src/run-rebuilt-here.js';
import type { CompanyKeyHere } from '../../../../packages/web-shared/src/company-key-here.js';
import type { CompanyRecordAsked, CompanyWrites } from '../../../../packages/web-shared/src/records-source.js';
import type { ListsView } from '../../../../packages/web-shared/src/people-read-here.js';
import {
  companyJudges,
  openAccountWith,
  seatsAdmittedWith,
  type OpenedAccount
} from '../../../../packages/web-shared/src/company-judges.js';
import {
  manifestFollowing,
  recordsEnteredFor,
  type ManifestService
} from '../../../../packages/web-shared/src/record-entered-here.js';
import { treeKeptHere } from '../../../../packages/web-shared/src/tree-kept-here.js';
import {
  withNewSeat,
  type AccountKeys,
  type Keyring,
  type SavedAccountKeys
} from '../../../../packages/web-shared/src/keyring-blob.js';
import type {
  VaultBuilderClient,
  AccountCallChainOnTheWire
} from '../../../../packages/web-shared/src/vault-worker-client.js';
import { deviceSignerFrom } from '../../../../packages/web-shared/src/vault-page-doors.js';
import { serviceNotReached, type HandOver } from '../../../../packages/web-shared/src/hand-over.js';
import type { OwnWalletDoors } from '../chain/sent-straight-to-the-chain.js';
import { type ServiceOpener } from '../../../../src/midnight/company-service-record.js';
import { companyServiceHere, serviceOpenerFor, type ServiceRead } from './company-service-read.js';
import { stopsFor } from './leaving-read-in-the-wallet.js';
import { StepRefused, type StepContext, type Words } from './definition.js';
import { companyAnchorsOnChain, holdersOn, ownChainReadsOf } from '../chain/view-doors.js';
import type { ViewHeld } from '../../../../packages/web-shared/src/company-view.js';
import { handOverFor, handOverMarked, sponsorFor, type Handed } from './hand-over-in-the-wallet.js';
import { signerMaterialOf } from '../../../../packages/web-shared/src/private-state.js';
import {
  companyReachHead,
  entryOwedThroughTheReach,
  pinRefusal,
  seatOfThePin,
  type RegistryEntryDoors
} from './company-reach-head.js';
import { pinTheJoiner } from './company-pin.js';

/*
 * WHAT AN ACTION ON A COMPANY READS THE COMPANY WITH, IN THE WALLET. The page
 * names the company by the service's record of it, its label and its account;
 * the wallet believes none of the three until its own chain read says the
 * account carries that label and seats the seat it holds for that record. Our
 * service is reached only through the page, one call at a time from the
 * action's own route list, and every answer is judged here (`companyJudges`)
 * against the chain and the company's directory before anything rests on it.
 * A service the company hosts itself, when the company chose one, is reached by
 * the wallet and handed finished calls alone (`handOverFor`). The seat's
 * secrets and the company's key never leave the wallet.
 */

/** The wallet's own reads of the chain an action on a company needs, none of them through the page. */
export interface CompanyChain {
  /** Who holds the account now, or why it could not be read, as this wallet's indexer shows it. */
  holders(account: AccountAddress, label: CompanyLabel): Promise<AccountHoldersRead | Words>;
  /** The account's state and the chain's parameters at one block, for a call built on them. */
  callState(account: AccountAddress): Promise<AccountCallChainOnTheWire | null>;
  /** Which of these entries the account's record of payments holds, as this wallet's indexer shows it; a payment out of a vault reads it. */
  payments?(
    account: AccountAddress,
    label: CompanyLabel,
    entries: readonly string[]
  ): Promise<AccountPaymentFacts | Words>;
  /** What the account holds under each of these keys, as this wallet's indexer shows it; a vault's spending policy is read from it. */
  roles?(
    account: AccountAddress,
    label: CompanyLabel,
    keys: readonly string[]
  ): Promise<readonly AccountRoleEntry[] | Words>;
  /** The indexer this wallet reads the chain through. */
  readonly indexer: { readonly indexerUri: string; readonly indexerWsUri: string };
  /** The person's own wallet, which pays the fee of a call sent straight to the chain. Absent, no call goes that way. */
  readonly ownWallet?: (identity: Identity, account: number) => OwnWalletDoors;
  /** How this wallet reaches the service the company hosts itself, when the company chose one; absent, the browser's own. */
  readonly ownServiceSend?: typeof fetch;
  /** The network and the account builder this person's entry in the private registry is written with; absent, none is named owed. */
  readonly registryEntry?: RegistryEntryDoors;
}

/**
 * Everything a step reads a company with, from the wallet's own reads and keys, read for that one step through its
 * view of the company (`keptReach`).
 */
export interface CompanyReach {
  readonly accountId: string;
  readonly label: CompanyLabel;
  readonly account: AccountAddress;
  /** This person's seat on the company, as their saved keys hold it. */
  readonly seat: SavedAccountKeys & { readonly scope: Hex };
  /** The seat's leaf, worked out here from its own secrets, and seated on the chain. */
  readonly leaf: Hex;
  /** The company's key this wallet derives for the person, hex. */
  readonly companyKey: Hex;
  /** The step's one view of the company: the judges, the anchor and the record stores read and write through it. */
  readonly stepView: ViewHeld<AccountHoldersRead>;
  /** The company's records read through the step's view: every version of a record asked with `every`. */
  readonly records: (asked: readonly CompanyRecordAsked[]) => Promise<readonly unknown[]>;
  readonly holders: () => Promise<AccountHoldersRead>;
  readonly judges: ReturnType<typeof companyJudges>;
  readonly sealed: SealedAccount;
  /** The company's key this seat was given, opened with the seat's own wrapping secret from the company's record. */
  readonly served: () => Hex;
  readonly companyKeys: CompanyKeyHere;
  readonly roster: () => Promise<OpenedAccount>;
  readonly builder: VaultBuilderClient;
  /** The step's vaults, read together once for the step and kept in its view, for every standing read of a vault. */
  readonly vaultsHere: VaultsReadOnce;
  readonly chain: CompanyChain;
  /** Where every call this action finishes is handed over (`handOverFor`); absent, through our service. */
  readonly handOver?: HandOver;
  /** The company's choice of service as this wallet read it (`companyServiceHere`), or why it could not be read. */
  readonly service?: ServiceRead;
  /** Opens this seat's copy of a version of the company's choice of service, for an act that reads its versions. */
  readonly opener: ServiceOpener;
}

const HEX64 = /^[0-9a-f]{64}$/u;

/** The company's key this wallet derives for the person and this company, as it releases it to a page that asks. */
export const companyKeyOf = (
  ctx: Pick<StepContext, 'held' | 'asker'>,
  label: CompanyLabel,
  account: AccountAddress
): Hex => {
  const key = unlockKeyFor(ctx.held.identity, {
    schema: 'midnight-identity/disclosure-request/v1',
    kind: 'unlock',
    requester: ctx.asker,
    purpose: '',
    nonce: 'act',
    expiresAt: 0,
    company: label,
    account
  } as unknown as UnlockRequest);
  try {
    return toHex(key) as Hex;
  } finally {
    key.fill(0);
  }
};

/*
 * A seat this wallet kept as waiting for this company (a seat taken by address whose request to be admitted got no
 * answer it could keep), once the chain holds its leaf and the company's key has been wrapped to it: its keys, under
 * the id that wrap names. Null when there is none, or the service does not yet let this person read the company.
 */
async function admittedFromWaiting(
  view: CompanyReach['stepView'],
  held: Keyring,
  accountId: string,
  seats: readonly string[],
  builder: VaultBuilderClient
): Promise<(SavedAccountKeys & { readonly signerId: string }) | null> {
  const onChain = new Set(seats.map((x) => x.toLowerCase()));
  for (const p of Object.values(held.pendingSeats ?? {})) {
    if (p.accountId !== accountId || typeof p.scope !== 'string' || !HEX64.test(p.scope.toLowerCase())) continue;
    const leaf = (
      await builder.ownSeat({ signingSecret: p.signingSecret, blinding: p.blinding, scope: p.scope })
    ).toLowerCase();
    if (!onChain.has(leaf)) continue;
    let rec: { wrappedKeys?: Array<{ signerId?: unknown }> } | null;
    try {
      rec = (await view.current().account()) as typeof rec;
    } catch (e) {
      if (serviceNotReached(e)) throw e;
      return null;
    }
    const mine = (rec?.wrappedKeys ?? []).find((w) => {
      try {
        unwrapKey(w as never, p.wrappingSecret);
        return true;
      } catch {
        return false;
      }
    });
    if (mine === undefined || typeof mine.signerId !== 'string') return null;
    const { accountId: _company, signingPublicKey: _key, joining: _joining, ...keys } = p;
    return { ...keys, signerId: mine.signerId };
  }
  return null;
}

/**
 * The refusal when the company's service cannot be reached for what only it holds: the company's sealed account, its
 * keys for this seat and its roster. Nothing can be built without them, so nothing is signed or sent, and the words
 * say what resolves it.
 */
export const RECORDS_UNREACHED: Words = Object.freeze({ key: 'act.reach.why.service-unreached' });

/* A read of what only the company's service holds: when the service cannot be reached, the action is refused in words. */
const onlyTheServiceHolds = async <T>(read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (e) {
    if (serviceNotReached(e)) throw new StepRefused(RECORDS_UNREACHED);
    throw e;
  }
};

/**
 * The roster this device believes, or none while it believes none (`RosterNotBelieved`), for a read that believes the
 * directory without it; any other failure (the service not reached, the view ended, the action stopped) is thrown.
 */
export const rosterOrNone =
  (roster: () => Promise<Pick<OpenedAccount, 'signers'>>) => async (): Promise<Pick<OpenedAccount, 'signers'>> => {
    try {
      return await roster();
    } catch (e) {
      if (e instanceof RosterNotBelieved) return { signers: [] };
      throw e;
    }
  };

/** What the judges and the step's view are opened with: the company, this seat's keys and the wallet's own reads. */
interface Opening {
  readonly accountId: string;
  readonly label: CompanyLabel;
  readonly account: AccountAddress;
  readonly chain: CompanyChain;
  readonly builder: VaultBuilderClient;
  readonly companyKey: Hex;
  readonly seat: SavedAccountKeys;
  readonly view: CompanyReach['stepView'];
  readonly refuse: (key: string) => never;
}

/** A sealed account as the judges hand it: its id and the company key wrapped for each signer. */
type SealedAccountKeys = {
  readonly id: string;
  readonly wrappedKeys: readonly ({ readonly signerId?: unknown } & Parameters<typeof unwrapKey>[0])[];
};

/** The judges of the company's filings, every read of theirs through the step's view of the company. */
function judgesThrough(
  o: Opening
): Pick<CompanyReach, 'judges'> & { readonly servedKeyFor: (rec: SealedAccountKeys) => Hex } {
  const servedKeyFor = (rec: SealedAccountKeys): Hex => {
    if (rec.id !== o.accountId) throw new Error('that is not the company this action is on.');
    const wrapped = rec.wrappedKeys.find((w) => w.signerId === o.seat.signerId);
    if (wrapped === undefined) throw new Error("your seat has not been given the company's key yet.");
    return unwrapKey(wrapped, o.seat.wrappingSecret) as Hex;
  };
  const shown = { signerId: o.seat.signerId, signingPublicKey: signingPublicKeyOf(o.seat.signingSecret).toLowerCase() };
  const view = (id: string) => {
    if (id !== o.accountId) throw new Error('that is not the company this action is on.');
    return o.view.current();
  };
  const doors = { view, keysFor: (id: string) => (id === o.accountId ? shown : null), servedKeyFor };
  const judges = companyJudges({
    ...doors,
    indexer: async () => o.chain.indexer,
    builder: async () => o.builder,
    released: (id) => (id === o.accountId ? o.companyKey : null),
    askReleased: async (id) => (id === o.accountId ? o.companyKey : null),
    treeKept: () => treeKeptHere(),
    openAccount: (...a) => openAccountWith(doors, ...a),
    seatsAdmittedFor: (...a) => seatsAdmittedWith(doors, ...a),
    noAccount: () => o.refuse('not-on-chain')
  });
  return { judges, servedKeyFor };
}

/**
 * The step's view of the company: who holds it through this wallet's own chain read, the anchors and heads through the
 * wallet's builder and indexer, the device's own stores, and the directory with its records as the judges believe it.
 */
export const viewOfTheStep = (
  ctx: Pick<StepContext, 'viewFor'>,
  o: Omit<Opening, 'view' | 'companyKey' | 'seat' | 'refuse'>,
  later: { judges?: CompanyReach['judges']; roster?: () => Promise<OpenedAccount>; filer?: string },
  first?: Promise<AccountHoldersRead>
): CompanyReach['stepView'] => {
  let firstRead = first;
  const judges = (): CompanyReach['judges'] =>
    later.judges ??
    (() => {
      throw new Error('the company was read before its judges were opened.');
    })();
  /* Before the reach has opened its roster, the directory is believed without one, as it is to open the company's keys. */
  const roster = rosterOrNone(() => (later.roster ?? (async () => ({ signers: [] })))());
  return ctx.viewFor(
    o.accountId,
    {
      holders: () => {
        const read = firstRead ?? holdersOn(o.chain, o.account, o.label)();
        firstRead = undefined;
        return read;
      },
      onChain: () => companyAnchorsOnChain(o.builder, o.account, o.chain.indexer),
      builder: { anchorHeads: anchorHeadsKept(o.builder) },
      kept: () => treeKeptHere(),
      /* This seat's filing key, once the reach has found the seat: its own entries a header filed again carries. */
      filer: () => later.filer ?? null,
      chain: ownChainReadsOf(o.chain, o.account),
      directory: async (view) => {
        const found = await judges().keysFoundFor(o.accountId, (await view.account()) as SealedAccount);
        return judges().directoryWithItsRecordsFor(o.accountId, o.label, o.account, found, roster)();
      }
    },
    (view, asked) => judges().heldReaderFor(o.accountId, o.account)(view, asked)
  );
};

/**
 * Reads the company the action names, for one step, refusing (`StepRefused`, with `why`) a label pinned to another
 * account or to none (`companyReachHead`), a record this person holds no seat on, a seat this wallet's words do not make
 * for the pinned company, an account that does not carry the label, and a seat the chain does not hold. Everything it reads of the
 * company it reads through the step's one view (`ctx.viewFor`). A seat kept only as waiting (`admittedFromWaiting`)
 * is kept as the company's seat here first, once the roster names it. The company's sealed records come from its
 * service alone: when it cannot be reached, the action is refused (`RECORDS_UNREACHED`). Its choice of service is read
 * too, and a choice that cannot be read sends the action's calls straight to the chain (`handOverFor`).
 */
export async function companyReachFor(
  ctx: StepContext,
  chain: CompanyChain,
  builder: VaultBuilderClient,
  why: (key: string) => Words
): Promise<CompanyReach> {
  const refuse = (key: string): never => {
    throw new StepRefused(why(key));
  };
  const leafOfSeat = async (s: { signingSecret: string; blinding: string; scope: unknown }): Promise<Hex> =>
    (
      await builder.ownSeat({ signingSecret: s.signingSecret, blinding: s.blinding, scope: s.scope as Hex })
    ).toLowerCase() as Hex;
  /* Who holds the company is read off the chain before anything is asked of the page; the view starts from that read. */
  let first: Promise<AccountHoldersRead> | undefined;
  const firstRead = (label: CompanyLabel, account: AccountAddress): Promise<AccountHoldersRead> =>
    (first ??= holdersOn(chain, account, label)());
  const head = await companyReachHead(ctx, refuse, {
    seats: async (l, a) => (await firstRead(l, a)).seats,
    leafOf: leafOfSeat,
    chain
  });
  const { accountId, keyring } = head;
  const held = keyring.open().read();
  const read = await firstRead(head.label, head.account);
  const later: { judges?: CompanyReach['judges']; roster?: () => Promise<OpenedAccount>; filer?: string } = {};
  const view = viewOfTheStep(
    ctx,
    { accountId, label: head.label, account: head.account, chain, builder },
    later,
    first
  );
  const kept = held.accounts[accountId];
  const admitted =
    kept === undefined
      ? await onlyTheServiceHolds(() => admittedFromWaiting(view, held, accountId, read.seats, builder))
      : null;
  const saved: SavedAccountKeys = kept ?? admitted ?? refuse('no-seat');
  const scope = typeof saved.scope === 'string' && HEX64.test(saved.scope) ? (saved.scope as Hex) : refuse('no-seat');
  const seat = { ...saved, scope };
  await seatOfThePin(ctx.held.identity, head, seat, refuse);
  const leaf = await leafOfSeat(seat);
  if (!read.seats.some((s) => s.toLowerCase() === leaf)) refuse('seat-not-held');
  return await openedOver(ctx, { head, chain, builder, view, later, seat, leaf, admitted, seats: read.seats, refuse });
}

/** What the reach has read and chosen once the seat is held, for the part of it that opens the company's records. */
interface Seated {
  readonly head: Awaited<ReturnType<typeof companyReachHead>>;
  readonly chain: CompanyChain;
  readonly builder: VaultBuilderClient;
  readonly view: CompanyReach['stepView'];
  readonly later: { judges?: CompanyReach['judges']; roster?: () => Promise<OpenedAccount>; filer?: string };
  readonly seat: SavedAccountKeys & { readonly scope: Hex };
  readonly leaf: Hex;
  readonly admitted: (SavedAccountKeys & { readonly signerId: string }) | null;
  readonly seats: readonly string[];
  readonly refuse: (key: string) => never;
}

/** The company's records opened over the seat the reach holds: its key, judges, sealed record, roster and service. */
async function openedOver(ctx: StepContext, o: Seated): Promise<CompanyReach> {
  const { head, chain, builder, view, later, seat, leaf, admitted, refuse } = o;
  const { accountId, label, account, keyring } = head;
  later.filer = signingPublicKeyOf(seat.signingSecret).toLowerCase();
  const companyKey = companyKeyOf(ctx, label, account);
  const { judges, servedKeyFor } = judgesThrough({
    accountId,
    label,
    account,
    chain,
    builder,
    companyKey,
    seat,
    view,
    refuse
  });
  later.judges = judges;
  const sealed = (await onlyTheServiceHolds(() => view.current().account())) as SealedAccount;
  if (
    sealed?.id !== accountId ||
    sealed.companyLabel !== label ||
    String(sealed.contractAddress).toLowerCase() !== account
  )
    refuse('not-a-company');
  const companyKeys = await onlyTheServiceHolds(() => judges.companyKeysFor(accountId, sealed, seat));
  const roster = async (): Promise<OpenedAccount> =>
    (await judges.openedHere((await view.current().account()) as SealedAccount)) ?? refuse('roster-not-opened');
  later.roster = roster;
  if (admitted !== null) {
    /* A seat taken by address and kept only as waiting: kept as this company's seat once the roster names it, active,
     * under the id the company's key was wrapped to it by, with the leaf the chain holds; then its company is pinned
     * when the person confirmed it (`pinTheJoiner`). */
    const named = (await onlyTheServiceHolds(roster)).signers.find(
      (x) => x.id === admitted.signerId && x.status === 'active'
    );
    if (named === undefined || String(named.leafCommitment).toLowerCase() !== leaf) refuse('no-seat');
    await keyring.keep((k) => withNewSeat(k, accountId, admitted as AccountKeys));
    const pending = Object.values(keyring.open().read().pendingSeats ?? {}).find(
      (p) => p.accountId === accountId && p.signingSecret === admitted.signingSecret
    );
    if (pending !== undefined) await pinTheJoiner(ctx, pending, leaf, o.seats, account);
  }
  entryOwedThroughTheReach(ctx, chain, head, { ...seat, leaf }, o.seats);
  /* The company's choice of service is opened, as its spending policies are, with the records key this seat's device
   * holds from the company key, or with the company's key at the version's epoch; the keys stay here and the record is
   * handed only the opened copy. */
  const signer = deviceSignerFrom(leaf, companyKey);
  const opener = serviceOpenerFor(
    accountId,
    signer.signerId,
    (wrapped) => unwrapKey(wrapped, signer.wrappingSecret) as Hex,
    companyKeys
  );
  const records = (asked: readonly CompanyRecordAsked[]): Promise<readonly unknown[]> => view.current().records(asked);
  const service = await companyServiceHere(
    { accountId, records, judges, label, account, companyKeys, roster, opener },
    ctx
  );
  return Object.freeze({
    accountId,
    label,
    account,
    seat,
    leaf,
    companyKey,
    holders: () => view.current().holders(),
    judges,
    sealed,
    served: () => servedKeyFor(sealed),
    companyKeys,
    roster,
    builder,
    chain,
    service,
    opener,
    stepView: view,
    records,
    vaultsHere: vaultsReadInTheView(() => view.current(), builder),
    handOver: handOverFor(
      ctx,
      chain,
      service,
      Date.now,
      sponsorFor(ctx.intent, (w) => writesOfTheStep({ accountId, stepView: view })(accountId, w))
    )
  });
}

/**
 * The company as each step of an action reads it: `at` checks the pin for the page's label (`pinRefusal`), then reads
 * it once for the step that asks, through that step's own view, and hands the same read to every later ask of the same step; a later step reads it again, so nothing read in
 * one step is relied on in the next. `renew` ends the step's read, so the next ask reads the company again (after the
 * company's key changed in the step, every seal is under the new key).
 */
export function keptReach(readFor: (ctx: StepContext) => Promise<CompanyReach>) {
  let step: { readonly ctx: StepContext; readonly read: Promise<CompanyReach> } | null = null;
  /* The pin check runs before any reach it is handed, so a reach that skips the head is held to the pin too. */
  const held = async (ctx: StepContext): Promise<CompanyReach> => {
    const refused = pinRefusal(ctx);
    if (refused !== null) throw new StepRefused({ key: `act.${ctx.intent.name}.why.${refused}` });
    return readFor(ctx);
  };
  return {
    at: (ctx: StepContext): Promise<CompanyReach> => {
      if (step === null || step.ctx !== ctx) step = { ctx, read: held(ctx) };
      const mine = step;
      mine.read.catch(() => {
        if (step === mine) step = null;
      });
      return mine.read;
    },
    renew: (): void => {
      const was = step;
      step = null;
      was?.read.then(
        (r) => r.stepView.current().end('the step reads the company again'),
        () => undefined
      );
    }
  };
}

/** The company's writes through the step's view, refused for any company but the step's own. */
export const writesOfTheStep =
  (r: Pick<CompanyReach, 'accountId' | 'stepView'>): CompanyWrites =>
  async (company, w) => {
    if (company !== r.accountId)
      throw new Error(
        `a write for another company (${company}) was asked through this company's view; nothing was written.`
      );
    return (await r.stepView.current().write([w]))[0];
  };

/** The company's lists, records and hand-overs, each read through the step's view as it is when asked. */
export const listsOfTheStep = (r: Pick<CompanyReach, 'stepView'>): ListsView =>
  Object.freeze<ListsView>({
    list: (kind) => r.stepView.current().list(kind),
    records: (asked) => r.stepView.current().records(asked),
    handovers: (people) => r.stepView.current().handovers(people),
    vendorHandovers: (vendors) => r.stepView.current().vendorHandovers(vendors)
  });

/** The company's proposals, as the step's view lists them. */
export const proposalsInTheView = (r: Pick<CompanyReach, 'stepView'>) => async (): Promise<SealedProposal[]> => {
  const listed = await r.stepView.current().list('proposals');
  if (!Array.isArray(listed)) throw new Error("the service did not answer with the company's proposals");
  return listed as SealedProposal[];
};

/** The step's view's manifest, following the view the step holds now: what is entered through it moves the view's baseline. */
export const manifestOfTheStep = (r: Pick<CompanyReach, 'stepView'>): ManifestService => manifestFollowing(r.stepView);

/** What this seat files is entered as it files it, signed with its own key, through the step's view; nothing more once a removal of its seat is approved (`stopsFor`). */
export const enteredFor = (r: CompanyReach) =>
  recordsEnteredFor(manifestOfTheStep(r), r.accountId, r.seat.signingSecret, stopsFor(r));

/*
 * The company's records as a change to who is seated reads them: its directory, its state record, its proposals and
 * runs, the proposals the chain holds, by this wallet's own read, and the spending policies, read and never filed. A
 * payroll run's own records are not read for it.
 */
export const governanceRecordsFor = (r: CompanyReach): CompanyRecordsHere => {
  const notRead = (what: string) => (): never => {
    throw new Error(`a change to who is seated reads no ${what}.`);
  };
  return {
    directory: r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster),
    people: notRead('person of the company'),
    state: (id) => firstFiledThrough(r.stepView, r.accountId, 'state', id),
    runs: async () => (await r.stepView.current().list('runs')) as readonly SealedRun[],
    proposals: proposalsInTheView(r),
    roundsOnChain: (chainIds) =>
      r.builder.roundsOnChain({ account: r.account, indexer: r.chain.indexer, chainIds, seat: r.seat.signingSecret }),
    payments: { paidOnceOf: notRead('payment'), paidMovementOf: notRead('payment'), read: notRead('payment') },
    roundIdentity: { runPayload: notRead('payroll run'), proposalIdOf: notRead('payroll run') },
    policy: notRead('payroll policy'),
    /* `detailsOf` is a table, not a call, so there is nothing to refuse with: it is empty, and `open` and `treeOf`, the only readers of it, refuse. */
    oneOffs: {
      at: notRead('one-off payment'),
      keys: r.companyKeys,
      detailsOf: {} as CompanyRecordsHere['oneOffs']['detailsOf'],
      open: notRead('one-off payment'),
      treeOf: notRead('one-off payment')
    },
    /* Read, never filed: a removal counts each vault's approvers at the top band of its policies in force. */
    spendingPolicies: policiesInTheWallet(r)
  };
};

/**
 * **THE DOORS A CHANGE TO WHO IS SEATED IS RAISED AND APPROVED THROUGH, FROM THIS WALLET'S OWN REACH**: the proposals
 * filed and sent through the page (each send marked in `handed`), the account's state at one block and every
 * proposal's standing from this wallet's own read of the chain, this seat's own three parts from the saved keys, the
 * records it files entered under this seat's key, the approvers as the roster and the chain count them, with the
 * signers removed since the open run they outran most was raised (`approversHere`), and the roster read and judged here (`rosterReadsFor`). Nothing the page says is believed by them.
 */
export function governanceDoorsFor(
  r: CompanyReach,
  sleep: (ms: number) => Promise<void>,
  handed: Handed = { over: false },
  o: { readonly waitMs?: number; readonly everyMs?: number } = {}
): GovernanceDoors & { readonly roster: RosterDoors } {
  const service = governedCallServiceThrough(r.stepView);
  const marked =
    <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> => {
      handed.over = true;
      return f(...a);
    };
  const entered = enteredFor(r);
  return {
    service: {
      ...service,
      file: (accountId, body) => {
        if (body.tx !== undefined) handed.over = true;
        return service.file!(accountId, body);
      },
      approve: marked(service.approve),
      send: marked(service.send),
      ...(service.carry === undefined ? {} : { carry: marked(service.carry) }),
      ...(service.retire === undefined ? {} : { retire: marked(service.retire) }),
      ...(service.cancel === undefined ? {} : { cancel: marked(service.cancel) }),
      /* Not marked: `closed` only has the service record a proposal already closed on the chain; it sends nothing to it. */
      ...(service.closed === undefined ? {} : { closed: service.closed })
    },
    builder: r.builder,
    material: signerMaterialOf(r.seat),
    accountId: r.accountId,
    records: governanceRecordsFor(r),
    leaves: r.judges.leavesFor(r.account),
    handOver: handOverMarked(r.handOver, handed),
    sleep,
    ...(o.waitMs === undefined ? {} : { waitMs: o.waitMs }),
    ...(o.everyMs === undefined ? {} : { everyMs: o.everyMs }),
    filing: {
      seat: r.leaf,
      keyEpoch: r.companyKeys.epoch,
      salt: () => toHex(randomBytes(32)),
      newId: () => newProposalId(),
      entered
    },
    approvers: () => approversHere(r, () => runsOutrunHere(r)),
    vaultName: (vault) => vault,
    roster: withCompanyKeys(
      {
        accountId: r.accountId,
        signingSecret: r.seat.signingSecret as Hex,
        label: r.label,
        account: r.account,
        reads: r.judges.rosterReadsFor(r.accountId, r.label, r.account),
        entered,
        view: r.stepView
      },
      r.companyKeys
    )
  };
}
