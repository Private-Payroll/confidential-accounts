/**
 * WHERE THE NOTE POOL LIVES, AND WHY IT IS NOT SEALED LIKE EVERYTHING ELSE.
 * `C202`, `S6d`, and `docs/scope-the-vault-system.md` §3.3.
 *
 * `vault-notes.ts` holds what a vault can spend: which notes exist, what they
 * are worth, which one to spend. **None of that is on chain and none of it is
 * derivable** — the chain publishes commitments, which disclose nothing — so
 * the pool is the money, and until this file existed it had nowhere to live.
 * `NotePool` in `vault-ledger.ts` was an interface with exactly one
 * implementation, inside a test.
 *
 * ------------------------------------------------------------------------
 * WRAPPED PER SIGNER, AND **NOT** SEALED UNDER A PURPOSE KEY. This is the whole
 * design decision and it reverses an earlier one on purpose.
 *
 * Every other confidential record this product holds is sealed under a key
 * derived from the account's viewing key (`src/core/sealed-records.ts`), and the
 * obvious thing to do here was add a seventh `Purpose` and follow suit.
 *
 * **It would hand our server the vault's balance.** A purpose key is derived
 * from the account viewing key, and the viewing key crosses the wire to our
 * server on the vault-threshold routes. The pool is not metadata — it is
 * nonces, tokens and **values**. So a purpose-key-sealed pool makes the
 * product's central claim false the first time a signer changes a threshold.
 * `Purpose` therefore stays at six and the pool gets its own envelope:
 *
 *   · a **fresh symmetric key on every write**, which seals the pool;
 *   · that key **wrapped to each signer's own wrapping public key**, which is
 *     `wrapKey`/`unwrapKey` — the same machinery a payslip already travels
 *     through, and the same machinery that delivers the viewing key itself.
 *
 * **No viewing key appears anywhere in this file, and that is a property rather
 * than an omission** — `vault-pool.test.ts` asserts it of the source text,
 * because the failure it prevents is somebody adding one to make a signature
 * tidier and nothing ever objecting.
 *
 * ------------------------------------------------------------------------
 * WHAT FALLS OUT, INCLUDING THE ONE NOBODY LOOKED FOR
 *
 *   1. **The server holds the ciphertext and cannot read it.** It can still
 *      withhold it or serve an old one — that is `decision 0002` and `M-91`,
 *      unchanged and not fixed here — but it cannot learn a balance.
 *   2. **Every signer can open it**, because whoever runs a payout needs it and
 *      a device-local pool means a lost laptop is a frozen vault.
 *   3. **Viewing-key rotation is not a vault event.** `rotate` re-seals every
 *      record an account owns under a new key; a purpose-key-sealed pool would
 *      have to be re-sealed in that same pass, and a rotation that half
 *      completed would be a vault nobody can spend — a new way to lose money,
 *      introduced by the fix for another one, at the moment an account is
 *      already dealing with somebody leaving. Wrapping per signer means
 *      `rotate` never touches this and cannot break it.
 *
 * ------------------------------------------------------------------------
 * WHAT IT COSTS, STATED RATHER THAN ENGINEERED AROUND
 *
 * **Adding a signer means wrapping the pool key to them** — `wrapFor` below,
 * which needs a signer who can already open it. **Removing one does not un-tell
 * them what they have already read.** That is the same property a signer's own
 * key material already has, and it is smaller than it sounds: a departed signer
 * with a stale pool can *recognise* the vault's notes, not spend them. Spending
 * needs an approved run, and that is the threshold's job.
 *
 * ------------------------------------------------------------------------
 * AND THE HALF THAT MATTERS MOST: **THE POOL IS A CACHE, NEVER THE RECORD.**
 *
 * The chain's `notes` set is the record. This is what lets the owner say which
 * note a commitment describes, and it is rebuildable from the chain plus the
 * owner's history — `replayVault` in `vault-recovery.ts`. So the failure this
 * file is allowed to have is *"the pool could not be read"*, which is a
 * refusal and recoverable. The failure it must never have is *"the pool read as
 * empty"*, which is indistinguishable from a vault with no money in it. Every
 * refusal below is written to keep those two apart.
 */
import {
  seal, unseal, wrapKey, unwrapKey, canonical, parseCanonical, newSymmetricKey,
  type Sealed, type Hex,
} from '../core/crypto.js';
import type { VaultNotes } from './vault-notes.js';
import type { NotePool } from './vault-ledger.js';

/** A signer, as this file needs them: an id and the public half they publish. */
export interface PoolSigner {
  id: string;
  /** The x25519 public key their device holds the secret for. */
  wrappingPublicKey: Hex;
}

/** One signer's copy of the key that opens a pool. */
export interface WrappedPoolKey {
  signerId: string;
  wrapped: { ephemeral: Hex } & Sealed;
}

/**
 * A pool as it is stored: opaque bytes, plus one wrapped key per signer.
 *
 * `vault` and `version` are the only readable fields and both are Tier 4 — an
 * address that is already public, and a counter. **Nothing here says what the
 * vault holds, how many notes it has, or what they are worth**, which is the
 * difference between this and a purpose-sealed record whose key we could
 * derive.
 */
export interface SealedPool {
  vault: string;
  /**
   * Monotonic, and checked on write.
   *
   * Two operators reconciling the same vault at once is not exotic — `B3` is
   * the shape — and the pool is the money, so a later write silently landing
   * under an earlier one is a pool that has forgotten a payment. The store
   * refuses rather than resolving it, because there is no correct merge of two
   * disagreeing beliefs about which notes exist.
   */
  version: number;
  sealed: Sealed;
  wrapped: WrappedPoolKey[];
}

/** Thrown rather than answering with a pool nobody should act on. */
export class VaultPoolUnreadable extends Error {
  constructor(readonly vault: string, why: string) {
    super(
      `this vault's note pool could not be read: ${why}. **This is not the same as the vault ` +
      'holding nothing** — an empty pool is a claim that the vault has no money, and a pool ' +
      'we could not open is our ignorance. Acting on the first when the second is true spends ' +
      'nothing and reports a balance of zero; the notes stay on chain and nobody can say what ' +
      'they are. Rebuild it from the chain and the history with replayVault.' +
      /*
       * **THE VAULT IS NOT NAMED HERE. `C236`, and see the same note in
       * `vault-ledger.ts`.** It used to end `(vault <64 hex>)`. An error
       * message is a screen, and an instrument's failure block deliberately
       * does not go through the screen guard, so this was a route the address
       * reached a person by. It stays as this error's `vault` property.
       */
      ' (the vault is not named here — its address is the one value that destroys money when ' +
      'somebody pastes it into a wallet, C236. It is this error\'s `vault` property, and an ' +
      'instrument names the vault by the NAME it was deployed under.)');
    this.name = 'VaultPoolUnreadable';
  }
}

/**
 * Seals a pool for a set of signers, under a key made here and kept by nobody.
 *
 * **A FRESH KEY ON EVERY WRITE, not a long-lived pool key.** A pool changes on
 * every payment, so a key that outlived one write would be a secret whose age
 * grows with the vault's history and whose compromise reveals all of it. One
 * seal and one wrap per signer is the cost, and it is the shape a payslip
 * already pays once per employee per run.
 *
 * The key is a local that goes out of scope. Nothing returns it, stores it, or
 * logs it: the only copies that survive this function are the wrapped ones,
 * each openable by exactly one signer's device.
 */
export const sealPool = (
  vault: string,
  notes: VaultNotes,
  signers: readonly PoolSigner[],
  version: number,
): SealedPool => {
  if (signers.length === 0) {
    /*
     * A pool wrapped to nobody is ciphertext with no key in the world. It would
     * store, replicate and back up perfectly, and the money would be gone.
     */
    throw new Error(
      `refusing to seal ${vault}'s note pool to no signers: the key would exist in no ` +
      'device anywhere, and the pool would be unreadable by everyone including its owner');
  }
  const key = newSymmetricKey();
  return {
    vault,
    version,
    sealed: seal(canonical(notes), key),
    wrapped: signers.map((s) => ({ signerId: s.id, wrapped: wrapKey(key, s.wrappingPublicKey) })),
  };
};

/**
 * Opens a pool with one signer's own wrapping secret. No viewing key involved.
 *
 * Both failures are named separately, because they are different facts about
 * the world: **no copy was wrapped for this signer** (they were added after the
 * last write, or removed) is an access problem with an obvious remedy, and **a
 * copy that will not open** is a wrong secret or a damaged record.
 */
export const openPool = (
  rec: SealedPool, signerId: string, wrappingSecret: Hex,
): VaultNotes => {
  const mine = rec.wrapped.find((w) => w.signerId === signerId);
  if (!mine) {
    throw new VaultPoolUnreadable(
      rec.vault,
      `no copy of the key is wrapped for signer ${signerId}. Either they joined after this ` +
      `pool was last written — any signer who can open it can call wrapFor — or they were ` +
      'removed');
  }
  let key: Hex;
  try {
    key = unwrapKey(mine.wrapped, wrappingSecret);
  } catch {
    throw new VaultPoolUnreadable(
      rec.vault, `signer ${signerId}'s copy of the key would not unwrap with the secret given`);
  }
  try {
    return parseCanonical<VaultNotes>(unseal(rec.sealed, key));
  } catch {
    /*
     * `parseCanonical`, not `JSON.parse`. `M-125`: a note's value is a bigint,
     * which `canonical` writes as `{"$n":"…"}` and a plain parse hands back as
     * an object. An object in arithmetic is `NaN` or a concatenation, not an
     * error — a pool that opens and is wrong is worse than one that refuses.
     */
    throw new VaultPoolUnreadable(
      rec.vault, 'the key unwrapped but the pool itself did not open or did not parse');
  }
};

/**
 * Adds a signer's copy WITHOUT re-sealing, using a signer who can already open.
 *
 * **The pool is not re-encrypted and its version does not move**, because
 * nothing about what the vault holds has changed — only who can read it. That
 * matters for the reason `M-73`/`M-74` give about the sealed state: a rewrite
 * of the money is a chance to write half of it, and adding a reader is not a
 * good enough reason to take that chance.
 *
 * It needs an existing signer's secret because there is no other way: the key
 * exists only inside the wrapped copies. **That is the mechanism working, not a
 * gap** — a server that could add a reader without a signer present is a server
 * that could add itself.
 */
export const wrapFor = (
  rec: SealedPool,
  by: { signerId: string; wrappingSecret: Hex },
  added: readonly PoolSigner[],
): SealedPool => {
  const mine = rec.wrapped.find((w) => w.signerId === by.signerId);
  if (!mine) {
    throw new VaultPoolUnreadable(
      rec.vault,
      `signer ${by.signerId} holds no copy of this pool's key, so they cannot give one to ` +
      'anybody else');
  }
  const key = unwrapKey(mine.wrapped, by.wrappingSecret);
  const already = new Set(rec.wrapped.map((w) => w.signerId));
  return {
    ...rec,
    wrapped: [
      ...rec.wrapped,
      ...added
        .filter((s) => !already.has(s.id))
        .map((s) => ({ signerId: s.id, wrapped: wrapKey(key, s.wrappingPublicKey) })),
    ],
  };
};

/**
 * Where a sealed pool is kept. An interface for the reason `NotePool` is one:
 * this belongs in whatever store the customer already trusts with their sealed
 * state, not in a variable a class happens to hold.
 *
 * **`put` must never overwrite and never half-write**, exactly as
 * `SealedStateStore` must not, and for the same reason: a truncated record is
 * indistinguishable from a wrong key, and both read as "this vault is
 * unreadable" forever.
 */
export interface SealedPoolStore {
  get(vault: string): Promise<SealedPool | null>;
  put(vault: string, rec: SealedPool): Promise<void>;
}

/**
 * The pool `VaultLedger` actually uses, sealed and wrapped per signer.
 *
 * Constructed with ONE signer's identity, because a `NotePool` is used by a
 * process acting as somebody: the operator running this payout. It reads with
 * their secret and writes to every signer it is told about, so no operation
 * leaves the vault readable by fewer people than it was before.
 */
export class SealedNotePool implements NotePool {
  constructor(
    private store: SealedPoolStore,
    private me: { signerId: string; wrappingSecret: Hex },
    /** Everybody who must be able to open what this writes. */
    private signers: () => Promise<readonly PoolSigner[]>,
  ) {}

  /**
   * **AN ABSENT RECORD IS A REFUSAL, NOT AN EMPTY POOL.** `C197`'s rule, on the
   * pool rather than on a Zswap state.
   *
   * A vault with no pool record and a vault with no money are the same bytes
   * from here and opposite facts about a company's treasury. Answering `{notes:
   * []}` for the first would make `balance` report zero, `noteToSpend` say the
   * vault holds nothing of the token, and a reconciliation call every note the
   * chain holds an unexplained one. A brand-new vault is initialised with
   * `create` below, which says so out loud.
   */
  async load(vaultAddress: string): Promise<VaultNotes> {
    const rec = await this.store.get(vaultAddress);
    if (!rec) {
      throw new VaultPoolUnreadable(
        vaultAddress,
        'the store has no pool for it at all. A vault that has never had one is initialised ' +
        'with create(); a vault that had one and now does not is the store having lost it, ' +
        'and those are not the same event');
    }
    return openPool(rec, this.me.signerId, this.me.wrappingSecret);
  }

  /**
   * Writes the pool, sealed afresh, wrapped to every current signer.
   *
   * The version is taken from what is there rather than counted here, so two
   * processes that both read version 4 cannot both write version 5 — the store
   * is what refuses, because the store is the only thing that sees both.
   */
  async save(vaultAddress: string, notes: VaultNotes): Promise<void> {
    const rec = await this.store.get(vaultAddress);
    if (!rec) {
      throw new VaultPoolUnreadable(
        vaultAddress,
        'there is no pool to advance. Saving one here would create a vault record out of a ' +
        'single operation, and a pool that begins mid-history is a pool missing every note ' +
        'before it');
    }
    await this.store.put(
      vaultAddress, sealPool(vaultAddress, notes, await this.signers(), rec.version + 1));
  }

  /**
   * The first pool a vault ever has. Separate from `save` on purpose: creating
   * and advancing are different acts and only one of them is allowed to invent
   * a starting point.
   */
  async create(vaultAddress: string, notes: VaultNotes): Promise<void> {
    if (await this.store.get(vaultAddress)) {
      throw new Error(
        `${vaultAddress} already has a note pool. Creating a second would replace the record ` +
        'of every note it holds with whatever this caller happened to know about');
    }
    await this.store.put(vaultAddress, sealPool(vaultAddress, notes, await this.signers(), 1));
  }
}

/**
 * The smallest store with the right properties. Good enough to run on, and
 * deliberately not more: moving to the customer's own store later replaces this
 * class and nothing else.
 */
export class MemorySealedPoolStore implements SealedPoolStore {
  private byVault = new Map<string, SealedPool>();

  async get(vault: string): Promise<SealedPool | null> {
    return this.byVault.get(vault) ?? null;
  }

  async put(vault: string, rec: SealedPool): Promise<void> {
    const existing = this.byVault.get(vault);
    if (existing && rec.version <= existing.version) {
      /*
       * **REFUSED, NOT MERGED.** Two beliefs about which notes a vault holds
       * have no correct combination: the union invents notes the chain never
       * had and the intersection drops ones it does. The recoverable answer is
       * to stop and reconcile against the chain.
       */
      throw new Error(
        `refusing to write version ${rec.version} of ${vault}'s pool over version ` +
        `${existing.version}. Another process has advanced this pool since it was read, and ` +
        'there is no correct merge of two disagreeing records of which notes exist — ' +
        'reconcile against the chain with replayVault and write once');
    }
    this.byVault.set(vault, rec);
  }
}
