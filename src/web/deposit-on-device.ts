/**
 * **A PRIVATE DEPOSIT'S COIN IS CHOSEN ON THE SIGNER'S OWN DEVICE, AND WHAT
 * LEAVES THE DEVICE IS SEALED.**
 *
 * A deposit's nonce is derived from the vault's nonce secret. Whoever learns
 * the nonce and sees the chain can confirm a guessed amount, so the nonce, the
 * secret and the amount are worked out and used here, and the only things
 * this sends to the product's server are sealed records it cannot open:
 *
 *   1. the signer's records key is derived from the key their wallet released
 *      for this company (`recordsKeypairFrom`);
 *   2. the vault's nonce secret is read from the server as sealed versions and
 *      opened here;
 *   3. the deposit journal line is sealed here and filed signed;
 *   4. the coin is checked against the vault's history, its notes and its pool;
 *   5. the coin is handed back, and the caller (`depositIntoCompanyVault` in
 *      `vault-operation.ts`) has the vault worker build and prove the deposit
 *      with it, using the ledger parameters the chain holds now. What this
 *      settles is that the coin is chosen where the key is, and nothing the
 *      server receives names it.
 *
 * Starting a vault's nonce secret is done here as well: the secret is made on
 * the device and filed only as a sealed record wrapped to the signers, and
 * only for a vault the chain has made nothing for.
 */
import type { Hex } from '../core/crypto.js';
import {
  SealedNotePool, type PoolSigner, type SealedPoolStore,
} from '../midnight/vault-pool.js';
import { DepositJournalInStore } from '../midnight/vault-journal.js';
import {
  claimNewDepositCoin, type DepositCoin, type DepositMoney,
} from '../midnight/deposit-nonce.js';
import {
  currentDepositNonceKey, openNonceSecrets, recordsKeypairFrom, startNonceSecret,
  type NonceSecretReader,
} from '../midnight/company-nonce-secret.js';
import type { WireRecord } from '../midnight/sealed-record-wire.js';

/** The signer this device acts for, with what their device holds. */
export interface DeviceSigner {
  /** Their seat's id, which their copies of the pool's key are filed under. */
  readonly signerId: string;
  /** The secret their copies of the pool and journals are wrapped to. */
  readonly wrappingSecret: Hex;
  /** The key their wallet released for the vault's company. */
  readonly companyKey: Uint8Array;
}

/** Where this device reads and files a vault's records: the product's server, sealed. */
export type DeviceRecords = (record: WireRecord) => SealedPoolStore;

/** What the chain says about the vault, read on this device before a deposit. */
export interface VaultAsRead {
  /** The ledger's commitment of every coin the chain has ever created for the vault. */
  readonly everCreated: ReadonlySet<string>;
  /** The ledger's commitment of a coin owned by the vault. */
  readonly outputCommitmentOf: (coin: DepositCoin) => Promise<string> | string;
  /** Whether the vault holds this coin now. */
  readonly heldNow: (coin: DepositCoin) => Promise<boolean> | boolean;
}

/** The public half of this signer's records key, which is what other signers wrap the vault's nonce secret to. */
export const recordsReaderOf = (companyKey: Uint8Array): NonceSecretReader =>
  ({ publicKey: recordsKeypairFrom(companyKey).publicKey });

/**
 * **STARTS A VAULT'S NONCE SECRET**, made here and filed only sealed, wrapped
 * to every signer given (this one included).
 */
export async function startVaultNonceSecretOnThisDevice(
  vault: Hex, me: DeviceSigner, others: readonly NonceSecretReader[], records: DeviceRecords,
  /** Every coin the chain has ever created for the vault, as read now. */
  everCreated: ReadonlySet<string>,
): Promise<void> {
  const store = records('nonce-secret');
  if (await store.get(vault)) {
    throw new Error(
      'this vault already has a nonce secret. Starting another would make deposits nobody else can name. '
      + 'Nothing is written.');
  }
  if (everCreated.size > 0) {
    /*
     * **A VAULT WITH MONEY IN IT AND NO SECRET HAS LOST ITS SECRET**, or was
     * funded some other way. Starting a new one here would leave every earlier
     * deposit named by nothing, and it would look like a first start.
     */
    throw new Error(
      'the chain has already made coins for this vault, and no nonce secret is filed for it. That is a '
      + 'record that has been lost, or a vault funded before its deposits were derived from a nonce secret, '
      + 'not a new vault. Nothing is written. If the company keeps a copy of the vault\x27s nonce secret, '
      + 'file that copy again. A vault funded before nonce secrets existed has none, and cannot take a '
      + 'private deposit from this device: deposit into a new vault instead.');
  }
  await store.put(vault, startNonceSecret(vault, [recordsReaderOf(me.companyKey), ...others]));
}

/**
 * **CHOOSES A PRIVATE DEPOSIT'S COIN ON THIS DEVICE**, files its journal line
 * sealed and signed, and returns the coin for this device to build the
 * deposit's transaction with.
 */
export async function depositCoinOnThisDevice(input: {
  readonly vault: Hex;
  readonly money: DepositMoney;
  readonly me: DeviceSigner;
  /** Everybody the pool and the journals are wrapped to. */
  readonly signers: () => Promise<readonly PoolSigner[]>;
  readonly records: DeviceRecords;
  readonly chain: VaultAsRead;
}): Promise<{ readonly coin: DepositCoin; readonly slot: number; readonly epoch: number }> {
  const { vault, me } = input;
  const opener = recordsKeypairFrom(me.companyKey);
  /*
   * **THE NEWEST VERSION, AND ONLY THE NEWEST.** A deposit is made under the
   * epoch deposits are made under now. A signer with no copy in the newest
   * version has left, and a secret they can still open is one they took with
   * them: a deposit under it is one they could go on confirming.
   */
  const newest = await input.records('nonce-secret').get(vault);
  if (newest === null) {
    throw new Error(
      'this vault has no nonce secret yet, so a private deposit would be one the company could not name '
      + 'again. Nothing is filed or deposited. Start the vault\x27s nonce secret first.');
  }
  const secrets = openNonceSecrets(newest, vault, opener);
  const journal = new DepositJournalInStore(
    input.records('deposit-journal'), vault, { id: me.signerId, wrappingSecret: me.wrappingSecret },
    input.signers, currentDepositNonceKey(secrets));
  const pool = new SealedNotePool(
    input.records('pool'), { signerId: me.signerId, wrappingSecret: me.wrappingSecret }, input.signers);
  const { coin, slot } = await claimNewDepositCoin({
    vault,
    money: input.money,
    journal,
    everCreated: input.chain.everCreated,
    outputCommitmentOf: input.chain.outputCommitmentOf,
    heldNow: input.chain.heldNow,
    poolHoldsTheNonce: async (nonce) => (await pool.load(vault)).notes.some((n) => n.nonce === nonce),
  });
  return { coin, slot, epoch: secrets.epoch };
}
