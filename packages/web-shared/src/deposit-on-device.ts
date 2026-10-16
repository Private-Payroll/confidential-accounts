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
  assertNoSignerWouldLoseAccess, openPool, sealPool, SealedNotePool, type PoolSigner, type SealedPool, type SealedPoolStore,
} from '../../../src/midnight/vault-pool.js';
import type { Note } from '../../../src/midnight/vault-notes.js';
import { DepositJournalInStore } from '../../../src/midnight/vault-journal.js';
import {
  claimNewDepositCoin, type DepositCoin, type DepositMoney,
} from '../../../src/midnight/deposit-nonce.js';
import {
  currentDepositNonceKey, openNonceSecrets, recordsKeypairFrom, refileNonceSecret, startNonceSecret, startNonceSecretAgain,
  type NonceSecretReader,
} from '../../../src/midnight/company-nonce-secret.js';
import type { FiledPoolVersion, PassedOverVersion } from '../../../src/midnight/vault-pool.js';
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

/** A store that can also list every version as filed, without the check of who filed it. */
interface ListsAsFiled { versionsAsFiled(vault: string): Promise<readonly FiledPoolVersion[]> }

/** What became of the records' newest nonce secret against the vault's own commitment. */
type ChainsSecret =
  /** The newest version this device believes holds the secret the vault's commitment names. */
  | 'the-newest'
  /** A filed version holding the vault's secret was filed again, as the newest, under this device's own seat. */
  | 'filed-again'
  /** No filed version this device can open holds the secret the vault's commitment names. */
  | 'none-names-it';

/**
 * **THE CHAIN WINS: THE RECORDS' NEWEST NONCE SECRET IS MADE THE ONE THE
 * VAULT'S OWN COMMITMENT NAMES.** When the newest version this device
 * believes holds that secret, nothing is done. Otherwise every version is read
 * as filed, newest first, opened with this signer's own records key, and the
 * first whose secret the vault's commitment names is filed again as the newest
 * version, unchanged but for its version, signed by this device's own seat. A
 * version the chain does not vouch for is never filed again and nothing is
 * built from it.
 *
 * This is also how a version filed by a signer who has since left is read
 * again: its content is filed again only because the chain vouches for it.
 */
export async function fileTheChainsSecretAsTheNewest(input: {
  readonly vault: Hex;
  readonly me: DeviceSigner;
  readonly records: DeviceRecords;
  /** Whether `secret` is the one the vault's commitment names; never for a vault whose commitment is unset. */
  readonly secretIsTheVaults: (secret: Hex) => Promise<boolean> | boolean;
}): Promise<ChainsSecret> {
  const store = input.records('nonce-secret');
  const opener = recordsKeypairFrom(input.me.companyKey);
  const newestSecretOf = (rec: SealedPool): Hex | null => {
    try {
      const opened = openNonceSecrets(rec, input.vault, opener);
      return opened.secrets[opened.secrets.length - 1]! as Hex;
    } catch {
      return null;
    }
  };
  let believed: SealedPool | null = null;
  try {
    believed = await store.get(input.vault);
  } catch {
    believed = null;
  }
  if (believed !== null) {
    const s = newestSecretOf(believed);
    if (s !== null && await input.secretIsTheVaults(s)) return 'the-newest';
  }
  const lister = store as SealedPoolStore & Partial<ListsAsFiled>;
  const all = typeof lister.versionsAsFiled === 'function' ? await lister.versionsAsFiled(input.vault) : await store.versions(input.vault);
  if (all.length === 0) return 'none-names-it';
  const newestVersion = all[all.length - 1]!.version;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    /* A version the company's records passed over carries no bytes here. */
    const v: FiledPoolVersion | PassedOverVersion = all[i]!;
    if (v.neverEntered === true) continue;
    const s = newestSecretOf(v.sealed);
    if (s === null || !(await input.secretIsTheVaults(s))) continue;
    await store.put(input.vault, refileNonceSecret(v.sealed, input.vault, opener, newestVersion + 1));
    return 'filed-again';
  }
  return 'none-names-it';
}

/** What became of the vault's pool against the notes the chain holds for it. */
export interface PoolTheChainHolds {
  readonly answer:
    /** The pool this device believes agrees with the chain, and no version filed above it was passed over: nothing filed. */
    | 'the-newest'
    /** The pool was filed again as the newest, under this device's own seat, from what the chain vouches for. */
    | 'filed-again'
    /** The pool this device believes holds a note the chain does not, and no version passed over names anything to file. */
    | 'none-vouched';
  /** The journals filed again, each carrying forward every passed-over line the chain vouches for. */
  readonly journals: readonly ('payment-journal' | 'deposit-journal')[];
  /**
   * What this device could not take from a passed-over version, in words a person can act on: a version that is not a
   * pool, or a payment the chain shows landed whose change no version this device can take holds. Never empty when a
   * landed payment's change is missing from what was filed.
   */
  readonly said: readonly string[];
}

/** One step a payment journal line names, with every note it spends. */
type JournalStep = { readonly spent: Note; readonly further?: readonly Note[]; readonly step?: string; readonly amount: bigint };

const noteKey = (n: Pick<Note, 'nonce' | 'token' | 'value'>): string => `${n.nonce.toLowerCase()}:${n.token.toLowerCase()}:${n.value}`;
const stepKey = (a: JournalStep): string => `${[a.spent, ...(a.further ?? [])].map(noteKey).join('+')}:${a.step === 'merge' ? 'merge' : 'pays'}:${a.amount}`;

/**
 * **THE CHAIN WINS: THE VAULT'S POOL AND JOURNALS, FILED AGAIN UNDER THIS
 * DEVICE'S OWN SEAT FROM WHAT THE CHAIN VOUCHES FOR, OVER EVERY VERSION A
 * DEVICE PASSES OVER.** A seat that leaves may have carried out a payment
 * after its removal was raised, so a version it filed then - past the boundary
 * its leaving keeps - holds the payment's change and its journal line, and no
 * device believes it. No pool or journal write is built on top of such a
 * version (`passedOverAbove`); this is what lets the next one be made.
 *
 * - **The pool**, when the pool this device believes holds a note the chain no
 *   longer holds or a version filed above it was passed over: every note the
 *   chain holds, from the pool believed and from every passed-over version
 *   (wherever it sits) this signer's own key opens. A version naming a note
 *   twice is not a pool, and nothing is taken from it. Where `changeOf` is
 *   given, the change a passed-over payment line keeps, worked out with the
 *   vault's own functions, is taken when the chain holds it. A payment the
 *   chain shows landed - every note it spent gone - whose change none of these
 *   holds is said, never passed by. Filed as the next version.
 * - **Each journal**, when a version filed above the one believed was passed
 *   over: the lines believed, and every passed-over line the chain vouches for
 *   - a payment whose notes are all gone from the chain, a deposit whose coin
 *   it holds. A line the chain does not vouch for is not believed or carried.
 *
 * Nothing the chain does not hold is filed, and nothing is built on a version
 * no device believes except what the chain itself vouches for.
 */
export async function fileThePoolTheChainHolds(input: {
  readonly vault: Hex;
  readonly me: Pick<DeviceSigner, 'signerId' | 'wrappingSecret'>;
  readonly records: DeviceRecords;
  /** Everybody who must be able to open what this files: the pool's signers. */
  readonly signers: () => Promise<readonly PoolSigner[]>;
  /** Whether the chain holds the vault's commitment to `note`, as this device's vault worker reads it. */
  readonly held: (note: Note) => Promise<boolean>;
  /** The coin a payment line keeps as change, worked out with the vault's own functions and secret; null for none. */
  readonly changeOf?: (step: JournalStep) => Promise<Note | null>;
}): Promise<PoolTheChainHolds> {
  const said: string[] = [];
  const journals: ('payment-journal' | 'deposit-journal')[] = [];
  const opened = (rec: SealedPool, record: 'pool' | 'payment-journal' | 'deposit-journal', store: SealedPoolStore): Record<string, unknown> | null => {
    try {
      return openPool(rec, input.me.signerId, input.me.wrappingSecret, {
        record, unlabelled: store.unlabelledRecordsFiled === true ? 'accept' : 'refuse',
      }) as unknown as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  /** The version of `record` this device believes, and whether a version filed above it was passed over: one read. */
  const believedOf = async (record: 'pool' | 'payment-journal' | 'deposit-journal') => {
    const store = input.records(record);
    const believed = await store.get(input.vault);
    const filed = store.filedPast?.(input.vault);
    return { store, believed, above: filed !== undefined && filed > (believed?.version ?? 0) };
  };
  /** Every version of a record a device passes over, wherever it sits, with its bytes as filed, and the newest version filed. */
  const passedOverIn = async (store: SealedPoolStore) => {
    const judged = await store.versions(input.vault);
    const passed = new Set(judged.filter((v) => v.neverEntered === true).map((v) => v.version));
    const lister = store as SealedPoolStore & Partial<ListsAsFiled>;
    const asFiled = passed.size === 0 || typeof lister.versionsAsFiled !== 'function' ? [] : await lister.versionsAsFiled(input.vault);
    return { passed: asFiled.filter((v) => passed.has(v.version)), newest: judged.length === 0 ? 0 : judged[judged.length - 1]!.version };
  };
  const heldAll = async (notes: readonly Note[]): Promise<boolean> => {
    for (const n of notes) if (!(await input.held(n))) return false;
    return true;
  };
  const goneAll = async (notes: readonly Note[]): Promise<boolean> => {
    for (const n of notes) if (await input.held(n)) return false;
    return true;
  };
  const refile = async (store: SealedPoolStore, believed: SealedPool | null, page: Record<string, unknown>, version: number,
    record: 'pool' | 'payment-journal' | 'deposit-journal'): Promise<void> => {
    const to = await input.signers();
    if (believed !== null) assertNoSignerWouldLoseAccess(believed.wrapped.map((w) => w.signerId), to.map((x) => x.id));
    await store.put(input.vault, sealPool(input.vault, page as never, to, version, record));
  };

  /* The payment lines passed over that the chain shows landed - every note each spent is gone - read once, when asked. */
  let landedLines: JournalStep[] | undefined;
  const landed = async (): Promise<JournalStep[]> => {
    if (landedLines !== undefined) return landedLines;
    const out: JournalStep[] = [];
    try {
      const store = input.records('payment-journal');
      for (const v of (await passedOverIn(store)).passed) {
        const lines = opened(v.sealed, 'payment-journal', store)?.attempts;
        if (!Array.isArray(lines)) continue;
        for (const line of lines as JournalStep[]) {
          if (await goneAll([line.spent, ...(line.further ?? [])]) && !out.some((l) => stepKey(l) === stepKey(line))) out.push(line);
        }
      }
    } catch {
      /* A journal this device cannot list names no payment here; every change found is still checked against the chain. */
    }
    landedLines = out;
    return out;
  };
  /*
   * Each journal with a version passed over above the one believed is filed again; a journal this device cannot read
   * now is left as it is, and no line is appended to it until it is (`passedOverAbove`).
   */
  try {
    const payments = await believedOf('payment-journal');
    if (payments.above) {
      const believedLines = (payments.believed === null ? [] : opened(payments.believed, 'payment-journal', payments.store)?.attempts ?? []) as JournalStep[];
      const carried = [...believedLines, ...(await landed()).filter((l) => !believedLines.some((b) => stepKey(b) === stepKey(l)))];
      await refile(payments.store, payments.believed, { attempts: carried }, (await passedOverIn(payments.store)).newest + 1, 'payment-journal');
      journals.push('payment-journal');
    }
  } catch { /* said to whoever appends next, by the refusal itself */ }
  try {
    const deposits = await believedOf('deposit-journal');
    if (deposits.above) {
      const believedCoins = (deposits.believed === null ? [] : opened(deposits.believed, 'deposit-journal', deposits.store)?.notes ?? []) as Note[];
      const carried = [...believedCoins];
      const { passed, newest } = await passedOverIn(deposits.store);
      for (const v of passed) {
        const coins = opened(v.sealed, 'deposit-journal', deposits.store)?.notes;
        if (!Array.isArray(coins)) continue;
        for (const c of coins as Note[]) {
          if (!carried.some((b) => noteKey(b) === noteKey(c)) && await input.held(c)) carried.push(c);
        }
      }
      await refile(deposits.store, deposits.believed, { notes: carried }, newest + 1, 'deposit-journal');
      journals.push('deposit-journal');
    }
  } catch { /* said to whoever appends next, by the refusal itself */ }

  const believedPool = await believedOf('pool');
  const believedNotes = (believedPool.believed === null ? [] : opened(believedPool.believed, 'pool', believedPool.store)?.notes ?? []) as Note[];
  const contradicted = !(await heldAll(believedNotes));
  if (!contradicted && !believedPool.above) return { answer: 'the-newest', journals, said };
  const pool = { ...believedPool, ...(await passedOverIn(believedPool.store)) };
  if (pool.passed.length === 0) return { answer: contradicted ? 'none-vouched' : 'the-newest', journals, said };
  const taken = new Map<string, Note>();
  for (const n of believedNotes) if (await input.held(n)) taken.set(noteKey(n), n);
  for (const v of pool.passed) {
    const notes = opened(v.sealed, 'pool', pool.store)?.notes;
    if (!Array.isArray(notes)) {
      said.push(`version ${v.version} of this vault's pool, filed by a seat past the boundary its leaving keeps, does not open `
        + 'with this signer\'s key, so none of its notes is taken');
      continue;
    }
    if (new Set((notes as Note[]).map((n) => n.nonce.toLowerCase())).size !== notes.length) {
      said.push(`version ${v.version} of this vault's pool, filed by a seat past the boundary its leaving keeps, names a note `
        + 'more than once, so it is not a pool and none of its notes is taken');
      continue;
    }
    for (const n of notes as Note[]) if (!taken.has(noteKey(n)) && await input.held(n)) taken.set(noteKey(n), n);
  }
  /* Each landed payment's change: from the line, where the chain holds it; said where nothing taken holds it. */
  for (const line of await landed()) {
    const spentValue = [line.spent, ...(line.further ?? [])].reduce((a, n) => a + n.value, 0n);
    const keeps = spentValue - (line.step === 'merge' ? 0n : line.amount);
    if (keeps <= 0n) continue;
    const change = input.changeOf === undefined ? null : await input.changeOf(line);
    if (change !== null && !taken.has(noteKey(change)) && await input.held(change)) {
      taken.set(noteKey(change), change);
      said.push(`a payment a seat that left carried out after its removal was raised kept ${keeps} as change, and no pool it `
        + 'filed holds that change; the chain holds it, so it is taken from the payment journal\'s line');
      continue;
    }
    if (![...taken.values()].some((n) => n.token.toLowerCase() === line.spent.token.toLowerCase() && n.value === keeps)) {
      said.push(`a payment a seat that left carried out after its removal was raised landed - every note it spent is gone from the `
        + `chain - and kept ${keeps} as change, which no pool this device can take holds. The chain holds that change: a `
        + 'rebuild of the vault from its journals and the chain names it');
    }
  }
  await refile(pool.store, pool.believed, { notes: [...taken.values()] }, pool.newest + 1, 'pool');
  return { answer: 'filed-again', journals, said };
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
