/**
 * **THE PAGE'S SIDE OF THE VAULT WORKER.** One request, one answer, matched by
 * id. The page never loads what the worker loads; it only sends what to build
 * and receives proven bytes back. Every ask answers or fails with a reason
 * (`VaultAskFailed`) inside the proof time limit, a worker that stops is
 * replaced on the next ask, and the page can read how long each proof in
 * progress has run (`proofsInProgress`).
 */
import type { Committee } from '../../../src/midnight/vault-committee.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import type { PrivatePaymentOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import type { PaymentsFitAnswer } from '../../../src/midnight/vault-notes.js';
import type { EventOnTheWire, NoteOnTheWire, PaymentConfirmation, TransactionRead } from './vault-builder.js';
import type { SecretRunOnTheWire } from './vault-secret-built.js';
import type { OwnChainCopy } from '../../../src/midnight/sealed-secret-copy.js';
import type { VaultCallOnChain } from '../../../src/midnight/note-index.js';
import type { StartStandingOnTheWire } from './vault-worker-start.js';
import type { StepOnTheWire, VaultRebuildAsked, VaultRebuilt } from './vault-rebuild-wire.js';
import { superAdminWorkerOver, type SuperAdminWorker } from './super-admin-asks.js';
import type { ForgetUnshieldedAsk, RetireAsk } from './vault-retire-built.js';
import { PROOF_CEILING_MS } from './proof-ceiling.js';
import { FAILED_BECAUSE, VaultAskFailed, type VaultAskFailure } from './vault-ask-failed.js';
import { ReadRanOutOfTime, SERVICE_READ_BOUND_MS } from './read-bound.js';

import type {
  AnchorPlacement, AnchorsOnChain, GovernedCallOrder, HeadStepAsked, OpenedRound, ProposalIdentity, RoundChangeOnTheWire, RoundOnChain, SignerMaterial, SpendingPolicyKeys, VouchedRunOnTheWire,
} from './governed-call-builder.js';
import type { PolicyOpeningOnTheWire } from '../../../src/midnight/spending-policy-record.js';
import type { BatchHolders } from '../../../src/midnight/record-manifest.js';
import type { AddressClaimFor, UnshieldedAddressClaim } from 'midnight-identity/profile/address-claim';
import type { PeriodTotalAskOnTheWire, RunChargeStanding, RunToChargeOnTheWire, RunTreeOnTheWire } from './run-charge-builder.js';

export type * from './vault-worker-wire.js';
import type {
  AccountCallChainOnTheWire, AccountPresenceOnTheWire, CoinOnTheWire, CreatingTransactionAnswer, InvitedSeatOnTheWire, OneOffOnTheWire, OrderOnTheWire, PayoutChainOnTheWire, SeatOpeningsAnswer, SigningKeyOnTheWire, VaultAnswer, VaultAsk, VaultOnChainOnTheWire, VaultRequest,
} from './vault-worker-wire.js';
export { VaultAskFailed };

/** What the page needs from wherever vault transactions are built. */
export interface VaultBuilderClient {
  /**
   * The proofs the worker is working out now, each with how long it has run,
   * read off the worker's own word as each starts and ends. Every client this
   * file makes has it.
   */
  readonly proofsInProgress: () => readonly ProofInProgress[];
  deploy(account: string): Promise<{ vault: string; temporaryKey: SigningKeyOnTheWire; tx: string }>;
  /**
   * The company's account, deployed held by the founding signer's committee key
   * from its first transaction, proved; and the keys of this build the second
   * step inserts, each checked against the compiled account's own digest, as
   * base64 of their files, for the founding signer's wallet to check again.
   */
  accountDeploy?(input: { foundingLeaf: string; label: string; foundingKey: SigningKeyOnTheWire; clockOffsetMs?: number }): Promise<{
    account: string; tx: string; insert: ReadonlyArray<{ circuit: string; key: string }>;
  }>;
  /** The second step of the account's creation, with the founding signer's wallet's signature on it, proved. */
  finishedCreation?(input: { account: string; signature: SigningKeyOnTheWire; clockOffsetMs?: number }): Promise<{ tx: string }>;
  /** A vault deployed held by the company's committee at its threshold from its first transaction, proved. */
  bornHeldVault?(input: { account: string; holders: Committee }): Promise<{ vault: string; tx: string }>;
  /**
   * The vault as its deploy made it, read in the worker from the deploy the
   * chain holds for its address, at the indexer the person's own wallet names:
   * null when it was born held by `holders`, pinned to `account`, with this
   * build's circuits and nothing written; otherwise the sentence that says what
   * it is instead. With `again`, a vault the company retired and adopts again,
   * who holds it and its circuits are read off its state today instead.
   */
  vaultAsDeployed?(input: { vault: string; account: string; holders: Committee; again?: boolean; indexer: { indexerUri: string; indexerWsUri: string } }): Promise<{ refusal: string | null }>;
  handover(input: { vault: string; counter: bigint; temporaryKey: SigningKeyOnTheWire; to: Committee }): Promise<{ tx: string }>;
  /** `state` and `parameters` are base64 of the vault's state and of the ledger parameters the chain holds now. */
  deposit(input: { vault: string; coin: CoinOnTheWire; state: string; parameters: string }): Promise<{ tx: string }>;
  /**
   * The vault's public deposit of one public token and one amount, built and
   * proved: no coin, no nonce, no note. `amount` is decimal digits.
   */
  publicDeposit?(input: { vault: string; token: string; amount: string; state: string; parameters: string }): Promise<{ tx: string }>;
  commitments(input: { vault: string; coin: CoinOnTheWire }): Promise<{ output: string; held: string }>;
  /**
   * The one coin a step written in the vault's payment journal kept, if it
   * landed, worked out with the vault's own functions under `secret`: a merge's
   * coin, or a payment's change; `null` when it kept none.
   */
  stepKept(input: { vault: string; secret: string; step: StepOnTheWire }): Promise<NoteOnTheWire | null>;
  /**
   * **THE VAULT'S NOTES, REBUILT**: every note the chain holds that the records handed in, the walk over the company's
   * own amounts (when `walk` is given) and the chain's split journal name, each with both its commitments; the chain
   * notes nothing names; and, with `copyFor`, this signer's sealed copy of the vault's secret read off `state`.
   */
  vaultRebuilt?(input: VaultRebuildAsked): Promise<VaultRebuilt>;
  /**
   * The vault as the chain holds it, read in this worker from the indexer the
   * person's own wallet names (`indexer`), and from nowhere else; with
   * `account`, whether that account's circuits are this app's too.
   */
  vaultOnChain(input: { vault: string; account?: string; indexer: { indexerUri: string; indexerWsUri: string } }): Promise<VaultOnChainOnTheWire>;
  /**
   * Every vault named, read as `vaultOnChain` reads one, their states and the account's in one request to the indexer
   * for each 256; each answer in the order asked. An answer that leaves a vault out, or names another, is refused.
   */
  vaultsOnChain(input: { vaults: readonly string[]; account?: string; indexer: { indexerUri: string; indexerWsUri: string } }): Promise<VaultOnChainOnTheWire[]>;
  /**
   * **WHAT A STEP OUT OF THE VAULT IS BUILT ON**, read in this worker at the
   * indexer the person's own wallet names: one block, named first, and as of it
   * the vault's state, the commitment tree, the ledger's parameters and the
   * state of `account`. Null while that block holds either contract not yet.
   */
  chainAtOneBlock(input: { vault: string; account: string; indexer: { indexerUri: string; indexerWsUri: string } }): Promise<PayoutChainOnTheWire | null>;
  /** Every zswap event the chain holds for one transaction, read in this worker at the indexer the wallet names. */
  eventsOf(input: { transactionHash: string; indexer: { indexerUri: string; indexerWsUri: string } }): Promise<EventOnTheWire[]>;
  /**
   * Which of the vault's own transactions created the output with this
   * commitment, and its events, read in this worker at the indexer the wallet
   * names; null while no transaction the chain lists for the vault does.
   */
  createdBy(input: { vault: string; commitment: string; indexer: { indexerUri: string; indexerWsUri: string } }): Promise<{ transactionHash: string; events: EventOnTheWire[] } | null>;
  /**
   * **WHETHER ONE CALL TO `vault` IN A TRANSACTION THIS DEVICE HOLDS TOOK EFFECT ON THE CHAIN**, read in this worker at
   * the indexer the wallet names: `transaction` (base64, finished or not yet bound) is looked for by its own
   * identifiers, and judged by the part of it that carries the call to one of `entryPoints` (`vaultCallOnChain`). A hash
   * the service answered with is never asked for: it is the service's word. Refuses bytes it cannot read, or that name
   * no identifier.
   */
  vaultCallOnChain?(input: {
    vault: string; entryPoints: string[]; transaction: string; indexer: { indexerUri: string; indexerWsUri: string };
  }): Promise<VaultCallOnChain>;
  /** What a transaction (base64, finished or not yet bound) says of itself: its identifiers, its earliest time to live, its calls, the private coins it creates for contracts and the public tokens its calls take in (`readTransaction`). Null for bytes that are no transaction. */
  readTransaction?(input: { transaction: string }): Promise<TransactionRead | null>;
  /**
   * **A CHANGE OF THE SUPER ADMINS' READS AND LEDGER**, each asked of this worker: who holds each contract and which
   * vaults the account lists, at the indexer the wallet names, and an update's bytes and each signature's check.
   */
  readonly superAdmins?: SuperAdminWorker;
  /**
   * The seat this signer's own key material makes on the company's account: the
   * leaf the account holds for them, worked out here and not taken from any record.
   */
  ownSeat(material: SignerMaterial): Promise<string>;
  /** A company's deploy and its signed second step carried again in fresh transactions, as base64. */
  creationAgain?(input: { deploy: string; insert: string; clockOffsetMs?: number }): Promise<{ account: string; deploy: string; insert: string }>;
  /**
   * Whether `secret` is the one the vault's commitment names in `state` (base64
   * of the vault's state): its commitment, worked out with the vault's own
   * function, against the one the state holds.
   */
  secretIsTheVaults(input: { vault: string; state: string; secret: string }): Promise<boolean>;
  /**
   * This reader's sealed copy of the vault's secret, read off `state` (base64 of the vault's state) under the
   * commitment `of` names: the one the vault holds now, or the one whose copies were last all written. Sealed: only
   * the reader's own key opens it, on the page.
   */
  ownChainCopy?(input: { vault: string; state: string; reader: string; of: 'commitment' | 'copies-written' }): Promise<OwnChainCopy>;
  /**
   * The account's removal count before the block that set the vault's secret `commitment`, lowered to the count the run
   * that set it was raised at (`removalsWhenTheSecretWasSet`). Read in this worker from the history of the vault and
   * `account` at the indexer the person's own wallet names, and from nowhere else.
   */
  secretSetAt?(input: { vault: string; account: string; commitment: string; indexer: { indexerUri: string; indexerWsUri: string } }): Promise<number>;
  /**
   * The notes a payment spends, by the one choice every payment makes: in place
   * order, the first the one the vault is offered and the rest the further notes
   * the payment takes. Refuses with what the pool holds.
   */
  notesForPayment(input: { notes: readonly NoteOnTheWire[]; token: string; amount: string }): Promise<NoteOnTheWire[]>;
  /**
   * Whether the notes can make every payment in turn: `fits`, or `does-not-fit`
   * naming the first they cannot. Refuses only when it could not ask.
   */
  paymentsFit(input: { notes: readonly NoteOnTheWire[]; payments: ReadonlyArray<{ token: string; amount: string }> }): Promise<PaymentsFitAnswer>;
  /** The pool after a payment landed: `spent` and every `further` note gone, the change added. */
  afterPayment(input: {
    notes: readonly NoteOnTheWire[]; spent: string; further?: readonly string[]; amount: string;
    change: NoteOnTheWire | null; createdIn: string | null;
  }): Promise<NoteOnTheWire[]>;
  /** What this payment's own events say about it; with `merge`, what a merge's own events say about it. */
  confirmPayment(input: {
    vault: string; transactionHash: string; change: NoteOnTheWire | null; events: readonly EventOnTheWire[]; merge?: true;
  }): Promise<PaymentConfirmation>;
  /** Which transaction created the note with this commitment, as these events of the named transaction say. */
  creatingTransaction(input: {
    vault: string; commitment: string; transactionHash: string; events: readonly EventOnTheWire[];
  }): Promise<CreatingTransactionAnswer>;
  payout(input: {
    vault: string; account: string; order: OrderOnTheWire; payment: PrivatePaymentOnTheWire;
    note: NoteOnTheWire; events: readonly EventOnTheWire[];
    /** The further notes the payment draws on, in place order, each with the events of the transaction that created it. */
    further?: ReadonlyArray<{ readonly note: NoteOnTheWire; readonly events: readonly EventOnTheWire[] }>;
    chain: PayoutChainOnTheWire;
    /** The vault's current nonce secret, opened on this device. */
    secret: string;
  }): Promise<{ tx: string; spent: string; change: NoteOnTheWire | null }>;
  /**
   * A merge of two to four of the vault's own notes into one, built and
   * proved: the notes in place order, each with the events of the transaction
   * that created it. Answers the notes spent and the one coin the vault keeps.
   */
  mergeNotes(input: {
    vault: string; notes: ReadonlyArray<{ readonly note: NoteOnTheWire; readonly events: readonly EventOnTheWire[] }>;
    chain: PayoutChainOnTheWire;
    /** The vault's current nonce secret, opened on this device. */
    secret: string;
  }): Promise<{ tx: string; spent: string[]; kept: NoteOnTheWire }>;
  /** A public payment out of the vault, built and proved: no note, no change. */
  payoutPublicly(input: {
    vault: string; account: string; order: OrderOnTheWire; payment: PrivatePaymentOnTheWire; chain: PayoutChainOnTheWire;
  }): Promise<{ tx: string }>;
  /**
   * **A GOVERNANCE PROPOSAL'S IDENTITY, MADE HERE WITH THE CONTRACT'S OWN
   * FUNCTIONS**: the payload the change commits to, and its identity on the
   * chain under the salt given and no vault. A vault's adoption and the
   * pay-record key are named here as every other change is.
   */
  proposalIdentity(change: RoundChangeOnTheWire, salt: string): Promise<ProposalIdentity>;
  /**
   * **THE IDENTITY ON CHAIN A LEG'S RUN WOULD HAVE, RAISED OVER THE HEAD IT
   * SEALS**, made here with the contract's own functions (`vouchedRunIdentityOf`);
   * null for a run of no vault.
   */
  vouchedRunIdentity(run: VouchedRunOnTheWire): Promise<string | null>;
  /** The value a company-wide run names in place of a vault, made with the account's own function. */
  companyWide(): Promise<string>;
  /**
   * Where the chain keeps a vault's spending policy for a currency, its marker
   * and the approvals a policy change needs, and with `policy` the commitment it
   * makes, and with `policy` and a run's `total` the approvals its band needs,
   * each made with the account's own functions.
   */
  spendingPolicyKeys(input: {
    vault: string; asset: string; assetBlinding: string; policy?: PolicyOpeningOnTheWire; total?: string;
  }): Promise<SpendingPolicyKeys>;
  /** The key the account keeps the approvals any change to a spending policy needs under, made with the account's own function. */
  policyBarKey(): Promise<string>;
  /**
   * Why a wallet's claim of an unshielded address does not prove it for this company, record and payslip key, or null
   * when it does, checked with the ledger in the worker (`signedClaimRefusal`). Absent from a builder that cannot check
   * one, and a read that needs it then fails rather than skip the check.
   */
  addressClaimRefusal?(claim: UnshieldedAddressClaim, f: AddressClaimFor): Promise<string | null>;
  /**
   * A one-off payment's record opened in the worker with the company's key at its epoch (`openOneOff`), refused as the
   * opening refuses it. Absent from a builder that cannot open one, and a read that needs it then reads none.
   */
  openOneOff?(rec: SealedCompanyRecord, key: string): Promise<OneOffOnTheWire>;
  /** A raise or an approval on the company account, built and proved with this signer's own material. */
  governedCall(input: {
    account: string; order: GovernedCallOrder; material: SignerMaterial; chain: AccountCallChainOnTheWire;
    /** What this device opened from the company's sealed records, which the call is checked against and proved with. */
    opened: OpenedRound;
  }): Promise<{ tx: string }>;
  /**
   * **AN APPROVED RUN CHARGED TO ITS VAULT'S PERIOD**, built and proved here
   * against the account's state at one block (base64), with the period's
   * running total worked out again from that state and `runs`, the company's
   * runs that may have been charged to it. `tx` is null when the chain already
   * holds the run as charged; `spent` is the period's total before this charge.
   */
  clearRun(input: {
    account: string; run: RunToChargeOnTheWire; runs: readonly RunTreeOnTheWire[]; chain: { accountState: string; parameters: string };
  }): Promise<{ tx: string | null; spent: string | null }>;
  /**
   * **WHAT A VAULT HAS BEEN CHARGED IN ONE PERIOD**, worked out again from the
   * account's state at one block (base64) and the company's runs, and taken only
   * when it opens the commitment the chain holds. Decimal digits.
   */
  periodTotal(input: { accountState: string; total: PeriodTotalAskOnTheWire }): Promise<string>;
  /**
   * **WHETHER THE CHAIN HOLDS A RUN AS CHARGED**, read off the account's state
   * at one block (base64): its proposal open and charged, open and not yet
   * charged, or not open.
   */
  runCharged(input: { accountState: string; proposal: string }): Promise<RunChargeStanding>;
  /**
   * The head the latest recovery carried out wrote (hex), thirty-two zero bytes before any, read off the account's
   * state (base64) by the account's own reader and key. Reads no chain: the caller reads the state at the indexer the
   * person's own wallet names.
   */
  lastRecovery(input: { accountState: string }): Promise<string>;
  /**
   * The head after each batch asked about, each made with the account's own `anchorHeadOf` over `anchorHeldOf` of the
   * batch and the holders its header names, and the seats those holders' leaves name when they make the root they name
   * (null when they do not); and the same seats for each of `holders`, as a directory version's leaf names them. Hex.
   * Reads no chain.
   */
  anchorHeads(input: {
    after: readonly HeadStepAsked[]; holders?: readonly BatchHolders[];
  }): Promise<{ after: string[]; seats: (string[] | null)[]; holderSeats: (string[] | null)[] }>;
  /**
   * The tag this signer's seat anchors under in `account` (hex), made with the account's own `anchorTagOf` over the
   * seat's public key and blinding, as the account's call works it out: what this device's headers name. Reads no chain.
   */
  anchorTag(input: { account: string; material: SignerMaterial }): Promise<string>;
  /**
   * What each seat's opening opens - the leaf its public key, blinding and scope make, null for one that is not one - and
   * the tag that seat anchors under in `account`; with `own`, this signer's own opening, leaf and tag. Hex. Reads no chain.
   */
  seatOpenings(input: {
    account: string; openings: ReadonlyArray<{ publicKey: string; scope: string; blinding: string }>; own?: SignerMaterial;
  }): Promise<SeatOpeningsAnswer>;
  /**
   * **EVERY HEAD THE ACCOUNT'S HISTORY SHOWS, OLDEST FIRST, AND WHO HOLDS THE
   * ACCOUNT IN ITS LATEST STATE**, read in this worker from the account's
   * history at the indexer the person's own wallet names (`indexer`), and from
   * nowhere else: the head the last anchor call of each block left, the
   * committee after that block, and the block; the last is the head the account
   * holds. `now` is who holds it in the history's latest state, as a batch's
   * header names them, and `seatsNow` the seats it names.
   */
  anchorsOnChain(input: { account: string; indexer: { indexerUri: string; indexerWsUri: string } }): Promise<AnchorsOnChain>;
  /**
   * **WHERE EACH PROPOSAL ASKED ABOUT STANDS ON THE CHAIN**, by its identity on
   * chain, read in this worker from the same history at the indexer the
   * person's own wallet names (`indexer`), and from nowhere else. With `seat`,
   * this device's signing secret, each says whether that seat's approval is
   * already counted (`approvedHere`) and, while held, whether that seat raised
   * it (`raisedHere`), which decides who may withdraw a change to the company.
   */
  roundsOnChain(input: {
    account: string; indexer: { indexerUri: string; indexerWsUri: string }; chainIds: readonly string[]; seat?: string;
  }): Promise<Record<string, RoundOnChain>>;
  /**
   * **WHICH OF THE LEAVES ASKED ABOUT THE ACCOUNT RECORDS PAID**, by each leaf as 64 lower-case hex digits: true once
   * the account's `movements` hold the entry its own `paidMovementOf` makes of that leaf. Read in this worker from the
   * latest state of the history at the indexer the person's own wallet names, and from nowhere else; a state that
   * cannot be read is refused, never answered "not paid". `false` means only "not seen in the newest state this indexer
   * holds", which an indexer behind the chain gives for a leaf just paid: never "owed", always "not yet seen".
   */
  paidLeaves(input: { account: string; indexer: { indexerUri: string; indexerWsUri: string }; leaves: readonly string[] }): Promise<Record<string, boolean>>;
  /**
   * **EVERY RUN OPEN NOW**, by its identity on chain, with the signers removed since it was raised, 0 included
   * (`runsOutrunIn`), read in this worker from the history at the indexer the person's own wallet names.
   */
  runsOutrun(input: { account: string; indexer: { indexerUri: string; indexerWsUri: string } }): Promise<Record<string, number>>;
  /**
   * **THE SEAT EACH INVITATION'S PROPOSAL TOOK**, by the proposal's identity on chain: the one leaf the `seatInvited`
   * call that closed it put into the account's signers, read from that call's own transaction, or null where no such
   * call closed it (`seatsInvitedIn`). Read in this worker from the history at the indexer the person's own wallet
   * names, and from nowhere else; a seating it cannot read is refused, never answered as no seat.
   */
  invitedSeats(input: {
    account: string; indexer: { indexerUri: string; indexerWsUri: string }; proposals: readonly string[];
  }): Promise<Record<string, string | null>>;
  /**
   * The invitee's own call taking the seat an invitation by address offered (`buildSeatInvitedCall`), built and proved
   * in this worker. Asked only by the invitee's wallet: the address's coin key it carries never comes from a page.
   */
  seatInvited(input: InvitedSeatOnTheWire): Promise<string>;
  /**
   * One batch folded into the head this device read, built and proved with this signer's own material, naming who held
   * the account as the batch was judged; the account refuses it unless they still do.
   */
  anchor(input: {
    account: string; material: SignerMaterial; chain: AccountCallChainOnTheWire; previous: string; batch: string;
    held: Pick<BatchHolders, 'approvals' | 'signerRoot'>;
  }): Promise<{ tx: string }>;
  /**
   * **A RECOVERY OF THE RECORD ANCHOR, BUILT AND PROVED HERE**, as an anchor
   * call: the recovery's batch folded into the head this device read, resuming
   * from the head `resumesFrom` its quorum approved under `proposal`, raised
   * with `proposalSalt`, before `latest`, while the head the latest recovery
   * carried out wrote is still `lastRecovery`; refused unless that proposal is
   * approved and the holders named still hold the account. `placement` is the
   * section of its transaction the call lands in, read off it: in the fallible
   * one, a carrying out another anchor beats pays its fee.
   */
  recoverAnchor(input: {
    account: string; material: SignerMaterial; chain: AccountCallChainOnTheWire; previous: string; batch: string;
    held: Pick<BatchHolders, 'approvals' | 'signerRoot'>; resumesFrom: string; latest: string; lastRecovery: string;
    proposal: string; proposalSalt: string;
  }): Promise<{ tx: string; placement: AnchorPlacement }>;
  /**
   * **WHAT A CALL TO THE ACCOUNT ALONE IS BUILT ON**, read in this worker at one
   * block from the indexer the person's own wallet names (`indexer`), and never
   * from the company's service: the account's state and the ledger's
   * parameters. Null while the indexer holds the account at no block.
   */
  accountCallChain(input: { account: string; indexer: { indexerUri: string; indexerWsUri: string } }): Promise<AccountCallChainOnTheWire | null>;
  /**
   * **WHETHER THE COMPANY'S ACCOUNT IS ON THE CHAIN, BY THE CHAIN'S OWN TIME**, read in this worker at the indexer the
   * person's own wallet names and never from the service: whether a contract is held at the address, the time of the
   * newest block named in the same answer, and the newest time to live of the kept transactions (`transactions`, base64),
   * null when one of them cannot be read. It throws when the indexer cannot say.
   */
  accountPresence?(input: { account: string; indexer: { indexerUri: string; indexerWsUri: string }; transactions: string[] }): Promise<AccountPresenceOnTheWire>;
  /**
   * Where a vault's start stands, read off both contracts' states at one block
   * (base64), and with `secret` the secret run made from it over `previous` (the
   * commitment it replaces; zero when absent), finding among `earlier` the secret
   * a replacement carries. `now` is this device's clock in seconds, as digits.
   */
  startStanding(input: {
    vault: string; account: string; accountState: string; vaultState: string;
    secret?: string; readers?: readonly string[]; now: string; previous?: string; earlier?: readonly string[];
    /** A window to make the secret run's identity with, for a raise about to be built. */
    window?: { opensAt: string; closesAt: string };
    /** This device's signing secret: each round then says whether this seat's approval is already counted (`approvedHere`). */
    seat?: string;
    /** For a vault the company retired and adopts again, the proposal that retired it, which its adoption is made from. */
    again?: string;
  }): Promise<{ standing: StartStandingOnTheWire; run?: SecretRunOnTheWire }>;
  /** The vault's secret set under its approved run, carrying `earlier` when it replaces one, built against one block's view of both contracts. */
  setNonceSecret(input: {
    vault: string; account: string; run: SecretRunOnTheWire; secret: string; earlier?: string; proposal: string; opensAt: string; closesAt: string;
    chain: PayoutChainOnTheWire;
  }): Promise<{ tx: string }>;
  /** One sealed copy of the run's secret written into the vault, by its place in the approved tree. */
  writeSecretCopy(input: { vault: string; run: SecretRunOnTheWire; place: number; state: string; parameters: string }): Promise<{ tx: string }>;
  /** The vault retired under the proposal its signers approved and that proposal's salt, built against one block's view of both contracts. */
  retire?(input: Omit<RetireAsk, 'id' | 'network' | 'ask'>): Promise<{ tx: string }>;
  /** One public token the vault lists and holds none of taken off its list, which its retire refuses while any token is on it. */
  forgetUnshielded?(input: Omit<ForgetUnshieldedAsk, 'id' | 'network' | 'ask'>): Promise<{ tx: string }>;
  /**
   * Has the worker fetch and check, ahead of any proof, the public parameters the
   * circuits this app proves need, through the same checked source a proof reads.
   * Resolves once they are held on this device; refuses with the worker's own
   * words when one could not be fetched or is not the published file.
   */
  provingWarmed?(): Promise<void>;
}

interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** A worker the page started itself, which it can hear stop and can stop. */
interface VaultWorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: { message?: string }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  terminate(): void;
}

/** One proof the worker is working out now: the ask it belongs to, its circuit when it names one, and how long it has run. */
export interface ProofInProgress {
  readonly ask: string;
  readonly circuit: string | null;
  readonly startedAt: number;
  readonly elapsedMs: number;
}

const START_MS = 30_000;

/**
 * The asks that only read the network and send nothing: each is held to SERVICE_READ_BOUND_MS from when the worker
 * says it has started it, its code loaded. Every other ask may be a send or a proof and is never cut short.
 */
export const CHAIN_READS: ReadonlySet<string> = new Set([
  'vault-as-deployed', 'vault-on-chain', 'vaults-on-chain', 'chain-at-one-block', 'events-of', 'created-by', 'vault-call-on-chain', 'anchors-on-chain', 'rounds-on-chain',
  'paid-leaves', 'runs-outrun', 'invited-seats', 'account-call-chain', 'account-presence', 'secret-set-at', 'account-committee', 'contract-authority',
]);

/** The answers for `asked`, in its order, or a refusal when the worker left a vault out or answered for another. */
export const everyVaultAnswered = (
  asked: readonly string[], reads: ReadonlyArray<{ readonly vault: string; readonly read: VaultOnChainOnTheWire }>,
): VaultOnChainOnTheWire[] => {
  if (!Array.isArray(reads) || reads.length !== asked.length || reads.some((r, i) => r?.vault !== asked[i])) {
    throw new Error('the read of the vaults on the chain did not answer for every vault asked, so none of it is used.');
  }
  return reads.map((r) => r.read);
};

/** What the worker says when its code is loaded and it starts on an ask: a read's time limit starts here. */
export const ASK_STARTED = 'vault-ask-started';

/** What `askOver` is handed to reach a worker: one that is ready, posting what it is given and stopped on a failure. */
interface Reached {
  post(message: unknown): void;
  stop(): void;
}
type Reach = (hear: (data: unknown) => void, stopped: (reason: 'stopped' | 'unreadable-answer') => void) => Promise<Reached>;

/**
 * **EVERY ASK ANSWERS OR FAILS WITH A REASON INSIDE THE TIME LIMIT.** An ask
 * fails when `PROOF_CEILING_MS` passes since the later of its own posting and
 * the worker's last word about work in progress: a proof starting or ending, or
 * a fetch of proving material starting or ending. An answer to another ask is
 * not such a word, so an ask whose work never finishes is not held open by the
 * asks answered around it. A proof on this device's one
 * thread blocks the worker, so its silence is what this hears. A failure stops
 * the worker and fails every ask waiting on it, since the page cannot tell which
 * ask held it up; the next ask reaches a new one. Nothing a stopped worker still
 * says is heard.
 *
 * A read of the network is also held to SERVICE_READ_BOUND_MS, from when the
 * worker says it has started it: the worker loads its code on its first ask,
 * and that load is bounded by the time limit above, not by the read's. The
 * worker saying it started an ask is not a word about work in progress.
 */
function askOver(reach: Reach, network: string, now: () => number) {
  let next = 1;
  let generation = 0;
  let current: { readonly at: number; readonly reached: Reached } | null = null;
  let reaching: Promise<{ readonly at: number; readonly reached: Reached }> | null = null;
  let lastWord = now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const waiting = new Map<number, { ask: string; postedAt: number; resolve: (a: VaultAnswer) => void; reject: (e: Error) => void }>();
  const proofs = new Map<number, { ask: string; circuit: string | null; startedAt: number }>();
  const readStarts = new Map<number, () => void>();

  const failAll = (at: number, reason: Exclude<VaultAskFailure, 'answered'>): void => {
    if (at !== generation) return;
    generation += 1;
    const was = current;
    current = null;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const failed = [...waiting.values()];
    waiting.clear();
    readStarts.clear();
    proofs.clear();
    try { was?.reached.stop(); } catch { /* a worker that cannot be stopped is not heard again either way */ }
    for (const w of failed) w.reject(new VaultAskFailed(w.ask, reason, FAILED_BECAUSE[reason]));
  };
  const arm = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (waiting.size === 0) return;
    let earliest = Infinity;
    for (const w of waiting.values()) earliest = Math.min(earliest, Math.max(w.postedAt, lastWord));
    const at = generation;
    timer = setTimeout(() => {
      timer = null;
      const t = now();
      const late = [...waiting.values()].some((w) => t - Math.max(w.postedAt, lastWord) >= PROOF_CEILING_MS);
      if (late) failAll(at, 'took-too-long'); else arm();
    }, Math.max(0, earliest + PROOF_CEILING_MS - now()));
  };
  const hearFor = (at: number) => (data: unknown): void => {
    if (at !== generation || typeof data !== 'object' || data === null) return;
    const m = data as { kind?: unknown; id?: unknown; ok?: unknown; ask?: unknown; circuit?: unknown; state?: unknown; started?: unknown };
    if (m.ok === undefined && m.kind === ASK_STARTED) {
      if (typeof m.started === 'number') { readStarts.get(m.started)?.(); readStarts.delete(m.started); }
      return;
    }
    if (m.ok === undefined) {
      lastWord = now();
      if (m.kind === 'vault-proof' && typeof m.id === 'number') {
        if (m.state === 'started') {
          proofs.set(m.id, { ask: String(m.ask), circuit: typeof m.circuit === 'string' ? m.circuit : null, startedAt: lastWord });
        } else proofs.delete(m.id);
      }
      arm();
      return;
    }
    if (typeof m.id !== 'number') return;
    const w = waiting.get(m.id);
    if (w === undefined) return;
    waiting.delete(m.id);
    proofs.delete(m.id);
    w.resolve(data as VaultAnswer);
    arm();
  };
  const reached = (): Promise<{ readonly at: number; readonly reached: Reached }> => {
    if (current !== null) return Promise.resolve(current);
    if (reaching !== null) return reaching;
    const at = generation;
    reaching = reach(hearFor(at), (reason) => failAll(at, reason)).then(
      (r) => {
        reaching = null;
        if (at !== generation) { r.stop(); throw new Error('the worker stopped while it started.'); }
        lastWord = now();
        current = { at, reached: r };
        return current;
      },
      (e: unknown) => { reaching = null; throw e; },
    );
    return reaching;
  };
  const ask = async <A extends VaultAsk['ask']>(request: VaultRequest & { ask: A }) => {
    let live: { readonly at: number; readonly reached: Reached };
    try {
      live = await reached();
    } catch (e) {
      throw new VaultAskFailed(request.ask, 'did-not-start', (e as Error)?.message ?? FAILED_BECAUSE['did-not-start']);
    }
    const id = next;
    next += 1;
    const answered = new Promise<VaultAnswer>((resolve, reject) => {
      waiting.set(id, { ask: request.ask, postedAt: now(), resolve, reject });
    });
    const read = CHAIN_READS.has(request.ask);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outOfTime = new Promise<never>((_, refuse) => {
      if (!read) return;
      readStarts.set(id, () => {
        timer = setTimeout(() => {
          waiting.delete(id);
          proofs.delete(id);
          arm();
          refuse(new ReadRanOutOfTime(`The network (${request.ask})`));
        }, SERVICE_READ_BOUND_MS);
      });
    });
    try {
      live.reached.post({ ...request, id, network });
    } catch (e) {
      waiting.delete(id);
      readStarts.delete(id);
      throw e;
    }
    arm();
    let a: VaultAnswer;
    if (read) {
      try { a = await Promise.race([answered, outOfTime]); } finally { clearTimeout(timer); readStarts.delete(id); }
    } else {
      a = await answered;
    }
    if (a.ok !== true) {
      const refused = a as { error: string; name?: string; kind?: string };
      throw new VaultAskFailed(request.ask, 'answered', refused.error, {
        ...(typeof refused.name === 'string' ? { name: refused.name } : {}),
        ...(typeof refused.kind === 'string' ? { kind: refused.kind } : {}),
      });
    }
    if (a.ask !== request.ask) throw new Error('the vault worker answered a different question.');
    return a as Extract<VaultAnswer, { ask: A }>;
  };
  const proofsInProgress = (): readonly ProofInProgress[] => {
    const t = now();
    return [...proofs.values()].map((p) => ({ ...p, elapsedMs: t - p.startedAt }));
  };
  return { ask, proofsInProgress, opened: () => reached().then(() => undefined) };
}

/**
 * A client over a worker that is already running and listened to for its
 * messages only. `network` is the deployment's own network name. It has the
 * time limit; a failure cannot stop this worker, so the next ask goes to it
 * again.
 */
export function vaultBuilderOver(worker: WorkerLike, network: string, now: () => number = Date.now): VaultBuilderClient {
  let hearNow: (data: unknown) => void = () => {};
  worker.addEventListener('message', (event) => hearNow(event.data));
  const reached: Reached = { post: (m) => worker.postMessage(m), stop: () => {} };
  const { ask, proofsInProgress } = askOver(async (hear) => { hearNow = hear; return reached; }, network, now);
  return clientFrom(ask, proofsInProgress);
}

/**
 * **THE WORKER STARTED ONLY WHEN AN ASK NEEDS ONE.** Each worker `start` makes
 * is waited for until it says it is ready, for thirty seconds; its error after
 * that fails every ask waiting on it, and the next ask starts another.
 */
const reachOver = (start: () => VaultWorkerLike): Reach => (hear, stopped) => new Promise<Reached>((resolve, reject) => {
  const worker = start();
  let ready = false;
  const timer = setTimeout(() => {
    try { worker.terminate(); } catch { /* it is not heard again either way */ }
    reject(new Error(FAILED_BECAUSE['did-not-start']));
  }, START_MS);
  worker.addEventListener('message', (event) => {
    if (!ready) {
      if ((event.data as { kind?: unknown } | null)?.kind !== 'vault-worker-ready') return;
      ready = true;
      clearTimeout(timer);
      resolve({ post: (m) => worker.postMessage(m), stop: () => worker.terminate() });
      return;
    }
    hear(event.data);
  });
  const ended = (reason: 'stopped' | 'unreadable-answer') => () => {
    if (ready) { stopped(reason); return; }
    clearTimeout(timer);
    try { worker.terminate(); } catch { /* it is not heard again either way */ }
    reject(new Error('the part of this page that builds vault transactions stopped before it started.'));
  };
  worker.addEventListener('error', ended('stopped'));
  worker.addEventListener('messageerror', ended('unreadable-answer'));
});

/** A client that starts its own workers with `start`, and starts a new one after a worker fails. */
export function vaultBuilderOnWorkers(start: () => VaultWorkerLike, network: string, now: () => number = Date.now): VaultBuilderClient {
  const { ask, proofsInProgress } = askOver(reachOver(start), network, now);
  return clientFrom(ask, proofsInProgress);
}

/**
 * The name the person's wallet gives its own vault builder's worker: a worker
 * of that name is started by the wallet, with the wallet's own keys and
 * prover, and the builder does not start itself again in it with the page's.
 */
export const WALLET_VAULT_BUILDER = 'wallet-vault-builder';

/** The page's client, once its first worker has said it is ready; a later worker is started when an ask needs one. */
export function startVaultBuilder(network: string): Promise<VaultBuilderClient> {
  const start = () => new Worker(new URL('./vault-worker-entry.js', import.meta.url), { type: 'module', name: 'vault-builder' }) as unknown as VaultWorkerLike;
  const { ask, proofsInProgress, opened } = askOver(reachOver(start), network, Date.now);
  return opened().then(() => clientFrom(ask, proofsInProgress));
}

type Ask = ReturnType<typeof askOver>['ask'];

/** Every ask of the client, each through the one `ask`. */
function clientFrom(ask: Ask, proofsInProgress: () => readonly ProofInProgress[]): VaultBuilderClient {
  return {
    proofsInProgress,
    deploy: async (account) => {
      const a = await ask({ ask: 'deploy', account });
      return { vault: a.vault, temporaryKey: a.temporaryKey, tx: a.tx };
    },
    accountDeploy: async (input) => {
      const a = await ask({ ask: 'account-deploy', ...input });
      return { account: a.account, tx: a.tx, insert: a.insert };
    },
    finishedCreation: async (input) => ({ tx: (await ask({ ask: 'finished-creation', ...input })).tx }),
    bornHeldVault: async (input) => {
      const a = await ask({ ask: 'born-held-vault', ...input });
      return { vault: a.vault, tx: a.tx };
    },
    vaultAsDeployed: async (input) => ({ refusal: (await ask({ ask: 'vault-as-deployed', ...input })).refusal }),
    handover: async (input) => ({ tx: (await ask({
      ask: 'handover', vault: input.vault, counter: input.counter.toString(), temporaryKey: input.temporaryKey, to: input.to,
    })).tx }),
    deposit: async (input) => ({ tx: (await ask({ ask: 'deposit', ...input })).tx }),
    publicDeposit: async (input) => ({ tx: (await ask({ ask: 'public-deposit', ...input })).tx }),
    commitments: async (input) => {
      const a = await ask({ ask: 'commitments', ...input });
      return { output: a.output, held: a.held };
    },
    stepKept: async (input) => (await ask({ ask: 'step-kept', ...input })).kept,
    vaultRebuilt: async (input) => {
      const { id: _id, ok: _ok, ask: _ask, ...answer } = await ask({ ask: 'vault-rebuilt', ...input });
      return answer;
    },
    vaultOnChain: async (input) => (await ask({ ask: 'vault-on-chain', ...input })).read,
    vaultsOnChain: async (input) => everyVaultAnswered(input.vaults, (await ask({ ask: 'vaults-on-chain', ...input, vaults: [...input.vaults] })).reads),
    chainAtOneBlock: async (input) => (await ask({ ask: 'chain-at-one-block', ...input })).chain,
    eventsOf: async (input) => (await ask({ ask: 'events-of', ...input })).events,
    createdBy: async (input) => (await ask({ ask: 'created-by', ...input })).found,
    vaultCallOnChain: async (input) => (await ask({ ask: 'vault-call-on-chain', ...input })).seen,
    superAdmins: superAdminWorkerOver((request) => ask(request)),
    readTransaction: async (input) => (await ask({ ask: 'transaction-read', ...input })).read,
    ownSeat: async (material) => (await ask({ ask: 'own-seat', material })).seat,
    creationAgain: async (input) => {
      const a = await ask({ ask: 'creation-again', ...input });
      return { account: a.account, deploy: a.deploy, insert: a.insert };
    },
    secretIsTheVaults: async (input) => (await ask({ ask: 'secret-is-the-vaults', ...input })).matches,
    ownChainCopy: async (input) => (await ask({ ask: 'own-chain-copy', ...input })).copy,
    secretSetAt: async (input) => (await ask({ ask: 'secret-set-at', ...input })).removals,
    notesForPayment: async (input) => (await ask({ ask: 'notes-for-payment', ...input })).notes,
    paymentsFit: async (input) => (await ask({ ask: 'payments-fit', ...input })).answer,
    afterPayment: async (input) => (await ask({ ask: 'after-payment', ...input })).notes,
    confirmPayment: async (input) => (await ask({ ask: 'confirm-payment', ...input })).confirmation,
    creatingTransaction: async (input) => (await ask({ ask: 'creating-transaction', ...input })).answer,
    payout: async (input) => {
      const a = await ask({ ask: 'payout', ...input });
      return { tx: a.tx, spent: a.spent, change: a.change };
    },
    mergeNotes: async (input) => {
      const a = await ask({ ask: 'merge', ...input });
      return { tx: a.tx, spent: a.spent, kept: a.kept };
    },
    payoutPublicly: async (input) => ({ tx: (await ask({ ask: 'payout-publicly', ...input })).tx }),
    governedCall: async (input) => ({ tx: (await ask({ ask: 'governed-call', ...input })).tx }),
    clearRun: async (input) => {
      const a = await ask({ ask: 'clear-run', ...input });
      return { tx: a.tx, spent: a.spent };
    },
    periodTotal: async (input) => (await ask({ ask: 'period-total', ...input })).spent,
    runCharged: async (input) => (await ask({ ask: 'run-charged', ...input })).standing,
    lastRecovery: async (input) => (await ask({ ask: 'last-recovery', ...input })).head,
    anchorHeads: async (input) => {
      const a = await ask({ ask: 'anchor-heads', ...input });
      return { after: a.after, seats: a.seats, holderSeats: a.holderSeats };
    },
    anchorsOnChain: async (input) => {
      const a = await ask({ ask: 'anchors-on-chain', ...input });
      return { landed: a.landed, now: a.now, seatsNow: a.seatsNow, deployed: a.deployed, vouching: a.vouching };
    },
    roundsOnChain: async (input) => (await ask({ ask: 'rounds-on-chain', ...input })).rounds,
    paidLeaves: async (input) => (await ask({ ask: 'paid-leaves', ...input })).paid,
    runsOutrun: async (input) => (await ask({ ask: 'runs-outrun', ...input })).runs,
    invitedSeats: async (input) => (await ask({ ask: 'invited-seats', ...input })).seats,
    seatInvited: async (input) => (await ask({ ask: 'seat-invited', ...input })).tx,
    anchor: async (input) => ({ tx: (await ask({ ask: 'anchor', ...input })).tx }),
    recoverAnchor: async (input) => {
      const a = await ask({ ask: 'recover-anchor', ...input });
      return { tx: a.tx, placement: a.placement };
    },
    accountCallChain: async (input) => (await ask({ ask: 'account-call-chain', ...input })).chain,
    accountPresence: async (input) => (await ask({ ask: 'account-presence', ...input })).presence,
    anchorTag: async (input) => (await ask({ ask: 'anchor-tag', ...input })).tag,
    seatOpenings: async (input) => {
      const a = await ask({ ask: 'seat-openings', ...input });
      return a.own === undefined ? { openings: a.openings } : { openings: a.openings, own: a.own };
    },
    proposalIdentity: async (change, salt) => (await ask({ ask: 'proposal-identity', change, salt })).identity,
    vouchedRunIdentity: async (run) => (await ask({ ask: 'vouched-run-identity', run })).chainId,
    companyWide: async () => (await ask({ ask: 'company-wide' })).value,
    spendingPolicyKeys: async (input) => (await ask({ ask: 'spending-policy-keys', ...input })).keys,
    policyBarKey: async () => (await ask({ ask: 'policy-bar-key' })).value,
    addressClaimRefusal: async (claim, f) => (await ask({ ask: 'address-claim-refusal', claim, for: f })).refusal,
    openOneOff: async (rec, key) => (await ask({ ask: 'one-off-opened', rec, key })).oneOff,
    startStanding: async (input) => {
      const a = await ask({ ask: 'start-standing', ...input });
      return { standing: a.standing, ...(a.run === undefined ? {} : { run: a.run }) };
    },
    setNonceSecret: async (input) => ({ tx: (await ask({ ask: 'set-nonce-secret', ...input })).tx }),
    writeSecretCopy: async (input) => ({ tx: (await ask({ ask: 'write-secret-copy', ...input })).tx }),
    retire: async (input) => ({ tx: (await ask({ ask: 'retire', ...input })).tx }),
    forgetUnshielded: async (input) => ({ tx: (await ask({ ask: 'forget-unshielded', ...input })).tx }),
    provingWarmed: async () => { await ask({ ask: 'warm-proving' }); },
  };
}
