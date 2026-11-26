/**
 * **A COMPANY'S VAULTS, AS ITS SIGNERS' DEVICES CREATE, HAND OVER AND FUND
 * THEM.**
 *
 * Nothing a device sends here carries a secret: the device builds and proves a
 * vault's transactions; the depositor's own wallet puts in and signs for any
 * coin; this service reads what arrives, refuses anything that is not exactly
 * what the route is for, and pays only the network fee. It builds and signs no
 * transaction itself. What it answers about a vault's rules is read from the
 * chain each time it is asked.
 *
 *   GET  /api/accounts/:id/vault-keys                   the committee holding the account on the chain, and who can read the records
 *   GET  /api/accounts/:id/vaults                       the company's vaults, and who holds each on chain
 *   POST /api/accounts/:id/vaults                       a vault deployed held by the company's committee from its first transaction
 *   POST /api/accounts/:id/vaults/:vault/handover       that vault handed to the company's committee
 *   POST /api/accounts/:id/vaults/:vault/start/account  a step of its start on the account: the adoption round or the
 *                                                       first secret run approved, or the adoption carried out (each is
 *                                                       raised with its record, through the proposals route)
 *   POST /api/accounts/:id/vaults/:vault/start/secret   its first secret set under the approved run
 *   POST /api/accounts/:id/vaults/:vault/start/copy     one signer's sealed copy of that secret written
 *   GET  /api/accounts/:id/vaults/:vault/chain          what the chain holds for one vault
 *   POST /api/accounts/:id/vaults/:vault/deposit        a deposit the depositor's wallet has paid for
 *   POST /api/accounts/:id/vaults/:vault/public-deposit a public deposit the depositor's wallet has paid for
 *   GET  /api/accounts/:id/vaults/:vault/payout-state   the chain as one block saw it, for a payout to be built on
 *   GET  /api/accounts/:id/vaults/:vault/events/:tx     what one transaction created, for a note's place to be read
 *   GET  /api/accounts/:id/vaults/:vault/created/:out   which of the vault's transactions created one output
 *   POST /api/accounts/:id/vaults/:vault/payout         a private payment out of the vault
 *   POST /api/accounts/:id/fee                          only the network fee added to one call a device proved, handed back
 *                                                       finished for the company's own service or the person's wallet to submit
 *   POST /api/accounts/:id/fee/done                     the member handed that call is done with it, which frees their turn
 *   GET  /api/accounts/:id/authority                    who holds the account's and every vault's rules
 *   GET  /api/accounts/:id/call-state                   the account as one block saw it, for a raise or an approval to be built on
 *   GET  /api/accounts/:id/committee-change             the contracts not holding the committee the account holds on the chain
 *   POST /api/accounts/:id/committee-change/signatures  signatures on contracts' committee updates, kept
 *   GET  /api/accounts/:id/committee-change/signatures  every signature kept, handed back
 *   POST /api/accounts/:id/committee-change/send        one contract's update sent, on a device's request
 *
 * **WHO HOLDS A CONTRACT'S RULES STOPS NO MONEY.** Whether money goes into a
 * vault, and whether the fee on a payment out is paid, is
 * `refusalToPutMoneyIn`, which reads no committee: a vault is the company's by
 * the account it is pinned to and by this service's record of its creation.
 * What these routes cannot stop: anybody paying their own fee can call a
 * vault's deposit directly.
 *
 * **FOR A CHANGE OF WHO HOLDS THE CONTRACTS THIS SERVICE IS A STORE AND A
 * RELAY.** It keeps and hands back each contract's signatures, checking only
 * their shape, that each verifies under the committee holding that contract
 * on the chain, and the counter the chain holds; it keeps anything only when a
 * signature given counts, and each place on a committee signs for one change
 * at a time; it sends an update only when a device asks, and pays the fee only
 * once the signatures that verify reach that committee's threshold on the
 * chain. Its four routes admit a member, or a super admin with no seat whose
 * request its committee key signed (`superAdminOrMember`). It holds no copy of
 * who the super admins are and has no committee of its own: the only committee
 * it reads is the one holding the company's account on the chain.
 */
import express from 'express';
import type { Hex } from '../core/crypto.js';
import type { SealedAccount, CompanyVault, AccountDeploy } from '../core/types.js';
import type { CompanyVaultKeyIndex } from '../core/vault-keys.js';
import type { Ledger } from '../core/ledger.js';
import type { AuthorityRead } from '../midnight/ledger.js';
import type { Committee } from '../midnight/vault-committee.js';
import type { PlaceSignature } from '../midnight/company-authority.js';
import type { CollectedCommitteeSignatures } from '../core/store.js';
import type { SuperAdminChangesStore } from './super-admin-changes-kept.js';
import type { VaultStartingLedger } from '../wiring/vault-submission.js';
import { companyVaultReads } from './company-vault-reads-and-sends.js';
import { vaultCreationAndDepositRoutes } from './vault-creation-and-deposit-routes.js';
import { vaultStartRoutes } from './vault-start-routes.js';
import { callStateRoutes } from './call-state-routes.js';
import { feeRoutes } from './fee-routes.js';
import { vaultPaymentOutRoutes } from './vault-payment-out-routes.js';
import { contractHoldersRoutes } from './contract-holders-routes.js';

export { VAULT_TX_LIMIT, vaultState, type AccountNotReady } from './company-vault-reads-and-sends.js';
export { HANDED_BACK_HELD_MS } from './fee-routes.js';

/** What these routes read about one vault from the chain. */
export interface VaultChain {
  /** The vault's contract state as the indexer serves it, or null when there is none. */
  contractState(vault: Hex): Promise<unknown | null>;
  /** The state's bytes, as a device reads them back. */
  serialize(state: unknown): Uint8Array;
  /** The vault's note commitments now, lower-case hex. */
  notesOf(state: unknown): readonly Hex[];
  /**
   * **EVERY VAULT THE COMPANY'S ACCOUNT LISTS ON THE CHAIN, ADOPTED OR
   * RETIRED**: the account's own record of which vaults are the company's.
   * Throws when the chain could not be asked. Absent where this deployment
   * reads no chain, and then no vault is taken as the company's.
   */
  accountVaults?(account: Hex): Promise<readonly string[]>;
  /**
   * **RETURNS ONLY WHEN THE STATE IS A LEDGER OF THE SHAPE THIS BUILD'S VAULT
   * HAS**, and refuses, saying how it differs, when it is not. A field is read
   * off a ledger by its position, so a vault of another shape answers the
   * question about its notes out of whichever field is in that place. Absent
   * where this deployment cannot tell, and then the notes are not vouched for.
   */
  ledgerIsThisBuilds?(state: unknown): Promise<void>;
  /** What the vault's ledger holds, read through the vault's own compiled ledger. */
  startingLedgerOf(state: unknown): VaultStartingLedger;
  /** Every output the chain has ever created for the vault. */
  everCreated(vault: Hex): Promise<ReadonlySet<string>>;
  /**
   * **ONE BLOCK'S VIEW OF EVERYTHING A PRIVATE PAYMENT IS BUILT ON**: the vault's
   * state, the chain's commitment tree and parameters as that block holds them,
   * and the account's state at the same block, which the vault's call reads.
   * Each value is its bytes. Absent where this deployment reads no chain.
   */
  payoutState?(vault: Hex, account: Hex): Promise<PayoutState | null>;
  /**
   * **ONE BLOCK'S VIEW OF THE COMPANY ACCOUNT, FOR A PROPOSAL TO BE RAISED OR
   * APPROVED ON**: the account's state and the ledger parameters as that block
   * holds them. Each value is its bytes. Absent where this deployment reads no
   * chain.
   */
  accountCallState?(account: Hex): Promise<AccountCallState | null>;
  /**
   * **WHAT ONE TRANSACTION CREATED**, as the chain's own events say: the only
   * place a note's position in the commitment tree is read from.
   */
  eventsOf?(transactionHash: Hex): Promise<readonly ServedEventOnTheWire[]>;
  /**
   * **THE TRANSACTION IN THIS VAULT'S OWN HISTORY WHOSE EVENTS CARRY AN OUTPUT
   * WITH THIS COMMITMENT, OWNED BY THIS VAULT**, with those events; `null` when
   * none does yet. For a note whose sender could not name its transaction.
   * Absent where this deployment reads no chain.
   */
  createdBy?(vault: Hex, commitment: string): Promise<{ transactionHash: Hex; events: readonly ServedEventOnTheWire[] } | null>;
}

/** The chain as one block saw it, for a private payment to be built on. Every value is the bytes, as base64. */
export interface PayoutState {
  readonly blockHash: string;
  readonly vaultState: string;
  readonly zswapState: string;
  readonly parameters: string;
  readonly accountState: string;
}

/** The company account as one block saw it, for a governed call to be built on. Base64 of the bytes. */
export interface AccountCallState {
  readonly blockHash: string;
  readonly accountState: string;
  readonly parameters: string;
}

/** One zswap event of one transaction, with its position as a decimal string. */
export interface ServedEventOnTheWire {
  readonly transactionHash: string;
  readonly details: { readonly tag: string; readonly commitment?: string; readonly contract?: string; readonly mtIndex?: string };
}

export interface CompanyVaultDeps {
  readonly signedIn: express.RequestHandler;
  readonly member: express.RequestHandler;
  readonly store: SuperAdminChangesStore & {
    getAccount(id: string): SealedAccount | null;
    putCompanyVault(v: CompanyVault): void;
    getCompanyVault(vault: string): CompanyVault | null;
    /** The company account's deploy as its founding signer's browser sent it, when it was created that way. */
    getAccountDeploy(accountId: string): AccountDeploy | null;
    listCompanyVaults(accountId: string): CompanyVault[];
    /** The company's records keys and filing keys with nobody's name on them, made from the sealed roster. */
    getVaultKeyIndex(accountId: string): CompanyVaultKeyIndex | null;
    /** The signatures one company keeps for one contract's committee updates, at the counter they were signed against. */
    getCommitteeSignatures(accountId: string, address: string): CollectedCommitteeSignatures | null;
    putCommitteeSignatures(c: CollectedCommitteeSignatures): void;
    /** Every contract's kept signatures for one company. */
    listCommitteeSignatures(accountId: string): CollectedCommitteeSignatures[];
  };
  /** The company's account contract address, its approval threshold, how many seats it holds and every vault's own, as the chain holds them. */
  readonly company: (accountId: string) => Promise<{
    address: Hex; threshold: number; seats: number; vaultThresholds: ReadonlyArray<{ vault: Hex; threshold: number }>;
  } | null>;
  readonly ledger: Pick<Ledger, 'sendVault' | 'feeAddedTo'>;
  /** The private registries this deployment's network lists: the only contracts besides the company's own whose call it pays a fee for. */
  readonly registries?: readonly string[];
  readonly chain: VaultChain;
  /** Every vault circuit's verifying key, as this build compiled it. */
  readonly verifierKeys: () => Promise<ReadonlyMap<string, Uint8Array>>;
  /** The company account's deployed circuits and their verifying keys, as this build compiled them. */
  readonly account: {
    readonly circuits: readonly string[];
    readonly verifierKeys: () => Promise<ReadonlyMap<string, Uint8Array>>;
    /** The public half of the temporary key this deployment once created accounts under, so a seat it holds is named as this service's. */
    readonly temporaryKey?: { tag: string; value: string };
  };
  readonly readers: { proven(bytes: Uint8Array): Promise<unknown>; finished(bytes: Uint8Array): Promise<unknown> };
  /**
   * Puts one contract's committee update together from the signatures its
   * committee's wallets made, counting only those that verify under the
   * committee holding it on the chain, and proves it once they reach that
   * committee's threshold. It takes no key. Absent where this deployment sends
   * nothing, and then a committee change is refused by name.
   */
  readonly committeeChange?: (input: {
    read: AuthorityRead; to: Committee; signatures: readonly PlaceSignature[]; label: string;
  }) => Promise<{
    have: number; required: number; indexesSigned: number[]; counted: readonly PlaceSignature[]; proven: Uint8Array | null;
  }>;
  readonly now?: () => Date;
}

export function companyVaultRoutes(deps: CompanyVaultDeps): express.Router {
  const r = express.Router();
  const reads = companyVaultReads(deps);
  vaultCreationAndDepositRoutes(r, reads);
  const { startStepMayGo } = vaultStartRoutes(r, reads);
  callStateRoutes(r, reads);
  feeRoutes(r, reads, startStepMayGo);
  vaultPaymentOutRoutes(r, reads);
  contractHoldersRoutes(r, reads);
  return r;
}
