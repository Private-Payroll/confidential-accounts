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
 *   the deadline          for a raise only: the last chain time it may land at,
 *                         `raiseBy`, never from the service's order. It is the
 *                         time the proposal's signed record says it was written
 *                         down plus a day, or for a recovery raised from the
 *                         chain its own last time to be carried out. Past it
 *                         by this device's clock the raise is refused before
 *                         it is built (`RaiseTooLate`).
 *   the chain             the account's contract state and the ledger
 *                         parameters, both as one block saw them.
 *
 * **WHAT LEAVES THIS FILE IS A PROVEN TRANSACTION.** It carries no coin of
 * anybody's: a raise and an approval move nothing, and the two public keys the
 * call builder asks for are made from randomness nobody keeps.
 */
import type { AccountPrivateState, PolicyOpening } from '../../../contracts/src/witnesses.js';
import type { Hex } from '../../../src/core/crypto.js';
import { HEX64 } from '../../../src/midnight/directory-change-shape.js';
import { CIRCUITS_THAT_READ_NO_WITNESS } from '../../../src/midnight/governed-call.js';
import { ACCOUNT_CIRCUITS_A_DEVICE_GOVERNS } from '../../../src/midnight/vault-contract.js';
import type { BatchHolders } from '../../../src/midnight/record-manifest.js';
import { signerHalfOf, type SignerMaterial } from './private-state.js';
import type { Provable } from './vault-proof-workers.js';
import { type AccountLedgerView, refuseWhatThisDeviceDidNotMake } from './what-this-device-made.js';
import type { DetailsOfKind } from '../../../src/midnight/payout-tree.js';
import type { AccountStartPure, VaultStartPure } from '../../../src/midnight/vault-start.js';
import { policyOpeningFromWire } from '../../../src/midnight/spending-policy-record.js';
import { bytesOf, digitsOf, governancePayloadOf, hexOf, invitationThresholdOf } from './governance-payload.js';
import {
  ACCOUNT_FIELDS,
  NotReadByAnApproval,
  RecordChangedByTheCall,
  refuseARaisePastItsTime,
  refuseARaiseThatIsNotTheRecordedOne,
  refuseAWalletsCoinKey,
  refuseWhatThisDeviceDidNotOpen,
  theWitnessSaid,
  withNoInvitation
} from './governed-call-refusals.js';
import { type AccountCallChain, type GovernedCallOrder, type OpenedRound, raisesARun } from './governed-call-wire.js';
import { throwawayKeys } from './vault-builder.js';
import { SPENDS_NO_COIN, type ContractCalls } from './contract-call-built.js';
import { AnchorNotBuilt, anchorPure, rootOfHex } from './account-anchors-read.js';
import { callsOnTheAccountIn, type RoundOnChain } from './account-calls-read.js';
import { argumentsBuilt, deadlineOf } from './governed-call-arguments.js';
export {
  type AccountCallChain,
  type GovernanceOnTheWire,
  type GovernedCallOrder,
  NotWhatThisDeviceOpened,
  type OpenedRound,
  type RaiseHalfOnTheWire,
  type RaiseRunOrder,
  raisesARun,
  RecordDoesNotAddUp,
  type RoundChangeOnTheWire,
  type RunOnTheWire
} from './governed-call-wire.js';
export {
  CallNotBuilt,
  NotReadByAnApproval,
  RaiseTooLate,
  RecordChangedByTheCall,
  refuseARaiseThatIsNotTheRecordedOne,
  refuseWhatThisDeviceDidNotOpen,
  WalletKeyNotForAPage
} from './governed-call-refusals.js';
export {
  argumentsFor,
  identityOfAChange,
  type ProposalIdentity,
  type SpendingPolicyKeys,
  spendingPolicyKeysOf
} from './governed-call-arguments.js';
export {
  type AccountDeployed,
  accountDeployedIn,
  anchorHeadsAfter,
  type AnchorLanded,
  AnchorNotBuilt,
  anchorsLandedIn,
  type AnchorsOnChain,
  batchHoldersIn,
  type HeadStepAsked,
  lastRecoveryIn,
  OPEN_PROPOSALS_FIELD,
  seatsNamedBy,
  signerRootOf,
  signersMakeTheirRoot
} from './account-anchors-read.js';
export {
  type CallOnTheAccount,
  callsOnTheAccountIn,
  PROPOSAL_CLOSING_CIRCUITS,
  type RoundOnChain,
  runsOutrunIn,
  vouchedRunIdentityOf,
  type VouchedRunOnTheWire,
  type VouchingRun,
  vouchingRunsIn
} from './account-calls-read.js';

export { governancePayloadOf };

export type { SignerMaterial } from './private-state.js';

export const ZERO_32 = new Uint8Array(32);

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
  readonly contracts: Pick<ContractCalls, 'buildCall'>;
  /** The network the ask names, whose settings every call is built with. */
  readonly network: string;
  /** The company account's compiled contract, with the account's own witnesses. */
  readonly accountCompiled: unknown;
  /** Hands out the account circuits' verifying keys. */
  readonly accountZkConfig: unknown;
  /** Proves an unproven transaction for the circuit it names. */
  readonly prove: (unproven: Provable, circuit?: string) => Promise<{ serialize(): Uint8Array }>;
  /** The company account's own pure circuits, which make a proposal's identity from its parts. */
  readonly accountPure: {
    runPayload(root: Uint8Array, payees: bigint, opensAt: bigint, closesAt: bigint, required: bigint): Uint8Array;
    proposalIdOf(payload: Uint8Array, vault: Uint8Array, salt: Uint8Array): Uint8Array;
    /** A run's salt, `retrySaltOf(leg, fresh)`: asked for where a payroll run is raised, approved or charged. */
    retrySaltOf?(legRoot: Uint8Array, fresh: Uint8Array): Uint8Array;
    signerInvitePayload(address: Uint8Array, scope: Uint8Array, threshold: bigint): Uint8Array;
    /** Present where a signer's removal is built; asked for only then. */
    removeAndSetThresholdPayload?(leaf: Uint8Array, threshold: bigint): Uint8Array;
    setThresholdPayload(threshold: bigint): Uint8Array;
    /** Present where a vault's own approvals needed are changed; asked for only then. */
    setVaultThresholdPayload?(vault: Uint8Array, threshold: bigint): Uint8Array;
    /** Present where a vault's adoption is built; asked for only then. */
    adoptVaultPayload?(vault: Uint8Array): Uint8Array;
    /** Present where a vault's retire is built; asked for only then. */
    retireVaultPayload?(vault: Uint8Array): Uint8Array;
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
    anchorRecoveredOf?(
      batch: Uint8Array,
      approvals: bigint,
      signerRoot: { field: bigint },
      tag: Uint8Array,
      resumesFrom: Uint8Array
    ): Uint8Array;
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
    /** The entry the account records among its `movements` once the payment of one leaf has landed. */
    paidMovementOf?(leaf: Uint8Array): Uint8Array;
    /** The key the account's count of signers removed is held under, among its proposals' holds. */
    removalCountKey?(): Uint8Array;
    /** One seat's approval marker for one proposal in one account, as the account writes it into `approvals`. */
    approvalNullifierOf?(sk: Uint8Array, account: Uint8Array, proposal: Uint8Array): Uint8Array;
    /**
     * One seat's withdraw secret for one proposal in one account, and the key made from it that a proposal's hold
     * carries from its raise: the account lets only the seat whose secret makes that key withdraw a change to the company.
     */
    withdrawSecretOf?(sk: Uint8Array, account: Uint8Array, proposal: Uint8Array): Uint8Array;
    withdrawKeyOf?(secret: Uint8Array): Uint8Array;
    /**
     * The approvals a run needs before a vault pays or charges it: the higher of its bar when raised
     * and the vault's bar now, plus one for every signer removed since it was raised. This is the
     * account's own count; a device does not recompute it.
     */
    runApprovalsNeeded?(
      neededWhenRaised: bigint,
      vaultBar: bigint,
      removalsNow: bigint,
      removalsWhenRaised: bigint
    ): bigint;
  };
  /**
   * `@midnight-ntwrk/compact-runtime`'s signer-tree pieces: a blank tree, a leaf's encoding and a root's reading.
   * Asked for only where who held the account is named in, or read off, a batch's header.
   */
  readonly accountTree?: {
    readonly StateBoundedMerkleTree: new (height: number) => {
      update(index: bigint, leaf: unknown): unknown;
      rehash(): { root(): { value: unknown } | undefined };
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
  /** This device's clock, in milliseconds; a raise past its `raiseBy` by it is refused before it is built. */
  readonly now?: () => number;
}

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
export function recordForOneCall(
  order: GovernedCallOrder,
  material: SignerMaterial,
  opened?: OpenedRound
): AccountPrivateState {
  refuseAWalletsCoinKey(material, opened);
  const signer = signerHalfOf(material);
  if (order.circuit === 'propose') {
    /* What this device opened, when it did; `buildGovernedCall` never builds without it. */
    const h = opened?.half ?? order.half;
    return withNoInvitation({
      ...signer,
      assetId: bytesOf('asset', h.assetId),
      assetBlinding: bytesOf("account's asset blinding", order.half.assetBlinding),
      proposalSalt: bytesOf("proposal's salt", opened?.salt ?? order.half.proposalSalt),
      changeAmount: digitsOf('change amount', h.changeAmount),
      changeBatchDigest: bytesOf('change digest', h.changeBatchDigest),
      pinnedPath: null
    });
  }
  const record = withNoInvitation({ ...signer, pinnedPath: null } as AccountPrivateState);
  const salt =
    order.circuit === 'removeSignerAndSetThreshold' ||
    order.circuit === 'setThreshold' ||
    order.circuit === 'adopt' ||
    order.circuit === 'sealPayKey' ||
    order.circuit === 'setVaultThreshold' ||
    order.circuit === 'setPolicy' ||
    order.circuit === 'setPolicyBar'
      ? bytesOf("proposal's salt", opened?.salt ?? order.proposalSalt)
      : null;
  /* Setting a policy reads the currency and the account's blinding its key is made with, and the policy's opening. */
  const policyFields: Partial<Record<(typeof ACCOUNT_FIELDS)[number], Uint8Array>> =
    order.circuit === 'setPolicy'
      ? {
          assetId: bytesOf('currency', order.asset),
          assetBlinding: bytesOf("account's asset blinding", order.assetBlinding)
        }
      : {};
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
      get: () => {
        throw new NotReadByAnApproval(field);
      }
    });
  }
  return record;
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
  }
): Promise<{ proven: Uint8Array }> {
  const account = String(input.account).toLowerCase();
  if (!HEX64.test(account)) {
    throw new Error('this call is not for a company account this device can name, so nothing was built.');
  }
  const circuit = input.order.circuit;
  if (!ACCOUNT_CIRCUITS_A_DEVICE_GOVERNS.includes(circuit) || CIRCUITS_THAT_READ_NO_WITNESS.has(circuit)) {
    throw new Error(
      `a device here raises, approves and withdraws proposals, seats signers, changes the company's or a vault's threshold, adopts a vault, seals the pay-record key and sets a vault's spending policy and the approvals a policy change needs, and "${String(circuit)}" is none of those. Nothing was built.`
    );
  }
  const parts = argumentsBuilt(deps, input.order);
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
    const view =
      deps.accountLedger === undefined
        ? null
        : (deps.accountLedger(
            (deps.runtimeState.deserialize(input.chain.accountState) as { data: unknown }).data
          ) as AccountLedgerView);
    refuseWhatThisDeviceDidNotMake(
      {
        runPayload: deps.accountPure.runPayload,
        vaultDetails: deps.vaultDetails,
        payKeyCommitmentOf: deps.accountPure.payKeyCommitmentOf,
        ...(deps.accountPure.retrySaltOf === undefined ? {} : { retrySaltOf: deps.accountPure.retrySaltOf }),
        ...(deps.vaultPure === undefined
          ? {}
          : { secretRun: { vault: deps.vaultPure, account: deps.accountPure as unknown as AccountStartPure } })
      },
      input.opened,
      view,
      raisingARun ? 'raise' : 'approve'
    );
  }
  refuseARaiseThatIsNotTheRecordedOne(deps, input.order);
  /* A raise's deadline is the one read from its record; past it by this device's clock, nothing is built. */
  const args = circuit === 'propose' ? [...parts, deadlineOf(input.opened.raiseBy)] : parts;
  if (circuit === 'propose') refuseARaisePastItsTime(deps, input.opened.raiseBy!);
  /*
   * Frozen, so a circuit that tried to write into the record it was handed
   * fails there rather than changing what the next check compares.
   */
  const record = Object.freeze(recordForOneCall(input.order, input.material, input.opened));
  try {
    const { coinPublicKey, encryptionPublicKey } = throwawayKeys(deps);
    const built = await deps.contracts
      .buildCall(
        deps.accountZkConfig,
        {
          compiledContract: deps.accountCompiled,
          circuitId: circuit,
          contractAddress: account,
          coinPublicKey,
          /* A raise and an approval move no coin, so the builder is given no commitment tree to read. */
          network: deps.network,
          read: { contract: input.chain.accountState, zswap: SPENDS_NO_COIN, parameters: input.chain.parameters },
          initialPrivateState: record,
          args
        },
        encryptionPublicKey
      )
      .catch((e: unknown) => {
        throw theWitnessSaid(circuit, e);
      });
    if (built.private.nextPrivateState !== record) throw new RecordChangedByTheCall(circuit);
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
  /** The threshold the invitation sets once the seat is taken, as digits; "0" keeps the one in force. */
  readonly newThreshold: string;
  readonly chain: AccountCallChain;
}

/**
 * **THE INVITEE'S OWN CALL THAT TAKES THE SEAT AN INVITATION BY ADDRESS OFFERED** (`seatInvited`), built and proved
 * where it is called, which is only ever the invitee's own wallet: the coin secret key it proves the address with is
 * a witness to the proof and is in nothing returned. The account refuses it unless the proposal invites the address
 * this key makes, with the rights this seat carries and the threshold it sets, and the proposal is approved at the seat
 * bar; it refuses a threshold above the signers seated once the seat is taken.
 */
export async function buildSeatInvitedCall(
  deps: GovernedCallDeps,
  input: InvitedSeatInput
): Promise<{ proven: Uint8Array }> {
  const account = String(input.account).toLowerCase();
  if (!HEX64.test(account))
    throw new Error('this seat is not taken on a company account this wallet can name, so nothing was built.');
  const record = {
    ...signerHalfOf(input.material),
    invite: {
      coinSecretKey: bytesOf("address's coin key", input.invite.coinSecretKey),
      addressSalt: bytesOf("address's salt", input.invite.addressSalt)
    },
    proposalSalt: bytesOf("proposal's salt", input.proposalSalt),
    pinnedPath: null
  } as unknown as AccountPrivateState;
  try {
    /* The throwaway keys are cleared as they are made, and hold nothing of the wallet's. */
    const keys = throwawayKeys(deps);
    const built = await deps.contracts
      .buildCall(
        deps.accountZkConfig,
        {
          compiledContract: deps.accountCompiled,
          circuitId: 'seatInvited',
          contractAddress: account,
          coinPublicKey: keys.coinPublicKey,
          network: deps.network,
          read: { contract: input.chain.accountState, zswap: SPENDS_NO_COIN, parameters: input.chain.parameters },
          initialPrivateState: record,
          args: [
            bytesOf('proposal', String(input.proposal).toLowerCase()),
            input.intoVacatedSlot,
            invitationThresholdOf(input.newThreshold)
          ]
        },
        keys.encryptionPublicKey
      )
      .catch((e: unknown) => {
        throw theWitnessSaid('seatInvited', e);
      });
    const proven = await deps.prove(built.private.unprovenTx, 'seatInvited');
    return { proven: proven.serialize() };
  } finally {
    wipe(record);
    (record as unknown as { invite: { coinSecretKey: Uint8Array } }).invite.coinSecretKey.fill(0);
  }
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
  }
): {
  openings: Array<{ leaf: string | null; tag: string | null }>;
  own?: { publicKey: string; leaf: string; tag: string };
} {
  const P = anchorPure(deps);
  if (typeof deps.accountPure.signerLeaf !== 'function') {
    throw new AnchorNotBuilt(
      "this device was not given the account's functions for its seats. Reload the page to use the current build"
    );
  }
  const leafOf = deps.accountPure.signerLeaf.bind(deps.accountPure);
  const account = String(input.account).toLowerCase();
  if (!HEX64.test(account)) throw new AnchorNotBuilt('this call is not for a company account this device can name');
  const a = bytesOf('account', account);
  const openings = input.openings.map((o) => {
    try {
      const pk = bytesOf('public key', String(o.publicKey).toLowerCase());
      const blinding = bytesOf('blinding', String(o.blinding).toLowerCase());
      return {
        leaf: hexOf(leafOf(pk, blinding, bytesOf('scope', String(o.scope).toLowerCase()))),
        tag: hexOf(P.anchorTagOf(a, pk, blinding))
      };
    } catch {
      return { leaf: null, tag: null };
    }
  });
  if (input.own === undefined) return { openings };
  if (input.own.scope === undefined)
    throw new AnchorNotBuilt("this seat's material names no scope, so its leaf cannot be opened");
  const pk = P.signerPublicKey(bytesOf('signing secret', String(input.own.signingSecret).toLowerCase()));
  const blinding = bytesOf('blinding', String(input.own.blinding).toLowerCase());
  return {
    openings,
    own: {
      publicKey: hexOf(pk),
      leaf: hexOf(leafOf(pk, blinding, bytesOf('scope', String(input.own.scope).toLowerCase()))),
      tag: hexOf(P.anchorTagOf(a, pk, blinding))
    }
  };
}

/**
 * **THE TAG THIS DEVICE'S SEAT ANCHORS UNDER IN `account`**, made with the
 * account's own `anchorTagOf` over the seat's public key and its leaf's
 * blinding, as the account's call works it out from the seat it proves: what
 * this device's headers name, and what the head they make binds.
 */
export function anchorTagIn(
  deps: Pick<GovernedCallDeps, 'accountPure'>,
  account: string,
  material: Pick<SignerMaterial, 'signingSecret' | 'blinding'>
): string {
  const P = anchorPure(deps);
  const a = String(account).toLowerCase();
  if (!HEX64.test(a)) throw new AnchorNotBuilt('this call is not for a company account this device can name');
  return hexOf(
    P.anchorTagOf(
      bytesOf('account', a),
      P.signerPublicKey(bytesOf('signing secret', String(material.signingSecret).toLowerCase())),
      bytesOf('blinding', String(material.blinding).toLowerCase())
    )
  );
}

/**
 * **WHERE EACH PROPOSAL ASKED ABOUT STANDS, FROM THE ACCOUNT'S HISTORY**: every
 * block's state read once with the account's own ledger reader, oldest first,
 * from the last step of that block - the state after the whole block, which
 * the indexer gives every step of the block alike. Which call raised or closed
 * a proposal is read from each transaction's bytes (`raw`), a transaction read
 * once however many of its calls the history lists (`callsOnTheAccountIn`):
 * only the calls to `account` count. `chainIds` are the proposals' identities
 * on chain, as 64 hex digits. With `seat`, each also says whether that seat's
 * approval marker is in the latest state, and, while held, whether that seat
 * raised it, both computed with the account's own derivations over
 * `seat.account`. Refused when a transaction's bytes cannot be read, or a step
 * carries them and no `account` was given.
 */
export function roundsOnChainIn(
  deps: Pick<GovernedCallDeps, 'accountPure' | 'accountLedger' | 'runtimeState'> &
    Partial<Pick<GovernedCallDeps, 'ledger'>>,
  steps: ReadonlyArray<{
    readonly kind: string;
    readonly transaction: string;
    readonly state: Uint8Array;
    readonly entryPoint?: string;
    readonly block: { readonly height: number; readonly at: number };
    readonly succeeded: boolean;
    readonly raw?: Uint8Array;
  }>,
  chainIds: readonly string[],
  seat?: { readonly account: string; readonly signingSecret: string },
  account?: string
): ReadonlyMap<string, RoundOnChain> {
  const cleared = deps.accountPure.clearedMark;
  if (deps.accountLedger === undefined || typeof cleared !== 'function') {
    throw new Error(
      "this device was not given the account's reader, so where its proposals stand on the chain was not read. Reload the page"
    );
  }
  const markerOf = seat === undefined ? undefined : approvalMarkerOf(deps, seat);
  const withdrawKeyHere = seat === undefined ? undefined : withdrawKeyMadeBy(deps, seat);
  type View = {
    approvals: { member(marker: Uint8Array): boolean };
    openProposals: { member(id: Uint8Array): boolean; lookup(id: Uint8Array): Uint8Array };
    approvalCounts: { member(id: Uint8Array): boolean; lookup(id: Uint8Array): bigint };
    proposalHolds?: {
      member(id: Uint8Array): boolean;
      lookup(id: Uint8Array): {
        readonly removals: bigint;
        readonly needed?: bigint;
        readonly withdrawKey?: Uint8Array;
      };
    };
    runWindow?: { member(id: Uint8Array): boolean; lookup(id: Uint8Array): { readonly opensAt: bigint } };
  };
  /* The account's own count of signers removed, where this device was given where it keeps it. */
  const removalKey = deps.accountPure.removalCountKey?.();
  const removalsIn = (v: View, id: Uint8Array): bigint | null =>
    v.proposalHolds !== undefined && v.proposalHolds.member(id) ? BigInt(v.proposalHolds.lookup(id).removals) : null;
  const viewOf = (state: Uint8Array) =>
    deps.accountLedger!((deps.runtimeState.deserialize(state) as { data: unknown }).data) as View;
  /*
   * One state per block: the indexer gives every step of a block the state after the whole block, so a block is read
   * once, from its last step, and a state never says which of a block's calls moved a proposal. The calls' own
   * operations, in their transactions' bytes, do.
   */
  const blocks: Array<{ readonly at: number; readonly steps: (typeof steps)[number][] }> = [];
  for (const step of steps) {
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.steps[0]!.block.height === step.block.height) last.steps.push(step);
    else blocks.push({ at: step.block.at, steps: [step] });
  }
  const views = blocks.map((b) => viewOf(b.steps[b.steps.length - 1]!.state));
  const callsIn = (b: (typeof blocks)[number]) => b.steps.filter((x) => x.kind === 'call');
  type Call = {
    readonly entryPoint: string;
    readonly transaction: string;
    readonly opened?: ReadonlySet<string>;
    readonly closed?: ReadonlySet<string>;
  };
  /* The calls of a block's transactions that succeeded in full: each transaction read once, its calls to the account alone. */
  const succeededIn = (b: (typeof blocks)[number]): Call[] => {
    const read = new Set<string>();
    return callsIn(b)
      .filter((x) => x.succeeded)
      .flatMap((x): Call[] => {
        if (x.raw === undefined) return [{ entryPoint: x.entryPoint ?? '', transaction: x.transaction }];
        if (read.has(x.transaction)) return [];
        read.add(x.transaction);
        if (account === undefined)
          throw new Error(
            'which call raised or closed a proposal was not read: this device was not told whose calls to read. Reload the page'
          );
        return callsOnTheAccountIn(deps, x.raw, account).map((c) => ({ ...c, transaction: x.transaction }));
      });
  };
  const bySucceeded = new Map<(typeof blocks)[number], Call[]>();
  const succeeded = (b: (typeof blocks)[number]): Call[] => {
    const known = bySucceeded.get(b);
    if (known !== undefined) return known;
    const calls = succeededIn(b);
    bySucceeded.set(b, calls);
    return calls;
  };
  const latest = views[views.length - 1];
  const out = new Map<string, RoundOnChain>();
  for (const asked of chainIds) {
    const hex = String(asked).toLowerCase();
    if (!HEX64.test(hex)) throw new Error('a proposal was asked about by an identity that is not thirty-two bytes');
    const id = bytesOf('proposal', hex);
    const mine =
      markerOf === undefined ? {} : { approvedHere: latest !== undefined && latest.approvals.member(markerOf(id)) };
    let first = -1;
    let gone = -1;
    /* The latest time it was held: an identity proposed again after it closed is read from that second time on. */
    views.forEach((v, i) => {
      const held = v.openProposals.member(id);
      if (held && (first < 0 || gone >= 0)) {
        first = i;
        gone = -1;
      }
      if (!held && first >= 0 && gone < 0) gone = i;
    });
    if (first < 0) {
      out.set(hex, { held: 'never', approvals: 0, ...mine });
      continue;
    }
    const raised = blocks[first]!;
    const raisedBy = succeeded(raised);
    const opener = raisedBy.find((c) => c.opened?.has(hex));
    const proposes = raisedBy.filter((c) => c.opened === undefined && c.entryPoint === 'propose');
    const txRef = opener?.transaction ?? (proposes.length === 1 ? proposes[0]!.transaction : undefined);
    const base = { raisedAt: raised.at, ...(txRef === undefined ? {} : { txRef }) };
    /* Held: the latest state. Closed: the last state that held it, the one before the block that closed it. */
    const now = views[gone >= 0 ? gone - 1 : views.length - 1]!;
    const approvals = now.approvalCounts.member(id) ? Number(now.approvalCounts.lookup(id)) : 0;
    const bar =
      now.proposalHolds !== undefined && now.proposalHolds.member(id) ? now.proposalHolds.lookup(id).needed : undefined;
    const needed = bar === undefined || bar === null ? undefined : Number(bar);
    const neededRead = needed === undefined || !Number.isSafeInteger(needed) ? {} : { needed };
    if (gone >= 0) {
      const closing = succeeded(blocks[gone]!);
      const closers = closing.filter((c) => c.closed?.has(hex));
      const named = closers.length > 0 ? closers : closing.filter((c) => c.closed === undefined);
      /* Every call of that block read from its bytes and none took it out: the history and its transactions disagree. */
      if (named.length === 0 && callsIn(blocks[gone]!).every((x) => x.raw !== undefined)) {
        throw new Error(
          "where a proposal stands was not read: the account's history shows it closed in a block where no call read " +
            "from that block's transactions closed it, so how it closed is not known. Read again; if it happens again, the indexer " +
            'your wallet names is serving a history its transactions do not explain'
        );
      }
      out.set(hex, {
        held: 'closed',
        approvals,
        ...neededRead,
        ...base,
        closedBy: [...new Set(named.map((c) => c.entryPoint))],
        ...mine
      });
      continue;
    }
    const failedCalls = blocks
      .slice(first)
      .flatMap(callsIn)
      .filter((x) => !x.succeeded)
      .map((x) => x.entryPoint ?? '');
    const atRaise = removalKey === undefined ? null : removalsIn(now, id);
    const removalsNow = removalKey === undefined ? null : (removalsIn(now, removalKey) ?? 0n);
    const outrun = atRaise !== null && removalsNow !== null && atRaise !== removalsNow;
    const since = outrun && removalsNow! > atRaise! ? Number(removalsNow! - atRaise!) : 0;
    const window =
      now.runWindow !== undefined && now.runWindow.member(id) ? Number(now.runWindow.lookup(id).opensAt) : undefined;
    const heldKey =
      now.proposalHolds !== undefined && now.proposalHolds.member(id)
        ? now.proposalHolds.lookup(id).withdrawKey
        : undefined;
    /* A hold read with no withdraw key says nothing of who raised it: absent, never read as another seat's. */
    const raisedHere =
      withdrawKeyHere === undefined || !(heldKey instanceof Uint8Array)
        ? {}
        : { raisedHere: hexOf(heldKey) === hexOf(withdrawKeyHere(id)) };
    out.set(hex, {
      held: hexOf(now.openProposals.lookup(id)) === hexOf(cleared()) ? 'cleared' : 'open',
      approvals,
      ...base,
      ...(failedCalls.length === 0 ? {} : { failedCalls }),
      ...neededRead,
      ...(window === undefined || !Number.isSafeInteger(window) ? {} : { opensAt: window }),
      ...(outrun ? { outrun: true as const } : {}),
      ...(since > 0 && Number.isSafeInteger(since) ? { removals: since } : {}),
      ...mine,
      ...raisedHere
    });
  }
  return out;
}

/**
 * **ONE SEAT'S APPROVAL MARKER IN ONE ACCOUNT**, made with the account's own derivation (`approvalNullifierOf`), the
 * value the account writes into `approvals` when that seat approves a proposal or raises it counted. Only the holder of
 * the signing secret can make it. Refused, saying what resolves it, when this build of the account has no derivation.
 */
export function approvalMarkerOf(
  deps: Pick<GovernedCallDeps, 'accountPure'>,
  seat: { readonly account: string; readonly signingSecret: string }
): (proposal: Uint8Array) => Uint8Array {
  const derive = deps.accountPure.approvalNullifierOf;
  if (typeof derive !== 'function') {
    throw new Error(
      "this device was not given the account's function for an approval, so whether your approval is already counted was not read. Reload the page"
    );
  }
  const account = String(seat.account).toLowerCase();
  if (!HEX64.test(account))
    throw new Error('whether your approval is already counted was asked about an account this device cannot name');
  const a = bytesOf('account', account);
  const sk = bytesOf('signing secret', String(seat.signingSecret).toLowerCase());
  return (proposal) => derive.call(deps.accountPure, sk, a, proposal);
}

/**
 * **THE WITHDRAW KEY ONE SEAT MAKES FOR A PROPOSAL IN ONE ACCOUNT**, with the account's own derivations
 * (`withdrawSecretOf`, then `withdrawKeyOf`): the key the account writes into a proposal's hold when that seat raises
 * it. Only the holder of the signing secret can make it. Undefined where this device was not given the derivations, so
 * whether the seat raised a proposal is then not said, never guessed.
 */
function withdrawKeyMadeBy(
  deps: Pick<GovernedCallDeps, 'accountPure'>,
  seat: { readonly account: string; readonly signingSecret: string }
): ((proposal: Uint8Array) => Uint8Array) | undefined {
  const { withdrawSecretOf, withdrawKeyOf } = deps.accountPure;
  if (typeof withdrawSecretOf !== 'function' || typeof withdrawKeyOf !== 'function') return undefined;
  const account = String(seat.account).toLowerCase();
  if (!HEX64.test(account)) throw new Error('who raised a proposal was asked about an account this device cannot name');
  const a = bytesOf('account', account);
  const sk = bytesOf('signing secret', String(seat.signingSecret).toLowerCase());
  return (proposal) => withdrawKeyOf.call(deps.accountPure, withdrawSecretOf.call(deps.accountPure, sk, a, proposal));
}

/**
 * **WHERE THE ANCHOR CALL LANDS IN ITS TRANSACTION.** A call in the guaranteed
 * section that reads a head another device has since moved fails the whole
 * transaction, so nothing is applied and no fee is paid; in the fallible
 * section the transaction would land, its fee paid, with the anchor not
 * written. So it is read off the transaction, never assumed.
 */
export function anchorPlacementOf(
  unproven: unknown,
  circuit: 'anchor' | 'recoverAnchor' = 'anchor'
): 'guaranteed' | 'fallible' | 'unread' {
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
  recoverAnchor: ['guaranteed', 'fallible']
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
    readonly account: string;
    readonly material: SignerMaterial;
    readonly chain: AccountCallChain;
    readonly previous: string;
    readonly batch: string;
    /** Who held the account as this device judged the batch, as its header names them; the call is refused unless they still do. */
    readonly held: Pick<BatchHolders, 'approvals' | 'signerRoot'>;
  }
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
    readonly account: string;
    readonly material: SignerMaterial;
    readonly chain: AccountCallChain;
    readonly previous: string;
    readonly batch: string;
    readonly held: Pick<BatchHolders, 'approvals' | 'signerRoot'>;
    readonly resumesFrom: string;
    readonly latest: string;
    readonly lastRecovery: string;
    readonly proposal: string;
    readonly proposalSalt: string;
  }
): Promise<{ proven: Uint8Array; placement: AnchorPlacement }> {
  const resumesFrom = bytesOf('head it resumes from', String(input.resumesFrom).toLowerCase());
  const latest = digitsOf("recovery's last time", input.latest);
  const lastRecovery = bytesOf("latest recovery's head", String(input.lastRecovery).toLowerCase());
  const proposal = bytesOf('proposal', String(input.proposal).toLowerCase());
  const salt = bytesOf("proposal's salt", String(input.proposalSalt).toLowerCase());
  let made: Uint8Array;
  try {
    made = deps.accountPure.proposalIdOf(
      governancePayloadOf(deps, {
        kind: 'recover-anchor',
        resumesFrom: String(input.resumesFrom).toLowerCase(),
        latest: String(input.latest),
        lastRecovery: String(input.lastRecovery).toLowerCase()
      }),
      deps.accountPure.noVault(),
      salt
    );
  } catch (e) {
    throw new AnchorNotBuilt((e as Error)?.message?.replace(/\.$/u, '') ?? String(e), { cause: e, recovery: true });
  }
  if (hexOf(made) !== hexOf(proposal)) {
    throw new AnchorNotBuilt(
      'the recovery this device was asked to carry out is not the proposal the signers approved: the head it ' +
        'resumes from, its last time, the latest recovery and its salt make another identity. Reload the page and carry it out again ' +
        "from the proposal's own file",
      { recovery: true }
    );
  }
  return buildAnAnchorCall(deps, input, 'recoverAnchor', [resumesFrom, latest, lastRecovery, proposal], {
    proposalSalt: salt
  });
}

/** An anchor call or a recovery, as the two builders above take them: the anchor's arguments first, then `more`. */
async function buildAnAnchorCall(
  deps: GovernedCallDeps,
  input: {
    readonly account: string;
    readonly material: SignerMaterial;
    readonly chain: AccountCallChain;
    readonly previous: string;
    readonly batch: string;
    readonly held: Pick<BatchHolders, 'approvals' | 'signerRoot'>;
  },
  circuit: 'anchor' | 'recoverAnchor',
  more: readonly (Uint8Array | bigint)[],
  answers: { readonly proposalSalt?: Uint8Array }
): Promise<{ proven: Uint8Array; placement: AnchorPlacement }> {
  const recovery = circuit === 'recoverAnchor';
  const account = String(input.account).toLowerCase();
  if (!HEX64.test(account))
    throw new AnchorNotBuilt('this call is not for a company account this device can name', { recovery });
  anchorPure(deps);
  const previous = bytesOf('head', String(input.previous).toLowerCase());
  const batch = bytesOf('batch', String(input.batch).toLowerCase());
  if (!Number.isSafeInteger(input.held?.approvals) || input.held.approvals < 1) {
    throw new AnchorNotBuilt('the batch does not name the approvals the account required as it was judged', {
      recovery
    });
  }
  const approvals = BigInt(input.held.approvals);
  const signerRoot = rootOfHex(input.held.signerRoot);
  const record = { ...signerHalfOf(input.material), pinnedPath: null, ...answers } as AccountPrivateState;
  for (const field of ACCOUNT_FIELDS) {
    if (field in answers) continue;
    Object.defineProperty(record, field, {
      enumerable: false,
      get: () => {
        throw new AnchorNotBuilt(
          `the ${circuit === 'anchor' ? 'anchor' : 'recovery'} call read "${field}" from this device, and it has never needed it. The company's contract is not the one this page was built for; reload the page`,
          { recovery }
        );
      }
    });
  }
  Object.freeze(record);
  try {
    const { coinPublicKey, encryptionPublicKey } = throwawayKeys(deps);
    let built: Awaited<ReturnType<GovernedCallDeps['contracts']['buildCall']>>;
    try {
      built = await deps.contracts.buildCall(
        deps.accountZkConfig,
        {
          compiledContract: deps.accountCompiled,
          circuitId: circuit,
          contractAddress: account,
          coinPublicKey,
          /* An anchor moves no coin. */
          network: deps.network,
          read: { contract: input.chain.accountState, zswap: SPENDS_NO_COIN, parameters: input.chain.parameters },
          initialPrivateState: record,
          args: [previous, batch, approvals, signerRoot, ...more]
        },
        encryptionPublicKey
      );
    } catch (e) {
      if (e instanceof AnchorNotBuilt) throw e;
      const said = theWitnessSaid(circuit, e);
      throw new AnchorNotBuilt((said as Error)?.message ?? String(said), { cause: e, recovery });
    }
    if (built.private.nextPrivateState !== record) throw new RecordChangedByTheCall(circuit);
    const placement = anchorPlacementOf(built.private.transaction, circuit);
    if (placement === 'unread') {
      throw new AnchorNotBuilt(
        'the transaction built is not one anchor call this device can read. Reload the page to use the current build',
        { recovery }
      );
    }
    if (!ANCHOR_CALL_MAY_LAND_IN[circuit].includes(placement)) {
      throw new AnchorNotBuilt(
        'the call would land where, if another device anchored first, its fee would be paid and nothing written. Reload the ' +
          'page and anchor again',
        { recovery }
      );
    }
    const proven = await deps.prove(built.private.unprovenTx, circuit);
    return { proven: proven.serialize(), placement };
  } finally {
    wipe(record);
  }
}
