/**
 * THE ACTIONS A PAGE MAY ASK A WALLET TO RUN WHOLE, BY NAME.
 *
 * An `act` ask names one of these and the ids and amounts it acts on, and
 * nothing else: the wallet reads the chain itself, builds every transaction
 * itself and hands each back for the page to send. So every field an action
 * takes is one of the kinds below: an id or an amount the wallet can check
 * on its own, or a short text the wallet shows as the page's words, and none
 * of them is bytes the page built. An action not
 * named here is refused before anything is shown, and so is a field its
 * entry does not name.
 *
 * Adding an action is one entry here (its fields and their kinds, and what
 * each transaction it hands back is for) and one definition of the same name
 * in the wallet, which will not build without it.
 */

/**
 * What one field of an action may be: a company's label, its account, a vault,
 * a seat, an amount, a private token (`token`, its sixty-four hex characters
 * as the ledger names it), the service's own name for a company's record
 * (`record`, a short id the wallet only ever uses to say which record it asks
 * the page for, and checks nothing by), or the page's own words (`words`, a
 * short text such as a vault's name, which the wallet shows as the page's and
 * never treats as anything it read itself).
 */
export type IntentFieldKind = 'company' | 'account' | 'vault' | 'seat' | 'amount' | 'token' | 'record' | 'words';

/**
 * A call to the service an action may ask the page to make for it, and the
 * only calls it may: the method, and the path with `:name` standing for one
 * path segment. `sends` marks a call that carries a transaction to the chain,
 * which is counted with the relays. Every answer is the page's word, which the
 * wallet checks before it relies on it.
 */
export interface CallRoute {
  readonly method: 'GET' | 'PUT' | 'POST';
  readonly path: string;
  readonly sends?: boolean;
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
  { method: 'POST', path: '/api/accounts/:record/proposals', sends: true },
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
}) satisfies Readonly<Record<string, IntentShape>>;

export type ActIntentName = keyof typeof ACT_INTENTS & string;
