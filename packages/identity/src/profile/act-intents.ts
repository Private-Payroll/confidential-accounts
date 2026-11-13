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
 * by), the page's own words (`words`, a short text such as a vault's name,
 * which the wallet shows as the page's and never treats as anything it read
 * itself), or a join code a person's own wallet wrote (`join-code`), which the
 * wallet reads and checks itself.
 */
export type IntentFieldKind = 'company' | 'account' | 'vault' | 'seat' | 'amount' | 'token' | 'record' | 'words' | 'join-code';

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

import {
  FINISH_COMPANY_RELAYS, FINISH_COMPANY_CALLS, COMPANY_RECORD_CALLS, UPKEEP_CALLS, CREATE_VAULT_CALLS,
  PRIVATE_DEPOSIT_CALLS, ONE_OFF_PAYMENT_CALLS, INVITE_CALLS, APPROVE_PROPOSAL_CALLS, CHANGE_THRESHOLD_CALLS, RETIRE_VAULT_CALLS,
  RAISE_RUN_CALLS, PAY_RUN_CALLS, WITHDRAW_PROPOSAL_CALLS, REMOVE_SIGNER_CALLS, ROTATE_VAULT_SECRETS_CALLS, SET_POLICY_CALLS,
  ADMIT_SIGNER_CALLS, ADMIT_PERSON_CALLS, CHANGE_PERSON_CALLS, CHOOSE_COMPANY_SERVICE_CALLS, GRANT_READ_CALLS, CHANGE_ROLE_CALLS,
  READER_KEYS_CALLS, WITHDRAW_WAITING_SIGNER_CALLS, REISSUE_INVITATION_CALLS, TAKE_REISSUE_CALLS, ADD_SIGNER_BY_CODE_CALLS,
  RAISE_WAITING_SIGNER_CALLS,
} from './act-intent-calls.js';

export { FINISH_COMPANY_RELAYS };

import { RETIREMENT_OUTCOME, UPKEEP_OUTCOME, VAULTS_CHANGED_OUTCOME } from './act-outcomes.js';

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
   * the signers as the page lists them: all three the page's words. With `retired`, the company's record of the
   * retire that retired `vault`, the vault is adopted again under the proposal that retire carried out.
   */
  'create-vault': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, vault: 'vault' as const,
      title: 'words' as const, about: 'words' as const, readers: 'words' as const, retired: 'record' as const,
    }),
    optional: Object.freeze(['vault', 'title', 'about', 'readers', 'retired']),
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
   * once the seat is taken, bound in the proposal; `vaults`, where given, the vaults a signer's seat may act on, every
   * vault when none. For an employee or a vendor, `token` is the page's own token for the link, so the page makes
   * the link itself; a signer's token is made in the wallet, which shows the link in its own window, and a page never
   * gives or gets one. The person's details are the page's words, and never reach the service but sealed. It tells the
   * page where the invitation got to, for a signer the approvals the proposal holds and needs as the chain shows them,
   * whether the upkeep was all done and how many records it anchored.
   */
  invite: Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, token: 'token' as const, kind: 'words' as const,
      personName: 'words' as const, email: 'words' as const, title: 'words' as const, startDate: 'words' as const, endDate: 'words' as const,
      classification: 'words' as const, address: 'words' as const, asset: 'token' as const, amount: 'amount' as const,
      terms: 'words' as const, termsAsset: 'token' as const, termsAmount: 'amount' as const, role: 'words' as const, scope: 'seat' as const,
      threshold: 'amount' as const, vaults: 'words' as const,
    }),
    optional: Object.freeze([
      'token', 'email', 'title', 'startDate', 'endDate', 'classification', 'address', 'asset', 'amount', 'terms', 'termsAsset', 'termsAmount', 'role',
      'scope', 'threshold', 'vaults',
    ]),
    calls: INVITE_CALLS,
    outcome: Object.freeze({ state: 'code' as const, approvals: 'count' as const, needed: 'count' as const, ...UPKEEP_OUTCOME }),
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
      Object.freeze({ method: 'GET' as const, path: '/api/accounts/:record/directory' }),
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
      rotation: 'code' as const, vaultSecrets: 'code' as const, vaultSecretsWhy: 'code' as const, ...VAULTS_CHANGED_OUTCOME, ...RETIREMENT_OUTCOME,
      ...UPKEEP_OUTCOME,
    }),
  }),
  /*
   * Retire, with the seat this wallet holds, `vault` from the company's account: the wallet reads the vault holding no
   * money on the chain and refuses otherwise, raises the retire with this seat's approval counted, or carries on the one
   * the company's records already hold, and has the vault carry it out once the chain counts the company's threshold.
   * It tells the page where the retire got to, the approvals the chain shows and needs, whether the upkeep was all done
   * and how many records it anchored.
   */
  'retire-vault': Object.freeze({
    fields: Object.freeze({ record: 'record' as const, company: 'company' as const, account: 'account' as const, vault: 'vault' as const }),
    optional: Object.freeze([]),
    calls: RETIRE_VAULT_CALLS,
    outcome: Object.freeze({ state: 'code' as const, approvals: 'count' as const, needed: 'count' as const, said: 'code' as const, ...UPKEEP_OUTCOME }),
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
  /*
   * Set, with the seat this wallet holds, `vault`'s spending policy for the currency `token`: four bands written
   * `ceiling:approvals` and separated by commas, the limit in each period, the first period's start and the period's
   * length in seconds. The wallet refuses it from a seat whose role does not set spending policies; files the policy as
   * a version of its sealed record signed by this seat; raises the proposal, or approves the same change already
   * raised; and carries it out when the chain counts its bar. It tells the page where the proposal got to and its name,
   * the approvals the chain shows and needs, whether the upkeep was all done and how many records it anchored.
   */
  'set-spending-policy': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, vault: 'vault' as const, token: 'token' as const,
      periodLimit: 'amount' as const, periodStart: 'amount' as const, periodLength: 'amount' as const, bands: 'words' as const,
    }),
    calls: SET_POLICY_CALLS,
    outcome: Object.freeze({ state: 'code' as const, proposal: 'record' as const, approvals: 'count' as const, needed: 'count' as const, ...UPKEEP_OUTCOME }),
  }),
  /*
   * Change, with the seat this wallet holds, the approvals any change to a spending policy needs to `bar`, which is
   * also the least that adding, removing or re-seating a signer needs. Any seat may raise it. It tells the page what
   * `set-spending-policy` tells.
   */
  'set-policy-bar': Object.freeze({
    fields: Object.freeze({ record: 'record' as const, company: 'company' as const, account: 'account' as const, bar: 'amount' as const }),
    calls: SET_POLICY_CALLS,
    outcome: Object.freeze({ state: 'code' as const, proposal: 'record' as const, approvals: 'count' as const, needed: 'count' as const, ...UPKEEP_OUTCOME }),
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
      rotation: 'code' as const, vaultSecrets: 'code' as const, vaultSecretsWhy: 'code' as const, ...VAULTS_CHANGED_OUTCOME, ...RETIREMENT_OUTCOME, ...UPKEEP_OUTCOME,
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
   * Withdraw, with the seat this wallet holds, the person waiting for a seat under `signer`, whom no proposal can still
   * seat as the wallet reads the chain itself: the withdrawal is signed in the wallet and the service lets the request go
   * and marks its invitation withdrawn. `personName` is the name the page showed. It tells the page whether it was done,
   * and how the upkeep went.
   */
  'withdraw-waiting-signer': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, signer: 'record' as const,
      personName: 'words' as const,
    }),
    calls: WITHDRAW_WAITING_SIGNER_CALLS,
    outcome: Object.freeze({ state: 'code' as const, ...UPKEEP_OUTCOME }),
  }),
  /*
   * Sign again, with the seat this wallet holds, the invitation the person seated at `leaf` was proposed under, with
   * every term unchanged, under a new link the wallet shows in its own window and never hands the page. `personName` is
   * the name the page showed. It tells the page whether it was done, and how the upkeep went.
   */
  'reissue-invitation': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, leaf: 'seat' as const,
      personName: 'words' as const,
    }),
    calls: REISSUE_INVITATION_CALLS,
    outcome: Object.freeze({ state: 'code' as const, ...UPKEEP_OUTCOME }),
  }),
  /*
   * Keep, in the wallet of the person it is for, the re-issued invitation under the link's `token` for the seat this
   * wallet holds on the company, with the seat that signed it as who invited them. Nothing is sent. It tells the page
   * whether it was kept.
   */
  'take-reissue': Object.freeze({
    fields: Object.freeze({ company: 'company' as const, account: 'account' as const, record: 'record' as const, token: 'token' as const }),
    calls: TAKE_REISSUE_CALLS,
    outcome: Object.freeze({ state: 'code' as const }),
  }),
  /*
   * File, with the seat this wallet holds, an invitation and a request for a seat from the `code` a person's own wallet
   * made, at the `role` the page names (a code's seat is for every vault, so only an admin's), under `personName`. The
   * fingerprint to compare is shown in the wallet's own window. It tells the page whether it was filed, the request's
   * id (`signer`) to propose the seat by, and how the upkeep went.
   */
  'add-signer-by-code': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, code: 'join-code' as const,
      personName: 'words' as const, role: 'words' as const,
    }),
    calls: ADD_SIGNER_BY_CODE_CALLS,
    outcome: Object.freeze({ state: 'code' as const, signer: 'record' as const, ...UPKEEP_OUTCOME }),
  }),
  /*
   * Raise, with the seat this wallet holds, the proposal to seat the person waiting under `signer` who joined by a link
   * or a code, at the address their own wallet signed, once `readOut` is the fingerprint their request makes.
   * `personName` is the name the page showed. It tells the page where the proposal got to, and how the upkeep went.
   */
  'raise-waiting-signer': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, signer: 'record' as const,
      personName: 'words' as const, readOut: 'words' as const,
    }),
    calls: RAISE_WAITING_SIGNER_CALLS,
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
  /*
   * Give a read grant (`code`, the join code the reader's own wallet signed over its key for this company and its person
   * id; `role`, limited or accountant), or take one away from `recipient`, the reader's key (`away`, yes), signed with the seat this wallet holds and filed as
   * the next version of the company's read grants, sealed to every seat and reader. It comes into force once signers at
   * the seat bar have each signed it in their own wallets; once in force the readers are handed to the service, and a
   * taking-away changes the company's key. It tells the page whether the change is in force, how many signers have
   * signed it and how many it needs, and how the upkeep went.
   */
  'grant-read': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, recipient: 'seat' as const,
      code: 'words' as const, role: 'words' as const, away: 'words' as const,
    }),
    optional: Object.freeze(['recipient', 'code', 'role', 'away']),
    calls: GRANT_READ_CALLS,
    outcome: Object.freeze({ state: 'code' as const, filed: 'count' as const, needed: 'count' as const, ...UPKEEP_OUTCOME }),
  }),
  /*
   * Change a signer's role (`leaf`, the seat; `role`, the new signer role): while the chain holds the seat, its removal
   * is raised; once the removal is carried out, pressed again, the person is invited by `address` at the new role,
   * named `personName`, on the vaults the seat held, under the token the first press made and kept in the wallet,
   * which the page never gives or gets; the link is shown in the wallet's own window. It tells the page which step the
   * change is at (`stage`), and what the removal or the invitation tells.
   */
  'change-role': Object.freeze({
    fields: Object.freeze({
      record: 'record' as const, company: 'company' as const, account: 'account' as const, leaf: 'seat' as const, role: 'words' as const,
      address: 'words' as const, personName: 'words' as const,
    }),
    calls: CHANGE_ROLE_CALLS,
    outcome: Object.freeze({
      stage: 'code' as const, state: 'code' as const, approvals: 'count' as const, needed: 'count' as const,
      rotation: 'code' as const, vaultSecrets: 'code' as const, vaultSecretsWhy: 'code' as const, ...VAULTS_CHANGED_OUTCOME, ...RETIREMENT_OUTCOME, ...UPKEEP_OUTCOME,
    }),
  }),
  /*
   * Repair the company's key from this seat: a new key made from the newest one this seat holds, wrapped to every signer
   * who stays, the payout seed kept, for when a signer's copy of the newest key does not open. Refused for a seat that
   * does not hold the newest key. It ends with the upkeep, which wraps the read grants again to the new key. It tells
   * the page what became of the key (`state`) and its new `epoch`, and what the upkeep did.
   */
  'repair-company-key': Object.freeze({
    fields: Object.freeze({ record: 'record' as const, company: 'company' as const, account: 'account' as const }),
    calls: Object.freeze([...COMPANY_RECORD_CALLS, ...UPKEEP_CALLS]),
    outcome: Object.freeze({ state: 'code' as const, epoch: 'count' as const, ...UPKEEP_OUTCOME }),
  }),
  /*
   * Drop the role change this wallet keeps for one seat (`leaf`), so a role change abandoned before its invitation is
   * filed leaves nothing behind. It sends nothing and changes nothing on the chain or in the company's records; a
   * removal already raised stays raised. It tells the page whether there was one to drop (`state`).
   */
  'drop-role-change': Object.freeze({
    fields: Object.freeze({ record: 'record' as const, company: 'company' as const, account: 'account' as const, leaf: 'seat' as const }),
    calls: Object.freeze([]) as readonly CallRoute[],
    outcome: Object.freeze({ state: 'code' as const }),
  }),
  /*
   * Read a company as one of its readers: this wallet works out its reader key for the company, believes the newest
   * read grant sealed to it that signers at the seat bar signed, from the company's directory and the chain, and hands
   * the page only the keys that grant wraps to it, for this one company. It signs and sends nothing and needs no seat. It tells the page nothing else.
   */
  'reader-keys': Object.freeze({
    fields: Object.freeze({ record: 'record' as const, company: 'company' as const, account: 'account' as const }),
    calls: READER_KEYS_CALLS,
  }),
  /*
   * Set the company's recovery window to `seconds`, or add this seat's signature to a change to that length still
   * gathering signatures: signed with the seat this wallet holds, filed as the next version of the window, sealed to
   * every seat and to the company's key. Any seat signs; only a seat whose role files policy (an admin, or a seat with no role set) starts a change. It tells
   * the page whether the change is in force, how many signers have signed it and how many it needs, and how the upkeep went.
   */
  'set-recovery-window': Object.freeze({
    fields: Object.freeze({ record: 'record' as const, company: 'company' as const, account: 'account' as const, seconds: 'amount' as const }),
    calls: Object.freeze([...COMPANY_RECORD_CALLS, ...UPKEEP_CALLS]),
    outcome: Object.freeze({ state: 'code' as const, signed: 'count' as const, needed: 'count' as const, ...UPKEEP_OUTCOME }),
  }),
}) satisfies Readonly<Record<string, IntentShape>>;

export type ActIntentName = keyof typeof ACT_INTENTS & string;
