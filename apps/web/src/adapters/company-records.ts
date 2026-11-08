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
import { companyKeysQuietlyFor, directoryHereFor, filingJudgeFor, openedQuietly, rosterReadsFor, walletIndexerFor } from './filing-judge.js';
import { KIND_FIELD, NEVER_WITHDRAWN, POLICY_KINDS, RUN_FORM, RUN_LIST, WALLET_KIND, type RunForm, type RunList } from 'vaults-web-shared/proposal-in-the-wallet.js';
import type { RoundOnChain } from 'vaults-web-shared/governed-call-builder.js';
import { VAULT, type VaultStanding } from 'vaults-web-shared/vault-standing.js';
import type { ClosedAs } from 'vaults-web-shared/run-rebuilt-here.js';
import { PROPOSAL_STANDING, shownStatus, statusOnChain, type ClosingRead, type ProposalStanding } from './proposal-standing-on-chain.js';
import type { DirectoryRead } from 'vaults-web-shared/vault-page-doors.js';
import { keyOf, type CompanyKeys } from '../../../../src/core/company-key.js';
import { theVaultBuilder } from './vault-builder.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { paidPublicly } from 'vaults-web-shared/public-payment.js';
import { keyringFor, keysOnTheWayIn } from './keyring-person.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { ACTED, ACT_REFUSAL, refusalOf, type ActRefusal } from './refusals.js';
import { vaultPublicMoney, type VaultPublicMoney } from './vault-public-money.js';
import { OPENED, READ, type Read } from './reads.js';
import { seatsTakenAsked } from 'vaults-web-shared/seat-not-read-on-the-chain.js';
import { Fault, FAULT } from '../faults.js';
import { readPeopleHere, type PeopleReader } from 'vaults-web-shared/people-read-here.js';
import { readVendorsHere, type VendorHere } from 'vaults-web-shared/vendors-read-here.js';
import { NETWORK } from 'midnight-identity/network';
import type { NetworkName } from '../../../../src/midnight/network.js';
import { addSignerByAddressIn, type AddSignerByAddress } from '../../../../src/core/proposal-filing.js';
import { HttpCompanyRecordStore, type WireSend } from 'vaults-web-shared/http-sealed-pool-store.js';
import { oneOffHere } from 'vaults-web-shared/one-off-here.js';
import {
  ASKS_UNREAD, listedKindOf, NOT_READ, proposalAsksHere, type Asked, type AsksReads, type AsksUnread, type OneOffHere, type ProposalAsks,
} from 'vaults-web-shared/proposal-asks-here.js';
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
 * Proposals are read as the chain holds them, through the page's vault worker at the indexer the person's own wallet
 * names (`proposalsHere`): where each stands, its count and the bar it was raised needing are the chain's, and who
 * raised it is the seat whose signed filing this device believes. One this device does not believe, or cannot open,
 * is listed by its id as unreadable, never as the service gave it.
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
  proposalsRecord: 'proposals', runsRecord: 'payroll', proposalKind: 'proposal',
  active: 'active', pending: 'pending', leaver: 'leaver', shielded: 'shielded', unshielded: 'unshielded',
} as const;

/** How a payment is made, read from the address it goes to. */
export const PAID = { privately: 'privately', publicly: 'publicly', notSetUp: 'not-set-up', notKnown: 'not-known' } as const;
export type Paid = (typeof PAID)[keyof typeof PAID];

/** A signer of the company, as its own record names them. */
export interface SignerRow { id: string; name: string }

/** What a proposal this device does not believe, or cannot open, is listed as: by its id alone, with nothing read from it. */
const UNREADABLE = 'unreadable' as const;

/** A proposal, as the proposals list shows it. */
export interface ProposalRow {
  id: string;
  /**
   * What it does, by kind; a change to a spending policy or to the approvals one needs is `change-policy`, whichever its
   * record is sealed as; `unreadable` for a proposal this device does not believe or cannot open.
   */
  kind: ProposalKind | typeof UNREADABLE;
  /**
   * Where it stands, as the chain holds it and never as the service lists it: `approved` while it is held cleared or
   * has the approvals it was raised needing, `executed` once a call other than a withdrawal or a closing past its
   * window took it off the chain, `cancelled` once a withdrawal did, `expired` once the closing of a run past its
   * window did, `closed` when it is off the chain and how it closed was not read, `open` otherwise; `unreadable` for
   * a proposal not read.
   */
  status: ProposalStatus | ClosedAs | typeof UNREADABLE;
  /**
   * The signer who raised it: the one whose signing key the filing this device believes is signed with, by the name
   * the company's record gives them; null when no believed signer has that key, the filing is not signed, or the
   * record names them only in an entry this device refused as not what its own wallet signed.
   */
  raisedBy: string | null;
  /** Why this device does not believe the roster entry of the signer who raised it; null when it does, or names nobody. */
  raiserNotBelieved?: RosterEntryRefusal | null;
  /** How many have approved, as the chain counts them; once closed, its count when it closed, for showing only. */
  approvals: number;
  /** How many it was raised needing, as the chain holds it; null when the chain holds no number for it, and then no "of" is shown. */
  needed: number | null;
  /**
   * When it was raised: when the chain first held it, or, for one the chain has not shown, when its record was written;
   * empty for one the service did not give.
   */
  raisedAt: string;
  /** For a payment of a run: the run, the token it pays and that token's symbol, and whether the proposal pays privately or publicly. */
  pays: RunPays | null;
  /**
   * What the wallet is asked to check before it approves it, or pays it (`ProposalAsks`); absent when it is neither waiting nor a one-off payment the chain
   * holds approved, is of a kind this page does not approve, or `asksUnread` says why.
   */
  asks?: ProposalAsks;
  /**
   * For a one-off payment the chain holds approved: whether the account records its payment, asked of the chain by the payment leaf the worker built from
   * its record. Absent when that was not read, and then nothing is offered on it.
   */
  paidOnChain?: boolean;
  /** Why a waiting proposal, or a one-off payment the chain holds approved, of a kind this page approves carries no asks (`ASKS_UNREAD`); absent for a kind this page does not approve. */
  asksUnread?: AsksUnread;
  /** Whether the seat this device holds filed it: the filing this device believes is signed with this seat's own signing key. */
  raisedByYou?: boolean;
}

export { ASKS_UNREAD, type AsksUnread, type ProposalAsks };

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
export interface RunLeg {
  code: string; asset: string; symbol: string | null; paid: Paid; vault: string; payees: number;
  /** Each person's payment on this leg as the account would record it paid, 64 lower-case hex digits; absent where the run records none. */
  leaves?: readonly string[];
  /** Every further attempt at this leg, oldest first: absent when there is none. */
  retries?: readonly RunLegRetry[];
  /** How much of this leg the chain shows paid, read on this device from the account (`runsPaidFromTheChain`); absent where that was not read. */
  paidOnChain?: PaidState;
  /** When the leg's payment window closes, in seconds, as the run records it for the leg. */
  closesAt?: bigint;
  /** What each person on the leg is paid in the token's smallest units, in the order of the leg's leaves (the wallet's `legEmployees`); absent where the leg lists other than the leaves it was raised over. */
  amounts?: readonly bigint[];
  /** The places in the leg's leaves, in that order, of the payments the chain does not show paid: what a retry names. Absent where the chain was not read. */
  unpaid?: readonly number[];
  /** The proposal raised for this leg, or null when none is recorded. */
  proposal: string | null;
  /** How the leg's payments are made, as the wallet names it; null for a leg keyed before a run paid one form, which the wallet cannot be asked to pay. */
  form: RunForm | null;
  /** Whom the run pays: the company's employees or its vendors. */
  list: RunList;
  /** How many of the run's people are on this leg, counted from the run's people as the wallet counts them (not the leaves recorded for it). */
  people: number;
  /** What the leg pays in all, in the token's smallest units. */
  total: bigint;
  /** Each person on the leg, their address as the run names it (null where it names none) and what they are paid. */
  pays: readonly RunLegPay[];
}

/** One attempt at a leg for some of its people, raised as a proposal of its own: paid like the leg once it is approved. */
interface RunLegRetry {
  /** The proposal this attempt was raised as; null while none is recorded. */
  proposal: string | null;
  vault: string;
  /** How many of the leg's people it pays, and what it pays them in all. */
  people: number;
  total: bigint;
  pays: readonly RunLegPay[];
  /** The leaves of those people on the leg, absent where the leg records fewer than it names. */
  leaves?: readonly string[];
  paidOnChain?: PaidState;
}

/** How much of what a leg, a retry or a run pays the chain shows paid: 2 all of it, 1 some of it, 0 none of it seen in the newest state the indexer holds. Numbers, so no screen mistakes one for a phrase. */
export const PAID_STATE = { all: 2, some: 1, none: 0 } as const;
type PaidState = (typeof PAID_STATE)[keyof typeof PAID_STATE];

/** One person's payment on a leg: what a public payment would put on the chain beside their address. */
interface RunLegPay { name: string; address: string | null; amount: TokenAmount | null }

/** A payroll run, as the runs list and its own page show it. */
export interface RunRow {
  id: string;
  /** The month it pays, as the service wrote it (`2026-10`). */
  period: string;
  /** How much of the run the chain shows paid, from its legs; absent where any leg's was not read. Nothing the service says of a run is carried: whether it was paid is the chain's alone. */
  paidOnChain?: PaidState;
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

export { VAULT, type VaultStanding } from 'vaults-web-shared/vault-standing.js';
const VAULT_STANDINGS: readonly string[] = Object.values(VAULT);

/**
 * A vault, as the vault tiles and its own page show it. `adopted` is set only on a vault the company's account adopted,
 * as the person's own wallet read the chain: the one kind of vault whose filed name is read and shown. `approvals` is the number
 * of approvals the vault's runs need as the chain holds it (the vault's own number where it has one, else the company's), and is
 * absent where the chain gave none.
 */
export interface VaultRow { vault: string; createdAt: string; standing: VaultStanding; adopted?: true; approvals?: number }

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
 * signer admits them; `notPayable` is why this device will not pay them, null when it will; `address` is where they are paid, as their entry holds
 * it, null while it holds none.
 */
export interface VendorRow {
  id: string;
  name: string;
  address: string | null;
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

/*
 * WHICH PRESSES A PROPOSAL OR A LEG IS OFFERED, from the records alone: what the records and the chain show of it. The wallet decides
 * again, with its words, before it signs anything.
 */
/** The wallet's name for a row's kind; a change of policy is named by the change its asks say it is. */
export const walletKindOf = (row: ProposalRow): string | undefined => {
  const policy = row.asks?.[KIND_FIELD];
  if (row.kind === 'change-policy') return typeof policy === 'string' && POLICY_KINDS.has(policy) ? policy : undefined;
  return WALLET_KIND[row.kind];
};

/**
 * The one rule for every kind: a waiting proposal of a kind the wallet knows, and, where its kind takes fields, the row carries them. The only kind that takes
 * none is the pay key's. A one-off payment the chain holds approved is offered too while the chain shows its payment not made (`paidOnChain` false), since
 * paying it does not close it: the same press, and the wallet, finding it at the bar, pays it without approving again. Never one shown paid or not read.
 */
export const canApprove = (row: ProposalRow): boolean =>
  (row.status === 'open' || (row.status === PROPOSAL_STANDING.approved && row.kind === 'transfer' && row.paidOnChain === false))
  && walletKindOf(row) !== undefined && (row.kind === 'pay-key' || Object.keys(row.asks ?? {}).some((k) => k !== KIND_FIELD));

/**
 * Whether Withdraw is offered on a proposal. A change to the company, and a one-off payment, only to the seat that filed
 * it while it waits: the filing this device believes is signed with the key of the seat this device holds
 * (`raisedByYou`), never matched by a name two signers may share. A payroll run to any seated signer while it waits,
 * approved or not, as the account lets any signer withdraw a run before its payment window opens. The page holds no
 * time from the chain to tell whether the window has opened, so it hides nothing the wallet would allow: the wallet
 * decides again, and refuses with its words.
 */
export function canWithdraw(row: ProposalRow): boolean {
  if (NEVER_WITHDRAWN.has(row.kind) || WALLET_KIND[row.kind] === undefined) return false;
  if (row.kind === 'payroll') return row.status === 'open' || row.status === 'approved';
  if (row.status !== 'open') return false;
  return row.raisedByYou === true && (row.raiserNotBelieved ?? null) === null;
}

/**
 * Whether Retry is offered on a leg of a run, as the wallet accepts one: the chain shows people of the leg not paid and the page can name
 * them in the order of the leg's leaves, the leg's proposal is known, and the leg can no longer pay them, because its window has closed
 * (by this device's clock; the wallet judges again by its own) or its proposal was stopped. A leg paid in full, or one the chain was
 * not read for, never. Whether the people are already on a retry that can still pay them is the wallet's to say.
 */
export function canRetry(
  leg: Pick<RunLeg, 'proposal' | 'form' | 'paidOnChain' | 'unpaid' | 'amounts' | 'leaves' | 'closesAt'>, proposals: Read<readonly ProposalRow[]>, nowMs: number,
): boolean {
  if (leg.proposal === null || leg.form === null || leg.paidOnChain === undefined || leg.paidOnChain === PAID_STATE.all) return false;
  if (leg.unpaid === undefined || leg.unpaid.length === 0 || leg.amounts === undefined || leg.amounts.length !== leg.leaves?.length || leg.closesAt === undefined) return false;
  const row = proposals.of === READ.read ? proposals.value.find((p) => p.id === leg.proposal) : undefined;
  return row !== undefined && (row.status === 'cancelled' || row.status === 'blocked' || row.status === 'expired'
    || row.status === 'closed' || BigInt(nowMs) >= leg.closesAt * 1000n);
}

/** A vendor a one-off payment can be made to from the vendor list: active, with an address in their entry, and nothing this device holds against paying them. */
interface PayableVendor { id: string; name: string; address: string }

/**
 * The vendors the payee select offers: those a signer could pay now. A vendor with no address, one who has left or not yet joined, and
 * one this device will not pay are left out, so choosing one never ends in the wallet's refusal for a reason the list already knew.
 */
export function payableVendors(vendors: readonly VendorRow[]): readonly PayableVendor[] {
  return vendors.flatMap((v) => (v.standing === STANDING.active && v.notPayable === null && v.address !== null ? [{ id: v.id, name: v.name, address: v.address }] : []));
}

/**
 * A single payment as the public-facts block reads a leg: one payee, paid privately or publicly by the address's own kind, the amount
 * in units of the currency. `null` when the address is not one the page can place as private or public, so no screen says what such a
 * payment makes public.
 */
export function oneOffLegOf(one: { vault: string; token: string; units: bigint; address: string; name: string }, registry: AssetRegistry = assets): RunLeg | null {
  const paid = paidTo(one.address);
  if (paid === PAID.notKnown) return null;
  return {
    code: one.token, asset: one.token, symbol: registry.find(one.token)?.symbol ?? null, paid, vault: one.vault, payees: 1, proposal: null,
    form: paid === PAID.privately ? RUN_FORM.shielded : RUN_FORM.unshielded, list: RUN_LIST.vendors, people: 1, total: one.units,
    pays: [{ name: one.name, address: one.address, amount: amountOf(one.units, one.token, paid, registry) }],
  };
}

/** A one-off payment waiting on a signer as a vault's page lists it: what it pays, to whom and why, with the approvals it has and needs, and the proposal row to approve or pay. */
export interface OneOffRow {
  id: string;
  amount: TokenAmount | null;
  /** The name it is shown under: the name it was raised with, else the address. */
  payee: string;
  /** The payment as the public-facts block reads it, `null` when the address is not one the page can place as private or public. */
  leg: RunLeg | null;
  reason: string;
  approvals: number;
  needed: number | null;
  proposal: ProposalRow;
}

/**
 * The one-off payments waiting on a signer from one vault: proposals of the transfer kind offered Approve (`canApprove`: held open, or
 * held approved with the chain showing them not paid), that carry what they pay (the wallet reads the record again before it approves anything), and whose vault is this one. A payee shows by the name it was
 * raised with, else by its address. The amount is made here, private or public by the address's own kind, null for a currency this app
 * does not know.
 */
export function openOneOffsOf(proposals: readonly ProposalRow[], vault: string, registry: AssetRegistry = assets): readonly OneOffRow[] {
  return proposals.flatMap((p) => {
    if (p.kind !== 'transfer' || !canApprove(p) || p.asks === undefined) return [];
    const { vault: from, token, amount, payee, payeeName, reason } = p.asks;
    if (typeof from !== 'string' || from.toLowerCase() !== vault.toLowerCase() || typeof payee !== 'string') return [];
    const units = typeof amount === 'bigint' ? amount : typeof amount === 'string' && /^[0-9]+$/u.test(amount) ? BigInt(amount) : null;
    return [{
      id: p.id, amount: units === null || typeof token !== 'string' ? null : amountOf(units, token, markOf(paidTo(payee)), registry),
      leg: units === null || typeof token !== 'string' ? null : oneOffLegOf({ vault: from, token, units, address: payee, name: typeof payeeName === 'string' ? payeeName : '' }, registry),
      payee: typeof payeeName === 'string' && payeeName !== '' ? payeeName : payee,
      reason: typeof reason === 'string' ? reason : '', approvals: p.approvals, needed: p.needed, proposal: p,
    }];
  });
}

/**
 * Whether Pay is offered on a leg of a run, or on a retry made into a leg (`legOfRetry`): only when the chain shows its
 * proposal approved and shows the leg not paid in full. A proposal the chain was not read for, a leg whose payments
 * the chain was not read for, and a leg with no proposal or no form the wallet knows are never offered. The wallet
 * decides again, on the window and on what the chain holds, before it pays.
 */
export function canPay(leg: Pick<RunLeg, 'proposal' | 'form' | 'paidOnChain'>, proposals: Read<readonly ProposalRow[]>): boolean {
  if (leg.proposal === null || leg.form === null || leg.paidOnChain === undefined || leg.paidOnChain === PAID_STATE.all) return false;
  return proposals.of === READ.read && proposals.value.some((p) => p.id === leg.proposal && p.status === 'approved');
}

/** A company's records, opened. */
export interface CompanyRecords {
  of: typeof OPENED.open;
  id: string;
  name: string;
  /** The epochs of the company's key this seat holds a copy of that the wallet has not released on this visit, so what is sealed under them shows as not opened yet; absent or empty when none. */
  notOpened?: readonly number[];
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
   * The proposals that invite a signer by address and still wait, from the proposals of `proposals` this device believes and
   * opened, each with where the chain holds it, its count on the chain, the seat the chain says it took and the roster's entry
   * waiting there; one whose seat the believed roster holds active is left out. Unreadable when that list is, or when none could
   * be opened.
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

/**
 * A run as this device reads it: the service's plain fields and its sealed ones, opened, the marker the record carries
 * kept. What a run seals (its people, totals, proposals, payout, skips, repeats and list) is read from the seal alone: the
 * same field served beside it is dropped, never used where the seal holds none.
 */
function openRun(rec: SealedRun, viewingKey: CompanyKeys): PayrollRun {
  const {
    sealed, keyEpoch, proposalIds: _flat, employees: _e, totals: _t, payout: _p, skips: _s, repeats: _r, list: _l, ...operational
  } = rec as SealedRun & Partial<Pick<PayrollRun, 'employees' | 'totals' | 'payout' | 'skips' | 'repeats' | 'list'>>;
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
    const form = paid === PAID.privately ? RUN_FORM.shielded : paid === PAID.publicly ? RUN_FORM.unshielded : null;
    /* The people on a leg are those the wallet counts for it: their token and form, a form not named being private. */
    const onLeg = form === null ? [] : (run.employees ?? []).filter((e) => e.asset === asset && (e.form === RUN_FORM.unshielded) === (form === RUN_FORM.unshielded));
    const leaves = (leg.leaves ?? []).map((l) => l.toLowerCase());
    const payForm = form === RUN_FORM.unshielded ? PAID.publicly : PAID.privately;
    const retries = (leg.retries ?? []).map((r): RunLegRetry => {
      const people = r.originalIndices.flatMap((i) => (onLeg[i] === undefined ? [] : [onLeg[i]!]));
      const theirs = r.originalIndices.flatMap((i) => (leaves[i] === undefined ? [] : [leaves[i]!]));
      return {
        proposal: r.proposalId ?? null, vault: r.vault, people: people.length, total: people.reduce((sum, e) => sum + e.amount, 0n),
        pays: people.map((e) => ({ name: e.name, address: e.paidTo ?? null, amount: amountOf(e.amount, e.asset, payForm, registry) })),
        ...(theirs.length === r.originalIndices.length ? { leaves: theirs } : {}),
      };
    });
    return {
      code, asset, symbol: registry.find(asset)?.symbol ?? null, paid, vault: leg.vault, payees: (leg.leaves ?? []).length,
      ...(leaves.length === 0 ? {} : { leaves }), ...(retries.length === 0 ? {} : { retries }),
      ...(leg.closesAt === undefined ? {} : { closesAt: BigInt(leg.closesAt) }),
      ...(leaves.length === 0 || onLeg.length !== leaves.length ? {} : { amounts: onLeg.map((e) => e.amount) }),
      proposal: run.proposalIds?.[code] ?? null, form, list: run.list ?? RUN_LIST.employees, people: onLeg.length,
      total: onLeg.reduce((sum, e) => sum + e.amount, 0n),
      pays: onLeg.map((e) => ({ name: e.name, address: e.paidTo ?? null, amount: amountOf(e.amount, e.asset, form === RUN_FORM.unshielded ? PAID.publicly : PAID.privately, registry) })),
    };
  });
  return { id: run.id, period: run.period, payees, currencies, legs, unrecognised };
}

/** What a run's round for the leg `leg` pays, as a screen names it. */
/** A retry on a leg, as a leg of its own for the same run: the same token and form, the retry's proposal, vault, people and total. */
export const legOfRetry = (leg: RunLeg, retry: RunLegRetry): RunLeg => {
  const { retries: _retries, leaves: _leaves, unpaid: _unpaid, amounts: _amounts, closesAt: _closesAt, ...same } = leg;
  return { ...same, vault: retry.vault, payees: retry.people, proposal: retry.proposal, people: retry.people, total: retry.total, pays: retry.pays, ...(retry.leaves === undefined ? {} : { leaves: retry.leaves }), ...(retry.paidOnChain === undefined ? {} : { paidOnChain: retry.paidOnChain }) };
};

/**
 * HOW MUCH OF SOME PAYMENTS THE CHAIN SHOWS PAID, from the answer to `paidLeaves`: all of them, none, or some. A leaf the
 * answer does not name, or no leaves at all, is not read, never "none". `none` is only "not seen in the newest state the
 * indexer holds".
 */
function paidStateOf(leaves: readonly string[] | undefined, paid: Readonly<Record<string, boolean>>): PaidState | undefined {
  if (leaves === undefined || leaves.length === 0 || leaves.some((l) => typeof paid[l] !== 'boolean')) return undefined;
  const seen = leaves.filter((l) => paid[l] === true).length;
  return seen === leaves.length ? PAID_STATE.all : seen === 0 ? PAID_STATE.none : PAID_STATE.some;
}

const allOf = (states: readonly (PaidState | undefined)[]): PaidState | undefined => {
  if (states.length === 0 || states.some((x) => x === undefined)) return undefined;
  return states.every((x) => x === PAID_STATE.all) ? PAID_STATE.all : states.every((x) => x === PAID_STATE.none) ? PAID_STATE.none : PAID_STATE.some;
};

/** The runs with what the chain shows paid of each leg, retry and run, from the answer to `paidLeaves`. Nothing a run's record or the service says of it is used. */
function runsPaidOnChain(runs: readonly RunRow[], paid: Readonly<Record<string, boolean>>): RunRow[] {
  return runs.map((run) => {
    const legs = run.legs.map((leg): RunLeg => {
      const retries = leg.retries?.map((r): RunLegRetry => ({ ...r, paidOnChain: paidStateOf(r.leaves, paid) }));
      const paidOnChain = paidStateOf(leg.leaves, paid);
      const unpaid = paidOnChain === undefined ? undefined : (leg.leaves ?? []).flatMap((l, i) => (paid[l] === true ? [] : [i]));
      return { ...leg, ...(retries === undefined ? {} : { retries }), paidOnChain, ...(unpaid === undefined ? {} : { unpaid }) };
    });
    return { ...run, legs, paidOnChain: allOf(legs.map((l) => l.paidOnChain)) };
  });
}

/**
 * **WHICH OF A COMPANY'S PAYMENTS THE CHAIN SHOWS PAID**, asked of this device's own worker, which reads the account's
 * newest state at the indexer the person's wallet names. When it cannot be read, the runs come back unread, never as
 * unpaid and never as paid.
 */
async function runsPaidFromTheChain(sealed: Pick<SealedAccount, 'companyLabel' | 'contractAddress'>, runs: readonly RunRow[]): Promise<RunRow[]> {
  const label = sealed.companyLabel ?? null;
  const address = sealed.contractAddress ?? null;
  const leaves = [...new Set(runs.flatMap((r) => r.legs.flatMap((l) => [...(l.leaves ?? []), ...(l.retries ?? []).flatMap((x) => x.leaves ?? [])])))];
  if (label === null || address === null || leaves.length === 0) return [...runs];
  try {
    const indexer = await walletIndexerFor(label as CompanyLabel, address as AccountAddress);
    if (indexer === null) return [...runs];
    return runsPaidOnChain(runs, await (await theVaultBuilder()).paidLeaves({ account: address, indexer, leaves }));
  } catch {
    return [...runs];
  }
}

/**
 * **WHETHER THE CHAIN SHOWS EACH APPROVED ONE-OFF PAYMENT PAID**, by the payment leaf the worker built from its record (`leaves`, by
 * proposal), through the same read as the runs'. A row whose leaf the answer does not name true or false, or a read that fails, is left
 * without `paidOnChain`: unread, never paid and never unpaid.
 */
async function oneOffsPaidFromTheChain(
  sealed: Pick<SealedAccount, 'companyLabel' | 'contractAddress'>, rows: readonly ProposalRow[], leaves: ReadonlyMap<string, string>,
): Promise<ProposalRow[]> {
  const label = sealed.companyLabel ?? null;
  const address = sealed.contractAddress ?? null;
  if (label === null || address === null || leaves.size === 0) return [...rows];
  try {
    const indexer = await walletIndexerFor(label as CompanyLabel, address as AccountAddress);
    if (indexer === null) return [...rows];
    const paid = await (await theVaultBuilder()).paidLeaves({ account: address, indexer, leaves: [...new Set(leaves.values())] });
    return rows.map((r) => {
      const leaf = leaves.get(r.id);
      const shown = leaf === undefined ? undefined : paid[leaf];
      return typeof shown === 'boolean' ? { ...r, paidOnChain: shown } : r;
    });
  } catch {
    return [...rows];
  }
}

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
  p: Proposal, standing: ProposalStanding, signers: readonly (SignerRow & { readonly signingPublicKey?: string })[], runs: readonly PayrollRun[],
  registry: AssetRegistry = assets, refused: readonly RefusedEntry[] = [],
): ProposalRow {
  const retryOf = (r: PayrollRun): string | undefined => Object.entries(r.payout ?? {}).find(([, l]) => (l.retries ?? []).some((x) => x.proposalId === p.id))?.[0];
  const run = runs.find((r) => Object.values(r.proposalIds ?? {}).includes(p.id) || retryOf(r) !== undefined);
  const filer = standing.filer === null ? undefined : signers.find((s) => typeof s.signingPublicKey === 'string' && s.signingPublicKey.toLowerCase() === standing.filer);
  /* A filer no believed entry holds the key of: the entry the record names for the raiser, if this device refused it, says why. */
  const notBelieved = filer !== undefined ? undefined : refused.find((r) => r.signerId === p.proposedBy);
  const leg = run === undefined ? undefined : Object.entries(run.proposalIds ?? {}).find(([, id]) => id === p.id)?.[0] ?? retryOf(run);
  return {
    id: p.id, kind: listedKindOf(p.kind), status: standing.shown,
    raisedBy: filer?.name ?? (notBelieved !== undefined && namedThoughNotBelieved(notBelieved.why) ? notBelieved.name : null),
    raiserNotBelieved: notBelieved?.why ?? null,
    approvals: standing.approvals,
    needed: standing.needed,
    raisedAt: standing.raisedAt,
    pays: run === undefined || leg === undefined ? null : paysOf(run, leg, registry),
  };
}

/** A proposal listed by its id alone: this device does not believe it, or cannot open it, so nothing is read from it. */
const unreadableRow = (id: string, raisedAt: string): ProposalRow => ({
  id, kind: UNREADABLE, status: UNREADABLE, raisedBy: null, raiserNotBelieved: null, approvals: 0, needed: null, raisedAt, pays: null,
});

/** A proposal opened and believed on this device, with where the chain holds it. */
interface ProposalHere { readonly rec: SealedProposal; readonly opened: Proposal; readonly status: ProposalStatus; readonly approvals: number }

/**
 * **THE COMPANY'S PROPOSALS AS THE CHAIN HOLDS THEM AND THIS DEVICE BELIEVES THEM**: the service's list, checked
 * against the company's records and read where each stands at the indexer the person's own wallet names
 * (`proposalsListedHere`, in the page's vault worker); then each one the company's records name, whose filing this
 * device believes (`believedFilerHere`) and whose record it opens, is a row, and every other one is listed as
 * unreadable by its id: one the records name that the service did not give (with no date, since nothing of it was
 * read; the rest are still checked and read without it), one the records name under an older key, one they do not
 * name, one whose filing does not check, one that does not open. Refused, so the proposals read as unreadable, when the company has no account on the
 * network, the wallet names no indexer, or the chain or the records cannot be read.
 */
async function proposalsHere(
  companyId: string, sealed: Pick<SealedAccount, 'companyLabel' | 'contractAddress'>, served: readonly SealedProposal[],
  directory: DirectoryRead | null, viewingKey: CompanyKeys,
): Promise<{ readonly believed: readonly (ProposalHere & { readonly standing: ProposalStanding })[]; readonly unreadable: readonly ProposalRow[] }> {
  const label = sealed.companyLabel ?? null;
  const address = sealed.contractAddress ?? null;
  if (label === null || address === null || directory === null) throw new Fault(FAULT.noAccountToReadProposalsFrom);
  const indexer = await walletIndexerFor(label as CompanyLabel, address as AccountAddress);
  if (indexer === null) throw new Fault(FAULT.noIndexerToReadProposalsAt);
  const [builder, { proposalsListedHere, closedAs, statusOfAClose }, { believedFilerHere }, { kindAsked, namedHere }, { recordKeyOf }] = await Promise.all([
    theVaultBuilder(), import('vaults-web-shared/run-rebuilt-here.js'), import('vaults-web-shared/round-opened-here.js'),
    import('vaults-web-shared/vault-page-doors.js'), import('../../../../src/midnight/record-manifest.js'),
  ]);
  const named = new Set(namedHere(await directory(kindAsked(SERVICE.proposalKind)), SERVICE.proposalKind, SERVICE.proposalKind));
  const given = new Set(served.map((p) => p.id));
  /* Each proposal the company's records name and the service did not give: listed unreadable, and the rest still read. */
  const withheld = [...named].filter((id) => !given.has(id));
  const withheldKeys = new Set(withheld.map((id) => recordKeyOf({ store: SERVICE.proposalKind, kind: SERVICE.proposalKind, id })));
  const withoutWithheld: DirectoryRead = withheld.length === 0 ? directory : async (asked) => {
    const here = await directory(asked);
    return {
      ...here,
      records: {
        ...here.records,
        history: new Map([...here.records.history].filter(([key]) => !withheldKeys.has(key))),
        notYetAnchored: here.records.notYetAnchored.filter((e) => !withheldKeys.has(recordKeyOf(e))),
      },
    };
  };
  let onChain: Readonly<Record<string, RoundOnChain>> = {};
  const listed = await proposalsListedHere({
    directory: withoutWithheld,
    roundsOnChain: async (chainIds) => { onChain = await builder.roundsOnChain({ account: address, indexer, chainIds }); return onChain; },
    proposals: async () => served,
  });
  const unreadable: ProposalRow[] = [
    ...withheld.map((id) => unreadableRow(id, '')), ...[...listed.setAside].map((rec) => unreadableRow(rec.id, rec.createdAt)),
  ];
  const believed: (ProposalHere & { readonly standing: ProposalStanding })[] = [];
  for (const rec of listed) {
    if (!named.has(rec.id)) { unreadable.push(unreadableRow(rec.id, rec.createdAt)); continue; }
    let opened: Proposal;
    let filer: string | null;
    try {
      filer = await believedFilerHere({ directory }, companyId, rec);
      opened = openProposal(rec, viewingKey);
    } catch {
      unreadable.push(unreadableRow(rec.id, rec.createdAt));
      continue;
    }
    const r = onChain[rec.chainId.toLowerCase()];
    /* Where it stands and its count are the chain's round, read above; nothing of either is taken from the service's list. */
    const closing: ClosingRead = { closedAs, statusOfAClose };
    const status = statusOnChain(rec.status, r, closing);
    const standing: ProposalStanding = {
      status, shown: shownStatus(status, r, closing), approvals: r?.approvals ?? 0, needed: r?.needed ?? null,
      raisedAt: rec.raisedAt ?? rec.createdAt, filer, raised: r !== undefined && r.held !== 'never',
      outrun: r !== undefined && r.held !== 'closed' && r.outrun === true,
    };
    believed.push({ rec, opened, status: standing.status, approvals: standing.approvals, standing });
  }
  return { believed, unreadable };
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

/** What the chain holds of the approvals: the company's, and the vaults that have a number of their own. */
interface VaultNumbers { readonly company: number | null; readonly own: readonly { readonly vault: string; readonly threshold: number }[] }

const wholeApprovals = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;

/** The approvals a vault's runs need: its own number where the chain gives it one, else the company's; null where that is not a whole number of one or more. */
const approvalsOfVault = (numbers: VaultNumbers, vault: string): number | null => {
  const own = numbers.own.find((v) => v.vault.toLowerCase() === vault.toLowerCase());
  const n = own === undefined ? numbers.company : own.threshold;
  return wholeApprovals(n) ? n : null;
};

/**
 * **THE COMPANY'S VAULTS ARE THE VAULTS ITS ACCOUNT HAS ADOPTED, AS THE
 * PERSON'S OWN WALLET READ THEM OFF THE CHAIN.** The service's list only
 * says when each was made and where its set-up stands. A vault the account
 * adopted that the service's list leaves out makes the whole list unreadable,
 * so a list cut short is noticed rather than shown short; a vault the service
 * lists that the account has not adopted is shown only as a set-up not
 * finished, never as one of the company's vaults. Each row of a vault the
 * account adopted says so, so a screen reads a name only for those, and carries the approvals that vault's runs need where the
 * chain gave them (a vault not yet adopted has none).
 */
export const vaultsAsTheChainHoldsThem = (
  served: readonly ServedVault[], adopted: readonly string[], numbers?: VaultNumbers,
): Read<readonly VaultRow[]> => {
  const held = new Set(adopted.map((v) => v.toLowerCase()));
  const listed = new Set(served.map((r) => r.vault.toLowerCase()));
  if ([...held].some((v) => !listed.has(v))) return { of: READ.unreadable };
  return {
    of: READ.read,
    value: served.filter((r) => held.has(r.vault.toLowerCase()) || NOT_YET_ADOPTED.has(r.state)).map((r) => {
      const approvals = numbers === undefined || !held.has(r.vault.toLowerCase()) ? null : approvalsOfVault(numbers, r.vault);
      return { ...vaultRow(r, held.has(r.vault.toLowerCase())), ...(approvals === null ? {} : { approvals }) };
    }),
  };
};

/**
 * The seat each add-signer proposal took, as the chain says through the person's own indexer, by the proposal's identity on
 * the chain, read once for the page. Only an identity of thirty-two bytes is asked about: the read is one ask for every
 * proposal, and a record naming any other identity must not fail it for the rest. Unreadable when the company names no
 * account or the read is not made or refused (`seatsTakenAsked`): a seat not read is never shown as no seat taken.
 */
const seatsTakenOnChain = async (
  companyId: string, sealed: Pick<SealedAccount, 'companyLabel' | 'contractAddress'>, served: readonly { readonly rec: SealedProposal; readonly opened: Proposal }[],
): Promise<Read<Readonly<Record<string, string | null>>>> => {
  const ids = [...new Set(served.filter(({ opened }) => opened.kind === 'add-signer').flatMap(({ rec }) => (typeof rec.chainId === 'string' ? [rec.chainId.toLowerCase()] : []))
    .filter((id) => /^[0-9a-f]{64}$/u.test(id)))];
  if (ids.length === 0) return { of: READ.read, value: {} };
  if (sealed.companyLabel == null || sealed.contractAddress == null) return { of: READ.unreadable };
  const { invitedSeats } = rosterReadsFor(companyId, sealed.companyLabel as CompanyLabel, sealed.contractAddress as AccountAddress);
  return alone(() => seatsTakenAsked(invitedSeats, ids));
};

/**
 * WHAT THE PERSON'S OWN WALLET READS OF THE COMPANY'S ACCOUNT IN ONE ASK, with the service's list of its vaults: the
 * vaults the account has adopted, each with the service's row for it, and how many signers must approve. The approvals
 * are the answer's `approvals`, never its `threshold`, which is the account's maintenance committee's. Each is
 * unreadable when the company names no account yet or the read it rests on fails; the approvals do not wait on the
 * service's list, and the vaults do not rest on a wallet answer that carries no approvals.
 */
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
    ? vaultsAsTheChainHoldsThem(answer.rows as ServedVault[], wallet.holders.adoptedVaults, { company: approvals.of === READ.read ? approvals.value : null, own: wallet.holders.vaultThresholds ?? [] })
    : { of: READ.unreadable };
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
    id: v.id, name: v.name, address: v.address?.bech32 ?? null, standing: standingOfRecord(v.status, h.handedOver),
    handedOver: h.handedOver === true, termsKind: v.terms.kind,
    asset: v.terms.kind === 'monthly' ? v.terms.asset : null,
    monthly: v.terms.kind === 'monthly' ? amountOf(v.terms.amount, v.terms.asset, markOf(paid), registry) : null,
    paid, startedAt: v.startDate, endDate: v.endDate ?? null, admittedAt: v.admittedAt,
    admitBy: admitByOf(v.invitedAddress),
    notPayable,
  };
}

/**
 * The one-off payment named `id`, as this device believes its record: fetched by its name alone, judged against the
 * company's records and opened with the company's key here; null when it is not given, not believed or does not open.
 */
async function oneOffHereFor(
  companyId: string, sealed: Pick<SealedAccount, 'companyLabel' | 'contractAddress'>, account: Account,
  viewingKey: CompanyKeys, directory: DirectoryRead | null, id: string,
): Promise<OneOffHere | null> {
  const label = sealed.companyLabel ?? null;
  const address = sealed.contractAddress ?? null;
  if (label === null || address === null || directory === null) return null;
  try {
    const send: WireSend = async (path) => ({ status: 200, body: await api(path) });
    const store = new HttpCompanyRecordStore(companyId, send, null, filingJudgeFor(companyId, label as CompanyLabel, address as AccountAddress, viewingKey, async () => account));
    /* Opened in the page's vault worker, where the payee's address is decoded: the page itself loads no address decoder. */
    const { openOneOff } = await theVaultBuilder();
    if (openOneOff === undefined) return null;
    const read = await oneOffHere({ accountId: companyId, directory, records: { at: (kind, at, version) => store.at(kind, at, version) }, keys: viewingKey, open: openOneOff }, id);
    return read.state === 'read' ? read : null;
  } catch {
    return null;
  }
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
  let account: Account & { readonly refused?: readonly RefusedEntry[]; readonly waited?: readonly string[] };
  let viewingKey: CompanyKeys & { readonly notOpened?: readonly number[] };
  let ownSeat: { readonly signerId: string; readonly signingPublicKey: string };
  try {
    if (!(await keyringFor(personId))) return { of: OPENED.refused, why: ACT_REFUSAL.notSignedIn };
    sealed = await ask(SERVICE.company + companyId) as SealedAccount;
    /* Keys saved in another tab since are read first, so a person who opened them there is not asked again here. */
    const keys = await keysOnTheWayIn(companyId);
    if (keys === null) return { of: canOpenCompanies(companyId) ? OPENED.noKeysHere : OPENED.locked };
    const opened = await openedQuietly(sealed);
    if (opened === null) return { of: OPENED.noKeysHere };
    account = opened;
    viewingKey = await companyKeysQuietlyFor(companyId, sealed, { signingPublicKey: keys.signingPublicKey });
    ownSeat = { signerId: keys.signerId, signingPublicKey: keys.signingPublicKey };
  } catch (e) {
    return { of: OPENED.refused, why: refusalOf(e) };
  }
  const signers: SignerRow[] = account.signers.map((s) => ({ id: s.id, name: s.name }));
  const route = (r: string): string => SERVICE.company + companyId + r;
  const opened = alone(async () => (await ask(route(SERVICE.runs)) as SealedRun[]).map((r) => openRun(r, viewingKey)));
  /* Each run is made into its row inside the read, so a run that cannot be made fails the runs alone. */
  const runs = opened.then((read) => (read.of === READ.read
    ? alone(async () => runsPaidFromTheChain(sealed, read.value.map((r) => runRow(r)).sort((a, b) => b.period.localeCompare(a.period))))
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
  /* Each invitation is opened once, whether for what its row asks the wallet to check or for the signers it invites. */
  const byAddressOpened = new Map<string, AddSignerByAddress | null>();
  const byAddress = (rec: SealedProposal): AddSignerByAddress | null => {
    if (!byAddressOpened.has(rec.id)) byAddressOpened.set(rec.id, addSignerByAddressIn(rec, companyId, viewingKey));
    return byAddressOpened.get(rec.id)!;
  };
  const reads: AsksReads = { byAddress, oneOff: (id) => oneOffHereFor(companyId, sealed, account, viewingKey, reader?.directory ?? null, id) };
  const ownKey = ownSeat.signingPublicKey.toLowerCase();
  const [rows, proposalsRead, peopleHere, chain, invitations, vendorsHere] = await Promise.all([
    runs,
    alone(async () => {
      const read = await opened;
      const served = await ask(route(SERVICE.proposals)) as SealedProposal[];
      const here = await proposalsHere(companyId, sealed, served, reader?.directory ?? null, viewingKey);
      const runsRead = read.of === READ.read ? read.value : [];
      const oneOffLeaves = new Map<string, string>();
      const believedRows = await Promise.all(here.believed.map(async (p): Promise<ProposalRow> => {
        const row: ProposalRow = {
          ...proposalRow(p.opened, p.standing, account.signers, runsRead, assets, account.refused ?? []),
          raisedByYou: p.standing.filer !== null && p.standing.filer === ownKey,
        };
        const approvedOneOff = p.standing.status === PROPOSAL_STANDING.approved && row.kind === 'transfer';
        if (p.standing.status !== PROPOSAL_STANDING.open && !approvedOneOff) return row;
        const got = await proposalAsksHere(p, viewingKey, runsRead, reads).catch((): Asked => NOT_READ);
        if (got === null) return row;
        if (got.unread !== null) return { ...row, asksUnread: got.unread };
        if (approvedOneOff && got.leaf !== undefined) oneOffLeaves.set(row.id, got.leaf);
        /* The chain has never held it, so there is nothing on the chain to approve yet. */
        return p.standing.raised ? { ...row, asks: got.asks } : { ...row, asksUnread: ASKS_UNREAD.notRaised };
      }));
      return { rows: [...await oneOffsPaidFromTheChain(sealed, believedRows, oneOffLeaves), ...here.unreadable], served: here.believed };
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
  const taken = proposalsRead.of === READ.read ? await seatsTakenOnChain(companyId, sealed, proposalsRead.value.served) : { of: READ.read, value: {} } as const;
  const standings: Read<readonly SignerStanding[]> = chain.holders.of !== READ.read ? chain.holders : taken.of !== READ.read ? taken
    : { of: READ.read, value: signerStandings(account.signers, chain.holders.value.seats, {
      own: ownSeat, entries, waited: account.waited ?? [], shown: Object.values(taken.value).flatMap((x) => (x === null ? [] : [x])),
    }) };
  const forSigners: Read<SignersApprovals> = chain.holders.of === READ.read ? approvalsForSigners(chain.holders.value) : chain.holders;
  const signersInvited: Read<readonly SignerInvited[]> = proposalsRead.of !== READ.read ? proposalsRead : taken.of !== READ.read ? taken
    : await alone(async () => signersInvitedIn(proposalsRead.value.served, byAddress, {
      taken: taken.value,
      waiting: account.signers.filter((s) => s.status === 'pending'), seated: account.signers.filter((s) => s.status === 'active'),
    }));
  return {
    of: OPENED.open, id: companyId, name: account.name, notOpened: viewingKey.notOpened ?? [], signers, approvalsNeeded: chain.approvals,
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
    const account = await openedQuietly(sealed);
    if (account === null) return notRead;
    const companyKeys: CompanyKeys = await companyKeysQuietlyFor(companyId, sealed, { signingPublicKey: keys.signingPublicKey });
    const judge = filingJudgeFor(companyId, label as CompanyLabel, address as AccountAddress, companyKeys, async () => account);
    const { vaultInfoHere, vaultInfoRecordsFor } = await import('vaults-web-shared/vault-info-here.js');
    const filed = await vaultInfoHere({ companyKeys, records: vaultInfoRecordsFor(companyId, null, judge, () => currentUser()?.id ?? null) }, vault);
    if (filed.state === 'unread') return notRead;
    return filed.state === 'named' && filed.name.trim() !== '' ? filed.name : null;
  } catch {
    return notRead;
  }
}
