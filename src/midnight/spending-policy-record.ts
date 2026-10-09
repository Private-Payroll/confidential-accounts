/**
 * **A VAULT'S SPENDING POLICY, KEPT AS ONE OF THE COMPANY'S OWN RECORDS.**
 *
 * The chain holds only a commitment to a vault's spending policy for one
 * currency. What opens it - the four bands, the limit per period, the periods
 * and the blinding - is kept here, and only signers' devices ever read it.
 *
 * **SEALED TO THE SIGNERS, NOT UNDER A KEY THE SERVICE COULD WORK OUT.** A key
 * derived from the company's viewing key would not do: the viewing key reaches
 * the company's service on some routes, and the opening is what turns every
 * period's stored total into an amount. So each version is sealed under a key
 * made for it and kept by nobody, wrapped to each signer's own wrapping key,
 * exactly as a vault's note pool is, and signed by the seat that filed it.
 * What it says it is - the company, the record and the version - is sealed
 * inside it too, so a version filed under another record does not open as this
 * one.
 *
 * **ONE RECORD PER VAULT AND CURRENCY**, filed under the key the chain keeps
 * that policy under; each policy set on it is its next version.
 *
 * **A VERSION IS NEVER BELIEVED FOR WHAT IT SAYS.** A device takes the version
 * whose opening makes exactly the commitment the chain holds for that vault and
 * currency, or the one a proposal being approved names, and refuses when none
 * does (`policyOpeningFor`). Nothing here makes a commitment: that is the
 * contract's own circuit, called where the contract runs, and handed in.
 *
 * Pure: the page, the worker and the service all import it.
 */
import { canonical, parseCanonical, seal, unseal, unwrapKey, wrapKey, newSymmetricKey, fromHex, toHex, type Hex } from '../core/crypto.js';
import { paddedToABucket, type PoolSigner } from './vault-pool.js';
import type { SealedCompanyRecord } from './sealed-record-wire.js';
import type { PolicyOpening } from '../../contracts/src/witnesses.js';

/** How many bands a policy has. The contract's `Vector<4, Band>`. */
export const POLICY_BANDS = 4;

/** Refuses terms the contract could not open, with a sentence saying why. */
const refuseUnusableTerms = (terms: PolicyOpening['terms']): void => {
  if (terms.bands.length !== POLICY_BANDS) {
    throw new Error(`a spending policy has exactly ${POLICY_BANDS} bands; this one has ${terms.bands.length}`);
  }
  if (terms.periodLength <= 0n) {
    throw new Error('a spending policy needs periods of at least one second, or no run could ever fit inside one');
  }
};

/** Refuses a policy the contract could not open, with a sentence saying why. */
export const refuseAnUnusablePolicy = (policy: PolicyOpening): void => {
  refuseUnusableTerms(policy.terms);
  if (policy.blinding.length !== 32) {
    throw new Error("this device's copy of the spending policy is damaged; get the current policy again from a signer who holds it");
  }
};

/** When period `period` of `policy` starts and ends, in seconds since the Unix epoch. */
export const periodWindowOf = (policy: PolicyOpening, period: bigint): { from: bigint; until: bigint } => {
  refuseAnUnusablePolicy(policy);
  const from = policy.terms.periodStart + period * policy.terms.periodLength;
  return { from, until: from + policy.terms.periodLength };
};

/**
 * The period a run's whole window lies in, or null when it opens before the
 * policy's first period or crosses from one period into the next. A run the
 * chain cannot charge is refused here rather than after a fee.
 */
export const periodOf = (policy: PolicyOpening, window: { opensAt: bigint; closesAt: bigint }): bigint | null => {
  refuseAnUnusablePolicy(policy);
  if (window.opensAt < policy.terms.periodStart) return null;
  const period = (window.opensAt - policy.terms.periodStart) / policy.terms.periodLength;
  return window.closesAt <= periodWindowOf(policy, period).until ? period : null;
};

/** One band, as it travels: decimal digits. */
export interface PolicyBandOnTheWire {
  readonly ceiling: string;
  readonly approvals: string;
}

/** A policy's opening, as it travels and as it is sealed: decimal digits, and the blinding as hexadecimal. */
export interface PolicyOpeningOnTheWire {
  readonly terms: {
    readonly bands: readonly PolicyBandOnTheWire[];
    readonly periodLimit: string;
    readonly periodStart: string;
    readonly periodLength: string;
  };
  readonly blinding: string;
}

/** What one version of the record holds: the vault, the currency and the policy's opening. */
export interface SpendingPolicySecrets {
  readonly vault: Hex;
  /** The account's own code for the currency, as hexadecimal: what the contract's asset witness answers with. */
  readonly asset: Hex;
  readonly opening: PolicyOpeningOnTheWire;
}

/** The record kind, as the company's records name it. */
export const SPENDING_POLICY_KIND = 'spending-policy' as const;

const HEX64 = /^[0-9a-f]{64}$/u;
const DIGITS = /^[0-9]{1,39}$/u;

/** Why a policy could not be read on this device. Nothing is built on it. */
export class PolicyNotOpenedHere extends Error {
  constructor(why: string, options?: { cause?: unknown }) {
    super(`${why} Nothing was built or sent.`, options);
    this.name = 'PolicyNotOpenedHere';
  }
}

const digitsOf = (what: string, v: unknown): bigint => {
  if (typeof v !== 'string' || !DIGITS.test(v)) throw new PolicyNotOpenedHere(`The spending policy's ${what} is not a whole number.`);
  return BigInt(v);
};

/** A policy's terms, written the one way they travel. */
export const policyTermsToWire = (t: PolicyOpening['terms']): PolicyOpeningOnTheWire['terms'] => ({
  bands: t.bands.map((b) => ({ ceiling: b.ceiling.toString(), approvals: b.approvals.toString() })),
  periodLimit: t.periodLimit.toString(),
  periodStart: t.periodStart.toString(),
  periodLength: t.periodLength.toString(),
});

/** A policy's opening, made ready to travel and to be sealed. */
export const policyOpeningToWire = (o: PolicyOpening): PolicyOpeningOnTheWire => ({
  terms: policyTermsToWire(o.terms), blinding: toHex(o.blinding),
});

/** A policy's terms as the contract takes them, refused unless the contract could open them. */
export const policyTermsFromWire = (w: unknown): PolicyOpening['terms'] => {
  const t = w as Partial<PolicyOpeningOnTheWire['terms']> | null | undefined;
  if (t === undefined || t === null || typeof t !== 'object' || !Array.isArray(t.bands)) {
    throw new PolicyNotOpenedHere('This is not a spending policy: it has no bands.');
  }
  const terms: PolicyOpening['terms'] = {
    bands: t.bands.map((b, i) => ({
      ceiling: digitsOf(`band ${i + 1} ceiling`, (b as PolicyBandOnTheWire | null)?.ceiling),
      approvals: digitsOf(`band ${i + 1} approvals`, (b as PolicyBandOnTheWire | null)?.approvals),
    })),
    periodLimit: digitsOf('limit per period', t.periodLimit),
    periodStart: digitsOf('first period\'s start', t.periodStart),
    periodLength: digitsOf('period length', t.periodLength),
  };
  try {
    refuseUnusableTerms(terms);
  } catch (e) {
    throw new PolicyNotOpenedHere(`${(e as Error).message}.`, { cause: e });
  }
  return terms;
};

/** A policy's opening as the contract takes it, refused unless every part is what the contract can open. */
export const policyOpeningFromWire = (w: unknown): PolicyOpening => {
  const o = w as Partial<PolicyOpeningOnTheWire> | null;
  if (o === null || typeof o !== 'object') throw new PolicyNotOpenedHere('This is not a spending policy.');
  const terms = policyTermsFromWire(o.terms);
  if (typeof o.blinding !== 'string' || !HEX64.test(o.blinding)) {
    throw new PolicyNotOpenedHere('This spending policy\'s blinding is not thirty-two bytes, so it opens no commitment.');
  }
  return { terms, blinding: fromHex(o.blinding) };
};

/** What is sealed inside every version, so one filed under another record or version does not open as this one. */
interface PolicyLabel {
  readonly record: typeof SPENDING_POLICY_KIND;
  readonly company: string;
  readonly id: string;
  readonly version: number;
}
const LABEL = '$label';

/**
 * **ONE VERSION OF A VAULT'S SPENDING POLICY, SEALED TO THE SIGNERS**, under a
 * key made here and kept by nobody: only the wrapped copies survive this call.
 * Not yet signed: the store that files it signs it with this device's seat.
 */
export const sealSpendingPolicy = (input: {
  readonly company: string;
  /** The key the chain keeps this vault's policy for this currency under. */
  readonly id: Hex;
  readonly version: number;
  readonly keyEpoch: number;
  readonly secrets: SpendingPolicySecrets;
  readonly signers: readonly PoolSigner[];
}): SealedCompanyRecord => {
  if (!HEX64.test(input.id)) throw new PolicyNotOpenedHere('A spending policy is filed under the key the chain keeps it under, and this is not one.');
  if (input.signers.length === 0) {
    throw new PolicyNotOpenedHere('A spending policy sealed to nobody could never be opened again, so it was not sealed.');
  }
  policyOpeningFromWire(input.secrets.opening);
  const key = newSymmetricKey();
  const label: PolicyLabel = { record: SPENDING_POLICY_KIND, company: input.company, id: input.id, version: input.version };
  return {
    company: input.company, kind: SPENDING_POLICY_KIND, id: input.id, version: input.version, keyEpoch: input.keyEpoch,
    sealed: seal(paddedToABucket(canonical({
      vault: input.secrets.vault.toLowerCase(), asset: input.secrets.asset.toLowerCase(), opening: input.secrets.opening, [LABEL]: label,
    })), key),
    wrapped: input.signers.map((s) => ({ signerId: s.id, wrapped: wrapKey(key, s.wrappingPublicKey) })),
  };
};

/** One version opened with this signer's own wrapping secret, refused unless it is exactly the record it is filed as. */
export const openSpendingPolicy = (
  rec: SealedCompanyRecord, me: { readonly signerId: string; readonly wrappingSecret: Hex },
): { readonly secrets: SpendingPolicySecrets; readonly opening: PolicyOpening } => {
  if (rec.kind !== SPENDING_POLICY_KIND) throw new PolicyNotOpenedHere('This record is not a spending policy.');
  const mine = rec.wrapped.find((w) => w.signerId === me.signerId);
  if (mine === undefined) {
    throw new PolicyNotOpenedHere('This spending policy was not sealed to you: you were seated after it was set. Ask a signer '
      + 'who holds it to set it again, or to give you a copy.');
  }
  let body: Record<string, unknown>;
  try {
    body = parseCanonical<Record<string, unknown>>(unseal(rec.sealed, unwrapKey(mine.wrapped, me.wrappingSecret)));
  } catch (e) {
    throw new PolicyNotOpenedHere('This spending policy would not open with your key, so it is damaged or not yours to open.', { cause: e });
  }
  const label = body?.[LABEL] as Partial<PolicyLabel> | undefined;
  if (label?.record !== SPENDING_POLICY_KIND || label.company !== rec.company || label.id !== rec.id || label.version !== rec.version) {
    throw new PolicyNotOpenedHere('What is sealed inside this spending policy says it is another record or another version '
      + 'than the one it is filed as, so it is not believed.');
  }
  if (typeof body.vault !== 'string' || !HEX64.test(body.vault) || typeof body.asset !== 'string' || !HEX64.test(body.asset)) {
    throw new PolicyNotOpenedHere('This spending policy does not say which vault and currency it is for.');
  }
  const opening = policyOpeningFromWire(body.opening);
  return { secrets: { vault: body.vault, asset: body.asset, opening: policyOpeningToWire(opening) }, opening };
};

/**
 * **THE ONE VERSION THAT OPENS WHAT IS ASKED FOR**: the newest version filed
 * for this vault and currency whose opening makes `commitment` under the
 * contract's own `commitmentOf`. A version that will not open, or opens to
 * another vault, currency or commitment, is passed over; when none opens it,
 * the policy is refused, never guessed. `commitment` is what the chain holds,
 * or what a proposal being approved names.
 */
export const policyOpeningFor = async (
  versions: readonly SealedCompanyRecord[],
  me: { readonly signerId: string; readonly wrappingSecret: Hex },
  want: { readonly vault: Hex; readonly asset: Hex; readonly commitment: Hex },
  commitmentOf: (opening: PolicyOpeningOnTheWire) => Hex | Promise<Hex>,
): Promise<{ readonly secrets: SpendingPolicySecrets; readonly opening: PolicyOpening; readonly version: number }> => {
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  const reasons: string[] = [];
  for (const rec of [...versions].sort((a, b) => b.version - a.version)) {
    let opened: ReturnType<typeof openSpendingPolicy>;
    try {
      opened = openSpendingPolicy(rec, me);
    } catch (e) {
      reasons.push((e as Error).message.replace(/ Nothing was built or sent\.$/u, ''));
      continue;
    }
    if (!same(opened.secrets.vault, want.vault) || !same(opened.secrets.asset, want.asset)) continue;
    if (!same(await commitmentOf(opened.secrets.opening), want.commitment)) continue;
    return { ...opened, version: rec.version };
  }
  throw new PolicyNotOpenedHere('None of the company\'s records of this vault\'s spending policy opens the policy the chain '
    + 'holds for it, so this device cannot say what the policy is. Ask a signer who set it to set it again from their device.'
    + (reasons.length === 0 ? '' : ` (${reasons[0]})`));
};
