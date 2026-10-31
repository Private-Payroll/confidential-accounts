/**
 * THE ACTIONS A PAGE MAY ASK A WALLET TO RUN WHOLE, BY NAME.
 *
 * An `act` ask names one of these and the ids and amounts it acts on, and
 * nothing else: the wallet reads the chain itself, builds every transaction
 * itself and hands each back for the page to send. So every field an action
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
  /** The only query parameters a call to it may carry, each once with a plain value; none unless named. */
  readonly query?: readonly string[];
}

/** What one part of an action's outcome may be: sixty-four hex characters (a vault's address, or a transaction the chain names), a whole number, or a short code. */
export type OutcomeKind = 'vault' | 'count' | 'code';

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
 * three `pay-key-*` relays carry one call each of committing the account to its
 * pay-record key.
 */
export const FINISH_COMPANY_RELAYS = Object.freeze([
  'creation', 'creation-again', 'creation-finish', 'pay-key-propose', 'pay-key-approve', 'pay-key-seal',
] as const);

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
  { method: 'POST', path: '/api/accounts/:record/manifest/newest' },
  { method: 'POST', path: '/api/accounts/:record/manifest/tree/proofs' },
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
 * each vault's records filed again; the header of the records anchored, and the
 * one call that sends the anchor.
 */
const UPKEEP_CALLS: readonly CallRoute[] = Object.freeze([
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
  { method: 'POST', path: '/api/accounts/:record/manifest/newest' },
  { method: 'POST', path: '/api/accounts/:record/manifest/tree/proofs' },
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
  { method: 'POST', path: '/api/accounts/:record/manifest/newest' },
  { method: 'POST', path: '/api/accounts/:record/manifest/tree/proofs' },
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
 * What approving a signer invited by address reads and writes: the company's records the seat, the directory, the
 * roster and the proposal are read from, the proposal's standing, and the one approval sent, plus the upkeep's
 * routes. No route that files or raises a proposal is listed: the wallet approves only one the chain has raised.
 */
const APPROVE_SIGNER_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'POST', path: '/api/proposals/:proposal/standing' },
  { method: 'POST', path: '/api/proposals/:proposal/approve', sends: true },
  ...UPKEEP_CALLS.filter((u) => !COMPANY_RECORD_CALLS.some((c) => c.method === u.method && c.path === u.path)),
].map((r) => Object.freeze(r)) as CallRoute[]);

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

/** Every action a wallet runs, by name. */
export const ACT_INTENTS = Object.freeze({
  /** Finish creating the company this wallet drew the label for: its account sent and finished, its pay-record key committed and sealed. */
  'finish-company': Object.freeze({ fields: Object.freeze({ company: 'company' as const }), relays: FINISH_COMPANY_RELAYS }),
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
   * invitation kept in the saved keys before the raise. `token` is the page's own token for the link, so the page
   * makes the link itself and nothing secret comes back. The person's details are the page's words, and never reach
   * the service but sealed. It tells the page where the invitation got to, whether the upkeep was all done and how
   * many records it anchored.
   */
  invite: Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, token: 'token' as const, kind: 'words' as const,
      personName: 'words' as const, email: 'words' as const, title: 'words' as const, startDate: 'words' as const, endDate: 'words' as const,
      classification: 'words' as const, address: 'words' as const, asset: 'token' as const, amount: 'amount' as const,
      terms: 'words' as const, termsAsset: 'token' as const, termsAmount: 'amount' as const, role: 'words' as const, scope: 'seat' as const,
    }),
    optional: Object.freeze([
      'email', 'title', 'startDate', 'endDate', 'classification', 'address', 'asset', 'amount', 'terms', 'termsAsset', 'termsAmount', 'role', 'scope',
    ]),
    calls: INVITE_CALLS,
    outcome: Object.freeze({ state: 'code' as const, ...UPKEEP_OUTCOME }),
  }),
  /*
   * A signer invited by address takes the seat from their own wallet: the wallet opens the offer with the link's
   * `token`, checks the address is its own, derives its seat for the company, proves `seatInvited` with the address's
   * coin key, hands the transaction to the invitation's relay and asks to be admitted with its seat's public halves.
   */
  'seat-invited': Object.freeze({
    fields: Object.freeze({ company: 'company' as const, account: 'account' as const, record: 'record' as const, token: 'token' as const }),
    calls: Object.freeze([
      Object.freeze({ method: 'GET' as const, path: '/api/invites/:invitation/offer' }),
      Object.freeze({ method: 'POST' as const, path: '/api/invites/:invitation/seat', sends: true }),
      Object.freeze({ method: 'POST' as const, path: '/api/invites/:invitation/accept-signer' }),
    ]),
  }),
  /*
   * Approve, with the seat this wallet holds, the proposal (`proposal`, its name in the company's records) another
   * seat raised to seat a private address. `personName`, `role` (one of the four a signer may hold), `address` (the
   * commitment to the address), `scope` and `coinKey` are what the page showed: the wallet opens the proposal itself and approves it only when it invites
   * exactly those, the coin key makes the commitment, and that wallet holds no seat here and no other open invitation.
   * It raises nothing. It tells the page where the proposal got to, the approvals the chain shows, whether the upkeep
   * was all done and how many records it anchored.
   */
  'approve-signer': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, proposal: 'record' as const,
      personName: 'words' as const, role: 'words' as const, address: 'seat' as const, scope: 'seat' as const, coinKey: 'seat' as const,
    }),
    calls: APPROVE_SIGNER_CALLS,
    outcome: Object.freeze({ state: 'code' as const, approvals: 'count' as const, ...UPKEEP_OUTCOME }),
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
}) satisfies Readonly<Record<string, IntentShape>>;

export type ActIntentName = keyof typeof ACT_INTENTS & string;
