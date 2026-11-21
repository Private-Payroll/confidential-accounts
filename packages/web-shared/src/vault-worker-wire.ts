/**
 * **WHAT CROSSES BETWEEN THE PAGE AND THE VAULT WORKER**: every ask the page can
 * send, every answer the worker sends back, and the shapes they carry, each state
 * and key as base64 of its bytes. Types only; the page's side of the worker that
 * sends and matches them is `vaultBuilderOver`.
 */
import type { Committee } from '../../../src/midnight/vault-committee.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import type { PrivatePaymentOnTheWire, PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import type { PaymentsFitAnswer } from '../../../src/midnight/vault-notes.js';
import type { EventOnTheWire, NoteOnTheWire, PaymentConfirmation, TransactionRead } from './vault-builder.js';
import type { SecretRunOnTheWire } from './vault-secret-built.js';
import type { OwnChainCopy } from '../../../src/midnight/sealed-secret-copy.js';
import type { VaultCallOnChain } from '../../../src/midnight/note-index.js';
import type { StartStandingOnTheWire } from './vault-worker-start.js';
import type { StepOnTheWire, VaultRebuildAsked, VaultRebuilt } from './vault-rebuild-wire.js';
import type { SuperAdminAnswer, SuperAdminAsk } from './super-admin-asks.js';
import type { ForgetUnshieldedAsk, RetireAsk } from './vault-retire-built.js';

export type { SecretRunOnTheWire } from './vault-secret-built.js';
export type { StartStandingOnTheWire };
export type { VaultRebuildAsked, VaultRebuilt } from './vault-rebuild-wire.js';

import type {
  AnchorPlacement, AnchorsOnChain, GovernedCallOrder, HeadStepAsked, OpenedRound, ProposalIdentity, RoundChangeOnTheWire, RoundOnChain, SignerMaterial, SpendingPolicyKeys, VouchedRunOnTheWire,
} from './governed-call-builder.js';
import type { PolicyOpeningOnTheWire } from '../../../src/midnight/spending-policy-record.js';
import type { BatchHolders } from '../../../src/midnight/record-manifest.js';
import type { AddressClaimFor, UnshieldedAddressClaim } from 'midnight-identity/profile/address-claim';
import type { PeriodTotalAskOnTheWire, RunChargeStanding, RunToChargeOnTheWire, RunTreeOnTheWire } from './run-charge-builder.js';


/** An invitee's call taking an invited seat, as a wallet asks its worker for it: the chain's state as base64. */
export interface InvitedSeatOnTheWire {
  readonly account: string;
  readonly proposal: string;
  readonly material: { readonly signingSecret: string; readonly blinding: string; readonly scope: string };
  readonly invite: { readonly coinSecretKey: string; readonly addressSalt: string };
  readonly proposalSalt: string;
  readonly intoVacatedSlot: boolean;
  /** The threshold the invitation sets once the seat is taken, as digits; "0" keeps the one in force. */
  readonly newThreshold: string;
  readonly chain: { readonly accountState: string; readonly parameters: string };
}

export type { AccountCallChainOnTheWire, PayoutChainOnTheWire } from './one-block-read.js';
import type { AccountCallChainOnTheWire, PayoutChainOnTheWire } from './one-block-read.js';
export interface SigningKeyOnTheWire { readonly tag: string; readonly value: string }
export interface CoinOnTheWire { readonly nonce: string; readonly token: string; readonly value: string }
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
/** Whether the chain holds an account, the newest block's time (ms) as the indexer names it, and the newest time to live (ms) of the transactions asked about, or null when one could not be read. */
export interface AccountPresenceOnTheWire { held: boolean; blockHeight: number; blockTime: number; ttl: number | null }


export type VaultAsk =
  | { id: number; network: string; ask: 'deploy'; account: string }
  /*
   * **A COMPANY'S ACCOUNT, HELD BY ITS FOUNDING SIGNER'S OWN COMMITTEE KEY FROM
   * ITS FIRST TRANSACTION**, and then the second step that finishes it, signed
   * by that key in the founding signer's wallet. Nothing secret crosses: a
   * seat, a label, a public key and a signature.
   */
  | { id: number; network: string; ask: 'account-deploy'; foundingLeaf: string; label: string; foundingKey: SigningKeyOnTheWire; clockOffsetMs?: number }
  | { id: number; network: string; ask: 'finished-creation'; account: string; signature: SigningKeyOnTheWire; clockOffsetMs?: number }
  /*
   * **A VAULT HELD BY THE COMPANY'S COMMITTEE FROM ITS FIRST TRANSACTION**, and
   * the reading of a vault's deploy, as sent, before it is adopted: held by
   * exactly that committee, this build's circuits, nothing written.
   */
  | { id: number; network: string; ask: 'born-held-vault'; account: string; holders: Committee }
  | { id: number; network: string; ask: 'vault-as-deployed'; vault: string; account: string; holders: Committee; again?: boolean; indexer: { indexerUri: string; indexerWsUri: string } }
  | { id: number; network: string; ask: 'handover'; vault: string; counter: string; temporaryKey: SigningKeyOnTheWire; to: Committee }
  | { id: number; network: string; ask: 'deposit'; vault: string; coin: CoinOnTheWire; state: string; parameters: string }
  | { id: number; network: string; ask: 'public-deposit'; vault: string; token: string; amount: string; state: string; parameters: string }
  | { id: number; network: string; ask: 'commitments'; vault: string; coin: CoinOnTheWire }
  | { id: number; network: string; ask: 'step-kept'; vault: string; secret: string; step: StepOnTheWire }
  | ({ id: number; network: string; ask: 'vault-rebuilt' } & VaultRebuildAsked)
  | { id: number; network: string; ask: 'vault-on-chain'; vault: string; account?: string; indexer: { indexerUri: string; indexerWsUri: string } }
  /* Many vaults read together: their states, and the account's, in one request for each 256. */
  | { id: number; network: string; ask: 'vaults-on-chain'; vaults: string[]; account?: string; indexer: { indexerUri: string; indexerWsUri: string } }
  /* What a step out of the vault is built on, and the events it is judged by, read here at the indexer the wallet names. */
  | { id: number; network: string; ask: 'chain-at-one-block'; vault: string; account: string; indexer: { indexerUri: string; indexerWsUri: string } }
  | { id: number; network: string; ask: 'events-of'; transactionHash: string; indexer: { indexerUri: string; indexerWsUri: string } }
  | { id: number; network: string; ask: 'created-by'; vault: string; commitment: string; indexer: { indexerUri: string; indexerWsUri: string } }
  | { id: number; network: string; ask: 'vault-call-on-chain'; vault: string; entryPoints: string[]; transaction: string; indexer: { indexerUri: string; indexerWsUri: string } }
  | { id: number; network: string; ask: 'transaction-read'; transaction: string }
  | { id: number; network: string; ask: 'own-seat'; material: SignerMaterial }
  | { id: number; network: string; ask: 'warm-proving' }
  /* A company's deploy and its signed second step, carried in fresh transactions: the same account, the same signature. */
  | { id: number; network: string; ask: 'creation-again'; deploy: string; insert: string; clockOffsetMs?: number }
  | { id: number; network: string; ask: 'secret-is-the-vaults'; vault: string; state: string; secret: string }
  | { id: number; network: string; ask: 'own-chain-copy'; vault: string; state: string; reader: string; of: 'commitment' | 'copies-written' }
  | { id: number; network: string; ask: 'secret-set-at'; vault: string; account: string; commitment: string; indexer: { indexerUri: string; indexerWsUri: string } }
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
   * **A VAULT'S START, OR A SECRET RUN REPLACING ITS SECRET.** The secret, when
   * given, is the one the page opened from the company's filed record or from its
   * own sealed copy in the run's record, handed to the worker on the same device
   * so the run is made with the contracts' own functions over `previous`, the
   * commitment it replaces; `earlier` are the secrets the device holds for the
   * vault, among which the worker finds the one a replacement carries. It keeps
   * none of them.
   */
  | {
    id: number; network: string; ask: 'start-standing'; vault: string; account: string;
    accountState: string; vaultState: string; secret?: string; readers?: readonly string[]; now: string;
    window?: { opensAt: string; closesAt: string }; seat?: string; previous?: string; earlier?: readonly string[]; again?: string;
  }
  | {
    id: number; network: string; ask: 'set-nonce-secret'; vault: string; account: string; run: SecretRunOnTheWire;
    secret: string; earlier?: string; proposal: string; opensAt: string; closesAt: string; chain: PayoutChainOnTheWire;
  }
  | RetireAsk | ForgetUnshieldedAsk
  | {
    id: number; network: string; ask: 'write-secret-copy'; vault: string; run: SecretRunOnTheWire; place: number;
    state: string; parameters: string;
  }
  | {
    id: number; network: string; ask: 'payout-publicly'; vault: string; account: string; order: OrderOnTheWire;
    payment: PrivatePaymentOnTheWire; chain: PayoutChainOnTheWire;
  }
  /*
   * A proposal's identity, made in the worker by the account's own functions from the change and its salt: a change of
   * seats, thresholds, policies or a vault retired, a vault adopted, or the pay-record key committed.
   */
  | {
    id: number; network: string; ask: 'proposal-identity'; change: RoundChangeOnTheWire; salt: string;
  }
  | {
    id: number; network: string; ask: 'vouched-run-identity'; run: VouchedRunOnTheWire;
  }
  | { id: number; network: string; ask: 'company-wide' }
  | { id: number; network: string; ask: 'policy-bar-key' }
  /*
   * **A WALLET'S SIGNED CLAIM OF AN UNSHIELDED ADDRESS, CHECKED WITH THE
   * LEDGER** (`signedClaimRefusal`), for a page whose own code loads none.
   */
  | { id: number; network: string; ask: 'address-claim-refusal'; claim: UnshieldedAddressClaim; for: AddressClaimFor }
  /*
   * **A ONE-OFF PAYMENT'S RECORD, OPENED** with the company's key at its epoch (`openOneOff`), for a page whose own
   * code loads no address decoder: opening it decodes the payee's address. The answer carries its payment leaf, built
   * here from the record's secrets, and none of the secrets.
   */
  | { id: number; network: string; ask: 'one-off-opened'; rec: SealedCompanyRecord; key: string }
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
  | { id: number; network: string; ask: 'rounds-on-chain'; account: string; indexer: { indexerUri: string; indexerWsUri: string }; chainIds: readonly string[]; seat?: string }
  /* Which of the leaves asked about the account records paid, read in the worker from its history's latest state at the indexer the wallet names. */
  | { id: number; network: string; ask: 'paid-leaves'; account: string; indexer: { indexerUri: string; indexerWsUri: string }; leaves: readonly string[] }
  /* Every run open now that a removal has outrun, read in the worker from the account's history at the indexer the wallet names. */
  | { id: number; network: string; ask: 'runs-outrun'; account: string; indexer: { indexerUri: string; indexerWsUri: string } }
  | { id: number; network: string; ask: 'seat-invited' } & Omit<InvitedSeatOnTheWire, never>
  | { id: number; network: string; ask: 'invited-seats'; account: string; indexer: { indexerUri: string; indexerWsUri: string }; proposals: readonly string[] }
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
  | { id: number; network: string; ask: 'account-call-chain'; account: string; indexer: { indexerUri: string; indexerWsUri: string } }
  /* Whether the indexer the wallet names holds a contract at the account, the chain's newest block time with it, and the newest time to live of the kept transactions. */
  | { id: number; network: string; ask: 'account-presence'; account: string; indexer: { indexerUri: string; indexerWsUri: string }; transactions: string[] }
  /* A change of the super admins: the chain's reads and the ledger's part, asked of the worker so the ledger loads only there. */
  | SuperAdminAsk;

type Answered<A extends VaultAsk['ask'], T> = { id: number; ok: true; ask: A } & T;

/**
 * A one-off payment as the worker opens it, as much of it as a page reads: the vault it is paid from, its currency and the ledger token that currency is paid in (read off the
 * currency's own row, for the way the payee is paid), its amount (a whole number in decimal), who it pays, why, and the proposal it is raised over;
 * and its payment leaf, the one leaf of the tree its payment is made from, built in the worker from the record's own secrets as the wallet builds it to pay
 * (`oneOffBuiltHere`), so a page can ask the account whether it is paid. Null when the worker holds no vault details circuits to build it with. The secrets
 * themselves never leave the worker.
 */
export interface OneOffOnTheWire {
  readonly vault: string; readonly asset: string; readonly token: string; readonly amount: string; readonly reason: string;
  readonly payee: { readonly ref: string | null; readonly name: string | null; readonly address: string };
  readonly proposal: { readonly id: string; readonly chainId: string };
  readonly leaf: string | null;
}

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
  | Answered<'vaults-on-chain', { reads: Array<{ vault: string; read: VaultOnChainOnTheWire }> }>
  | Answered<'chain-at-one-block', { chain: PayoutChainOnTheWire | null }>
  | Answered<'events-of', { events: EventOnTheWire[] }>
  | Answered<'created-by', { found: { transactionHash: string; events: EventOnTheWire[] } | null }>
  | Answered<'vault-call-on-chain', { seen: VaultCallOnChain }>
  | Answered<'transaction-read', { read: TransactionRead | null }>
  | Answered<'own-seat', { seat: string }>
  | Answered<'warm-proving', unknown>
  | Answered<'creation-again', { account: string; deploy: string; insert: string }>
  | Answered<'secret-is-the-vaults', { matches: boolean }>
  | Answered<'own-chain-copy', { copy: OwnChainCopy }>
  | Answered<'secret-set-at', { removals: number }>
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
  | Answered<'paid-leaves', { paid: Record<string, boolean> }>
  | Answered<'runs-outrun', { runs: Record<string, number> }>
  | Answered<'invited-seats', { seats: Record<string, string | null> }>
  | Answered<'seat-invited', { tx: string }>
  | Answered<'anchor', { tx: string }>
  | Answered<'recover-anchor', { tx: string; placement: AnchorPlacement }>
  | Answered<'account-call-chain', { chain: AccountCallChainOnTheWire | null }>
  | Answered<'account-presence', { presence: AccountPresenceOnTheWire }>
  | Answered<'proposal-identity', { identity: ProposalIdentity }>
  | Answered<'vouched-run-identity', { chainId: string | null }>
  | Answered<'company-wide', { value: string }>
  | Answered<'spending-policy-keys', { keys: SpendingPolicyKeys }>
  | Answered<'policy-bar-key', { value: string }>
  | Answered<'address-claim-refusal', { refusal: string | null }>
  | Answered<'one-off-opened', { oneOff: OneOffOnTheWire }>
  | Answered<'start-standing', { standing: StartStandingOnTheWire; run?: SecretRunOnTheWire }>
  | Answered<'set-nonce-secret', { tx: string }>
  | Answered<'write-secret-copy', { tx: string }>
  | Answered<'retire', { tx: string }>
  | Answered<'forget-unshielded', { tx: string }>
  | SuperAdminAnswer
  | { id: number; ok: false; error: string; name?: string; kind?: string };

type Without<T> = T extends unknown ? Omit<T, 'id' | 'network'> : never;
export type VaultRequest = Without<VaultAsk>;

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
    /** The public tokens the vault lists, which its retire refuses on while any is listed; absent, with why, off a ledger of another shape. */
    readonly unshieldedTokens?: readonly string[];
    readonly unshieldedTokensWhy?: string;
    readonly circuits?: { readonly why: string; readonly circuit: string | null } | null;
    readonly accountCircuits?: { readonly why: string; readonly circuit: string | null } | null;
  };

