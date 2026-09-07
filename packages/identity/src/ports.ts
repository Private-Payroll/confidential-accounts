import type { Passkey } from './passkey/verify.js';
import type { PayeeAddress } from './wallet/address.js';

/**
 * WHAT A HOST HAS TO SUPPLY. `ARCHITECTURE.md`: the core performs no input or
 * output, so everything that touches a disk, a network or a platform is an
 * interface here and an implementation somewhere else.
 *
 * The standalone wallet supplies one set. The payroll product supplies its own
 * — it already has a server, a session and a place for sealed blobs, and it
 * should keep using them rather than inherit a second opinion.
 */

/**
 * A challenge is a one-use random value that makes a sign-in un-replayable.
 *
 * **One use is the whole point, and it is this interface's job, not the
 * verifier's.** `verifyAssertion` checks that the challenge presented is the one
 * expected; only something with memory can check it has not been presented
 * before.
 *
 * AND THIS IS NOT A SIDE POINT. `verify.ts` names two defences against a
 * replayed sign-in, and the other one — the sign counter — **is off for almost
 * everybody**: a synced passkey reports zero for ever, and §1 depends
 * on passkeys syncing. So this interface is the whole defence. An
 * implementation whose `take` always returns true passes every test in this
 * library while one captured request signs in for ever.
 *
 * `MemoryChallengeStore` implements it, and `everyChallengeStoreMustPass` in
 * `passkey/challenges.test.ts` is the conformance suite to run your own against.
 */
export interface ChallengeStore {
  /** Mint a challenge, remember it, and return it base64url-encoded. */
  issue(purpose: 'register' | 'sign-in'): Promise<string>;
  /**
   * Consume it. Returns false if it was never issued, has already been taken,
   * or has expired — and all three mean the same thing to a caller: refuse.
   */
  take(challenge: string, purpose: 'register' | 'sign-in'): Promise<boolean>;
}

/**
 * Where registered passkeys live.
 *
 * `save` is called after a registration and again after every sign-in, because
 * the sign counter moves. **A host that does not persist the updated counter
 * has switched off the clone detector**, silently, which is why the counter is
 * part of the record rather than a separate call.
 */
export interface PasskeyStore {
  /**
   * Look one up by its id.
   *
   * **This does not tell you whose it is.** A `Passkey` carries a
   * `personHandle`, and `verifyAssertion` refuses when the sign-in names a
   * different one — so the person comes from the verified result and never from
   * the request.
   */
  byCredentialId(credentialId: string): Promise<Passkey | null>;
  forPerson(personId: string): Promise<readonly Passkey[]>;
  save(personId: string, passkey: Passkey): Promise<void>;
  /**
   * **Removing somebody's last passkey is removing their way in.**
   * §1 is "passkey and nothing else" and recovery is not built yet, so a host
   * calling this on a sole credential should say what happens next before it
   * does, not after.
   */
  remove(credentialId: string): Promise<void>;
}

/**
 * WHERE A RECOVERY PIECE LIVES. §7.10 — a piece has a **home** and a
 * **lock**, and they are separate things. This is the home.
 *
 * The library ships no implementation that reaches a server of ours. The
 * standalone wallet supplies self-custody homes only; the payroll product may
 * supply one of its own (§7.9), under the rule that whatever a host holds is
 * never enough and never necessary (§7.2).
 */
export interface PieceHome {
  /**
   * Who ultimately controls this place — a Google account id, `device`,
   * `paper`. Used to enforce *no two pieces behind the same account*, so two
   * homes that answer the same string are one home.
   */
  readonly holder: string;
  put(id: string, piece: Uint8Array): Promise<void>;
  get(id: string): Promise<Uint8Array | null>;
  /**
   * Is it still there? Returns null when the home cannot be asked — paper
   * cannot — and that is shown as unknown rather than as fine. §1.
   */
  check(id: string): Promise<boolean | null>;
}

/**
 * WHAT OPENS A PIECE. §7.10 — the lock, separate from the home.
 *
 * Only one lock ships: another Midnight wallet, which publishes an encryption
 * key as half of every address. Outside wallets are deferred until the
 * sign-twice determinism check exists, because a wallet that signs differently
 * the second time destroys the piece silently.
 */
export interface PieceLock {
  readonly kind: string;
  lock(piece: Uint8Array): Promise<Uint8Array>;
  unlock(locked: Uint8Array): Promise<Uint8Array>;
}

/**
 * WHERE A DEVICE KEEPS ITS OWN COPY of a person's keys, encrypted.
 *
 * §7.1: what encrypts it is a key the browser will not hand back —
 * so a host implementing this stores a blob it **cannot export, and can use only
 * while the page that made the key is open.** That is a narrower claim than it
 * first sounds and the narrower one is the true one: non-extractable stops the
 * key being carried off the device; it does not stop a script on the page using
 * it. An XSS on the origin, or anyone with the unlocked browser profile, reads
 * the blob without any ceremony. The passkey gates the interface; this gates
 * the bytes; **they are not connected**, and nothing here should be described as
 * though they were.
 */
export interface KeyringStore {
  read(): Promise<{ sealed: Uint8Array; version: number } | null>;
  /** Refuses if `ifVersion` is not the version on disk. Returns the new one. */
  write(sealed: Uint8Array, ifVersion: number): Promise<number>;
}


/**
 * READING A WALLET — balance, history, the address. This is what is implemented.
 *
 * **Nothing here is named or typed as read-only**, deliberately. There is no
 * `ReadOnlyWallet` and no `canSend: false`, because a type that encodes the
 * limitation has to be unpicked from every call site the day the limitation
 * goes. The wallet is a wallet; this is the reading half of it.
 */
export interface WalletReader {
  address(): PayeeAddress;
  /** What is there now, in the smallest unit the asset counts in. */
  balance(asset: string): Promise<bigint>;
  /** What has arrived, newest first. */
  history(options?: { readonly limit?: number }): Promise<readonly Received[]>;
}

export interface Received {
  readonly asset: string;
  readonly amount: bigint;
  /** When the chain settled it, milliseconds since the epoch. */
  readonly at: number;
  /** The transaction it arrived in. */
  readonly transaction: string;
}

/**
 * SENDING. **Declared and not implemented**, on purpose.
 *
 * Sending arrives later and must arrive without anything being rebuilt, so the
 * seam exists from the first line of code. What must NOT be done in the name of
 * preparing for it is building the facade, the proof server wiring or dust
 * handling before anything uses them — `ARCHITECTURE.md`. **The rule is that
 * the seam exists, not that the machinery does.**
 */
export interface WalletSpender {
  send(to: PayeeAddress, asset: string, amount: bigint): Promise<string>;
}
