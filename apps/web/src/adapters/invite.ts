import { NETWORK } from 'midnight-identity/network';
import { checkShieldedAddress, checkUnshieldedAddress } from 'midnight-identity/wallet/address-shape';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { inviteInTheWallet, type InviteAsk } from 'vaults-web-shared/invite-in-the-wallet.js';
import { assets, type Asset, type AssetRegistry } from '../../../../src/core/assets.js';
import { EMPLOYEE_CLASSIFICATIONS, tokenOfLink } from '../../../../src/core/invitation.js';
import type { NetworkName } from '../../../../src/midnight/network.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { namedFor } from './create-vault.js';
import { keyringFor } from './keyring-person.js';
import { READ, type Read } from './reads.js';
import { ACT_REFUSAL, refusalOf, type ActRefusal } from './refusals.js';
import type { SignersApprovals } from './signers.js';

/** Who can be invited. A super admin is shown and refused: a seat never invites one. */
export const INVITE_KIND = { employee: 'employee', vendor: 'vendor', signer: 'signer', superAdmin: 'super-admin' } as const;
export type InviteKind = (typeof INVITE_KIND)[keyof typeof INVITE_KIND];

/** How an employee or a vendor joins: by a link alone, or at an address as well. A signer is always at an address. */
export const INVITE_WAY = { link: 'link', address: 'address' } as const;
type InviteWay = (typeof INVITE_WAY)[keyof typeof INVITE_WAY];

/** The roles a signer can be invited to now, and the two shown for later. */
export const ROLE = { admin: 'admin', approver: 'approver', initiator: 'initiator', viewer: 'viewer', limited: 'limited', accountant: 'accountant' } as const;
export const SIGNER_ROLES = [ROLE.admin, ROLE.approver, ROLE.initiator, ROLE.viewer] as const;
export const SIGNER_ROLES_LATER = [ROLE.limited, ROLE.accountant] as const;
/** The on-screen keypad an amount field asks a phone for. */
export const DECIMAL_KEYPAD = 'decimal';
export const TERMS = { oneOff: 'one-off', monthly: 'monthly' } as const;
export const VENDOR_TERMS = [TERMS.oneOff, TERMS.monthly] as const;
export const CLASSIFICATIONS = EMPLOYEE_CLASSIFICATIONS;

/** The fields of the form, named as the draft names them; and the phases the form is in; and the scopes a signer can be offered. */
export const FIELD = {
  kind: 'kind', way: 'way', name: 'name', email: 'email', title: 'title', startDate: 'startDate', endDate: 'endDate', classification: 'classification',
  asset: 'asset', amount: 'amount', terms: 'terms', termsAsset: 'termsAsset', termsAmount: 'termsAmount', address: 'address', role: 'role',
} as const satisfies Record<string, keyof InviteDraft>;
export const FORM = { edit: 'edit', busy: 'busy', sent: 'sent' } as const;
export const SCOPE = { all: 'all', chosen: 'chosen' } as const;

/** What the person has typed, every field as text; the ask is made from it. */
export interface InviteDraft {
  kind: InviteKind; way: InviteWay; name: string; email: string; title: string; startDate: string; endDate: string;
  classification: string; asset: string; amount: string; terms: string; termsAsset: string; termsAmount: string; address: string; role: string;
}

/** The currencies a pay can be in. */
export const payAssets = (registry: AssetRegistry = assets): readonly Pick<Asset, 'code' | 'symbol' | 'name'>[] =>
  registry.enabled().map((a) => ({ code: a.code, symbol: a.symbol, name: a.name }));

export function emptyDraft(kind: InviteKind = INVITE_KIND.employee, registry: AssetRegistry = assets): InviteDraft {
  const first = payAssets(registry)[0]?.code ?? '';
  return {
    kind, way: INVITE_WAY.link, name: '', email: '', title: '', startDate: '', endDate: '', classification: CLASSIFICATIONS[0],
    asset: first, amount: '', terms: VENDOR_TERMS[0], termsAsset: first, termsAmount: '', address: '', role: SIGNER_ROLES[1],
  };
}

/** What a made ask is: the ask, or the first thing wrong with it; and what an amount typed comes to. */
export const MADE = { ask: 'ask', problem: 'problem', units: 'units' } as const;

export const PROBLEM = {
  noName: 'no-name', noStart: 'no-start', badStart: 'bad-start', badEnd: 'bad-end', endBeforeStart: 'end-before-start', badEmail: 'bad-email',
  noAsset: 'no-asset', noAmount: 'no-amount', badAmount: 'bad-amount', zeroAmount: 'zero-amount', tooManyDecimals: 'too-many-decimals',
  noAddress: 'no-address', badAddress: 'bad-address', notPrivateAddress: 'not-private-address', noRole: 'no-role', roleLater: 'role-later',
  superAdmin: 'super-admin',
} as const;
export type InviteProblem = (typeof PROBLEM)[keyof typeof PROBLEM];

type AskMade =
  | { readonly of: typeof MADE.ask; readonly ask: InviteAsk }
  | { readonly of: typeof MADE.problem; readonly problem: InviteProblem; readonly field: keyof InviteDraft };

const problem = (field: keyof InviteDraft, why: InviteProblem): AskMade => ({ of: MADE.problem, problem: why, field });
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const isDay = (s: string): boolean => DAY.test(s) && !Number.isNaN(Date.parse(s)) && new Date(Date.parse(s)).toISOString().slice(0, 10) === s;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;
const AMOUNT_TEXT = /^(\d+)(?:\.(\d*))?$/u;
const MOST_DIGITS = 39;

/** An amount typed in a currency's units, as whole smallest units; or why not. */
export function unitsOf(entry: string, asset: Pick<Asset, 'decimals'>): { readonly of: typeof MADE.units; readonly units: bigint } | { readonly of: typeof MADE.problem; readonly problem: InviteProblem } {
  const text = entry.trim();
  if (text === '') return { of: MADE.problem, problem: PROBLEM.noAmount };
  const m = AMOUNT_TEXT.exec(text);
  if (m === null) return { of: MADE.problem, problem: PROBLEM.badAmount };
  const fraction = (m[2] ?? '').replace(/0+$/u, '');
  if (fraction.length > asset.decimals) return { of: MADE.problem, problem: PROBLEM.tooManyDecimals };
  const units = BigInt(m[1]!) * 10n ** BigInt(asset.decimals) + BigInt(fraction === '' ? 0 : fraction.padEnd(asset.decimals, '0'));
  if (units <= 0n) return { of: MADE.problem, problem: PROBLEM.zeroAmount };
  return units >= 10n ** BigInt(MOST_DIGITS) ? { of: MADE.problem, problem: PROBLEM.badAmount } : { of: MADE.units, units };
}

/** An address of this network: a private one, or (unless `privateOnly`) a public one. */
function addressProblem(entry: string, privateOnly: boolean, network: NetworkName = NETWORK as NetworkName): InviteProblem | null {
  const text = entry.trim();
  if (text === '') return PROBLEM.noAddress;
  try { checkShieldedAddress(text, network); return null; } catch { /* not a private address */ }
  if (privateOnly) {
    try { checkUnshieldedAddress(text, network); return PROBLEM.notPrivateAddress; } catch { return PROBLEM.badAddress; }
  }
  try { checkUnshieldedAddress(text, network); return null; } catch { return PROBLEM.badAddress; }
}

/** The company an invitation is for, as `namedFor` reads it. */
/** Whether the address typed is a private (shielded) one on this network: what decides who can take up an invitation made at it. */
export function addressIsPrivate(entry: string, network: NetworkName = NETWORK as NetworkName): boolean {
  try { checkShieldedAddress(entry.trim(), network); return true; } catch { return false; }
}

export interface Named { readonly record: string; readonly company: string; readonly account: string }

/** The ask made from what was typed, or the first thing wrong with it, named by its field. */
export function askOf(d: InviteDraft, named: Named, registry: AssetRegistry = assets, network: NetworkName = NETWORK as NetworkName): AskMade {
  if (d.kind === INVITE_KIND.superAdmin) return problem(FIELD.kind, PROBLEM.superAdmin);
  const name = d.name.trim();
  if (name === '') return problem(FIELD.name, PROBLEM.noName);
  const company = { record: named.record, company: named.company as CompanyLabel, account: named.account as AccountAddress };
  if (d.kind === INVITE_KIND.signer) {
    if (!(SIGNER_ROLES as readonly string[]).includes(d.role)) {
      return problem(FIELD.role, (SIGNER_ROLES_LATER as readonly string[]).includes(d.role) ? PROBLEM.roleLater : PROBLEM.noRole);
    }
    const wrong = addressProblem(d.address, true, network);
    if (wrong !== null) return problem(FIELD.address, wrong);
    return { of: MADE.ask, ask: { ...company, kind: INVITE_KIND.signer, name, role: d.role, address: d.address.trim() } };
  }
  const email = d.email.trim();
  if (email !== '' && !EMAIL.test(email)) return problem(FIELD.email, PROBLEM.badEmail);
  if (d.startDate === '') return problem(FIELD.startDate, PROBLEM.noStart);
  if (!isDay(d.startDate)) return problem(FIELD.startDate, PROBLEM.badStart);
  if (d.endDate !== '' && !isDay(d.endDate)) return problem(FIELD.endDate, PROBLEM.badEnd);
  if (d.endDate !== '' && d.endDate < d.startDate) return problem(FIELD.endDate, PROBLEM.endBeforeStart);
  let address: string | undefined;
  if (d.way === INVITE_WAY.address) {
    const wrong = addressProblem(d.address, false, network);
    if (wrong !== null) return problem(FIELD.address, wrong);
    address = d.address.trim();
  }
  const common = {
    ...company, name, ...(email === '' ? {} : { email }), startDate: d.startDate, ...(d.endDate === '' ? {} : { endDate: d.endDate }),
    ...(address === undefined ? {} : { address }),
  };
  const priced = (code: string, entry: string, field: keyof InviteDraft): { readonly of: typeof MADE.units; readonly asset: string; readonly units: bigint } | AskMade => {
    const asset = registry.find(code);
    if (asset === null) return problem(FIELD.asset, PROBLEM.noAsset);
    const got = unitsOf(entry, asset);
    return got.of === MADE.units ? { of: MADE.units, asset: asset.code, units: got.units } : problem(field, got.problem);
  };
  if (d.kind === INVITE_KIND.employee) {
    const pay = priced(d.asset, d.amount, FIELD.amount);
    if (pay.of !== MADE.units) return pay;
    return { of: MADE.ask, ask: { ...common, kind: INVITE_KIND.employee, title: d.title.trim(), asset: pay.asset, units: pay.units, classification: d.classification } };
  }
  if (d.terms === TERMS.monthly) {
    const pay = priced(d.termsAsset, d.termsAmount, FIELD.termsAmount);
    if (pay.of !== MADE.units) return pay;
    return { of: MADE.ask, ask: { ...common, kind: INVITE_KIND.vendor, terms: { kind: TERMS.monthly, asset: pay.asset, units: pay.units } } };
  }
  return { of: MADE.ask, ask: { ...common, kind: INVITE_KIND.vendor, terms: { kind: TERMS.oneOff } } };
}

/** Why the wallet stopped, from the key of the words it refused with; any other key is `other`; no key at all is `stopped`. */
export const WHY = {
  notACompany: 'not-a-company',
  noSavedKeys: 'no-saved-keys',
  noSeat: 'no-seat',
  seatNotHeld: 'seat-not-held',
  notOnChain: 'not-on-chain',
  rosterNotOpened: 'roster-not-opened',
  notAToken: 'not-a-token',
  noName: 'no-name',
  notAnAsset: 'not-an-asset',
  noPay: 'no-pay',
  noClassification: 'no-classification',
  noStart: 'no-start',
  noTerms: 'no-terms',
  noRole: 'no-role',
  signerByAddress: 'signer-by-address',
  superAdmin: 'super-admin',
  notAKind: 'not-a-kind',
  noOpening: 'no-opening',
  ownAddress: 'own-address',
  widerScope: 'wider-scope',
  notMade: 'not-made',
  notFiled: 'not-filed',
  raisedNotFiled: 'raised-not-filed',
  mayBeSent: 'may-be-sent',
  filedNotEntered: 'filed-not-entered',
  offerNotRead: 'offer-not-read',
  stopped: 'stopped',
  other: 'other',
} as const;
export type InviteWhy = (typeof WHY)[keyof typeof WHY];
const WHY_KEY = /^act\.invite\.why\.([a-z-]+)$/u;
export function whyOf(refused: string | undefined): InviteWhy {
  if (refused === undefined) return WHY.stopped;
  const m = WHY_KEY.exec(refused);
  const code = (Object.values(WHY) as string[]).find((c) => c === m?.[1] && c !== WHY.stopped && c !== WHY.other);
  return code === undefined ? WHY.other : (code as InviteWhy);
}
/** The stops after which pressing again must carry on the SAME invitation: part of it may already be made. */
const KEEPS_ITS_TOKEN: ReadonlySet<InviteWhy> = new Set<InviteWhy>([WHY.raisedNotFiled, WHY.mayBeSent, WHY.filedNotEntered, WHY.offerNotRead, WHY.stopped, WHY.other]);

/** The stops whose own words already speak of something handed over; every other stop's words say nothing was sent, which a stop that handed transactions over contradicts. */
export const WORDS_OF_SENT: ReadonlySet<InviteWhy> = new Set<InviteWhy>([WHY.raisedNotFiled, WHY.mayBeSent, WHY.filedNotEntered, WHY.stopped, WHY.other]);

export const INVITED = { done: 'done', stopped: 'stopped', refused: 'refused', problem: 'problem' } as const;
/** `handedOver` on a stop: the wallet handed the page transactions before it stopped (sent or not confirmed), whatever the reason. */
export type Invited =
  | { readonly of: typeof INVITED.done; readonly link: string; readonly token: string; readonly already: boolean }
  | { readonly of: typeof INVITED.stopped; readonly why: InviteWhy; readonly token: string; readonly keeps: boolean; readonly link: string | null; readonly handedOver: boolean }
  | { readonly of: typeof INVITED.refused; readonly why: ActRefusal }
  | { readonly of: typeof INVITED.problem; readonly problem: InviteProblem; readonly field: keyof InviteDraft };

/** What the wallet's end answer is called when it is done, and the outcome it names and says when the invitation was filed before. */
const DONE = 'done';
const STATE = 'state';
const ALREADY_FILED = 'already-filed';
/**
 * INVITES SOMEBODY FROM THE SHOWN COMPANY, through the person's wallet. `token`, when the last press of this same
 * invitation kept one, makes this press carry on that invitation; the wallet wrapper refuses a token that is not a whole
 * one before the wallet is asked, and that refusal comes back as a refusal.
 */
export async function sendInvite(
  personId: string, companyId: string, draft: InviteDraft, token?: string, onStep?: (step: number, steps: number) => void,
): Promise<Invited> {
  try {
    if (ACCOUNT_ORIGIN === '') return { of: INVITED.refused, why: ACT_REFUSAL.notSetUp };
    if (!(await keyringFor(personId))) return { of: INVITED.refused, why: ACT_REFUSAL.notSignedIn };
    const named = await namedFor(companyId);
    if (named === null) return { of: INVITED.refused, why: ACT_REFUSAL.didNotFinish };
    const made = askOf(draft, named);
    if (made.of === MADE.problem) return { of: INVITED.problem, problem: made.problem, field: made.field };
    const sent = await inviteInTheWallet(made.ask, ACCOUNT_ORIGIN, {
      ...(onStep === undefined ? {} : { onStep: (at: { step: number; steps: number }) => onStep(at.step, at.steps) }),
      ...(token === undefined ? {} : { token }),
    });
    const kept = tokenOfLink(sent.link);
    if (kept === null) return { of: INVITED.refused, why: ACT_REFUSAL.didNotFinish };
    if (sent.ended.of === DONE) return { of: INVITED.done, link: sent.link, token: kept, already: sent.ended.outcome?.[STATE] === ALREADY_FILED };
    const why = whyOf(sent.ended.refused);
    return { of: INVITED.stopped, why, token: kept, keeps: KEEPS_ITS_TOKEN.has(why), link: why === WHY.raisedNotFiled ? sent.link : null,
      handedOver: sent.ended.relayed > 0 || sent.ended.unconfirmed > 0 };
  } catch (e) {
    return { of: INVITED.refused, why: refusalOf(e) };
  }
}

/** What the panel says before the wallet is asked, of the approvals adding a signer needs; nothing when the number could not be read. */
export const APPROVALS = { account: 'account', raised: 'raised', raisedUnnamed: 'raisedUnnamed' } as const;
type ApprovalsSentence = { readonly code: (typeof APPROVALS)[keyof typeof APPROVALS]; readonly values: { readonly count: number; readonly vaults: number } } | null;
export function approvalsSentence(read: Read<SignersApprovals> | undefined): ApprovalsSentence {
  if (read === undefined || read.of !== READ.read) return null;
  const { count, raisedAboveTheAccount, vaultsAtThatNumber } = read.value;
  const vaults = vaultsAtThatNumber.length;
  return { code: !raisedAboveTheAccount ? APPROVALS.account : vaults > 0 ? APPROVALS.raised : APPROVALS.raisedUnnamed, values: { count, vaults } };
}
