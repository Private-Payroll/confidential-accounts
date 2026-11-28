import { fromBase64Url, toBase64Url } from 'midnight-identity/passkey/bytes';
import { checkPlan, fingerprintOf, proveRecoverable } from 'midnight-identity/recovery/pieces';
import type { PieceSet } from 'midnight-identity/recovery/pieces';
import type { Secret } from 'midnight-identity/keys/derivation';
/* How a checkpoint's other tokens are written and read back.
 * `shielded-tokens.ts` imports nothing, so this is acyclic. */
import { otherTokensFromStored, otherTokensToStored } from '../chain/shielded-tokens.js';
import type { OtherTokens } from '../chain/shielded-tokens.js';
/* What a snapshot says about itself. `snapshot.ts` imports only the ledger, so this is acyclic. */
import { snapshotFacts } from '../chain/snapshot.js';
/* Which compartment a record is in. `wallets-held.ts` imports
 * nothing from this file, so this is acyclic, exactly as `subwallets.ts` is. */
import {
  checkpointKeyFor,
  forgetWallet,
  heldWallets,
  keyFor,
  allocateWalletId,
  RECORD_KINDS,
  openWallet,
  openWalletId,
  rememberWallet,
  sealKeyFor
} from './wallets-held.js';
/* Which compartment a secret's records are on. `record-shelf.ts` imports
 * nothing from this file, so this is acyclic. */
import { slotOf, slotToWrite } from './record-shelf.js';
/* How a record is judged. `record-checks.ts` imports nothing, so this is acyclic. */
import { StorageError, isNamed, isRealNumber } from './record-checks.js';

/* The error, and the records that moved to files of their own by job, read from here as before. */
export { StorageError } from './record-checks.js';
export type { StorageFailure } from './record-checks.js';
export { loadSubwallets, saveLastUsedWallet, saveSubwalletName } from './subwallet-record.js';
export type { SubwalletRecord } from './subwallet-record.js';
export {
  allPasskeys,
  forgetAllPasskeys,
  forgetPasskey,
  passkeyById,
  resetPasskeyRecordTo,
  savePasskey,
  walletOfCredential
} from './passkey-records.js';

/**
 * WHERE THIS BROWSER KEEPS THINGS — the standalone wallet's own implementation
 * of the ports in `ports.ts`. Nothing here is imported by the core.
 *
 * THE SECRET IS SEALED UNDER A KEY THE BROWSER WILL NOT HAND BACK.
 * §7.1. WebCrypto generates an AES-GCM key marked non-extractable, it is kept
 * in IndexedDB as a handle, and there is no API — for us or for anybody else's
 * script — that exports it.
 *
 * **WHAT THAT DOES AND DOES NOT BUY, said plainly because it is easy to
 * overstate.** It means the ciphertext cannot be carried off this machine and
 * opened elsewhere: copying `localStorage` out gets you nothing. It does NOT
 * mean a script on this page cannot use the key — it can, while the page is
 * open — so an XSS on this origin, or somebody with the unlocked browser
 * profile, reads the secret without any ceremony. The passkey gates the
 * interface; this gates the bytes; **they are not connected.**
 *
 * A real product hardens this further. This is a test wallet, and it is honest
 * about which half of the problem it solves.
 */

const DB = 'midnight-identity';
const STORE = 'keys';

/**
 * **THE FIXED KEYS ARE GONE FROM THIS FILE.** Every record above used to
 * be a module constant, and that was the whole of "one wallet per browser":
 * a second wallet's keyring was written to the same string as the first's.
 * `wallets-held.ts` builds the key from the WALLET AND THE RECORD KIND, and
 * the compartment the original wallet is in still uses the very strings this
 * file used to hold — so nothing on any existing machine moves.
 */

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function idbGet(key: string): Promise<unknown> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await idb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function idbDelete(key: string): Promise<void> {
  const db = await idb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * The key that seals this browser's copy. Made once, never exported.
 *
 * GUARDED LIKE THE REST OF THE FILE — the third of three failures: a
 * browser with IndexedDB blocked or evicted (a Firefox private window, some
 * iOS and enterprise profiles) throws a `DOMException` out of `indexedDB.open`
 * itself, which is neither a damaged record nor a missing key, and used to
 * sail past the `instanceof` into the dead end that row is named for.
 */
async function sealingKey(walletId: string): Promise<CryptoKey> {
  let existing: unknown;
  try {
    existing = await idbGet(sealKeyFor(walletId));
  } catch {
    throw new StorageError(
      'sealed-copy-unopenable',
      'this browser is refusing access to the place the sealing key is kept — private ' +
        'windows and some managed profiles do this. Nothing can be sealed or opened ' +
        'here. Use a normal window, or recover from your pieces on another machine.'
    );
  }
  if (existing) return existing as CryptoKey;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, /* extractable: */ false, [
    'encrypt',
    'decrypt'
  ]);
  try {
    await idbPut(sealKeyFor(walletId), key);
  } catch {
    throw new StorageError(
      'sealed-copy-unopenable',
      'this browser is refusing to store the sealing key — private windows and some ' +
        'managed profiles do this. Nothing can be sealed here. Use a normal window.'
    );
  }
  return key;
}

/** Everything this browser knows about the person signed in here. */
export interface StoredAccount {
  readonly sealed: string;
  readonly iv: string;
  readonly createdAt: number;
}

/**
 * SEALS A SECRET INTO A COMPARTMENT OF ITS OWN, AND OPENS THAT COMPARTMENT.
 *
 * THIS IS WHERE "a second wallet destroys the first" STOPS BEING TRUE.
 * Which compartment, in order:
 *
 *   1. the one already holding THIS secret, if this browser has it — a wallet
 *      recovered or paired onto a machine that already holds it lands on
 *      itself, which replaces nothing;
 *   2. The compartment of a wallet that predates this change, IF the secret
 *      opens it. That is proved by unsealing it and comparing bytes, not
 *      assumed: it is the one case where this browser cannot know a wallet's
 *      fingerprint, and getting it wrong would put the same wallet in the list
 *      twice;
 *   3. otherwise a NEW compartment. Nothing that is here is read, moved or
 *      removed.
 *
 * **IT RETURNS THE SLOT AND IT OPENS IT, and the second half is not a
 * convenience.** Every landing goes on to write that wallet's other records —
 * its name, its arrival stamp, its passkey — and `finishRecovery` goes on to
 * REMOVE a passkey record. A landing that had to remember to switch afterwards
 * would do all of that to the wallet it just landed beside.
 */
export async function saveSecret(secret: Uint8Array): Promise<string> {
  const walletId = await slotForLanding(secret);
  const key = await sealingKey(walletId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, secret as BufferSource));
  const account: StoredAccount = {
    sealed: toBase64Url(sealed),
    iv: toBase64Url(iv),
    createdAt: Date.now()
  };
  localStorage.setItem(keyFor(walletId, 'keyring'), JSON.stringify(account));
  rememberWallet(walletId, toBase64Url(fingerprintOf(secret)), Date.now());
  openWallet(walletId);
  return walletId;
}

/** Step 2 of `saveSecret` above: does this secret open the wallet that
 * predates this change? Any failure — no such slot, no sealing key, a damaged
 * record — is a NO, which costs a duplicate row and never a lost wallet. */
async function opensUnidentifiedSlot(secret: Uint8Array, walletId: string): Promise<boolean> {
  try {
    const held = await loadSecret(walletId);
    if (held === null || held.length !== secret.length) return false;
    return held.every((byte, i) => byte === secret[i]);
  } catch {
    return false;
  }
}

async function slotForLanding(secret: Uint8Array): Promise<string> {
  const fingerprint = toBase64Url(fingerprintOf(secret));
  const held = heldWallets();
  const known = held.find((wallet) => wallet.fingerprint === fingerprint);
  if (known) return known.id;
  for (const wallet of held) {
    if (wallet.fingerprint !== null) continue;
    if (await opensUnidentifiedSlot(secret, wallet.id)) return wallet.id;
  }
  /* A COMPARTMENT WITH NO KEYRING IS A SHELF, NOT A WALLET — and this is the
   * `startFresh` case exactly. `passkey-no-account` means credentials with
   * nothing behind them: landing beside them would leave a row in the list
   * for a wallet that does not exist and can never be opened. So the new
   * wallet lands HERE, which is also what that door has always promised.
   * The landing order is unchanged: the stale records are replaced by the caller
   * AFTER this returns and the secret is down. */
  const open = openWalletId();
  if (localStorage.getItem(keyFor(open, 'keyring')) === null) return open;
  return allocateWalletId();
}

/**
 * The keyring record parsed, or a named refusal. Shared by `loadSecret` and
 * `readKeyringRecord`, so the phase machine and the unseal cannot disagree
 * about what counts as readable: "your wallet is here" must never be
 * decided by whether a string merely exists.
 */
function parseKeyring(raw: string): { iv: Uint8Array; sealed: Uint8Array } {
  /* The parse is guarded like everything else in this file: a
   * corrupted record used to throw a SyntaxError into a catch that was
   * matching a different sentence, and the person got a retry that could
   * never work instead of the screen for exactly this state. */
  try {
    const account = JSON.parse(raw) as StoredAccount;
    if (typeof account?.sealed !== 'string' || typeof account?.iv !== 'string') {
      throw new Error('not a keyring record');
    }
    return { iv: fromBase64Url(account.iv), sealed: fromBase64Url(account.sealed) };
  } catch {
    throw new StorageError(
      'record-damaged',
      'there is an account stored in this browser and its record is damaged — it cannot ' +
        'be read, let alone opened. Recover from your pieces, or start again.'
    );
  }
}

/**
 * What the keyring holds, WITHOUT opening it — for the phase machine, which
 * is synchronous and must not claim "your wallet is here, intact" over
 * unparseable text. The sealing key can only be checked by the async
 * open; `loadSecret` remains the authority on that.
 */
export function readKeyringRecord(
  walletId: string
):
  | { readonly state: 'absent' }
  | { readonly state: 'readable' }
  | { readonly state: 'damaged'; readonly error: StorageError } {
  const raw = localStorage.getItem(keyFor(walletId, 'keyring'));
  if (!raw) return { state: 'absent' };
  try {
    parseKeyring(raw);
    return { state: 'readable' };
  } catch (e) {
    if (e instanceof StorageError) return { state: 'damaged', error: e };
    throw e;
  }
}

export async function loadSecret(walletId: string): Promise<Uint8Array | null> {
  const raw = localStorage.getItem(keyFor(walletId, 'keyring'));
  if (!raw) return null;
  const { iv, sealed } = parseKeyring(raw);

  const key = await sealingKey(walletId);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, sealed as BufferSource);
    return new Uint8Array(plain);
  } catch {
    /* The sealing key is gone — a cleared profile, another browser. The
     * ciphertext is unopenable and saying so is better than looking empty. */
    throw new StorageError(
      'sealed-copy-unopenable',
      'there is an account stored in this browser and the key that opens it is gone. ' +
        'Recover from your pieces, or start again.'
    );
  }
}

export const hasAccount = (walletId: string): boolean => localStorage.getItem(keyFor(walletId, 'keyring')) !== null;

/**
 * TAKES ONE WALLET OFF THIS BROWSER — every record it owns, its cached
 * balances, and its place in the list.
 *
 * THIS IS NOW TWO CONTROLS WEARING ONE IMPLEMENTATION, and they are
 * only the same because they do the same thing: `startOver` on the wallet
 * this window has open (which is what this function has always been), and the
 * removal control, which names the wallet it is given. **What it does NOT do
 * is destroy the sealing key** — that is `forgetSealingKey`, called only by
 * removal, because `startOver` has never done it and a fresh wallet in the
 * same compartment re-uses the entry exactly as it did before this change.
 */
export function forgetEverything(walletId: string): void {
  for (const kind of RECORD_KINDS) localStorage.removeItem(keyFor(walletId, kind));
  forgetWalletCheckpoints(walletId);
  forgetWallet(walletId);
}

/**
 * The non-extractable AES key that opened this wallet's sealed copy, deleted.
 * Only the REMOVAL control calls it, and it goes LAST — after the records, so
 * an interrupted removal leaves a wallet that cannot be opened rather than a
 * key with nothing to open, which is the direction that loses nothing a person
 * still has pieces for.
 */
export function forgetSealingKey(walletId: string): void {
  void idbDelete(sealKeyFor(walletId)).catch(() => {
    /* nothing behind it */
  });
}

/* ---- balance checkpoints: the wallet's synced state, sealed, per account. ----
 *
 * MEASURED, twice: 1.6 seconds of cold sync
 * was an empty wallet on a small test chain — a floor, not a ceiling — so the
 * SDK's `serializeState`/`restore` is used to make every open after the first
 * cheap regardless of how the chain grows.
 *
 * SEALED, LIKE THE SECRET, AND FOR A NEARBY REASON. The snapshot holds no
 * key — measured: the SDK serialises public keys, the local coin state and
 * coin commitment/nullifier hashes — but it is a map of this wallet's money:
 * what it holds and which coins are which. That does not belong on disk in
 * the clear, so it is sealed under the same non-extractable AES key as the
 * keyring, in IndexedDB (snapshots grow with history; localStorage does not).
 *
 * A CHECKPOINT IS A CACHE, NOT A GATE — deliberately unlike the keyring.
 * Damage, an unopenable blob, a version the SDK refuses: every failure reads
 * as ABSENCE and the next sync rebuilds it from the chain. Nothing behind
 * this record can be lost, so nothing here may ever block a screen (that
 * discipline is for states that gate money; this gates a shortcut).
 *
 * EACH ENTRY IS NAMED BY ITS WALLET'S OWN COIN PUBLIC KEY — the same rule with
 * a sharper name than a fingerprint: the caller supplies the key it derived
 * for the account it is asking about, and a record carrying any other key is
 * null. A stale checkpoint from a replaced account can therefore never dress
 * a new account's balance, which would be the §4 failure (a number the wallet
 * did not establish) delivered from disk.
 */

/* The store is per wallet (`checkpointKeyFor`). Two wallets sharing it
 * leaked nothing (an entry is refused unless it names the asking wallet's own
 * coin public key) but they evicted each other's account 0, so switching cost
 * a cold sync every time. */

export interface WalletCheckpoint {
  /** The SDK's own serialised snapshot, fed back through `restore`. */
  readonly serialized: string;
  /** tNIGHT in smallest units at `asOf` — the last established number. */
  readonly night: bigint;
  /** Every other private token held at `asOf`, sealed with the rest. Absent
   * on a checkpoint written before other tokens were recorded, and absent is
   * read as "not recorded", never as "none". */
  readonly others?: OtherTokens;
  /** The moment the number was true of. Part of what makes it honest. */
  readonly asOf: number;
}

interface StoredCheckpointEntry {
  readonly coinPublicKey: string;
  readonly iv: string;
  readonly sealed: string;
}

interface StoredCheckpoints {
  readonly perAccount: Record<string, StoredCheckpointEntry>;
}

/**
 * **`walletId` IS REQUIRED, AND THAT IS THE FIX FOR A DEFECT, NOT A STYLE
 * PREFERENCE.**
 *
 * It defaulted to `openWalletId()` when the store was first split. A default
 * argument is evaluated WHERE THE CALL RUNS, and this function's only writer
 * runs inside a long-lived SDK subscription (`balance.ts`, `wallet.state
 * .subscribe`) that fires whenever a sync completes — minutes after the engine
 * started, and after the person may have turned to another wallet. The
 * checkpoint was then computed for wallet A and written into whichever
 * compartment was open at the moment it arrived.
 *
 * **NO READER-SIDE CHECK CATCHES THAT, BECAUSE THE WRITE IS WHAT IS WRONG.**
 * `loadWalletCheckpoint` refuses an entry that does not name the asking
 * wallet's coin public key, so nobody is ever SHOWN a wrong number — but B's
 * own entry for that account has been evicted by A's, and A's map of its money
 * now sits in B's compartment, where removing A will not remove it.
 *
 * So the compartment is named by the caller, which forces every call site to
 * decide it at a moment when the answer is known — the START of the work, not
 * the end of it. A defaulted argument here reads mutable global state at an
 * arbitrary later time, and that is precisely the trap.
 */
/*
 * **AND NO SNAPSHOT HOLDING ANYTHING IN FLIGHT IS KEPT, WHOEVER ASKS.** A
 * snapshot taken while coins are set aside, or expected, keeps them so in every
 * wallet restored from it, for good (`snapshot.ts` says why). The rule is kept
 * here, in the store, so that it holds for every writer: one that cannot be
 * read is not kept either, because it cannot be shown to hold nothing. A
 * refused save writes nothing and answers `false`; missing a checkpoint costs
 * one slow read.
 */
/** A record sealed under this wallet's own sealing key: the key that seals the secret, used as it is. */
export interface SealedHere {
  readonly iv: string;
  readonly sealed: string;
}

/**
 * **SEALS A RECORD UNDER THE KEY THAT SEALS THIS WALLET'S SECRET**, for a record the wallet keeps beside it (a new
 * vault's secret until the vault has started). The key is the same non-extractable one `saveSecret` seals with, read
 * as it is; nothing about how the secret itself is sealed changes.
 */
export async function sealHere(plain: string, walletId: string = openWalletId()): Promise<SealedHere> {
  const key = await sealingKey(walletId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain) as BufferSource)
  );
  return { iv: toBase64Url(iv), sealed: toBase64Url(sealed) };
}

/** Opens a record `sealHere` sealed, or answers null when it does not open under this wallet's key. */
export async function openHere(kept: SealedHere, walletId: string = openWalletId()): Promise<string | null> {
  try {
    const key = await sealingKey(walletId);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(kept.iv) as BufferSource },
      key,
      fromBase64Url(kept.sealed) as BufferSource
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export async function saveWalletCheckpoint(
  coinPublicKey: string,
  account: number,
  checkpoint: WalletCheckpoint,
  walletId: string
): Promise<boolean> {
  const facts = snapshotFacts(checkpoint.serialized);
  if (facts === null || facts.inFlight) return false;
  const key = await sealingKey(walletId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(
    JSON.stringify({
      coinPublicKey,
      serialized: checkpoint.serialized,
      night: checkpoint.night.toString(),
      ...(checkpoint.others === undefined ? {} : { others: otherTokensToStored(checkpoint.others) }),
      asOf: checkpoint.asOf
    })
  );
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain as BufferSource));
  const record = ((await idbGet(checkpointKeyFor(walletId))) as StoredCheckpoints | undefined) ?? { perAccount: {} };
  record.perAccount[String(account)] = {
    coinPublicKey,
    iv: toBase64Url(iv),
    sealed: toBase64Url(sealed)
  };
  await idbPut(checkpointKeyFor(walletId), record);
  return true;
}

/**
 * The checkpoint for THIS wallet, or null — for no record, another wallet's
 * record, a damaged blob, or a browser that cannot open it. Never throws:
 * a cache that cannot be read is a cache that does not exist.
 */
/** `walletId` is required for the reason `saveWalletCheckpoint` gives above.
 * The cost of getting it wrong here is only a spurious cache miss — the
 * coin-public-key check turns a foreign entry into a null — but the same
 * argument must be threaded either way, and one rule is cheaper to keep than
 * two. */
export async function loadWalletCheckpoint(
  coinPublicKey: string,
  account: number,
  walletId: string
): Promise<WalletCheckpoint | null> {
  try {
    const record = (await idbGet(checkpointKeyFor(walletId))) as StoredCheckpoints | undefined;
    const entry = record?.perAccount?.[String(account)];
    if (!entry) return null;
    if (entry.coinPublicKey !== coinPublicKey) return null;
    const key = await sealingKey(walletId);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(entry.iv) as BufferSource },
      key,
      fromBase64Url(entry.sealed) as BufferSource
    );
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as {
      coinPublicKey: string;
      serialized: string;
      night: string;
      asOf: number;
      others?: unknown;
    };
    /* The sealed copy names its wallet too; AES-GCM authenticated it, and
     * this check makes a mismatched outer label a null rather than a lie. */
    if (parsed.coinPublicKey !== coinPublicKey) return null;
    if (typeof parsed.serialized !== 'string' || !Number.isFinite(parsed.asOf)) return null;
    /* A snapshot holding anything in flight, kept before the store refused one,
     * is refused here and taken out, so the next complete read writes a clean
     * one in its place rather than restoring the set-aside coins for ever. */
    if (snapshotFacts(parsed.serialized)?.inFlight === true) {
      const now = (await idbGet(checkpointKeyFor(walletId))) as StoredCheckpoints | undefined;
      if (now?.perAccount?.[String(account)]?.sealed === entry.sealed) {
        delete now.perAccount[String(account)];
        await idbPut(checkpointKeyFor(walletId), now);
      }
      return null;
    }
    /* A checkpoint saved before other tokens were recorded has no `others`
     * and loads as NIGHT only; a damaged map throws and is no checkpoint. */
    const others = otherTokensFromStored(parsed.others);
    const night = BigInt(parsed.night);
    return others === undefined
      ? { serialized: parsed.serialized, night, asOf: parsed.asOf }
      : { serialized: parsed.serialized, night, others, asOf: parsed.asOf };
  } catch {
    return null;
  }
}

/** Fire-and-forget: checkpoints are a cache, and forgetting must not wait. */
export function forgetWalletCheckpoints(walletId: string): void {
  void idbDelete(checkpointKeyFor(walletId)).catch(() => {
    /* nothing behind it to lose */
  });
}

/* ---- how this account got here, when it was not made here. ----
 *
 * §7.15'S THIRD STATE, MADE DURABLE FOR PAIRING (the answer to
 * UNSURE (a)): the fact worth keeping is *this account arrived from another
 * device on this date*, and the pairing itself is that evidence at full
 * strength — the sealed blob only opened here because another machine held
 * the account and a person confirmed the digits. It says NOTHING about
 * pieces, so it can never light the tick; it exists so a reload does not
 * greet the person with "your account exists only in this browser", which
 * pairing has just demonstrated to be false. The same discipline applies: the
 * record names its account by fingerprint and is null for any other.
 */

export interface ArrivalRecord {
  readonly fingerprint: string;
  readonly at: number;
}

export function saveArrival(secret: Secret): void {
  const record: ArrivalRecord = {
    fingerprint: toBase64Url(fingerprintOf(secret)),
    at: Date.now()
  };
  localStorage.setItem(keyFor(slotToWrite(secret), 'arrived'), JSON.stringify(record));
}

/** The arrival fact FOR THIS SECRET, or null — including for a damaged or
 * foreign record, which must not borrow a different account's history. */
export function arrivalOf(secret: Secret): ArrivalRecord | null {
  const slot = slotOf(secret);
  if (slot === null) return null;
  const raw = localStorage.getItem(keyFor(slot, 'arrived'));
  if (!raw) return null;
  let parsed: ArrivalRecord;
  try {
    parsed = JSON.parse(raw) as ArrivalRecord;
  } catch {
    return null;
  }
  if (typeof parsed?.fingerprint !== 'string' || !isRealNumber(parsed?.at)) return null;
  if (parsed.fingerprint !== toBase64Url(fingerprintOf(secret))) return null;
  return { fingerprint: parsed.fingerprint, at: parsed.at };
}

/* ---- how far on each person's saved keys are, as this wallet last saw them. ----
 *
 * A page hands this wallet a person's saved keys sealed, as the service holds
 * them, and the service can hand back an older copy, or another copy sealed at
 * the same count. The sealed text counts its own writes, and this record keeps,
 * per person, the highest count this wallet has opened or seen kept and a hash
 * of the sealed copy it saw at that count: anything lower, or another copy at
 * that count, is not the newest. Kept beside the wallet's other records and
 * forgotten with them, and refused for any other secret as they are. Neither is
 * a secret: a count says only how often the keys were written, and the hash
 * opens nothing.
 */

/**
 * The highest count of writes of a person's saved keys this wallet has seen, and which sealed copy it was; `under: 2`
 * once it has opened a copy sealed under the key no page had (`keyring/seal-key.ts`), after which a copy under the old
 * key is refused.
 */
export interface KeyringMarkKept {
  readonly counter: number;
  readonly digest: string;
  readonly under?: 2;
}

interface KeyringMarksRecord {
  readonly fingerprint: string;
  readonly marks: Readonly<Record<string, KeyringMarkKept>>;
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const DIGEST = /^[0-9a-f]{64}$/u;
const isMark = (m: unknown): m is KeyringMarkKept =>
  typeof m === 'object' &&
  m !== null &&
  isCount((m as KeyringMarkKept).counter) &&
  typeof (m as KeyringMarkKept).digest === 'string' &&
  DIGEST.test((m as KeyringMarkKept).digest) &&
  ((m as KeyringMarkKept).under === undefined || (m as KeyringMarkKept).under === 2);

function keyringMarksOf(secret: Secret): Record<string, KeyringMarkKept> | null {
  const slot = slotOf(secret);
  if (slot === null) return null;
  const raw = localStorage.getItem(keyFor(slot, 'keyring-marks'));
  if (!raw) return {};
  let parsed: KeyringMarksRecord;
  try {
    parsed = JSON.parse(raw) as KeyringMarksRecord;
  } catch {
    return {};
  }
  if (typeof parsed?.fingerprint !== 'string' || parsed.fingerprint !== toBase64Url(fingerprintOf(secret))) return {};
  if (typeof parsed.marks !== 'object' || parsed.marks === null) return {};
  const marks: Record<string, KeyringMarkKept> = {};
  for (const [person, m] of Object.entries(parsed.marks)) {
    if (isMark(m))
      marks[person] = { counter: m.counter, digest: m.digest, ...(m.under === 2 ? { under: 2 as const } : {}) };
  }
  return marks;
}

/** The highest count of writes of this person's saved keys this wallet has seen and its copy, or null when it has seen none. */
export function keyringMarkOf(secret: Secret, person: string): KeyringMarkKept | null {
  const marks = keyringMarksOf(secret);
  if (marks === null || !Object.prototype.hasOwnProperty.call(marks, person)) return null;
  return marks[person] ?? null;
}

/**
 * Keeps `mark` for this person when its count is higher than the one kept, or when it is the same copy and says it was
 * sealed under the new key. Never lowers the count, never replaces the copy kept at a count with another copy at the
 * same count, and never takes `under: 2` away once kept.
 */
export function raiseKeyringMark(secret: Secret, person: string, mark: KeyringMarkKept): void {
  if (!isMark(mark))
    throw new Error('a mark of saved keys is a count from 0 and the hash of one sealed copy. Nothing was kept.');
  const slot = slotToWrite(secret);
  const marks = keyringMarksOf(secret) ?? {};
  const kept = marks[person];
  const higher = (kept?.counter ?? -1) < mark.counter;
  const nowUnder =
    kept !== undefined &&
    kept.counter === mark.counter &&
    kept.digest === mark.digest &&
    kept.under !== 2 &&
    mark.under === 2;
  if (!higher && !nowUnder) return;
  const under = mark.under === 2 || kept?.under === 2;
  const record: KeyringMarksRecord = {
    fingerprint: toBase64Url(fingerprintOf(secret)),
    marks: {
      ...marks,
      [person]: { counter: mark.counter, digest: mark.digest, ...(under ? { under: 2 as const } : {}) }
    }
  };
  localStorage.setItem(keyFor(slot, 'keyring-marks'), JSON.stringify(record));
}

/* ---- and when it WAS made here. ----
 *
 * A card was asked for saying when this device got the
 * account.
 * `ArrivalRecord` above answers that for a device the account was PAIRED onto
 * — and is null on the device it was CREATED on, which is every tester's
 * first device, so the card as asked for would be blank exactly where a
 * tester starts. **Decided 21 Aug: record creation too**, and let the
 * card say one of two true sentences.
 *
 * IT IS THE SAME SHAPE AS `ArrivalRecord` BECAUSE IT IS THE SAME KIND OF
 * FACT: a fingerprint and a date, about THIS device's own origin, never about
 * any other. The same discipline — the record names its account and is null for
 * any other — and the standing refusal: this wallet
 * cannot know how many devices hold this account and must not appear to, so
 * there is no count here and nothing to build one from.
 *
 * A LOCAL CONVENIENCE, LIKE THE SUBWALLET NAMES. A browser that loses or
 * damages this record shows NOTHING rather than a wrong date; no money
 * depends on it, and the no-silent-rewrite rule means a damaged record is
 * not repaired in place — the reader returns null and the next write, if
 * there ever is one, writes a whole new record.
 *
 * **THE WRITER IS CALLED WHERE A NEW SECRET IS MADE, NOT WHERE A KEYRING IS
 * STORED**, and that is the entire safety of it. Three paths put a keyring in
 * a browser — creation, pairing and recovery — and only one of them is a
 * beginning. A stamp written by whatever stores a keyring would mark a
 * RECOVERY as a creation, and the card would then tell somebody who had just
 * put an old account back that it began on the machine they recovered onto.
 * `session.tsx` names the two call sites and says why the other two cannot
 * reach them.
 */

export interface CreationRecord {
  readonly fingerprint: string;
  readonly at: number;
}

export function saveCreation(secret: Secret): void {
  const record: CreationRecord = {
    fingerprint: toBase64Url(fingerprintOf(secret)),
    at: Date.now()
  };
  localStorage.setItem(keyFor(slotToWrite(secret), 'created'), JSON.stringify(record));
}

/** The creation fact FOR THIS SECRET, or null — including for a damaged or
 * foreign record, which must not borrow a different account's history. */
export function creationOf(secret: Secret): CreationRecord | null {
  const slot = slotOf(secret);
  if (slot === null) return null;
  const raw = localStorage.getItem(keyFor(slot, 'created'));
  if (!raw) return null;
  let parsed: CreationRecord;
  try {
    parsed = JSON.parse(raw) as CreationRecord;
  } catch {
    return null;
  }
  if (typeof parsed?.fingerprint !== 'string' || !isRealNumber(parsed?.at)) return null;
  if (parsed.fingerprint !== toBase64Url(fingerprintOf(secret))) return null;
  return { fingerprint: parsed.fingerprint, at: parsed.at };
}

/* ---- the name of the WHOLE wallet — the secret, not an account inside it. ----
 *
 * **THE TWO KINDS OF NAME ARE NOT THE SAME THING, AND THE COPY MUST NOT BLUR
 * THEM.** `SubwalletRecord.names` (`subwallet-record.ts`) names the ACCOUNTS in
 * one wallet — the main wallet and the ten slots, each with its own address
 * and its own money. THIS record names the wallet those accounts live in.
 * One name per SECRET; nothing here is per-account.
 *
 * WHY IT EXISTS, OBSERVED RATHER THAN IMAGINED. Clearing the store does not
 * clear passkeys, so credentials accumulate for one origin and the browser's
 * chooser lists several entries all reading `Midnight wallet`, `new passkey
 * <date>` or `recovered <date>` — strings a person could not change. They
 * cannot tell which wallet is which, and one of them holds their money.
 * `session.tsx` passes this name to `createPasskey`, so the chooser reads it.
 *
 * OPTIONAL, AND DECORATION LIKE THE SUBWALLET NAMES. No money depends on it:
 * a wallet with no name behaves exactly as it did before this record existed,
 * and a browser that loses the record loses a label to re-type. So damage is
 * ABSENCE and never a `broken` state — there is nothing behind it to lose.
 *
 * The same discipline, and it is the whole of the safety here: the record
 * carries the fingerprint of the secret it names, and `walletNameOf` is null
 * for any other. A browser that held wallet B and now holds wallet A must
 * never dress A in B's name — over a WHOLE wallet that is the wrong-wallet
 * failure at its largest, because every account inside inherits the mistake.
 */

interface WalletNameRecord {
  readonly fingerprint: string;
  readonly name: string;
}

function parseWalletName(raw: string): WalletNameRecord | null {
  let parsed: WalletNameRecord;
  try {
    parsed = JSON.parse(raw) as WalletNameRecord;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  if (!isNamed(parsed.fingerprint)) return null;
  if (!isNamed(parsed.name)) return null;
  return { fingerprint: parsed.fingerprint, name: parsed.name.trim() };
}

/**
 * Names or renames the wallet sealed in this browser. An empty name REMOVES
 * the record: an unnamed wallet is a state this build supports everywhere,
 * not a hole, so a name can always be taken back off.
 *
 * **EVERY PATH THAT LANDS A KEYRING CALLS THIS, EVEN WITH NO NAME**, and that
 * is the ground `walletNameOnRecord` stands on: a landing writes the record
 * for the secret it has just sealed, or removes whatever is there. So the
 * record beside a keyring belongs to that keyring or does not exist — never
 * to the wallet the landing replaced. `session.tsx` holds the four landings.
 */
export function saveWalletName(secret: Secret, name: string): void {
  const key = keyFor(slotToWrite(secret), 'wallet-name');
  const trimmed = name.trim();
  if (trimmed === '') {
    localStorage.removeItem(key);
    return;
  }
  const record: WalletNameRecord = {
    fingerprint: toBase64Url(fingerprintOf(secret)),
    name: trimmed
  };
  localStorage.setItem(key, JSON.stringify(record));
}

/**
 * The wallet's name FOR THIS SECRET, or null — for no record, a damaged one,
 * or another wallet's. **This is the authority**: every surface that holds a
 * secret asks this one and no other.
 */
export function walletNameOf(secret: Secret): string | null {
  const slot = slotOf(secret);
  if (slot === null) return null;
  const raw = localStorage.getItem(keyFor(slot, 'wallet-name'));
  if (!raw) return null;
  const parsed = parseWalletName(raw);
  if (!parsed) return null;
  if (parsed.fingerprint !== toBase64Url(fingerprintOf(secret))) return null;
  return parsed.name;
}

/**
 * The name as stored, WITHOUT the fingerprint check. Same shape and same rule
 * as `securedSetupOnRecord`: it makes no claim, and it must never
 * decide anything — `walletNameOf` is the authority.
 *
 * **EVERY LAWFUL USE IS THE SAME SITUATION**, and it is worth stating as one
 * rule rather than as a list that will go stale: **the caller is talking
 * ABOUT the wallet sealed in this browser, and does not have — and cannot
 * get — the secret that would check it.** Today that is four call sites and
 * three screens:
 *
 *   - the LOCKED screen, naming the wallet a person is about to unlock;
 *   - the recovery landing and the pairing landing, which owe the person
 *     deciding the NAME of what they are about to replace;
 *   - the refusal in `session.tsx` that stops a wallet being made over one
 *     that arrived since the screen was drawn, which names it for the same
 *     reason.
 *
 * Anywhere a secret IS in hand, using this instead of `walletNameOf` is a
 * defect, not a shortcut.
 *
 * IT IS HONEST ONLY BECAUSE OF THE LANDING DISCIPLINE ON `saveWalletName`
 * ABOVE. If a path ever seals a keyring without settling this record, this
 * function becomes a way to print one wallet's name over another's money.
 * `wallet-name.test.ts` is what goes red when it does.
 */
export function walletNameOnRecord(walletId: string): string | null {
  const raw = localStorage.getItem(keyFor(walletId, 'wallet-name'));
  if (!raw) return null;
  return parseWalletName(raw)?.name ?? null;
}

/**
 * Deletes ONLY the secured record — the map to the pieces. Exists for
 * `startFresh`, which must forget things in the order that risks nothing:
 * the new wallet lands first, the stale credentials are replaced next, and
 * this — the one irreplaceable value in the stale state — goes LAST.
 */
export function forgetSecuredSetup(walletId: string): void {
  localStorage.removeItem(keyFor(walletId, 'secured'));
}

/* ---- whether this account has been secured, and with what. ----
 *
 * THIS RECORD IS WHAT THE HOME SCREEN'S STANDING NOTICE READS. §7.7:
 * the notice stays until it is untrue, and this record is the thing that makes
 * it untrue. Written only by the securing flow after
 * `splitSecret` has proved the set recoverable; read by the shell from
 * the start.
 *
 * It records METADATA ONLY — labels, holders, when each piece was last
 * verified. No piece bytes, ever: pieces live in their homes (`ports.ts`,
 * `PieceHome`), never in this browser's localStorage. `lastVerified` is null
 * for a piece that cannot be asked — paper cannot — and the screen shows that
 * as unknown rather than as fine (§1, §7.12).
 *
 * WHAT THE RECORD MUST BE BEFORE IT COUNTS. §7.7's notice is the most
 * important sentence this interface says, and it is switched off by this
 * record; so a record this file cannot stand behind is not "shown anyway with
 * gaps", it is null, and the notice stays up. And the record names the account
 * it describes: it carries the eight-byte fingerprint of the secret it
 * was cut from (`fingerprintOf`, the same one every piece carries), and it is
 * refused for any other secret. A stale record must never become a new
 * account's proof of backup.
 */

export interface PlacedPiece {
  readonly label: string;
  readonly holder: string;
  /**
   * TWO IDLE STATES, NOT ONE — §7.12 wrote this trap down in advance and
   * Trouble is what happened when one value carried both. `null` means the
   * home CANNOT BE ASKED — paper cannot, ever, and that is its honest,
   * permanent answer. `'never'` means the home could be asked and has not
   * been yet. A number is when it last answered. The screen says a different
   * sentence for each, because they are different facts.
   */
  readonly lastVerified: number | 'never' | null;
}

/**
 * A set this account REPLACED — kept, never erased, §7.14: re-cutting
 * mints a new set id but the old pieces still rebuild the same secret for as
 * long as they exist. Nothing in Shamir can switch them off. So replacing a
 * plan must not destroy the map to what is still live, and the screen states
 * the fact — re-cutting adds a way in and never removes one.
 */
export interface SupersededSet {
  readonly fingerprint: string;
  readonly threshold: number;
  readonly pieces: readonly PlacedPiece[];
  readonly rebuiltAt: number;
  readonly supersededAt: number;
}

export interface SecuredSetup {
  /**
   * base64url of `fingerprintOf` the secret this set was cut from.
   * Written by `saveSecuredSetup`, which computes it — a writer cannot supply
   * a wrong one.
   */
  readonly fingerprint: string;
  /** How many pieces put the account back. Off the pieces themselves. */
  readonly threshold: number;
  readonly pieces: readonly PlacedPiece[];
  /**
   * When the account was ACTUALLY REBUILT from a real subset of these pieces.
   * §7.12: the tick states that one dated fact and nothing else — never a
   * prediction about today. Set only by a real rebuild, never by the act of
   * placing pieces.
   */
  readonly rebuiltAt: number;
  /**
   * TRUE FOR A MAP THAT NAMES ONLY THE PIECES THAT WERE USED — §7.15.
   * A completed recovery writes this record (it is the strongest evidence the
   * product ever has: threshold-many real pieces, fetched from their real
   * homes, checked against the secret's own fingerprint), but it only ever
   * saw the pieces the person typed in. There may be others this browser does
   * not know about, and every screen that shows a partial map says so. The
   * wizard's records are complete: it cut every piece itself.
   */
  readonly partial: boolean;
  /** Older sets whose pieces are still out there and still work. */
  readonly superseded: readonly SupersededSet[];
}

const isVerification = (value: unknown): boolean => value === null || value === 'never' || isRealNumber(value);

/** Structure of one set's worth of pieces — shared by the live set and the
 * superseded ones, which were all live once. */
function validPieces(pieces: unknown, threshold: unknown): pieces is PlacedPiece[] {
  if (!Array.isArray(pieces)) return false;
  if (!Number.isInteger(threshold)) return false;
  if ((threshold as number) < 1 || (threshold as number) > pieces.length) return false;
  for (const piece of pieces as PlacedPiece[]) {
    if (typeof piece !== 'object' || piece === null) return false;
    if (!isNamed(piece.label) || !isNamed(piece.holder)) return false;
    if (!isVerification(piece.lastVerified)) return false;
  }
  return true;
}

/**
 * The record, or null for anything this file cannot stand behind.
 *
 * Structure is checked here; the PLAN — threshold against count, no two
 * pieces behind one holder, a threshold of one being copies — is checked by
 * `checkPlan`, THE SAME RULES THAT CUT A SET. A looser second copy of those
 * rules lived here briefly and accepted "any 1 of these 1 pieces" and a
 * 2-of-3 with two pieces in one Google account; a rule written twice is two
 * rules, and the weaker one wins where it matters.
 */
function parseSecuredSetup(raw: string): SecuredSetup | null {
  let parsed: SecuredSetup;
  try {
    parsed = JSON.parse(raw) as SecuredSetup;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  if (!isNamed(parsed.fingerprint)) return null;
  if (!validPieces(parsed.pieces, parsed.threshold)) return null;
  if (!isRealNumber(parsed.rebuiltAt)) return null;

  /* Superseded sets: absent on records written before that rule — read as none. */
  const superseded = (parsed.superseded ?? []) as SupersededSet[];
  if (!Array.isArray(superseded)) return null;
  for (const old of superseded) {
    if (typeof old !== 'object' || old === null) return null;
    if (!isNamed(old.fingerprint)) return null;
    if (!validPieces(old.pieces, old.threshold)) return null;
    if (!isRealNumber(old.rebuiltAt) || !isRealNumber(old.supersededAt)) return null;
  }

  try {
    checkPlan(
      parsed.pieces.map((p) => ({ label: p.label, holder: p.holder })),
      parsed.threshold
    );
  } catch {
    return null;
  }
  /* `partial` is absent on records written before §7.15 — all of which the
   * wizard wrote, and the wizard's maps are complete. */
  return { ...parsed, superseded, partial: parsed.partial === true };
}

/**
 * The secured record FOR THIS SECRET, or null — and null means the standing
 * notice shows. Refuses a malformed record and a record cut from a
 * different secret, because a green tick backed by either is the
 * notice lying.
 */
export function loadSecuredSetup(secret: Secret): SecuredSetup | null {
  const slot = slotOf(secret);
  if (slot === null) return null;
  const raw = localStorage.getItem(keyFor(slot, 'secured'));
  if (!raw) return null;
  const parsed = parseSecuredSetup(raw);
  if (!parsed) return null;
  if (parsed.fingerprint !== toBase64Url(fingerprintOf(secret))) return null;
  return parsed;
}

/**
 * The record as stored, WITHOUT the fingerprint check — for exactly one use:
 * showing a person the map of where their pieces are when the secret cannot
 * be unlocked to check it (the broken-storage screen). It makes no
 * security claim and must never decide the tick; `loadSecuredSetup` does that.
 */
export function securedSetupOnRecord(walletId: string): SecuredSetup | null {
  const raw = localStorage.getItem(keyFor(walletId, 'secured'));
  if (!raw) return null;
  return parseSecuredSetup(raw);
}

/**
 * Writes the record — and `rebuiltAt` is NOT caller data. §7.12: the
 * tick states that on a date the account was ACTUALLY REBUILT, so the only
 * way to write the record is to hand over a real `PieceSet` — the artefact a
 * wizard that skipped the split cannot have — and this function performs the
 * rebuild it is about to claim, right here, via `proveRecoverable`, then
 * stamps its own clock. A caller has no `rebuiltAt` to lie with and no
 * fingerprint to mistake: both come from the evidence.
 *
 * `verification` seeds the per-piece freshness lines — the part §7.12 puts
 * UNDER the tick — and it must name EVERY holder, because the writer refuses
 * to guess whether a home can be asked: `null` is "cannot be checked, ever"
 * (paper), `'never'` is "could be, has not been", a number is when it last
 * was. One value carrying both idle states was the defect.
 *
 * WHAT WAS ON RECORD IS KEPT, NEVER ERASED — §7.14. A replaced set's
 * pieces still rebuild this secret for as long as they exist; an earlier
 * record with a DIFFERENT fingerprint is some other account's map. Both go
 * into `superseded` rather than into the void.
 */
export async function saveSecuredSetup(
  secret: Secret,
  set: PieceSet,
  verification: Readonly<Record<string, number | 'never' | null>>,
  options?: { readonly partial?: boolean }
): Promise<void> {
  for (const piece of set.pieces) {
    if (!(piece.placement.holder in verification)) {
      throw new Error(
        `saveSecuredSetup: no verification state for holder "${piece.placement.holder}". ` +
          'The writer does not guess whether a home can be asked — say null (cannot be), ' +
          "'never' (can be, has not been), or a timestamp."
      );
    }
  }

  /* The rebuild this record claims. Throws — and nothing is written — if the
   * set does not actually recover this secret. */
  await proveRecoverable(secret, set);

  const slot = slotToWrite(secret);
  const previous = securedSetupOnRecord(slot);
  const superseded: SupersededSet[] =
    previous === null
      ? []
      : [
          ...previous.superseded,
          {
            fingerprint: previous.fingerprint,
            threshold: previous.threshold,
            pieces: previous.pieces,
            rebuiltAt: previous.rebuiltAt,
            supersededAt: Date.now()
          }
        ];

  const record: SecuredSetup = {
    fingerprint: toBase64Url(fingerprintOf(secret)),
    threshold: set.threshold,
    pieces: set.pieces.map((piece) => ({
      label: piece.placement.label,
      holder: piece.placement.holder,
      lastVerified: verification[piece.placement.holder] ?? null
    })),
    rebuiltAt: Date.now(),
    partial: options?.partial === true,
    superseded
  };
  localStorage.setItem(keyFor(slot, 'secured'), JSON.stringify(record));
}
