import { unlockKeyFor } from 'midnight-identity/profile/unlock';
import type { UnlockRequest } from 'midnight-identity/profile/request';
import { readAccountAddress, readCompanyLabel, type AccountAddress, type CompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountHoldersRead, AccountPaymentFacts, AccountRoleEntry } from 'midnight-identity/profile/records-key';
import { signingPublicKeyOf, toHex, unwrapKey, type Hex } from '../../../../src/core/crypto.js';
import type { SealedAccount } from '../../../../src/core/types.js';
import type { CompanyKeyHere } from '../../../../packages/web-shared/src/company-key-here.js';
import { companyJudges, openAccountWith, seatsAdmittedWith, type OpenedAccount } from '../../../../packages/web-shared/src/company-judges.js';
import type { WireSend } from '../../../../packages/web-shared/src/http-sealed-pool-store.js';
import { recordsEnteredFor, manifestServiceFor } from '../../../../packages/web-shared/src/record-entered-here.js';
import { treeKeptHere } from '../../../../packages/web-shared/src/tree-kept-here.js';
import type { SavedAccountKeys } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { VaultBuilderClient, AccountCallChainOnTheWire } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { StepRefused, type StepContext, type Words } from './definition.js';

/*
 * WHAT AN ACTION ON A COMPANY READS THE COMPANY WITH, IN THE WALLET. The page
 * names the company by the service's record of it, its label and its account;
 * the wallet believes none of the three until its own chain read says the
 * account carries that label and seats the seat it holds for that record. The
 * service is reached only through the page, one call at a time from the
 * action's own route list, and every answer is judged here (`companyJudges`)
 * against the chain and the company's directory before anything rests on it.
 * The seat's secrets and the company's key never leave the wallet.
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
}

const HEX64 = /^[0-9a-f]{64}$/u;

/** A call made through the page, as a fetch: the body read as JSON; a refusal thrown with the service's words, marked when it says nothing was sent. */
export const apiOver = (ctx: Pick<StepContext, 'call'>) => async (path: string, init?: RequestInit): Promise<any> => {
  const method = (init?.method ?? 'GET').toUpperCase() as 'GET' | 'PUT' | 'POST';
  const body = typeof init?.body === 'string' ? init.body : undefined;
  const answered = await ctx.call(method, path, body);
  if (answered.status >= 200 && answered.status < 300) return answered.body;
  const said = (answered.body as { error?: unknown } | null)?.error;
  const why = typeof said === 'string' ? said : `the company's service answered ${answered.status}`;
  throw Object.assign(new Error(why), { status: answered.status, nothingWasSent: /Nothing was sent/u.test(why) });
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

/**
 * Reads the company the action names, refusing (`StepRefused`, with `why`) a
 * record this person holds no seat on, an account that does not carry the
 * label, and a seat the chain does not hold.
 */
export async function companyReachFor(
  ctx: StepContext, chain: CompanyChain, builder: VaultBuilderClient, why: (key: string) => Words,
): Promise<CompanyReach> {
  const refuse = (key: string): never => { throw new StepRefused(why(key)); };
  const accountId = ctx.intent.fields['record'] ?? refuse('not-a-company');
  const label = readCompanyLabel(ctx.intent.fields['company']) ?? refuse('not-a-company');
  const account = readAccountAddress(ctx.intent.fields['account']) ?? refuse('not-a-company');
  if (ctx.keyring === null) return refuse('no-saved-keys');
  const held = ctx.keyring.open().read();
  const seat = held.accounts[accountId] ?? refuse('no-seat');
  const scope = typeof seat.scope === 'string' && HEX64.test(seat.scope) ? seat.scope as Hex : refuse('no-seat');
  const read = await chain.holders(account, label);
  if ('key' in read) throw new StepRefused(read);
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
  const sealed = await api(`/api/accounts/${encodeURIComponent(accountId)}`) as SealedAccount;
  if (sealed?.id !== accountId || sealed.companyLabel !== label || String(sealed.contractAddress).toLowerCase() !== account) refuse('not-a-company');
  const companyKeys = await judges.companyKeysFor(accountId, sealed, seat);
  const roster = async (): Promise<OpenedAccount> => {
    const opened = await judges.openedHere(await api(`/api/accounts/${encodeURIComponent(accountId)}`) as SealedAccount);
    return opened ?? refuse('roster-not-opened');
  };
  return Object.freeze({
    accountId, label, account, seat: { ...seat, scope }, leaf, companyKey, api, send: sendOver(through), holders, judges, sealed, served: () => servedKeyFor(sealed), companyKeys, roster,
    builder, chain,
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

/** What this seat files is entered as it files it, signed with its own key, through the page. */
export const enteredFor = (r: CompanyReach) => recordsEnteredFor(manifestServiceFor(r.api), r.accountId, r.seat.signingSecret);
