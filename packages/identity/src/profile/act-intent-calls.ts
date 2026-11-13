/**
 * WHAT EACH ACTION A WALLET RUNS MAY CALL ON THE SERVICE, THROUGH THE PAGE.
 *
 * One list of routes per action (`ACT_INTENTS` names it as the action's `calls`), and the relays finishing a company
 * makes. A call to any route an action's list does not name is refused before it is made.
 */
import type { CallRoute } from './act-intents.js';

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
export const FINISH_COMPANY_CALLS: readonly CallRoute[] = Object.freeze([
  { method: 'POST', path: '/api/accounts/:record/creation/pay-key/proposal', sends: true, sendsWith: 'tx' },
].map((r) => Object.freeze(r)) as CallRoute[]);

/**
 * The service calls an action on a company's records makes through the page:
 * reading the company, its directory, its roster's offers, its proposals and
 * its manifest; filing this seat's directory entry, its vault keys, the
 * roster's fold and the manifest entries for each record it files.
 */
export const COMPANY_RECORD_CALLS: readonly CallRoute[] = Object.freeze([
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
 * the anchor; the fee sponsorship for a call the company's own service or the
 * person's wallet submits; and the company's read grants read, and filed again
 * wrapped to the company's new key once it changes.
 */
export const UPKEEP_CALLS: readonly CallRoute[] = Object.freeze([
  { method: 'GET', path: '/api/accounts/:record/records/:kind/:id/versions' },
  { method: 'PUT', path: '/api/accounts/:record/records/:kind/:id/:version' },
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

/**
 * What creating a vault adds: the vault's deploy and the transactions of its
 * start, each carried in a call to the service that sends it; its name and its
 * proposals filed; and its pool and secret records read and filed.
 */
export const CREATE_VAULT_CALLS: readonly CallRoute[] = Object.freeze([
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
 * journal, its pool, its nonce secret filed again), and the one call that sends the deposit. The upkeep it adds files
 * only the company's roster and its read grants, so of the company's records it may write those two kinds and no other.
 */
export const PRIVATE_DEPOSIT_CALLS: readonly CallRoute[] = Object.freeze([
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
  { method: 'PUT', path: '/api/accounts/:record/records/roster/:id/:version' },
  { method: 'PUT', path: '/api/accounts/:record/records/grants/:id/:version' },
  ...UPKEEP_CALLS.filter((u) => !(u.method === 'PUT' && u.path === '/api/accounts/:record/records/:kind/:id/:version')),
].map((r) => Object.freeze(r)) as CallRoute[]);

/**
 * What a one-off payment asks of the page: the company's records it reads to believe the vault, the policy, the
 * proposals, the runs and the one-off's own record; the one-off's record and the manifest entries it files; the vault's
 * records it reads and files for the payment; and the calls that send the raise, an approval, the charge to the
 * vault's period and the payment. None of them carries the amount, payee or name in the clear, except a public
 * payment's own transaction, which shows them as every public payment does.
 */
export const ONE_OFF_PAYMENT_CALLS: readonly CallRoute[] = Object.freeze([
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
export const INVITE_CALLS: readonly CallRoute[] = Object.freeze([
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
export const APPROVE_PROPOSAL_CALLS: readonly CallRoute[] = Object.freeze([
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
export const CHANGE_THRESHOLD_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'POST', path: '/api/accounts/:record/proposals', sends: true, sendsWith: 'tx' },
  { method: 'POST', path: '/api/proposals/:proposal/send', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/approve', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/standing' },
  { method: 'POST', path: '/api/proposals/:proposal/carry', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/closed' },
  ...UPKEEP_CALLS.filter((u) => !COMPANY_RECORD_CALLS.some((c) => c.method === u.method && c.path === u.path)),
].map((r) => Object.freeze(r)) as CallRoute[]);

/*
 * What retiring a vault reads and writes: what changing the approvals needed does, besides the vault itself read on the
 * chain by the wallet; the vault's own retire goes from the wallet to the chain, its fee paid by the sponsorship the
 * upkeep's routes list.
 */
export const RETIRE_VAULT_CALLS: readonly CallRoute[] = CHANGE_THRESHOLD_CALLS;

/*
 * What raising a change of policy reads and writes: what changing the approvals needed does, the policy's own sealed
 * record filed through the records route the upkeep already lists.
 */
export const SET_POLICY_CALLS: readonly CallRoute[] = CHANGE_THRESHOLD_CALLS;

/**
 * What raising a payroll run asks of the page: the company's records, its runs (read, and filed when the run is
 * drawn here), its people and vendors, the vaults' records the vault's money is read from, the proposal filed with
 * its transaction or a filed one sent again, where it stands, and the upkeep every seat action does.
 */
export const RAISE_RUN_CALLS: readonly CallRoute[] = Object.freeze([
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
export const PAY_RUN_CALLS: readonly CallRoute[] = Object.freeze([
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
export const WITHDRAW_PROPOSAL_CALLS: readonly CallRoute[] = Object.freeze([
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
export const REMOVE_SIGNER_CALLS: readonly CallRoute[] = Object.freeze([
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
export const ROTATE_VAULT_SECRETS_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'POST', path: '/api/accounts/:record/proposals', sends: true, sendsWith: 'tx' },
  { method: 'POST', path: '/api/proposals/:proposal/send', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/approve', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/standing' },
  ...UPKEEP_CALLS,
].filter((r, i, all) => all.findIndex((x) => x.method === r.method && x.path === r.path) === i)
  .map((r) => Object.freeze({ ...r })) as CallRoute[]);

/*
 * What admitting a signer seated by address reads and writes: the company, its roster and its proposals read, the
 * roster filed with the person in it and the company's key wrapped to them, in one call, plus the upkeep's routes.
 */
export const ADMIT_SIGNER_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'POST', path: '/api/accounts/:record/signers/:signer/admit' },
  ...UPKEEP_CALLS.filter((u) => !COMPANY_RECORD_CALLS.some((c) => c.method === u.method && c.path === u.path)),
].map((r) => Object.freeze(r)) as CallRoute[]);

/*
 * What admitting a person or a vendor reads and writes: the company's records, its people and its invitations read,
 * what the person handed over read, and their record filed active in one call, plus the upkeep's routes.
 */
export const ADMIT_PERSON_CALLS: readonly CallRoute[] = Object.freeze([
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
export const CHANGE_PERSON_CALLS: readonly CallRoute[] = Object.freeze([
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
export const CHOOSE_COMPANY_SERVICE_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'PUT', path: '/api/accounts/:record/records/:kind/:id/:version' },
  ...UPKEEP_CALLS.filter((u) => !COMPANY_RECORD_CALLS.some((c) => c.method === u.method && c.path === u.path)),
].map((r) => Object.freeze(r)) as CallRoute[]);

/*
 * What giving or taking away a read grant reads and writes: the company's records (the grants already filed, read as
 * every act reads them), the next version of the grants filed and entered, the readers handed to the service once the
 * change is in force, and the upkeep's routes, which change the company's key after a taking-away.
 */
export const GRANT_READ_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'PUT', path: '/api/accounts/:record/records/:kind/:id/:version' },
  { method: 'POST', path: '/api/accounts/:record/readers' },
  ...UPKEEP_CALLS,
].filter((r, i, all) => all.findIndex((x) => x.method === r.method && x.path === r.path) === i)
  .map((r) => Object.freeze({ ...r })) as CallRoute[]);

/*
 * Changing a signer's role: the seat's removal, then the person's invitation by address at the new role, so what each
 * of the two calls and nothing else.
 */
export const CHANGE_ROLE_CALLS: readonly CallRoute[] = Object.freeze([...REMOVE_SIGNER_CALLS, ...INVITE_CALLS]
  .filter((r, i, all) => all.findIndex((x) => x.method === r.method && x.path === r.path) === i)
  .map((r) => Object.freeze({ ...r })) as CallRoute[]);

/*
 * What a reader's wallet reads to believe the read grants in force: the company, its directory, the grants' versions
 * and the anchor of its records. Every one is a read a reader of the company may make; nothing is written or sent.
 */
export const READER_KEYS_CALLS: readonly CallRoute[] = Object.freeze([
  { method: 'GET', path: '/api/accounts/:record' },
  { method: 'GET', path: '/api/accounts/:record/directory' },
  { method: 'GET', path: '/api/accounts/:record/records/:kind/:id/versions' },
  { method: 'POST', path: '/api/accounts/:record/manifest/newest', reads: true },
  { method: 'POST', path: '/api/accounts/:record/manifest/tree/proofs', reads: true },
  { method: 'GET', path: '/api/accounts/:record/manifest/tree/pending', query: ['root'] },
  { method: 'GET', path: '/api/accounts/:record/manifest/tree/headers', query: ['after', 'limit'] },
].map((r) => Object.freeze(r)) as CallRoute[]);

/** The upkeep's routes a list built on the company's records does not already name. */
const UPKEEP_BEYOND_RECORDS: readonly CallRoute[] = UPKEEP_CALLS.filter((u) => !COMPANY_RECORD_CALLS.some((c) => c.method === u.method && c.path === u.path));

/*
 * What withdrawing a person waiting for a seat reads and writes: the company's records its proposals and the seat are
 * read from, and the one withdrawal signed by this seat, plus the upkeep's routes. Which proposals the chain holds is
 * read from the chain by the wallet itself, never asked of the service.
 */
export const WITHDRAW_WAITING_SIGNER_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'POST', path: '/api/accounts/:record/signers/:signer/withdraw' },
  ...UPKEEP_BEYOND_RECORDS,
].map((r) => Object.freeze(r)) as CallRoute[]);

/*
 * What sending a signer's invitation again reads and writes: the company's records the seat and the proposal that
 * seated the person are read from, and the new invitation filed, plus the upkeep's routes.
 */
export const REISSUE_INVITATION_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'POST', path: '/api/accounts/:record/invites' },
  ...UPKEEP_BEYOND_RECORDS,
].map((r) => Object.freeze(r)) as CallRoute[]);

/*
 * What taking a re-issued invitation reads: the company's records this wallet's seat and the proposal that seated it
 * are read from, and the re-issued offer. Nothing is written.
 */
export const TAKE_REISSUE_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'GET', path: '/api/invites/:invitation/offer' },
].map((r) => Object.freeze(r)) as CallRoute[]);

/*
 * What adding a signer from their code reads and writes: the company's records the seat is read from, the invitation
 * filed, and the person's request for a seat filed under it, sealed to the company, plus the upkeep's routes.
 */
export const ADD_SIGNER_BY_CODE_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'POST', path: '/api/accounts/:record/invites' },
  { method: 'POST', path: '/api/invites/:invitation/accept-signer' },
  ...UPKEEP_BEYOND_RECORDS,
].map((r) => Object.freeze(r)) as CallRoute[]);

/*
 * What proposing the seat of a person waiting reads and writes: the company's records, its runs and its roster read,
 * the proposal written down and raised with this seat's approval and its standing read, and the person admitted when
 * the chain already holds their seat, plus the upkeep's routes.
 */
export const RAISE_WAITING_SIGNER_CALLS: readonly CallRoute[] = Object.freeze([
  ...COMPANY_RECORD_CALLS,
  { method: 'GET', path: '/api/accounts/:record/runs' },
  { method: 'POST', path: '/api/accounts/:record/proposals', sends: true, sendsWith: 'tx' },
  { method: 'POST', path: '/api/proposals/:proposal/send', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/approve', sends: true },
  { method: 'POST', path: '/api/proposals/:proposal/standing' },
  { method: 'POST', path: '/api/accounts/:record/signers/:signer/admit' },
  ...UPKEEP_BEYOND_RECORDS,
].map((r) => Object.freeze(r)) as CallRoute[]);
