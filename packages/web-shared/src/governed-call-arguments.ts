/**
 * **WHAT A GOVERNED CALL IS CALLED WITH**: the circuit's arguments made from its order, a proposal's identity
 * made by the account's own functions, and the keys a spending policy is kept under.
 */
import { PAY_KEY_PARTS } from '../../../src/midnight/pay-key-round.js';
import { policyOpeningFromWire, type PolicyOpeningOnTheWire } from '../../../src/midnight/spending-policy-record.js';
import {
  assetKeyMadeHere,
  bytesOf,
  digitsOf,
  governancePayloadOf,
  hexOf,
  policyBarOf,
  policyCommitmentMadeHere,
  removalThresholdOf,
  thresholdOf
} from './governance-payload.js';
import { type GovernedCallDeps, ZERO_32 } from './governed-call-builder.js';
import {
  type GovernedCallOrder,
  type RaiseAdoptionOrder,
  type RaiseGovernanceOrder,
  type RaisePayKeyOrder,
  raisesARun,
  type RoundChangeOnTheWire
} from './governed-call-wire.js';

/**
 * The circuit's arguments, from the order and, for a raise, the `raiseBy` the device read from the
 * proposal's own record, which is the circuit's last argument, its `deadline`.
 */
export function argumentsFor(order: GovernedCallOrder, raiseBy?: string): unknown[] {
  const parts = partsFor(order);
  return order.circuit === 'propose' ? [...parts, deadlineOf(raiseBy)] : parts;
}

/** The last chain time a raise may land at, refused unless this device read it from the proposal's record. */
export const deadlineOf = (raiseBy: string | undefined): bigint => {
  if (raiseBy === undefined) {
    throw new Error(
      "this proposal's record does not carry a signed time of writing, so the time the chain takes its raise by is " +
        "not known and it can never be raised. Nothing was built or sent. Write the change down again from a signer's device, " +
        'which signs its record, and raise that one.'
    );
  }
  return digitsOf('time to send it by', raiseBy);
};

/** The circuit's arguments but a raise's deadline, from the order and from nothing else. */
export function partsFor(order: GovernedCallOrder): unknown[] {
  if (order.circuit === 'approve' || order.circuit === 'cancel')
    return [bytesOf("proposal's identity", order.proposal)];
  if (order.circuit === 'removeSignerAndSetThreshold') {
    /* A removal marks the leaf's own slot vacant. */
    return [
      bytesOf("signer's leaf", order.leaf),
      removalThresholdOf(order.threshold),
      bytesOf("proposal's identity", order.proposal)
    ];
  }
  if (order.circuit === 'setThreshold') {
    return [thresholdOf(order.threshold), bytesOf("proposal's identity", order.proposal)];
  }
  if (order.circuit === 'setVaultThreshold') {
    return [
      bytesOf('vault', order.vault),
      thresholdOf(order.threshold),
      bytesOf("proposal's identity", order.proposal)
    ];
  }
  if (order.circuit === 'adopt') {
    return [bytesOf('vault', order.vault), bytesOf("proposal's identity", order.proposal)];
  }
  if (order.circuit === 'setPolicy') {
    return [
      bytesOf('vault', order.vault),
      bytesOf("policy's commitment", order.commitment),
      bytesOf("proposal's identity", order.proposal)
    ];
  }
  if (order.circuit === 'setPolicyBar') {
    return [policyBarOf(order.bar), bytesOf("proposal's identity", order.proposal)];
  }
  if (order.circuit === 'sealPayKey') {
    if (!Array.isArray(order.wrap) || order.wrap.length !== PAY_KEY_PARTS) {
      throw new Error(
        'a sealed pay-record key is four entries of thirty-two bytes, and this is not. Nothing was built.'
      );
    }
    return [
      order.wrap.map((part) => bytesOf('sealed pay-record key', part)),
      bytesOf("pay-record key's commitment", order.commitment),
      bytesOf("proposal's identity", order.proposal)
    ];
  }
  if (!raisesARun(order)) {
    /*
     * The merged circuit on its governance branch: the payload is passed, the
     * run's own parts are empty, and the vault is the one no vault can equal.
     * The payload and that vault are made where the call is built, from the
     * contract's own functions, so they are not arguments this file can get wrong.
     */
    return [GOVERNANCE_PAYLOAD, ZERO_32, 0n, 0n, 0n, 0n, false, NO_VAULT];
  }
  const r = order.run;
  const payees = digitsOf('number of people paid', r.payees);
  const opensAt = digitsOf("window's opening", r.opensAt);
  const closesAt = digitsOf("window's close", r.closesAt);
  if (payees < 1n) throw new Error('a run pays at least one person, and this one names none. Nothing was built.');
  if (opensAt >= closesAt) throw new Error("this run's window closes before it opens. Nothing was built.");
  /* The merged circuit on its run branch: no opaque payload, and `isRun` set. */
  const required = digitsOf('approvals the run needs', r.required ?? '0');
  return [
    ZERO_32,
    bytesOf('payout root', r.root),
    payees,
    opensAt,
    closesAt,
    required,
    true,
    bytesOf('vault', r.vault)
  ];
}

/** What a raise that is not a run changes: a seat or a threshold, a vault adopted, or the pay-record key committed. */
export const raisedChange = (
  order: RaiseGovernanceOrder | RaiseAdoptionOrder | RaisePayKeyOrder
): RoundChangeOnTheWire => ('adoption' in order ? order.adoption : 'payKey' in order ? order.payKey : order.governance);

/** Stand-ins in a governance raise's arguments, replaced with the contract's own values before the call is built. */
const GOVERNANCE_PAYLOAD = Symbol('the governance payload');
const NO_VAULT = Symbol('no vault');

/** A governance proposal's payload and its identity on the chain, each the hexadecimal of its thirty-two bytes. */
export interface ProposalIdentity {
  readonly digest: string;
  readonly chainId: string;
  /** The value a governance proposal names in place of a vault. */
  readonly noVault: string;
}

/**
 * **THE PAYLOAD A GOVERNANCE CHANGE COMMITS TO, AND ITS IDENTITY UNDER `salt`**,
 * made by the contract's own functions. A device writing a governance proposal
 * down takes both from here, so what it files is what the chain will compute.
 */
export function identityOfAChange(
  deps: Pick<GovernedCallDeps, 'accountPure'>,
  change: RoundChangeOnTheWire,
  salt: string
): ProposalIdentity {
  const P = deps.accountPure;
  const digest = governancePayloadOf(deps, change);
  const noVault = P.noVault();
  return {
    digest: hexOf(digest),
    chainId: hexOf(P.proposalIdOf(digest, noVault, bytesOf("proposal's salt", salt))),
    noVault: hexOf(noVault)
  };
}

/**
 * **WHERE THE CHAIN KEEPS ONE VAULT'S SPENDING POLICY FOR ONE CURRENCY, AND
 * WHAT A POLICY COMMITS TO**, each by the contract's own function: the
 * currency's blinded key (from the currency and the account's blinding), the
 * key the policy's commitment is kept under, the vault's policy marker, the
 * key the approvals a policy change needs are kept under, and, given an
 * opening, the commitment it makes - and, given a run's total too, the
 * approvals its band needs.
 */
export interface SpendingPolicyKeys {
  readonly assetKey: string;
  readonly policyKey: string;
  readonly onKey: string;
  readonly barKey: string;
  readonly commitment: string | null;
  /**
   * Given an opening and a run's total: the approvals the band that total fits
   * needs, as decimal digits, or null when it is above every band - a run the
   * chain will never charge.
   */
  readonly required?: string | null;
}

export function spendingPolicyKeysOf(
  deps: Pick<GovernedCallDeps, 'accountPure'>,
  input: {
    readonly vault: string;
    readonly asset: string;
    readonly assetBlinding: string;
    readonly policy?: PolicyOpeningOnTheWire;
    /** A run's total, as decimal digits; with `policy`, the approvals its band needs are worked out too. */
    readonly total?: string;
  }
): SpendingPolicyKeys {
  const P = deps.accountPure;
  if (
    typeof P.policyKeyOf !== 'function' ||
    typeof P.policyOnKeyOf !== 'function' ||
    typeof P.policyBarKey !== 'function'
  ) {
    throw new Error(
      "this device was not given the account's functions for a spending policy, so nothing was worked out."
    );
  }
  const assetKey = assetKeyMadeHere(deps, input.asset, input.assetBlinding);
  return {
    assetKey,
    policyKey: hexOf(P.policyKeyOf(bytesOf('vault', input.vault), bytesOf("currency's key", assetKey))),
    onKey: hexOf(P.policyOnKeyOf(bytesOf('vault', input.vault))),
    barKey: hexOf(P.policyBarKey()),
    commitment: input.policy === undefined ? null : policyCommitmentMadeHere(deps, input.policy),
    ...(input.policy === undefined || input.total === undefined
      ? {}
      : { required: bandApprovalsMadeHere(deps, input.policy, input.total) })
  };
}

/**
 * The approvals a run of `total` needs under `policy`, by the contract's own
 * function, or null when the total is above every band: the contract refuses
 * such a total, and that refusal is the only one taken as "above every band".
 */
const bandApprovalsMadeHere = (
  deps: Pick<GovernedCallDeps, 'accountPure'>,
  policy: PolicyOpeningOnTheWire,
  total: string
): string | null => {
  if (typeof deps.accountPure.bandApprovals !== 'function') {
    throw new Error(
      "this device was not given the account's function for a policy's bands, so nothing was worked out."
    );
  }
  const opening = policyOpeningFromWire(policy);
  const amount = digitsOf("run's total", total);
  try {
    return deps.accountPure.bandApprovals(opening.terms.bands, amount).toString();
  } catch (e) {
    if (/above every band/u.test(String((e as Error)?.message ?? e))) return null;
    throw e;
  }
};

/** The arguments as the circuit is handed them, with the contract's own payload and no-vault in place. */
export const argumentsBuilt = (deps: Pick<GovernedCallDeps, 'accountPure'>, order: GovernedCallOrder): unknown[] => {
  const args = partsFor(order);
  if (order.circuit !== 'propose' || raisesARun(order)) return args;
  return args.map((a) =>
    a === GOVERNANCE_PAYLOAD
      ? governancePayloadOf(deps, raisedChange(order))
      : a === NO_VAULT
        ? deps.accountPure.noVault()
        : a
  );
};
