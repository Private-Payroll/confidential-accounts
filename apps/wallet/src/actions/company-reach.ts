import { unlockKeyFor } from 'midnight-identity/profile/unlock';
import type { UnlockRequest } from 'midnight-identity/profile/request';
import type { Identity } from 'midnight-identity/keys/derivation';
import { readAccountAddress, readCompanyLabel, type AccountAddress, type CompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountHoldersRead, AccountPaymentFacts, AccountRoleEntry } from 'midnight-identity/profile/records-key';
import { randomBytes, signingPublicKeyOf, toHex, unwrapKey, type Hex } from '../../../../src/core/crypto.js';
import type { SealedAccount, SealedProposal } from '../../../../src/core/types.js';
import { newProposalId } from '../../../../src/core/proposal-filing.js';
import { approversHere, runsOutrunHere } from './approvers-here.js';
import { policiesInTheWallet } from './policy-doors-in-the-wallet.js';
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
import { detailsOfKind } from '../../../../src/midnight/vault-details.js';
import { HttpCompanyRecordStore } from '../../../../packages/web-shared/src/http-sealed-pool-store.js';
import { readPeopleHere } from '../../../../packages/web-shared/src/people-read-here.js';
import { readVendorsWithKeys } from '../../../../packages/web-shared/src/vendors-on-device.js';
import { signedClaimRefusal } from '../../../../packages/web-shared/src/signed-claim-refusal.js';
import type { TreeKept } from '../../../../packages/web-shared/src/tree-kept-here.js';
import { deviceSignerFrom } from '../../../../packages/web-shared/src/vault-page-doors.js';
import { NETWORK } from 'midnight-identity/network';
import { serviceNotReached, THROUGH_THE_SERVICE, type ChainCall, type HandOver } from '../../../../packages/web-shared/src/hand-over.js';
import { provenOnTheChainAlready, straightFromTheOwnWallet, type FeeAndSubmit, type OwnWalletDoors } from '../chain/sent-straight-to-the-chain.js';
import { toTheCompanysService } from '../chain/sent-to-the-companys-service.js';
import { OUR_SERVICE, serviceAddressRefusal, type ServiceOpener } from '../../../../src/midnight/company-service-record.js';
import { companyServiceHere, serviceOpenerFor, type ServiceRead } from './company-service-read.js';
import { stopsFor } from './leaving-read-in-the-wallet.js';
import { intentShapeOf } from 'midnight-identity/profile/act-shape';
import { routeOf } from 'midnight-identity/profile/act-intents';
import { StepRefused, type StepContext, type Words } from './definition.js';
import { fellBackLine, type FellBack } from './fall-back-line.js';
import { signerMaterialOf } from '../../../../packages/web-shared/src/private-state.js';


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

/**
 * The hand-over with `handed.over` set the moment a call may have reached the network: once the wallet sends it,
 * or once it fails anywhere but before the network was handed it. A call `before` names comes ahead of the act's own
 * call and is not it, so it is counted in `handed.before` instead and never says the act's own call was handed over.
 */
export const handOverMarked = (given: HandOver | undefined, handed: Handed, before: (call: ChainCall) => boolean = () => false): HandOver => {
  const over = given ?? THROUGH_THE_SERVICE;
  const mark = (call: ChainCall): void => {
    if (before(call)) handed.before = (handed.before ?? 0) + 1;
    else handed.over = true;
  };
  const marked = (toChain: NonNullable<HandOver['toChain']>): NonNullable<HandOver['toChain']> => async (tx, call) => {
    try {
      await toChain(tx, call);
    } catch (e) {
      if ((e as { nothingWasSent?: unknown } | null)?.nothingWasSent !== true) mark(call);
      throw e;
    }
    mark(call);
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

/** What this seat files is entered as it files it, signed with its own key, through the page; nothing more once a removal of its seat is approved (`stopsFor`). */
export const enteredFor = (r: CompanyReach, api: CompanyReach['api'] = r.api) =>
  recordsEnteredFor(manifestServiceFor(api), r.accountId, r.seat.signingSecret, stopsFor(r));

/**
 * Whether anything of an action has been handed to the service to send, so a refusal after it is never said as nothing
 * sent: its own call (`over`), and how many calls that come ahead of it (`before`).
 */
export interface Handed { over: boolean; before?: number }

/*
 * The company's records as a change to who is seated reads them: its directory, its state record, its proposals and
 * runs, the proposals the chain holds, by this wallet's own read, and the spending policies, read and never filed. A
 * payroll run's own records are not read for it.
 */
export const governanceRecordsFor = (r: CompanyReach): CompanyRecordsHere => {
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
    spendingPolicies: policiesInTheWallet(r),
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
    material: signerMaterialOf(r.seat),
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
    spendingPolicies: policiesInTheWallet(r),
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

/* Who may approve each vault's runs is counted in its own file. */
export { approversHere, runsOutrunHere } from './approvers-here.js';
export {
  companyServiceFiledHere, companyServiceHere, serviceFromVersions, serviceOpenerFor, serviceVersionsFrom, versionsNamedIn,
  type ServiceFiled, type ServiceRead, type ServiceUnread,
} from './company-service-read.js';
