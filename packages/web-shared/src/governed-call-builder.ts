/**
 * **A PROPOSAL RAISED, OR A PROPOSAL APPROVED, BUILT AND PROVED ON THE SIGNER'S OWN
 * DEVICE.**
 *
 * Both calls open with the contract's signer check, which reads three values
 * off the calling device - the signer's secret key, their blinding and their
 * scope - and a path through the public signer tree. Those three exist in one
 * place, the signer's own keyring, so these calls can only be built where the
 * keyring is open. **RUNS IN THE PROVING WORKER**, where the contract runtime
 * and the prover are allowed to load; the page asks for it through
 * `vault-worker-client.ts`.
 *
 * -- THERE IS NO PRIVATE-STATE STORE HERE, AND THAT IS THE DESIGN ----------
 *
 * The usual client hands the call builder a store and a key, and the builder
 * reads the record the circuit needs out of the store. That shape is a
 * capability: whatever holds the store can ask it for any record it holds, at
 * any time. **The call builder used here takes the record itself, as a value,
 * for one call.** So the record is composed in memory from what this call was
 * handed, used for exactly this call, and then its three secret fields are
 * overwritten. Nothing is looked up, nothing is kept, and there is no second
 * question anything here could answer.
 *
 * **WHAT THAT REMOVES, AND WHY IT MATTERS FOR A PAYROLL RUN.** The store-based
 * client writes the record back after every call that settles, as it was when
 * that call STARTED. Anything staged into the store while the call was being
 * proved is silently put back, and the field that would be put back is the
 * salt a proposal's identity is recomputed from. A payroll run is several such
 * calls in a row. **Here there is no store to write back into**: every call is
 * composed from its own order, so a second call cannot read what a first call
 * left behind, and a first call cannot overwrite what a second call staged.
 * Several calls through one client, one after another or at once, share
 * nothing.
 *
 * **WHAT THAT DESIGN RESTS ON, CHECKED ON EVERY CALL RATHER THAN ASSUMED.** It
 * is correct only while no circuit changes the record: the contract's
 * witnesses today hand back the record they were given, unchanged. A circuit
 * that one day wrote something into it would expect that write to be there for
 * the next call, and dropping the record would lose it without a word. So the
 * record a call finishes with is compared with the record it started with, and
 * a call that changed it is refused before it is proved.
 *
 * -- WHAT THIS IS HANDED, AND WHERE EACH PART COMES FROM --------------------
 *
 *   the signer's three    from the keyring the person opened on this device.
 *                         A scope that is absent is refused by name: it is part
 *                         of the leaf, and a record composed without it proves
 *                         the person is not a signer, on a device that looks
 *                         healthy.
 *   the account's half    for a raise only: the asset, the account's asset
 *                         blinding, the salt and the change the proposal commits
 *                         to. The service hands them over. All but the blinding
 *                         are also opened on the page from the proposal's own
 *                         sealed record, with the viewing key; the record is
 *                         composed from what was opened, and a value the
 *                         service handed that is not the opened one is refused
 *                         by name before anything is built. The blinding is the
 *                         service's: it is kept only inside the account's sealed
 *                         state beside things a signer's page is not handed, and
 *                         what it feeds - the change commitment a raise records -
 *                         is read back by no circuit. An approval reads none of
 *                         them, and a record for an approval refuses by name if
 *                         a circuit ever asks for one.
 *   the salt              for a seat or a threshold change, the one sealed
 *                         inside the proposal, from the same opening.
 *   the chain             the account's contract state and the ledger
 *                         parameters, both as one block saw them.
 *
 * **WHAT LEAVES THIS FILE IS A PROVEN TRANSACTION.** It carries no coin of
 * anybody's: a raise and an approval move nothing, and the two public keys the
 * call builder asks for are made from randomness nobody keeps.
 */
import type { AccountPrivateState } from '../../../contracts/src/witnesses.js';
import { fromHex } from '../../../src/core/crypto.js';
import { CIRCUITS_THAT_READ_NO_WITNESS } from '../../../src/midnight/governed-call.js';
import { ACCOUNT_CIRCUITS_A_DEVICE_GOVERNS } from '../../../src/midnight/vault-contract.js';
import { PAY_KEY_PARTS } from '../../../src/midnight/pay-key-round.js';
import { signerHalfOf, type SignerMaterial } from './private-state.js';
import { refuseWhatThisDeviceDidNotMake, type AccountLedgerView, type MadeHere } from './what-this-device-made.js';
import { sameGovernance } from './governance-compared.js';
import type { DetailsOfKind } from '../../../src/midnight/payout-tree.js';
import type { AccountStartPure, VaultStartPure } from '../../../src/midnight/vault-start.js';
import { policyOpeningFromWire, type PolicyOpeningOnTheWire } from '../../../src/midnight/spending-policy-record.js';
import type { PolicyOpening } from '../../../contracts/src/witnesses.js';

export type { SignerMaterial } from './private-state.js';

const HEX64 = /^[0-9a-f]{64}$/u;
const DIGITS = /^[0-9]+$/u;
const ZERO_32 = new Uint8Array(32);

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
  | { readonly kind: 'add-signer'; readonly leaf: string }
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
  | { readonly kind: 'policy-bar'; readonly bar: string };

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
interface RaiseGovernanceOrder {
  readonly circuit: 'propose'; readonly governance: GovernanceOnTheWire; readonly half: RaiseHalfOnTheWire;
  /** The identity the service wrote the proposal down under; the device recomputes it and refuses a mismatch. */
  readonly proposal: string;
}

/** Raising the proposal that adopts a new vault, with the identity this device made for it. */
interface RaiseAdoptionOrder {
  readonly circuit: 'propose'; readonly adoption: AdoptionOnTheWire; readonly half: RaiseHalfOnTheWire;
  readonly proposal: string;
}

/** Raising the proposal that commits the account to its pay-record key, with the identity this device made for it. */
interface RaisePayKeyOrder {
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
  | { readonly circuit: 'amendSigner'; readonly leaf: string; readonly proposal: string; readonly proposalSalt: string }
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
  /** What the person is shown for this proposal. */
  readonly summary: string;
  /**
   * For a seat or a threshold change: the change the proposal names, the leaf
   * read from the company's own roster. For a vault adopted: that vault. For
   * the pay-record key: the commitment to the key this device holds.
   */
  readonly governance?: RoundChangeOnTheWire;
  /** For a raise: the change sealed inside the proposal. */
  readonly half?: Omit<RaiseHalfOnTheWire, 'proposalSalt' | 'assetBlinding'>;
  /**
   * For an approval that changes no seat or setting: what the proposal pays, as
   * this device made it again from the company's records (`refuseWhatThisDeviceDidNotMake`).
   */
  readonly made?: MadeHere;
}

/** Each value, as the person reading a refusal would name it. */
const SAID: Readonly<Record<string, string>> = {
  'proposal identity': 'proposal', salt: 'proposal', change: 'proposal', vault: 'proposal',
  'run vault': 'account this run pays from', leaf: 'person being given access',
  threshold: 'number of approvals required', 'vault adopted': 'vault being adopted', 'pay-record key': 'company\'s pay-record key',
  run: 'payroll run', asset: 'token', amount: 'amount',
  'payments digest': 'list of payments', policy: 'spending policy',
  'policy bar': 'number of approvals a change to a spending policy needs',
};
/** What not to do if the refusal comes back, for each call a device makes. */
const IF_AGAIN: Readonly<Record<string, string>> = {
  approve: 'do not approve it', propose: 'do not send it', amendSigner: 'do not grant this access',
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

export interface GovernedCallDeps {
  /** `@midnightntwrk/ledger-v9`. */
  readonly ledger: any;
  /** `@midnight-ntwrk/compact-runtime`'s `ContractState`. */
  readonly runtimeState: { deserialize(bytes: Uint8Array): unknown };
  /**
   * **THE ONE CALL BUILDER, AND IT IS THE ONE THAT TAKES THE RECORD AS A
   * VALUE.** The type names nothing else, so the entry points that read and
   * write a store cannot be reached through this object.
   */
  readonly contracts: {
    createUnprovenCallTxFromInitialStates(...args: any[]): Promise<any>;
  };
  /** The company account's compiled contract, with the account's own witnesses. */
  readonly accountCompiled: unknown;
  /** Hands out the account circuits' verifying keys. */
  readonly accountZkConfig: unknown;
  /** Proves an unproven transaction for the circuit it names. */
  readonly prove: (unproven: any, circuit?: string) => Promise<{ serialize(): Uint8Array }>;
  /** The company account's own pure circuits, which make a proposal's identity from its parts. */
  readonly accountPure: {
    runPayload(root: Uint8Array, payees: bigint, opensAt: bigint, closesAt: bigint, required: bigint): Uint8Array;
    proposalIdOf(payload: Uint8Array, vault: Uint8Array, salt: Uint8Array): Uint8Array;
    signerAddPayload(leaf: Uint8Array): Uint8Array;
    setThresholdPayload(threshold: bigint): Uint8Array;
    /** Present where a vault's own approvals needed are changed; asked for only then. */
    setVaultThresholdPayload?(vault: Uint8Array, threshold: bigint): Uint8Array;
    /** Present where a vault's adoption is built; asked for only then. */
    adoptVaultPayload?(vault: Uint8Array): Uint8Array;
    /** Present where the pay-record key's round is built; asked for only then. */
    payKeyPayload?(commitment: Uint8Array): Uint8Array;
    /** The commitment to a pay-record key, and where the account keeps it; asked for only when a payroll run is approved. */
    payKeyCommitmentOf?(key: Uint8Array): Uint8Array;
    payKeyCommitmentKey?(): Uint8Array;
    /** Where the account marks a vault that pays only runs cleared against its spending policy. */
    policyOnKeyOf?(vault: Uint8Array): Uint8Array;
    /** Present where a spending policy or the approvals a policy change needs are set; asked for only then. */
    setPolicyPayload?(vault: Uint8Array, assetKey: Uint8Array, commitment: Uint8Array): Uint8Array;
    setPolicyBarPayload?(bar: bigint): Uint8Array;
    assetKeyOf?(asset: Uint8Array, blinding: Uint8Array): Uint8Array;
    policyCommitmentOf?(policy: PolicyOpening): Uint8Array;
    /** Where the chain keeps a vault's policy for one currency, and the approvals a policy change needs. */
    policyKeyOf?(vault: Uint8Array, assetKey: Uint8Array): Uint8Array;
    policyBarKey?(): Uint8Array;
    /** The approvals a run of a total needs under a policy's bands: the first band its total fits. */
    bandApprovals?(bands: PolicyOpening['terms']['bands'], total: bigint): bigint;
    noVault(): Uint8Array;
  };
  /** Reads the account's ledger out of its contract state's data; what an approval is checked against on the chain. */
  readonly accountLedger?: (data: unknown) => unknown;
  /** The vault's two details circuits, which a payee's leaf is made with when a run is rebuilt here. */
  readonly vaultDetails?: DetailsOfKind;
  /** The vault's own pure circuits, which a vault's first secret run is made again with. */
  readonly vaultPure?: VaultStartPure;
  readonly random?: (n: number) => Uint8Array;
}

/**
 * **A FIELD AN APPROVAL NEVER READS.** Reading one means the circuit has
 * changed under this device, and answering with any value would be answering
 * with a guess.
 */
export class NotReadByAnApproval extends Error {
  constructor(readonly field: string) {
    super(
      `approving a proposal read "${field}" from this device, and an approval has never needed it. ` +
        'The company\'s contract is not the one this page was built for; nothing was built or sent. ' +
        'Reload the page to use the current build.',
    );
    this.name = 'NotReadByAnApproval';
  }
}

/** A circuit that changed the record it was handed, which this design would drop. */
export class RecordChangedByTheCall extends Error {
  constructor(readonly circuit: string) {
    super(
      `the "${circuit}" call changed this device's record for the company, and nothing here keeps a ` +
        'record between calls, so the change would be lost. Nothing was proved or sent. The ' +
        'company\'s contract is not the one this page was built for.',
    );
    this.name = 'RecordChangedByTheCall';
  }
}

const bytesOf = (name: string, value: string): Uint8Array => {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    throw new Error(`the ${name} this proposal was handed is not thirty-two bytes, so nothing was built.`);
  }
  return fromHex(value);
};
const digitsOf = (name: string, value: string): bigint => {
  if (typeof value !== 'string' || !DIGITS.test(value)) {
    throw new Error(`the ${name} this proposal was handed is not a whole number, so nothing was built.`);
  }
  return BigInt(value);
};

const ACCOUNT_FIELDS = ['assetBlinding', 'assetId', 'proposalSalt', 'changeAmount', 'changeBatchDigest'] as const;

/**
 * **THE RECORD FOR ONE CALL, COMPOSED NOW AND USED ONCE.**
 *
 * The signer's three come first and are refused by name if any is missing or
 * the wrong width - the scope included. For a raise the account's half is the
 * one this device read from the proposal's own record, and the asset blinding
 * is the order's. Seating a signer, changing the threshold and adopting a vault
 * read one account field, the salt the approved round's identity was made with, and it is the one
 * sealed in the proposal. Given no record read here - which `buildGovernedCall`
 * never builds without - each is read off the order. Every other account field
 * is a refusal rather than a value. The two membership-path fields are set here and from
 * nowhere else, so nothing handed in can put a path into the record.
 */
export function recordForOneCall(order: GovernedCallOrder, material: SignerMaterial, opened?: OpenedRound): AccountPrivateState {
  const signer = signerHalfOf(material);
  if (order.circuit === 'propose') {
    /* What this device opened, when it did; `buildGovernedCall` never builds without it. */
    const h = opened?.half ?? order.half;
    return {
      ...signer,
      assetId: bytesOf('asset', h.assetId),
      assetBlinding: bytesOf('account\'s asset blinding', order.half.assetBlinding),
      proposalSalt: bytesOf('proposal\'s salt', opened?.salt ?? order.half.proposalSalt),
      changeAmount: digitsOf('change amount', h.changeAmount),
      changeBatchDigest: bytesOf('change digest', h.changeBatchDigest),
      pinnedPath: null,
    };
  }
  const record = { ...signer, pinnedPath: null } as AccountPrivateState;
  const salt = order.circuit === 'amendSigner' || order.circuit === 'setThreshold' || order.circuit === 'adopt'
    || order.circuit === 'sealPayKey' || order.circuit === 'setVaultThreshold' || order.circuit === 'setPolicy'
    || order.circuit === 'setPolicyBar'
    ? bytesOf('proposal\'s salt', opened?.salt ?? order.proposalSalt) : null;
  /* Setting a policy reads the currency and the account's blinding its key is made with, and the policy's opening. */
  const policyFields: Partial<Record<(typeof ACCOUNT_FIELDS)[number], Uint8Array>> = order.circuit === 'setPolicy'
    ? { assetId: bytesOf('currency', order.asset), assetBlinding: bytesOf('account\'s asset blinding', order.assetBlinding) } : {};
  if (order.circuit === 'setPolicy') {
    Object.defineProperty(record, 'policy', { enumerable: true, value: policyOpeningFromWire(order.policy) });
  }
  for (const field of ACCOUNT_FIELDS) {
    if (field === 'proposalSalt' && salt !== null) {
      Object.defineProperty(record, field, { enumerable: true, value: salt });
      continue;
    }
    const given = policyFields[field];
    if (given !== undefined) {
      Object.defineProperty(record, field, { enumerable: true, value: given });
      continue;
    }
    Object.defineProperty(record, field, {
      enumerable: false,
      get: () => { throw new NotReadByAnApproval(field); },
    });
  }
  return record;
}

/** A threshold, as the digits it travels as, refused unless it is a whole number of at least one. */
const thresholdOf = (value: string): bigint => {
  const t = digitsOf('threshold', value);
  if (t < 1n) throw new Error('a company\'s threshold is at least one, and this one is not. Nothing was built.');
  return t;
};

/** The approvals a change to a spending policy needs, refused unless it is a whole number of at least one. */
const policyBarOf = (value: string): bigint => {
  const t = digitsOf('number of approvals a policy change needs', value);
  if (t < 1n) throw new Error('a change to a spending policy needs at least one approval, and this number is not. Nothing was built.');
  return t;
};

/** The circuit's arguments, from the order and from nothing else. */
export function argumentsFor(order: GovernedCallOrder): unknown[] {
  if (order.circuit === 'approve' || order.circuit === 'cancel') return [bytesOf('proposal\'s identity', order.proposal)];
  if (order.circuit === 'amendSigner') {
    /* Seating, never removing, and appended rather than put into a vacated slot. */
    return [bytesOf('signer\'s leaf', order.leaf), bytesOf('proposal\'s identity', order.proposal), false, false];
  }
  if (order.circuit === 'setThreshold') {
    return [thresholdOf(order.threshold), bytesOf('proposal\'s identity', order.proposal)];
  }
  if (order.circuit === 'setVaultThreshold') {
    return [bytesOf('vault', order.vault), thresholdOf(order.threshold), bytesOf('proposal\'s identity', order.proposal)];
  }
  if (order.circuit === 'adopt') {
    return [bytesOf('vault', order.vault), bytesOf('proposal\'s identity', order.proposal)];
  }
  if (order.circuit === 'setPolicy') {
    return [bytesOf('vault', order.vault), bytesOf('policy\'s commitment', order.commitment), bytesOf('proposal\'s identity', order.proposal)];
  }
  if (order.circuit === 'setPolicyBar') {
    return [policyBarOf(order.bar), bytesOf('proposal\'s identity', order.proposal)];
  }
  if (order.circuit === 'sealPayKey') {
    if (!Array.isArray(order.wrap) || order.wrap.length !== PAY_KEY_PARTS) {
      throw new Error('a sealed pay-record key is four entries of thirty-two bytes, and this is not. Nothing was built.');
    }
    return [order.wrap.map((part) => bytesOf('sealed pay-record key', part)), bytesOf('pay-record key\'s commitment', order.commitment),
      bytesOf('proposal\'s identity', order.proposal)];
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
  const opensAt = digitsOf('window\'s opening', r.opensAt);
  const closesAt = digitsOf('window\'s close', r.closesAt);
  if (payees < 1n) throw new Error('a run pays at least one person, and this one names none. Nothing was built.');
  if (opensAt >= closesAt) throw new Error('this run\'s window closes before it opens. Nothing was built.');
  /* The merged circuit on its run branch: no opaque payload, and `isRun` set. */
  const required = digitsOf('approvals the run needs', r.required ?? '0');
  return [ZERO_32, bytesOf('payout root', r.root), payees, opensAt, closesAt, required, true, bytesOf('vault', r.vault)];
}

/** The contract's own payload for adopting `vault`, refused by name where this device was not given the function. */
const adoptionPayloadOf = (deps: Pick<GovernedCallDeps, 'accountPure'>, vault: string): Uint8Array => {
  if (typeof deps.accountPure.adoptVaultPayload !== 'function') {
    throw new Error('this device was not given the account\'s function for adopting a vault, so nothing was built.');
  }
  return deps.accountPure.adoptVaultPayload(bytesOf('vault', vault));
};

/** The contract's own payload for one vault's approvals needed, refused by name where this device was not given the function. */
const vaultThresholdPayloadOf = (deps: Pick<GovernedCallDeps, 'accountPure'>, vault: string, threshold: string): Uint8Array => {
  if (typeof deps.accountPure.setVaultThresholdPayload !== 'function') {
    throw new Error('this device was not given the account\'s function for a vault\'s approvals needed, so nothing was built.');
  }
  return deps.accountPure.setVaultThresholdPayload(bytesOf('vault', vault), thresholdOf(threshold));
};

/** The contract's own payload for committing to the pay-record key, refused by name where this device was not given the function. */
const payKeyPayloadOf = (deps: Pick<GovernedCallDeps, 'accountPure'>, commitment: string): Uint8Array => {
  if (typeof deps.accountPure.payKeyPayload !== 'function') {
    throw new Error('this device was not given the account\'s function for its pay-record key, so nothing was built.');
  }
  return deps.accountPure.payKeyPayload(bytesOf('pay-record key\'s commitment', commitment));
};

/** The contract's own payload for a vault's spending policy, refused by name where this device was not given the function. */
const spendingPolicyPayloadOf = (deps: Pick<GovernedCallDeps, 'accountPure'>, vault: string, assetKey: string, commitment: string): Uint8Array => {
  if (typeof deps.accountPure.setPolicyPayload !== 'function') {
    throw new Error('this device was not given the account\'s function for a spending policy, so nothing was built.');
  }
  return deps.accountPure.setPolicyPayload(bytesOf('vault', vault), bytesOf('currency\'s key', assetKey), bytesOf('policy\'s commitment', commitment));
};

/** The contract's own payload for the approvals a policy change needs, refused by name where this device was not given the function. */
const policyBarPayloadOf = (deps: Pick<GovernedCallDeps, 'accountPure'>, bar: string): Uint8Array => {
  if (typeof deps.accountPure.setPolicyBarPayload !== 'function') {
    throw new Error('this device was not given the account\'s function for the approvals a policy change needs, so nothing was built.');
  }
  return deps.accountPure.setPolicyBarPayload(policyBarOf(bar));
};

/** The currency's blinded key, made by the contract's own function from the currency and the account's blinding. */
const assetKeyMadeHere = (deps: Pick<GovernedCallDeps, 'accountPure'>, asset: string, blinding: string): string => {
  if (typeof deps.accountPure.assetKeyOf !== 'function') {
    throw new Error('this device was not given the account\'s function for a currency\'s key, so nothing was built.');
  }
  return hexOf(deps.accountPure.assetKeyOf(bytesOf('currency', asset), bytesOf('account\'s asset blinding', blinding)));
};

/** The commitment a policy's opening makes, by the contract's own function. */
const policyCommitmentMadeHere = (deps: Pick<GovernedCallDeps, 'accountPure'>, policy: PolicyOpeningOnTheWire): string => {
  if (typeof deps.accountPure.policyCommitmentOf !== 'function') {
    throw new Error('this device was not given the account\'s function for a policy\'s commitment, so nothing was built.');
  }
  return hexOf(deps.accountPure.policyCommitmentOf(policyOpeningFromWire(policy)));
};

/** What a raise that is not a run changes: a seat or a threshold, a vault adopted, or the pay-record key committed. */
const raisedChange = (order: RaiseGovernanceOrder | RaiseAdoptionOrder | RaisePayKeyOrder): RoundChangeOnTheWire =>
  ('adoption' in order ? order.adoption : 'payKey' in order ? order.payKey : order.governance);

/** Stand-ins in a governance raise's arguments, replaced with the contract's own values before the call is built. */
const GOVERNANCE_PAYLOAD = Symbol('the governance payload');
const NO_VAULT = Symbol('no vault');

/** The payload a governance round commits to, made by the contract's own function from the change named. */
export function governancePayloadOf(deps: Pick<GovernedCallDeps, 'accountPure'>, g: RoundChangeOnTheWire): Uint8Array {
  if (g.kind === 'add-signer') return deps.accountPure.signerAddPayload(bytesOf('signer\'s leaf', g.leaf));
  if (g.kind === 'threshold') return deps.accountPure.setThresholdPayload(thresholdOf(g.threshold));
  if (g.kind === 'vault-threshold') return vaultThresholdPayloadOf(deps, g.vault, g.threshold);
  if (g.kind === 'adopt-vault') return adoptionPayloadOf(deps, g.vault);
  if (g.kind === 'pay-key') return payKeyPayloadOf(deps, g.commitment);
  if (g.kind === 'spending-policy') return spendingPolicyPayloadOf(deps, g.vault, g.assetKey, g.commitment);
  if (g.kind === 'policy-bar') return policyBarPayloadOf(deps, g.bar);
  throw new Error('this proposal is neither a seat nor a threshold, nor a vault adopted, nor the pay-record key, nor a spending '
    + 'policy, so nothing was built.');
}

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
export function identityOfAChange(deps: Pick<GovernedCallDeps, 'accountPure'>, change: GovernanceOnTheWire, salt: string): ProposalIdentity {
  const P = deps.accountPure;
  const digest = governancePayloadOf(deps, change);
  const noVault = P.noVault();
  return { digest: hexOf(digest), chainId: hexOf(P.proposalIdOf(digest, noVault, bytesOf('proposal\'s salt', salt))), noVault: hexOf(noVault) };
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
    readonly vault: string; readonly asset: string; readonly assetBlinding: string; readonly policy?: PolicyOpeningOnTheWire;
    /** A run's total, as decimal digits; with `policy`, the approvals its band needs are worked out too. */
    readonly total?: string;
  },
): SpendingPolicyKeys {
  const P = deps.accountPure;
  if (typeof P.policyKeyOf !== 'function' || typeof P.policyOnKeyOf !== 'function' || typeof P.policyBarKey !== 'function') {
    throw new Error('this device was not given the account\'s functions for a spending policy, so nothing was worked out.');
  }
  const assetKey = assetKeyMadeHere(deps, input.asset, input.assetBlinding);
  return {
    assetKey,
    policyKey: hexOf(P.policyKeyOf(bytesOf('vault', input.vault), bytesOf('currency\'s key', assetKey))),
    onKey: hexOf(P.policyOnKeyOf(bytesOf('vault', input.vault))),
    barKey: hexOf(P.policyBarKey()),
    commitment: input.policy === undefined ? null : policyCommitmentMadeHere(deps, input.policy),
    ...(input.policy === undefined || input.total === undefined ? {} : { required: bandApprovalsMadeHere(deps, input.policy, input.total) }),
  };
}

/**
 * The approvals a run of `total` needs under `policy`, by the contract's own
 * function, or null when the total is above every band: the contract refuses
 * such a total, and that refusal is the only one taken as "above every band".
 */
const bandApprovalsMadeHere = (deps: Pick<GovernedCallDeps, 'accountPure'>, policy: PolicyOpeningOnTheWire, total: string): string | null => {
  if (typeof deps.accountPure.bandApprovals !== 'function') {
    throw new Error('this device was not given the account\'s function for a policy\'s bands, so nothing was worked out.');
  }
  const opening = policyOpeningFromWire(policy);
  const amount = digitsOf('run\'s total', total);
  try {
    return deps.accountPure.bandApprovals(opening.terms.bands, amount).toString();
  } catch (e) {
    if (/above every band/u.test(String((e as Error)?.message ?? e))) return null;
    throw e;
  }
};

/** The arguments as the circuit is handed them, with the contract's own payload and no-vault in place. */
const argumentsBuilt = (deps: Pick<GovernedCallDeps, 'accountPure'>, order: GovernedCallOrder): unknown[] => {
  const args = argumentsFor(order);
  if (order.circuit !== 'propose' || raisesARun(order)) return args;
  return args.map((a) => (a === GOVERNANCE_PAYLOAD ? governancePayloadOf(deps, raisedChange(order))
    : a === NO_VAULT ? deps.accountPure.noVault() : a));
};

/**
 * **WHY A CALL COULD NOT BE BUILT, IN THE CONTRACT'S OR THE WITNESS'S OWN
 * WORDS.** The call builder lifts a failed assertion's sentence to the top, but
 * a witness that refuses - "you are not a signer on this account" - arrives
 * wrapped as a generic failure to run the circuit, with the sentence one level
 * down. That sentence is the one a person can act on, so it is brought up.
 */
/** What each call is called in a sentence a person reads. */
const CALLED: Readonly<Record<string, string>> = {
  approve: 'approval', propose: 'proposal', amendSigner: 'seat', setThreshold: 'threshold change',
  adopt: 'adoption of the vault', sealPayKey: 'sealing of the pay-record key',
  setVaultThreshold: 'change of a vault\'s approvals needed', cancel: 'withdrawal',
  setPolicy: 'spending policy', setPolicyBar: 'change of the approvals a policy change needs',
};

export class CallNotBuilt extends Error {
  constructor(readonly circuit: string, why: string, options?: { cause?: unknown }) {
    super(`this ${CALLED[circuit] ?? 'proposal'} could not be built on this device: ${why}. Nothing was proved or sent.`, options);
    this.name = 'CallNotBuilt';
  }
}

const theWitnessSaid = (circuit: string, e: unknown): unknown => {
  const outer = e as { _tag?: unknown; cause?: unknown } | null;
  const inner = outer?.cause as { message?: unknown } | undefined;
  if (outer?._tag === 'ContractRuntimeError' && inner instanceof Error && typeof inner.message === 'string' && inner.message !== '') {
    return new CallNotBuilt(circuit, inner.message, { cause: e });
  }
  return e;
};

/**
 * **A CALL IS BUILT ONLY FOR THE PROPOSAL THE SERVICE WROTE DOWN.** Its
 * identity is made here, by the contract's own functions, from what this device
 * was handed - the run or the change, and the salt - and compared with the
 * identity the service recorded. A mismatch - a salt, a window, a vault, a leaf
 * or a threshold that is not the recorded proposal's - is refused before
 * anything is built, because the chain would otherwise hold, or act on, a
 * proposal the service's record does not describe. Seating a signer and changing
 * the threshold are checked the same way: the leaf seated and the threshold set
 * must be the ones the approved round was raised for.
 */
export function refuseARaiseThatIsNotTheRecordedOne(deps: Pick<GovernedCallDeps, 'accountPure'>, order: GovernedCallOrder): void {
  if ((order.circuit === 'approve' && order.of === undefined) || order.circuit === 'cancel') return;
  const P = deps.accountPure;
  let made: Uint8Array;
  if (order.circuit === 'approve') {
    made = P.proposalIdOf(governancePayloadOf(deps, order.of!.governance), P.noVault(), bytesOf('proposal\'s salt', order.of!.proposalSalt));
  } else if (order.circuit === 'propose' && raisesARun(order)) {
    const [, root, payees, opensAt, closesAt, required, , vault] = argumentsFor(order) as [unknown, Uint8Array, bigint, bigint, bigint, bigint, unknown, Uint8Array];
    made = P.proposalIdOf(P.runPayload(root, payees, opensAt, closesAt, required), vault, bytesOf('proposal\'s salt', order.half.proposalSalt));
  } else if (order.circuit === 'propose') {
    made = P.proposalIdOf(governancePayloadOf(deps, raisedChange(order)), P.noVault(), bytesOf('proposal\'s salt', order.half.proposalSalt));
  } else if (order.circuit === 'amendSigner') {
    made = P.proposalIdOf(P.signerAddPayload(bytesOf('signer\'s leaf', order.leaf)), P.noVault(),
      bytesOf('proposal\'s salt', order.proposalSalt));
  } else if (order.circuit === 'adopt') {
    made = P.proposalIdOf(adoptionPayloadOf(deps, order.vault), P.noVault(), bytesOf('proposal\'s salt', order.proposalSalt));
  } else if (order.circuit === 'sealPayKey') {
    made = P.proposalIdOf(payKeyPayloadOf(deps, order.commitment), P.noVault(), bytesOf('proposal\'s salt', order.proposalSalt));
  } else if (order.circuit === 'setVaultThreshold') {
    made = P.proposalIdOf(vaultThresholdPayloadOf(deps, order.vault, order.threshold), P.noVault(),
      bytesOf('proposal\'s salt', order.proposalSalt));
  } else if (order.circuit === 'setPolicy') {
    made = P.proposalIdOf(spendingPolicyPayloadOf(deps, order.vault, assetKeyMadeHere(deps, order.asset, order.assetBlinding),
      order.commitment), P.noVault(), bytesOf('proposal\'s salt', order.proposalSalt));
  } else if (order.circuit === 'setPolicyBar') {
    made = P.proposalIdOf(policyBarPayloadOf(deps, order.bar), P.noVault(), bytesOf('proposal\'s salt', order.proposalSalt));
  } else {
    made = P.proposalIdOf(P.setThresholdPayload(thresholdOf(order.threshold)), P.noVault(),
      bytesOf('proposal\'s salt', order.proposalSalt));
  }
  const hex = Array.from(made, (b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== String(order.proposal).toLowerCase()) {
    throw new Error(
      order.circuit === 'propose'
        ? 'the proposal this device was asked to raise is not the one the company wrote down: its parts and its salt '
          + 'make another identity. Nothing was built or sent. Reload the page and try again.'
        : order.circuit === 'approve'
          ? 'the proposal this device was asked to approve is not for the change asked for here. Nothing was built or '
            + 'sent. Reload the page and try again; if it happens again, do not approve it.'
          : 'the approved proposal this device was asked to act on is not for this change: the change and its salt make '
            + 'another identity. Nothing was built or sent. Reload the page and try again.');
  }
}

const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const same = (a: unknown, b: unknown): boolean => String(a).toLowerCase() === String(b).toLowerCase();
const changeNamed = (g: RoundChangeOnTheWire | undefined): string =>
  (g?.kind === 'threshold' || g?.kind === 'vault-threshold' ? 'threshold' : g?.kind === 'adopt-vault' ? 'vault adopted'
    : g?.kind === 'pay-key' ? 'pay-record key' : g?.kind === 'spending-policy' ? 'policy' : g?.kind === 'policy-bar' ? 'policy bar' : 'leaf');

/**
 * **NOTHING IS PROVED WITH A VALUE THIS DEVICE DID NOT READ ITSELF, BUT TWO.**
 *
 * The proposal's identity is remade, with the contract's own functions, from
 * the payload and vault its record carries and the salt sealed inside it, and
 * must be the identity the record names. Then every value the service sent -
 * the proposal's identity, the salt, the leaf or the threshold, the run, the
 * vault and the account's half - must be the one read here, or the call is
 * refused naming the value, before anything is built. A seat or a threshold
 * change must also be the change whose payload the record carries.
 *
 * **THE FIRST IS THE ACCOUNT'S ASSET BLINDING**, which is the service's: see
 * the account's half above. **THE SECOND IS THE RUN ITSELF - ITS PAYOUT ROOT,
 * ITS COUNT OF PAYEES AND ITS WINDOW - WHICH IS ONLY AS GOOD AS THE RECORD**:
 * the payload the run must make is kept on the record beside the sealed part,
 * not inside it, so a record written down with another run passes here. And
 * the chain's state a call is built against is the one the service read.
 */
export function refuseWhatThisDeviceDidNotOpen(
  deps: Pick<GovernedCallDeps, 'accountPure'>, order: GovernedCallOrder, opened: OpenedRound,
): void {
  if (typeof opened !== 'object' || opened === null) {
    throw new Error('this device could not read the company\'s record of this proposal, so nothing was built or sent. '
      + 'Reload the page and try again.');
  }
  const P = deps.accountPure;
  const c = order.circuit;
  const refuse = (value: string): never => { throw new NotWhatThisDeviceOpened(value, c); };
  const made = hexOf(P.proposalIdOf(bytesOf('proposal\'s payload', opened.digest), bytesOf('vault', opened.vault),
    bytesOf('proposal\'s salt', opened.salt)));
  if (!same(made, opened.chainId)) throw new RecordDoesNotAddUp(c);
  if (!same(order.proposal, opened.chainId)) refuse('proposal identity');
  const saltHanded = order.circuit === 'propose' ? order.half.proposalSalt
    : order.circuit === 'approve' ? order.of?.proposalSalt : order.circuit === 'cancel' ? undefined : order.proposalSalt;
  if (saltHanded !== undefined && !same(saltHanded, opened.salt)) refuse('salt');
  const g = opened.governance;
  if (g !== undefined) {
    if (!same(opened.vault, hexOf(P.noVault()))) refuse('vault');
    if (!same(hexOf(governancePayloadOf(deps, g)), opened.digest)) refuse(changeNamed(g));
  }
  if (order.circuit === 'approve') {
    if (order.of !== undefined && (g === undefined || !sameGovernance(order.of.governance, g))) {
      refuse(changeNamed(order.of.governance));
    }
    return;
  }
  /* A withdrawal names only the proposal, and the proposal is the one this device opened. */
  if (order.circuit === 'cancel') return;
  if (order.circuit === 'amendSigner') {
    if (g?.kind !== 'add-signer' || !same(order.leaf, g.leaf)) refuse('leaf');
    return;
  }
  if (order.circuit === 'setThreshold') {
    if (g?.kind !== 'threshold' || thresholdOf(order.threshold) !== thresholdOf(g.threshold)) {
      refuse('threshold');
    }
    return;
  }
  if (order.circuit === 'setVaultThreshold') {
    if (g?.kind !== 'vault-threshold' || !same(order.vault, g.vault) || thresholdOf(order.threshold) !== thresholdOf(g.threshold)) {
      refuse('threshold');
    }
    return;
  }
  if (order.circuit === 'adopt') {
    if (g?.kind !== 'adopt-vault' || !same(order.vault, g.vault)) refuse('vault adopted');
    return;
  }
  if (order.circuit === 'sealPayKey') {
    if (g?.kind !== 'pay-key' || !same(order.commitment, g.commitment)) refuse('pay-record key');
    return;
  }
  if (order.circuit === 'setPolicy') {
    /*
     * The policy carried out is the one approved: the vault, the currency's key
     * made here from what this device is handed, and a commitment the opening
     * this device holds makes, all the proposal's own.
     */
    if (g?.kind !== 'spending-policy' || !same(order.vault, g.vault) || !same(order.commitment, g.commitment)
      || !same(assetKeyMadeHere(deps, order.asset, order.assetBlinding), g.assetKey)
      || !same(policyCommitmentMadeHere(deps, order.policy), g.commitment)) {
      refuse('policy');
    }
    return;
  }
  if (order.circuit === 'setPolicyBar') {
    if (g?.kind !== 'policy-bar' || policyBarOf(order.bar) !== policyBarOf(g.bar)) refuse('policy bar');
    return;
  }
  if (raisesARun(order)) {
    if (g !== undefined) refuse('change');
    const [, root, payees, opensAt, closesAt, required, , vault] = argumentsFor(order) as [unknown, Uint8Array, bigint, bigint, bigint, bigint, unknown, Uint8Array];
    if (!same(hexOf(P.runPayload(root, payees, opensAt, closesAt, required)), opened.digest)) refuse('run');
    if (!same(hexOf(vault), opened.vault)) refuse('run vault');
  } else if (g === undefined || !sameGovernance(raisedChange(order), g)) {
    refuse(changeNamed(raisedChange(order)));
  }
  const h = opened.half;
  if (h === undefined) {
    throw new Error('this device could not read the change sealed in the company\'s record of this proposal, so it cannot '
      + 'send it. Nothing was built or sent. Reload the page and try again.');
  }
  if (!same(order.half.assetId, h.assetId)) refuse('asset');
  if (String(order.half.changeAmount) !== String(h.changeAmount)) refuse('amount');
  if (!same(order.half.changeBatchDigest, h.changeBatchDigest)) refuse('payments digest');
}

/** Overwrites the signer's three in a record that is finished with. */
const wipe = (record: AccountPrivateState): void => {
  for (const field of ['secretKey', 'blinding', 'scope'] as const) {
    const value = (record as unknown as Record<string, unknown>)[field];
    if (value instanceof Uint8Array) value.fill(0);
  }
};

/**
 * **ONE GOVERNED CALL, BUILT AND PROVED HERE.**
 *
 * Refuses, before anything is built, a circuit a device does not govern here
 * and a circuit that reads no witness: the second kind is open to anybody on
 * the chain and must not be given anybody's record.
 */
export async function buildGovernedCall(
  deps: GovernedCallDeps,
  input: {
    readonly account: string;
    readonly order: GovernedCallOrder;
    readonly material: SignerMaterial;
    readonly chain: AccountCallChain;
    /** What this device opened from the company's sealed records; see `refuseWhatThisDeviceDidNotOpen`. */
    readonly opened: OpenedRound;
  },
): Promise<{ proven: Uint8Array }> {
  const account = String(input.account).toLowerCase();
  if (!HEX64.test(account)) {
    throw new Error('this call is not for a company account this device can name, so nothing was built.');
  }
  const circuit = input.order.circuit;
  if (!ACCOUNT_CIRCUITS_A_DEVICE_GOVERNS.includes(circuit) || CIRCUITS_THAT_READ_NO_WITNESS.has(circuit)) {
    throw new Error(`a device here raises, approves and withdraws proposals, seats signers, changes the company's or a vault's threshold, adopts a vault, seals the pay-record key and sets a vault's spending policy and the approvals a policy change needs, and "${String(circuit)}" is none of those. Nothing was built.`);
  }
  const args = argumentsBuilt(deps, input.order);
  /* What this device opened first, so a value the service handed over that is not in the company's records is named. */
  refuseWhatThisDeviceDidNotOpen(deps, input.order, input.opened);
  /* An approval of a run or a vault's first secret is proved only for what this device made again itself. */
  /*
   * And a payroll run is raised only as this device built it again, against the
   * chain as it holds the account now: the same rebuild an approval makes, and
   * nothing on the chain the company's records cannot account for. A vault's
   * first secret run, which moves no money, is checked where its approval is
   * built. What it is comes from the run this device made again, never from the
   * amount the proposal's filer sealed.
   */
  const raisingARun = circuit === 'propose' && raisesARun(input.order) && input.opened.made?.kind !== 'vault-secret';
  if ((circuit === 'approve' && input.opened.governance === undefined) || raisingARun) {
    const view = deps.accountLedger === undefined ? null
      : deps.accountLedger((deps.runtimeState.deserialize(input.chain.accountState) as { data: unknown }).data) as AccountLedgerView;
    refuseWhatThisDeviceDidNotMake({
      runPayload: deps.accountPure.runPayload, vaultDetails: deps.vaultDetails,
      payKeyCommitmentOf: deps.accountPure.payKeyCommitmentOf,
      ...(deps.vaultPure === undefined ? {} : { secretRun: { vault: deps.vaultPure, account: deps.accountPure as unknown as AccountStartPure } }),
    }, input.opened, view, raisingARun ? 'raise' : 'approve');
  }
  refuseARaiseThatIsNotTheRecordedOne(deps, input.order);
  /*
   * Frozen, so a circuit that tried to write into the record it was handed
   * fails there rather than changing what the next check compares.
   */
  const record = Object.freeze(recordForOneCall(input.order, input.material, input.opened));
  try {
    const L = deps.ledger;
    const seed = (deps.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(32);
    const keys = L.ZswapSecretKeys.fromSeed(seed);
    const coinPublicKey = keys.coinPublicKey;
    const encryptionPublicKey = keys.encryptionPublicKey;
    seed.fill(0);
    try { keys.clear?.(); } catch { /* nothing to clear */ }
    const built = await deps.contracts.createUnprovenCallTxFromInitialStates(deps.accountZkConfig, {
      compiledContract: deps.accountCompiled,
      circuitId: circuit,
      contractAddress: account,
      coinPublicKey,
      initialContractState: deps.runtimeState.deserialize(input.chain.accountState),
      /* A raise and an approval move no coin, so the builder is given no commitment tree to read. */
      initialZswapChainState: new L.ZswapChainState(),
      ledgerParameters: L.LedgerParameters.deserialize(input.chain.parameters),
      initialPrivateState: record,
      args,
    }, encryptionPublicKey).catch((e: unknown) => { throw theWitnessSaid(circuit, e); });
    if (built?.private?.nextPrivateState !== record) throw new RecordChangedByTheCall(circuit);
    const proven = await deps.prove(built.private.unprovenTx, circuit);
    return { proven: proven.serialize() };
  } finally {
    wipe(record as AccountPrivateState);
  }
}
