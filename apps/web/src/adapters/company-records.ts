import { privateAmount, publicAmount, type TokenAmount } from 'vaults-ui';
import { reviveBigints } from '../../../../src/core/crypto.js';
import type { Hex } from '../../../../src/core/crypto.js';
import { assets, type AssetRegistry } from '../../../../src/core/assets.js';
import { openRecord } from '../../../../src/core/sealed-records.js';
import { onlyPayableWhenActive, openPerson, peopleOnTheWire } from '../../../../src/core/person-record.js';
import type { Account, PayrollRun, Proposal, ProposalKind, ProposalStatus, SealedAccount, SealedProposal, SealedRun } from '../../../../src/core/types.js';
import { api, canOpenCompanies, openAccount, openKeysWithWallet, viewingKeyFor } from 'vaults-web-shared/keyring.js';
import { paidPublicly } from 'vaults-web-shared/public-payment.js';
import { keyringFor, keysOnTheWayIn } from './keyring-person.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { ACTED, ACT_REFUSAL, refusalOf, type ActRefusal } from './refusals.js';
import { vaultPublicMoney, type VaultPublicMoney } from './vault-public-money.js';
import { OPENED, READ, type Read } from './reads.js';

export { OPENED, READ, type Read };

/*
 * A COMPANY'S RECORDS, OPENED ON THIS DEVICE WITH THE PERSON'S SAVED KEYS, AND
 * READ FOR THE PAGES THAT ONLY READ.
 *
 * The service stores a company's name, signers, runs and proposals sealed.
 * The legacy application opens them the way
 * this file does: the shared keyring opens the keys saved for the person
 * (`openKeysWithWallet`, after the person approves in their account), derives
 * the company's viewing key from them, and opens the company's record
 * (`openAccount`); each run and proposal is opened with the same key and the
 * same `openRecord` the legacy application uses. Nothing here decides who may
 * read what: the service answers only a member, and only this device opens.
 *
 * NO READ SENDS THE VIEWING KEY TO THE SERVICE. The people on the payroll
 * come as their signed person records and are opened here, as the runs and
 * the proposals are; the service is handed no key to answer any of them.
 * Like the runs and the proposals, they are read to be shown: who filed each
 * version is judged where a person is changed or admitted
 * (`vaults-web-shared/people-on-device.ts`), not on this read. But an active
 * person is shown only when their address and payslip key are what their own
 * wallet signed (`whyNotPayable`); otherwise the people are not read at all,
 * so a screen never shows somebody as paid at an address they did not give.
 *
 * EACH READ IS ASKED AND OPENED ON ITS OWN. One that fails is handed on as
 * unreadable and the others as read, so a page never hides what was read
 * behind what was not. A payment proposal's link to its run is read from the
 * runs, and is missing when the runs could not be read. Nothing the service or the shared code says in words is
 * handed on: a screen is handed codes, and says them in its own phrases.
 *
 * EVERY AMOUNT IS MADE HERE, from its token's record in the registry, and
 * marked by how it is paid: private only to an address written the way a
 * private address is, public otherwise. Where how it is paid is not known, it
 * is marked public and said as not known, so a screen never calls private
 * what may not be.
 */

/** The service's addresses, the purposes its records are sealed for, and the words of its answers: sent and compared, never shown. */
export const SERVICE = {
  company: '/api/accounts/', proposals: '/proposals', runs: '/runs', people: '/people',
  vaults: '/vaults', vault: '/vaults/', chain: '/chain', invites: '/invites',
  proposalsRecord: 'proposals', runsRecord: 'payroll',
  active: 'active', pending: 'pending', leaver: 'leaver', shielded: 'shielded', unshielded: 'unshielded',
} as const;


/** How a payment is made, read from the address it goes to. */
export const PAID = { privately: 'privately', publicly: 'publicly', notSetUp: 'not-set-up', notKnown: 'not-known' } as const;
export type Paid = (typeof PAID)[keyof typeof PAID];

/** A signer of the company, as its own record names them. */
export interface SignerRow { id: string; name: string }

/** A proposal, as the proposals list shows it. */
export interface ProposalRow {
  id: string;
  /** What it does, by kind. */
  kind: ProposalKind;
  status: ProposalStatus;
  /** The signer who raised it, by the name the company's record gives them; null when the record names nobody by that seat. */
  raisedBy: string | null;
  /** How many have approved. */
  approvals: number;
  /** How many must, when the company's record says; null when it does not, and then no "of" is shown. */
  needed: number | null;
  /** When it was raised, as the service wrote it. */
  raisedAt: string;
  /** For a payment of a run: the run, the token it pays and that token's symbol, and whether the proposal pays privately or publicly. */
  pays: RunPays | null;
}

/**
 * What a payroll round pays: one token, in one form. `symbol` is what a
 * person is shown, and is null for a token the registry does not name; `paid`
 * is not known for a round written before a run paid one form.
 */
export interface RunPays { run: string; period: string; asset: string; symbol: string | null; paid: Paid }

/** One token of a run: what it pays privately and what publicly, never added together. */
export interface RunCurrency {
  /** The token, compared and never shown. */
  code: string;
  /** What a person is shown for the token. */
  symbol: string;
  /** Paid privately: null when nobody in the run is paid this token privately. */
  privately: TokenAmount | null;
  /** Paid publicly, or where how is not known: null when nobody is. */
  publicly: TokenAmount | null;
}

/** A person in a run, and what the run pays them. */
export interface RunPayee { id: string; name: string; amount: TokenAmount | null; paid: Paid }

/**
 * A leg of a run, paid in one token, in one form, from one vault. `code` is
 * the leg as the record keys it and `asset` its token, both compared and never
 * shown; `symbol` is what a person is shown, null for a token the registry
 * does not name.
 */
export interface RunLeg { code: string; asset: string; symbol: string | null; paid: Paid; vault: string; payees: number }

/** A payroll run, as the runs list and its own page show it. */
export interface RunRow {
  id: string;
  /** The month it pays, as the service wrote it (`2026-10`). */
  period: string;
  status: 'draft' | 'proposed' | 'settled';
  /** When it was paid, for a paid run; null otherwise, or when the record does not say. */
  settledAt: string | null;
  payees: readonly RunPayee[];
  currencies: readonly RunCurrency[];
  legs: readonly RunLeg[];
  /** How many of its amounts are in a token the registry does not name: counted, never shown as a figure. */
  unrecognised: number;
}

/** Where a person on the payroll stands. */
export const STANDING = { invited: 'invited', waitingForCheck: 'waiting-for-check', active: 'active', leaver: 'leaver' } as const;
export type PersonStanding = (typeof STANDING)[keyof typeof STANDING];

/** A person the company pays, as the people list and their panel show them. */
export interface PersonRow {
  id: string;
  name: string;
  title: string;
  standing: PersonStanding;
  /** Their pay each run, marked by how it is paid; null when their token is not in the registry. */
  pay: TokenAmount | null;
  paid: Paid;
  /** When they started, as the service wrote it. */
  startedAt: string;
}

/** Where a vault stands, one of a fixed set a screen says in its own words. */
export const VAULT = {
  held: 'held-by-committee', handoverOwed: 'handover-owed', startOwed: 'start-owed', notOnChain: 'not-on-chain-yet', notFundable: 'not-fundable',
  accountNotHandedOver: 'account-not-handed-over', accountNotFundable: 'account-not-fundable', heldByOtherKeys: 'held-by-other-keys', unknown: 'unknown',
} as const;
export type VaultStanding = (typeof VAULT)[keyof typeof VAULT];
const VAULT_STANDINGS: readonly string[] = Object.values(VAULT);

/** A vault, as the vault tiles and its own page show it. */
export interface VaultRow { vault: string; createdAt: string; standing: VaultStanding }

/** Who an invitation is for: somebody to sign, or somebody to be paid. */
export const INVITED = { signer: 'signer', employee: 'employee' } as const;

/** An invitation sent and not yet used, withdrawn or expired. */
export interface InvitationRow {
  kind: (typeof INVITED)[keyof typeof INVITED];
  /** Who it is for, as the person who sent it named them; null when they named nobody. */
  name: string | null;
  sentAt: string;
  expiresAt: string | null;
}

/** A company's records, opened. */
export interface CompanyRecords {
  of: typeof OPENED.open;
  id: string;
  name: string;
  signers: readonly SignerRow[];
  /** How many signers must approve, as the company's record says. Public: the chain publishes it. */
  approvalsNeeded: number;
  proposals: Read<readonly ProposalRow[]>;
  runs: Read<readonly RunRow[]>;
  people: Read<readonly PersonRow[]>;
  vaults: Read<readonly VaultRow[]>;
  invitations: Read<readonly InvitationRow[]>;
}

export type Company =
  | CompanyRecords
  | { of: typeof OPENED.locked | typeof OPENED.noKeysHere }
  | { of: typeof OPENED.refused; why: ActRefusal };

/** The service's answer, with its whole numbers read back as whole numbers, as the legacy application reads it. */
const ask = async (path: string): Promise<unknown> => reviveBigints(await api(path));

/** Settle a read on its own. */
async function alone<T>(read: () => Promise<T>): Promise<Read<T>> {
  try { return { of: READ.read, value: await read() }; } catch { return { of: READ.unreadable }; }
}

/** How a private address is written: its type, then the network if any, then the separator. */
const PRIVATE_ADDRESS = /^mn_shield-addr(?:_[a-z0-9]+)?1/;

/**
 * How a payment to `address` is made: privately only to an address written
 * the way a private one is; publicly to a public one; and not known when the
 * run names no address, or one of neither kind. A payment not known is shown
 * with its amount marked public, so it is never called private.
 */
export function paidTo(address: string | undefined): Paid {
  if (typeof address !== 'string') return PAID.notKnown;
  if (paidPublicly(address)) return PAID.publicly;
  return PRIVATE_ADDRESS.test(address.trim().toLowerCase()) ? PAID.privately : PAID.notKnown;
}

/** An amount of the token `code`, marked by how it is paid and shown with its symbol; null when the registry does not name the token. */
function amountOf(units: bigint, code: string, paid: Paid, registry: AssetRegistry): TokenAmount | null {
  const asset = registry.find(code);
  if (asset === null) return null;
  return paid === PAID.privately ? privateAmount(units, asset.decimals, asset.symbol) : publicAmount(units, asset.decimals, asset.symbol);
}

/**
 * A leg as the record keys it, `<token>:<form>`: its token and how it pays.
 * A leg keyed by its token alone was written before a run paid one form, so
 * how it pays is not known.
 */
function legOf(key: string): { asset: string; paid: Paid } {
  const at = key.indexOf(':');
  if (at < 0) return { asset: key, paid: PAID.notKnown };
  const form = key.slice(at + 1);
  return { asset: key.slice(0, at), paid: form === 'shielded' ? PAID.privately : form === 'unshielded' ? PAID.publicly : PAID.notKnown };
}

/** A run as this device reads it: the service's plain fields and its sealed ones, opened, the marker the record carries kept. */
function openRun(rec: SealedRun, viewingKey: Hex): PayrollRun {
  const { sealed, keyEpoch: _epoch, proposalIds: _flat, ...operational } = rec;
  return { ...operational, ...openRecord<Pick<PayrollRun, 'employees' | 'totals' | 'proposalIds'>>(SERVICE.runsRecord, rec.accountId, sealed, viewingKey) } as PayrollRun;
}

/** A proposal as this device reads it, the plain fields put back last so the envelope cannot override them. */
function openProposal(rec: SealedProposal, viewingKey: Hex): Proposal {
  const { sealed, keyEpoch: _epoch, approvalCount: _count, wiring: _wiring, ...open } = rec;
  return { ...openRecord<Omit<Proposal, 'id' | 'accountId' | 'status' | 'createdAt' | 'executedAt' | 'digest' | 'txRef' | 'chainId'>>(SERVICE.proposalsRecord, rec.accountId, sealed, viewingKey), ...open } as Proposal;
}

/** A run for a screen: its people and amounts, each token split by how it is paid. */
export function runRow(run: PayrollRun, registry: AssetRegistry = assets): RunRow {
  let unrecognised = 0;
  const payees: RunPayee[] = [];
  const sums = new Map<string, { privately: bigint; publicly: bigint; anyPrivately: boolean; anyPublicly: boolean }>();
  for (const e of run.employees ?? []) {
    const paid = paidTo(e.paidTo);
    const amount = amountOf(e.amount, e.asset, paid, registry);
    if (amount === null) unrecognised += 1;
    payees.push({ id: e.id, name: e.name, amount, paid });
    if (amount === null) continue;
    const s = sums.get(e.asset) ?? { privately: 0n, publicly: 0n, anyPrivately: false, anyPublicly: false };
    if (paid === PAID.privately) { s.privately += e.amount; s.anyPrivately = true; } else { s.publicly += e.amount; s.anyPublicly = true; }
    sums.set(e.asset, s);
  }
  const currencies: RunCurrency[] = [...sums].map(([code, s]) => ({
    code,
    symbol: registry.require(code).symbol,
    privately: s.anyPrivately ? amountOf(s.privately, code, PAID.privately, registry) : null,
    publicly: s.anyPublicly ? amountOf(s.publicly, code, PAID.publicly, registry) : null,
  }));
  /* A leg's payees are counted by its leaves, one a payee. */
  const legs: RunLeg[] = Object.entries(run.payout ?? {}).map(([code, leg]) => {
    const { asset, paid } = legOf(code);
    return { code, asset, symbol: registry.find(asset)?.symbol ?? null, paid, vault: leg.vault, payees: (leg.leaves ?? []).length };
  });
  return { id: run.id, period: run.period, status: run.status, settledAt: run.settledAt ?? null, payees, currencies, legs, unrecognised };
}

/** What a run's round for the leg `leg` pays, as a screen names it. */
function paysOf(run: PayrollRun, leg: string, registry: AssetRegistry): RunPays {
  const { asset, paid } = legOf(leg);
  return { run: run.id, period: run.period, asset, symbol: registry.find(asset)?.symbol ?? null, paid };
}

/** A proposal for a screen. */
function proposalRow(p: Proposal, signers: readonly SignerRow[], runs: readonly PayrollRun[], registry: AssetRegistry = assets): ProposalRow {
  const round = p.approvalRound;
  const run = runs.find((r) => Object.values(r.proposalIds ?? {}).includes(p.id));
  const leg = run === undefined ? undefined : Object.entries(run.proposalIds).find(([, id]) => id === p.id)?.[0];
  return {
    id: p.id, kind: p.kind, status: p.status,
    raisedBy: signers.find((s) => s.id === p.proposedBy)?.name ?? null,
    approvals: (p.approvals ?? []).length,
    needed: round !== undefined && round.state !== 'unknown' ? round.threshold : null,
    raisedAt: p.createdAt,
    pays: run === undefined || leg === undefined ? null : paysOf(run, leg, registry),
  };
}

interface RosterRow {
  id: string; name: string; title: string; asset: string; baseAmount: bigint; startDate: string;
  status: string; address: { kind: string } | null; handedOver?: boolean;
}

/** A person on the payroll for a screen. */
export function personRow(p: RosterRow, registry: AssetRegistry = assets): PersonRow {
  const paid = p.address === null ? PAID.notSetUp : p.address.kind === SERVICE.shielded ? PAID.privately : PAID.publicly;
  const standing = p.status === SERVICE.active ? STANDING.active
    : p.status === SERVICE.leaver ? STANDING.leaver
      : p.handedOver === true ? STANDING.waitingForCheck : STANDING.invited;
  /* A person with no address yet is paid however they set up: their pay is marked public until then, never private. */
  return { id: p.id, name: p.name, title: p.title, standing, pay: amountOf(p.baseAmount, p.asset, paid === PAID.privately ? PAID.privately : PAID.publicly, registry), paid, startedAt: p.startDate };
}

interface InviteRow { kind: string; name?: string; createdAt: string; expiresAt?: string; revokedAt?: string; acceptedAt?: string }

/** The invitations still waiting to be used, at `now`. */
export function invitationRows(rows: readonly InviteRow[], now: number): InvitationRow[] {
  return rows
    .filter((i) => (i.kind === INVITED.signer || i.kind === INVITED.employee) && !i.acceptedAt && !i.revokedAt && (i.expiresAt === undefined || Date.parse(i.expiresAt) > now))
    .map((i) => ({ kind: i.kind as InvitationRow['kind'], name: typeof i.name === 'string' && i.name !== '' ? i.name : null, sentAt: i.createdAt, expiresAt: i.expiresAt ?? null }));
}

/** A vault for a screen; a standing the service names that is not one of the set is unknown. */
export const vaultRow = (v: { vault: string; deployedAt: string; state: string }): VaultRow => ({
  vault: v.vault, createdAt: v.deployedAt, standing: (VAULT_STANDINGS.includes(v.state) ? v.state : VAULT.unknown) as VaultStanding,
});

/**
 * THE COMPANY `companyId`'S RECORDS, FOR THE PERSON `personId`: opened with
 * the keys saved for them, then read, each read on its own.
 */
export async function readCompany(personId: string, companyId: string): Promise<Company> {
  let sealed: SealedAccount;
  let account: Account;
  let viewingKey: Hex;
  try {
    if (!(await keyringFor(personId))) return { of: OPENED.refused, why: ACT_REFUSAL.notSignedIn };
    sealed = await ask(SERVICE.company + companyId) as SealedAccount;
    /* Keys saved in another tab since are read first, so a person who opened them there is not asked again here, and a seat this device did not finish is finished. */
    if (await keysOnTheWayIn(companyId, async () => sealed) === null) return { of: canOpenCompanies() ? OPENED.noKeysHere : OPENED.locked };
    const opened = openAccount(sealed);
    if (opened === null) return { of: OPENED.noKeysHere };
    account = opened;
    viewingKey = viewingKeyFor(sealed);
  } catch (e) {
    return { of: OPENED.refused, why: refusalOf(e) };
  }
  const signers: SignerRow[] = account.signers.map((s) => ({ id: s.id, name: s.name }));
  const route = (r: string): string => SERVICE.company + companyId + r;
  const opened = alone(async () => (await ask(route(SERVICE.runs)) as SealedRun[]).map((r) => openRun(r, viewingKey)));
  /* Each run is made into its row inside the read, so a run that cannot be made fails the runs alone. */
  const runs = opened.then((read) => (read.of === READ.read
    ? alone(async () => read.value.map((r) => runRow(r)).sort((a, b) => b.period.localeCompare(a.period)))
    : read));
  const [rows, proposals, people, vaults, invitations] = await Promise.all([
    runs,
    alone(async () => {
      const read = await opened;
      const all = (await ask(route(SERVICE.proposals)) as SealedProposal[]).map((p) => openProposal(p, viewingKey));
      return all.map((p) => proposalRow(p, signers, read.of === READ.read ? read.value : []));
    }),
    alone(async () => [...onlyPayableWhenActive(peopleOnTheWire(await ask(route(SERVICE.people)), companyId)
      .map(({ rec, handedOver }) => ({ ...openPerson(rec, viewingKey), handedOver })), sealed.companyLabel ?? '')]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => personRow(p))),
    alone(async () => ((await ask(route(SERVICE.vaults)) as { rows: { vault: string; deployedAt: string; state: string }[] }).rows).map(vaultRow)),
    alone(async () => invitationRows(await ask(route(SERVICE.invites)) as InviteRow[], Date.now())),
  ]);
  return {
    of: OPENED.open, id: companyId, name: account.name, signers, approvalsNeeded: sealed.threshold,
    proposals, runs: rows, people, vaults, invitations,
  };
}

/**
 * OPEN THE KEYS SAVED FOR THE PERSON, with their account: it asks them to
 * approve, and releases the key the saved keys are sealed under. Nothing is
 * signed or sent but that approval.
 */
export async function openWithYourAccount(personId: string): Promise<{ of: typeof ACTED.done } | { of: typeof ACTED.refused; why: ActRefusal }> {
  if (ACCOUNT_ORIGIN === '') return { of: ACTED.refused, why: ACT_REFUSAL.notSetUp };
  try {
    if (!(await keyringFor(personId))) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn };
    await openKeysWithWallet(ACCOUNT_ORIGIN);
    return { of: ACTED.done };
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e) };
  }
}

/**
 * WHAT THE VAULT `vault` HOLDS IN PUBLIC MONEY, read when the person asks, as
 * the legacy vault screen reads it: the service's view of the vault, read by
 * the shared reader. Null when it could not be read, which is never shown as
 * nothing held.
 */
export async function readVaultPublicMoney(personId: string, companyId: string, vault: string): Promise<VaultPublicMoney | null> {
  try {
    if (!(await keyringFor(personId))) return null;
    return await vaultPublicMoney(() => api(SERVICE.company + companyId + SERVICE.vault + vault + SERVICE.chain));
  } catch {
    return null;
  }
}
