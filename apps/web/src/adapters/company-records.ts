import { privateAmount, publicAmount, type TokenAmount } from 'vaults-ui';
import { reviveBigints } from '../../../../src/core/crypto.js';
import { assets, type AssetRegistry } from '../../../../src/core/assets.js';
import { classificationOn, payLineOn, payLinesOf } from '../../../../src/core/person-record.js';
import { typedAddressIsShielded } from 'midnight-identity/profile/address-claim';
import type { Account, PayrollRun, Proposal, RosterEmployee, SealedAccount, SealedProposal, SealedRun } from '../../../../src/core/types.js';
import { ROSTER_ID, type RefusedEntry, type RosterEntryRefusal } from '../../../../src/core/roster-record.js';
import { canOpenCompanies, openKeysWithWallet } from 'vaults-web-shared/keyring.js';
import { companyKeysQuietlyFor, directoryHereFor, openedQuietly, sealedIn, type PageView } from './filing-judge.js';
import { KIND_FIELD, NEVER_WITHDRAWN, RUN_FORM, RUN_LIST, WALLET_KIND } from 'vaults-web-shared/proposal-in-the-wallet.js';
import { PROPOSAL_STANDING, type ProposalStanding } from './proposal-standing-on-chain.js';
import type { CompanyKeys } from '../../../../src/core/company-key.js';
import { theVaultBuilder } from './vault-builder.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { paidPublicly } from 'vaults-web-shared/public-payment.js';
import { keyringFor, keysOnTheWayIn } from './keyring-person.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { ACTED, ACT_REFUSAL, refusalOf, type ActRefusal } from './refusals.js';
import { alone, OPENED, READ, type Read } from './reads.js';
import { LIST, PROVEN } from './view-asks.js';
import { Fault, FAULT } from '../faults.js';
import { readPeopleHere, type PeopleReader } from 'vaults-web-shared/people-read-here.js';
import { readVendorsHere, type VendorHere } from 'vaults-web-shared/vendors-read-here.js';
import { openRun } from './runs-and-proposals-opened.js';
import { NETWORK } from 'midnight-identity/network';
import type { NetworkName } from '../../../../src/midnight/network.js';
import { addSignerByAddressIn, type AddSignerByAddress } from '../../../../src/core/proposal-filing.js';
import { ASKS_UNREAD, NOT_READ, proposalAsksHere, type Asked, type AsksReads } from 'vaults-web-shared/proposal-asks-here.js';
import { approvalsForSigners, signerStandings, signersInvitedIn, type SignerInvited, type SignerStanding, type SignersApprovals } from './signers.js';
import { chainOfTheCompany } from './company-vaults-read.js';
import { chainReadIn, oneOffHereFor, oneOffsPaidFromTheChain, proposalsHere, runsPaidFromTheChain, seatsTakenOnChain } from './company-proposals.js';

export { OPENED, READ, type Read };

/*
 * A COMPANY'S RECORDS, OPENED ON THIS DEVICE WITH THE PERSON'S SAVED KEYS, AND
 * READ FOR THE PAGES THAT ONLY READ.
 *
 * The service stores a company's name, signers, runs and proposals sealed. This file opens them on the device: the
 * person's wallet reads the keys saved for them and opens this seat's copy of each company's viewing key
 * (`openKeysWithWallet`, after the person approves in their account); this page derives the company's keys from its
 * directory (`companyKeysQuietlyFor`), opens the company's record (`openedQuietly`), and opens each run, proposal and person with
 * the key it holds for that record's purpose, of the epoch it was sealed at (`openRun`, `openProposal`, `readPeopleHere`). Nothing here decides who may read what:
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

import { SERVICE, PAID, PAID_STATE, STANDING, ADMIT_BY, type Paid, type SignerRow, type ProposalRow, type RunPays, type RunCurrency, type RunPayee, type RunLeg, type RunLegRetry, type RunRow, type PersonStanding, type AdmitBy, type PersonRow, type VaultRow } from './company-rows.js';

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
/** The wallet's name for a row's kind, read off the wallet's one list of kinds; none for a kind the wallet does not act on. */
export const walletKindOf = (row: ProposalRow): string | undefined => WALLET_KIND[row.kind];

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

/** One of the company's lists as its view read it, with its whole numbers read back as whole numbers (`reviveBigints`). */
const listed = async (view: PageView, kind: Parameters<PageView['list']>[0]): Promise<unknown> => reviveBigints(await view.list(kind));

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
export function proposalRow(
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
    id: p.id, kind: p.kind, status: standing.shown,
    raisedBy: filer?.name ?? (notBelieved !== undefined && namedThoughNotBelieved(notBelieved.why) ? notBelieved.name : null),
    raiserNotBelieved: notBelieved?.why ?? null,
    approvals: standing.approvals,
    needed: standing.needed,
    raisedAt: standing.raisedAt,
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









/** The name of the ask a retire's record carries the vault it retired under, read by the code and never shown. */
const RETIRE_ASKS = 'vault';

/** The vault a carried-out retire in the company's records retired, in lower case; null for any other record. */
export const retiredBy = (p: ProposalRow): string | null => {
  const vault = p.asks?.[RETIRE_ASKS];
  return p.kind === 'retire-vault' && p.status === 'executed' && typeof vault === 'string' ? vault.toLowerCase() : null;
};

/**
 * The vaults the company retired, as its own records this device opened and believed say: each named by a retire the
 * records hold carried out. Only these, of the vaults the account no longer holds, are listed, so a vault the service
 * calls the company's that the company never retired is still never shown.
 */
const retiredInTheRecords = (proposals: Read<readonly ProposalRow[]>): ReadonlySet<string> => new Set(proposals.of !== READ.read ? []
  : proposals.value.flatMap((p) => { const vault = retiredBy(p); return vault === null ? [] : [vault]; }));




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
 * What reading a company proves of its records, named before the first read so one read of what its anchor holds
 * proves all of it: the read grants, the roster, and every person, vendor and proposal.
 */
const READ_BY_EVERY_PAGE = {
  records: [{ store: PROVEN.company, kind: PROVEN.roster, id: ROSTER_ID }],
  kinds: [
    { store: PROVEN.company, kind: PROVEN.grants }, { store: PROVEN.company, kind: PROVEN.person }, { store: PROVEN.company, kind: PROVEN.vendor },
    { store: SERVICE.proposalKind, kind: SERVICE.proposalKind },
  ],
} as const;

/**
 * THE RECORDS OF THE COMPANY `view` READS, FOR THE PERSON `personId`: opened with
 * what their wallet read from the keys saved for them, then read through the
 * view, each read on its own. Reading signs,
 * files and anchors nothing: the company's records are anchored at the end of
 * each seat action in a signer's wallet.
 */
export async function readCompany(personId: string, view: PageView): Promise<Company> {
  view.declare(READ_BY_EVERY_PAGE);
  const opened = await openedForTheRead(personId, view);
  return openedHere(opened) ? companyReadFrom(view, opened) : opened;
}

/** Whether the read opened the company, rather than saying why it did not: only an opening carries this seat. */
const openedHere = (o: OpenedForTheRead | Company): o is OpenedForTheRead => (o as Partial<OpenedForTheRead>).ownSeat !== undefined;

/** What reading a company opens first, with the person's keys: its record, its roster as this device believes it, its keys and this seat. */
interface OpenedForTheRead {
  readonly sealed: SealedAccount;
  readonly account: Account & { readonly refused?: readonly RefusedEntry[]; readonly waited?: readonly string[] };
  readonly viewingKey: CompanyKeys & { readonly notOpened?: readonly number[] };
  readonly ownSeat: { readonly signerId: string; readonly signingPublicKey: string };
}

/** The company opened for the read through `view`, or why it did not open. */
async function openedForTheRead(personId: string, view: PageView): Promise<OpenedForTheRead | Company> {
  const companyId = view.company;
  try {
    if (!(await keyringFor(personId))) return { of: OPENED.refused, why: ACT_REFUSAL.notSignedIn };
    const sealed = reviveBigints(await sealedIn(view)) as SealedAccount;
    /* Keys saved in another tab since are read first, so a person who opened them there is not asked again here. */
    const keys = await keysOnTheWayIn(companyId);
    if (keys === null) return { of: canOpenCompanies(companyId) ? OPENED.noKeysHere : OPENED.locked };
    const account = await openedQuietly(view, sealed);
    if (account === null) return { of: OPENED.noKeysHere };
    const viewingKey = await companyKeysQuietlyFor(view, sealed, { signingPublicKey: keys.signingPublicKey });
    return { sealed, account, viewingKey, ownSeat: { signerId: keys.signerId, signingPublicKey: keys.signingPublicKey } };
  } catch (e) {
    return { of: OPENED.refused, why: refusalOf(e) };
  }
}

/**
 * How the people and vendors are read for the company opened (`readPeopleHere`), through `view`; `found` is given the
 * seats the company's directory holds an entry for, as that read's own directory read found them. Null for a company
 * with no account on the chain.
 */
function peopleReaderOf(view: PageView, { sealed, account, viewingKey }: OpenedForTheRead, found: { entries: ReadonlySet<string> | null }): PeopleReader | null {
  const companyId = view.company;
  const label = sealed.companyLabel ?? null;
  const address = sealed.contractAddress ?? null;
  if (label === null || address === null) return null;
  const directory = directoryHereFor(view, label as CompanyLabel, address as AccountAddress, viewingKey, async () => account);
  return {
    company: { id: companyId, label: label as CompanyLabel, viewingKey },
    view,
    directory: async (asked) => {
      const here = await directory(asked);
      const seats = (here as { dir?: { seats?: unknown } } | null)?.dir?.seats;
      if (found.entries === null && Array.isArray(seats)) {
        found.entries = new Set(seats.flatMap((x) => { const seat = (x as { seat?: unknown } | null)?.seat; return typeof seat === 'string' ? [seat.toLowerCase()] : []; }));
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
}

/** What the proposals read is given beside the company opened: the runs opened, where the chain is read, the people's reader, the asks' reads and this seat's key. */
interface ProposalsReadWith {
  readonly opened: Promise<Read<PayrollRun[]>>;
  readonly paidAt: ReturnType<typeof chainReadIn>;
  readonly reader: PeopleReader | null;
  readonly reads: AsksReads;
  readonly ownKey: string;
}

/** The company's proposals as their rows, with each believed proposal's filing for the signers it invites. */
async function proposalsReadOf(view: PageView, { sealed, account, viewingKey }: OpenedForTheRead, { opened, paidAt, reader, reads, ownKey }: ProposalsReadWith) {
  const read = await opened;
  const served = await listed(view, LIST.proposals) as SealedProposal[];
  const here = await proposalsHere(paidAt, sealed, served, reader?.directory ?? null, viewingKey);
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
  return { rows: [...await oneOffsPaidFromTheChain(paidAt, sealed, believedRows, oneOffLeaves), ...here.unreadable], served: here.believed };
}

/** The people and vendors as the screens show them, from what their reads found. */
function peopleAndVendorsShown(
  peopleHere: Read<Awaited<ReturnType<typeof readPeopleHere>>>, vendorsHere: Read<Awaited<ReturnType<typeof readVendorsHere>>>,
) {
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
  return { people, peopleBelief, vendors, vendorsBelief };
}

/** The company read through `view` once it opened (`openedForTheRead`): its runs, proposals, people, vendors, vaults, invitations and signers. */
async function companyReadFrom(view: PageView, o: OpenedForTheRead): Promise<Company> {
  const companyId = view.company;
  const { sealed, account, viewingKey, ownSeat } = o;
  const signers: SignerRow[] = account.signers.map((s) => ({ id: s.id, name: s.name }));
  const paidAt = chainReadIn(view);
  const opened = alone(async () => (await listed(view, LIST.runs) as SealedRun[]).map((r) => openRun(r, viewingKey)));
  /* Each run is made into its row inside the read, so a run that cannot be made fails the runs alone. */
  const runs = opened.then((read) => (read.of === READ.read
    ? alone(async () => runsPaidFromTheChain(paidAt, sealed, read.value.map((r) => runRow(r)).sort((a, b) => b.period.localeCompare(a.period))))
    : read));
  /* The seats the company's directory holds an entry for, as the people read's own directory read found them: no read more. */
  const found: { entries: ReadonlySet<string> | null } = { entries: null };
  const reader = peopleReaderOf(view, o, found);
  const peopleRead: Promise<Read<Awaited<ReturnType<typeof readPeopleHere>>>> = reader === null
    ? Promise.resolve({ of: READ.unreadable }) : alone(async () => readPeopleHere(reader));
  /* Each invitation is opened once, whether for what its row asks the wallet to check or for the signers it invites. */
  const byAddressOpened = new Map<string, AddSignerByAddress | null>();
  const byAddress = (rec: SealedProposal): AddSignerByAddress | null => {
    if (!byAddressOpened.has(rec.id)) byAddressOpened.set(rec.id, addSignerByAddressIn(rec, companyId, viewingKey));
    return byAddressOpened.get(rec.id)!;
  };
  const reads: AsksReads = { byAddress, oneOff: (id) => oneOffHereFor(view, sealed, account, viewingKey, reader?.directory ?? null, id) };
  const ownKey = ownSeat.signingPublicKey.toLowerCase();
  const [rows, proposalsRead, peopleHere, chain, invitations, vendorsHere] = await Promise.all([
    runs,
    alone(() => proposalsReadOf(view, o, { opened, paidAt, reader, reads, ownKey })),
    peopleRead,
    chainOfTheCompany(view, sealed),
    alone(async () => invitationRows(await listed(view, LIST.invites) as InviteRow[], Date.now())),
    reader === null ? Promise.resolve({ of: READ.unreadable } as const) : alone(async () => readVendorsHere(reader, undefined, { handedOver: true })),
  ]);
  const proposals: Read<readonly ProposalRow[]> = proposalsRead.of === READ.read ? { of: READ.read, value: proposalsRead.value.rows } : proposalsRead;
  const { people, peopleBelief, vendors, vendorsBelief } = peopleAndVendorsShown(peopleHere, vendorsHere);
  const taken = proposalsRead.of === READ.read ? await seatsTakenOnChain(view, sealed, proposalsRead.value.served) : { of: READ.read, value: {} } as const;
  const standings: Read<readonly SignerStanding[]> = chain.holders.of !== READ.read ? chain.holders : taken.of !== READ.read ? taken
    : { of: READ.read, value: signerStandings(account.signers, chain.holders.value.seats, {
      own: ownSeat, entries: found.entries, waited: account.waited ?? [], shown: Object.values(taken.value).flatMap((x) => (x === null ? [] : [x])),
    }) };
  const forSigners: Read<SignersApprovals> = chain.holders.of === READ.read ? approvalsForSigners(chain.holders.value) : chain.holders;
  const signersInvited: Read<readonly SignerInvited[]> = proposalsRead.of !== READ.read ? proposalsRead : taken.of !== READ.read ? taken
    : await alone(async () => signersInvitedIn(proposalsRead.value.served, byAddress, {
      taken: taken.value,
      waiting: account.signers.filter((s) => s.status === 'pending'), seated: account.signers.filter((s) => s.status === 'active'),
    }));
  return {
    of: OPENED.open, id: companyId, name: account.name, notOpened: viewingKey.notOpened ?? [], signers, approvalsNeeded: chain.approvals,
    proposals, runs: rows, people, vaults: chain.retiredToo?.(retiredInTheRecords(proposals)) ?? chain.vaults, invitations,
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



