import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { privateAmount, type PrivateAmount } from 'vaults-ui';
import { assets, formatAmount, parseAmount, type Asset, type AssetId, type AssetRegistry } from '../../../../src/core/assets.js';
import { changeHoldersOf, whatAChangeCosts, type ChangeCost, type ChangeHolders, type GovernanceChangeAsked, type PublicFact } from '../../../../src/core/change-costs.js';
import { companyWirePaths, fromCompanyWire } from '../../../../src/midnight/sealed-record-wire.js';
import { POLICY_BANDS, POLICY_PERIODS, policyPeriodNamed, type PolicyPeriodId } from '../../../../src/midnight/spending-policy-record.js';
import { api, holdersFromTheWallet } from 'vaults-web-shared/keyring.js';
import {
  countOf, PROPOSAL_ACTED, proposalOutcomeOf, setPolicyBarInTheWallet, setSpendingPolicyInTheWallet, thresholdProblem, type ThresholdProblem,
} from 'vaults-web-shared/proposal-in-the-wallet.js';
import type { ActOutcome } from 'vaults-web-shared/wallet-act.js';
import type { CompanyRecordsHere } from 'vaults-web-shared/run-rebuilt-here.js';
import { spendingPoliciesFor } from 'vaults-web-shared/spending-policies-reach.js';
import { spendingPolicyHere, type SpendingPolicyDoors } from 'vaults-web-shared/spending-policy-here.js';
import { Fault, FAULT } from '../faults.js';
import type { CompanyKeyHere } from 'vaults-web-shared/company-key-here.js';
import { namedFor } from './create-vault.js';
import { keyringFor } from './keyring-person.js';
import { READ, type Read } from './reads.js';
import { ACT_REFUSAL, refusalOf, SEAT_REFUSALS, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { seatAndRecordsHere, type SeatAndRecordsHere } from './vault-private-money.js';

/*
 * THE POLICIES PAGE'S REACH INTO THE COMPANY AND ITS WALLET. A vault's spending policy is read on this device through the one
 * reader the wallet also uses, with the seat and company key the person's wallet released for this tab and no way to file; what the
 * account holds (approvals, bars, seats) is asked of the person's own wallet, which reads it off the chain; and a new policy, a new
 * bar and their carrying out are asked of the wallet as acts. The page judges no role: a refusal is the wallet's and is told as such.
 */

export { POLICY_PERIODS, whatAChangeCosts, type ChangeCost, type ChangeHolders, type GovernanceChangeAsked, type PublicFact };

type PeriodNamed = ReturnType<typeof policyPeriodNamed>;
const inDays = (named: PeriodNamed): named is Extract<PeriodNamed, { readonly days: number }> => typeof (named as { readonly days?: unknown }).days === 'number';

/** A policy's period, by the name of a length it is offered in, or, for any other length, in days. */
export function policyPeriodOf(seconds: bigint): { readonly id: PolicyPeriodId; readonly days: null } | { readonly id: null; readonly days: number } {
  const named = policyPeriodNamed(seconds);
  return inDays(named) ? { id: null, days: named.days } : { id: named.id, days: null };
}

export const POLICY_ACTED = { ...PROPOSAL_ACTED, problem: 'problem' } as const;
/** The name of the outcome the wallet gives of the proposal an act raised, read by the code. */
const OUTCOME = { proposal: 'proposal' } as const;

/** The kind and version of the company's state record, as the service files it; sent and never shown. */
const STATE_RECORD = { kind: 'state', version: 1 } as const;

export const POLICIES_READ = { read: 'read', refused: 'refused' } as const;
export const POLICY_HELD = { set: 'set', none: 'none', notForThisCurrency: 'not-for-this-currency', unread: 'unread' } as const;


/* What the wallet's acts can stop with, as the page tells it. Each is worded in `locales/pages/policies`, as `policies.why.` and the code. */
export const POLICY_WHY = {
  seat: 'seat', mayNotSet: 'may-not-set', mayNotSetAfterFiling: 'may-not-set-after-filing', mayNotSetAfterSending: 'may-not-set-after-sending',
  seatNotInDirectory: 'seat-not-in-directory', seatNotBelieved: 'seat-not-believed', notAdopted: 'not-adopted', notAPolicy: 'not-a-policy',
  notACurrency: 'not-a-currency', notABar: 'not-a-bar', tooMany: 'too-many', refused: 'refused', notRaised: 'not-raised', mayBeSent: 'may-be-sent',
  raisedNotRead: 'raised-not-read', notApproved: 'not-approved', notCarried: 'not-carried', withdrawn: 'withdrawn', carriedOut: 'carried-out',
  alreadyCounted: 'already-counted', outrun: 'outrun', notAsShown: 'not-as-shown', stopped: 'stopped', other: 'other',
} as const;
export type PolicyWhy = (typeof POLICY_WHY)[keyof typeof POLICY_WHY];


const WHY_OF_CODE: Readonly<Record<string, PolicyWhy>> = Object.fromEntries([
  ...SEAT_REFUSALS.map((c) => [c, POLICY_WHY.seat] as const),
  ...(Object.values(POLICY_WHY).filter((w) => w !== POLICY_WHY.seat && w !== POLICY_WHY.notACurrency && w !== POLICY_WHY.stopped && w !== POLICY_WHY.other)
    .map((w) => [w, w] as const)),
  ['not-a-known-currency', POLICY_WHY.notACurrency] as const,
]);

/* A stop that may have gone part of the way: part of the change may be raised, sent or filed already, so the page says to look before trying again. */
const PARTLY: ReadonlySet<PolicyWhy> = new Set<PolicyWhy>([
  POLICY_WHY.mayNotSetAfterSending, POLICY_WHY.mayBeSent, POLICY_WHY.raisedNotRead, POLICY_WHY.notCarried, POLICY_WHY.stopped, POLICY_WHY.other,
]);

const CODE = /^act\.(?:set-spending-policy|set-policy-bar|approve-policy)\.why\.([a-z-]+)$/u;

/** Which reason the page tells for the key a wallet act stopped with; a code of another act, or one the page does not know, is told as `other`. */
function policyWhyOf(refused: string | undefined): PolicyWhy {
  if (refused === undefined) return POLICY_WHY.stopped;
  const code = CODE.exec(refused)?.[1];
  return code !== undefined && Object.prototype.hasOwnProperty.call(WHY_OF_CODE, code) ? WHY_OF_CODE[code]! : POLICY_WHY.other;
}


/** A policy as this device opened it: each amount as it is shown and as it is written in a field, and the approvals a band needs as a number. */
export interface PolicyTermsHeld {
  readonly bands: readonly { readonly ceiling: PrivateAmount; readonly ceilingText: string; readonly approvals: number }[];
  readonly limit: PrivateAmount;
  readonly limitText: string;
  readonly periodStart: bigint;
  readonly periodLength: bigint;
  readonly version: number;
}

export type PolicyHeld = { readonly vault: string; readonly token: AssetId } & (
  | { readonly of: typeof POLICY_HELD.set; readonly terms: PolicyTermsHeld }
  | { readonly of: typeof POLICY_HELD.none | typeof POLICY_HELD.notForThisCurrency | typeof POLICY_HELD.unread }
);

export type PoliciesRead =
  | { readonly of: typeof POLICIES_READ.read; readonly held: readonly PolicyHeld[] }
  | { readonly of: typeof POLICIES_READ.refused; readonly why: ActRefusal };


const notRead = (): never => { throw new Fault(FAULT.policyReadReadsNothingElse); };

/**
 * The company's records as a policy read needs them: its directory, its signed state (which holds the blinding a policy's keys are made
 * with) and its policies. Everything else a company's records can hold is refused, so a policy read can never stand in for another read.
 */
function recordsForPolicies(here: SeatAndRecordsHere, companyId: string): CompanyRecordsHere {
  const policies = spendingPoliciesFor({
    accountId: companyId, leaf: here.leaf, companyKey: here.companyKey, api: (path) => api(path),
    keys: (input) => here.builder.spendingPolicyKeys(input),
    roles: async (asked) => {
      const read = await holdersFromTheWallet(ACCOUNT_ORIGIN, { company: here.company, account: here.account, roles: asked });
      return { roles: read.roles };
    },
    directory: here.directory,
  });
  return {
    directory: here.directory,
    people: notRead,
    runs: notRead,
    state: async (id) => {
      const body = await api(companyWirePaths.one(companyId, STATE_RECORD.kind, id, STATE_RECORD.version)) as { filed?: unknown } | null;
      return body?.filed == null ? null : fromCompanyWire(body.filed, { company: companyId, kind: STATE_RECORD.kind, id, version: STATE_RECORD.version }).sealed;
    },
    payments: { paidOnceOf: notRead, paidMovementOf: notRead, read: notRead },
    roundIdentity: { runPayload: notRead, proposalIdOf: notRead },
    policy: notRead,
    oneOffs: { at: notRead, keys: here.viewingKey, detailsOf: {} as CompanyRecordsHere['oneOffs']['detailsOf'], open: notRead, treeOf: notRead },
    spendingPolicies: policies,
  };
}

async function heldOf(doors: SpendingPolicyDoors, vault: string, asset: Asset): Promise<PolicyHeld> {
  const token = asset.code;
  try {
    const standing = await spendingPolicyHere(doors, { vault, asset: token });
    if (standing.state !== 'set') return { vault, token, of: standing.state };
    const { terms } = standing.policy;
    return {
      vault, token, of: POLICY_HELD.set,
      terms: {
        bands: terms.bands.map((b) => ({ ceiling: privateAmount(b.ceiling, asset.decimals, asset.symbol), ceilingText: formatAmount(b.ceiling, asset), approvals: countOf(b.approvals) })),
        limit: privateAmount(terms.periodLimit, asset.decimals, asset.symbol), limitText: formatAmount(terms.periodLimit, asset),
        periodStart: terms.periodStart, periodLength: terms.periodLength, version: standing.version,
      },
    };
  } catch {
    // A policy this device cannot open or read is shown as unread, never as none: saying none would invite a second policy over a real one.
    return { vault, token, of: POLICY_HELD.unread };
  }
}


/**
 * What each of the vaults holds as a spending policy, in each currency of the registry. It is asked of nothing until the wallet has
 * released the company key for this tab and refuses with no keys here until then; it never asks the wallet to release it itself.
 */
export async function readPolicies(
  personId: string, companyId: string, vaults: readonly string[], registry: AssetRegistry = assets,
): Promise<PoliciesRead> {
  try {
    const here = await seatAndRecordsHere(personId, companyId);
    if (typeof here === 'string') return { of: POLICIES_READ.refused, why: here };
    /* The company's keys as this device believes them, which `seatAndRecordsHere` made with `companyKeysFor`, handed on typed as such. */
    const viewingKey: CompanyKeyHere = here.viewingKey;
    const doors: SpendingPolicyDoors = { records: recordsForPolicies(here, companyId), accountId: companyId, viewingKey };
    const held: PolicyHeld[] = [];
    for (const vault of vaults) {
      for (const asset of registry.all()) held.push(await heldOf(doors, vault.toLowerCase(), asset));
    }
    return { of: POLICIES_READ.read, held };
  } catch (e) {
    return { of: POLICIES_READ.refused, why: refusalOf(e) };
  }
}


/** What the account holds now, as the person's own wallet reads it off the chain, with the signers seated counted: what a change is costed from. */
export async function readHolders(personId: string, companyId: string): Promise<Read<ChangeHolders>> {
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return { of: READ.unreadable };
    const { holders } = await holdersFromTheWallet(ACCOUNT_ORIGIN, { company: named.company, account: named.account });
    return {
      of: READ.read,
      value: changeHoldersOf(holders),
    };
  } catch {
    // A wallet that cannot say who holds the company is shown as unread, never as holders: a change is not costed from a guess.
    return { of: READ.unreadable };
  }
}


/** The first period of a policy: the one it already has when it is edited, so period boundaries do not move; when it is raised, now, in seconds. */
const startOfPolicy = (current: Pick<PolicyTermsHeld, 'periodStart'> | null, nowMs: number): bigint =>
  (current === null ? BigInt(Math.floor(nowMs / 1000)) : current.periodStart);


/** A policy whose terms cannot be set as typed, told apart from a count of approvals the chain cannot meet. */
export const NOT_A_POLICY = 'not-a-policy';
type PolicyProblem = ThresholdProblem | typeof NOT_A_POLICY;

export type PolicyActed =
  | { readonly of: typeof POLICY_ACTED.done; readonly state: string | null; readonly proposal: string | null; readonly approvals: number | null; readonly needed: number | null }
  | { readonly of: typeof POLICY_ACTED.stopped; readonly why: PolicyWhy; readonly partial: boolean; readonly handedOver: boolean }
  | { readonly of: typeof POLICY_ACTED.refused; readonly why: ActRefusal }
  | { readonly of: typeof POLICY_ACTED.problem; readonly problem: PolicyProblem; readonly most?: number };

const refused = (why: ActRefusal): PolicyActed => ({ of: POLICY_ACTED.refused, why });

async function namedBefore(personId: string, companyId: string): Promise<{ record: string; company: CompanyLabel; account: AccountAddress } | ActRefusal> {
  if (ACCOUNT_ORIGIN === '') return ACT_REFUSAL.notSetUp;
  if (!(await keyringFor(personId))) return ACT_REFUSAL.notSignedIn;
  const named = await namedFor(companyId);
  return named === null ? ACT_REFUSAL.didNotFinish : { record: named.record, company: named.company as CompanyLabel, account: named.account as AccountAddress };
}

function actedOf(ended: ActOutcome): PolicyActed {
  if (ended.of === POLICY_ACTED.done) {
    const proposal = ended.outcome?.[OUTCOME.proposal];
    return { of: POLICY_ACTED.done, ...proposalOutcomeOf(ended), proposal: typeof proposal === 'string' ? proposal : null };
  }
  const why = policyWhyOf(ended.refused);
  return { of: POLICY_ACTED.stopped, why, partial: PARTLY.has(why), handedOver: ended.relayed > 0 || ended.unconfirmed > 0 };
}

const onStepOf = (onStep?: (step: number, steps: number) => void) => (onStep === undefined ? {} : { onStep: (at: { step: number; steps: number }) => onStep(at.step, at.steps) });


/**
 * Change the approvals any change to a spending policy needs. Refused here, asking the wallet nothing, for a number that is not whole, a bar
 * above the signers seated now, one already in force, or when what the account holds was not read; any seat may raise it, and the wallet
 * judges the rest.
 */
export async function raisePolicyBar(
  personId: string, companyId: string, bar: number, known: { readonly policyBar: number | null; readonly seated: number | null },
  onStep?: (step: number, steps: number) => void,
): Promise<PolicyActed> {
  const wrong = thresholdProblem(bar, { now: known.seated === null ? null : known.policyBar ?? 0, seated: known.seated });
  if (wrong !== null) return { of: POLICY_ACTED.problem, ...wrong };
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    return actedOf(await setPolicyBarInTheWallet({ ...named, bar }, ACCOUNT_ORIGIN, onStepOf(onStep)));
  } catch (e) {
    return refused(refusalOf(e));
  }
}


export interface PolicyAsked {
  readonly vault: string;
  readonly token: AssetId;
  /** The limit for each period and each band's ceiling, as written in a field: a plain decimal in the currency. */
  readonly limit: string;
  readonly periodLength: bigint;
  readonly bands: readonly { readonly ceiling: string; readonly approvals: number }[];
  /** The policy this one replaces, whose first period this one keeps; null for a vault's first policy in the currency. */
  readonly current: Pick<PolicyTermsHeld, 'periodStart'> | null;
}

const MOST_APPROVALS = 999_999_999;

/** The policy as the wallet is asked for it, or null when what was filled in is not a policy: four bands of whole approvals, amounts of the currency, a period of some length. */
function termsOf(a: PolicyAsked, registry: AssetRegistry): { periodLimit: bigint; bands: { ceiling: bigint; approvals: number }[] } | null {
  const asset = registry.find(a.token);
  if (asset === null || !/^[0-9a-f]{64}$/iu.test(a.vault) || a.bands.length !== POLICY_BANDS || a.periodLength <= 0n) return null;
  if (!a.bands.every((b) => Number.isSafeInteger(b.approvals) && b.approvals >= 1 && b.approvals <= MOST_APPROVALS)) return null;
  try {
    return { periodLimit: parseAmount(a.limit, asset), bands: a.bands.map((b) => ({ ceiling: parseAmount(b.ceiling, asset), approvals: b.approvals })) };
  } catch {
    // An amount that is not a plain decimal of this currency is not a policy; the person is told so and nothing is asked of the wallet.
    return null;
  }
}


/** The currencies a policy can be set in, as the person may choose them. */
export const policyCurrencies = (registry: AssetRegistry = assets): readonly { readonly code: AssetId; readonly symbol: string; readonly name: string }[] =>
  registry.enabled().map((a) => ({ code: a.code, symbol: a.symbol, name: a.name }));


/**
 * Raise a vault's spending policy for one currency. Refused here, asking the wallet nothing, for anything that is not a policy; whether this
 * seat may set it, and whether the vault is adopted, are the wallet's to say.
 */
export async function raisePolicy(
  personId: string, companyId: string, asked: PolicyAsked, onStep?: (step: number, steps: number) => void, now: () => number = Date.now,
  registry: AssetRegistry = assets,
): Promise<PolicyActed> {
  const terms = termsOf(asked, registry);
  if (terms === null) return { of: POLICY_ACTED.problem, problem: NOT_A_POLICY };
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    return actedOf(await setSpendingPolicyInTheWallet({
      ...named, vault: asked.vault.toLowerCase(), token: asked.token, periodLimit: terms.periodLimit,
      periodStart: startOfPolicy(asked.current, now()), periodLength: asked.periodLength, bands: terms.bands,
    }, ACCOUNT_ORIGIN, onStepOf(onStep)));
  } catch (e) {
    return refused(refusalOf(e));
  }
}
