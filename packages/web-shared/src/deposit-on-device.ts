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
 * only for a vault the chain has made nothing for. The record filed is handed
 * back, so the device that made the secret builds on the secret it made and
 * never on one read back.
 *
 * **A SECRET READ BACK IS CHECKED AGAINST THE VAULT BEFORE A COIN IS CHOSEN
 * UNDER IT.** The server keeps the records, and whoever holds the company's
 * viewing key can file a record wrapped to every signer around a secret of its
 * own. The vault holds a commitment to its secret on the chain, so a deposit
 * is refused unless the secret opened here is the one that commitment names.
 */
import type { Hex } from '../../../src/core/crypto.js';
import {
  SealedNotePool, type PoolSigner, type SealedPool, type SealedPoolStore,
} from '../../../src/midnight/vault-pool.js';
import { DepositJournalInStore } from '../../../src/midnight/vault-journal.js';
import {
  claimNewDepositCoin, type DepositCoin, type DepositMoney,
} from '../../../src/midnight/deposit-nonce.js';
import {
  currentDepositNonceKey, openNonceSecrets, recordsKeypairFrom, startNonceSecret, startNonceSecretAgain,
  type NonceSecretReader,
} from '../../../src/midnight/company-nonce-secret.js';
import type { WireRecord } from '../../../src/midnight/sealed-record-wire.js';

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
  /**
   * Whether `secret` is the one the vault's commitment on the chain names, in
   * the same state the deposit is built against.
   */
  readonly secretIsTheVaults: (secret: Hex) => Promise<boolean> | boolean;
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
): Promise<SealedPool> {
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
  const made = startNonceSecret(vault, [recordsReaderOf(me.companyKey), ...others]);
  await store.put(vault, made);
  return made;
}

/**
 * **A FRESH FIRST SECRET IN PLACE OF ONE NOTHING VOUCHES FOR**, made here and
 * filed as the next version after `filed`, wrapped to every signer given (this
 * one included), and handed back. Only for a vault the chain has made nothing
 * for, whose first secret the chain has not taken and that no open secret run
 * commits to; the caller has read the chain and says so. Refused when the
 * newest version filed is no longer `filed`: somebody filed another since, and
 * the press is made again.
 */
export async function startVaultNonceSecretAgainOnThisDevice(
  vault: Hex, me: DeviceSigner, others: readonly NonceSecretReader[], records: DeviceRecords,
  everCreated: ReadonlySet<string>, filed: SealedPool,
): Promise<SealedPool> {
  if (everCreated.size > 0) {
    throw new Error(
      'the chain has already made coins for this vault, so its secret is not replaced. Nothing is written.');
  }
  const store = records('nonce-secret');
  const newest = await store.get(vault);
  if (newest === null || newest.version !== filed.version) {
    throw new Error('another secret was filed for this vault while this one was being checked. Nothing is written; try again.');
  }
  const made = startNonceSecretAgain(filed, vault, [recordsReaderOf(me.companyKey), ...others]);
  await store.put(vault, made);
  return made;
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
  if (!(await input.chain.secretIsTheVaults(secrets.secrets[secrets.secrets.length - 1]! as Hex))) {
    throw new Error(
      'the secret the company\x27s records hold for this vault is not the one the vault holds on the chain, so a '
      + 'deposit made under it could be traced by whoever made it. Nothing is filed or deposited; contact support.');
  }
  const journal = new DepositJournalInStore(
    input.records('deposit-journal'), vault, { id: me.signerId, wrappingSecret: me.wrappingSecret },
    input.signers, currentDepositNonceKey(secrets));
  const pool = new SealedNotePool(
    input.records('pool'), { signerId: me.signerId, wrappingSecret: me.wrappingSecret }, input.signers);
  const { coin, slot } = await claimNewDepositCoin({
    vault,
    money: input.money,
    journal,
    nonceAt: (m, s) => journal.nonceAt(vault, m, s),
    everCreated: input.chain.everCreated,
    outputCommitmentOf: input.chain.outputCommitmentOf,
    heldNow: input.chain.heldNow,
    poolHoldsTheNonce: async (nonce) => (await pool.load(vault)).notes.some((n) => n.nonce === nonce),
  });
  return { coin, slot, epoch: secrets.epoch };
}
