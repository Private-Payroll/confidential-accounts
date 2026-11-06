import { unlockKeyFor } from 'midnight-identity/profile/unlock';
import type { UnlockRequest } from 'midnight-identity/profile/request';
import type { Identity } from 'midnight-identity/keys/derivation';
import { readAccountAddress, readCompanyLabel, type AccountAddress, type CompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountHoldersRead, AccountPaymentFacts, AccountRoleEntry } from 'midnight-identity/profile/records-key';
import { canonical, randomBytes, signingPublicKeyOf, toHex, unwrapKey, type Hex } from '../../../../src/core/crypto.js';
import type { SealedAccount, SealedProposal } from '../../../../src/core/types.js';
import { newProposalId } from '../../../../src/core/proposal-filing.js';
import { approverRosterFrom, type ApproverRoster } from '../../../../src/core/vault-approvers.js';
import { companyWirePaths, fromCompanyWire } from '../../../../src/midnight/sealed-record-wire.js';
import { governedCallServiceFor, withCompanyKeys, type GovernanceDoors } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import type { RosterDoors } from '../../../../packages/web-shared/src/roster-here.js';
import type { CompanyRecordsHere } from '../../../../packages/web-shared/src/run-rebuilt-here.js';
import type { CompanyKeyHere } from '../../../../packages/web-shared/src/company-key-here.js';
import { companyJudges, openAccountWith, seatsAdmittedWith, type OpenedAccount } from '../../../../packages/web-shared/src/company-judges.js';
import type { WireSend } from '../../../../packages/web-shared/src/http-sealed-pool-store.js';
import { recordsEnteredFor, manifestServiceFor } from '../../../../packages/web-shared/src/record-entered-here.js';
import { treeKeptHere } from '../../../../packages/web-shared/src/tree-kept-here.js';
import { withNewSeat, type AccountKeys, type Keyring, type SavedAccountKeys } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { VaultBuilderClient, AccountCallChainOnTheWire } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { assets as theAssets, type AssetRegistry } from '../../../../src/core/assets.js';
import { fromHex } from '../../../../src/core/crypto.js';
import type { PaymentsAmong } from '../../../../src/core/ledger.js';
import { buildOneOffRun, type DetailsOfKind } from '../../../../src/midnight/payout-tree.js';
import { openOneOff } from '../../../../src/midnight/one-off-record.js';
import type { NetworkName } from '../../../../src/midnight/network.js';
import { type SealedCompanyRecord } from '../../../../src/midnight/sealed-record-wire.js';
import { SPENDING_POLICY_KIND } from '../../../../src/midnight/spending-policy-record.js';
import { detailsOfKind } from '../../../../src/midnight/vault-details.js';
import { HttpCompanyRecordStore } from '../../../../packages/web-shared/src/http-sealed-pool-store.js';
import { readPeopleHere } from '../../../../packages/web-shared/src/people-read-here.js';
import { readVendorsWithKeys } from '../../../../packages/web-shared/src/vendors-on-device.js';
import { signedClaimRefusal } from '../../../../packages/web-shared/src/signed-claim-refusal.js';
import { chainReadThroughTheWallet } from '../../../../packages/web-shared/src/spending-policy-here.js';
import type { TreeKept } from '../../../../packages/web-shared/src/tree-kept-here.js';
import { deviceSignerFrom, filingRefusalCodeOf, judgeIn, seatNotBelievedHere, type DirectoryHere } from '../../../../packages/web-shared/src/vault-page-doors.js';
import { NETWORK } from 'midnight-identity/network';
import { serviceNotReached, THROUGH_THE_SERVICE, type ChainCall, type HandOver } from '../../../../packages/web-shared/src/hand-over.js';
import { provenOnTheChainAlready, straightFromTheOwnWallet, type FeeAndSubmit, type OwnWalletDoors } from '../chain/sent-straight-to-the-chain.js';
import { toTheCompanysService } from '../chain/sent-to-the-companys-service.js';
import {
  COMPANY_SERVICE_RECORD, OUR_SERVICE, openCompanyService, openedWithTheCompanyKey, serviceAddressRefusal, serviceInForce, type CompanyService, type ServiceInForce,
  type ServiceOpener, type ServiceVersion,
} from '../../../../src/midnight/company-service-record.js';
import { companyRecordKey } from '../../../../src/midnight/seat-directory.js';
import { companyRecordEntry, recordKeyOf } from '../../../../src/midnight/record-manifest.js';
import { verifiedCompanyFiler } from '../../../../src/midnight/sealed-record-wire.js';
import { intentShapeOf } from 'midnight-identity/profile/act-shape';
import { routeOf } from 'midnight-identity/profile/act-intents';
import { StepRefused, type StepContext, type Words } from './definition.js';
import { fellBackLine, type FellBack } from './fall-back-line.js';


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
  payments?(account: AccountAddress, label: CompanyLabel, entries: readonly string[]): Promise<AccountPaymentFacts | Words>;
  /** What the account holds under each of these keys, as this wallet's indexer shows it; a vault's spending policy is read from it. */
  roles?(account: AccountAddress, label: CompanyLabel, keys: readonly string[]): Promise<readonly AccountRoleEntry[] | Words>;
  /** The indexer this wallet reads the chain through. */
  readonly indexer: { readonly indexerUri: string; readonly indexerWsUri: string };
  /** The person's own wallet, which pays the fee of a call sent straight to the chain. Absent, no call goes that way. */
  readonly ownWallet?: (identity: Identity, account: number) => OwnWalletDoors;
  /** How this wallet reaches the company's own service, when the company chose one; absent, the browser's own. */
  readonly fetch?: typeof fetch;
}

/**
 * Everything a step reads a company with, from the wallet's own reads and keys. Read once, it may be kept for the
 * action's later steps (`keptReach`): its calls to the service go through the step it was last handed to.
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
  /** The service, through the page, as the step it was last handed to: throws on a refusal, with the service's own words. */
  readonly api: (path: string, init?: RequestInit) => Promise<any>;
  /** A record store's way to the service, through the page, as the step it was last handed to. */
  readonly send: WireSend;
  /** Hands the read to the step now running: every call and send from here on, the judges' own among them, is that step's. */
  readonly stepTo: (ctx: Pick<StepContext, 'call'>) => void;
  readonly holders: () => Promise<AccountHoldersRead>;
  readonly judges: ReturnType<typeof companyJudges>;
  readonly sealed: SealedAccount;
  /** The company's key this seat was given, opened with the seat's own wrapping secret from the company's record. */
  readonly served: () => Hex;
  readonly companyKeys: CompanyKeyHere;
  readonly roster: () => Promise<OpenedAccount>;
  readonly builder: VaultBuilderClient;
  readonly chain: CompanyChain;
  /** Where every call this action finishes is handed over (`handOverFor`); absent, through our service. */
  readonly handOver?: HandOver;
  /** The company's choice of service as this wallet read it (`companyServiceHere`), or why it could not be read. */
  readonly service?: ServiceRead;
  /** Opens this seat's copy of a version of the company's choice of service, for an act that reads its versions. */
  readonly opener: ServiceOpener;
}

/**
 * **WHERE EVERY CALL AN ACTION FINISHES GOES, AND WHO PAYS ITS FEE.** Decided by the company's choice of service
 * (`companyServiceHere`), a setting the company files; never asked of the person, never the act's or the page's.
 *
 * - Our service: it pays the fee and submits, as it always has. When it answers that it took nothing because it
 *   could not (`ourServiceTookNothing`), or cannot be reached with nothing handed over, the call goes straight to
 *   the chain instead. When the call went out and no answer came back, the wallet reads the chain for that very
 *   call first and sends it straight only when it is not there. A call the service answered for is never sent again.
 * - The company's own service: the call is handed to it finished, its fee paid. An address the company's choice
 *   could not have named refuses every hand-over before anything is paid. A service there that gives no answer at
 *   all is gone around the same way: the chain is read for the finished call, and absent, the wallet sends it.
 * - No service, or a choice this wallet could not read: straight to the chain from the person's wallet for this
 *   account. An unread choice is never taken as ours, so our service cannot undo the company's choice by withholding
 *   it.
 *
 * Off our service's way the fee is our sponsorship's (`sponsor`), which only adds it, or the person's own DUST when
 * sponsorship cannot pay or cannot be reached (`sentFromTheOwnWallet`). A wallet this device cannot reach leaves no
 * way but our service. A fallback used is told once, as one plain line at the end of the window (`ctx.show`). Every
 * call this wallet hands over itself is told to the action (`ctx.sentByTheWallet`), since the page never sees it, and
 * a call the chain shows after our service gave no answer is told too (`ctx.seenOnTheChain`).
 */
export function handOverFor(
  ctx: Pick<StepContext, 'held' | 'signal'> & Partial<Pick<StepContext, 'show' | 'sentByTheWallet' | 'seenOnTheChain'>>, chain: Pick<CompanyChain, 'ownWallet' | 'fetch'>,
  service: ServiceRead = { choice: OUR_SERVICE }, now: () => number = Date.now,
  sponsor?: FeeAndSubmit['sponsor'],
): HandOver {
  const account = ctx.held.account;
  const own = chain.ownWallet;
  const fell = new Set<FellBack>();
  const note = (why: FellBack): void => {
    fell.add(why);
    const key = fellBackLine(fell);
    if (key !== undefined) ctx.show?.({ key });
  };
  /* Each call has its own mark of whether it was handed over, so a call refused before its hand-over undoes its own fee. */
  const sent = (submit?: FeeAndSubmit['submit']) => (account === undefined || own === undefined ? undefined
    : (tx: string, call: ChainCall) => straightFromTheOwnWallet(() => own(ctx.held.identity, account), now, () => !ctx.signal.aborted, { over: false }, {
      ...(sponsor === undefined ? {} : { sponsor }), ...(submit === undefined ? {} : { submit }), ownDustPaid: () => note('own-dust'),
      unreached: () => note('unreached'), handedOver: () => ctx.sentByTheWallet?.(),
    })(tx, call));
  const choice = 'unread' in service ? null : service.choice;
  if (choice !== null && choice.service === 'ours') {
    const toChain = sent();
    if (toChain === undefined || account === undefined || own === undefined) return THROUGH_THE_SERVICE;
    let taken = false;
    /* The wallet's own read of the chain for the very call it handed our service, its doors stopped after. */
    const landed = async (tx: string): Promise<boolean> => {
      const o = own(ctx.held.identity, account);
      try {
        const there = await provenOnTheChainAlready(o, tx);
        if (there) ctx.seenOnTheChain?.();
        return there;
      } finally {
        await o.stop?.().catch(() => undefined);
      }
    };
    return Object.freeze({
      path: 'service' as const,
      fallback: Object.freeze({
        toChain, fellBack: (why?: 'unreached') => { taken = true; note(why ?? 'chain'); }, taken: () => taken, landed,
      }),
    });
  }
  if (choice !== null && choice.service === 'own') {
    const bad = serviceAddressRefusal(choice.at);
    if (bad !== null) return Object.freeze({ path: 'company-service' as const, at: choice.at, refused: `${bad}. Nothing was sent.` });
    const toChain = sent(toTheCompanysService(choice.at, chain.fetch));
    return Object.freeze({ path: 'company-service' as const, at: choice.at, ...(toChain === undefined ? {} : { toChain }) });
  }
  const straight = sent();
  const toChain = straight === undefined || choice !== null ? straight
    : async (tx: string, call: ChainCall) => { note('unread'); await straight(tx, call); };
  return Object.freeze({ path: 'chain' as const, ...(toChain === undefined ? {} : { toChain }) });
}

/*
 * Our fee sponsorship for this act: the call handed to our service's fee route, which adds only the fee and hands
 * it back finished, with the way to tell it this wallet is done with that call. Absent when the act's own route
 * list does not carry that route, so asking it never stops the window.
 */
export const sponsorFor = (
  intent: Pick<StepContext['intent'], 'name'>, accountId: string, api: CompanyReach['api'],
): FeeAndSubmit['sponsor'] => {
  const path = `/api/accounts/${encodeURIComponent(accountId)}/fee`;
  const shape = intentShapeOf(intent.name);
  if (shape === undefined || routeOf(shape, 'POST', path) === null) return undefined;
  const donePath = `${path}/done`;
  const told = routeOf(shape, 'POST', donePath) !== null;
  return async (tx, call) => {
    const back = await api(path, { method: 'POST', body: JSON.stringify({ tx, kind: call.kind, contract: call.contract, circuit: call.circuit }) }) as { tx?: unknown; booking?: unknown } | null;
    if (typeof back?.tx !== 'string' || back.tx.length === 0) throw new Error('the fee sponsorship handed back no call. Nothing was paid or sent; try again');
    const booking = back.booking;
    return {
      tx: back.tx,
      ...(told && typeof booking === 'string'
        ? { done: async () => { await api(donePath, { method: 'POST', body: JSON.stringify({ booking }) }); } } : {}),
    };
  };
};

/** Every read of the company's choice of service, as one act asks the page for it. */
const SERVICE_READS = (accountId: string): readonly ['GET' | 'POST', string][] => {
  const at = `/api/accounts/${encodeURIComponent(accountId)}`;
  return [
    ['GET', companyWirePaths.versions(accountId, COMPANY_SERVICE_RECORD.kind, COMPANY_SERVICE_RECORD.id)],
    ['GET', `${at}/directory`], ['POST', `${at}/manifest/entries`], ['POST', `${at}/manifest/newest`], ['POST', `${at}/manifest/tree/proofs`],
    ['GET', `${at}/manifest/tree/pending?root=0`], ['GET', `${at}/manifest/tree/headers?after=0&limit=1`],
  ];
};

/**
 * How this seat opens a version of the company's choice of service: its own copy with `keyOf`, which the caller makes
 * from the secret it holds, and the company's copy with the company's key at the version's epoch, as this device holds
 * it (`keyAt`, which throws for an epoch it holds no key for). The keys stay with the caller; the record is handed only
 * the opened copy.
 */
export const serviceOpenerFor = (
  accountId: string, signerId: string, keyOf: ServiceOpener['keyOf'], companyKeys: Pick<CompanyKeyHere, 'keyAt'>,
): ServiceOpener => ({
  signerId, keyOf, companyCopy: openedWithTheCompanyKey(accountId, (epoch) => companyKeys.keyAt(epoch)),
});

/** The company's choice of service as read, or why it could not be read whole. */
export type ServiceRead = ServiceInForce | { readonly unread: string };

const whyOf = (e: unknown): string => String((e as Error)?.message ?? e).replace(/\s*Nothing was [a-z ]+\.?/giu, '').replace(/\.\s*$/u, '');

/**
 * **THE COMPANY'S CHOICE OF SERVICE, AS THIS WALLET READS IT** from the company's own record of it, beside the
 * company's anchored records, which say every version that exists (`serviceFromVersions`). Our service is the
 * answer only when those records show none was ever filed. A version they name that was not served, or any read
 * that fails, leaves the choice unread, which refuses the service path and leaves the chain path open. An act
 * that may not ask the page for the record asks nothing and is our service: that is the act's own list, which
 * no answer of the service can change.
 */
export async function companyServiceHere(
  r: Pick<CompanyReach, 'accountId' | 'api' | 'judges' | 'label' | 'account' | 'companyKeys' | 'roster'> & { readonly opener: ServiceOpener },
  ctx: Pick<StepContext, 'intent'>,
): Promise<ServiceRead> {
  const shape = intentShapeOf(ctx.intent.name);
  if (shape === undefined || SERVICE_READS(r.accountId).some(([method, path]) => routeOf(shape, method, path) === null)) {
    return { choice: OUR_SERVICE, unchosen: 'this act does not read the company\'s choice of service, so its calls go through ours' };
  }
  const filed = await companyServiceFiledHere(r);
  return 'unread' in filed ? { unread: filed.unread } : serviceInForce(filed.versions, filed.needed);
}

/**
 * The versions of the company's choice of service this seat counts, read as `companyServiceHere` reads them, for
 * an act that files the next version: it seals and counts from what this returns. Any read that fails is unread.
 */
export async function companyServiceFiledHere(
  r: Pick<CompanyReach, 'accountId' | 'api' | 'judges' | 'label' | 'account' | 'companyKeys' | 'roster'> & { readonly opener: ServiceOpener },
): Promise<ServiceFiled | ServiceUnread> {
  const { kind, id } = COMPANY_SERVICE_RECORD;
  try {
    const b = await r.api(companyWirePaths.versions(r.accountId, kind, id)).catch((e: unknown) => {
      if ((e as { status?: unknown } | null)?.status === 404) return null;
      throw e;
    }) as { versions?: unknown } | null;
    const served = Array.isArray(b?.versions)
      ? b!.versions.map((m) => fromCompanyWire(m, { company: r.accountId, kind, id }).sealed) : [];
    const here = await r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster)({ records: [{ store: 'company', kind, id }] }) as DirectoryHere;
    const judge = judgeIn(here);
    const named = versionsNamedIn(here.records);
    return serviceVersionsFrom(served, {
      company: r.accountId, judge, needed: here.holders.policyBar ?? here.holders.approvals, me: r.opener,
      named, withheld: served.length === 0 ? withheldIn(judge, { store: 'company', kind, id }) : null,
      seatedNow: (filer) => {
        const seat = here.dir.seats.find((x) => x.signingKey.toLowerCase() === filer.toLowerCase());
        return seat !== undefined && seatNotBelievedHere(here, seat) === null;
      },
    });
  } catch (e) {
    return { unread: whyOf(e) };
  }
}

/** Why the company's records say the record was withheld; a judge that cannot say is taken as withholding it. */
const withheldIn = (judge: ReturnType<typeof judgeIn>, read: { readonly store: 'company'; readonly kind: string; readonly id: string }): string | null =>
  (judge.withheld === undefined ? 'this wallet cannot tell which versions the company\'s records hold' : judge.withheld(read));

/** Every version of the company's choice of service its anchored records name: those anchored, and those entered since. */
export const versionsNamedIn = (records: Pick<DirectoryHere['records'], 'history' | 'notYetAnchored'>): readonly number[] => {
  const key = recordKeyOf({ store: 'company', ...COMPANY_SERVICE_RECORD });
  return [
    ...(records.history.get(key) ?? []).map((v) => v.version),
    ...records.notYetAnchored.filter((e) => recordKeyOf(e) === key).map((e) => e.version),
  ];
};

/** The versions of the company's choice of service a seat counts, the seats a choice needs, and the highest served. */
export interface ServiceFiled {
  readonly versions: readonly ServiceVersion[];
  readonly needed: number;
  /** The highest version served, believed or not: the next version filed is the one after it. */
  readonly highest: number;
  /** The highest version served when no entry in the company's records names it: not counted, and filed over. */
  readonly unentered?: SealedCompanyRecord;
}

/**
 * The choice could not be read whole. `fileOver` is set when the only reasons are ones a seat resolves by filing the
 * next version: the newest served was never entered, a version this seat cannot open is passed over below the bar,
 * or the choice agreed is no longer agreed by the signers seated now. It holds what this seat counts after them.
 */
export interface ServiceUnread {
  readonly unread: string;
  readonly fileOver?: ServiceFiled;
}

/** What `serviceVersionsFrom` is given beside the versions served. */
interface ServiceReadDoors {
  readonly company: string;
  readonly judge: (filer: Hex | null, kind: 'policy', recordKey: string, read: ReturnType<typeof companyRecordEntry>, newest: boolean, sealedAt?: number) => string | null;
  readonly needed: number;
  readonly me: ServiceOpener;
  /** Every version the company's anchored records name, anchored or entered since. */
  readonly named: readonly number[];
  /** Why the anchored records say a version was withheld, or null. */
  readonly withheld: string | null;
  /** Whether the seat that signs with this key is one this device believes seated now. */
  readonly seatedNow: (filer: Hex) => boolean;
}

/** The choice in force among the versions served (`serviceVersionsFrom`), or why it cannot be read whole. */
export function serviceFromVersions(served: readonly SealedCompanyRecord[], d: ServiceReadDoors): ServiceRead {
  const filed = serviceVersionsFrom(served, d);
  return 'unread' in filed ? { unread: filed.unread } : serviceInForce(filed.versions, filed.needed);
}

const NO_LONGER_AGREED = 'the company\'s choice of service was agreed by signers who are no longer seated, and the signers '
  + 'seated now have not filed it as many times as it needs, so it is not read as ours. A seated signer files the choice again';

/**
 * The versions this seat counts among those served, or why the choice cannot be read whole:
 * - every version the company's anchored records name must be served, and none withheld;
 * - each version is judged before it is opened, the highest served as the newest there is. A version the anchored
 *   records do not name is dropped unopened (never entered, or passed over by the records); the highest refused only
 *   as never entered is not counted and leaves the choice unread until a later version is filed over it. A version
 *   they name refused for any other reason leaves the choice unread: one served as other bytes is never dropped,
 *   so a service cannot take a filing out of the count. Only one filed by a seat no longer seated is not counted;
 * - a believed version this seat cannot open (filed in the old form, wrapped to the seats alone, before it was
 *   seated; sealed at an epoch whose company key this device does not hold; or whose copies will not open) is
 *   passed over, with every version before it, only when the versions after it agree a choice by themselves;
 *   otherwise the choice is unread. The choice those later versions agree is the one all of them agree, since a
 *   count only grows with earlier versions and the choice in force is the newest one agreed;
 * - a choice the company agreed that the signers seated now no longer agree, because seats that filed it have
 *   left, is unread, never ours: our service is the answer only for a company whose seats never agreed a choice.
 */
export function serviceVersionsFrom(served: readonly SealedCompanyRecord[], d: ServiceReadDoors): ServiceFiled | ServiceUnread {
  const { kind, id } = COMPANY_SERVICE_RECORD;
  if (d.withheld !== null) return { unread: d.withheld };
  const given = new Set(served.map((rec) => rec.version));
  const named = new Set(d.named);
  const missing = [...named].sort((a, b) => a - b).find((v) => !given.has(v));
  if (missing !== undefined) {
    return { unread: `the company's records name version ${missing} of the company's choice of service, and the service did not give it` };
  }
  const highest = Math.max(0, ...served.map((rec) => rec.version));
  let versions: ServiceVersion[] = [];
  /* The same versions with those of seats no longer seated, to tell a choice once agreed from one never agreed. */
  let all: ServiceVersion[] = [];
  let passedOver: string | null = null;
  let unentered: { readonly rec: SealedCompanyRecord; readonly why: string } | null = null;
  for (const rec of [...served].sort((a, b) => a.version - b.version)) {
    const filer = verifiedCompanyFiler(rec);
    const ours = rec.company === d.company && rec.kind === kind && rec.id === id;
    const refused = ours ? d.judge(filer, kind, companyRecordKey(kind, id), companyRecordEntry(rec), rec.version === highest, rec.keyEpoch) : 'it is filed for another record';
    let left = false;
    if (refused !== null) {
      const code = filingRefusalCodeOf(refused);
      if (rec.version === highest && code === 'not-entered' && !named.has(rec.version)) { unentered = { rec, why: refused }; continue; }
      if (rec.version === highest && code !== 'seat-not-seated') return { unread: refused };
      if (!named.has(rec.version) || code === 'past-its-boundary') continue;
      if (code !== 'seat-not-seated') return { unread: refused };
      left = true;
    }
    if (filer === null) continue;
    left ||= !d.seatedNow(filer);
    let choice: CompanyService;
    try {
      choice = openCompanyService(rec, d.me);
    } catch (e) {
      all = [];
      if (left) continue;
      passedOver = whyOf(e);
      versions = [];
      continue;
    }
    all.push({ version: rec.version, filer, choice });
    if (!left) versions.push({ version: rec.version, filer, choice });
  }
  const filed: ServiceFiled = { versions, needed: d.needed, highest, ...(unentered === null ? {} : { unentered: unentered.rec }) };
  const seated = serviceInForce(versions, d.needed);
  if (passedOver !== null && seated.unchosen !== undefined) return { unread: passedOver, fileOver: filed };
  const once = serviceInForce(all, d.needed);
  if (once.unchosen === undefined && (seated.unchosen !== undefined || canonical(once.choice) !== canonical(seated.choice))) {
    return { unread: NO_LONGER_AGREED, fileOver: filed };
  }
  if (unentered !== null) return { unread: unentered.why, fileOver: filed };
  return filed;
}

/**
 * The hand-over with `handed.over` set the moment a call may have reached the network: once the wallet sends it,
 * or once it fails anywhere but before the network was handed it.
 */
export const handOverMarked = (given: HandOver | undefined, handed: { over: boolean }): HandOver => {
  const over = given ?? THROUGH_THE_SERVICE;
  const marked = (toChain: NonNullable<HandOver['toChain']>): NonNullable<HandOver['toChain']> => async (tx, call) => {
    try {
      await toChain(tx, call);
    } catch (e) {
      if ((e as { nothingWasSent?: unknown } | null)?.nothingWasSent !== true) handed.over = true;
      throw e;
    }
    handed.over = true;
  };
  if (over.toChain === undefined && over.fallback === undefined) return over;
  return Object.freeze({
    ...over,
    ...(over.toChain === undefined ? {} : { toChain: marked(over.toChain) }),
    ...(over.fallback === undefined ? {} : { fallback: Object.freeze({ ...over.fallback, toChain: marked(over.fallback.toChain) }) }),
  });
};

const HEX64 = /^[0-9a-f]{64}$/u;

/**
 * A call made through the page, as a fetch: the body read as JSON; a refusal thrown with the service's words, its
 * status and its code, marked as nothing sent when the answer says so (or, saying neither, its words do).
 */
export const apiOver = (ctx: Pick<StepContext, 'call'>) => async (path: string, init?: RequestInit): Promise<any> => {
  const method = (init?.method ?? 'GET').toUpperCase() as 'GET' | 'PUT' | 'POST';
  const body = typeof init?.body === 'string' ? init.body : undefined;
  const answered = await ctx.call(method, path, body);
  if (answered.status >= 200 && answered.status < 300) return answered.body;
  const said = (answered.body as { error?: unknown } | null)?.error;
  const why = typeof said === 'string' ? said : `the company's service answered ${answered.status}`;
  const marked = answered.body as { nothingWasSent?: unknown; code?: unknown } | null;
  throw Object.assign(new Error(why), {
    status: answered.status,
    nothingWasSent: typeof marked?.nothingWasSent === 'boolean' ? marked.nothingWasSent : /Nothing was sent/u.test(why),
    ...(typeof marked?.code === 'string' ? { code: marked.code } : {}),
  });
};

/** A record store's way to the service, through the page. */
export const sendOver = (ctx: Pick<StepContext, 'call'>): WireSend => async (path, init) =>
  ctx.call(init.method, path, init.body);

/** The company's key this wallet derives for the person and this company, as it releases it to a page that asks. */
export const companyKeyOf = (ctx: Pick<StepContext, 'held' | 'asker'>, label: CompanyLabel, account: AccountAddress): Hex => {
  const key = unlockKeyFor(ctx.held.identity, {
    schema: 'midnight-identity/disclosure-request/v1', kind: 'unlock', requester: ctx.asker, purpose: '', nonce: 'act', expiresAt: 0,
    company: label, account,
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
  ctx: StepContext, held: Keyring,
  accountId: string, seats: readonly string[], builder: VaultBuilderClient,
): Promise<(SavedAccountKeys & { readonly signerId: string }) | null> {
  const onChain = new Set(seats.map((x) => x.toLowerCase()));
  for (const p of Object.values(held.pendingSeats ?? {})) {
    if (p.accountId !== accountId || typeof p.scope !== 'string' || !HEX64.test(p.scope.toLowerCase())) continue;
    const leaf = (await builder.ownSeat({ signingSecret: p.signingSecret, blinding: p.blinding, scope: p.scope })).toLowerCase();
    if (!onChain.has(leaf)) continue;
    let rec: { wrappedKeys?: Array<{ signerId?: unknown }> } | null;
    try { rec = await apiOver(ctx)(`/api/accounts/${encodeURIComponent(accountId)}`); } catch (e) { if (serviceNotReached(e)) throw e; return null; }
    const mine = (rec?.wrappedKeys ?? []).find((w) => {
      try { unwrapKey(w as never, p.wrappingSecret); return true; } catch { return false; }
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
 * Reads the company the action names, refusing (`StepRefused`, with `why`) a
 * record this person holds no seat on, an account that does not carry the
 * label, and a seat the chain does not hold. A seat kept only as waiting
 * (`admittedFromWaiting`) is kept as the company's seat here first, once the
 * roster names it. The company's sealed records come from its service alone:
 * when it cannot be reached, the action is refused (`RECORDS_UNREACHED`). Its
 * choice of service is read too, and a choice that cannot be read sends the
 * action's calls straight to the chain (`handOverFor`).
 */
export async function companyReachFor(
  ctx: StepContext, chain: CompanyChain, builder: VaultBuilderClient, why: (key: string) => Words,
): Promise<CompanyReach> {
  const refuse = (key: string): never => { throw new StepRefused(why(key)); };
  const accountId = ctx.intent.fields['record'] ?? refuse('not-a-company');
  const label = readCompanyLabel(ctx.intent.fields['company']) ?? refuse('not-a-company');
  const account = readAccountAddress(ctx.intent.fields['account']) ?? refuse('not-a-company');
  if (ctx.keyring === null) return refuse('no-saved-keys');
  const keyring = ctx.keyring;
  const held = keyring.open().read();
  const read = await chain.holders(account, label);
  if ('key' in read) throw new StepRefused(read);
  const kept = held.accounts[accountId];
  const admitted = kept === undefined ? await onlyTheServiceHolds(() => admittedFromWaiting(ctx, held, accountId, read.seats, builder)) : null;
  const seat: SavedAccountKeys = kept ?? admitted ?? refuse('no-seat');
  const scope = typeof seat.scope === 'string' && HEX64.test(seat.scope) ? seat.scope as Hex : refuse('no-seat');
  const leaf = (await builder.ownSeat({ signingSecret: seat.signingSecret, blinding: seat.blinding, scope })).toLowerCase() as Hex;
  if (!read.seats.some((s) => s.toLowerCase() === leaf)) refuse('seat-not-held');
  const holders = async (): Promise<AccountHoldersRead> => {
    const now = await chain.holders(account, label);
    if ('key' in now) throw new StepRefused(now);
    return now;
  };
  /* The step every call goes through: the one that read the company, until a later step takes the read over. */
  let calls: Pick<StepContext, 'call'> = ctx;
  const through: Pick<StepContext, 'call'> = { call: (method, path, body) => calls.call(method, path, body) };
  const api = apiOver(through);
  const companyKey = companyKeyOf(ctx, label, account);
  const servedKeyFor = (rec: { id: string; wrappedKeys: any[] }): Hex => {
    if (rec.id !== accountId) throw new Error('that is not the company this action is on.');
    const wrapped = rec.wrappedKeys.find((w: { signerId?: unknown }) => w.signerId === seat.signerId);
    if (wrapped === undefined) throw new Error('your seat has not been given the company\'s key yet.');
    return unwrapKey(wrapped, seat.wrappingSecret) as Hex;
  };
  const shown = { signerId: seat.signerId, signingPublicKey: signingPublicKeyOf(seat.signingSecret).toLowerCase() };
  const doors = {
    api, keysFor: (id: string) => (id === accountId ? shown : null), servedKeyFor,
  };
  const judges = companyJudges({
    api,
    holders: async (l: CompanyLabel, a: AccountAddress) => {
      if (l !== label || a !== account) throw new Error('that is not the company this action is on.');
      return holders();
    },
    indexer: async () => chain.indexer,
    builder: async () => builder,
    keysFor: doors.keysFor,
    servedKeyFor,
    released: (id) => (id === accountId ? companyKey : null),
    askReleased: async (id) => (id === accountId ? companyKey : null),
    treeKept: () => treeKeptHere(),
    openAccount: (...a) => openAccountWith(doors, ...a),
    seatsAdmittedFor: (...a) => seatsAdmittedWith(doors, ...a),
    noAccount: () => refuse('not-on-chain'),
  });
  const sealed = await onlyTheServiceHolds(() => api(`/api/accounts/${encodeURIComponent(accountId)}`)) as SealedAccount;
  if (sealed?.id !== accountId || sealed.companyLabel !== label || String(sealed.contractAddress).toLowerCase() !== account) refuse('not-a-company');
  const companyKeys = await onlyTheServiceHolds(() => judges.companyKeysFor(accountId, sealed, seat));
  const roster = async (): Promise<OpenedAccount> => {
    const opened = await judges.openedHere(await api(`/api/accounts/${encodeURIComponent(accountId)}`) as SealedAccount);
    return opened ?? refuse('roster-not-opened');
  };
  if (admitted !== null) {
    /* A seat taken by address and kept only as waiting: kept as this company's seat once the roster names it, active,
     * under the id the company's key was wrapped to it by, with the leaf the chain holds. */
    const named = (await onlyTheServiceHolds(roster)).signers.find((x) => x.id === admitted.signerId && x.status === 'active');
    if (named === undefined || String(named.leafCommitment).toLowerCase() !== leaf) refuse('no-seat');
    await keyring.keep((k) => withNewSeat(k, accountId, admitted as AccountKeys));
  }
  /* The company's choice of service is opened, as its spending policies are, with the records key this seat's device
   * holds from the company key, or with the company's key at the version's epoch; the keys stay here and the record is
   * handed only the opened copy. */
  const signer = deviceSignerFrom(leaf, companyKey);
  const opener = serviceOpenerFor(accountId, signer.signerId, (wrapped) => unwrapKey(wrapped, signer.wrappingSecret) as Hex, companyKeys);
  const service = await companyServiceHere({ accountId, api, judges, label, account, companyKeys, roster, opener }, ctx);
  return Object.freeze({
    accountId, label, account, seat: { ...seat, scope }, leaf, companyKey, api, send: sendOver(through), holders, judges, sealed, served: () => servedKeyFor(sealed), companyKeys, roster,
    builder, chain, service, opener, handOver: handOverFor(ctx, chain, service, Date.now, sponsorFor(ctx.intent, accountId, api)),
    stepTo: (next: Pick<StepContext, 'call'>) => { calls = next; },
  });
}

/**
 * A company read once for an action and kept for its later steps, as each step that takes it: `at` reads it in the
 * first step that needs it and hands it to every later one without reading it again; `renew` lets it go, so the next
 * step reads the company again (after the company's key changed, every seal is under the new key).
 */
export function keptReach(readFor: (ctx: StepContext) => Promise<CompanyReach>) {
  let read: CompanyReach | null = null;
  return {
    at: async (ctx: StepContext): Promise<CompanyReach> => {
      if (read === null) {
        read = await readFor(ctx);
        return read;
      }
      read.stepTo(ctx);
      return read;
    },
    renew: (): void => { read = null; },
  };
}

/**
 * Who may approve each vault's runs, counted from the roster this wallet believes and the seats the chain holds, for
 * the check that a change leaves no vault unable to pay. Refused while the roster names no signer for a seat the chain
 * holds (`notBelieved`), such as one waiting for Finish adding: a count without that seat is not the company's. With
 * `removals`, the signers removed since the open run they outran most was raised are counted against every vault the
 * account holds, naming that run: which vault a run pays from is sealed in its record, so the count can only refuse
 * more, never less. For a removal (`o.removal`), every vault the account holds is counted as holding an open run while
 * any run is open on the chain, so the one approval more the removal adds to every open run is counted, naming a run.
 */
export const approversHere = async (
  r: Pick<CompanyReach, 'roster' | 'holders' | 'builder'>,
  removals?: () => Promise<{ readonly removals: number; readonly run: string | null; readonly open?: string | null }>,
  o: { readonly removal?: boolean } = {},
): Promise<ApproverRoster> => {
  const [account, held, wide] = await Promise.all([r.roster(), r.holders(), r.builder.companyWide()]);
  const n = account.notBelieved.length;
  if (n > 0) {
    throw new Error(`the company's roster, as this wallet believes it, names no signer for ${n} seat${n === 1 ? '' : 's'} the `
      + 'company\'s account holds on the network, so it cannot count who approves each vault. Nothing was approved. If a '
      + 'signer is waiting for Finish adding, a signer presses it first; then try again.');
  }
  const outrun: { removals: number; run: string | null; open?: string | null } = removals === undefined ? { removals: 0, run: null } : await removals();
  const since = outrun.removals;
  const counting = o.removal === true && (outrun.open ?? null) !== null;
  const onTheChain = new Set(held.seats.map((x) => x.toLowerCase()));
  return approverRosterFrom({
    threshold: held.approvals, vaultThresholds: held.vaultThresholds,
    seated: account.signers.filter((x) => x.status === 'active' && x.leafCommitment !== null && onTheChain.has(x.leafCommitment.toLowerCase()))
      .map((x) => ({ leaf: x.leafCommitment!, ...(x.rights === undefined ? {} : { rights: x.rights }) })),
    adoptedVaults: held.adoptedVaults, companyWide: wide,
    ...(since > 0 || counting ? {
      removals: since, openRuns: new Set([...held.adoptedVaults, wide].map((v) => v.toLowerCase() as Hex)), ...(outrun.run === null ? {} : { outrunBy: outrun.run }),
      ...(counting && since === 0 ? { openRun: outrun.open! } : {}),
    } : {}),
  });
};

/**
 * **THE RUN OPEN NOW THAT THE MOST REMOVALS HAVE OUTRUN**, and how many signers were removed or replaced since it was
 * raised, read from the chain's open proposals at the indexer this wallet names (`runsOutrun`), so a run the service
 * or the records leave out is still counted; and `open`, one run open on the chain whether or not any removal has
 * outrun it, or null when none is. Each run is named as the company's records name it where the service lists it, and
 * by its identity on the chain otherwise, so a refusal can say which run to withdraw, pay out or raise again.
 */
export const runsOutrunHere = async (r: CompanyReach): Promise<{ readonly removals: number; readonly run: string | null; readonly open: string | null }> => {
  const runs = await r.builder.runsOutrun({ account: r.account, indexer: r.chain.indexer });
  let most: { removals: number; chainId: string | null } = { removals: 0, chainId: null };
  for (const [chainId, removals] of Object.entries(runs)) if (removals > most.removals) most = { removals, chainId: chainId.toLowerCase() };
  const first = Object.keys(runs).map((x) => x.toLowerCase()).sort()[0] ?? null;
  if (most.chainId === null && first === null) return { removals: 0, run: null, open: null };
  const listed = await governedCallServiceFor(r.api).sealedProposals!(r.accountId).catch(() => [] as readonly { id: string; chainId: string }[]);
  const nameOf = (chainId: string): string => {
    const named = (listed as readonly { id: string; chainId: string }[]).find((p) => String(p.chainId).toLowerCase() === chainId);
    return named === undefined ? chainId : `${named.id} (${chainId})`;
  };
  const open = nameOf(most.chainId ?? first!);
  return { removals: most.removals, run: most.chainId === null ? null : nameOf(most.chainId), open };
};

/** What this seat files is entered as it files it, signed with its own key, through the page. */
export const enteredFor = (r: CompanyReach) => recordsEnteredFor(manifestServiceFor(r.api), r.accountId, r.seat.signingSecret);

/** Whether anything of an action has been handed to the service to send, so a refusal after it is never said as nothing sent. */
export interface Handed { over: boolean }

/*
 * The company's records as a change to who is seated reads them: its directory, its state record, its proposals and
 * runs, the proposals the chain holds, by this wallet's own read, and the spending policies, read and never filed. A
 * payroll run's own records are not read for it.
 */
const governanceRecordsFor = (r: CompanyReach): CompanyRecordsHere => {
  const notRead = (what: string) => (): never => { throw new Error(`a change to who is seated reads no ${what}.`); };
  return {
    directory: r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster),
    people: notRead('person of the company'),
    state: async (id) => {
      const b = await r.api(companyWirePaths.one(r.accountId, 'state', id, 1)) as { filed?: unknown } | null;
      return b?.filed == null ? null : fromCompanyWire(b.filed, { company: r.accountId, kind: 'state', id, version: 1 }).sealed;
    },
    runs: async () => r.api(`/api/accounts/${encodeURIComponent(r.accountId)}/runs`),
    proposals: async () => governedCallServiceFor(r.api).sealedProposals!(r.accountId),
    roundsOnChain: (chainIds) => r.builder.roundsOnChain({ account: r.account, indexer: r.chain.indexer, chainIds, seat: r.seat.signingSecret }),
    payments: { paidOnceOf: notRead('payment'), paidMovementOf: notRead('payment'), read: notRead('payment') },
    roundIdentity: { runPayload: notRead('payroll run'), proposalIdOf: notRead('payroll run') },
    policy: notRead('payroll policy'),
    oneOffs: { at: notRead('one-off payment'), keys: r.companyKeys, detailsOf: {} as CompanyRecordsHere['oneOffs']['detailsOf'], open: notRead('one-off payment'), treeOf: notRead('one-off payment') },
    /* Read, never filed: a removal counts each vault's approvers at the top band of its policies in force. */
    spendingPolicies: spendingPoliciesFor(r),
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
  r: CompanyReach, sleep: (ms: number) => Promise<void>, handed: Handed = { over: false },
  o: { readonly waitMs?: number; readonly everyMs?: number } = {},
): GovernanceDoors & { readonly roster: RosterDoors } {
  const service = governedCallServiceFor(r.api);
  const marked = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => (...a: A): Promise<R> => { handed.over = true; return f(...a); };
  const entered = enteredFor(r);
  return {
    service: {
      ...service,
      file: (accountId, body) => { if (body.tx !== undefined) handed.over = true; return service.file!(accountId, body); },
      approve: marked(service.approve),
      send: marked(service.send),
      ...(service.carry === undefined ? {} : { carry: marked(service.carry) }),
      ...(service.retire === undefined ? {} : { retire: marked(service.retire) }),
      ...(service.cancel === undefined ? {} : { cancel: marked(service.cancel) }),
      ...(service.closed === undefined ? {} : { closed: service.closed }),
      callState: async () => {
        const chain = await r.chain.callState(r.account);
        if (chain === null) throw new Error('this wallet could not read the company\'s account at one block, so nothing was built or sent.');
        return { ...chain, account: r.account };
      },
    },
    builder: r.builder,
    material: { signingSecret: r.seat.signingSecret as Hex, blinding: r.seat.blinding as Hex, scope: r.seat.scope },
    accountId: r.accountId,
    records: governanceRecordsFor(r),
    leaves: r.judges.leavesFor(r.account),
    handOver: handOverMarked(r.handOver, handed),
    sleep,
    ...(o.waitMs === undefined ? {} : { waitMs: o.waitMs }),
    ...(o.everyMs === undefined ? {} : { everyMs: o.everyMs }),
    filing: { seat: r.leaf, keyEpoch: r.companyKeys.epoch, salt: () => toHex(randomBytes(32)), newId: () => newProposalId(), entered },
    approvers: () => approversHere(r, () => runsOutrunHere(r)),
    vaultName: (vault) => vault,
    roster: withCompanyKeys({
      api: r.api, accountId: r.accountId, signingSecret: r.seat.signingSecret as Hex, label: r.label, account: r.account,
      reads: r.judges.rosterReadsFor(r.accountId, r.label, r.account), entered,
    }, r.companyKeys),
  };
}

/** The account's and the vault's pure circuits every payment action computes with, read from the compiled contracts this wallet ships. */
export interface PureCircuits {
  readonly account: CompanyRecordsHere['roundIdentity'] & {
    readonly retrySaltOf: (legRoot: Uint8Array, fresh: Uint8Array) => Uint8Array;
    readonly noVault: () => Uint8Array;
    readonly paidOnceOf: (nonce: Uint8Array) => Uint8Array;
    readonly paidMovementOf: (leaf: Uint8Array) => Uint8Array;
  };
  readonly details: DetailsOfKind;
}

let pureLoaded: Promise<PureCircuits> | null = null;
/** The pure circuits, loaded once for every payment action and loaded again only after a failed load. */
export const pureCircuits = (): Promise<PureCircuits> => {
  pureLoaded ??= (async () => {
    const [account, vault] = await Promise.all([
      import('../../../../contracts/managed/contract/index.js'),
      import('../../../../contracts/managed-vault/contract/index.js'),
    ]);
    return { account: (account as any).pureCircuits, details: detailsOfKind((vault as any).pureCircuits) };
  })();
  pureLoaded.catch(() => { pureLoaded = null; });
  return pureLoaded;
};

/** What the records door is read with beyond the company: the currencies, the network payees' addresses are read on, and where this wallet keeps the heads it checked. */
export interface RecordsReach {
  readonly assets?: AssetRegistry;
  readonly network?: NetworkName;
  readonly treeKept?: () => TreeKept;
}

/** The company's records every payment action reads, with the one-off payments' records beside them. */
export type CompanyRecordsInTheWallet = CompanyRecordsHere & {
  readonly oneOffs: NonNullable<CompanyRecordsHere['oneOffs']>;
  readonly proposals: () => Promise<readonly SealedProposal[]>;
};

/**
 * **A VAULT'S SPENDING POLICIES AS THIS SEAT READS THEM, AND NEVER FILES THEM**: every version of a policy's sealed
 * record as the service holds it, each judged where it is used; this seat's key to open them; the contract's keys made
 * in the worker; and what the chain holds under each key, read through this wallet's own indexer. Filing is refused:
 * no action that reads policies through this door, a payment or an approval of another seat's policy, writes one.
 */
export const spendingPoliciesFor = (r: CompanyReach): NonNullable<CompanyRecordsHere['spendingPolicies']> => {
  const me = deviceSignerFrom(r.leaf, r.companyKey);
  return {
    versions: async (id) => {
      const b = await r.api(companyWirePaths.versions(r.accountId, SPENDING_POLICY_KIND, id)) as { versions?: unknown } | null;
      return Array.isArray(b?.versions)
        ? b!.versions.map((m) => fromCompanyWire(m, { company: r.accountId, kind: SPENDING_POLICY_KIND, id }).sealed) as SealedCompanyRecord[] : [];
    },
    file: async () => { throw new Error('a payment, or an approval of another seat\'s policy, files no spending policy.'); },
    me: { signerId: me.signerId, wrappingSecret: me.wrappingSecret as Hex },
    keys: (input) => r.builder.spendingPolicyKeys(input),
    onChain: chainReadThroughTheWallet(async (asked) => {
      if (r.chain.roles === undefined) throw new Error('this wallet cannot read the account\'s entries.');
      const read = await r.chain.roles(r.account, r.label, asked);
      if ('key' in read) throw new StepRefused(read);
      return { roles: read };
    }),
  };
};

/**
 * **THE ONE RECORDS DOOR OF EVERY PAYMENT ACTION IN THE WALLET** (a one-off payment, a payroll run raised or
 * approved). The directory every filing is judged by; the company's people and vendors, read and judged as every
 * device reads them; its ceilings from the roster this wallet opens; its state; its proposals and runs as the service
 * holds them, each judged where it is used; where each proposal stands on the chain and what the account records as
 * paid, read through this wallet's own indexer with this seat; the heads of the company's records this wallet checked
 * itself; a vault's spending policy (sealed records this seat opens, checked against the chain); the one-off records
 * under the company key. Nothing a check or a payment decides on is taken from the service's word.
 */
export function companyRecordsFor(r: CompanyReach, reach: RecordsReach, pure: PureCircuits): CompanyRecordsInTheWallet {
  const registry = reach.assets ?? theAssets;
  const network = reach.network ?? NETWORK;
  const directory = r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const judge = r.judges.filingJudgeFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const store = new HttpCompanyRecordStore(r.accountId, r.send, null, judge);
  const served = async (path: string): Promise<unknown> => r.api(path);
  return {
    directory,
    people: () => readPeopleHere({
      company: withCompanyKeys({ id: r.accountId, label: r.label }, r.companyKeys), send: async (path, init) => {
        if (init.method === 'POST') throw new Error('reading the company\'s people writes nothing.');
        return r.send(path, { method: init.method, ...(init.body === undefined ? {} : { body: init.body }) });
      },
      directory, network,
      claimRefusal: signedClaimRefusal,
    }),
    vendors: () => readVendorsWithKeys({ id: r.accountId, label: r.label }, r.companyKeys, {
      send: r.send, directory, network, claimRefusal: signedClaimRefusal,
    }),
    state: async (id) => {
      const b = await served(companyWirePaths.one(r.accountId, 'state', id, 1)) as { filed?: unknown } | null;
      return b?.filed == null ? null : fromCompanyWire(b.filed, { company: r.accountId, kind: 'state', id, version: 1 }).sealed;
    },
    runs: async () => r.api(`/api/accounts/${encodeURIComponent(r.accountId)}/runs`),
    proposals: async () => governedCallServiceFor(r.api).sealedProposals!(r.accountId),
    roundsOnChain: (chainIds) => r.builder.roundsOnChain({ account: r.account, indexer: r.chain.indexer, chainIds, seat: r.seat.signingSecret }),
    checked: () => (reach.treeKept ?? treeKeptHere)().checked.read(r.accountId),
    payments: {
      paidOnceOf: (nonce) => pure.account.paidOnceOf(nonce),
      paidMovementOf: (leaf) => pure.account.paidMovementOf(leaf),
      read: async (entries) => {
        if (r.chain.payments === undefined) throw new Error('this wallet cannot read the account\'s record of payments.');
        const read = await r.chain.payments(r.account, r.label, entries);
        if ('key' in read) throw new StepRefused(read);
        return read;
      },
    },
    roundIdentity: pure.account,
    policy: async () => (await r.roster()).policy,
    registry,
    spendingPolicies: spendingPoliciesFor(r),
    oneOffs: {
      at: (kind, id, version) => store.at(kind, id, version), keys: r.companyKeys, detailsOf: pure.details, registry,
      open: openOneOff, treeOf: buildOneOffRun,
    },
  };
}

/** Which of these leaves the account records as paid, read from the chain through this wallet's own indexer. */
export const paidAmongFor = (records: CompanyRecordsHere, pure: PureCircuits) => async (leaves: readonly Hex[]): Promise<PaymentsAmong> => {
  const entries = leaves.map((leaf) => toHex(pure.account.paidMovementOf(fromHex(leaf))).toLowerCase());
  const held = new Set((await records.payments.read(entries)).held.map((e) => e.toLowerCase()));
  return { known: true, paid: leaves.filter((_leaf, i) => held.has(entries[i]!)) as Hex[] };
};
