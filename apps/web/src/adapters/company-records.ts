import { privateAmount, publicAmount, type TokenAmount } from 'vaults-ui';
import { reviveBigints } from '../../../../src/core/crypto.js';
import { assets, type AssetRegistry } from '../../../../src/core/assets.js';
import { openRecord } from '../../../../src/core/sealed-records.js';
import { classificationOn, payLineOn, payLinesOf } from '../../../../src/core/person-record.js';
import type { EmployeeClassification } from '../../../../src/core/invitation.js';
import { typedAddressIsShielded } from 'midnight-identity/profile/address-claim';
import type { Account, PayrollRun, Proposal, ProposalKind, ProposalStatus, RosterEmployee, SealedAccount, SealedProposal, SealedRun } from '../../../../src/core/types.js';
import type { RefusedEntry, RosterEntryRefusal } from '../../../../src/core/roster-record.js';
import { api, canOpenCompanies, currentUser, holdersFromTheWallet, openKeysWithWallet } from 'vaults-web-shared/keyring.js';
import { companyKeysFor, directoryHereFor, filingJudgeFor, openedHere, rosterReadsFor, walletIndexerFor } from './filing-judge.js';
import { keyOf, type CompanyKeys } from '../../../../src/core/company-key.js';
import { theVaultBuilder } from './vault-builder.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { paidPublicly } from 'vaults-web-shared/public-payment.js';
import { keyringFor, keysOnTheWayIn } from './keyring-person.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { ACTED, ACT_REFUSAL, refusalOf, type ActRefusal } from './refusals.js';
import { vaultPublicMoney, type VaultPublicMoney } from './vault-public-money.js';
import { OPENED, READ, type Read } from './reads.js';
import { Fault, FAULT } from '../faults.js';
import { readPeopleHere, type PeopleReader } from 'vaults-web-shared/people-read-here.js';
import { readVendorsHere, type VendorHere } from 'vaults-web-shared/vendors-read-here.js';
import { NETWORK } from 'midnight-identity/network';
import type { NetworkName } from '../../../../src/midnight/network.js';
import { addSignerByAddressIn } from '../../../../src/core/proposal-filing.js';
import { approvalsForSigners, signerStandings, signersInvitedIn, type ChainSeats, type SignerInvited, type SignerStanding, type SignersApprovals } from './signers.js';

export { OPENED, READ, type Read };

/*
 * A COMPANY'S RECORDS, OPENED ON THIS DEVICE WITH THE PERSON'S SAVED KEYS, AND
 * READ FOR THE PAGES THAT ONLY READ.
 *
 * The service stores a company's name, signers, runs and proposals sealed. This file opens them on the device: the
 * person's wallet reads the keys saved for them and opens this seat's copy of each company's viewing key
 * (`openKeysWithWallet`, after the person approves in their account); this page derives the company's keys from its
 * directory (`companyKeysFor`), opens the company's record (`openAccount`), and opens each run, proposal and person with
 * the key of the epoch it was sealed at (`openRecord`, shared with src/web). Nothing here decides who may read what:
 * the service answers only a member, and only this device opens.
 *
 * NO READ SENDS THE VIEWING KEY TO THE SERVICE. The people on the payroll come as their signed person records and
 * are opened here, as the runs and the proposals are; the service is handed no key to answer any of them.
 *
 * People are read with this device's own belief check (`readPeopleHere`), as a seat's device reads them. A record is
 * set aside, not shown, when:
 *   - its filer or history is not believed (`peopleBelief.notBelieved`);
 *   - it does not read as a person of this company (`refused`);
 *   - it is an active person whose address and payslip key differ from what their own wallet signed, or, for an
 *     unshielded address, whose wallet's signed claim fails (`notPayable`, with the reason). The claim is checked
 *     with the ledger in the vault builder's worker, since this page loads none; a claim it cannot check makes the
 *     whole read unreadable.
 * `people` holds none of them and reads as unreadable while any exist, so a screen that reads only `people` loses
 * nobody silently and never shows someone as paid at an address they did not give. The People page reads
 * `peopleBelief` instead: `rows` lists the people it does show (an active person it will not pay among them, marked
 * by `notPayable`) beside everyone it left out. Vendors are read the same way (`vendors`, with `vendorsBelief`).
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
  vaults: '/vaults', invites: '/invites', employee: '/api/employees/', handover: '/handover',
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
  /**
   * The signer who raised it, by the name the company's record gives them; null when the record names nobody by that
   * seat, or names them only in an entry this device refused as not what its own wallet signed.
   */
  raisedBy: string | null;
  /** Why this device does not believe the roster entry of the signer who raised it; null when it does, or names nobody. */
  raiserNotBelieved?: RosterEntryRefusal | null;
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

/** How a person is admitted: on the fingerprint they read out (added by link or at a private address), or on their wallet's signed claim of the public address they were added at, with nothing read out. */
export const ADMIT_BY = { fingerprint: 'fingerprint', claim: 'claim' } as const;
export type AdmitBy = (typeof ADMIT_BY)[keyof typeof ADMIT_BY];

/** One line of a person's salary history: what they are paid each run from a calendar day, and when a seat's device made the line (null on a line from before the history was kept). */
interface PersonPayLine { amount: TokenAmount | null; from: string; madeAt: string | null }

/** One line of a person's classification history, kept the way a pay line is. */
interface PersonClassificationLine { classification: EmployeeClassification; from: string; madeAt: string | null }

/** A person the company pays, as the people list and their panel show them. */
export interface PersonRow {
  id: string;
  name: string;
  title: string;
  standing: PersonStanding;
  /** Their pay each run, marked by how it is paid and shown with its Public pill only when `visibilityKnown(paid)`; null when their token is not in the registry. */
  pay: TokenAmount | null;
  paid: Paid;
  /** When they started: a calendar date, such as 2026-10-01, never a moment. */
  startedAt: string;
  /** The token they are paid in, by its code: a change of their pay is in this token and no other. */
  asset: string;
  /** The classification in force today, or their first when none is yet; null when the record names none. */
  classification: EmployeeClassification | null;
  /** The calendar day a fixed term ends and the calendar day they leave, when the record names them. */
  endDate: string | null;
  leavingDate: string | null;
  /** Every salary line, oldest first as the record keeps them: one from the start date for a record filed before the history was kept. */
  pays: readonly PersonPayLine[];
  /** Every classification line as the record keeps them; none for a record that names no classification. */
  classifications: readonly PersonClassificationLine[];
  /** The moment a signer admitted them; null until then. */
  admittedAt: string | null;
  /** What admits them: the fingerprint they read out, or their wallet's signed claim. */
  admitBy: AdmitBy;
  /** Why this device will not pay them, when they are active and their record does not hold; null for everyone else. Nothing is admitted or changed for them. */
  notPayable: string | null;
}

/** Where a vault stands, one of a fixed set a screen says in its own words. */
export const VAULT = {
  held: 'held-by-committee', startOwed: 'start-owed', notOnChain: 'not-on-chain-yet', notFundable: 'not-fundable',
  accountNotHandedOver: 'account-not-handed-over', accountNotFundable: 'account-not-fundable', heldByOtherKeys: 'held-by-other-keys', unknown: 'unknown',
} as const;
export type VaultStanding = (typeof VAULT)[keyof typeof VAULT];
const VAULT_STANDINGS: readonly string[] = Object.values(VAULT);

/**
 * A vault, as the vault tiles and its own page show it. `adopted` is set only on a vault the company's account adopted,
 * as the person's own wallet read the chain: the one kind of vault whose filed name is read and shown.
 */
export interface VaultRow { vault: string; createdAt: string; standing: VaultStanding; adopted?: true }

/** Who an invitation is for: somebody to sign, or somebody to be paid (an employee or a vendor). Another kind of invitation is not listed. */
export const INVITED = { signer: 'signer', employee: 'employee', vendor: 'vendor' } as const;

/** An invitation sent and not yet used, withdrawn or expired. */
export interface InvitationRow {
  kind: (typeof INVITED)[keyof typeof INVITED];
  /** Who it is for, as the person who sent it named them; null when they named nobody. */
  name: string | null;
  sentAt: string;
  expiresAt: string | null;
}

/** A person this device read and would not show as payable: their row and why. */
interface PersonNotPayable { person: PersonRow; why: string }

/**
 * What this device's belief check left out of `people`, and why. `notBelieved` are record ids it does not believe (no
 * name: a record it does not believe says nothing it can show); `notPayable` are active people it believes and will not
 * pay, each with why (they are in `rows` too, marked; a pending or former person is in `rows`, unmarked); `refused` are records that do not read as a person's.
 * `rows` are the people it believes and shows, the same rows `people` holds when nobody is left out: the People page
 * lists them beside what was left out, so one record it does not believe never takes the rest off the page.
 */
export interface PeopleBelief {
  rows: readonly PersonRow[];
  notBelieved: readonly string[];
  notPayable: readonly PersonNotPayable[];
  refused: readonly { id: string; why: string }[];
}

/**
 * A vendor of the company: where they stand, how they are paid, their dates, and whether a hand-over waits for a signer to admit
 * them. `monthly` is the monthly amount in `asset` (shown with its Public pill only when `visibilityKnown(paid)`), null for one-off terms or a token this app does not know; `admitBy` is how a
 * signer admits them; `notPayable` is why this device will not pay them, null when it will.
 */
export interface VendorRow {
  id: string;
  name: string;
  standing: PersonStanding;
  handedOver: boolean;
  termsKind: 'monthly' | 'one-off';
  asset: string | null;
  monthly: TokenAmount | null;
  paid: Paid;
  startedAt: string;
  endDate: string | null;
  admittedAt: string | null;
  admitBy: AdmitBy;
  notPayable: string | null;
}

/**
 * The company's vendors as this device reads them: listed (`vendors`), not believed, and active vendors it believes but will not pay, each with
 * why (`notPayable`, as for people: one not yet admitted, or who has left, is never named here). `rows` are every vendor it believes, the active
 * ones it will not pay among them, marked, so the page lists them beside what was left out.
 */
export interface VendorsRead {
  vendors: readonly VendorRow[];
  notBelieved: readonly string[];
  notPayable: readonly { vendor: VendorRow; why: string }[];
  rows: readonly VendorRow[];
}

/** A company's records, opened. */
export interface CompanyRecords {
  of: typeof OPENED.open;
  id: string;
  name: string;
  signers: readonly SignerRow[];
  /** How many signers must approve, as the person's own wallet reads it off the chain; not readable when the wallet cannot say. */
  approvalsNeeded: Read<number>;
  proposals: Read<readonly ProposalRow[]>;
  runs: Read<readonly RunRow[]>;
  people: Read<readonly PersonRow[]>;
  vaults: Read<readonly VaultRow[]>;
  invitations: Read<readonly InvitationRow[]>;
  /** What the belief check left out of `people`; each id once, in `refused` or in `notBelieved` (set by `readCompany`). */
  peopleBelief?: Read<PeopleBelief>;
  /** The vendors; unreadable while any vendor is not believed or not payable, as `people` is (set by `readCompany`). */
  vendors?: Read<VendorsRead>;
  /** The vendors with those left out of `vendors` named, each with why (set by `readCompany`). */
  vendorsBelief?: Read<VendorsRead>;
  /** Each signer as accepted or seated, which is you, and whether the directory holds their entry (set by `readCompany`). */
  signerStandings?: Read<readonly SignerStanding[]>;
  /** The approvals a change of signers needs, and what sets them (set by `readCompany`). */
  approvalsForSigners?: Read<SignersApprovals>;

  /**
   * The proposals that invite a signer by address and still wait, opened from the same list as `proposals`, each with the seat the
   * chain says it took and the roster's entry waiting there; one whose seat the believed roster holds active is left out. Unreadable
   * when that list is, or when none could be opened.
   */
  signersInvited?: Read<readonly SignerInvited[]>;
}

export type Company =
  | CompanyRecords
  | { of: typeof OPENED.locked | typeof OPENED.noKeysHere }
  | { of: typeof OPENED.refused; why: ActRefusal };

/** The service's answer, with its whole numbers read back as whole numbers (`reviveBigints`). */
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
function openRun(rec: SealedRun, viewingKey: CompanyKeys): PayrollRun {
  const { sealed, keyEpoch, proposalIds: _flat, ...operational } = rec;
  return { ...operational, ...openRecord<Pick<PayrollRun, 'employees' | 'totals' | 'proposalIds'>>(SERVICE.runsRecord, rec.accountId, sealed, keyOf(viewingKey, keyEpoch)) } as PayrollRun;
}

/** A proposal as this device reads it, the plain fields put back last so the envelope cannot override them. */
function openProposal(rec: SealedProposal, viewingKey: CompanyKeys): Proposal {
  const { sealed, keyEpoch, approvalCount: _count, wiring: _wiring, ...open } = rec;
  return { ...openRecord<Omit<Proposal, 'id' | 'accountId' | 'status' | 'createdAt' | 'executedAt' | 'digest' | 'txRef' | 'chainId'>>(SERVICE.proposalsRecord, rec.accountId, sealed, keyOf(viewingKey, keyEpoch)), ...open } as Proposal;
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

/**
 * The refusals of a roster entry whose name is still shown: the seat is no longer held, or retired, or its holder has
 * not opened the company yet. An entry not as its own wallet signed it is vouched for by nothing, its name included.
 */
const namedThoughNotBelieved = (why: RosterEntryRefusal): boolean =>
  why === 'seat-not-on-the-chain' || why === 'seat-retired' || why === 'no-entry-of-their-own';

/** A proposal for a screen. */
function proposalRow(
  p: Proposal, signers: readonly SignerRow[], runs: readonly PayrollRun[], registry: AssetRegistry = assets, refused: readonly RefusedEntry[] = [],
): ProposalRow {
  const round = p.approvalRound;
  const run = runs.find((r) => Object.values(r.proposalIds ?? {}).includes(p.id));
  const notBelieved = refused.find((r) => r.signerId === p.proposedBy);
  const leg = run === undefined ? undefined : Object.entries(run.proposalIds).find(([, id]) => id === p.id)?.[0];
  return {
    id: p.id, kind: p.kind, status: p.status,
    raisedBy: signers.find((s) => s.id === p.proposedBy)?.name ?? (notBelieved !== undefined && namedThoughNotBelieved(notBelieved.why) ? notBelieved.name : null),
    raiserNotBelieved: notBelieved === undefined || signers.some((s) => s.id === p.proposedBy) ? null : notBelieved.why,
    approvals: (p.approvals ?? []).length,
    needed: round !== undefined && round.state !== 'unknown' ? round.threshold : null,
    raisedAt: p.createdAt,
    pays: run === undefined || leg === undefined ? null : paysOf(run, leg, registry),
  };
}

interface RosterRow {
  id: string; name: string; title: string; asset: string; baseAmount: bigint; startDate: string;
  pay?: RosterEmployee['pay']; status: string; address: { kind: string } | null; handedOver?: boolean;
  classifications?: RosterEmployee['classifications']; endDate?: string | null; leavingDate?: string | null; admittedAt?: string | null; invitedAddress?: string | null;
}

/** How a payee is paid, read from the address their record holds: not set up while it holds none. */
const paidOf = (address: { readonly kind: string } | null): Paid => (address === null ? PAID.notSetUp : address.kind === SERVICE.shielded ? PAID.privately : PAID.publicly);

/**
 * WHETHER AN ADDRESS DECIDES HOW A PAYMENT IS MADE: only a payee whose record holds the address says whether their payments are private or
 * public, so a screen draws the Public pill on their amounts, or promises nothing of them, only when this is true. A payee with no
 * address yet has no visibility to show: the amount is shown as a figure alone, and the words beside it say no address is set.
 */
export const visibilityKnown = (paid: Paid): boolean => paid === PAID.privately || paid === PAID.publicly;

/** The mark an amount of a payee is made with: private only when their address is, public otherwise, and never private by default. */
const markOf = (paid: Paid): Paid => (paid === PAID.privately ? PAID.privately : PAID.publicly);

/** Where a person or vendor stands, from their record's status and whether a hand-over waits. */
const standingOfRecord = (status: string, handedOver: boolean | undefined): PersonStanding => (status === SERVICE.active ? STANDING.active
  : status === SERVICE.leaver ? STANDING.leaver : handedOver === true ? STANDING.waitingForCheck : STANDING.invited);

/** How a signer admits them: on their wallet's signed claim when they were added by an unshielded address, on the fingerprint they read out otherwise. */
const admitByOf = (invitedAddress: string | null | undefined): AdmitBy => (invitedAddress != null && !typedAddressIsShielded(invitedAddress) ? ADMIT_BY.claim : ADMIT_BY.fingerprint);

/** A person on the payroll for a screen. Their pay is the salary line in force on `today`, or, before they start, their first; every line and the classification history are kept for their panel. */
export function personRow(p: RosterRow, registry: AssetRegistry = assets, today: string = new Date().toISOString().slice(0, 10)): PersonRow {
  const paid = paidOf(p.address);
  /* A person with no address yet is paid however they set up: their pay is marked public until then, never private, and shown without a visibility (`visibilityKnown`). */
  const form = markOf(paid);
  return {
    id: p.id, name: p.name, title: p.title, standing: standingOfRecord(p.status, p.handedOver), pay: amountOf((payLineOn(p, today) ?? payLinesOf(p)[0]!).amount, p.asset, form, registry), paid, startedAt: p.startDate,
    asset: p.asset,
    classification: classificationOn(p, today) ?? p.classifications?.[0]?.classification ?? null,
    endDate: p.endDate ?? null, leavingDate: p.leavingDate ?? null,
    pays: payLinesOf(p).map((l) => ({ amount: amountOf(l.amount, p.asset, form, registry), from: l.from, madeAt: l.madeAt })),
    classifications: (p.classifications ?? []).map((l) => ({ classification: l.classification, from: l.from, madeAt: l.madeAt })),
    admittedAt: p.admittedAt ?? null,
    admitBy: admitByOf(p.invitedAddress),
    notPayable: null,
  };
}

interface InviteRow { kind: string; name?: string; createdAt: string; expiresAt?: string; revokedAt?: string; acceptedAt?: string }

/** The invitations still waiting to be used, at `now`. */
export function invitationRows(rows: readonly InviteRow[], now: number): InvitationRow[] {
  return rows
    .filter((i) => (i.kind === INVITED.signer || i.kind === INVITED.employee || i.kind === INVITED.vendor) && !i.acceptedAt && !i.revokedAt && (i.expiresAt === undefined || Date.parse(i.expiresAt) > now))
    .map((i) => ({ kind: i.kind as InvitationRow['kind'], name: typeof i.name === 'string' && i.name !== '' ? i.name : null, sentAt: i.createdAt, expiresAt: i.expiresAt ?? null }));
}

/** A vault for a screen; a standing the service names that is not one of the set is unknown. `adopted` when the account adopted it. */
export const vaultRow = (v: { vault: string; deployedAt: string; state: string }, adopted = false): VaultRow => ({
  vault: v.vault, createdAt: v.deployedAt, standing: (VAULT_STANDINGS.includes(v.state) ? v.state : VAULT.unknown) as VaultStanding,
  ...(adopted ? { adopted: true as const } : {}),
});

/** A vault sent and not yet adopted: its set-up is not finished, so it is not yet one of the company's vaults. */
const NOT_YET_ADOPTED: ReadonlySet<string> = new Set([VAULT.startOwed, VAULT.notOnChain]);

/** A row of the service's list of a company's vaults, as it answers it. */
type ServedVault = { vault: string; deployedAt: string; state: string };

/**
 * **THE COMPANY'S VAULTS ARE THE VAULTS ITS ACCOUNT HAS ADOPTED, AS THE
 * PERSON'S OWN WALLET READ THEM OFF THE CHAIN.** The service's list only
 * says when each was made and where its set-up stands. A vault the account
 * adopted that the service's list leaves out makes the whole list unreadable,
 * so a list cut short is noticed rather than shown short; a vault the service
 * lists that the account has not adopted is shown only as a set-up not
 * finished, never as one of the company's vaults. Each row of a vault the
 * account adopted says so, so a screen reads a name only for those.
 */
export const vaultsAsTheChainHoldsThem = (served: readonly ServedVault[], adopted: readonly string[]): Read<readonly VaultRow[]> => {
  const held = new Set(adopted.map((v) => v.toLowerCase()));
  const listed = new Set(served.map((r) => r.vault.toLowerCase()));
  if ([...held].some((v) => !listed.has(v))) return { of: READ.unreadable };
  return {
    of: READ.read,
    value: served.filter((r) => held.has(r.vault.toLowerCase()) || NOT_YET_ADOPTED.has(r.state)).map((r) => vaultRow(r, held.has(r.vault.toLowerCase()))),
  };
};

/**
 * WHAT THE PERSON'S OWN WALLET READS OF THE COMPANY'S ACCOUNT IN ONE ASK, with the service's list of its vaults: the
 * vaults the account has adopted, each with the service's row for it, and how many signers must approve. The approvals
 * are the answer's `approvals`, never its `threshold`, which is the account's maintenance committee's. Each is
 * unreadable when the company names no account yet or the read it rests on fails; the approvals do not wait on the
 * service's list, and the vaults do not rest on a wallet answer that carries no approvals.
 */
/**
 * The seat each add-signer proposal took, as the chain says through the person's own indexer, by the proposal's identity on
 * the chain. A chain that could not be read says no seat was taken, so the page offers Approve as before and the wallet decides.
 */
const seatsTakenOnChain = async (
  companyId: string, sealed: Pick<SealedAccount, 'companyLabel' | 'contractAddress'>, served: readonly { readonly rec: SealedProposal; readonly opened: Proposal }[],
): Promise<Readonly<Record<string, string | null>>> => {
  const ids = served.filter(({ opened }) => opened.kind === 'add-signer').map(({ rec }) => rec.chainId);
  if (ids.length === 0 || sealed.companyLabel == null || sealed.contractAddress == null) return {};
  try {
    const read = rosterReadsFor(companyId, sealed.companyLabel as CompanyLabel, sealed.contractAddress as AccountAddress).invitedSeats;
    return read === undefined ? {} : await read(ids);
  } catch {
    return {};
  }
};

async function chainOfTheCompany(
  companyId: string, sealed: Pick<SealedAccount, 'companyLabel' | 'contractAddress'>, read: (path: string) => Promise<unknown> = api,
): Promise<{ vaults: Read<readonly VaultRow[]>; approvals: Read<number>; holders: Read<ChainSeats> }> {
  const label = sealed.companyLabel ?? null;
  const address = sealed.contractAddress ?? null;
  if (label === null || address === null) return { vaults: { of: READ.unreadable }, approvals: { of: READ.unreadable }, holders: { of: READ.unreadable } };
  const [answer, wallet] = await Promise.all([
    (read(SERVICE.company + companyId + SERVICE.vaults) as Promise<{ rows?: unknown }>).catch(() => null),
    holdersFromTheWallet(ACCOUNT_ORIGIN, { company: label as CompanyLabel, account: address as AccountAddress }).catch(() => null),
  ]);
  if (wallet === null) return { vaults: { of: READ.unreadable }, approvals: { of: READ.unreadable }, holders: { of: READ.unreadable } };
  const needed = wallet.holders.approvals;
  const approvals: Read<number> = Number.isSafeInteger(needed) && needed >= 1 ? { of: READ.read, value: needed } : { of: READ.unreadable };
  const vaults: Read<readonly VaultRow[]> = Array.isArray(answer?.rows)
    ? vaultsAsTheChainHoldsThem(answer.rows as ServedVault[], wallet.holders.adoptedVaults) : { of: READ.unreadable };
  return { vaults, approvals, holders: { of: READ.read, value: wallet.holders } };
}

/**
 * The vaults of the company `companyId`, whose record is `sealed`: the account's own, as the person's own wallet reads
 * them, each with the service's row for it; unreadable when the company names no account yet, or either read fails.
 */
export async function vaultListOf(
  companyId: string, sealed: Pick<SealedAccount, 'companyLabel' | 'contractAddress'>, read: (path: string) => Promise<unknown> = api,
): Promise<Read<readonly VaultRow[]>> {
  return (await chainOfTheCompany(companyId, sealed, read)).vaults;
}

/* The companies whose pages are open, newest last: the newest is the one opening the saved keys opens too. */
const pagesOpen: string[] = [];

/**
 * A company's pages say they are on screen while they are, and the closer they are handed says they have gone:
 * "Open with your account" names the company whose pages are open, and none once they are all left.
 */
export function companyPagesOpen(companyId: string): () => void {
  pagesOpen.push(companyId);
  return () => {
    const at = pagesOpen.lastIndexOf(companyId);
    if (at >= 0) pagesOpen.splice(at, 1);
  };
}

/** A vendor as the vendors read answers, as a row, from the same derivations a person's row is made with; `notPayable` is the why when this device will not pay them. */
function vendorRow(h: VendorHere, notPayable: string | null = null, registry: AssetRegistry = assets): VendorRow {
  const v = h.vendor;
  const paid = paidOf(v.address);
  return {
    id: v.id, name: v.name, standing: standingOfRecord(v.status, h.handedOver),
    handedOver: h.handedOver === true, termsKind: v.terms.kind,
    asset: v.terms.kind === 'monthly' ? v.terms.asset : null,
    monthly: v.terms.kind === 'monthly' ? amountOf(v.terms.amount, v.terms.asset, markOf(paid), registry) : null,
    paid, startedAt: v.startDate, endDate: v.endDate ?? null, admittedAt: v.admittedAt,
    admitBy: admitByOf(v.invitedAddress),
    notPayable,
  };
}

/**
 * THE COMPANY `companyId`'S RECORDS, FOR THE PERSON `personId`: opened with
 * what their wallet read from the keys saved for them, then read, each read on
 * its own. Reading signs,
 * files and anchors nothing: the company's records are anchored at the end of
 * each seat action in a signer's wallet.
 */
export async function readCompany(personId: string, companyId: string): Promise<Company> {
  let sealed: SealedAccount;
  let account: Account & { readonly refused?: readonly RefusedEntry[] };
  let viewingKey: CompanyKeys;
  let ownSeat: { readonly signerId: string; readonly signingPublicKey: string };
  try {
    if (!(await keyringFor(personId))) return { of: OPENED.refused, why: ACT_REFUSAL.notSignedIn };
    sealed = await ask(SERVICE.company + companyId) as SealedAccount;
    /* Keys saved in another tab since are read first, so a person who opened them there is not asked again here. */
    const keys = await keysOnTheWayIn(companyId);
    if (keys === null) return { of: canOpenCompanies(companyId) ? OPENED.noKeysHere : OPENED.locked };
    const opened = await openedHere(sealed);
    if (opened === null) return { of: OPENED.noKeysHere };
    account = opened;
    viewingKey = await companyKeysFor(companyId, sealed, { signingPublicKey: keys.signingPublicKey });
    ownSeat = { signerId: keys.signerId, signingPublicKey: keys.signingPublicKey };
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
  /* The seats the company's directory holds an entry for, as the people read's own directory read found them: no read more. */
  let entries: ReadonlySet<string> | null = null;
  const reader = ((): PeopleReader | null => {
    const label = sealed.companyLabel ?? null;
    const address = sealed.contractAddress ?? null;
    if (label === null || address === null) return null;
    const directory = directoryHereFor(companyId, label as CompanyLabel, address as AccountAddress, viewingKey, async () => account);
    return {
      company: { id: companyId, label: label as CompanyLabel, viewingKey },
      send: async (path) => ({ status: 200, body: await api(path) }),
      directory: async (asked) => {
        const here = await directory(asked);
        const seats = (here as { dir?: { seats?: unknown } } | null)?.dir?.seats;
        if (entries === null && Array.isArray(seats)) {
          entries = new Set(seats.flatMap((x) => { const seat = (x as { seat?: unknown } | null)?.seat; return typeof seat === 'string' ? [seat.toLowerCase()] : []; }));
        }
        return here;
      },
      network: NETWORK as NetworkName,
      claimRefusal: async (claim, f) => {
        const { addressClaimRefusal } = await theVaultBuilder();
        /* A builder that cannot check a claim fails the read: nobody added by an unshielded address is read unchecked. */
        if (addressClaimRefusal === undefined) throw new Fault(FAULT.noClaimCheckInTheBuilder);
        return addressClaimRefusal(claim, f);
      },
    };
  })();
  const peopleRead: Promise<Read<Awaited<ReturnType<typeof readPeopleHere>>>> = reader === null
    ? Promise.resolve({ of: READ.unreadable }) : alone(async () => readPeopleHere(reader));
  const [rows, proposalsRead, peopleHere, chain, invitations, vendorsHere] = await Promise.all([
    runs,
    alone(async () => {
      const read = await opened;
      const served = await ask(route(SERVICE.proposals)) as SealedProposal[];
      const all = served.map((p) => openProposal(p, viewingKey));
      return {
        rows: all.map((p) => proposalRow(p, signers, read.of === READ.read ? read.value : [], assets, account.refused ?? [])),
        served: served.map((rec, i) => ({ rec, opened: all[i]! })),
      };
    }),
    peopleRead,
    chainOfTheCompany(companyId, sealed, ask),
    alone(async () => invitationRows(await ask(route(SERVICE.invites)) as InviteRow[], Date.now())),
    reader === null ? Promise.resolve({ of: READ.unreadable } as const) : alone(async () => readVendorsHere(reader, undefined, { handedOver: true })),
  ]);
  const proposals: Read<readonly ProposalRow[]> = proposalsRead.of === READ.read ? { of: READ.read, value: proposalsRead.value.rows } : proposalsRead;
  const peopleLeftOut = peopleHere.of === READ.read && (peopleHere.value.notBelieved.length > 0 || (peopleHere.value.refused ?? []).length > 0
    || peopleHere.value.notPayable.some((n) => n.here.person.status === SERVICE.active));
  /* An active person the check will not pay is a row too, marked with why: a pending or former person it lists without that mark is shown as they are. */
  const whyNotPaid = new Map(peopleHere.of === READ.read ? peopleHere.value.notPayable.filter((n) => n.here.person.status === SERVICE.active).map((n) => [n.here.person.id, n.why] as const) : []);
  const shownPeople: readonly PersonRow[] = peopleHere.of !== READ.read ? [] : [
    ...peopleHere.value.people.map((here) => ({ ...here.person, handedOver: here.handedOver })),
    ...peopleHere.value.notPayable.map((n) => ({ ...n.here.person, handedOver: n.here.handedOver })),
  ].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ ...personRow(p), notPayable: whyNotPaid.get(p.id) ?? null }));
  const people: Read<readonly PersonRow[]> = peopleHere.of !== READ.read || peopleLeftOut ? { of: READ.unreadable } : { of: READ.read, value: shownPeople };
  const peopleBelief: Read<PeopleBelief> = peopleHere.of !== READ.read ? peopleHere : {
    of: READ.read,
    value: {
      rows: shownPeople,
      notBelieved: peopleHere.value.notBelieved.filter((id) => !(peopleHere.value.refused ?? []).some((r) => r.id === id)),
      notPayable: peopleHere.value.notPayable.filter((n) => n.here.person.status === SERVICE.active)
        .map((n) => ({ person: personRow({ ...n.here.person, handedOver: n.here.handedOver }), why: n.why })),
      refused: peopleHere.value.refused ?? [],
    },
  };
  /* Only an active vendor the check will not pay is marked and named, as an active person is: a vendor not yet admitted, or who has left, is listed as they are, with the admit control (the wallet checks their address when they are admitted). */
  const activeNotPayable = vendorsHere.of === READ.read ? vendorsHere.value.notPayable.filter((n) => n.here.vendor.status === SERVICE.active) : [];
  const vendorsBelief: Read<VendorsRead> = vendorsHere.of !== READ.read ? vendorsHere : {
    of: READ.read,
    value: {
      vendors: vendorsHere.value.vendors.map((h) => vendorRow(h)),
      notBelieved: vendorsHere.value.notBelieved,
      notPayable: activeNotPayable.map((n) => ({ vendor: vendorRow(n.here, n.why), why: n.why })),
      rows: [
        ...vendorsHere.value.vendors.map((h) => vendorRow(h)),
        ...vendorsHere.value.notPayable.map((n) => vendorRow(n.here, n.here.vendor.status === SERVICE.active ? n.why : null)),
      ].sort((a, b) => a.name.localeCompare(b.name)),
    },
  };
  const vendors: Read<VendorsRead> = vendorsBelief.of === READ.read && (vendorsBelief.value.notBelieved.length > 0 || vendorsBelief.value.notPayable.length > 0)
    ? { of: READ.unreadable } : vendorsBelief;
  const standings: Read<readonly SignerStanding[]> = chain.holders.of === READ.read
    ? { of: READ.read, value: signerStandings(account.signers, chain.holders.value.seats, { own: ownSeat, entries }) } : chain.holders;
  const forSigners: Read<SignersApprovals> = chain.holders.of === READ.read ? approvalsForSigners(chain.holders.value) : chain.holders;
  const signersInvited: Read<readonly SignerInvited[]> = proposalsRead.of !== READ.read ? proposalsRead : await alone(async () => signersInvitedIn(
    proposalsRead.value.served, (rec) => addSignerByAddressIn(rec, companyId, viewingKey),
    {
      taken: await seatsTakenOnChain(companyId, sealed, proposalsRead.value.served),
      waiting: account.signers.filter((s) => s.status === 'pending'), seated: account.signers.filter((s) => s.status === 'active'),
    },
  ));
  return {
    of: OPENED.open, id: companyId, name: account.name, signers, approvalsNeeded: chain.approvals,
    proposals, runs: rows, people, vaults: chain.vaults, invitations,
    peopleBelief, vendors, vendorsBelief, signerStandings: standings, approvalsForSigners: forSigners, signersInvited,
  };
}

/**
 * HAVE THE PERSON'S ACCOUNT READ THE KEYS SAVED FOR THEM: it asks them to
 * approve, opens the saved keys itself, and gives this page what they hold
 * that is not secret, with the key that reads the vault balances of the company
 * on screen (`companyId`, by default the one whose pages are open, `companyPagesOpen`)
 * when its own read of the chain confirms that company.
 * Nothing is signed or sent but that approval.
 */
export async function openWithYourAccount(
  personId: string, companyId: string | null = pagesOpen.at(-1) ?? null,
): Promise<{ of: typeof ACTED.done } | { of: typeof ACTED.refused; why: ActRefusal }> {
  if (ACCOUNT_ORIGIN === '') return { of: ACTED.refused, why: ACT_REFUSAL.notSetUp };
  try {
    if (!(await keyringFor(personId))) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn };
    await openKeysWithWallet(ACCOUNT_ORIGIN, undefined, undefined, undefined, companyId ?? undefined);
    return { of: ACTED.done };
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e) };
  }
}

/**
 * WHAT THE VAULT `vault` HOLDS IN PUBLIC MONEY, read when the person asks: the
 * vault's state read in this device's vault worker, at the indexer this
 * person's own wallet names, and read by the shared reader. Null when it could
 * not be read, the company names no account or label, or the wallet names no
 * indexer, which is never shown as nothing held.
 */
export async function readVaultPublicMoney(personId: string, companyId: string, vault: string): Promise<VaultPublicMoney | null> {
  try {
    if (!(await keyringFor(personId))) return null;
    const sealed = await api(SERVICE.company + companyId) as SealedAccount;
    const label = sealed.companyLabel ?? null;
    const address = sealed.contractAddress ?? null;
    if (label === null || address === null) return null;
    const indexer = await walletIndexerFor(label as CompanyLabel, address as AccountAddress);
    if (indexer === null) return null;
    const builder = await theVaultBuilder();
    return await vaultPublicMoney(() => builder.vaultOnChain({ vault, indexer }));
  } catch {
    return null;
  }
}

/** What `readVaultName` answers, when asked to, for a name it could not read, apart from none filed. */
export const NAME_NOT_READ: unique symbol = Symbol();

/**
 * THE NAME THE COMPANY FILED FOR THE VAULT `vault`, opened on this device with the company's key and believed only
 * as far as the company's directory, read by the person's own wallet, believes the filer. Null when there is no name
 * to show: none was filed, it is blank, or - unless `unread` is given, which is answered instead - it could not be
 * read or believed, nobody or somebody else is signed in, or the company names no account. A screen then says the
 * vault by its number. The record code is loaded when a name is asked for, so a page that shows no name does not carry it.
 */
export async function readVaultName(personId: string, companyId: string, vault: string): Promise<string | null>;
export async function readVaultName(personId: string, companyId: string, vault: string, unread: typeof NAME_NOT_READ): Promise<string | null | typeof NAME_NOT_READ>;
export async function readVaultName(
  personId: string, companyId: string, vault: string, unread?: typeof NAME_NOT_READ,
): Promise<string | null | typeof NAME_NOT_READ> {
  const notRead = unread ?? null;
  try {
    if (!(await keyringFor(personId))) return notRead;
    const sealed = await api(SERVICE.company + companyId) as SealedAccount;
    const label = sealed.companyLabel ?? null;
    const address = sealed.contractAddress ?? null;
    if (label === null || address === null) return notRead;
    const keys = await keysOnTheWayIn(companyId);
    if (keys === null) return notRead;
    const account = await openedHere(sealed);
    if (account === null) return notRead;
    const companyKeys: CompanyKeys = await companyKeysFor(companyId, sealed, { signingPublicKey: keys.signingPublicKey });
    const judge = filingJudgeFor(companyId, label as CompanyLabel, address as AccountAddress, companyKeys, async () => account);
    const { vaultInfoHere, vaultInfoRecordsFor } = await import('vaults-web-shared/vault-info-here.js');
    const filed = await vaultInfoHere({ companyKeys, records: vaultInfoRecordsFor(companyId, null, judge, () => currentUser()?.id ?? null) }, vault);
    if (filed.state === 'unread') return notRead;
    return filed.state === 'named' && filed.name.trim() !== '' ? filed.name : null;
  } catch {
    return notRead;
  }
}
