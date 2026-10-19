/**
 * **THE PAGE'S SIDE OF THE VAULT WORKER.** One request, one answer, matched by
 * id. The page never loads what the worker loads; it only sends what to build
 * and receives proven bytes back. Every ask answers or fails with a reason
 * (`VaultAskFailed`) inside the proof time limit, a worker that stops is
 * replaced on the next ask, and the page can read how long each proof in
 * progress has run (`proofsInProgress`).
 */
import type { Committee } from '../../../src/midnight/vault-committee.js';
import type { PrivatePaymentOnTheWire, PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import type { PaymentsFitAnswer } from '../../../src/midnight/vault-notes.js';
import type { EventOnTheWire, NoteOnTheWire, PaymentConfirmation, SecretRunOnTheWire } from './vault-builder.js';
import type { RoundMadeOf, RoundStanding } from '../../../src/midnight/vault-start.js';
import { PROOF_CEILING_MS } from './proof-ceiling.js';

export type { SecretRunOnTheWire } from './vault-builder.js';

/**
 * **HOW FAR A VAULT'S START HAS GOT**, as the worker read it off the account's
 * and the vault's ledgers at one block: adopted or not, where the adoption round
 * stands, and, once the company's record of the secret has been read, where the
 * first secret run, the secret and each sealed copy stand.
 */
export interface StartStandingOnTheWire {
  readonly adopted: boolean;
  readonly adoption: RoundStanding & RoundMadeOf;
  readonly secret?: {
    readonly set: boolean;
    readonly another: boolean;
    readonly rootIsThisRuns: boolean;
    readonly run: (RoundStanding & RoundMadeOf & { readonly opensAt: string; readonly closesAt: string; readonly inWindow: boolean }) | null;
    readonly raise?: RoundMadeOf & { readonly proposal: string; readonly opensAt: string; readonly closesAt: string };
    readonly written: readonly boolean[];
    readonly started: boolean;
  };
}
import type {
  AnchorPlacement, AnchorsOnChain, GovernanceOnTheWire, GovernedCallOrder, HeadStepAsked, OpenedRound, ProposalIdentity, RoundOnChain, SignerMaterial, SpendingPolicyKeys, VouchedRunOnTheWire,
} from './governed-call-builder.js';
import type { PolicyOpeningOnTheWire } from '../../../src/midnight/spending-policy-record.js';
import type { BatchHolders } from '../../../src/midnight/record-manifest.js';
import type { PeriodTotalAskOnTheWire, RunChargeStanding, RunToChargeOnTheWire, RunTreeOnTheWire } from './run-charge-builder.js';

export interface SigningKeyOnTheWire { readonly tag: string; readonly value: string }
export interface CoinOnTheWire { readonly nonce: string; readonly token: string; readonly value: string }
/** One block's view of what a payment out is built on, every value base64 of its bytes. */
export interface PayoutChainOnTheWire {
  readonly blockHash: string;
  readonly vaultState: string;
  readonly zswapState: string;
  readonly parameters: string;
  readonly accountState: string;
}
export type OrderOnTheWire = Omit<PrivatePaymentOrderOnTheWire, 'payments'>;
/**
 * Which transaction created a note, as its events say: `found`; `refused`, the
 * events are there and do not show this note as made there, and asking again
 * will not change that; or `unreadable`, and asking again may answer it.
 */
export type CreatingTransactionAnswer =
  | { readonly state: 'found'; readonly createdIn: string }
  | { readonly state: 'refused' }
  | { readonly state: 'unreadable' };
/** One block's view of the company account, for a raise or an approval to be built on. Base64 of the bytes. */
export interface AccountCallChainOnTheWire {
  readonly blockHash: string;
  readonly accountState: string;
  readonly parameters: string;
}

/**
 * **WHERE THE COMPANY'S PAY-RECORD KEY STANDS ON ITS ACCOUNT, FOR ONE SIGNER**,
 * read off the account's state with its own functions, and a copy of the key
 * sealed to that signer, ready to write.
 */
export interface PayKeyStandingOnTheWire {
  /** The commitment the account holds, or null when none is written yet. */
  readonly committed: string | null;
  readonly isThisKey: boolean;
  readonly sealedMine: boolean;
  readonly round: {
    readonly commitment: string; readonly payload: string; readonly salt: string; readonly proposal: string;
    readonly open: boolean; readonly approvals: number; readonly needed: number; readonly stale: boolean;
  };
  /** The value a governance round names in place of a vault. */
  readonly noVault: string;
  /** The key sealed to the signer's wrapping key, as the four entries the account stores. */
  readonly wrap: string[];
}

export type VaultAsk =
  | { id: number; network: string; ask: 'deploy'; account: string }
  /*
   * **A COMPANY'S ACCOUNT, HELD BY ITS FOUNDING SIGNER'S OWN COMMITTEE KEY FROM
   * ITS FIRST TRANSACTION**, and then the second step that finishes it, signed
   * by that key in the founding signer's wallet. Nothing secret crosses: a
   * seat, a label, a public key and a signature.
   */
  | { id: number; network: string; ask: 'account-deploy'; foundingLeaf: string; label: string; foundingKey: SigningKeyOnTheWire }
  | { id: number; network: string; ask: 'finished-creation'; account: string; signature: SigningKeyOnTheWire }
  /*
   * **A VAULT HELD BY THE COMPANY'S COMMITTEE FROM ITS FIRST TRANSACTION**, and
   * the reading of a vault's deploy, as sent, before it is adopted: held by
   * exactly that committee, this build's circuits, nothing written.
   */
  | { id: number; network: string; ask: 'born-held-vault'; account: string; holders: Committee }
  | { id: number; network: string; ask: 'vault-as-deployed'; vault: string; account: string; holders: Committee; indexer: { indexerUri: string; indexerWsUri: string } }
  | { id: number; network: string; ask: 'handover'; vault: string; counter: string; temporaryKey: SigningKeyOnTheWire; to: Committee }
  | { id: number; network: string; ask: 'deposit'; vault: string; coin: CoinOnTheWire; state: string; parameters: string }
  | { id: number; network: string; ask: 'public-deposit'; vault: string; token: string; amount: string; state: string; parameters: string }
  | { id: number; network: string; ask: 'commitments'; vault: string; coin: CoinOnTheWire }
  | { id: number; network: string; ask: 'step-kept'; vault: string; secret: string; step: StepOnTheWire }
  | ({ id: number; network: string; ask: 'vault-rebuilt' } & VaultRebuildAsked)
  | { id: number; network: string; ask: 'vault-on-chain'; vault: string; account?: string; indexer: { indexerUri: string; indexerWsUri: string } }
  /* What a step out of the vault is built on, and the events it is judged by, read here at the indexer the wallet names. */
  | { id: number; network: string; ask: 'chain-at-one-block'; vault: string; account: string; indexer: { indexerUri: string; indexerWsUri: string } }
  | { id: number; network: string; ask: 'events-of'; transactionHash: string; indexer: { indexerUri: string; indexerWsUri: string } }
  | { id: number; network: string; ask: 'created-by'; vault: string; commitment: string; indexer: { indexerUri: string; indexerWsUri: string } }
  | { id: number; network: string; ask: 'own-seat'; material: SignerMaterial }
  /* The founding signer's seat in a company made on this device: its leaf, and the scope it was made under. */
  | { id: number; network: string; ask: 'founding-seat'; material: { signingSecret: string; blinding: string } }
  /* A company's deploy and its signed second step, carried in fresh transactions: the same account, the same signature. */
  | { id: number; network: string; ask: 'creation-again'; deploy: string; insert: string }
  /* Where the pay-record key stands on the account for one signer, and their copy sealed. The key stays on this device. */
  | {
    id: number; network: string; ask: 'pay-key-standing'; account: string; accountState: string; key: string;
    signingSecret: string; wrappingPublicKey: string;
  }
  | { id: number; network: string; ask: 'secret-is-the-vaults'; vault: string; state: string; secret: string }
  | { id: number; network: string; ask: 'notes-for-payment'; notes: readonly NoteOnTheWire[]; token: string; amount: string }
  | {
    id: number; network: string; ask: 'payments-fit'; notes: readonly NoteOnTheWire[];
    payments: ReadonlyArray<{ token: string; amount: string }>;
  }
  | {
    id: number; network: string; ask: 'after-payment'; notes: readonly NoteOnTheWire[];
    spent: string; further?: readonly string[]; amount: string; change: NoteOnTheWire | null; createdIn: string | null;
  }
  | {
    id: number; network: string; ask: 'confirm-payment'; vault: string; transactionHash: string;
    change: NoteOnTheWire | null; events: readonly EventOnTheWire[]; merge?: true;
  }
  | {
    id: number; network: string; ask: 'creating-transaction'; vault: string; commitment: string;
    transactionHash: string; events: readonly EventOnTheWire[];
  }
  | {
    id: number; network: string; ask: 'payout'; vault: string; account: string; order: OrderOnTheWire;
    payment: PrivatePaymentOnTheWire; note: NoteOnTheWire; events: readonly EventOnTheWire[];
    further?: ReadonlyArray<{ readonly note: NoteOnTheWire; readonly events: readonly EventOnTheWire[] }>; chain: PayoutChainOnTheWire;
    /** The vault's current nonce secret, opened on this device, for this one payment. */
    secret: string;
  }
  | {
    id: number; network: string; ask: 'merge'; vault: string;
    notes: ReadonlyArray<{ readonly note: NoteOnTheWire; readonly events: readonly EventOnTheWire[] }>; chain: PayoutChainOnTheWire;
    /** The vault's current nonce secret, opened on this device, for this one merge. */
    secret: string;
  }
  /*
   * **A VAULT'S START.** The secret, when given, is the one the page opened from
   * the company's filed record, handed to the worker on the same device so the
   * first secret run is made with the contracts' own functions; it keeps none.
   */
  | {
    id: number; network: string; ask: 'start-standing'; vault: string; account: string;
    accountState: string; vaultState: string; secret?: string; readers?: readonly string[]; now: string;
    window?: { opensAt: string; closesAt: string };
  }
  | {
    id: number; network: string; ask: 'set-nonce-secret'; vault: string; account: string; run: SecretRunOnTheWire;
    secret: string; proposal: string; opensAt: string; closesAt: string; chain: PayoutChainOnTheWire;
  }
  | {
    id: number; network: string; ask: 'write-secret-copy'; vault: string; run: SecretRunOnTheWire; place: number;
    state: string; parameters: string;
  }
  | {
    id: number; network: string; ask: 'payout-publicly'; vault: string; account: string; order: OrderOnTheWire;
    payment: PrivatePaymentOnTheWire; chain: PayoutChainOnTheWire;
  }
  /*
   * **THE ONE ASK THAT CARRIES A SIGNER'S OWN KEY MATERIAL**, from the page to
   * the worker on the same device. The worker uses it for this one call and
   * keeps none of it.
   */
  | {
    id: number; network: string; ask: 'proposal-identity'; change: GovernanceOnTheWire; salt: string;
  }
  | {
    id: number; network: string; ask: 'vouched-run-identity'; run: VouchedRunOnTheWire;
  }
  | { id: number; network: string; ask: 'company-wide' }
  | { id: number; network: string; ask: 'policy-bar-key' }
  | {
    id: number; network: string; ask: 'spending-policy-keys'; vault: string; asset: string; assetBlinding: string;
    policy?: PolicyOpeningOnTheWire; total?: string;
  }
  | {
    id: number; network: string; ask: 'governed-call'; account: string; order: GovernedCallOrder;
    material: SignerMaterial; chain: AccountCallChainOnTheWire; opened: OpenedRound;
  }
  | {
    id: number; network: string; ask: 'clear-run'; account: string; run: RunToChargeOnTheWire;
    runs: readonly RunTreeOnTheWire[]; chain: { accountState: string; parameters: string };
  }
  | { id: number; network: string; ask: 'period-total'; accountState: string; total: PeriodTotalAskOnTheWire }
  | { id: number; network: string; ask: 'run-charged'; accountState: string; proposal: string }
  /* The head the latest recovery carried out wrote, read off one state of the account by its own reader and key. */
  | { id: number; network: string; ask: 'last-recovery'; accountState: string }
  | { id: number; network: string; ask: 'anchor-heads'; after: readonly HeadStepAsked[]; holders?: readonly BatchHolders[] }
  /* The tag this signer's seat anchors under in the account, by the account's own functions. */
  | { id: number; network: string; ask: 'anchor-tag'; account: string; material: SignerMaterial }
  /* What each seat's opening opens and the tag it anchors under, and this signer's own, by the account's own functions. */
  | {
    id: number; network: string; ask: 'seat-openings'; account: string;
    openings: ReadonlyArray<{ publicKey: string; scope: string; blinding: string }>; own?: SignerMaterial;
  }
  /* Every head the account's history shows, one per block, read in the worker at the indexer the wallet names. */
  | { id: number; network: string; ask: 'anchors-on-chain'; account: string; indexer: { indexerUri: string; indexerWsUri: string } }
  /* Where each proposal asked about stands, read in the worker from the account's history at the indexer the wallet names. */
  | { id: number; network: string; ask: 'rounds-on-chain'; account: string; indexer: { indexerUri: string; indexerWsUri: string }; chainIds: readonly string[] }
  | {
    id: number; network: string; ask: 'anchor'; account: string; material: SignerMaterial; chain: AccountCallChainOnTheWire;
    previous: string; batch: string; held: Pick<BatchHolders, 'approvals' | 'signerRoot'>;
  }
  /* A recovery of the record anchor under its approved proposal: as an anchor, resuming from a head its quorum approved. */
  | {
    id: number; network: string; ask: 'recover-anchor'; account: string; material: SignerMaterial; chain: AccountCallChainOnTheWire;
    previous: string; batch: string; held: Pick<BatchHolders, 'approvals' | 'signerRoot'>;
    resumesFrom: string; latest: string; lastRecovery: string; proposal: string; proposalSalt: string;
  }
  /* What a call to the account alone is built on, at one block, read in the worker at the indexer the wallet names. */
  | { id: number; network: string; ask: 'account-call-chain'; account: string; indexer: { indexerUri: string; indexerWsUri: string } };

type Answered<A extends VaultAsk['ask'], T> = { id: number; ok: true; ask: A } & T;

/** What each seat's opening opens and the tag it anchors under, and this signer's own (`seatOpeningsIn`). */
export interface SeatOpeningsAnswer {
  readonly openings: ReadonlyArray<{ readonly leaf: string | null; readonly tag: string | null }>;
  readonly own?: { readonly publicKey: string; readonly leaf: string; readonly tag: string };
}

export type VaultAnswer =
  | Answered<'deploy', { vault: string; temporaryKey: SigningKeyOnTheWire; tx: string }>
  | Answered<'account-deploy', { account: string; tx: string; insert: ReadonlyArray<{ circuit: string; key: string }> }>
  | Answered<'finished-creation', { tx: string }>
  | Answered<'born-held-vault', { vault: string; tx: string }>
  | Answered<'vault-as-deployed', { refusal: string | null }>
  | Answered<'handover', { tx: string }>
  | Answered<'deposit', { tx: string }>
  | Answered<'public-deposit', { tx: string }>
  | Answered<'commitments', { output: string; held: string }>
  | Answered<'step-kept', { kept: NoteOnTheWire | null }>
  | Answered<'vault-rebuilt', VaultRebuilt>
  | Answered<'vault-on-chain', { read: VaultOnChainOnTheWire }>
  | Answered<'chain-at-one-block', { chain: PayoutChainOnTheWire | null }>
  | Answered<'events-of', { events: EventOnTheWire[] }>
  | Answered<'created-by', { found: { transactionHash: string; events: EventOnTheWire[] } | null }>
  | Answered<'own-seat', { seat: string }>
  | Answered<'founding-seat', { seat: string; scope: string; publicKey: string }>
  | Answered<'creation-again', { account: string; deploy: string; insert: string }>
  | Answered<'pay-key-standing', { standing: PayKeyStandingOnTheWire }>
  | Answered<'secret-is-the-vaults', { matches: boolean }>
  | Answered<'notes-for-payment', { notes: NoteOnTheWire[] }>
  | Answered<'payments-fit', { answer: PaymentsFitAnswer }>
  | Answered<'after-payment', { notes: NoteOnTheWire[] }>
  | Answered<'confirm-payment', { confirmation: PaymentConfirmation }>
  | Answered<'creating-transaction', { answer: CreatingTransactionAnswer }>
  | Answered<'payout', { tx: string; spent: string; change: NoteOnTheWire | null }>
  | Answered<'merge', { tx: string; spent: string[]; kept: NoteOnTheWire }>
  | Answered<'payout-publicly', { tx: string }>
  | Answered<'governed-call', { tx: string }>
  | Answered<'clear-run', { tx: string | null; spent: string | null }>
  | Answered<'period-total', { spent: string }>
  | Answered<'run-charged', { standing: RunChargeStanding }>
  | Answered<'last-recovery', { head: string }>
  | Answered<'anchor-heads', { after: string[]; seats: (string[] | null)[]; holderSeats: (string[] | null)[] }>
  | Answered<'anchor-tag', { tag: string }>
  | Answered<'seat-openings', SeatOpeningsAnswer>
  | Answered<'anchors-on-chain', AnchorsOnChain>
  | Answered<'rounds-on-chain', { rounds: Record<string, RoundOnChain> }>
  | Answered<'anchor', { tx: string }>
  | Answered<'recover-anchor', { tx: string; placement: AnchorPlacement }>
  | Answered<'account-call-chain', { chain: AccountCallChainOnTheWire | null }>
  | Answered<'proposal-identity', { identity: ProposalIdentity }>
  | Answered<'vouched-run-identity', { chainId: string | null }>
  | Answered<'company-wide', { value: string }>
  | Answered<'spending-policy-keys', { keys: SpendingPolicyKeys }>
  | Answered<'policy-bar-key', { value: string }>
  | Answered<'start-standing', { standing: StartStandingOnTheWire; run?: SecretRunOnTheWire }>
  | Answered<'set-nonce-secret', { tx: string }>
  | Answered<'write-secret-copy', { tx: string }>
  | { id: number; ok: false; error: string; name?: string; kind?: string };

type Without<T> = T extends unknown ? Omit<T, 'id' | 'network'> : never;
export type VaultRequest = Without<VaultAsk>;

/** What the page needs from wherever vault transactions are built. */
/**
 * **A VAULT AS THE CHAIN HOLDS IT, AS THIS DEVICE READ IT.** `onChain: false`
 * when the indexer holds no state for the address. `notes` and `everCreated`
 * are commitments, 64 hex characters each; `notes` is absent when the state was
 * not laid out the way this build's vault is (`notesWhy` says why), and so are
 * `nonceCommitment` and `splitJournal`, which are never read as empty. `account`
 * is the company account it is pinned to;
 * `started` whether its first secret is set and every sealed copy written.
 * `circuits` is null when every circuit of the vault is the one this app was
 * built with, or says which is not; `accountCircuits` says the same of the
 * company account named in the ask, and is absent when no account was named.
 * Money goes in or out only when both are present and null.
 */
export type VaultOnChainOnTheWire =
  | { readonly onChain: false }
  | {
    readonly onChain: true;
    readonly state: string;
    readonly notes?: readonly string[];
    /** The secret's commitment the vault holds, and its split journal (nullifier, masked amount): read only with `notes`. */
    readonly nonceCommitment?: string;
    readonly splitJournal?: ReadonlyArray<readonly [string, string]>;
    readonly notesFromThisBuild: boolean;
    readonly notesWhy?: string;
    readonly everCreated: readonly string[];
    readonly account: string | null;
    readonly started: boolean;
    /** What it holds in public money, read off its state; absent, with why, when that could not be read. */
    readonly publicBalances?: ReadonlyArray<{ readonly token: string; readonly amount: string }>;
    readonly publicBalancesWhy?: string;
    readonly circuits?: { readonly why: string; readonly circuit: string | null } | null;
    readonly accountCircuits?: { readonly why: string; readonly circuit: string | null } | null;
  };

/**
 * What a rebuild of a vault's notes is asked over: the chain as one read gave it, the secrets the records hold, the
 * newest (or every) pool version, the journals' lines, the coins this device kept or was handed, and, for `walk`, the
 * company's own amounts. Amounts and values are decimal digits.
 */
export interface VaultRebuildAsked {
  readonly vault: string;
  readonly state?: string;
  readonly chain: {
    readonly notes: readonly string[];
    readonly everCreated: readonly string[];
    readonly nonceCommitment?: string;
    readonly splitJournal?: ReadonlyArray<readonly [string, string]>;
  };
  readonly secrets: readonly string[];
  readonly copyFor?: string;
  readonly versions: ReadonlyArray<{ readonly version: number; readonly notes: readonly CoinOnTheWire[] }>;
  readonly attempted: { readonly deposits: readonly CoinOnTheWire[]; readonly payments: readonly StepOnTheWire[] };
  readonly named?: readonly CoinOnTheWire[];
  readonly walk?: {
    readonly deposited: ReadonlyArray<{ readonly token: string; readonly value: string }>;
    readonly paid: ReadonlyArray<{ readonly token: string; readonly amount: string }>;
  };
}

/** A rebuild's answer: each held note with its held and output commitments, the chain notes nothing named, the sealed copy, and what was said. */
export interface VaultRebuilt {
  readonly held: ReadonlyArray<{ readonly nonce: string; readonly token: string; readonly value: string; readonly held: string; readonly output: string }>;
  readonly unexplained: readonly string[];
  readonly copy: readonly string[] | null;
  readonly said: readonly string[];
}

/** One step of the vault's payment journal as it crosses to the worker: its notes in place order, what left, and whether it was a merge. */
interface StepOnTheWire {
  readonly spent: NoteOnTheWire;
  readonly further?: readonly NoteOnTheWire[];
  readonly amount: string;
  readonly merge?: boolean;
}

export interface VaultBuilderClient {
  /**
   * The proofs the worker is working out now, each with how long it has run,
   * read off the worker's own word as each starts and ends. Every client this
   * file makes has it.
   */
  readonly proofsInProgress?: () => readonly ProofInProgress[];
  deploy(account: string): Promise<{ vault: string; temporaryKey: SigningKeyOnTheWire; tx: string }>;
  /**
   * The company's account, deployed held by the founding signer's committee key
   * from its first transaction, proved; and the keys of this build the second
   * step inserts, each checked against the compiled account's own digest, as
   * base64 of their files, for the founding signer's wallet to check again.
   */
  accountDeploy?(input: { foundingLeaf: string; label: string; foundingKey: SigningKeyOnTheWire }): Promise<{
    account: string; tx: string; insert: ReadonlyArray<{ circuit: string; key: string }>;
  }>;
  /** The second step of the account's creation, with the founding signer's wallet's signature on it, proved. */
  finishedCreation?(input: { account: string; signature: SigningKeyOnTheWire }): Promise<{ tx: string }>;
  /** A vault deployed held by the company's committee at its threshold from its first transaction, proved. */
  bornHeldVault?(input: { account: string; holders: Committee }): Promise<{ vault: string; tx: string }>;
  /**
   * The vault as its deploy made it, read here: null when it was born held by
   * `holders`, pinned to `account`, with this build's circuits and nothing
   * written; otherwise the sentence that says what it is instead.
   */
  /**
   * The vault as its deploy made it, read in the worker from the deploy the
   * chain holds for its address, at the indexer the person's own wallet names.
   */
  vaultAsDeployed?(input: { vault: string; account: string; holders: Committee; indexer: { indexerUri: string; indexerWsUri: string } }): Promise<{ refusal: string | null }>;
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
   * The seat this signer's own key material makes on the company's account: the
   * leaf the account holds for them, worked out here and not taken from any record.
   */
  ownSeat(material: SignerMaterial): Promise<string>;
  /**
   * The seat keys made on this device make on a company founded here: the leaf
   * the account seats, and the scope it was made under, both worked out with
   * the chain's own function.
   */
  foundingSeat?(material: { signingSecret: string; blinding: string }): Promise<{ seat: string; scope: string; publicKey: string }>;
  /** A company's deploy and its signed second step carried again in fresh transactions, as base64. */
  creationAgain?(input: { deploy: string; insert: string }): Promise<{ account: string; deploy: string; insert: string }>;
  /** Where the pay-record key stands on the account (its state as base64) for the signer whose secret is given. */
  payKeyStanding?(input: {
    account: string; accountState: string; key: string; signingSecret: string; wrappingPublicKey: string;
  }): Promise<PayKeyStandingOnTheWire>;
  /**
   * Whether `secret` is the one the vault's commitment names in `state` (base64
   * of the vault's state): its commitment, worked out with the vault's own
   * function, against the one the state holds.
   */
  secretIsTheVaults(input: { vault: string; state: string; secret: string }): Promise<boolean>;
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
   * chain under the salt given and no vault.
   */
  proposalIdentity(change: GovernanceOnTheWire, salt: string): Promise<ProposalIdentity>;
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
   * person's own wallet names (`indexer`), and from nowhere else.
   */
  roundsOnChain(input: {
    account: string; indexer: { indexerUri: string; indexerWsUri: string }; chainIds: readonly string[];
  }): Promise<Record<string, RoundOnChain>>;
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
   * Where a vault's start stands, read off both contracts' states at one block
   * (base64), and with `secret` the first secret run made from it. `now` is
   * this device's clock in seconds, as digits.
   */
  startStanding(input: {
    vault: string; account: string; accountState: string; vaultState: string;
    secret?: string; readers?: readonly string[]; now: string;
    /** A window to make the first secret run's identity with, for a raise about to be built. */
    window?: { opensAt: string; closesAt: string };
  }): Promise<{ standing: StartStandingOnTheWire; run?: SecretRunOnTheWire }>;
  /** The vault's first secret set under its approved run, built against one block's view of both contracts. */
  setNonceSecret(input: {
    vault: string; account: string; run: SecretRunOnTheWire; secret: string; proposal: string; opensAt: string; closesAt: string;
    chain: PayoutChainOnTheWire;
  }): Promise<{ tx: string }>;
  /** One sealed copy of the run's secret written into the vault, by its place in the approved tree. */
  writeSecretCopy(input: { vault: string; run: SecretRunOnTheWire; place: number; state: string; parameters: string }): Promise<{ tx: string }>;
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
interface ProofInProgress {
  readonly ask: string;
  readonly circuit: string | null;
  readonly startedAt: number;
  readonly elapsedMs: number;
}

/**
 * Why an ask of the vault worker failed: the worker said nothing for the time
 * limit, it stopped, it sent an answer the page could not read, a new worker did
 * not start, or the worker answered with a refusal of its own.
 */
type VaultAskFailure = 'took-too-long' | 'stopped' | 'unreadable-answer' | 'did-not-start' | 'answered';

/**
 * **EVERY FAILED ASK OF THE VAULT WORKER, ONE CLASS.** `reason` says which kind
 * of failure it was. When the worker answered with a refusal, the message is the
 * worker's own, `name` and `workerName` are the name of the worker's error, and
 * `kind` is how proving material was refused when that was the refusal. The
 * message never says whether anything was sent: that is for the step that
 * asked, which alone knows whether it sent anything before.
 */
export class VaultAskFailed extends Error {
  readonly ask: string;
  readonly reason: VaultAskFailure;
  readonly workerName?: string;
  readonly kind?: string;
  constructor(ask: string, reason: VaultAskFailure, message: string, said: { name?: string; kind?: string } = {}) {
    super(message);
    this.ask = ask;
    this.reason = reason;
    this.name = said.name ?? 'VaultAskFailed';
    if (said.name !== undefined) this.workerName = said.name;
    if (said.kind !== undefined) this.kind = said.kind;
  }
}

const MINUTES = Math.round(PROOF_CEILING_MS / 60_000);
const WORKER = 'the part of this page that builds and proves vault transactions';
const FAILED_BECAUSE: Record<Exclude<VaultAskFailure, 'answered'>, string> = {
  'took-too-long': `${WORKER} said nothing for ${MINUTES} minutes, so this page stopped it. Try again with this page open `
    + 'in front and other heavy work closed.',
  stopped: `${WORKER} stopped before it answered. Try again; if it happens again, reload the page.`,
  'unreadable-answer': `${WORKER} sent an answer this page could not read, so this page stopped it. Try again; if it `
    + 'happens again, reload the page.',
  'did-not-start': 'the part of this page that builds vault transactions did not start.',
};
const START_MS = 30_000;

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

  const failAll = (at: number, reason: Exclude<VaultAskFailure, 'answered'>): void => {
    if (at !== generation) return;
    generation += 1;
    const was = current;
    current = null;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const failed = [...waiting.values()];
    waiting.clear();
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
    const m = data as { kind?: unknown; id?: unknown; ok?: unknown; ask?: unknown; circuit?: unknown; state?: unknown };
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
    try {
      live.reached.post({ ...request, id, network });
    } catch (e) {
      waiting.delete(id);
      throw e;
    }
    arm();
    const a = await answered;
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
    handover: async (input) => {
      const a = await ask({
        ask: 'handover', vault: input.vault, counter: input.counter.toString(),
        temporaryKey: input.temporaryKey, to: input.to,
      });
      return { tx: a.tx };
    },
    deposit: async (input) => {
      const a = await ask({ ask: 'deposit', ...input });
      return { tx: a.tx };
    },
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
    chainAtOneBlock: async (input) => (await ask({ ask: 'chain-at-one-block', ...input })).chain,
    eventsOf: async (input) => (await ask({ ask: 'events-of', ...input })).events,
    createdBy: async (input) => (await ask({ ask: 'created-by', ...input })).found,
    ownSeat: async (material) => (await ask({ ask: 'own-seat', material })).seat,
    foundingSeat: async (material) => {
      const a = await ask({ ask: 'founding-seat', material });
      return { seat: a.seat, scope: a.scope, publicKey: a.publicKey };
    },
    creationAgain: async (input) => {
      const a = await ask({ ask: 'creation-again', ...input });
      return { account: a.account, deploy: a.deploy, insert: a.insert };
    },
    payKeyStanding: async (input) => (await ask({ ask: 'pay-key-standing', ...input })).standing,
    secretIsTheVaults: async (input) => (await ask({ ask: 'secret-is-the-vaults', ...input })).matches,
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
    anchor: async (input) => ({ tx: (await ask({ ask: 'anchor', ...input })).tx }),
    recoverAnchor: async (input) => {
      const a = await ask({ ask: 'recover-anchor', ...input });
      return { tx: a.tx, placement: a.placement };
    },
    accountCallChain: async (input) => (await ask({ ask: 'account-call-chain', ...input })).chain,
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
    startStanding: async (input) => {
      const a = await ask({ ask: 'start-standing', ...input });
      return { standing: a.standing, ...(a.run === undefined ? {} : { run: a.run }) };
    },
    setNonceSecret: async (input) => ({ tx: (await ask({ ask: 'set-nonce-secret', ...input })).tx }),
    writeSecretCopy: async (input) => ({ tx: (await ask({ ask: 'write-secret-copy', ...input })).tx }),
  };
}
