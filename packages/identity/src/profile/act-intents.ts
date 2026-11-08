/**
 * THE ACTIONS A PAGE MAY ASK A WALLET TO RUN WHOLE, BY NAME.
 *
 * An `act` ask names one of these and the ids and amounts it acts on, and
 * nothing else: the wallet reads the chain itself, builds every transaction
 * itself and hands each back for the page to send - or, for a recovery of the
 * company's records, sends it from the person's own wallet, which pays its fee
 * and nothing else. So every field an action
 * takes is one of the kinds below: an id or an amount the wallet can check on
 * its own, or a short text the wallet shows as the page's words, and none of
 * them is bytes the page built. An action not named here is refused before
 * anything is shown, and so is a field its entry does not name.
 *
 * Adding an action is one entry here (its fields and their kinds, and what
 * each transaction it hands back is for) and one definition of the same name
 * in the wallet, which will not build without it.
 */

/**
 * What one field of an action may be: a company's label, its account, a vault,
 * a seat, an amount, a currency (`token`, sixty-four hex characters: a private
 * token as the ledger names it, or the asset a one-off payment is made in), the
 * service's own name for a company's record (`record`, a short id the wallet
 * only ever uses to say which record it asks the page for, and checks nothing
 * by), or the page's own words (`words`, a short text such as a vault's name,
 * which the wallet shows as the page's and never treats as anything it read
 * itself).
 */
export type IntentFieldKind = 'company' | 'account' | 'vault' | 'seat' | 'amount' | 'token' | 'record' | 'words';

/**
 * A call to the service an action may ask the page to make for it, and the
 * only calls it may: the method, and the path with `:name` standing for one
 * path segment. `sends` marks a call that carries a transaction to the chain,
 * which is counted with the relays; `sendsWith: 'tx'` marks one that carries a
 * transaction only when its body names one (`sendsIn`). Every answer is the
 * page's word, which the wallet checks before it relies on it.
 */
export interface CallRoute {
  readonly method: 'GET' | 'PUT' | 'POST';
  readonly path: string;
  readonly sends?: boolean;
  /** A call to it sends only when its body carries a transaction under this name. */
  readonly sendsWith?: 'tx';
  /**
   * A POST that only reads: the service answers it and keeps nothing of it. Every other call that is not a GET writes,
   * and the wallet counts it as something that left it.
   */
  readonly reads?: true;
  /** The only query parameters a call to it may carry, each once with a plain value; none unless named. */
  readonly query?: readonly string[];
}

/**
 * What one part of an action's outcome may be: sixty-four hex characters (a vault's address, or a transaction the chain
 * names), a whole number, a short code, or the name of one of the company's records (a run or a proposal it raised).
 */
export type OutcomeKind = 'vault' | 'count' | 'code' | 'record';

/**
 * The fields one action takes, each required unless `optional` names it, and
 * what each transaction it hands back may be for: every relay names one of
 * `relays`, so the page knows where to send it; the page refuses a relay
 * naming anything else, and a call that matches none of `calls`.
 */
export interface IntentShape {
  readonly fields: Readonly<Record<string, IntentFieldKind>>;
  /** The fields an ask may leave out; every other field is required. */
  readonly optional?: readonly string[];
  readonly relays?: readonly string[];
  /** The service calls the page makes for this action; any other is refused by both sides. */
  readonly calls?: readonly CallRoute[];
  /** What the action's end may tell the page besides its counts, all of it public: the only parts it may carry. */
  readonly outcome?: Readonly<Record<string, OutcomeKind>>;
}

const SEGMENT = /^[A-Za-z0-9._~-]{1,128}$/u;

/**
 * The route of `shape` a call matches, or null: the same method, and the same
 * path segment by segment, each `:name` standing for exactly one plain
 * segment. An encoded character, an empty or a dot segment matches nothing,
 * and so does a query unless the route names each of its parameters, so a call
 * can never reach a path its route list does not name.
 */
export function routeOf(shape: IntentShape, method: string, path: string): CallRoute | null {
  if (typeof path !== 'string' || path.length > 512 || !path.startsWith('/api/')) return null;
  const [bare, query, more] = path.split('?');
  if (more !== undefined) return null;
  const parts = bare!.split('/').slice(1);
  if (parts.some((p) => !SEGMENT.test(p) || p === '.' || p === '..')) return null;
  const asked = query === undefined ? [] : query.split('&').map((q) => q.split('='));
  if (asked.some((q) => q.length !== 2 || !/^[a-z]{1,16}$/u.test(q[0]!) || !SEGMENT.test(q[1]!))) return null;
  const names = asked.map((q) => q[0]!);
  if (new Set(names).size !== names.length) return null;
  for (const route of shape.calls ?? []) {
    if (route.method !== method) continue;
    const want = route.path.split('/').slice(1);
    if (want.length !== parts.length) continue;
    if (!names.every((n) => (route.query ?? []).includes(n))) continue;
    if (want.every((w, i) => (w.startsWith(':') ? true : w === parts[i]))) return route;
  }
  return null;
}

/**
 * Whether one call to `route` with `body` hands a transaction to the chain, the one rule both the wallet and the page
 * count sends by. A route marked `sendsWith` sends only when the body names a transaction, so a proposal written down
 * with nothing for the chain is never counted as handed over; a body that does not read as JSON is counted as a send,
 * since it cannot be shown to carry nothing.
 */
export function sendsIn(route: CallRoute, body: string | undefined): boolean {
  if (route.sends !== true) return false;
  if (route.sendsWith === undefined) return true;
  if (body === undefined) return false;
  try {
    const read = JSON.parse(body) as Record<string, unknown> | null;
    const carried = read === null || typeof read !== 'object' ? undefined : read[route.sendsWith];
    return typeof carried === 'string' && carried.length > 0;
  } catch {
    return true;
  }
}

/**
 * What a relay of `finish-company` is for. `creation` and `creation-again`
 * carry the account's deploy with its signed second step beside it, which the
 * service takes together; `creation-finish` carries the second step alone; the
 * two `pay-key-*` relays carry one call each of committing the account to its
 * pay-record key, an approval and the seal. Its raise is never a relay: it is
 * handed over beside its record (`FINISH_COMPANY_CALLS`).
 */
export const FINISH_COMPANY_RELAYS = Object.freeze([
  'creation', 'creation-again', 'creation-finish', 'pay-key-approve', 'pay-key-seal',
] as const);

/**
 * The one service call finishing a company makes through the page: the record of the pay-record key's proposal,
 * sealed and signed on the device, written down, and with `tx` its raise, which the service sends only once the record
 * is kept. A call with no `tx` sends nothing.
 */
const FINISH_COMPANY_CALLS: readonly CallRoute[] = Object.freeze([
  { method: 'POST', path: '/api/accounts/:record/creation/pay-key/proposal', sends: true, sendsWith: 'tx' },
].map((r) => Object.freeze(r)) as CallRoute[]);

/**
 * The service calls an action on a company's records makes through the page:
 * reading the company, its directory, its roster's offers, its proposals and
 * its manifest; filing this seat's directory entry, its vault keys, the
 * roster's fold and the manifest entries for each record it files.
 */
const COMPANY_RECORD_CALLS: readonly CallRoute[] = Object.freeze([
  { method: 'GET', path: '/api/accounts/:record' },
  { method: 'GET', path: '/api/accounts/:record/proposals' },
  { method: 'GET', path: '/api/accounts/:record/directory' },
  { method: 'PUT', path: '/api/accounts/:record/directory/:version' },
  { method: 'GET', path: '/api/accounts/:record/vault-keys/offers' },
  { method: 'PUT', path: '/api/accounts/:record/vault-keys' },
  { method: 'POST', path: '/api/accounts/:record/roster' },
  { method: 'POST', path: '/api/accounts/:record/manifest/entries' },
  { method: 'POST', path: '/api/accounts/:record/manifest/newest', reads: true },
  { method: 'POST', path: '/api/accounts/:record/manifest/tree/proofs', reads: true },
  { method: 'GET', path: '/api/accounts/:record/manifest/tree/pending', query: ['root'] },
  { method: 'GET', path: '/api/accounts/:record/manifest/tree/headers', query: ['after', 'limit'] },
  { method: 'GET', path: '/api/accounts/:record/records/:kind/:id' },
  { method: 'GET', path: '/api/accounts/:record/records/:kind/:id/versions' },
  { method: 'GET', path: '/api/accounts/:record/records/:kind/:id/:version' },
].map((r) => Object.freeze(r)) as CallRoute[]);

/**
 * What every seat action adds for the upkeep it does in the same window: the
 * company's people and the answers waiting in their handovers, read to carry
 * them across a change of the company's key; that change, a roster followed and
 * each vault's records filed again; a vault secret's change that stopped part way
 * finished (its secret set, its copies written, and the proposal written down as
 * carried out); the header of the records anchored, and the one call that sends
 * the anchor; and the fee sponsorship for a call the company's own service or the
 * person's wallet submits.
 */
const UPKEEP_CALLS: readonly CallRoute[] = Object.freeze([
  { method: 'POST', path: '/api/accounts/:record/fee' },
  { method: 'POST', path: '/api/accounts/:record/fee/done' },
  { method: 'GET', path: '/api/accounts/:record/proposals' },
  { method: 'GET', path: '/api/accounts/:record/people' },
  { method: 'GET', path: '/api/employees/:employee/handover' },
  { method: 'PUT', path: '/api/accounts/:record/directory/:version' },
  { method: 'POST', path: '/api/accounts/:record/roster' },
  { method: 'POST', path: '/api/accounts/:record/manifest/tree/headers' },
  { method: 'POST', path: '/api/accounts/:record/proven', sends: true },
  { method: 'GET', path: '/api/vaults/:vault/records/:kind' },
  { method: 'GET', path: '/api/vaults/:vault/records/:kind/versions' },
  { method: 'GET', path: '/api/vaults/:vault/records/:kind/:version' },
  { method: 'PUT', path: '/api/vaults/:vault/records/:kind/:version' },
  { method: 'POST', path: '/api/accounts/:record/vaults/:vault/start/secret', sends: true },
  { method: 'POST', path: '/api/accounts/:record/vaults/:vault/start/copy', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/carried' },
].map((r) => Object.freeze(r)) as CallRoute[]);

/** What a seat action's upkeep says it did: all done, or some left for the next action; and how many records it anchored. */
const UPKEEP_OUTCOME = Object.freeze({ upkeep: 'code' as const, anchored: 'count' as const });

/**
 * What creating a vault adds: the vault's deploy and the transactions of its
 * start, each carried in a call to the service that sends it; its name and its
 * proposals filed; and its pool and secret records read and filed.
 */
const CREATE_VAULT_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'PUT', path: '/api/accounts/:record/records/:kind/:id/:version' },
  { method: 'POST', path: '/api/accounts/:record/proposals', sends: true, sendsWith: 'tx' },
  { method: 'POST', path: '/api/proposals/:proposal/send', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/carried' },
  { method: 'POST', path: '/api/accounts/:record/vaults', sends: true },
  { method: 'POST', path: '/api/accounts/:record/vaults/:vault/start/account', sends: true },
  { method: 'POST', path: '/api/accounts/:record/vaults/:vault/start/secret', sends: true },
  { method: 'POST', path: '/api/accounts/:record/vaults/:vault/start/copy', sends: true },
  { method: 'GET', path: '/api/vaults/:vault/records/:kind' },
  { method: 'GET', path: '/api/vaults/:vault/records/:kind/versions' },
  { method: 'GET', path: '/api/vaults/:vault/records/:kind/:version' },
  { method: 'PUT', path: '/api/vaults/:vault/records/:kind/:version' },
  ...UPKEEP_CALLS,
].map((r) => Object.freeze(r)) as CallRoute[]);

/**
 * What a private deposit asks of the page: the company's records it reads to believe the vault's records (no filing of
 * the company's own but the manifest entries of what it files), the vault's records it reads and files (its deposit
 * journal, its pool, its nonce secret filed again), and the one call that sends the deposit.
 */
const PRIVATE_DEPOSIT_CALLS: readonly CallRoute[] = Object.freeze([
  { method: 'GET', path: '/api/accounts/:record' },
  { method: 'GET', path: '/api/accounts/:record/directory' },
  { method: 'POST', path: '/api/accounts/:record/manifest/entries' },
  { method: 'POST', path: '/api/accounts/:record/manifest/newest', reads: true },
  { method: 'POST', path: '/api/accounts/:record/manifest/tree/proofs', reads: true },
  { method: 'GET', path: '/api/accounts/:record/manifest/tree/pending', query: ['root'] },
  { method: 'GET', path: '/api/accounts/:record/manifest/tree/headers', query: ['after', 'limit'] },
  { method: 'GET', path: '/api/accounts/:record/records/:kind/:id' },
  { method: 'GET', path: '/api/accounts/:record/records/:kind/:id/versions' },
  { method: 'GET', path: '/api/accounts/:record/records/:kind/:id/:version' },
  { method: 'GET', path: '/api/vaults/:vault/records/:kind' },
  { method: 'GET', path: '/api/vaults/:vault/records/:kind/versions' },
  { method: 'GET', path: '/api/vaults/:vault/records/:kind/:version' },
  { method: 'PUT', path: '/api/vaults/:vault/records/:kind/:version' },
  { method: 'POST', path: '/api/accounts/:record/vaults/:vault/deposit', sends: true },
  ...UPKEEP_CALLS,
].map((r) => Object.freeze(r)) as CallRoute[]);

/**
 * What a one-off payment asks of the page: the company's records it reads to believe the vault, the policy, the
 * proposals, the runs and the one-off's own record; the one-off's record and the manifest entries it files; the vault's
 * records it reads and files for the payment; and the calls that send the raise, an approval, the charge to the
 * vault's period and the payment. None of them carries the amount, payee or name in the clear, except a public
 * payment's own transaction, which shows them as every public payment does.
 */
const ONE_OFF_PAYMENT_CALLS: readonly CallRoute[] = Object.freeze([
  { method: 'GET', path: '/api/accounts/:record' },
  { method: 'GET', path: '/api/accounts/:record/directory' },
  { method: 'GET', path: '/api/accounts/:record/proposals' },
  { method: 'GET', path: '/api/accounts/:record/runs' },
  { method: 'POST', path: '/api/accounts/:record/manifest/entries' },
  { method: 'POST', path: '/api/accounts/:record/manifest/newest', reads: true },
  { method: 'POST', path: '/api/accounts/:record/manifest/tree/proofs', reads: true },
  { method: 'GET', path: '/api/accounts/:record/manifest/tree/pending', query: ['root'] },
  { method: 'GET', path: '/api/accounts/:record/manifest/tree/headers', query: ['after', 'limit'] },
  { method: 'GET', path: '/api/accounts/:record/records/:kind/:id' },
  { method: 'GET', path: '/api/accounts/:record/records/:kind/:id/versions' },
  { method: 'GET', path: '/api/accounts/:record/records/:kind/:id/:version' },
  { method: 'PUT', path: '/api/accounts/:record/records/:kind/:id/:version' },
  { method: 'GET', path: '/api/vaults/:vault/records/:kind' },
  { method: 'GET', path: '/api/vaults/:vault/records/:kind/versions' },
  { method: 'GET', path: '/api/vaults/:vault/records/:kind/:version' },
  { method: 'PUT', path: '/api/vaults/:vault/records/:kind/:version' },
  { method: 'POST', path: '/api/accounts/:record/proposals', sends: true, sendsWith: 'tx' },
  { method: 'POST', path: '/api/proposals/:proposal/standing' },
  { method: 'POST', path: '/api/proposals/:proposal/approve', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/charge', sends: true },
  { method: 'POST', path: '/api/accounts/:record/vaults/:vault/payout', sends: true },
  { method: 'POST', path: '/api/accounts/:record/vaults/:vault/public-payout', sends: true },
  ...UPKEEP_CALLS,
].map((r) => Object.freeze(r)) as CallRoute[]);

/*
 * What inviting somebody reads and writes: the company's records the seat, the directory, the vendors and the roster
 * are read from, the invitation filed with its first record, the offer read to tell whether an invitation is already
 * filed, and for a seat offered by address the proposal raised with this seat's approval, plus the upkeep's routes.
 */
const INVITE_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'GET', path: '/api/accounts/:record/runs' },
  { method: 'POST', path: '/api/accounts/:record/invites' },
  { method: 'GET', path: '/api/invites/:invitation/offer' },
  { method: 'POST', path: '/api/accounts/:record/proposals', sends: true, sendsWith: 'tx' },
  { method: 'POST', path: '/api/proposals/:proposal/send', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/approve', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/standing' },
  ...UPKEEP_CALLS.filter((u) => !COMPANY_RECORD_CALLS.some((c) => c.method === u.method && c.path === u.path)),
].map((r) => Object.freeze(r)) as CallRoute[]);

/*
 * What approving a proposal reads and writes, for every kind: the company's records the seat, the directory, the
 * roster and the proposal are read from (a spending policy's versions among them), the proposal's standing, the one
 * approval sent, and the call that carries a change of the approvals needed, a spending policy, the approvals a policy
 * change needs or a removal out once the chain counts its bar; a removal's retirement signature,
 * handed on its own; for a one-off payment, its vault's records, the runs, its charge and its payment; for a payroll
 * run, the vendors' handovers its list is read with; for a new vault's adoption or first secret run, the call each
 * step of the vault's start is sent by and the one that writes the proposal down as carried out once the chain shows it;
 * for the pay-record key, the creation's own route its approval and its carrying out are sent by;
 * plus the upkeep's routes. The routes that file, raise and send a raise are listed for one use only: once this press
 * has carried a removal out (`done` on the chain), the removal's hook raises each vault's secret run through them, so
 * the signer who left cannot open what comes next. No approval of any other kind raises anything, and neither does an
 * approval of a removal that does not carry it out.
 */
const APPROVE_PROPOSAL_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  ...ONE_OFF_PAYMENT_CALLS.filter((o) => !(o.method === 'POST' && o.path === '/api/accounts/:record/proposals')),
  { method: 'POST', path: '/api/accounts/:record/proposals', sends: true, sendsWith: 'tx' },
  { method: 'POST', path: '/api/proposals/:proposal/send', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/carry', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/retirement' },
  { method: 'GET', path: '/api/accounts/:record/vendors/:vendor/handover' },
  { method: 'POST', path: '/api/accounts/:record/vaults/:vault/start/account', sends: true },
  { method: 'POST', path: '/api/accounts/:record/vaults/:vault/start/secret', sends: true },
  { method: 'POST', path: '/api/accounts/:record/vaults/:vault/start/copy', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/carried' },
  { method: 'POST', path: '/api/accounts/:record/creation/pay-key', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/closed' },
  ...UPKEEP_CALLS,
].filter((r, i, all) => all.findIndex((x) => x.method === r.method && x.path === r.path) === i)
  .map((r) => Object.freeze({ ...r })) as CallRoute[]);

/*
 * What changing the approvals needed reads and writes: the company's records the seat, the directory, the roster and
 * the proposals are read from, the proposal filed with its raise or a raise written down sent again, an approval of the
 * same change already raised, its standing, and the call that carries it out at its bar; plus the upkeep's routes.
 */
const CHANGE_THRESHOLD_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'POST', path: '/api/accounts/:record/proposals', sends: true, sendsWith: 'tx' },
  { method: 'POST', path: '/api/proposals/:proposal/send', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/approve', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/standing' },
  { method: 'POST', path: '/api/proposals/:proposal/carry', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/closed' },
  ...UPKEEP_CALLS.filter((u) => !COMPANY_RECORD_CALLS.some((c) => c.method === u.method && c.path === u.path)),
].map((r) => Object.freeze(r)) as CallRoute[]);

/**
 * What raising a payroll run asks of the page: the company's records, its runs (read, and filed when the run is
 * drawn here), its people and vendors, the vaults' records the vault's money is read from, the proposal filed with
 * its transaction or a filed one sent again, where it stands, and the upkeep every seat action does.
 */
const RAISE_RUN_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'GET', path: '/api/accounts/:record/runs' },
  { method: 'POST', path: '/api/accounts/:record/runs' },
  { method: 'GET', path: '/api/accounts/:record/vendors/:vendor/handover' },
  { method: 'GET', path: '/api/vaults/:vault/records/:kind' },
  { method: 'GET', path: '/api/vaults/:vault/records/:kind/versions' },
  { method: 'GET', path: '/api/vaults/:vault/records/:kind/:version' },
  { method: 'PUT', path: '/api/vaults/:vault/records/:kind/:version' },
  { method: 'POST', path: '/api/accounts/:record/proposals', sends: true, sendsWith: 'tx' },
  { method: 'POST', path: '/api/proposals/:proposal/send', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/standing' },
  ...UPKEEP_CALLS,
].filter((r, i, all) => all.findIndex((x) => x.method === r.method && x.path === r.path) === i)
  .map((r) => Object.freeze({ ...r })) as CallRoute[]);

/**
 * What paying an approved payroll run asks of the page: the company's records and its runs, read; the vaults' records
 * the vault's money is read from and filed to; where the proposal stands; and the charge, the payments and the merges
 * the run's plan sends, each a send, then the upkeep every seat action does.
 */
const PAY_RUN_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'GET', path: '/api/accounts/:record/runs' },
  { method: 'GET', path: '/api/vaults/:vault/records/:kind' },
  { method: 'GET', path: '/api/vaults/:vault/records/:kind/versions' },
  { method: 'GET', path: '/api/vaults/:vault/records/:kind/:version' },
  { method: 'PUT', path: '/api/vaults/:vault/records/:kind/:version' },
  { method: 'POST', path: '/api/proposals/:proposal/standing' },
  { method: 'POST', path: '/api/proposals/:proposal/charge', sends: true },
  { method: 'POST', path: '/api/accounts/:record/vaults/:vault/payout', sends: true },
  { method: 'POST', path: '/api/accounts/:record/vaults/:vault/merge', sends: true },
  { method: 'POST', path: '/api/accounts/:record/vaults/:vault/public-payout', sends: true },
  ...UPKEEP_CALLS,
].filter((r, i, all) => all.findIndex((x) => x.method === r.method && x.path === r.path) === i)
  .map((r) => Object.freeze({ ...r })) as CallRoute[]);

/**
 * What withdrawing a proposal reads and sends: the company's records, where the proposal stands as the service keeps it,
 * and the withdrawal, which reaches the chain only when it carries a proven call; one without a call marks a proposal
 * the chain does not hold withdrawn in the company's records, and nothing more. A withdrawal the person's wallet sent
 * straight to the chain closes the service's record afterwards, which sends nothing; the fee sponsorship for a
 * withdrawal the company's own service or the person's wallet submits.
 */
const WITHDRAW_PROPOSAL_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'POST', path: '/api/accounts/:record/fee' },
  { method: 'POST', path: '/api/accounts/:record/fee/done' },
  { method: 'POST', path: '/api/proposals/:proposal/standing' },
  { method: 'POST', path: '/api/proposals/:proposal/cancel', sends: true, sendsWith: 'tx' },
  { method: 'POST', path: '/api/proposals/:proposal/closed' },
].map((r) => Object.freeze(r)) as CallRoute[]);

/**
 * Removing a signer (the wallet's `remove-signer` action): what changing the approvals needed calls, the route that
 * takes this seat's signature over the leaving seat's retirement on its own (kept beside the proposal; it relays
 * nothing, so it does not send), and, once it is carried out, what changing each vault's secret calls.
 */
const REMOVE_SIGNER_CALLS: readonly CallRoute[] = Object.freeze([
  ...CHANGE_THRESHOLD_CALLS,
  { method: 'POST', path: '/api/proposals/:proposal/retirement' },
  { method: 'POST', path: '/api/accounts/:record/vaults/:vault/start/secret', sends: true },
  { method: 'POST', path: '/api/accounts/:record/vaults/:vault/start/copy', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/carried' },
].filter((r, i, all) => all.findIndex((x) => x.method === r.method && x.path === r.path) === i)
  .map((r) => Object.freeze({ ...r })) as CallRoute[]);

/**
 * Changing the company's vault secrets after a removal (the wallet's `rotate-vault-secrets` action): the company's
 * records, a vault secret's run raised, sent, approved and its standing read, its secret set and its copies written,
 * the proposal written down as carried out, the vault's records read and filed, and the upkeep's routes.
 */
const ROTATE_VAULT_SECRETS_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'POST', path: '/api/accounts/:record/proposals', sends: true, sendsWith: 'tx' },
  { method: 'POST', path: '/api/proposals/:proposal/send', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/approve', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/standing' },
  ...UPKEEP_CALLS,
].filter((r, i, all) => all.findIndex((x) => x.method === r.method && x.path === r.path) === i)
  .map((r) => Object.freeze({ ...r })) as CallRoute[]);

/** What changing the vault secrets tells the page: how many vaults ended in each state, never which. */
const VAULTS_CHANGED_OUTCOME = Object.freeze({
  vaultsRotated: 'count' as const, vaultsAwaiting: 'count' as const, vaultsOwed: 'count' as const, vaultsWaiting: 'count' as const,
  vaultsNotChanged: 'count' as const,
});

/*
 * What admitting a signer seated by address reads and writes: the company, its roster and its proposals read, the
 * roster filed with the person in it and the company's key wrapped to them, in one call, plus the upkeep's routes.
 */
const ADMIT_SIGNER_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'POST', path: '/api/accounts/:record/signers/:signer/admit' },
  ...UPKEEP_CALLS.filter((u) => !COMPANY_RECORD_CALLS.some((c) => c.method === u.method && c.path === u.path)),
].map((r) => Object.freeze(r)) as CallRoute[]);

/*
 * What admitting a person or a vendor reads and writes: the company's records, its people and its invitations read,
 * what the person handed over read, and their record filed active in one call, plus the upkeep's routes.
 */
const ADMIT_PERSON_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'GET', path: '/api/accounts/:record/invites' },
  { method: 'GET', path: '/api/employees/:employee/handover' },
  { method: 'POST', path: '/api/employees/:employee/admit' },
  { method: 'GET', path: '/api/accounts/:record/vendors/:vendor/handover' },
  { method: 'POST', path: '/api/accounts/:record/vendors/:vendor/admit' },
  ...UPKEEP_CALLS.filter((u) => !COMPANY_RECORD_CALLS.some((c) => c.method === u.method && c.path === u.path)
    && !(u.method === 'GET' && u.path === '/api/employees/:employee/handover')),
].map((r) => Object.freeze(r)) as CallRoute[]);

/*
 * What changing a person or a vendor reads and writes: the company's records, its people, its runs and proposals (for
 * the months already raised) read, and the next version of the record filed in one call, plus the upkeep's routes.
 */
const CHANGE_PERSON_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'GET', path: '/api/accounts/:record/runs' },
  { method: 'POST', path: '/api/people/:person/status' },
  { method: 'POST', path: '/api/people/:person/details' },
  { method: 'PUT', path: '/api/accounts/:record/records/:kind/:id/:version' },
  ...UPKEEP_CALLS.filter((u) => !COMPANY_RECORD_CALLS.some((c) => c.method === u.method && c.path === u.path)),
].map((r) => Object.freeze(r)) as CallRoute[]);

/*
 * What filing the company's choice of service reads and writes: the company's records (the versions of the choice
 * already filed, read as every act reads them), the next version filed in one call and entered, plus the upkeep's routes.
 */
const CHOOSE_COMPANY_SERVICE_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'PUT', path: '/api/accounts/:record/records/:kind/:id/:version' },
  ...UPKEEP_CALLS.filter((u) => !COMPANY_RECORD_CALLS.some((c) => c.method === u.method && c.path === u.path)),
].map((r) => Object.freeze(r)) as CallRoute[]);

/** Every action a wallet runs, by name. */
export const ACT_INTENTS = Object.freeze({
  /**
   * Finish creating the company this wallet drew the label for: its account sent and finished, its pay-record key's
   * proposal written down in the company's records, raised, and the key committed and sealed.
   */
  'finish-company': Object.freeze({
    fields: Object.freeze({ company: 'company' as const }), relays: FINISH_COMPANY_RELAYS, calls: FINISH_COMPANY_CALLS,
  }),
  /**
   * Give this seat's vault keys to the company it holds a seat on: its directory entry, its vault keys offered and
   * folded, with the upkeep every seat action does. It tells the page whether the upkeep was all done and how many
   * records it anchored.
   */
  'give-vault-keys': Object.freeze({
    fields: Object.freeze({ record: 'record' as const, company: 'company' as const, account: 'account' as const }),
    calls: Object.freeze([...COMPANY_RECORD_CALLS, ...UPKEEP_CALLS]),
    outcome: UPKEEP_OUTCOME,
  }),
  /**
   * Create a vault, or carry on setting one up (`vault`): the vault keys given
   * first, then the vault built, started and its secret set, with the upkeep every seat action does. `title` and
   * `about` are the vault's name and description, and `readers` the names of
   * the signers as the page lists them: all three the page's words.
   */
  'create-vault': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, vault: 'vault' as const,
      title: 'words' as const, about: 'words' as const, readers: 'words' as const,
    }),
    optional: Object.freeze(['vault', 'title', 'about', 'readers']),
    calls: CREATE_VAULT_CALLS,
    outcome: Object.freeze({
      vault: 'vault' as const, round: 'code' as const, approvals: 'count' as const, needed: 'count' as const,
      said: 'code' as const, stopped: 'code' as const, ...UPKEEP_OUTCOME,
    }),
  }),
  /**
   * Put `amount` of the private token `token` into `vault` of the company: the deposit built, proved and paid in the
   * wallet, the records it makes signed there, the deposit's one transaction sent through the page, with the upkeep
   * every seat action does. It tells the page the vault, where the deposit got to, the transaction the chain made it
   * in, whether the upkeep was all done and how many records it anchored.
   */
  'private-deposit': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, vault: 'vault' as const,
      token: 'token' as const, amount: 'amount' as const,
    }),
    calls: PRIVATE_DEPOSIT_CALLS,
    outcome: Object.freeze({ vault: 'vault' as const, state: 'code' as const, created: 'vault' as const, ...UPKEEP_OUTCOME }),
  }),
  /**
   * Pay `amount` of the currency `token` out of `vault` to the address `payee`, once: the proposal raised, the
   * one-off's record sealed to the signers and filed, and, when the chain shows the approvals it needs, the payment
   * charged to the vault's period (if the vault has a spending policy) and paid, with the upkeep every seat action does.
   * `payee`, `payeeName` and `reason` are the page's words, checked by the wallet. Or carry on a one-off already raised
   * (`proposal`), named beside the same payment fields: the wallet opens its sealed record, refuses it unless it is that
   * payment, offers this seat's approval, and charges and pays it as far as the company's account accepts.
   * `vendor` names the vendor entry the payment is for, when it is for one: the wallet reads that entry itself and
   * raises, approves and pays nothing unless `payee` is the address it pays.
   * It tells the page where the payment got to, the approvals the chain shows and how many it needs, whether the upkeep
   * was all done and how many records it anchored.
   */
  'one-off-payment': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, vault: 'vault' as const,
      token: 'token' as const, amount: 'amount' as const, payee: 'words' as const, payeeName: 'words' as const, reason: 'words' as const,
      proposal: 'record' as const, vendor: 'record' as const,
    }),
    optional: Object.freeze(['vault', 'token', 'amount', 'payee', 'payeeName', 'reason', 'proposal', 'vendor']),
    calls: ONE_OFF_PAYMENT_CALLS,
    outcome: Object.freeze({ state: 'code' as const, charge: 'code' as const, approvals: 'count' as const, needed: 'count' as const, ...UPKEEP_OUTCOME }),
  }),
  /*
   * A person or vendor added by the unshielded address the inviter typed claims their record: the wallet opens the
   * inviter-signed offer itself with the link's `token`, takes the company's inbox key, the record and the address
   * from it (the page's `address` only names it, and must be the offer's), checks the address is its own, signs a
   * claim of it with that address's key and its payee's code, seals both to the company's inbox key and hands them to
   * the invitation. It lists the company among those that pay this person in the saved keys before it hands anything
   * over. One added by a shielded address joins with `join-by-code` instead.
   */
  'claim-by-address': Object.freeze({
    fields: Object.freeze({
      company: 'company' as const, account: 'account' as const, record: 'record' as const, token: 'token' as const, address: 'words' as const,
    }),
    calls: Object.freeze([
      Object.freeze({ method: 'GET' as const, path: '/api/invites/:invitation/offer' }),
      Object.freeze({ method: 'POST' as const, path: '/api/invites/:invitation/accept-payee' }),
    ]),
  }),
  /*
   * A person or vendor invited by link, or by a private address, joins from their own wallet: the wallet opens the
   * inviter-signed offer itself with the link's `token`, takes the record, the company's inbox key and any address the
   * inviter typed from it, and is paid at that address only if it holds it, or else at a private address of its own.
   * It signs its payee's code with its payslip key for the company, lists the company among those that pay this
   * person in the saved keys, seals the code to the company's inbox key and hands it to the invitation. The
   * fingerprint the inviter checks is shown in the wallet's own window and never sent to the page.
   */
  'join-by-code': Object.freeze({
    fields: Object.freeze({ company: 'company' as const, account: 'account' as const, record: 'record' as const, token: 'token' as const }),
    calls: Object.freeze([
      Object.freeze({ method: 'GET' as const, path: '/api/invites/:invitation/offer' }),
      Object.freeze({ method: 'POST' as const, path: '/api/invites/:invitation/accept-payee' }),
    ]),
  }),
  /*
   * Invite an employee, a vendor or a signer (`kind`) to the company, with the seat this wallet holds there: the
   * invitation, the offer and the first record are sealed and signed in the wallet and filed, and a signer, invited
   * only by a private address, gets the proposal to seat that address raised with this seat's approval, the
   * invitation kept in the saved keys before the raise; `threshold`, where given, is the approvals the account needs
   * once the seat is taken, bound in the proposal. `token` is the page's own token for the link, so the page
   * makes the link itself and nothing secret comes back. The person's details are the page's words, and never reach
   * the service but sealed. It tells the page where the invitation got to, for a signer the approvals the proposal
   * holds and needs as the chain shows them, whether the upkeep was all done and how many records it anchored. When a press goes
   * on under the invitation kept for the same address, not under the token the page sent, it names that invitation's own token
   * (sixty-four hex characters, the token the page made the link from before it lost it), so the page gives the link filed.
   */
  invite: Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, token: 'token' as const, kind: 'words' as const,
      personName: 'words' as const, email: 'words' as const, title: 'words' as const, startDate: 'words' as const, endDate: 'words' as const,
      classification: 'words' as const, address: 'words' as const, asset: 'token' as const, amount: 'amount' as const,
      terms: 'words' as const, termsAsset: 'token' as const, termsAmount: 'amount' as const, role: 'words' as const, scope: 'seat' as const,
      threshold: 'amount' as const,
    }),
    optional: Object.freeze([
      'email', 'title', 'startDate', 'endDate', 'classification', 'address', 'asset', 'amount', 'terms', 'termsAsset', 'termsAmount', 'role', 'scope',
      'threshold',
    ]),
    calls: INVITE_CALLS,
    outcome: Object.freeze({ state: 'code' as const, approvals: 'count' as const, needed: 'count' as const, token: 'vault' as const, ...UPKEEP_OUTCOME }),
  }),
  /*
   * A signer invited by address takes the seat from their own wallet: the wallet opens the offer with the link's
   * `token`, checks the address is its own, derives its seat for the company, proves `seatInvited` with the address's
   * coin key, hands the transaction to the invitation's relay and asks to be admitted with its seat's public halves. Before
   * it picks a seat number it asks the invitation's route which of its seats and keys the company's directory already names.
   */
  'seat-invited': Object.freeze({
    fields: Object.freeze({ company: 'company' as const, account: 'account' as const, record: 'record' as const, token: 'token' as const }),
    calls: Object.freeze([
      Object.freeze({ method: 'GET' as const, path: '/api/invites/:invitation/offer' }),
      Object.freeze({ method: 'POST' as const, path: '/api/invites/:invitation/seat', sends: true }),
      Object.freeze({ method: 'POST' as const, path: '/api/invites/:invitation/seats-named' }),
      Object.freeze({ method: 'POST' as const, path: '/api/invites/:invitation/accept-signer' }),
    ]),
  }),
  /*
   * Approve, with the seat this wallet holds, the proposal (`proposal`, its name in the company's records) another seat
   * raised, of the kind `kind` names. For `add-signer`: `personName`, `role` (one of the four a signer may hold),
   * `address` (the commitment to the address), `scope` and `coinKey`, and the wallet approves only when the proposal
   * invites exactly those, the coin key makes the commitment, and that wallet holds no seat here and no other open
   * invitation. For `one-off`: `vault`, `token`, `amount`, `payee`, `payeeName`, `reason` and `vendor`, and the wallet
   * approves only when the one-off's record pays exactly those, then charges and pays it once the chain shows the
   * approvals it needs. For `threshold`: `threshold`, the account's new threshold; for `vault-threshold`: `vault` and
   * `threshold`; the wallet approves only when the proposal changes exactly that, checks every vault first, and carries it
   * out once the chain shows the approvals it needs. For `removal`: `leaf`, the seat removed, and `threshold` where the
   * removal changes it; the wallet approves only when the proposal removes exactly that seat at exactly that threshold,
   * checks every vault first, signs the leaving seat's retirement, and carries it out once the chain shows the approvals
   * it needs. For `payroll`: `period`, `vault`, `token`, `form`, `payees`, `total` and `run`, and the wallet approves
   * only when the run the proposal raises, or the retry of some of its people, pays exactly those; it pays nothing.
   * For `recovery`: the parts of the recovery's file (`proposal` its identity on the chain, `salt`, `latest`,
   * `lastRecovery`, `resumesFrom`, `root`, `seq`), and the wallet makes the file again, checks it against the chain,
   * approves and carries it out on the chain and the person's own wallet alone, asking the service nothing.
   * For `spending-policy`: `vault`, `token`, `periodLimit`, `periodStart`, `periodLength` and `bands` (four bands, each
   * `ceiling:approvals`, comma-separated); the wallet approves only when the policy the proposal commits to opens, from
   * the company's records, to exactly those terms, checks every vault's approvers at its bands first, files nothing, and
   * carries it out once the chain shows the approvals it needs. For `policy-bar`: `bar`, the approvals any policy change
   * needs; the wallet approves only when the proposal sets exactly that and the chain seats at least that many signers,
   * and carries it out once the chain shows the approvals it needs.
   * For `adopt-vault`: `vault`; the wallet approves only the adoption of exactly that vault, as it makes it from the
   * vault, checks every vault first, and adopts it once the chain shows the approvals it needs. For `vault-secret`:
   * `vault`, and `readers`, the signers as the page names them; the wallet approves only the first secret run it makes
   * from the secret the company's records hold for that vault, sealed to exactly the seats the account holds, and once
   * the chain shows the approvals it needs sets the secret and writes each signer's sealed copy. Either is written down
   * as carried out once the chain shows it done, and `said` says when it could not be. For `pay-key`: nothing more; the
   * wallet approves only the proposal whose record commits the account to the pay-record key the company's signed first
   * state holds, and once the chain shows the approvals it needs commits it by sealing this seat's own copy.
   * Every field is what the page showed; the wallet opens the proposal itself. It raises nothing. It
   * tells the page where the proposal got to, the approvals the chain shows and the approvals it needs, the charge of a
   * one-off, whether the upkeep was all done and how many records it anchored.
   */
  'approve-proposal': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, proposal: 'record' as const, kind: 'words' as const,
      personName: 'words' as const, role: 'words' as const, address: 'seat' as const, scope: 'seat' as const, coinKey: 'seat' as const,
      vault: 'vault' as const, token: 'token' as const, amount: 'amount' as const, payee: 'words' as const, payeeName: 'words' as const,
      reason: 'words' as const, vendor: 'record' as const, threshold: 'amount' as const, leaf: 'seat' as const,
      run: 'record' as const, period: 'words' as const, form: 'words' as const, payees: 'amount' as const, total: 'amount' as const,
      salt: 'seat' as const, latest: 'amount' as const, lastRecovery: 'seat' as const, resumesFrom: 'seat' as const, root: 'seat' as const,
      seq: 'amount' as const, periodLimit: 'amount' as const, periodStart: 'amount' as const, periodLength: 'amount' as const,
      bands: 'words' as const, bar: 'amount' as const, readers: 'words' as const,
    }),
    optional: Object.freeze([
      'personName', 'role', 'address', 'scope', 'coinKey', 'vault', 'token', 'amount', 'payee', 'payeeName', 'reason', 'vendor', 'threshold', 'leaf',
      'run', 'period', 'form', 'payees', 'total', 'salt', 'latest', 'lastRecovery', 'resumesFrom', 'root', 'seq',
      'periodLimit', 'periodStart', 'periodLength', 'bands', 'bar', 'readers',
    ]),
    calls: APPROVE_PROPOSAL_CALLS,
    outcome: Object.freeze({
      state: 'code' as const, approvals: 'count' as const, needed: 'count' as const, charge: 'code' as const, said: 'code' as const,
      rotation: 'code' as const, vaultSecrets: 'code' as const, vaultSecretsWhy: 'code' as const, ...VAULTS_CHANGED_OUTCOME,
      ...UPKEEP_OUTCOME,
    }),
  }),
  /*
   * Change, with the seat this wallet holds, the approvals the company's account needs to `threshold`, or with `vault`
   * the approvals that vault's runs need. The wallet checks first, from the chain and the company's records, that the
   * chain would carry it out and that every vault keeps enough signers who may approve its runs, and again before every
   * send; then raises the proposal, or approves the same change already raised, and carries it out when the chain
   * counts its bar. It tells the page where the proposal got to, the approvals the chain shows and the approvals it
   * needs, whether the upkeep was all done and how many records it anchored.
   */
  'change-threshold': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, threshold: 'amount' as const, vault: 'vault' as const,
    }),
    optional: Object.freeze(['vault']),
    calls: CHANGE_THRESHOLD_CALLS,
    outcome: Object.freeze({ state: 'code' as const, approvals: 'count' as const, needed: 'count' as const, ...UPKEEP_OUTCOME }),
  }),
  /**
   * Raises a payroll run's leg, or a retry of some of its people, from a vault, in the wallet: opens the run and refuses
   * it unless it pays what the page shows, and refuses a window that is missing or already open. With no run named the
   * page names no people or total: the wallet draws the run, shows the leg's people and total with its month, list,
   * vault, currency and form, and files and raises it only on the person's Confirm. With `proposal` it sends again a raise or a retry the company wrote down and the chain never held,
   * over the window it was written down with. It tells the page the run's name and the proposal's, as soon as each is known.
   */
  'raise-run': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, run: 'record' as const, period: 'words' as const,
      list: 'words' as const, vault: 'vault' as const, token: 'token' as const, form: 'words' as const, payees: 'amount' as const,
      total: 'amount' as const, opensAt: 'amount' as const, closesAt: 'amount' as const, indices: 'words' as const, proposal: 'record' as const,
    }),
    optional: Object.freeze(['run', 'list', 'payees', 'total', 'opensAt', 'closesAt', 'indices', 'proposal']),
    calls: RAISE_RUN_CALLS,
    outcome: Object.freeze({
      state: 'code' as const, run: 'record' as const, proposal: 'record' as const, approvals: 'count' as const, needed: 'count' as const,
      ...UPKEEP_OUTCOME,
    }),
  }),
  /**
   * Pays an approved payroll run's leg, or a retry raised on it, from its vault, in the wallet: opens the proposal and
   * its run and refuses them unless they pay what the page shows, from the vault the proposal names; pays nothing
   * unless the chain holds the proposal open at its approvals and its window is open now; then charges the run to the
   * vault's period when the vault has a spending policy and pays each person still owed, privately or publicly as the
   * leg is. It tells the page where it got to, how many it paid, how many may still be landing and how many are still
   * owed, whether it charged the
   * run, the approvals the chain shows and the approvals it needs, whether the upkeep was all done and how many records
   * it anchored.
   */
  'pay-run': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, proposal: 'record' as const, run: 'record' as const,
      period: 'words' as const, list: 'words' as const, vault: 'vault' as const, token: 'token' as const, form: 'words' as const,
      payees: 'amount' as const, total: 'amount' as const,
    }),
    optional: Object.freeze(['run', 'list']),
    calls: PAY_RUN_CALLS,
    outcome: Object.freeze({
      state: 'code' as const, paid: 'count' as const, owed: 'count' as const, unseen: 'count' as const, charge: 'code' as const,
      approvals: 'count' as const,
      needed: 'count' as const, ...UPKEEP_OUTCOME,
    }),
  }),
  /**
   * A recovery of the company's records, run on the chain and the person's own wallet alone: `step` `raise` raises one
   * to be carried out before `latest` (seconds), resuming from the last head this device checked; `carry` carries one
   * out from the parts of its file (as `approve-proposal` takes them). Each call goes from the person's own wallet,
   * which pays its fee and nothing else, so the page is asked for no call and no relay. It tells the page where the
   * chain says the recovery stands, its approvals and the approvals it needs, and the parts of its file.
   */
  recovery: Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, step: 'words' as const, latest: 'amount' as const,
      proposal: 'record' as const, salt: 'seat' as const, lastRecovery: 'seat' as const, resumesFrom: 'seat' as const, root: 'seat' as const,
      seq: 'amount' as const,
    }),
    optional: Object.freeze(['proposal', 'salt', 'lastRecovery', 'resumesFrom', 'root', 'seq']),
    calls: Object.freeze([]) as readonly CallRoute[],
    outcome: Object.freeze({
      state: 'code' as const, approvals: 'count' as const, needed: 'count' as const, proposal: 'record' as const, salt: 'record' as const,
      latest: 'record' as const, lastRecovery: 'record' as const, resumesFrom: 'record' as const, root: 'record' as const, seq: 'count' as const,
    }),
  }),
  /**
   * Withdraw a proposal of any kind the wallet withdraws, named by its record and the kind the page shows: a run before
   * its time to be paid begins, any other proposal by the signer who raised it. `state` is where the chain shows it
   * after; `proposal` is the one withdrawn.
   */
  'withdraw-proposal': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, proposal: 'record' as const, kind: 'words' as const,
    }),
    calls: WITHDRAW_PROPOSAL_CALLS,
    outcome: Object.freeze({ state: 'code' as const, proposal: 'record' as const }),
  }),
  /**
   * Removing a signer, from the wallet: the leaf the chain takes off and, where it changes, the approvals the account
   * needs once they are gone (none or 0 keeps the number in force). Raised, and carried out at a bar of one; the others
   * approve it through `approve-proposal` (kind `removal`). The Signers screen asks for it.
   */
  'remove-signer': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, leaf: 'seat' as const, threshold: 'amount' as const,
    }),
    optional: Object.freeze(['threshold']),
    calls: REMOVE_SIGNER_CALLS,
    outcome: Object.freeze({
      state: 'code' as const, approvals: 'count' as const, needed: 'count' as const,
      rotation: 'code' as const, vaultSecrets: 'code' as const, vaultSecretsWhy: 'code' as const, ...VAULTS_CHANGED_OUTCOME, ...UPKEEP_OUTCOME,
    }),
  }),
  /*
   * Changing the company's vault secrets after a signer is removed, from a signer who stays: for `vault`, or for every
   * vault the company's account has adopted, a new secret is made and kept in this wallet, its run raised, and, when the
   * approvals it needs are met on this press, set and its copies written. A run already open on the chain is never
   * raised again. It tells the page how many vaults ended in each state. The Signers screen asks for it.
   */
  'rotate-vault-secrets': Object.freeze({
    fields: Object.freeze({ record: 'record' as const, company: 'company' as const, account: 'account' as const, vault: 'vault' as const }),
    optional: Object.freeze(['vault']),
    calls: ROTATE_VAULT_SECRETS_CALLS,
    outcome: Object.freeze({ state: 'code' as const, ...VAULTS_CHANGED_OUTCOME, ...UPKEEP_OUTCOME }),
  }),
  /*
   * Admit, with the seat this wallet holds, the signer waiting under `signer` whose own wallet took their seat by
   * address: the wallet holds their request to the seat the chain shows their invitation's proposal took, records the
   * coin key of the address they were invited at, files the roster with them in it and wraps the company's key to
   * them. Nothing is read out. `personName` is the name the page showed. It tells the page whether they were admitted
   * now or already, whether the upkeep was all done and how many records it anchored.
   */
  'admit-signer': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, signer: 'record' as const,
      personName: 'words' as const,
    }),
    calls: ADMIT_SIGNER_CALLS,
    outcome: Object.freeze({ state: 'code' as const, ...UPKEEP_OUTCOME }),
  }),
  /*
   * Admit, with the seat this wallet holds, the employee or vendor (`kind`) waiting under `person`: their wallet's
   * code is opened with the company's keys and held to the fingerprint they read out (`fingerprint`), or, for someone
   * added at a public address, to their wallet's signed claim of it, with nothing read out. Their record is filed
   * active at the address and payslip key their wallet handed over. `personName` is the name the page showed, held to
   * their record. It tells the page whether they were admitted now or already, and how the upkeep went.
   */
  'admit-person': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, kind: 'words' as const,
      person: 'record' as const, personName: 'words' as const, fingerprint: 'words' as const,
    }),
    optional: Object.freeze(['fingerprint']),
    calls: ADMIT_PERSON_CALLS,
    outcome: Object.freeze({ state: 'code' as const, ...UPKEEP_OUTCOME }),
  }),

  /*
   * Change, with the seat this wallet holds, the record of the employee or vendor (`kind`) under `person`, as the next
   * version signed by this seat. An employee's pay (`payAmount` in `asset` from `payFrom`), classification (from
   * `classificationFrom`), end and leaving dates, or else their status (`status`, a leaver with their `leavingDate`); a
   * vendor's terms (`terms`, `termsAsset`, `termsAmount`), end date and status. `clear` names the dates taken off, by
   * field name, separated by commas. Nothing changes a month a run has already been raised for. It tells the page
   * whether the record was changed, and how the upkeep went.
   */
  'change-person': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, kind: 'words' as const,
      person: 'record' as const, personName: 'words' as const, payAmount: 'amount' as const, asset: 'token' as const,
      payFrom: 'words' as const, classification: 'words' as const, classificationFrom: 'words' as const, endDate: 'words' as const,
      leavingDate: 'words' as const, status: 'words' as const, terms: 'words' as const, termsAsset: 'token' as const,
      termsAmount: 'amount' as const, clear: 'words' as const,
    }),
    optional: Object.freeze([
      'payAmount', 'asset', 'payFrom', 'classification', 'classificationFrom', 'endDate', 'leavingDate', 'status', 'terms',
      'termsAsset', 'termsAmount', 'clear',
    ]),
    calls: CHANGE_PERSON_CALLS,
    outcome: Object.freeze({ state: 'code' as const, ...UPKEEP_OUTCOME }),
  }),
  /*
   * File, with the seat this wallet holds, the company's choice of the service its calls go through (`service`: ours,
   * own or none; `at`, the secure site address of its own service, only with own), sealed to every signer seated now.
   * It tells the page whether the choice is in force, how many seats have filed it in a row (`filed`) and how many it
   * needs, and how the upkeep went.
   */
  'choose-company-service': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, service: 'words' as const, at: 'words' as const,
    }),
    optional: Object.freeze(['at']),
    calls: CHOOSE_COMPANY_SERVICE_CALLS,
    outcome: Object.freeze({ state: 'code' as const, filed: 'count' as const, needed: 'count' as const, ...UPKEEP_OUTCOME }),
  }),
}) satisfies Readonly<Record<string, IntentShape>>;

export type ActIntentName = keyof typeof ACT_INTENTS & string;
