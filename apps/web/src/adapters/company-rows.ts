/*
 * THE ROWS A COMPANY'S RECORDS ARE READ INTO: the run, proposal, person and vault rows the screens show, the words of
 * the service's answers they are read with, and how a payment and a person stand. Read by the company's read and by
 * the reads of its proposals and vaults; none of them is a read itself.
 */
import type { TokenAmount } from 'vaults-ui';
import type { EmployeeClassification } from '../../../../src/core/invitation.js';
import type { ProposalKind, ProposalStatus } from '../../../../src/core/types.js';
import type { RosterEntryRefusal } from '../../../../src/core/roster-record.js';
import type { RunForm, RunList } from 'vaults-web-shared/proposal-in-the-wallet.js';
import type { VaultStanding } from 'vaults-web-shared/vault-standing.js';
import type { ClosedAs } from 'vaults-web-shared/run-rebuilt-here.js';
import { ASKS_UNREAD, type AsksUnread, type ProposalAsks } from 'vaults-web-shared/proposal-asks-here.js';

/** The purposes the service's records are sealed for, and the words of its answers: compared, never shown. */
export const SERVICE = {
  proposalsRecord: 'proposals',
  runsRecord: 'payroll',
  proposalKind: 'proposal',
  active: 'active',
  pending: 'pending',
  leaver: 'leaver',
  shielded: 'shielded',
  unshielded: 'unshielded'
} as const;

/** How a payment is made, read from the address it goes to. */
export const PAID = {
  privately: 'privately',
  publicly: 'publicly',
  notSetUp: 'not-set-up',
  notKnown: 'not-known'
} as const;
export type Paid = (typeof PAID)[keyof typeof PAID];

/** A signer of the company, as its own record names them. */
export interface SignerRow {
  id: string;
  name: string;
}

/** What a proposal this device does not believe, or cannot open, is listed as: by its id alone, with nothing read from it. */
export const UNREADABLE = 'unreadable' as const;

/** A proposal, as the proposals list shows it. */
export interface ProposalRow {
  id: string;
  /**
   * What it does, by the kind its record is sealed as; `unreadable` for a proposal this device does not believe or cannot
   * open.
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
export interface RunPays {
  run: string;
  period: string;
  asset: string;
  symbol: string | null;
  paid: Paid;
}

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
export interface RunPayee {
  id: string;
  name: string;
  amount: TokenAmount | null;
  paid: Paid;
}

/**
 * A leg of a run, paid in one token, in one form, from one vault. `code` is
 * the leg as the record keys it and `asset` its token, both compared and never
 * shown; `symbol` is what a person is shown, null for a token the registry
 * does not name.
 */
export interface RunLeg {
  code: string;
  asset: string;
  symbol: string | null;
  paid: Paid;
  vault: string;
  payees: number;
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
export interface RunLegRetry {
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
export type PaidState = (typeof PAID_STATE)[keyof typeof PAID_STATE];

/** One person's payment on a leg: what a public payment would put on the chain beside their address. */
interface RunLegPay {
  name: string;
  address: string | null;
  amount: TokenAmount | null;
}

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
export const STANDING = {
  invited: 'invited',
  waitingForCheck: 'waiting-for-check',
  active: 'active',
  leaver: 'leaver'
} as const;
export type PersonStanding = (typeof STANDING)[keyof typeof STANDING];

/** How a person is admitted: on the fingerprint they read out (added by link or at a private address), or on their wallet's signed claim of the public address they were added at, with nothing read out. */
export const ADMIT_BY = { fingerprint: 'fingerprint', claim: 'claim' } as const;
export type AdmitBy = (typeof ADMIT_BY)[keyof typeof ADMIT_BY];

/** One line of a person's salary history: what they are paid each run from a calendar day, and when a seat's device made the line (null on a line from before the history was kept). */
interface PersonPayLine {
  amount: TokenAmount | null;
  from: string;
  madeAt: string | null;
}

/** One line of a person's classification history, kept the way a pay line is. */
interface PersonClassificationLine {
  classification: EmployeeClassification;
  from: string;
  madeAt: string | null;
}

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

/**
 * A vault, as the vault tiles and its own page show it. `adopted` is set only on a vault the company's account adopted,
 * as the person's own wallet read the chain: the one kind of vault whose filed name is read and shown. `approvals` is the number
 * of approvals the vault's runs need as the chain holds it (the vault's own number where it has one, else the company's), and is
 * absent where the chain gave none.
 */
export interface VaultRow {
  vault: string;
  createdAt: string;
  standing: VaultStanding;
  adopted?: true;
  approvals?: number;
  retired?: true;
}
