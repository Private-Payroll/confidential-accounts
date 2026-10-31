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
 *                         sealed record, with the company's key at the epoch
 *                         the record was sealed under; the record is
 *                         composed from what was opened, and a value the
 *                         service handed that is not the opened one is refused
 *                         by name before anything is built. The blinding is the
 *                         service's: it is kept only inside the account's sealed
 *                         state beside things a signer's page is not handed, and
 *                         what it feeds - the change commitment a raise records -
 *                         is read back by no circuit. An approval reads none of
 *                         them, and a record for an approval refuses by name if
 *                         a circuit ever asks for one.
 *   the salt              for every proposal carried out, the one its record
 *                         names: sealed inside the proposal for a change of
 *                         the company, made from public data for a vault's
 *                         adoption and the pay-record key, and in the file the
 *                         signers approved for a recovery of the record anchor.
 *   the chain             the account's contract state and the ledger
 *                         parameters, both as one block saw them.
 *
 * **WHAT LEAVES THIS FILE IS A PROVEN TRANSACTION.** It carries no coin of
 * anybody's: a raise and an approval move nothing, and the two public keys the
 * call builder asks for are made from randomness nobody keeps.
 */
import type { AccountPrivateState } from '../../../contracts/src/witnesses.js';
import { fromHex, type Hex } from '../../../src/core/crypto.js';
import { vouchedFreshOf, vouchedRefusal } from '../../../src/midnight/record-tree.js';
import { CIRCUITS_THAT_READ_NO_WITNESS } from '../../../src/midnight/governed-call.js';
import { ACCOUNT_CIRCUITS_A_DEVICE_GOVERNS } from '../../../src/midnight/vault-contract.js';
import { CREATION_STEPS } from '../../../src/midnight/deferral.js';
import { PAY_KEY_PARTS } from '../../../src/midnight/pay-key-round.js';
import type { BatchHolders } from '../../../src/midnight/record-manifest.js';
import type { CommitteeKey } from '../../../src/midnight/seat-directory.js';
import type { RetirementTerms } from '../../../src/core/proposal-filing.js';
import { signerHalfOf, type SignerMaterial } from './private-state.js';
import { refuseWhatThisDeviceDidNotMake, type AccountLedgerView, type MadeHere, type VouchedHere } from './what-this-device-made.js';
import { sameGovernance } from './governance-compared.js';
import { authorityIn } from 'midnight-identity/profile/contract-authority';
import type { DetailsOfKind } from '../../../src/midnight/payout-tree.js';
import type { AccountStartPure, VaultStartPure } from '../../../src/midnight/vault-start.js';
import { NO_LEG, policyOpeningFromWire, type PolicyOpeningOnTheWire } from '../../../src/midnight/spending-policy-record.js';
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
  /**
   * An invitation to seat whoever holds an address: the hiding commitment to
   * the address (`inviteAddressOf`) and the rights the seat will carry. The
   * invitee takes the seat from their own wallet once it is approved.
   */
  | { readonly kind: 'add-signer'; readonly address: string; readonly scope: string }
  /** A seated signer's leaf, taken off the account. */
  | { readonly kind: 'remove-signer'; readonly leaf: string }
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
  | { readonly kind: 'recover-anchor'; readonly resumesFrom: string; readonly latest: string; readonly lastRecovery: string };

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
  /** Taking a seated signer's leaf off the account, on an approved removal. A seat is never carried out here: the invitee takes it. */
  | { readonly circuit: 'amendSigner'; readonly leaf: string; readonly proposal: string; readonly proposalSalt: string; readonly removing: true }
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
  approve: 'do not approve it', propose: 'do not send it', amendSigner: 'do not remove this signer',
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
    /** A run's salt, `retrySaltOf(leg, fresh)`: asked for where a payroll run is raised, approved or charged. */
    retrySaltOf?(legRoot: Uint8Array, fresh: Uint8Array): Uint8Array;
    signerInvitePayload(address: Uint8Array, scope: Uint8Array): Uint8Array;
    /** Present where a signer's removal is built; asked for only then. */
    removeSignerPayload?(leaf: Uint8Array): Uint8Array;
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
    /** Where the account keeps its record anchor, and the head after one batch; asked for only where records are anchored. */
    anchorKey?(): Uint8Array;
    anchorHeadOf?(previous: Uint8Array, batch: Uint8Array): Uint8Array;
    /** What one anchor call folds into the head: the batch, who held the account as it was judged, and the anchoring seat's tag. */
    anchorHeldOf?(batch: Uint8Array, approvals: bigint, signerRoot: { field: bigint }, tag: Uint8Array): Uint8Array;
    /** What one recovery folds into the head: as `anchorHeldOf`, and the head it resumes from. */
    anchorRecoveredOf?(batch: Uint8Array, approvals: bigint, signerRoot: { field: bigint }, tag: Uint8Array, resumesFrom: Uint8Array): Uint8Array;
    /** The tag a seat anchors under in an account, and the key the account keeps the last one under. */
    anchorTagOf?(account: Uint8Array, pk: Uint8Array, blinding: Uint8Array): Uint8Array;
    anchorSeatKey?(): Uint8Array;
    /**
     * What a quorum approves to recover the record anchor from a head its devices checked, before a latest time,
     * while the head the latest recovery carried out wrote is `lastRecovery`.
     */
    recoverAnchorPayload?(resumesFrom: Uint8Array, latest: bigint, lastRecovery: Uint8Array): Uint8Array;
    /** Where the account keeps the head the latest recovery carried out wrote. */
    lastRecoveryKey?(): Uint8Array;
    /** A seat's public key on the account, from its secret, and the leaf its key, blinding and scope make. */
    signerPublicKey?(sk: Uint8Array): Uint8Array;
    signerLeaf?(pk: Uint8Array, blinding: Uint8Array, scope: Uint8Array): Uint8Array;
    /** The leaf a removed signer's slot holds, and the slot a signer's path leads to. */
    vacantSlot?(): Uint8Array;
    slotOf?(path: unknown): bigint;
    /** What a run's entry among the open proposals is overwritten with once it is charged to its period. */
    clearedMark?(): Uint8Array;
    /** The mark a run's hold carries once a payment or a change from it has landed (`markPaidFrom`). */
    paidFromMark?(): Uint8Array;
    /** The key the account's count of signers removed is held under, among its proposals' holds. */
    removalCountKey?(): Uint8Array;
    /**
     * The approvals a run needs before a vault pays or charges it: the higher of its bar when raised
     * and the vault's bar now, plus one for every signer removed since it was raised. This is the
     * account's own count; a device does not recompute it.
     */
    runApprovalsNeeded?(neededWhenRaised: bigint, vaultBar: bigint, removalsNow: bigint, removalsWhenRaised: bigint): bigint;
  };
  /**
   * `@midnight-ntwrk/compact-runtime`'s signer-tree pieces: a blank tree, a leaf's encoding and a root's reading.
   * Asked for only where who held the account is named in, or read off, a batch's header.
   */
  readonly accountTree?: {
    readonly StateBoundedMerkleTree: new (height: number) => {
      update(index: bigint, leaf: unknown): unknown; rehash(): { root(): { value: unknown } | undefined };
    };
    readonly CompactTypeBytes: new (length: number) => { toValue(v: Uint8Array): unknown; alignment(): unknown };
    readonly CompactTypeMerkleTreeDigest: { fromValue(v: unknown): { field: bigint } };
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
 * **A WALLET'S COIN SECRET KEY NEVER REACHES A RECORD THIS PAGE BUILDS.** The
 * invitation a person takes their seat by (`invite`) holds the secret key that
 * spends every shielded coin they own, and only their own wallet proves the
 * seat with it. Thrown, with nothing built or sent, when anything handed to the
 * page's builder carries one.
 */
export class WalletKeyNotForAPage extends Error {
  constructor() {
    super('this page was handed the key a wallet takes an invited seat with, and that key spends every coin the wallet holds, so '
      + 'nothing was built or sent. Take the seat from your own wallet, never from a page; if a page asked you for it, do not '
      + 'use that page again.');
    this.name = 'WalletKeyNotForAPage';
  }
}

const refuseAWalletsCoinKey = (...given: unknown[]): void => {
  if (given.some((x) => typeof x === 'object' && x !== null && 'invite' in x)) throw new WalletKeyNotForAPage();
};

/** The record, with the invitation a wallet takes a seat by a refusal rather than a value: no circuit this page builds reads it. */
const withNoInvitation = <T extends object>(record: T): T => Object.defineProperty(record, 'invite', {
  enumerable: false,
  get: () => { throw new WalletKeyNotForAPage(); },
});

/**
 * **THE RECORD FOR ONE CALL, COMPOSED NOW AND USED ONCE.**
 *
 * The signer's three come first and are refused by name if any is missing or
 * the wrong width - the scope included. For a raise the account's half is the
 * one this device read from the proposal's own record, and the asset blinding
 * is the order's. Each carrying out this device builds - a removal, a
 * threshold, a vault's threshold, an adoption, the pay-record key, a spending
 * policy and its bar - is handed the salt the approved round's identity was made
 * with (a spending policy also its currency and blinding), and it is the one
 * the record this device opened names. The pay-record key's circuit reads it only before a key is committed. Given no record read here - which `buildGovernedCall`
 * never builds without - each is read off the order. Every other account field
 * is a refusal rather than a value. The two membership-path fields are set here and from
 * nowhere else, so nothing handed in can put a path into the record.
 */
export function recordForOneCall(order: GovernedCallOrder, material: SignerMaterial, opened?: OpenedRound): AccountPrivateState {
  refuseAWalletsCoinKey(material, opened);
  const signer = signerHalfOf(material);
  if (order.circuit === 'propose') {
    /* What this device opened, when it did; `buildGovernedCall` never builds without it. */
    const h = opened?.half ?? order.half;
    return withNoInvitation({
      ...signer,
      assetId: bytesOf('asset', h.assetId),
      assetBlinding: bytesOf('account\'s asset blinding', order.half.assetBlinding),
      proposalSalt: bytesOf('proposal\'s salt', opened?.salt ?? order.half.proposalSalt),
      changeAmount: digitsOf('change amount', h.changeAmount),
      changeBatchDigest: bytesOf('change digest', h.changeBatchDigest),
      pinnedPath: null,
    });
  }
  const record = withNoInvitation({ ...signer, pinnedPath: null } as AccountPrivateState);
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
    /* A removal marks the leaf's own slot vacant. */
    return [bytesOf('signer\'s leaf', order.leaf), bytesOf('proposal\'s identity', order.proposal)];
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

/** The contract's own payload for taking `leaf` off the account, refused by name where this device was not given the function. */
const removalPayloadOf = (deps: Pick<GovernedCallDeps, 'accountPure'>, leaf: string): Uint8Array => {
  if (typeof deps.accountPure.removeSignerPayload !== 'function') {
    throw new Error('this device was not given the account\'s function for removing a signer, so nothing was built. Reload the page to use the current build.');
  }
  return deps.accountPure.removeSignerPayload(bytesOf('signer\'s leaf', leaf));
};

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
  /* The super admins' changes are their own kind, signed by their wallets on each contract: never a proposal the account holds or counts. */
  if ((g as { readonly kind: string }).kind === 'super-admins') {
    throw new Error('a change of the super admins is never raised, approved or counted on the company\'s account as a signers\' proposal, so nothing was built.');
  }
  if (g.kind === 'add-signer') {
    return deps.accountPure.signerInvitePayload(bytesOf('invited address', g.address), bytesOf('seat\'s rights', g.scope));
  }
  if (g.kind === 'remove-signer') return removalPayloadOf(deps, g.leaf);
  if (g.kind === 'threshold') return deps.accountPure.setThresholdPayload(thresholdOf(g.threshold));
  if (g.kind === 'vault-threshold') return vaultThresholdPayloadOf(deps, g.vault, g.threshold);
  if (g.kind === 'adopt-vault') return adoptionPayloadOf(deps, g.vault);
  if (g.kind === 'pay-key') return payKeyPayloadOf(deps, g.commitment);
  if (g.kind === 'spending-policy') return spendingPolicyPayloadOf(deps, g.vault, g.assetKey, g.commitment);
  if (g.kind === 'policy-bar') return policyBarPayloadOf(deps, g.bar);
  if (g.kind === 'recover-anchor') {
    if (typeof deps.accountPure.recoverAnchorPayload !== 'function') {
      throw new Error('this device was not given the account\'s function for a recovery of its record anchor. Reload the page to use the current build.');
    }
    return deps.accountPure.recoverAnchorPayload(
      bytesOf('head it resumes from', String(g.resumesFrom).toLowerCase()), digitsOf('recovery\'s last time', g.latest),
      bytesOf('latest recovery\'s head', String(g.lastRecovery).toLowerCase()));
  }
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

/** What each call is called in a sentence a person reads. */
const CALLED: Readonly<Record<string, string>> = {
  approve: 'approval', propose: 'proposal', amendSigner: 'removal', setThreshold: 'threshold change',
  adopt: 'adoption of the vault', sealPayKey: 'sealing of the pay-record key',
  setVaultThreshold: 'change of a vault\'s approvals needed', cancel: 'withdrawal',
  setPolicy: 'spending policy', setPolicyBar: 'change of the approvals a policy change needs',
};

/**
 * **WHY A CALL COULD NOT BE BUILT, IN THE CONTRACT'S OR THE WITNESS'S OWN
 * WORDS.** The call builder lifts a failed assertion's sentence to the top, but
 * a witness that refuses - "you are not a signer on this account" - arrives
 * wrapped as a generic failure to run the circuit, with the sentence one level
 * down. That sentence is the one a person can act on, so it is brought up.
 */
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
 * proposal the service's record does not describe. Each carrying out this device
 * builds (the circuits of `GovernedCallOrder`) is checked the same way: its change
 * and its salt must make the approved round's identity. A recovery of the record
 * anchor is checked where it is built (`buildRecoverAnchorCall`).
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
    made = P.proposalIdOf(removalPayloadOf(deps, order.leaf), P.noVault(), bytesOf('proposal\'s salt', order.proposalSalt));
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
    : g?.kind === 'pay-key' ? 'pay-record key' : g?.kind === 'spending-policy' ? 'policy' : g?.kind === 'policy-bar' ? 'policy bar'
      : g?.kind === 'recover-anchor' ? 'recovery' : g?.kind === 'add-signer' ? 'invitation' : 'leaf');

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
    if (g?.kind !== 'remove-signer' || order.removing !== true || !same(order.leaf, g.leaf)) refuse('leaf');
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
      ...(deps.accountPure.retrySaltOf === undefined ? {} : { retrySaltOf: deps.accountPure.retrySaltOf }),
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

/** What an invitee's wallet takes an invited seat with: its seat, the address's coin key and salt, and the proposal's salt. */
export interface InvitedSeatInput {
  readonly account: string;
  /** The invitation's proposal, by its identity on chain. */
  readonly proposal: string;
  readonly material: SignerMaterial & { readonly scope: Hex };
  /** The coin secret key of the address invited, and the salt its commitment was made under. Only a wallet holds these. */
  readonly invite: { readonly coinSecretKey: Hex; readonly addressSalt: Hex };
  readonly proposalSalt: Hex;
  /** Whether the seat goes into a slot a removal left vacant. */
  readonly intoVacatedSlot: boolean;
  readonly chain: AccountCallChain;
}

/**
 * **THE INVITEE'S OWN CALL THAT TAKES THE SEAT AN INVITATION BY ADDRESS OFFERED** (`seatInvited`), built and proved
 * where it is called, which is only ever the invitee's own wallet: the coin secret key it proves the address with is
 * a witness to the proof and is in nothing returned. The account refuses it unless the proposal invites the address
 * this key makes, with the rights this seat carries, and the proposal is approved at the seat bar.
 */
export async function buildSeatInvitedCall(deps: GovernedCallDeps, input: InvitedSeatInput): Promise<{ proven: Uint8Array }> {
  const account = String(input.account).toLowerCase();
  if (!HEX64.test(account)) throw new Error('this seat is not taken on a company account this wallet can name, so nothing was built.');
  const record = {
    ...signerHalfOf(input.material),
    invite: { coinSecretKey: bytesOf('address\'s coin key', input.invite.coinSecretKey), addressSalt: bytesOf('address\'s salt', input.invite.addressSalt) },
    proposalSalt: bytesOf('proposal\'s salt', input.proposalSalt),
    pinnedPath: null,
  } as unknown as AccountPrivateState;
  try {
    const L = deps.ledger;
    const seed = (deps.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(32);
    const keys = L.ZswapSecretKeys.fromSeed(seed);
    seed.fill(0);
    try {
      const built = await deps.contracts.createUnprovenCallTxFromInitialStates(deps.accountZkConfig, {
        compiledContract: deps.accountCompiled,
        circuitId: 'seatInvited',
        contractAddress: account,
        coinPublicKey: keys.coinPublicKey,
        initialContractState: deps.runtimeState.deserialize(input.chain.accountState),
        initialZswapChainState: new L.ZswapChainState(),
        ledgerParameters: L.LedgerParameters.deserialize(input.chain.parameters),
        initialPrivateState: record,
        args: [bytesOf('proposal', String(input.proposal).toLowerCase()), input.intoVacatedSlot],
      }, keys.encryptionPublicKey).catch((e: unknown) => { throw theWitnessSaid('seatInvited', e); });
      const proven = await deps.prove(built.private.unprovenTx, 'seatInvited');
      return { proven: proven.serialize() };
    } finally {
      try { keys.clear?.(); } catch { /* the throwaway keys hold nothing of the wallet's */ }
    }
  } finally {
    wipe(record);
    (record as unknown as { invite: { coinSecretKey: Uint8Array } }).invite.coinSecretKey.fill(0);
  }
}

/* ── THE COMPANY'S RECORD ANCHOR, MOVED ON FROM THIS DEVICE ──────────────────── */

/** Thrown, with nothing built or sent, when an anchor call - or a recovery, `recovery` - cannot be made as this device would send it. */
export class AnchorNotBuilt extends Error {
  constructor(why: string, options?: { cause?: unknown; recovery?: boolean }) {
    super(`${options?.recovery === true ? 'the recovery of the company\'s records was not carried out' : 'the company\'s records were not anchored'}: ${why}. `
      + 'Nothing was built or sent.', options);
    this.name = 'AnchorNotBuilt';
  }
}

const anchorPure = (deps: Pick<GovernedCallDeps, 'accountPure'>) => {
  const { anchorKey, anchorHeadOf, anchorHeldOf, anchorRecoveredOf, anchorTagOf, anchorSeatKey, signerPublicKey, vacantSlot, slotOf } = deps.accountPure;
  if (typeof anchorKey !== 'function' || typeof anchorHeadOf !== 'function' || typeof anchorHeldOf !== 'function'
    || typeof anchorRecoveredOf !== 'function' || typeof anchorTagOf !== 'function' || typeof anchorSeatKey !== 'function'
    || typeof signerPublicKey !== 'function' || typeof vacantSlot !== 'function' || typeof slotOf !== 'function') {
    throw new AnchorNotBuilt('this device was not given the account\'s functions for its record anchor. Reload the page to use the '
      + 'current build');
  }
  return { anchorKey, anchorHeadOf, anchorHeldOf, anchorRecoveredOf, anchorTagOf, anchorSeatKey, signerPublicKey, vacantSlot, slotOf };
};

/** A signer tree's root as a header names it: the field, as 64 hex digits, big-endian. */
const rootHexOf = (field: bigint): string => field.toString(16).padStart(64, '0');
const rootOfHex = (hex: string): { field: bigint } => {
  const h = String(hex).toLowerCase();
  if (!HEX64.test(h)) throw new AnchorNotBuilt('the batch does not name the root of the account\'s signers as it was judged');
  return { field: BigInt(`0x${h}`) };
};

/**
 * The root of a signer tree holding `signers`, slot by slot from slot 0, as a
 * header names a root; the tree the account's own signer tree is, a tree of
 * height ten with each leaf hashed as the chain hashes it.
 */
export function signerRootOf(deps: Pick<GovernedCallDeps, 'accountTree'>, signers: readonly string[]): string {
  const T = deps.accountTree;
  if (T === undefined) throw new AnchorNotBuilt('this device was not given the account\'s signer tree. Reload the page to use the current build');
  const bytes = new T.CompactTypeBytes(32);
  let tree = new T.StateBoundedMerkleTree(10) as { update(index: bigint, leaf: unknown): unknown };
  signers.forEach((leaf, slot) => {
    const b = bytesOf('leaf', String(leaf).toLowerCase());
    tree = tree.update(BigInt(slot), { value: bytes.toValue(b), alignment: bytes.alignment() }) as typeof tree;
  });
  const root = (tree as unknown as { rehash(): { root(): { value: unknown } | undefined } }).rehash().root();
  if (root === undefined) throw new AnchorNotBuilt('the root of the account\'s signers could not be worked out');
  return rootHexOf(T.CompactTypeMerkleTreeDigest.fromValue(root.value).field);
}

/** Whether a header's leaves, slot by slot, make the signer-tree root it names: only then are they the account's. */
export function signersMakeTheirRoot(deps: Pick<GovernedCallDeps, 'accountTree'>, held: BatchHolders): boolean {
  if (deps.accountTree === undefined) signerRootOf(deps, []);
  try {
    return signerRootOf(deps, held.signers) === String(held.signerRoot).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * **WHO HOLDS THE ACCOUNT IN ONE OF ITS STATES, AS A BATCH'S HEADER NAMES
 * THEM**: the approvals it requires, its signer tree's root, and the leaf in
 * each slot up to the tree's first free one - a seated signer's leaf where its
 * path leads, the account's vacant-slot leaf in every other.
 */
export function batchHoldersIn(
  deps: Pick<GovernedCallDeps, 'accountPure' | 'accountLedger' | 'runtimeState'>, accountState: Uint8Array,
): BatchHolders {
  const P = anchorPure(deps);
  if (deps.accountLedger === undefined) throw new AnchorNotBuilt('this device was not given the account\'s reader');
  const view = deps.accountLedger((deps.runtimeState.deserialize(accountState) as { data: unknown }).data) as {
    threshold: bigint;
    signers: { root(): { field: bigint } | undefined; firstFree(): bigint; findPathForLeaf(leaf: Uint8Array): unknown };
    signerLeaves: Iterable<Uint8Array>;
  };
  const root = view.signers.root();
  if (root === undefined) throw new AnchorNotBuilt('the account\'s signers could not be read from its state');
  const free = Number(view.signers.firstFree());
  const vacant = hexOf(P.vacantSlot());
  const signers: string[] = Array.from({ length: free }, () => vacant);
  for (const leaf of view.signerLeaves) {
    const path = view.signers.findPathForLeaf(leaf);
    const slot = path === undefined ? -1 : Number(P.slotOf(path));
    if (!(slot >= 0 && slot < free)) throw new AnchorNotBuilt('a seated signer\'s slot could not be read from the account\'s state');
    signers[slot] = hexOf(leaf);
  }
  return { approvals: Number(view.threshold), signerRoot: rootHexOf(root.field), signers };
}

/**
 * The head an account's state holds under the anchor's own key - the empty
 * head, thirty-two zero bytes, before its first anchor - and the tag of the
 * seat that moved it there, null before the first.
 */
const headInState = (
  deps: Pick<GovernedCallDeps, 'accountPure' | 'accountLedger' | 'runtimeState'>, accountState: Uint8Array,
): { readonly head: string; readonly tag: string | null } => {
  const P = anchorPure(deps);
  if (deps.accountLedger === undefined) throw new AnchorNotBuilt('this device was not given the account\'s reader');
  const view = deps.accountLedger((deps.runtimeState.deserialize(accountState) as { data: unknown }).data) as {
    signerRoles: { member(key: Uint8Array): boolean; lookup(key: Uint8Array): Uint8Array };
  };
  const key = P.anchorKey();
  const seat = P.anchorSeatKey();
  return {
    head: view.signerRoles.member(key) ? hexOf(view.signerRoles.lookup(key)) : hexOf(ZERO_32),
    tag: view.signerRoles.member(seat) ? hexOf(view.signerRoles.lookup(seat)) : null,
  };
};

/**
 * **THE HEAD THE LATEST RECOVERY CARRIED OUT WROTE, AS ONE STATE OF THE ACCOUNT
 * HOLDS IT** (hex): thirty-two zero bytes before any recovery is carried out.
 * Read with the account's own reader and key, from a state the caller read at
 * the indexer the person's own wallet names. A recovery is raised naming it and
 * carried out only while the account still holds the head it names, since the
 * account refuses any other - and that refusal lands after the fee is paid.
 */
export function lastRecoveryIn(
  deps: Pick<GovernedCallDeps, 'accountPure' | 'accountLedger' | 'runtimeState'>, accountState: Uint8Array,
): string {
  const key = deps.accountPure.lastRecoveryKey;
  if (deps.accountLedger === undefined || typeof key !== 'function') {
    throw new Error('this device was not given the account\'s reader for its latest recovery, so no recovery was raised or carried out. '
      + 'Reload the page to use the current build');
  }
  const view = deps.accountLedger((deps.runtimeState.deserialize(accountState) as { data: unknown }).data) as {
    signerRoles: { member(key: Uint8Array): boolean; lookup(key: Uint8Array): Uint8Array };
  };
  const at = key.call(deps.accountPure);
  return view.signerRoles.member(at) ? hexOf(view.signerRoles.lookup(at)) : hexOf(ZERO_32);
}

/**
 * **WHAT EACH SEAT'S OPENING OPENS, AND THE TAG IT ANCHORS UNDER IN `account`**,
 * by the account's own `signerLeaf` and `anchorTagOf`: a device believes an
 * opening only where the leaf it makes is the seat's. With `own`, this device's
 * own opening too - its public key from its secret - which it files for the
 * company's members. Reads no chain.
 */
export function seatOpeningsIn(
  deps: Pick<GovernedCallDeps, 'accountPure'>,
  input: {
    readonly account: string;
    readonly openings: ReadonlyArray<{ readonly publicKey: string; readonly scope: string; readonly blinding: string }>;
    readonly own?: Pick<SignerMaterial, 'signingSecret' | 'blinding' | 'scope'>;
  },
): { openings: Array<{ leaf: string | null; tag: string | null }>; own?: { publicKey: string; leaf: string; tag: string } } {
  const P = anchorPure(deps);
  if (typeof deps.accountPure.signerLeaf !== 'function') {
    throw new AnchorNotBuilt('this device was not given the account\'s functions for its seats. Reload the page to use the current build');
  }
  const leafOf = deps.accountPure.signerLeaf.bind(deps.accountPure);
  const account = String(input.account).toLowerCase();
  if (!HEX64.test(account)) throw new AnchorNotBuilt('this call is not for a company account this device can name');
  const a = bytesOf('account', account);
  const openings = input.openings.map((o) => {
    try {
      const pk = bytesOf('public key', String(o.publicKey).toLowerCase());
      const blinding = bytesOf('blinding', String(o.blinding).toLowerCase());
      return { leaf: hexOf(leafOf(pk, blinding, bytesOf('scope', String(o.scope).toLowerCase()))), tag: hexOf(P.anchorTagOf(a, pk, blinding)) };
    } catch {
      return { leaf: null, tag: null };
    }
  });
  if (input.own === undefined) return { openings };
  if (input.own.scope === undefined) throw new AnchorNotBuilt('this seat\'s material names no scope, so its leaf cannot be opened');
  const pk = P.signerPublicKey(bytesOf('signing secret', String(input.own.signingSecret).toLowerCase()));
  const blinding = bytesOf('blinding', String(input.own.blinding).toLowerCase());
  return {
    openings,
    own: {
      publicKey: hexOf(pk), leaf: hexOf(leafOf(pk, blinding, bytesOf('scope', String(input.own.scope).toLowerCase()))),
      tag: hexOf(P.anchorTagOf(a, pk, blinding)),
    },
  };
}

/**
 * **THE TAG THIS DEVICE'S SEAT ANCHORS UNDER IN `account`**, made with the
 * account's own `anchorTagOf` over the seat's public key and its leaf's
 * blinding, as the account's call works it out from the seat it proves: what
 * this device's headers name, and what the head they make binds.
 */
export function anchorTagIn(deps: Pick<GovernedCallDeps, 'accountPure'>, account: string, material: Pick<SignerMaterial, 'signingSecret' | 'blinding'>): string {
  const P = anchorPure(deps);
  const a = String(account).toLowerCase();
  if (!HEX64.test(a)) throw new AnchorNotBuilt('this call is not for a company account this device can name');
  return hexOf(P.anchorTagOf(bytesOf('account', a), P.signerPublicKey(bytesOf('signing secret', String(material.signingSecret).toLowerCase())),
    bytesOf('blinding', String(material.blinding).toLowerCase())));
}

/** The seats a header's leaves name: every leaf but the account's vacant-slot one. */
export function seatsNamedBy(deps: Pick<GovernedCallDeps, 'accountPure'>, signers: readonly string[]): string[] {
  const vacant = hexOf(anchorPure(deps).vacantSlot());
  return signers.map((l) => String(l).toLowerCase()).filter((l) => l !== vacant);
}

/**
 * One step of the account's head as asked: the head before, a header's digest,
 * who held the account as it was judged, the anchoring seat's tag, and - for a
 * recovery - the head it resumes from.
 */
export interface HeadStepAsked {
  readonly previous: string; readonly batch: string; readonly held: BatchHolders; readonly tag: string; readonly resumesFrom?: string;
}

/**
 * **THE HEAD AFTER EACH BATCH ASKED ABOUT**, each made with the account's own
 * `anchorHeadOf` over `anchorHeldOf` (a recovery's, `anchorRecoveredOf`) of the batch, the tag and the holders its header
 * names; and the seats those holders' leaves name - every leaf but the
 * vacant-slot one - when they make the root the header names, null when they
 * do not; and the same seats for each of `holders`, as a directory version's
 * leaf names who held the account. Reads no chain.
 */
export function anchorHeadsAfter(
  deps: Pick<GovernedCallDeps, 'accountPure' | 'accountTree'>,
  input: {
    readonly after: readonly HeadStepAsked[];
    readonly holders?: readonly BatchHolders[];
  },
): { after: string[]; seats: (string[] | null)[]; holderSeats: (string[] | null)[] } {
  const P = anchorPure(deps);
  /* A batch whose holders the account's own functions refuse - a root that is no field element - folds to the empty head, which no batch on the chain's path ever leaves, so it is passed over and never believed. */
  const seatsOf = (held: BatchHolders): string[] | null => (signersMakeTheirRoot(deps, held) ? seatsNamedBy(deps, held.signers) : null);
  const headAfter = (x: HeadStepAsked): string => {
    try {
      const previous = bytesOf('head', String(x.previous).toLowerCase());
      const batch = bytesOf('batch', String(x.batch).toLowerCase());
      const tag = bytesOf('tag', String(x.tag).toLowerCase());
      const approvals = BigInt(x.held.approvals);
      const root = rootOfHex(x.held.signerRoot);
      return hexOf(P.anchorHeadOf(previous, x.resumesFrom === undefined
        ? P.anchorHeldOf(batch, approvals, root, tag)
        : P.anchorRecoveredOf(batch, approvals, root, tag, bytesOf('head', String(x.resumesFrom).toLowerCase()))));
    } catch {
      return hexOf(ZERO_32);
    }
  };
  return {
    after: input.after.map(headAfter),
    seats: input.after.map((x) => seatsOf(x.held)),
    holderSeats: (input.holders ?? []).map(seatsOf),
  };
}

/**
 * **ONE HEAD THE ACCOUNT'S HISTORY SHOWS**: the head the last anchor call of a
 * block left, and the block - its height and the time its author set, in
 * milliseconds. A head another anchor of the same block moved on from is never
 * shown, and the next head shown is that block's. The approvals and seats a
 * batch was judged against are never read off these states: they are what the
 * batch's header names, which the call checked.
 */
export interface AnchorLanded {
  readonly head: string;
  /**
   * The approvals a change of who is seated needed in the state this head's
   * block left (`seatBarOf`): what a demotion or retirement the batch anchored
   * is held to. A bar changed in the same block shows here as changed.
   */
  readonly seatBar: number;
  /** The tag of the seat that moved the head there, as the account wrote it beside the head; absent where a test's chain names none. */
  readonly tag?: string;
  readonly height: number;
  readonly at: number;
  /**
   * How many calls to move the anchor - `anchor` or `recoverAnchor` - this
   * head's block held, whatever their transactions' results, where the history
   * names its calls. The indexer keeps one state a block, so with more
   * than one the tag is the block's last anchoring seat's, not surely the one
   * that moved the head past any one head of that block.
   */
  readonly anchorsInBlock?: number;
  /** A recovery the quorum approved moved the anchor in this head's block, where the history names its calls. */
  readonly recovered?: boolean;
}

/**
 * **WHAT A DEVICE READS OF THE ACCOUNT'S HISTORY**: every head it shows,
 * oldest first, and who holds the account in its latest state as a batch's
 * header names them - what an anchoring device judges its batch against.
 */
export interface AnchorsOnChain {
  readonly landed: readonly AnchorLanded[];
  readonly now: BatchHolders;
  /** The seats `now` names: every leaf but the vacant-slot one. */
  readonly seatsNow: readonly string[];
  /** How the account was deployed (`accountDeployedIn`); null when its history does not open with its deploy. */
  readonly deployed: AccountDeployed | null;
  /** Every payroll run whose approvals vouch for the head its raiser sealed (`vouchingRunsIn`), oldest first. */
  readonly vouching: readonly VouchingRun[];
}

/**
 * **HOW THE ACCOUNT WAS DEPLOYED, AS THE FIRST STEP OF ITS HISTORY SHOWS IT**:
 * the seats, the maintenance committee, its threshold and its update counter
 * that step's state lists, and whether the account already ran a circuit the
 * second creation step inserts - the record anchor among them. An account
 * deployed held by one key alone at a threshold of one, with no second-step
 * circuit, gains `anchor` only through an update that key signs. The state is
 * the one after the whole block the deploy is in: an update in that block
 * shows here as a counter above zero, read as not deployed so.
 */
export interface AccountDeployed {
  readonly seats: readonly string[];
  readonly committee: readonly CommitteeKey[];
  readonly threshold: number;
  /** How many updates the maintenance committee had made by then: zero for the deploy's own state. */
  readonly updates: number;
  readonly ranSecondStep: boolean;
}

/**
 * **HOW THE ACCOUNT WAS DEPLOYED**, from the first step of its history (oldest
 * first): null unless that step is the deploy. Who held it is read with the
 * account's seats reader the caller hands in (`seatsIn`, the one way a wallet
 * reads them); its operations with the contract runtime's own reader; its
 * update counter through the one reader of a contract's authority
 * (`authorityIn`); the second step's circuits from the one list of them
 * (`CREATION_STEPS`). Throws when that reader refuses the deploy's authority:
 * a counter that cannot be read is not one no update touched, and a null here
 * would say the history does not open with a deploy, which is not what was
 * found, so the device refuses the whole reading rather than believe either.
 */
export function accountDeployedIn(
  deps: Pick<GovernedCallDeps, 'runtimeState'>,
  steps: ReadonlyArray<{ readonly kind: string; readonly state: Uint8Array }>,
  seatsIn: (state: Uint8Array) => { readonly seats: readonly string[]; readonly committee: readonly CommitteeKey[]; readonly threshold: number },
): AccountDeployed | null {
  const first = steps[0];
  if (first === undefined || first.kind !== 'deploy') return null;
  const held = seatsIn(first.state);
  const state = deps.runtimeState.deserialize(first.state) as { operations(): Array<string | Uint8Array> };
  const authority = authorityIn(state);
  if ('why' in authority) throw new Error(`how the company's account was deployed cannot be read: ${authority.why}`);
  const second = new Set<string>(CREATION_STEPS.second);
  const ranSecondStep = state.operations().some((op) => second.has(typeof op === 'string' ? op : new TextDecoder().decode(op)));
  return {
    seats: held.seats.map((s) => String(s).toLowerCase()),
    committee: held.committee.map((k) => ({ tag: String(k.tag), value: String(k.value).toLowerCase() })),
    threshold: Number(held.threshold),
    updates: Number(authority.counter),
    ranSecondStep,
  };
}

/**
 * **EVERY HEAD THE ACCOUNT'S HISTORY SHOWS, OLDEST FIRST**: each step of the
 * history whose state holds a head other than the step before it, with the
 * head and its block; where the history names each step's call, how many
 * calls moved the anchor in that block and whether a recovery was one of them.
 * The head before the first step is the empty head. Each head's seat bar is
 * read from that step's state with `seatBarIn`, the one reader of the
 * account's approvals a wallet reads them with.
 */
export function anchorsLandedIn(
  deps: Pick<GovernedCallDeps, 'accountPure' | 'accountLedger' | 'runtimeState'>,
  steps: ReadonlyArray<{
    readonly state: Uint8Array; readonly block: { readonly height: number; readonly at: number };
    readonly entryPoint?: string; readonly succeeded?: boolean;
  }>,
  seatBarIn: (state: Uint8Array) => number,
): AnchorLanded[] {
  const landed: AnchorLanded[] = [];
  const blocks = new Map<number, (typeof steps)[number][]>();
  for (const x of steps) blocks.set(x.block.height, [...(blocks.get(x.block.height) ?? []), x]);
  let before = hexOf(ZERO_32);
  for (const step of steps) {
    const { head, tag } = headInState(deps, step.state);
    if (head === before) continue;
    /*
     * One state a block. Every call to move the anchor in it is counted, whatever its transaction's result - one in a
     * guaranteed section moves the head even where the transaction succeeded only in part - so the count errs only on
     * the side of naming no seat; a recovery is read only from a call whose transaction succeeded in full.
     */
    const block = blocks.get(step.block.height)!;
    const named = block.some((x) => x.entryPoint !== undefined);
    const calls = block.filter((x) => x.entryPoint === 'anchor' || x.entryPoint === 'recoverAnchor');
    const seatBar = seatBarIn(step.state);
    if (!Number.isSafeInteger(seatBar) || seatBar < 1) throw new AnchorNotBuilt('the approvals a change of who is seated needs could not be read from the account\'s state');
    landed.push({
      head, seatBar, ...(tag === null ? {} : { tag }), height: step.block.height, at: step.block.at,
      ...(named ? { anchorsInBlock: calls.length, recovered: calls.some((x) => x.entryPoint === 'recoverAnchor' && x.succeeded === true) } : {}),
    });
    before = head;
  }
  return landed;
}

/**
 * **WHERE ONE PROPOSAL STANDS ON THE CHAIN**, as the account's history at the
 * indexer the person's own wallet names shows it:
 *
 *   - `held`: `open` while the account's latest state holds it among its open
 *     proposals, `cleared` once that entry is the mark `clearRun` writes, `closed`
 *     once a state held it and the latest no longer does, `never` when no state
 *     the history shows held it - withdrawn before it reached the chain, refused
 *     by the service, sent and not yet seen, or opened and closed within one
 *     block, which no block's state shows: the chain cannot tell them apart.
 *     An identity held again after it closed is read from its latest time held;
 *   - `approvals`: the account's count of approvals for it now, 0 when not held;
 *   - `raisedAt`: the time, in milliseconds, the author of the first block of
 *     that time whose state held it set for that block;
 *   - `txRef`: the transaction of the one call to `propose` in that block whose
 *     transaction succeeded in full - absent when the block holds more than
 *     one, since a state is a whole block's;
 *   - `closedBy`: the circuits called by every call of a transaction that
 *     succeeded in full in the first block whose state no longer held it -
 *     the call that closed it among them, beside any other proposal's calls of
 *     that block; a failed call closes nothing, so none is named;
 *   - `failedCalls`: while it is held, the circuits called by every call whose
 *     transaction landed without succeeding in full in a block since it was
 *     raised - a call in its transaction's fallible section that the account
 *     refused, its fee paid and nothing of it written. A state names no
 *     proposal a call was for, so a failed call is any proposal's of those
 *     blocks;
 *   - `needed`: while it is held, the approvals the account recorded it as
 *     needing when it was raised (its hold) - for a change to the company, the
 *     account's threshold then. Absent where the state holds no hold for it.
 */
export interface RoundOnChain {
  readonly held: 'open' | 'cleared' | 'closed' | 'never';
  readonly approvals: number;
  readonly raisedAt?: number;
  readonly txRef?: string;
  readonly closedBy?: readonly string[];
  readonly failedCalls?: readonly string[];
  /** The approvals its hold says it needed when it was raised; the account carries it out only at least at this many. */
  readonly needed?: number;
  /**
   * Open, and a signer was removed or replaced since it was raised: the account's count of removals is no longer the
   * one its hold took at the raise, so the account will never carry it out (`requireApproved`). It is raised again.
   */
  readonly outrun?: true;
}

/**
 * **WHERE EACH PROPOSAL ASKED ABOUT STANDS, FROM THE ACCOUNT'S HISTORY**: every
 * block's state read once with the account's own ledger reader, oldest first.
 * `chainIds` are the proposals' identities on chain, as 64 hex digits.
 */
export function roundsOnChainIn(
  deps: Pick<GovernedCallDeps, 'accountPure' | 'accountLedger' | 'runtimeState'>,
  steps: ReadonlyArray<{
    readonly kind: string; readonly transaction: string; readonly state: Uint8Array; readonly entryPoint?: string;
    readonly block: { readonly height: number; readonly at: number }; readonly succeeded: boolean;
  }>,
  chainIds: readonly string[],
): ReadonlyMap<string, RoundOnChain> {
  const cleared = deps.accountPure.clearedMark;
  if (deps.accountLedger === undefined || typeof cleared !== 'function') {
    throw new Error('this device was not given the account\'s reader, so where its proposals stand on the chain was not read. Reload the page');
  }
  type View = {
    openProposals: { member(id: Uint8Array): boolean; lookup(id: Uint8Array): Uint8Array };
    approvalCounts: { member(id: Uint8Array): boolean; lookup(id: Uint8Array): bigint };
    proposalHolds?: { member(id: Uint8Array): boolean; lookup(id: Uint8Array): { readonly removals: bigint; readonly needed?: bigint } };
  };
  /* The account's own count of signers removed, where this device was given where it keeps it. */
  const removalKey = deps.accountPure.removalCountKey?.();
  const removalsIn = (v: View, id: Uint8Array): bigint | null =>
    (v.proposalHolds !== undefined && v.proposalHolds.member(id) ? BigInt(v.proposalHolds.lookup(id).removals) : null);
  const viewOf = (state: Uint8Array) => deps.accountLedger!((deps.runtimeState.deserialize(state) as { data: unknown }).data) as View;
  /* One state per block: every step of a block shows the state after the whole block. */
  const blocks: Array<{ readonly at: number; readonly steps: typeof steps[number][]; readonly view: View }> = [];
  for (const step of steps) {
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.steps[0]!.block.height === step.block.height) last.steps.push(step);
    else blocks.push({ at: step.block.at, steps: [step], view: viewOf(step.state) });
  }
  const callsIn = (b: (typeof blocks)[number]) => b.steps.filter((x) => x.kind === 'call');
  const out = new Map<string, RoundOnChain>();
  for (const asked of chainIds) {
    const hex = String(asked).toLowerCase();
    if (!HEX64.test(hex)) throw new Error('a proposal was asked about by an identity that is not thirty-two bytes');
    const id = bytesOf('proposal', hex);
    let first = -1;
    let gone = -1;
    /* The latest time it was held: an identity proposed again after it closed is read from that second time on. */
    blocks.forEach((b, i) => {
      const held = b.view.openProposals.member(id);
      if (held && (first < 0 || gone >= 0)) { first = i; gone = -1; }
      if (!held && first >= 0 && gone < 0) gone = i;
    });
    if (first < 0) { out.set(hex, { held: 'never', approvals: 0 }); continue; }
    const raised = blocks[first]!;
    const proposes = callsIn(raised).filter((x) => x.entryPoint === 'propose' && x.succeeded);
    const base = { raisedAt: raised.at, ...(proposes.length === 1 ? { txRef: proposes[0]!.transaction } : {}) };
    if (gone >= 0) {
      const closing = callsIn(blocks[gone]!).filter((x) => x.succeeded);
      out.set(hex, { held: 'closed', approvals: 0, ...base, closedBy: [...new Set(closing.map((x) => x.entryPoint ?? ''))] });
      continue;
    }
    const now = blocks[blocks.length - 1]!.view;
    const approvals = now.approvalCounts.member(id) ? Number(now.approvalCounts.lookup(id)) : 0;
    const failedCalls = blocks.slice(first).flatMap(callsIn).filter((x) => !x.succeeded).map((x) => x.entryPoint ?? '');
    const atRaise = removalKey === undefined ? null : removalsIn(now, id);
    const outrun = atRaise !== null && removalKey !== undefined && atRaise !== (removalsIn(now, removalKey) ?? 0n);
    const held = now.proposalHolds !== undefined && now.proposalHolds.member(id) ? now.proposalHolds.lookup(id).needed : undefined;
    const needed = held === undefined || held === null ? undefined : Number(held);
    out.set(hex, {
      held: hexOf(now.openProposals.lookup(id)) === hexOf(cleared()) ? 'cleared' : 'open', approvals, ...base,
      ...(failedCalls.length === 0 ? {} : { failedCalls }), ...(needed === undefined || !Number.isSafeInteger(needed) ? {} : { needed }),
      ...(outrun ? { outrun: true as const } : {}),
    });
  }
  return out;
}

/**
 * Every circuit of the account that closes a proposal (`closeProposal`, ConfidentialAccount.compact), named so a
 * block that holds any of them beside a seating is never read as that seating's. Checked against the contract's
 * source by every-circuit-that-closes-a-proposal-is-known.test.ts.
 */
export const PROPOSAL_CLOSING_CIRCUITS: readonly string[] = Object.freeze([
  'adopt', 'amendSigner', 'approveVaultChange', 'cancel', 'closeExpiredRun', 'recoverAnchor', 'removeSignerAndSetThreshold',
  'reseatSigner', 'retireVault', 'sealPayKey', 'seatInvited', 'setPolicy', 'setPolicyBar', 'setThreshold', 'setVaultThreshold',
]);

/**
 * The leaf each invitation's proposal seated, read from the account's own history: for each proposal asked
 * about, the one leaf that entered the account's signers in a block where the account stopped holding the
 * proposal, when that block's only successful call that closes a proposal is one `seatInvited`, and exactly
 * one leaf entered. Every such block is read, the latest seating taken: a proposal cancelled and raised again under
 * its own salt closes once for the cancel and again when it seats. The steps carry no call's arguments, so a block where anything
 * else closed a proposal (a `cancel` of this one beside a seating for another, say) cannot show which call closed
 * which. Null for a proposal never closed, closed by anything else, or closed in such a block: a state is the
 * whole block's, and no seat is bound to an invitation on a guess.
 */
export function seatsInvitedIn(
  deps: Pick<GovernedCallDeps, 'accountLedger' | 'runtimeState'>,
  steps: ReadonlyArray<{
    readonly kind: string; readonly state: Uint8Array; readonly entryPoint?: string;
    readonly block: { readonly height: number; readonly at: number }; readonly succeeded: boolean;
  }>,
  proposals: readonly string[],
): ReadonlyMap<string, string | null> {
  if (deps.accountLedger === undefined) {
    throw new Error('this device was not given the account\'s reader, so which seat each invitation took was not read. Reload the page');
  }
  type View = {
    openProposals: { member(id: Uint8Array): boolean };
    signerLeaves: Iterable<Uint8Array>;
  };
  const viewOf = (state: Uint8Array) => deps.accountLedger!((deps.runtimeState.deserialize(state) as { data: unknown }).data) as View;
  const blocks: Array<{ readonly steps: typeof steps[number][]; readonly view: View }> = [];
  for (const step of steps) {
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.steps[0]!.block.height === step.block.height) last.steps.push(step);
    else blocks.push({ steps: [step], view: viewOf(step.state) });
  }
  const leavesOf = (v: View): Set<string> => new Set([...v.signerLeaves].map((l) => hexOf(l)));
  const out = new Map<string, string | null>();
  for (const asked of proposals) {
    const hex = String(asked).toLowerCase();
    if (!HEX64.test(hex)) throw new Error('an invitation\'s proposal was asked about by an identity that is not thirty-two bytes');
    const id = bytesOf('proposal', hex);
    /* Every block where the account stopped holding it: a proposal cancelled and raised again closes more than once. */
    let seat: string | null = null;
    blocks.forEach((b, gone) => {
      if (gone < 1 || !blocks[gone - 1]!.view.openProposals.member(id) || b.view.openProposals.member(id)) return;
      const closers = b.steps.filter((x) => x.kind === 'call' && x.succeeded && PROPOSAL_CLOSING_CIRCUITS.includes(x.entryPoint ?? ''));
      const before = leavesOf(blocks[gone - 1]!.view);
      const added = [...leavesOf(b.view)].filter((l) => !before.has(l));
      const onlyThisSeating = closers.length === 1 && closers[0]!.entryPoint === 'seatInvited';
      if (onlyThisSeating && added.length === 1) seat = added[0]!;
    });
    out.set(hex, seat);
  }
  return out;
}

/** What a payroll run's identity on chain is made from, as its sealed proposal holds them, with the head its raiser checked: decimal and hexadecimal. */
export interface VouchedRunOnTheWire {
  readonly root: string; readonly payees: string; readonly opensAt: string; readonly closesAt: string; readonly required: string;
  readonly vault: string; readonly head: string; readonly r: string;
}

/**
 * **THE IDENTITY ON CHAIN A LEG'S RUN WOULD HAVE, RAISED OVER THE HEAD IT
 * SEALS**, by the account's own functions: `proposalIdOf(runPayload(..), vault,
 * retrySaltOf(no leg, vouchedFreshOf(head, r)))`. A device that finds it is the
 * run's own identity knows the run's approvers approved that head. Null for a
 * run of no vault, which vouches for nothing.
 */
export function vouchedRunIdentityOf(deps: Pick<GovernedCallDeps, 'accountPure'>, run: VouchedRunOnTheWire): string | null {
  const P = deps.accountPure;
  if (P.retrySaltOf === undefined) throw new Error('this device was not given the account\'s functions a run\'s salt is made with. Reload the page');
  const whole = (what: string, v: string): bigint => {
    if (!/^(0|[1-9][0-9]*)$/u.test(String(v))) throw new Error(`a vouching run's ${what} is not a whole number`);
    return BigInt(v);
  };
  if (vouchedRefusal({ head: run.head, r: run.r }) !== null) return null;
  const vault = bytesOf('vault', String(run.vault).toLowerCase());
  if (hexOf(vault) === hexOf(P.noVault())) return null;
  const payload = P.runPayload(bytesOf('run root', String(run.root).toLowerCase()), whole('payee count', run.payees),
    whole('window', run.opensAt), whole('window', run.closesAt), whole('approvals', run.required));
  const salt = P.retrySaltOf(NO_LEG(), bytesOf('fresh', vouchedFreshOf(run.head.toLowerCase() as Hex, run.r.toLowerCase() as Hex)));
  return hexOf(P.proposalIdOf(payload, vault, salt));
}

/** A payroll run that vouches for the head its raiser sealed: its identity on chain, and the block of the last state showing it paid or charged. */
export interface VouchingRun { readonly chainId: string; readonly height: number; readonly at: number }

/**
 * **EVERY RUN WHOSE APPROVALS VOUCH FOR WHAT IT WAS RAISED OVER, FROM THE
 * ACCOUNT'S HISTORY**: each proposal a state holds charged to its period (the
 * mark `clearRun` writes) or paid from (the mark `markPaidFrom` writes on its
 * hold), read at the last state that shows it so, and kept only when that
 * state counts the approvals the account's `runApprovalsNeeded` gives for it,
 * with the account's threshold standing as the vault's bar: the higher of its
 * bar when raised and that threshold, plus one for every signer removed since it
 * was raised. A run approved only to a vault's lower threshold does not reach it. Only payroll
 * runs carry either mark. A run whose hold was released before it was paid
 * keeps the released mark, not the paid one, and vouches nothing unless the
 * account charged it. Oldest first.
 */
export function vouchingRunsIn(
  deps: Pick<GovernedCallDeps, 'accountPure' | 'accountLedger' | 'runtimeState'>,
  steps: ReadonlyArray<{ readonly state: Uint8Array; readonly block: { readonly height: number; readonly at: number } }>,
): VouchingRun[] {
  const P = deps.accountPure;
  if (deps.accountLedger === undefined || P.clearedMark === undefined || P.paidFromMark === undefined || P.removalCountKey === undefined
    || P.runApprovalsNeeded === undefined) {
    throw new Error('this device was not given the account\'s reader, so which runs vouch for the company\'s records was not read. Reload the page');
  }
  const cleared = hexOf(P.clearedMark());
  const paidFrom = hexOf(P.paidFromMark());
  const removalKey = P.removalCountKey();
  const neededFor = P.runApprovalsNeeded;
  type Hold = { readonly needed: bigint; readonly removals: bigint; readonly runHold: { readonly placedBy: Uint8Array } };
  type View = {
    readonly threshold: bigint;
    readonly openProposals: Iterable<[Uint8Array, Uint8Array]>;
    readonly approvalCounts: { member(id: Uint8Array): boolean; lookup(id: Uint8Array): bigint };
    readonly proposalHolds: { member(id: Uint8Array): boolean; lookup(id: Uint8Array): Hold };
  };
  /* The last state showing each run marked, and whether it counted enough approvals then. */
  const last = new Map<string, { readonly vouches: boolean; readonly height: number; readonly at: number }>();
  let height = Number.NaN;
  for (const step of steps) {
    /* One state per block: every step of a block shows the state after the whole block. */
    if (step.block.height === height) continue;
    height = step.block.height;
    const view = deps.accountLedger((deps.runtimeState.deserialize(step.state) as { data: unknown }).data) as View;
    const removals = view.proposalHolds.member(removalKey) ? BigInt(view.proposalHolds.lookup(removalKey).removals) : 0n;
    for (const [id, change] of view.openProposals) {
      const hold = view.proposalHolds.member(id) ? view.proposalHolds.lookup(id) : null;
      const marked = hexOf(change) === cleared || (hold !== null && hexOf(hold.runHold.placedBy) === paidFrom);
      if (!marked) continue;
      const approvals = view.approvalCounts.member(id) ? BigInt(view.approvalCounts.lookup(id)) : 0n;
      const vouches = hold !== null
        && approvals >= BigInt(neededFor(BigInt(hold.needed), BigInt(view.threshold), removals, BigInt(hold.removals)));
      last.set(hexOf(id), { vouches, height: step.block.height, at: step.block.at });
    }
  }
  return [...last].filter(([, l]) => l.vouches).map(([chainId, l]) => ({ chainId, height: l.height, at: l.at }))
    .sort((a, b) => a.height - b.height);
}

/**
 * **WHERE THE ANCHOR CALL LANDS IN ITS TRANSACTION.** A call in the guaranteed
 * section that reads a head another device has since moved fails the whole
 * transaction, so nothing is applied and no fee is paid; in the fallible
 * section the transaction would land, its fee paid, with the anchor not
 * written. So it is read off the transaction, never assumed.
 */
export function anchorPlacementOf(unproven: unknown, circuit: 'anchor' | 'recoverAnchor' = 'anchor'): 'guaranteed' | 'fallible' | 'unread' {
  const intents = (unproven as { intents?: unknown } | null)?.intents;
  if (!(intents instanceof Map)) return 'unread';
  const calls: Array<{ guaranteedTranscript?: unknown; fallibleTranscript?: unknown }> = [];
  for (const intent of intents.values()) {
    const actions = (intent as { actions?: unknown } | null)?.actions;
    if (!Array.isArray(actions)) return 'unread';
    for (const a of actions) {
      const name = (a as { entryPoint?: unknown } | null)?.entryPoint;
      const named = name instanceof Uint8Array ? new TextDecoder().decode(name) : String(name);
      if (named !== circuit) return 'unread';
      calls.push(a as { guaranteedTranscript?: unknown; fallibleTranscript?: unknown });
    }
  }
  if (calls.length !== 1) return 'unread';
  const c = calls[0]!;
  if (c.fallibleTranscript !== undefined && c.fallibleTranscript !== null) return 'fallible';
  return c.guaranteedTranscript !== undefined && c.guaranteedTranscript !== null ? 'guaranteed' : 'unread';
}

/**
 * **WHERE EACH ANCHOR CALL MAY BE BUILT IN ITS TRANSACTION.** `anchor` only in
 * the guaranteed section, where a call another device's anchor beat costs
 * nothing. `recoverAnchor` wherever it lands: at the ledger's initial
 * parameters its checks are over the guaranteed section's budget, so it lands
 * in the fallible one, and a carrying out another anchor beats pays its fee,
 * writes nothing and leaves the recovery open - read off the transaction once
 * it is on the chain (`RoundOnChain.failedCalls`) and said, with the recovery
 * carried out again within its window.
 */
const ANCHOR_CALL_MAY_LAND_IN: Readonly<Record<'anchor' | 'recoverAnchor', readonly ('guaranteed' | 'fallible')[]>> = {
  anchor: ['guaranteed'],
  recoverAnchor: ['guaranteed', 'fallible'],
};

/** Where an anchor call this device built lands in its transaction, as read off it. */
export type AnchorPlacement = 'guaranteed' | 'fallible';

/**
 * **ONE ANCHOR CALL, BUILT AND PROVED HERE**: the batch folded into the head
 * this device read, with this signer's own material proving they are a signer.
 * The record composed for it holds the signer's three and answers nothing
 * else. Refused before it is proved when the call would not land in the
 * transaction's guaranteed section (`ANCHOR_CALL_MAY_LAND_IN`), and when the head
 * this device read is not the one the state it was given holds - the
 * contract's own refusal, read here before anything is sent.
 */
export async function buildAnchorCall(
  deps: GovernedCallDeps,
  input: {
    readonly account: string; readonly material: SignerMaterial; readonly chain: AccountCallChain;
    readonly previous: string; readonly batch: string;
    /** Who held the account as this device judged the batch, as its header names them; the call is refused unless they still do. */
    readonly held: Pick<BatchHolders, 'approvals' | 'signerRoot'>;
  },
): Promise<{ proven: Uint8Array }> {
  return { proven: (await buildAnAnchorCall(deps, input, 'anchor', [], {})).proven };
}

/**
 * **ONE RECOVERY OF THE RECORD ANCHOR, BUILT AND PROVED HERE**: as an anchor
 * call (`buildAnchorCall`), moving the head on from the one this device read by
 * the recovery's batch, resuming from the head `resumesFrom` names, before the
 * time `latest` names, while the head the latest recovery carried out wrote
 * is still `lastRecovery`, under the approved proposal `proposal` raised with
 * `proposalSalt` - the one thing of the account's half its record answers.
 * Refused with its own reason before the account's circuit is run when the three
 * values and the salt do not make `proposal` with the account's own functions.
 * The circuit's own check would refuse it too, as the call is built and before
 * anything is proved or sent, so no fee is at stake; this says why in the
 * recovery's words rather than the circuit's. Built in whichever section of its
 * transaction it lands in (`ANCHOR_CALL_MAY_LAND_IN`), which is handed back: in
 * the fallible one, a carrying out another anchor beats pays its fee.
 */
export async function buildRecoverAnchorCall(
  deps: GovernedCallDeps,
  input: {
    readonly account: string; readonly material: SignerMaterial; readonly chain: AccountCallChain;
    readonly previous: string; readonly batch: string; readonly held: Pick<BatchHolders, 'approvals' | 'signerRoot'>;
    readonly resumesFrom: string; readonly latest: string; readonly lastRecovery: string;
    readonly proposal: string; readonly proposalSalt: string;
  },
): Promise<{ proven: Uint8Array; placement: AnchorPlacement }> {
  const resumesFrom = bytesOf('head it resumes from', String(input.resumesFrom).toLowerCase());
  const latest = digitsOf('recovery\'s last time', input.latest);
  const lastRecovery = bytesOf('latest recovery\'s head', String(input.lastRecovery).toLowerCase());
  const proposal = bytesOf('proposal', String(input.proposal).toLowerCase());
  const salt = bytesOf('proposal\'s salt', String(input.proposalSalt).toLowerCase());
  let made: Uint8Array;
  try {
    made = deps.accountPure.proposalIdOf(governancePayloadOf(deps, {
      kind: 'recover-anchor', resumesFrom: String(input.resumesFrom).toLowerCase(), latest: String(input.latest),
      lastRecovery: String(input.lastRecovery).toLowerCase(),
    }), deps.accountPure.noVault(), salt);
  } catch (e) {
    throw new AnchorNotBuilt((e as Error)?.message?.replace(/\.$/u, '') ?? String(e), { cause: e, recovery: true });
  }
  if (hexOf(made) !== hexOf(proposal)) {
    throw new AnchorNotBuilt('the recovery this device was asked to carry out is not the proposal the signers approved: the head it '
      + 'resumes from, its last time, the latest recovery and its salt make another identity. Reload the page and carry it out again '
      + 'from the proposal\'s own file', { recovery: true });
  }
  return buildAnAnchorCall(deps, input, 'recoverAnchor', [resumesFrom, latest, lastRecovery, proposal], { proposalSalt: salt });
}

/** An anchor call or a recovery, as the two builders above take them: the anchor's arguments first, then `more`. */
async function buildAnAnchorCall(
  deps: GovernedCallDeps,
  input: {
    readonly account: string; readonly material: SignerMaterial; readonly chain: AccountCallChain;
    readonly previous: string; readonly batch: string; readonly held: Pick<BatchHolders, 'approvals' | 'signerRoot'>;
  },
  circuit: 'anchor' | 'recoverAnchor', more: readonly (Uint8Array | bigint)[], answers: { readonly proposalSalt?: Uint8Array },
): Promise<{ proven: Uint8Array; placement: AnchorPlacement }> {
  const recovery = circuit === 'recoverAnchor';
  const account = String(input.account).toLowerCase();
  if (!HEX64.test(account)) throw new AnchorNotBuilt('this call is not for a company account this device can name', { recovery });
  anchorPure(deps);
  const previous = bytesOf('head', String(input.previous).toLowerCase());
  const batch = bytesOf('batch', String(input.batch).toLowerCase());
  if (!Number.isSafeInteger(input.held?.approvals) || input.held.approvals < 1) {
    throw new AnchorNotBuilt('the batch does not name the approvals the account required as it was judged', { recovery });
  }
  const approvals = BigInt(input.held.approvals);
  const signerRoot = rootOfHex(input.held.signerRoot);
  const record = { ...signerHalfOf(input.material), pinnedPath: null, ...answers } as AccountPrivateState;
  for (const field of ACCOUNT_FIELDS) {
    if (field in answers) continue;
    Object.defineProperty(record, field, {
      enumerable: false,
      get: () => { throw new AnchorNotBuilt(`the ${circuit === 'anchor' ? 'anchor' : 'recovery'} call read "${field}" from this device, and it has never needed it. The company's contract is not the one this page was built for; reload the page`, { recovery }); },
    });
  }
  Object.freeze(record);
  try {
    const L = deps.ledger;
    const seed = (deps.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(32);
    const keys = L.ZswapSecretKeys.fromSeed(seed);
    const coinPublicKey = keys.coinPublicKey;
    const encryptionPublicKey = keys.encryptionPublicKey;
    seed.fill(0);
    try { keys.clear?.(); } catch { /* nothing to clear */ }
    let built: any;
    try {
      built = await deps.contracts.createUnprovenCallTxFromInitialStates(deps.accountZkConfig, {
        compiledContract: deps.accountCompiled,
        circuitId: circuit,
        contractAddress: account,
        coinPublicKey,
        initialContractState: deps.runtimeState.deserialize(input.chain.accountState),
        /* An anchor moves no coin. */
        initialZswapChainState: new L.ZswapChainState(),
        ledgerParameters: L.LedgerParameters.deserialize(input.chain.parameters),
        initialPrivateState: record,
        args: [previous, batch, approvals, signerRoot, ...more],
      }, encryptionPublicKey);
    } catch (e) {
      if (e instanceof AnchorNotBuilt) throw e;
      const said = theWitnessSaid(circuit, e);
      throw new AnchorNotBuilt((said as Error)?.message ?? String(said), { cause: e, recovery });
    }
    if (built?.private?.nextPrivateState !== record) throw new RecordChangedByTheCall(circuit);
    const placement = anchorPlacementOf(built.private.unprovenTx, circuit);
    if (placement === 'unread') {
      throw new AnchorNotBuilt('the transaction built is not one anchor call this device can read. Reload the page to use the current build', { recovery });
    }
    if (!ANCHOR_CALL_MAY_LAND_IN[circuit].includes(placement)) {
      throw new AnchorNotBuilt('the call would land where, if another device anchored first, its fee would be paid and nothing written. Reload the '
        + 'page and anchor again', { recovery });
    }
    const proven = await deps.prove(built.private.unprovenTx, circuit);
    return { proven: proven.serialize(), placement };
  } finally {
    wipe(record);
  }
}
