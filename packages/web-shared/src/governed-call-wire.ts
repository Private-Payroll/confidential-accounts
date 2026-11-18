/**
 * **A CALL TO THE COMPANY ACCOUNT AS IT CROSSES FROM THE PAGE**: a raise's two halves, a run, a change to the
 * company, and the order a governed call is built from, each in the plain values a message carries.
 */
import type { RetirementTerms } from '../../../src/core/proposal-filing.js';
import type { MadeHere, VouchedHere } from './what-this-device-made.js';
import type { PolicyOpeningOnTheWire } from '../../../src/midnight/spending-policy-record.js';

/**
 * **THE ACCOUNT'S HALF OF A RAISE**, as the company's service hands it over.
 * Every value is the hexadecimal of its thirty-two bytes, except the amount,
 * which is decimal digits.
 */
export interface RaiseHalfOnTheWire {
  readonly assetId: string;
  readonly assetBlinding: string;
  readonly proposalSalt: string;
  readonly changeAmount: string;
  readonly changeBatchDigest: string;
}

/** The run a raise opens, as the chain is asked to open it. */
export interface RunOnTheWire {
  readonly root: string;
  readonly payees: string;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly vault: string;
  /** The approvals the run's total needs, bound into its identity. Absent is zero. */
  readonly required?: string;
}

/**
 * **A GOVERNANCE ROUND, AS THE DEVICE IS ASKED TO RAISE IT.** Only the change
 * itself is named: the device makes the proposal's payload from it with the
 * contract's own function, so the payload proved is the one for the seat or the
 * threshold this person was shown, and never a digest handed over as bytes.
 */
export type GovernanceOnTheWire =
  /**
   * An invitation to seat whoever holds an address: the hiding commitment to
   * the address (`inviteAddressOf`), the rights the seat will carry, and the
   * threshold the account needs once the seat is taken, as digits, where none
   * or 0 keeps the threshold in force. The invitee takes the seat from their own
   * wallet once it is approved.
   */
  | { readonly kind: 'add-signer'; readonly address: string; readonly scope: string; readonly threshold?: string }
  /**
   * A seated signer's leaf, taken off the account, and the threshold the account needs once they are gone: a whole number
   * as digits, where none or 0 keeps the threshold in force.
   */
  | { readonly kind: 'remove-signer'; readonly leaf: string; readonly threshold?: string }
  | { readonly kind: 'threshold'; readonly threshold: string }
  /** One vault's own approvals needed: the vault's address, and the number. */
  | { readonly kind: 'vault-threshold'; readonly vault: string; readonly threshold: string }
  /**
   * One vault's spending policy for one currency: the vault, the currency's
   * blinded key and the commitment to the policy. The policy itself is never
   * on the proposal; it is in the company's record of it, sealed to the signers.
   */
  | { readonly kind: 'spending-policy'; readonly vault: string; readonly assetKey: string; readonly commitment: string }
  /** The approvals any change to a spending policy needs. */
  | { readonly kind: 'policy-bar'; readonly bar: string }
  /**
   * The company's record anchor moved past a batch nobody can check, resuming
   * from the header whose head is `resumesFrom` (`recoverAnchor`), before
   * `latest`, the last time it may be carried out, in whole seconds since
   * 1970 as the chain's block time counts them. `lastRecovery` is the head the
   * latest recovery carried out wrote, thirty-two zero bytes before any: the
   * account carries this one out only while that is still its latest, so a
   * recovery approved before another is carried out can never be used after it.
   */
  | { readonly kind: 'recover-anchor'; readonly resumesFrom: string; readonly latest: string; readonly lastRecovery: string }
  /** A vault taken out of the company's account; the vault itself carries it out once it holds no money. */
  | { readonly kind: 'retire-vault'; readonly vault: string };

/**
 * **THE COMPANY'S ACCOUNT TAKING A NEW VAULT AS ITS OWN**, named by the vault's
 * address: the proposal a vault's creation raises from the device that made it.
 * Its payload is made the same way, by the contract's own function.
 */
interface AdoptionOnTheWire { readonly kind: 'adopt-vault'; readonly vault: string }

/**
 * **THE COMPANY'S ACCOUNT COMMITTED TO ITS PAY-RECORD KEY**, named by the
 * commitment to the key: the proposal a company's creation raises from its
 * founding signer's device. Its payload is made by the contract's own function.
 */
interface PayKeyOnTheWire { readonly kind: 'pay-key'; readonly commitment: string }

/** Any change a governance round on the account makes: a seat, a threshold, a vault adopted, or the pay-record key committed. */
export type RoundChangeOnTheWire = GovernanceOnTheWire | AdoptionOnTheWire | PayKeyOnTheWire;

/** Raising a payroll run. */
export interface RaiseRunOrder {
  readonly circuit: 'propose'; readonly run: RunOnTheWire; readonly half: RaiseHalfOnTheWire;
  /** The identity the service wrote the proposal down under; the device recomputes it and refuses a mismatch. */
  readonly proposal: string;
}

/** Raising a round that seats a signer or changes the account's threshold. */
export interface RaiseGovernanceOrder {
  readonly circuit: 'propose'; readonly governance: GovernanceOnTheWire; readonly half: RaiseHalfOnTheWire;
  /** The identity the service wrote the proposal down under; the device recomputes it and refuses a mismatch. */
  readonly proposal: string;
}

/** Raising the proposal that adopts a new vault, with the identity this device made for it. */
export interface RaiseAdoptionOrder {
  readonly circuit: 'propose'; readonly adoption: AdoptionOnTheWire; readonly half: RaiseHalfOnTheWire;
  readonly proposal: string;
}

/** Raising the proposal that commits the account to its pay-record key, with the identity this device made for it. */
export interface RaisePayKeyOrder {
  readonly circuit: 'propose'; readonly payKey: PayKeyOnTheWire; readonly half: RaiseHalfOnTheWire;
  readonly proposal: string;
}

/**
 * **WHAT TO BUILD.** One shape per call a device makes here. `proposal` is the
 * proposal's identity on the chain; `proposalSalt` is the salt that identity
 * was made with, which the seating and threshold circuits recompute it from.
 */
export type GovernedCallOrder =
  | RaiseRunOrder
  | RaiseGovernanceOrder
  | RaiseAdoptionOrder
  | RaisePayKeyOrder
  | {
    readonly circuit: 'approve'; readonly proposal: string;
    /**
     * For a seat or a threshold change: the change this person was asked to
     * approve and the salt the proposal's identity was made with. The identity is
     * remade from them and an approval of any other proposal is refused.
     */
    readonly of?: { readonly governance: RoundChangeOnTheWire; readonly proposalSalt: string };
  }
  /**
   * Taking a seated signer's leaf off the account, on an approved removal, and setting the threshold to `threshold`, or
   * keeping the one in force when it is "0". A seat is never carried out here: the invitee takes it.
   */
  | {
    readonly circuit: 'removeSignerAndSetThreshold'; readonly leaf: string; readonly threshold: string;
    readonly proposal: string; readonly proposalSalt: string; readonly removing: true;
  }
  | { readonly circuit: 'setThreshold'; readonly threshold: string; readonly proposal: string; readonly proposalSalt: string }
  /** Carrying out an approved change of one vault's own approvals needed. */
  | {
    readonly circuit: 'setVaultThreshold'; readonly vault: string; readonly threshold: string;
    readonly proposal: string; readonly proposalSalt: string;
  }
  /**
   * Carrying out an approved spending policy: the vault and the commitment the
   * proposal names, and the three the circuit reads off this device - the
   * currency, the account's blinding its key is made with, and the policy's
   * opening, which must make the commitment.
   */
  | {
    readonly circuit: 'setPolicy'; readonly vault: string; readonly commitment: string;
    readonly proposal: string; readonly proposalSalt: string;
    readonly asset: string; readonly assetBlinding: string; readonly policy: PolicyOpeningOnTheWire;
  }
  /** Carrying out an approved change to the approvals any change to a spending policy needs. */
  | { readonly circuit: 'setPolicyBar'; readonly bar: string; readonly proposal: string; readonly proposalSalt: string }
  /**
   * Withdrawing an open proposal: a run before its window opens, by any signer;
   * any other proposal only by the signer who raised it, as the chain checks.
   */
  | { readonly circuit: 'cancel'; readonly proposal: string }
  /** Carrying out an approved adoption: the vault joins the account's vaults. */
  | { readonly circuit: 'adopt'; readonly vault: string; readonly proposal: string; readonly proposalSalt: string }
  /**
   * Sealing the pay-record key to this signer, as four entries; the first to
   * seal also writes the commitment, under the approved round named.
   */
  | {
    readonly circuit: 'sealPayKey'; readonly wrap: readonly string[]; readonly commitment: string;
    readonly proposal: string; readonly proposalSalt: string;
  };

/**
 * **WHAT THIS DEVICE OPENED ITSELF** from the company's records, with the
 * viewing key it holds: the proposal's own record and the payload sealed inside
 * it, and the company's roster for the leaf of a person to be seated. Every
 * value is the hexadecimal of its thirty-two bytes except the threshold and the
 * amount, which are decimal digits. The service's order is checked against
 * this, and the call is proved with this.
 */
export interface OpenedRound {
  /** The identity the proposal's record carries, and the payload and vault it is made from with the salt. */
  readonly chainId: string;
  readonly digest: string;
  readonly vault: string;
  /** The salt sealed inside the proposal. */
  readonly salt: string;
  /**
   * For a payroll run: what its salt was made from, sealed inside the proposal
   * beside it - the head its raiser checked and a random value - and whether
   * this device checked that head itself (`refuseWhatThisDeviceDidNotMake`).
   */
  readonly vouched?: VouchedHere;
  /** What the person is shown for this proposal. */
  readonly summary: string;
  /**
   * For an invitation or a threshold change: the change the proposal names, read
   * from the company's own record of it. For a vault adopted: that vault. For
   * the pay-record key: the commitment to the key this device holds.
   */
  readonly governance?: RoundChangeOnTheWire;
  /** For a raise: the change sealed inside the proposal. */
  readonly half?: Omit<RaiseHalfOnTheWire, 'proposalSalt' | 'assetBlinding'>;
  /** For a signer's removal: the retirement of its seat the proposal carries, which each approving device signs. */
  readonly retirement?: RetirementTerms;
  /**
   * The filing key of the seat whose signed filing of this proposal this device believed when it opened it, as the
   * company's records anchor it; absent for one that carries no signed filing.
   */
  readonly filedBy?: string;
  /**
   * For an approval that changes no seat or setting: what the proposal pays, as
   * this device made it again from the company's records (`refuseWhatThisDeviceDidNotMake`).
   */
  readonly made?: MadeHere;
  /**
   * Opened to be withdrawn: the kind the proposal's sealed record names, so the person's own wallet can refuse a
   * withdrawal of a kind other than the one shown, or of a kind it never withdraws.
   */
  readonly kind?: string;
  /** Opened to be withdrawn, a signer's removal: the leaf it would take off, as its sealed record names it. */
  readonly removes?: string;
  /**
   * For a raise, and for a withdrawal of a proposal written down: the last chain time, in whole seconds as digits,
   * at which its raise may land (`raiseByOf`), from the time its signed record says it was written down. A raise
   * carries it as the circuit's `deadline`, so every send of one record carries the one deadline.
   */
  readonly raiseBy?: string;
}

/** Each value, as the person reading a refusal would name it. */
const SAID: Readonly<Record<string, string>> = {
  'proposal identity': 'proposal', salt: 'proposal', change: 'proposal', vault: 'proposal',
  'run vault': 'account this run pays from', leaf: 'signer being removed', invitation: 'person being invited',
  threshold: 'number of approvals required', 'vault adopted': 'vault being adopted', 'pay-record key': 'company\'s pay-record key',
  run: 'payroll run', asset: 'token', amount: 'amount',
  'payments digest': 'list of payments', policy: 'spending policy',
  'policy bar': 'number of approvals a change to a spending policy needs',
  recovery: 'recovery of the company\'s records',
};
/** What not to do if the refusal comes back, for each call a device makes. */
const IF_AGAIN: Readonly<Record<string, string>> = {
  approve: 'do not approve it', propose: 'do not send it', removeSignerAndSetThreshold: 'do not remove this signer',
  setThreshold: 'do not make this change', adopt: 'do not adopt this vault', sealPayKey: 'do not seal this key',
  setVaultThreshold: 'do not make this change', cancel: 'do not withdraw it',
  setPolicy: 'do not set this policy', setPolicyBar: 'do not make this change',
};

/**
 * **A VALUE THE SERVICE SENT THAT IS NOT THE ONE THIS DEVICE OPENED.** `value`
 * names it exactly, for whoever reads the refusal afterwards; the sentence names
 * it in the words of the page it is shown on.
 */
export class NotWhatThisDeviceOpened extends Error {
  constructor(readonly value: string, circuit: string) {
    super(
      `the ${SAID[value] ?? 'proposal'} the service sent to this device does not match the company's own record of this `
        + 'proposal, which this device read itself. Nothing was built or sent. Reload the page and try again. If it '
        + `happens again, ${IF_AGAIN[circuit] ?? 'do not act on it'}.`,
    );
    this.name = 'NotWhatThisDeviceOpened';
  }
}

/** A record whose own contents do not make the identity it carries: nothing sent it here, it disagrees with itself. */
export class RecordDoesNotAddUp extends Error {
  readonly value = 'record';
  constructor(circuit: string) {
    super(
      'the company\'s record of this proposal does not add up, so this device will not act on it. Nothing was built or '
        + `sent. Reload the page and try again. If it happens again, ${IF_AGAIN[circuit] ?? 'do not act on it'}.`,
    );
    this.name = 'RecordDoesNotAddUp';
  }
}

/** Whether a raise is for a run rather than for a governance round. */
export const raisesARun = (order: GovernedCallOrder): order is RaiseRunOrder =>
  order.circuit === 'propose' && 'run' in order;

/** The account as one block saw it. Both values are their bytes. */
export interface AccountCallChain {
  readonly accountState: Uint8Array;
  readonly parameters: Uint8Array;
}
