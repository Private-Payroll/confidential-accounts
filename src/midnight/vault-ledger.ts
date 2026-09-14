/**
 * THE VAULT, FROM THE CLIENT. V-74.
 *
 * A second contract binding, not a second mechanism. `MidnightLedger` is tied
 * to one compiled artefact and one `zkConfigPath`; the vault is a different
 * compiled contract, so it needs its own deployed handle. Everything else —
 * providers, the sponsor, fee balancing — is shared, because none of it knows
 * or cares which contract it is carrying.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO: RESOLVE THE ACCOUNT
 *
 * `payout` calls the account's `recordPayment`, and every offline test in this
 * repo builds that call by hand with a `ContractStateProvider` so the runtime
 * can read the callee. **The client needs none of it.** midnight-js supplies
 * the provider itself, on every call, unconditionally: both call sites in
 * `createUnprovenCallTx` pass `{ publicDataProvider, blockHash }`, and the
 * resolver fetches each callee lazily, at the point the circuit calls it,
 * pinned to the block the root contract's state was read at.
 *
 * Measured in `node_modules` rather than assumed — see the MEASURED HERE block
 * in `docs/midnight/03-midnight-js.md`. Reading the test's hand-built provider
 * as a preview of the client would have produced a plumbing layer that already
 * exists, and would have got the block pinning wrong.
 *
 * So this file never mentions the account's address. The VAULT pins it, in its
 * own ledger state, at construction (V-37) — which is also what stops anybody
 * pointing a vault at a contract that would answer "approved, pay me".
 */
import type { Hex } from '../core/crypto.js';
import { recipientOf, type Payee, type PayeeAddress } from './payee-address.js';
import { arityFrom, assertArity } from './circuit-arity.js';
import { fromHex, toHex } from '../core/crypto.js';
import type { MidnightConfig, FeeSponsor } from './ledger.js';
import type { SignerRef, TxRef } from '../core/ledger.js';
import {
  witnessesOver, witnessesWithoutAPool, afterDeposit, afterPayment, noteToSpend, paymentsFit,
  withIndexRead,
  type VaultNotes, type Note,
} from './vault-notes.js';
import { changeCoinOf } from './vault-coins.js';
import {
  NoteIndexUnaskable, indexForSpend, noteIndexFrom,
  theTransactionTheseEventsAreFrom, vaultNoteCommitment,
  type ChainReadIndex, type NoteEvents,
} from './note-index.js';
import { assertVaultLedgerIsThisBuilds } from './vault-ledger-shape.js';
import { commitmentForNote } from './vault-recovery.js';
import { isALostPoolRace } from './vault-pool.js';

/** One payment, exactly as `PayrollRun.payeeArgs` hands it over. */
export interface VaultPayment {
  proposal: Hex;
  root: Hex;
  payees: bigint;
  opensAt: bigint;
  closesAt: bigint;
  salt: Hex;
  /**
   * WHO IS PAID — ONE VALUE CARRYING BOTH KEYS. A-1, and it closes V-80.
   *
   * This used to be `recipient: Hex` (the coin key, which goes to the circuit)
   * beside `payslipKey: Hex` (the encryption key, which does not — it rides on
   * the transaction in `additionalCoinEncPublicKeyMappings` and is what makes
   * the payment visible in the payee's own wallet).
   *
   * **Two fields meant they could disagree, and the disagreement was silent:**
   * omit the encryption key and midnight-js refuses to build the transaction,
   * which is the platform protecting us; supply the WRONG one and the payment
   * settles perfectly into a coin the payee's wallet will never show them, with
   * nothing anywhere objecting.
   *
   * One value, one decode, and that pairing cannot be wrong. A wrong address is
   * now a wrong RECIPIENT — loud and ordinary. `V-78` is what remains: this
   * does not stop the wrong person's correct address.
   */
  /**
   * **AND IT CARRIES THE KIND, WHICH IS WHAT DECIDES THE CIRCUIT.** `C246`,
   *
   *
   * `Payee` is a union whose tag came out of the same decode as the 32 bytes
   * that go to the circuit. `payout` reads it and dispatches; **there is no
   * argument here, and no method to choose, by which a caller could name one
   * kind for a payee who is the other.** That matters more here than anywhere
   * else in this file: the two are both `{ bytes: Bytes<32> }` at the kernel,
   * so nothing downstream of raw bytes can tell them apart, and an unshielded
   * send to a Zswap coin public key removes the money permanently.
   */
  payee: Payee;
  token: Hex;
  amount: bigint;
  blinding: Hex;
  nonce: Hex;
  /** The payee's merkle path, in the shape the circuit takes. */
  path: unknown;
}

/**
 * **WHAT A SETTLED PAYMENT HANDS BACK, AND THE TWO KINDS DO NOT HAND BACK THE
 * SAME THING.**
 *
 * A shielded payment spends a note and produces a change note, so it reports
 * which note the contract actually took — the value the pool is advanced by,
 * read back rather than assumed. **An unshielded payment spends
 * nothing**: the ledger subtracts a number. There is no note to name, and a
 * `spentNote` of `undefined` beside a `kind` would be a field whose absence a
 * caller has to interpret.
 *
 * So it is a union, and a caller that wants the note has to establish which
 * kind of payment it made. That is one line at the call site and it is the line
 * that stops a pool being advanced by a payment that never touched one.
 */
export type VaultPaid =
  | (TxRef & { kind: 'shielded'; spentNote: Hex })
  | (TxRef & { kind: 'unshielded' });

/**
 * **WHAT A DEPOSIT LEAVES BEHIND, INCLUDING WHETHER THE NOTE IT MADE CAN BE
 * SPENT.**
 *
 * A note is spent by proving where the chain filed it, which is read from the
 * transaction that created it. **A note whose pool entry records no transaction
 * is money the vault owns and cannot pay out** - repairable, and not by
 * anything that happens automatically. So a deposit says which transaction it
 * recorded, where that came from, and, when it recorded none, why.
 *
 * `recordedFrom` is not decoration. `'nowhere'` is the one outcome a person has
 * to act on, and before this it was indistinguishable on screen from the other
 * two.
 */
export interface VaultDeposited extends TxRef {
  /** The transaction the note records, by its 32-byte hash. Absent when none could be. */
  readonly createdIn?: Hex;
  /** Where it came from: the call's own answer, the chain, or nothing did. */
  readonly recordedFrom: 'the call' | 'the chain' | 'nowhere';
  /** Why nothing could be recorded. Present exactly when `recordedFrom` is `'nowhere'`. */
  readonly stranded?: string;
  /**
   * **WHETHER READING AGAIN COULD ANSWER, WHICH DECIDES WHAT A PERSON DOES
   * NEXT.**
   *
   * An indexer a moment behind a node and an indexer this client can no longer
   * ask are two different situations with two different acts: wait and repair
   * the note when it catches up, or bring the client and the indexer back into
   * step first. They used to read the same on screen, so somebody told to wait
   * for an answer that would never come waited.
   *
   * Absent means retryable, which is the safe default: telling somebody to stop
   * waiting for an answer that WOULD have come is worse than the other way
   * round, because a note whose place is never read is money nobody reaches.
   */
  readonly permanent?: boolean;
}

/**
 * **WHICH STORED VERSION OF WHICH VAULT'S POOL A LOAD READ.** Made by a pool's
 * `load` and handed back to its `save`; nothing else has a reason to make one.
 */
export interface PoolVersion {
  readonly vault: string;
  readonly version: number;
}

/** A pool as loaded: its notes, and the version they were read at. */
export interface LoadedNotes extends VaultNotes {
  readonly readAt: PoolVersion;
}

/** Only the notes, so what is sealed is never the load's own bookkeeping. */
const notesOf = (pool: VaultNotes): VaultNotes => ({ notes: pool.notes });

/**
 * Where the vault's note pool lives between calls.
 *
 * An interface rather than a field because the pool is the money: it belongs in
 * whatever store the customer already trusts with their sealed state, not in a
 * variable this class happens to hold. `load` is called before every operation
 * so two processes cannot both work from a copy taken at start-up.
 *
 * **THE IMPLEMENTATION IS `SealedNotePool` IN `src/midnight/vault-pool.ts`.**
 * `S6d`, and until it existed this interface had exactly one implementation and
 * it was inside a test — so the pool, which is the money, had no home at all.
 * It is sealed under a fresh key per write and that key is **wrapped per
 * signer**, never derived from the account viewing key: a purpose key comes
 * from the viewing key, the viewing key crosses the wire to our server on the
 * vault-threshold routes, and the pool is nonces, tokens and **values**. Read
 * the header of that file before adding a seventh `Purpose`.
 */
export interface NotePool {
  /**
   * The pool as it stands, and the version that was read. **The version is what
   * a write built on this read must hand back**, so a write can never land on a
   * pool that moved after the decision it records was made.
   */
  load(vaultAddress: string): Promise<LoadedNotes>;
  /**
   * **ADVANCES THE POOL FROM THE VERSION ITS WRITE WAS BUILT ON, AND FROM NO
   * OTHER.**
   *
   * `builtOn` is the `readAt` of the load whose notes this write was decided
   * from. A private payment loads, proves for a minute or more, submits, and
   * then writes the change note; a deposit does the same. If another process
   * advanced the pool in that minute, a version taken at the moment of writing
   * would make the older copy win and erase the newer write with no trace, and
   * a change note is the vault's own money coming back. So the implementation
   * refuses unless the stored version is still `builtOn`, and nothing is
   * written.
   */
  save(vaultAddress: string, notes: VaultNotes, builtOn: PoolVersion): Promise<void>;
  /**
   * The FIRST pool a vault ever has. `C242`, and it is on this interface rather
   * than only on the implementation because until `S6f` nothing could reach it.
   *
   * **Separate from `save` on purpose, and the separation is the safety.**
   * `save` refuses to create — *"a pool that begins mid-history is a pool
   * missing every note before it"* — and `create` refuses to overwrite. Two
   * verbs, two refusals, and no single call can do the wrong one of them.
   *
   * **Whoever implements this holds signer key material**, because a pool is
   * sealed under a fresh key wrapped to each signer and `sealPool` refuses a
   * pool wrapped to nobody (`V-91`). That is why `scripts/deploy-vault.ts`
   * cannot call it and why the deploy deliberately does not create one.
   */
  create(vaultAddress: string, notes: VaultNotes): Promise<void>;
}

/**
 * WHAT ONE CIRCUIT CALL IS, before any of it reaches the SDK. V-82.
 *
 * Separated out because the fault this fixes was invisible: the arguments and
 * the encryption mapping were assembled and handed to midnight-js in one
 * breath, in a shape midnight-js does not read, and the only thing that ever
 * checked the shape was our own fake. **A plan can be asserted on without a
 * node, a proof server or a stub pretending to be either.**
 */
export interface CallPlan {
  circuit: string;
  /** EXACTLY the circuit's own arguments. A transaction context is not one. */
  args: unknown[];
  /** coin public key → encryption public key. What tells a payee they were paid. */
  mappings: ReadonlyMap<string, string>;
}

/**
 * Builds the plan for one call. Pure, and therefore assertable without a node.
 *
 * The mapping is built even when empty rather than conditionally, so there is
 * one code path rather than two and a payout cannot be assembled by the branch
 * that has no mapping.
 *
 * **It is NOT true that an empty map behaves differently from no map**, and an
 * earlier version of this comment said it did. `createEncryptionPublicKeyResolver`
 * maps `undefined` and an empty `Map` to the same thing, and the lookup is
 * `mappings?.get(cpk)` either way. The reason is one path, not two behaviours —
 * a plausible-sounding rationale beside correct code is exactly what this repo
 * has paid for more than once.
 */
export const planCall = (
  circuit: string, args: unknown[], encryptionKeys?: Record<string, Hex>,
): CallPlan => ({
  circuit,
  args: [...args],
  mappings: new Map(Object.entries(encryptionKeys ?? {})),
});

/**
 * **WHY NONE OF THE REFUSALS BELOW NAMES THE VAULT IT IS ABOUT. `C236`.**
 *
 * Every one of them used to end `(vault <64 hex>)`, which reads as helpful and
 * is the one value in this system that destroys money when a person acts on it:
 * a plain send to a vault's address is owned by the vault and spendable by
 * nobody, permanently, and no contract can refuse it. `S6e` decided a vault is
 * identified to people by a NAME and enforced it for the deploy report's own
 * lines — but **an error message is a screen too, and it reaches one by a route
 * the guard cannot cover**: an instrument's failure block deliberately does not
 * go through `createScreen`, because an error thrown from inside the guard
 * would make the failure unprintable.
 *
 * So the address is removed from the WORDS and kept as the `vaultAddress`
 * PROPERTY, which is where a caller that genuinely needs it looks. Nothing that
 * prints an error prints a property it did not ask for — except a whole-object
 * serialiser, which is why every instrument that uses one redacts.
 *
 * The cost is real and small: an operator running two vaults sees a refusal
 * that does not say which. The instrument knows the NAME and says it, which is
 * the identifier the whole product is built on.
 */
const WHICH_VAULT =
  ' (the vault is not named here: its address is the one value that destroys money when '
  + 'somebody pastes it into a wallet, and an error message is a screen — C236. The caller '
  + 'holds it as this error\'s `vaultAddress` property, and an instrument names the vault by '
  + 'the NAME it was deployed under.)';

/**
 * **THE CHAIN COULD NOT BE READ, WHICH IS NOT THE SAME AS THE CHAIN SAYING NO.**
 * `C198`, and `C110` is the measurement that makes it a separate class.
 *
 * A transaction the node had finalised read as `not found` to the indexer 168ms
 * later. So *"we could not check"* and *"the chain disagrees"* have opposite
 * consequences — the first is retried, the second is investigated and nothing
 * is paid until it is — and a caller that cannot tell them apart will do the
 * wrong one of those two things.
 */
export class VaultChainUnreadable extends Error {
  constructor(
    readonly vaultAddress: string,
    why: string,
    /**
     * **WHICH OF THE VAULT'S TWO BALANCES COULD NOT BE READ.** `S6k`, and the
     * reason it is a parameter rather than a second class.
     *
     * A caller must NOT be able to act on the difference — *"we could not
     * check"* has one consequence whichever half of the vault it is about, and
     * that is the whole reason this class is separate from
     * `VaultPoolDisagreesWithChain`. So there is one class and one
     * `catch`. What differs is only the sentence a person reads, and the two
     * sentences are not interchangeable: on the private side there IS a local
     * number and withholding it is the deliberate act; on the public side
     * **there is no local number at all**, because the chain's own figure is
     * the only record there has ever been.
     */
    about: 'note-pool' | 'public-balance' = 'note-pool',
  ) {
    super(
      `this vault's balance cannot be confirmed, because the chain could not be read: ${why}. ` +
      (about === 'note-pool'
        ? '**No local number is returned, deliberately** — the pool alone is our bookkeeping ' +
          'and not the money, and a balance nothing has reconciled is the thing this refusal ' +
          'exists to stop being shown. '
        : '**There is no local number to fall back to, and that is the design rather than a ' +
          'gap** — a contract\'s unshielded balance is the LEDGER\'s own figure, per contract ' +
          'per colour, and this client keeps no second copy of it (C245, S6j). ') +
      'This is NOT the chain disagreeing; it is us not knowing. Retry, ' +
      'and if it persists look at the indexer rather than the pool.' + WHICH_VAULT);
    this.name = 'VaultChainUnreadable';
  }
}

/**
 * **THE POOL AND THE CHAIN DISAGREE, SO THERE IS NO BALANCE TO REPORT.**
 *
 * Not a smaller balance and not a caveated one. The pool is our record of which
 * notes exist; the chain holds the commitments. When they differ, the vault's
 * spendable balance is unknown until somebody reconciles them, and a number
 * shown in the meantime is one a payroll run would be sized against.
 */
export class VaultPoolDisagreesWithChain extends Error {
  constructor(readonly vaultAddress: string, detail: string) {
    super(
      `this vault's pool disagrees with the chain, so it has no balance to report: ${detail}. ` +
      'Rebuild the pool from the chain before spending — see replayVault in ' +
      'src/midnight/vault-recovery.ts.' + WHICH_VAULT);
    this.name = 'VaultPoolDisagreesWithChain';
  }
}

/**
 * **A RUN THAT CANNOT BE PAID OUT OF THIS VAULT, FOR ANY OF THREE REASONS.**
 *
 *
 * One type rather than three, deliberately. The three reasons are
 * distinguishable — `cause` carries the original — but a caller must not be
 * able to act on the difference, because there is no version of *"the chain
 * could not be read"* or *"the pool disagrees with the chain"* that means it is
 * safe to start paying people. **EITHER REFUSAL IS `cannot afford`**, and the
 * failure this replaces is a caller that reads a refusal, decides it was only a
 * read problem, and starts a run against an unreconciled pool: it pays until it
 * stops, mid-run, and the person who goes unpaid is picked at random.
 */
export class VaultCannotAfford extends Error {
  constructor(
    readonly vaultAddress: string,
    readonly why: 'chain-unreadable' | 'pool-disagrees' | 'notes-do-not-cover'
      /**
       * **THE PUBLIC SIDE'S ONLY SHORTFALL, AND IT IS A SUM.**
       *
       * There is no `public-balance-disagrees`, because there is nothing local
       * that could disagree — see `unshieldedBalance`. And there is no note
       * arithmetic: an unshielded balance is one number the ledger subtracts
       * from, so a total IS the question here, which is exactly what it is not
       * on the private side (`C203`, `noteToSpend` does not merge).
       */
      | 'public-balance-short',
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(
      `this run cannot be paid out of this vault (${why}): ${detail} — so nothing is submitted. ` +
      '**A run started against a pool nothing has reconciled pays until it stops**, and it ' +
      'stops mid-run: the payees before the shortfall are paid, the ones after are not, and ' +
      'the split is arbitrary.' + WHICH_VAULT, options);
    this.name = 'VaultCannotAfford';
  }
}

/**
 * **THIS VAULT ALREADY HOLDS NOTES, SO ITS POOL CANNOT BE STARTED EMPTY.**
 * `C242`, and it is the refusal that keeps `C242`'s fix from becoming `S6d`'s
 * confusion.
 *
 * An empty pool and an unreadable pool are opposite claims about a company's
 * treasury, and `SealedNotePool` keeps them apart on the READ side: an absent
 * record throws, never `{notes: []}`. Creating one is the other side of the
 * same rule, and it is where the confusion could be MANUFACTURED — a vault
 * whose pool record was lost is a vault for which `create` succeeds and writes
 * a truthful-looking empty pool over a treasury that is not empty. `balance`
 * would then report zero and every note on chain would be unexplained.
 *
 * So an empty pool may only be created for a vault the CHAIN agrees is empty.
 */
export class VaultAlreadyHoldsNotes extends Error {
  constructor(readonly vaultAddress: string, holds: bigint) {
    super(
      `refusing to start an EMPTY note pool for a vault whose on-chain set holds ${holds} ` +
      'note(s). An empty pool is a claim that this vault has no money, and writing one here ' +
      'would make that claim about a treasury that exists: balance would report zero and every ' +
      'commitment on chain would read as unexplained. **This is not a new vault** — it is a ' +
      'vault whose pool record is missing, which is what replayVault ' +
      '(src/midnight/vault-recovery.ts) rebuilds, from the chain and the payment history. ' +
      WHICH_VAULT);
    this.name = 'VaultAlreadyHoldsNotes';
  }
}

export class VaultLedger {
  constructor(
    private cfg: MidnightConfig,
    private sponsor: FeeSponsor,
    /**
     * The provider bundle.
     *
     * **CALLED TWICE PER CIRCUIT CALL** — once by `connect` to read state and
     * once by `scopedCall` to prove, balance and submit — so it MUST be
     * memoised by whoever supplies it, exactly as `MidnightLedger`'s is
     * ("built once by `midnightProviders()`"). An unmemoised factory opens a
     * second private-state store per call and balances with a different wallet
     * handle than the one whose coin key went into the transaction.
     */
    private providers: () => Promise<any>,
    /** The vault's CompiledContract. NOT the account's. */
    private compiled: unknown,
    private pool: NotePool,
    /**
     * Where the VAULT's compiled artefacts are — `contracts/managed-vault`, not
     * the account's `contracts/managed`.
     *
     * Required rather than read off `cfg`, because `cfg.zkConfigPath` is the
     * ACCOUNT's, and a guard pointed at the wrong contract's ABI is confidently
     * wrong, which is worse than absent. V-82.
     */
    private vaultZkConfigPath: string,
  ) {}

  /**
   * Connects with the witnesses attached WHERE THE SDK READS THEM. V-82.
   *
   * The previous version assigned `witnesses` to the object `findDeployedContract`
   * returned. **They belong to the `CompiledContract`** — `ledger.ts` has always
   * done it that way — so the assignment was inert against the real SDK,
   * `pending.spending` was never set, and every payout ended at our own guard
   * telling the operator to rebuild the pool from the chain: an error confidently
   * wrong about what went wrong.
   *
   * `withWitnesses` returns a NEW compiled contract rather than mutating one, so
   * binding per call costs an object and keeps all three properties that were
   * bought expensively: the pool loaded fresh, read through a getter, and
   * the note the contract actually took reported back rather than assumed.
   *
   * ----------------------------------------------------------------------
   * **THE FIND IS THE VAULT'S OWN NOW, AND IT IS NEITHER OF THE OTHER TWO.**
   *
   *
   * This used to call the SDK's `findDeployedContract` directly. Two things
   * are wrong with that and only the second is obvious:
   *
   *   · **It samples and stores a signing key** for any address the private
   *     state store holds none for (`setOrGetInitialSigningKey`,
   *     `midnight-js-contracts/dist/index.mjs:1951-1963`) — so merely READING
   *     a vault filed a key under the vault's address that maintains nothing,
   *     in the exact slot a later `replaceAuthority` reads the real one from.
   *
   *   · **It never checks the contract is a vault at all.** Pointed at an
   *     account it fails on verifier keys, generically, naming circuits
   *     nobody called — `C231`'s shape one contract along.
   *
   * `findDeployedVaultContract` (`src/midnight/vault-contract.ts`) keeps
   * `M-9`'s byte-for-byte key comparison through the SDK's own
   * `verifyContractState`, refuses an operations map that is not exactly the
   * vault's own — saying so by name when the address is an account — sets
   * the private-state address from the vault the call is for before anything
   * reads, and stores nothing.
   *
   * **It is NOT `findDeployedPartialContract`**, which refuses a full
   * deployment by design because the account's deployment is partial and a
   * vault's is not.
   */
  private async connect(address: string, witnesses: unknown) {
    const [{ findDeployedVaultContract }, CompiledContract] = await Promise.all([
      import('./vault-contract.js'),
      import('@midnight-ntwrk/compact-js').then(m => (m as any).CompiledContract),
    ]);
    const withWitnesses = CompiledContract.withWitnesses(this.compiled as any, witnesses as any);
    return findDeployedVaultContract(await this.providers() as any, {
      compiledContract: withWitnesses as any,
      contractAddress: address,
    });
  }

  /**
   * **HOW MANY TIMES A WRITE THAT LOST A RACE IS RE-DERIVED AND FILED AGAIN.**
   *
   * Attempts rather than a deadline, because each one is a local read, a seal and
   * a filing — no network and no proof — so a wall-clock budget would be
   * measuring the wrong thing. Five, and losing five in a row is not contention
   * between three writers; it is something wrong that another attempt will not
   * mend, so the fifth failure is reported rather than hidden behind a sixth.
   */
  private static readonly POOL_WRITE_ATTEMPTS = 5;

  /**
   * **ADVANCES THE POOL BY A CHANGE, APPLIED TO WHAT THE POOL HOLDS NOW.**
   *
   * Every writer here records a DIFFERENCE: a deposit adds one note, a payment
   * takes one away and puts its change back. **A difference can be applied to a
   * pool that has moved; a whole pool cannot.** That is the entire reason this
   * exists, and it is what turns losing a race from a report of lost money into
   * a second attempt that costs a millisecond.
   *
   * ------------------------------------------------------------------------
   * **THIS IS NOT THE DEFECT `save` WAS SHAPED TO REMOVE, AND THE DIFFERENCE IS
   * THE WHOLE POINT.** `vault-pool.ts` says the version used to be read at the
   * moment of writing, so a writer holding a copy from before a minute of proving
   * would read whatever version was there by then, add one, and erase the write
   * that came in between. **That defect was re-reading the VERSION while writing
   * STALE NOTES.** Here the notes are re-read with the version and the change is
   * applied to them, so the other writer's note is carried forward rather than
   * erased. `save`'s refusal is untouched and just as strict: it still takes the
   * version of the load its change was built on, and that load is now the one
   * immediately before the write.
   *
   * **WHAT MAKES RE-APPLYING SAFE IS THAT THE CHANGE REFUSES WHEN IT CANNOT BE
   * TRUE.** `afterDeposit` refuses a nonce the pool already holds; `afterPayment`
   * refuses a spent nonce the pool does not hold. So a change that has already
   * been applied, or that describes a pool this is not, throws out of `change`
   * rather than being written twice — and that throw is not caught here.
   *
   * **AND WHAT IS RETRIED IS DELIBERATELY NARROW.** Only the two refusals that
   * mean *nothing was written and the other writer's record is intact*
   * (`isALostPoolRace`). A damaged record or a store that cannot be reached says
   * nothing of the kind, and retrying a write into one of those is how a pool
   * gets written twice.
   */
  private async advancePool(
    vaultAddress: string,
    /** What is being recorded, in the product's own words, for the refusal below. */
    what: string,
    /**
     * The change, as a function of the pool as it stands. Called again on each
     * attempt, against a fresh load, and it must refuse rather than guess when
     * the pool it is handed cannot be the one the change belongs to.
     */
    change: (now: LoadedNotes) => VaultNotes,
  ): Promise<void> {
    let lost: unknown;
    for (let attempt = 1; attempt <= VaultLedger.POOL_WRITE_ATTEMPTS; attempt += 1) {
      const now = await this.pool.load(vaultAddress);
      try {
        await this.pool.save(vaultAddress, notesOf(change(now)), now.readAt);
        return;
      } catch (cause) {
        if (!isALostPoolRace(cause)) throw cause;
        lost = cause;
      }
    }
    /*
     * **THE MONEY HAS MOVED AND THE POOL DOES NOT RECORD IT.** Said in those
     * words, because that is the state, and every earlier draft of this sentence
     * described the retry instead of the consequence.
     */
    throw new Error(
      `${what} could not be recorded in this vault's note pool: another writer filed the next `
      + `version first on all ${VaultLedger.POOL_WRITE_ATTEMPTS} attempts, each of which read the `
      + 'pool again and applied this change to what it held. **Nothing has been written and '
      + 'nothing has been erased.**\n'
      + 'This matters because the money has already moved on chain and the pool is the only '
      + 'record of what a note IS — the chain publishes commitments, which disclose nothing. So '
      + 'the vault now holds money this machine cannot name, and a payment that would reach it is '
      + 'refused.\n'
      + 'Stop writing this pool from anywhere else, then rebuild it from the chain and the '
      + 'versions this pool has been written at: reconcileVaultPool in '
      + 'src/midnight/vault-recovery.ts. Losing this race five times running is not three writers '
      + 'being busy, so find what else is writing before running anything that spends.',
      { cause: lost });
  }

  /**
   * Calls a circuit on the vault and submits it.
   *
   * The pool is loaded fresh and the witnesses read it through a getter, so the
   * contract sees it as it stands at the moment of the call. A snapshot taken
   * when this class was constructed is the "can make exactly one payment"
   * defect wearing a closure — which has already happened once here.
   */
  private async call(
    address: string, circuit: string, args: unknown[],
    /**
     * The payees this call pays, as coin key → ENCRYPTION key. V-77.
     *
     * **This is what tells the payee they were paid.** midnight-js attaches a
     * coin ciphertext to every shielded output bound for a user, encrypted to
     * this key, and the payee's own wallet finds it — in `availableCoins` and in
     * its history, permanently, with no help from us.
     *
     * It is a TRANSACTION option rather than a circuit argument, so the
     * contract cannot check it. Two failures follow and they are not equal:
     * omit a key and midnight-js REFUSES to build the transaction; supply the
     * WRONG key and the payment settles into a coin the payee cannot see. The
     * first is the platform protecting us. The second is ours to prevent, and
     * it is why `PaymentFacts` carries the key rather than a call site
     * inventing one.
     */
    encryptionKeys?: Record<string, Hex>,
    /**
     * The index of the note this call spends, read from the chain just before
     * it. Applied to this call's copy of the pool and never saved: the next
     * spend reads it again.
     */
    readIndex?: { note: Note; index: ChainReadIndex },
  ): Promise<{ result: any; notes: VaultNotes; spent?: Hex; readAt: PoolVersion }> {
    const loaded = await this.pool.load(address);
    if (readIndex) {
      /*
       * The index was read for one coin. If the pool now holds something else
       * under that nonce, that index belongs to nothing here.
       */
      const now = loaded.notes.find((n) => n.nonce === readIndex.note.nonce);
      if (!now || now.token !== readIndex.note.token || now.value !== readIndex.note.value
        || now.createdIn !== readIndex.note.createdIn) {
        throw new Error(
          `the vault's note ${readIndex.note.nonce} changed or left the pool while its place in the `
          + 'chain\x27s commitment tree was being read. Nothing is proved or paid. Pay again, and '
          + 'the note will be chosen and read afresh.');
      }
    }
    /*
     * **ONE NOTE CARRIES AN INDEX FOR THIS CALL, AND IT IS THE ONE WHOSE INDEX
     * WAS JUST READ.** Any index the pool holds for any other note is dropped
     * from this copy, so if the pool changed after the note was chosen and the
     * witness picks a different one, that note has no index and the witness
     * refuses it by name rather than spending at a number nobody read.
     */
    const notes = readIndex
      ? withIndexRead(
        { ...loaded, notes: loaded.notes.map(({ index: _notReadHere, ...n }) => n) },
        readIndex.note.nonce, readIndex.index)
      : loaded;
    const pending: { spending?: Hex } = {};

    /*
     * The witnesses are bound per call rather than per contract, because
     * `pending.spending` is the answer to "which note did the contract
     * actually take" — and a client that assumed which note was spent would
     * drift from the chain on the first payment where the assumption was wrong.
     */
    const result = await this.submit(
      address, planCall(circuit, args, encryptionKeys),
      witnessesOver(() => notes, pending));

    return { result, notes, spent: pending.spending, readAt: loaded.readAt };
  }

  /**
   * **ONE CIRCUIT CALL THAT NEVER TOUCHES THE NOTE POOL.** `C245`, `C242`,
   *
   *
   * `call` above loads the pool first, because a shielded circuit reads
   * `noteToSpend` and the pool is where the answer is. **The three unshielded
   * circuits read no witness at all** — public money is a ledger balance — so
   * loading one would make a public deposit require the very record a new
   * vault has not got, which is `C242` gating a path it has nothing to do with.
   *
   * **THIS IS WHY IT IS A SECOND METHOD RATHER THAN A FLAG ON THE FIRST.** A
   * boolean would leave the load in the code path, one refactor away from
   * being unconditional again, and the test that proves the difference —
   * driving a public deposit against a pool whose every method throws — would
   * still pass a version that loaded it inside an `if`. There is no branch
   * here to get wrong: this method has no `this.pool` in it.
   *
   * The witnesses it binds REFUSE rather than answer. See
   * `witnessesWithoutAPool`.
   */
  private async callWithoutPool(
    address: string, circuit: string, args: unknown[],
  ): Promise<{ result: any }> {
    /*
     * NO ENCRYPTION MAPPING, and its absence is a fact rather than an omission:
     * `V-77`'s obligation exists so a payee's wallet can find a shielded coin,
     * and an unshielded UTXO is public — the payee's wallet finds it by
     * looking. `planCall` builds an empty map, which midnight-js treats
     * identically to none.
     */
    const result = await this.submit(
      address, planCall(circuit, args), witnessesWithoutAPool());
    return { result };
  }

  /**
   * Arity, connect, dispatch — the part both call paths share, and nothing
   * about a pool.
   *
   * Factored so the two paths cannot drift on the guard that matters: `M-104`
   * is this project's standing reason never to write a rule the money depends
   * on twice, and an arity check that had been copied would be one circuit
   * behind on whichever copy was forgotten.
   */
  private async submit(
    address: string, plan: CallPlan, witnesses: unknown,
  ): Promise<any> {
    /*
     * ARITY, AGAINST THE VAULT'S OWN DECLARED ABI. V-82.
     *
     * This is the guard `ledger.ts` has had since M-38 and this client did not,
     * and its absence is exactly how an options object became a thirteenth
     * argument to a circuit that declares twelve. It counts the CIRCUIT's
     * arguments — the transaction context is the SDK's and is not one of them.
     */
    assertArity(arityFrom(this.vaultZkConfigPath), plan.circuit, plan.args.length);

    const contract = await this.connect(address, witnesses);
    const fn = (contract.callTx as any)[plan.circuit];
    if (typeof fn !== 'function') {
      throw new Error(`the deployed vault has no circuit "${plan.circuit}"`);
    }

    /*
     * THE MAPPING TRAVELS IN A TRANSACTION CONTEXT, FIRST, AND NOWHERE ELSE. V-82.
     *
     * midnight-js reads it in exactly one place — `createCircuitCallTxInterface`,
     * `midnight-js-contracts/dist/index.mjs:1879-1886`:
     *
     *     const txCtx = args.length > 0 && isTransactionContext(args[0]) ? args[0] : undefined;
     *     const callArgs = txCtx ? args.slice(1) : args;
     *     createCallTxOptions(..., txCtx?.getAdditionalMappings(), callArgs);
     *
     * Three things have to be true and the old code satisfied none of them: the
     * FIRST argument, a real `TransactionContext` (identified by a module-private
     * `unique symbol`), read through the METHOD `getAdditionalMappings()`. A
     * plain object in last position was not a mapping — it was an extra circuit
     * argument.
     *
     * **Exactly one circuit call goes inside each scope.** A scope batches every
     * call made within it into ONE transaction, which is the opposite of the
     * per-payee design: one payment, one transaction, retried independently.
     * This constraint is written here rather than remembered.
     *
     * The sponsor is untouched by any of this: the scope submits through
     * `submitTx(providers, ...)`, so `walletProvider.balanceTx` and
     * `midnightProvider.submitTx` — the customer's legs and the sponsor's dust —
     * are reached exactly as before. Checked in the SDK, not assumed.
     */
    return this.scopedCall(fn, plan);
  }

  /**
   * Submits one circuit call inside a transaction scope.
   *
   * `protected` so a test can watch what is handed to the SDK without a node, a
   * proof server or a chain. **That seam is not where this convention is
   * pinned** — a test that only watches an overridden method is a test of our
   * own model, which is the failure that produced V-82 in the first place.
   * `vault-call-convention.test.ts` drives the REAL
   * `withContractScopedTransaction` and asserts that the context it builds hands
   * our mapping back through `getAdditionalMappings()`, which is the single line
   * midnight-js reads.
   */
  protected async scopedCall(
    fn: (txCtx: unknown, ...args: unknown[]) => Promise<unknown>, plan: CallPlan,
  ): Promise<any> {
    const { withContractScopedTransaction } = await import('@midnight-ntwrk/midnight-js-contracts');
    return withContractScopedTransaction(
      await this.providers() as any,
      (async (txCtx: unknown) => { await fn(txCtx, ...plan.args); }) as any,
      {
        scopeName: `vault:${plan.circuit}`,
        additionalCoinEncPublicKeyMappings: plan.mappings,
      } as any,
    );
  }

  /**
   * The Zswap local state of a call, or whatever was there so the reader can
   * refuse it by name.
   *
   * **ONE PATH, NAMED, RATHER THAN A CHAIN OF `??`.** The alternatives a
   * defensive version would reach for — a circuit context's
   * `currentZswapLocalState`, a `zswapLocalState` beside it — are shapes this
   * client never sees; accepting them would be this file guessing at the SDK
   * again, which is `V-82`. What arrives here is `UnsubmittedCallTxData`'s
   * `private` block and nothing else, so that is what is read, and a result
   * that does not carry one is handed to `changeCoinOf` to be REFUSED rather
   * than quietly treated as a payment that left no change.
   */
  private static zswapOf = (result: any): unknown => result?.private?.nextZswapLocalState;

  /**
   * The finalised transaction's hash, as the SDK reported it, or `undefined`
   * when the result carries none in the shape a hash has. Never made up: a note
   * with no recorded transaction is refused by name when it is spent, and a
   * note recorded against a wrong transaction is refused when its index is read.
   */
  private static createdInOf = (result: any): Hex | undefined => {
    const hash = result?.public?.txHash;
    return typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash) ? hash.toLowerCase() : undefined;
  };

  /**
   * **THE OTHER NAME THE SAME TRANSACTION HAS, AND IT IS A DIFFERENT LENGTH.**
   *
   * `txId` is 33 bytes and `txHash` is 32, off the same finalised result, from
   * two different fields. The pool records the hash; the identifier is what a
   * screen reports, and it is the only name available when the result carries
   * no hash. Thirty-three bytes exactly - a value that is some other length is
   * not this name and nothing is guessed from a prefix.
   */
  private static identifierOf = (result: any): Hex | undefined => {
    const id = result?.public?.txId;
    return typeof id === 'string' && /^[0-9a-f]{66}$/i.test(id) ? (id.toLowerCase() as Hex) : undefined;
  };

  private txRef(result: any, by: SignerRef): TxRef {
    /*
     * `by` IS NOT ON THE RETURNED REFERENCE, and that is `TxRef`'s shape rather
     * than an oversight — attribution lives in the caller's own records, not in
     * something derived from a transaction the chain does not attribute either.
     * It is taken as an argument so a caller cannot submit a payment without
     * having decided who is making it.
     */
    void by;
    return { ref: String(result?.public?.txId ?? ''), at: new Date().toISOString() };
  }

  /**
   * **THE FIRST POOL A VAULT EVER HAS. `C242`, AND IT IS THIS ROUND'S FIRST
   * JOB RATHER THAN ITS LAST.**
   *
   * A vault deployed today cannot be funded. `SealedNotePool.load` refuses
   * when no record exists — correctly, because an absent pool and an empty
   * vault are opposite facts — and `deposit` below loads before it calls, so
   * **the client cannot take the first deposit.** `scripts/deploy-vault.ts`
   * deliberately does not create one: a pool is sealed under a fresh key
   * wrapped to each signer, `sealPool` refuses a pool wrapped to nobody
   * (`V-91`), and a deploy instrument holds no signer key material.
   *
   * **SO IT IS CREATED HERE, BY WHATEVER SUPPLIED THE `NotePool`** — which is
   * the thing holding the signer keys, and the only thing that can be. This
   * class holds none and gains none: it supplies the half the pool
   * implementation cannot have, which is the CHAIN.
   *
   * **AND THAT IS THE WHOLE REASON THIS IS NOT JUST `pool.create`.** `S6d`
   * established that answering *empty* where the truth is *unreadable* makes
   * `balance` report zero and leaves every note on chain unexplained. `create`
   * refuses to overwrite a record it can see — but a vault whose pool record
   * has been LOST looks exactly like a vault that never had one, and for that
   * vault `create` would succeed and write a truthful-looking empty pool over
   * a treasury. **The chain is the only thing that can tell those two apart**,
   * so it is asked, and:
   *
   *   · the chain says the vault's note set is EMPTY — the pool is created;
   *   · the chain says it holds notes — `VaultAlreadyHoldsNotes`, naming
   *     `replayVault`, because that is a rebuild and not an initialisation;
   *   · the chain could not be read — `VaultChainUnreadable`, and nothing is
   *     written. A state the node had finalised read as absent to the
   *     indexer 168ms later, and a vault that reads as empty because we asked
   *     too early is exactly the vault this refusal exists for.
   *
   * **WHEN IT MUST HAPPEN: after the vault exists and before its first
   * deposit.** There is no earlier moment — the pool is keyed by the vault's
   * address, which does not exist until the deploy lands — and no later one,
   * because `deposit` loads first.
   *
   * **WHAT THE PRODUCT MUST NEVER OFFER UNTIL THIS HAS RUN FOR A VAULT: that
   * vault, as a destination for money, by any route.** A deployed vault is not
   * a fundable vault. `C236` is why this matters more than downtime: the vault
   * has an address, anybody can address a shielded output to it, and money that
   * arrives without a `deposit` call is owned by the vault and spendable by
   * nobody, permanently.
   */
  async openPool(vaultAddress: string): Promise<void> {
    const onChain = await this.chainNotes(vaultAddress);
    const holds = onChain.size();
    if (holds !== 0n) throw new VaultAlreadyHoldsNotes(vaultAddress, holds);
    await this.pool.create(vaultAddress, { notes: [] });
  }

  /**
   * **WHETHER A RUN CAN BE PAID OUT OF THIS VAULT — `balance`'s FIRST
   * PRODUCTION CALLER.**
   *
   * `S6c` built `balance` to reconcile the whole pool against the chain or
   * refuse, in three outcomes, and recorded that it had no production caller.
   * This is it, and it is the shape that row asks for: **either refusal is
   * *cannot afford*.**
   *
   * Two questions, in this order, and the order is the point:
   *
   *   1. **Does the pool agree with the chain?** `balance` answers or refuses.
   *      A run started against an unreconciled pool is `C203`'s territory —
   *      a stranger who watched a deposit can reshape the pool, and the
   *      mitigation the register records for that is exactly this check.
   *   2. **Does what it holds cover these payments, one at a time?**
   *      `paymentsFit`, through the same `noteToSpend` the payment path uses.
   *      **A SUM IS NOT THE QUESTION**: notes do not merge, so a pool whose
   *      total covers a run can still stop halfway through it.
   *
   * **NOTHING IS RETURNED.** There is deliberately no number and no boolean: a
   * caller that can read a `false` and carry on is the failure this replaces,
   * and a balance shown beside a refusal is the stale number `C198` exists to
   * end. It throws or it does not.
   *
   * **IT DOES NOT CHECK INDICES**, and that is deliberate rather than an
   * oversight: a note's index is read from the chain by the payment itself,
   * just before it spends (`indexForSpend`), so an affordability check that
   * read it too would be a second answer taken at a different moment.
   */
  async affordable(
    vaultAddress: string,
    /**
     * **THE PAYEE IS REQUIRED, AND IT IS NOT DECORATION.**
     *
     * This took `{ token, amount }` and could not tell a note from a ledger
     * balance — so the first public run put through it would have been refused
     * for a vault holding plenty, by a check reading the wrong treasury. The
     * kind is not a flag added here; it rides on the payee, which is where it
     * already lives, so no call site can supply payments whose stated kind
     * disagrees with the addresses they will actually be paid at.
     */
    payments: ReadonlyArray<{ payee: Payee; token: Hex; amount: bigint }>,
  ): Promise<void> {
    if (payments.length === 0) throw new Error('a run with no payments is not a run');

    /*
     * **SPLIT BY THE PAYEE'S OWN KIND, BECAUSE THE TWO HALVES OF A VAULT ARE
     * TWO DIFFERENT QUESTIONS.**
     *
     * `S6j` established that ONE APPROVED RUN CAN HOLD BOTH KINDS SIDE BY SIDE,
     * payee by payee, so a mixed run is not an edge case to reject — it is the
     * shape the design produces. Asking one question about it gets the wrong
     * answer twice over: the pool knows nothing about NIGHT, so a public
     * payment run through `paymentsFit` is refused for a vault that is funded;
     * and the chain's public balance says nothing about notes.
     */
    const priv = payments.filter((p) => p.payee.kind === 'shielded');
    const pub = payments.filter((p) => p.payee.kind === 'unshielded');

    if (priv.length > 0) {
      try {
        /*
         * The token is only what `balance` sums; the RECONCILIATION it performs
         * covers the whole pool whatever token is asked for, which is why any
         * payment's token is a correct thing to ask about. The sum is discarded:
         * `paymentsFit` below is the real question.
         */
        await this.balance(vaultAddress, priv[0].token);
      } catch (cause) {
        if (cause instanceof VaultChainUnreadable) {
          throw new VaultCannotAfford(
            vaultAddress, 'chain-unreadable',
            'the chain could not be read, so nothing has confirmed what this vault holds. '
            + 'THIS IS NOT THE CHAIN SAYING NO and it is still not a reason to pay: an '
            + 'unconfirmed balance is one a run would be sized against',
            { cause });
        }
        if (cause instanceof VaultPoolDisagreesWithChain) {
          throw new VaultCannotAfford(
            vaultAddress, 'pool-disagrees',
            `the pool and the chain disagree, so this vault has no balance. ${cause.message}`,
            { cause });
        }
        throw cause;
      }

      const { notes } = await this.pool.load(vaultAddress);
      try {
        paymentsFit({ notes }, priv);
      } catch (cause) {
        throw new VaultCannotAfford(
          vaultAddress, 'notes-do-not-cover', (cause as Error).message, { cause });
      }
    }

    /*
     * **AND THE POOL IS NOT TOUCHED AT ALL FOR A RUN THAT IS ENTIRELY PUBLIC**,
     * which is the same property `depositUnshielded` has and for the same
     * reason: a vault holding only public money needs no pool, so nothing on
     * its path may require one.
     */
    for (const [colour, owed] of owedPerColour(pub)) {
      let held: bigint;
      try {
        held = await this.unshieldedBalance(vaultAddress, colour);
      } catch (cause) {
        if (cause instanceof VaultChainUnreadable) {
          throw new VaultCannotAfford(
            vaultAddress, 'chain-unreadable',
            'the chain could not be read, so nothing has confirmed what this vault holds in '
            + 'public money. THIS IS NOT THE CHAIN SAYING NO, and it is still not a reason to '
            + 'start paying people',
            { cause });
        }
        throw cause;
      }
      if (held < owed) {
        /*
         * NAMED AS A TOTAL, because that is what would fail. The ledger
         * subtracts each payment's `unshielded_outputs` from one number
         * (`semantics.rs:1422-1435`), so a run whose total exceeds the balance
         * pays until it stops — the same mid-run split `C203` is about,
         * arriving through the half of the vault that has no pool.
         */
        throw new VaultCannotAfford(
          vaultAddress, 'public-balance-short',
          `this run pays ${owed} of a public token the chain says this vault holds ${held} of. `
          + 'A public balance is one number the ledger subtracts from, so the payees before '
          + 'the shortfall settle and the ones after do not');
      }
    }
  }

  /**
   * Money arriving. No approval, by design — nobody needs permission to be paid.
   *
   * ONE ARGUMENT, WHERE THIS USED TO PASS A BLINDING TOO. S6a closes C124 by
   * deriving the blinding inside the circuit from the coin and the vault's
   * address, so there is nothing for this client to supply, to store, or to get
   * wrong — and a deposit made by somebody who has never heard of us produces a
   * note this company can still open.
   */
  async deposit(
    vaultAddress: string,
    /**
     * **THE COIN THIS DEPOSIT CREATES, CAPTURED BY WHOEVER SENDS IT.**
     *
     * `deposit` compiles to `receiveShielded`, which is `createZswapOutput` —
     * read from the generated contract, `contracts/managed-vault/contract/index.js`,
     * `_receiveShielded_0`. **So a deposit does not spend a coin the caller
     * already holds; it CREATES one, addressed to the vault, and the wallet
     * balancing the transaction funds it.** The nonce is therefore the
     * depositor's own choice, made before the transaction exists.
     *
     * That is what makes `C240` closable on this route and not on the general
     * one: the sender chose the nonce, so the sender can record the note in the
     * same breath — which is what happens below. **An outsider's deposit is
     * still unrecoverable by anybody but them**, because a commitment cannot be
     * inverted, and no route this client builds changes that.
     *
     * **THERE IS NO INDEX HERE, AND THAT IS A RULE RATHER THAN AN OMISSION.**
     * Where the chain files the commitment is assigned when the transaction is
     * included, so no caller can know it now. What is recorded instead is the
     * transaction's hash, read off the finalised result, and the index is read
     * from that transaction's events when the note is spent. See `Note.index`.
     */
    coin: { nonce: Hex; token: Hex; value: bigint },
    by: SignerRef,
    /**
     * **WHERE TO READ THE CREATING TRANSACTION FROM WHEN THE CALL DOES NOT
     * CARRY IT.**
     *
     * Optional, and the ordinary case never reaches it: a finalised call
     * reports its own transaction hash and that is what the note records. It is
     * here for the case where it does not - and that case used to leave a note
     * the vault owns and nothing can spend, written with no word said.
     */
    events?: NoteEvents,
  ): Promise<VaultDeposited> {
    if (coin.value <= 0n) throw new Error('a note of nothing is not a deposit');
    const note: Note = { nonce: coin.nonce, token: coin.token, value: coin.value };
    /*
     * **THE WRITE IS TRIED AGAINST THE POOL BEFORE THE MONEY MOVES, AND THE
     * ANSWER IS THROWN AWAY.**
     *
     * This load used to be the one the write was built on, which is why the
     * write was built on a copy taken before a proof and a network read. It is
     * now a pre-flight and nothing else: `afterDeposit` is the same function
     * that will make the write, so a deposit it would refuse — a nonce this
     * vault already holds, a value of nothing, an index nobody read — refuses
     * HERE, before a fee, rather than after the money has moved. The pool the
     * write is actually built on is read below, after everything that can be
     * settled has been.
     */
    afterDeposit(await this.pool.load(vaultAddress), note);

    const { result } = await this.call(vaultAddress, 'deposit', [
      { nonce: fromHex(coin.nonce), color: fromHex(coin.token), value: coin.value },
    ]);

    /*
     * **THE CREATING TRANSACTION IS SETTLED HERE, BEFORE THE ONE POOL WRITE,
     * AND THAT IS THE WHOLE POINT OF DOING IT HERE.**
     *
     * A note is spent by proving where the chain filed it, and that is read
     * from the transaction that created it. **A note whose pool entry does not
     * record that transaction cannot be spent**: the money is on chain, it is
     * the vault's, and every payment that would reach it is refused. Recording
     * it used to be a separate act somebody had to remember, and a step nobody
     * is forced to take is a step that will be missed.
     *
     * So it happens in the same action, and in the SAME WRITE. Not a second
     * `pool.save` afterwards: three writers already write this pool with no
     * lock between them, and a fourth would be a fourth.
     *
     * **IT NO LONGER LENGTHENS THE WINDOW THE NEXT COMMENT IS ABOUT, AND THAT
     * IS THE DEFECT.** It used to sit between the load the write was built on and
     * the write itself, so in the branch where the call reported no hash the
     * window was a network round trip wide rather than an instant. The pool is
     * now read AFTER this line, so everything between that read and the write is
     * local: nothing in the window waits on a chain, an indexer or a prover.
     */
    const recorded = await this.creatingTransactionOf(result, events, coin, vaultAddress);

    /*
     * **THE POOL IS WRITTEN AFTER THE TRANSACTION, DELIBERATELY, AND
     * `replayVault` IS WHAT MAKES THAT SAFE.**
     *
     * There are two orders and both lose something. Writing the pool FIRST
     * means a call that never lands leaves the pool holding a note the chain
     * does not have — the vault then offers a note the commitment set does not
     * contain, every later payment is refused, and nothing on chain records the
     * mistake to recover from. Writing it AFTER means a crash in the window
     * between these two statements leaves the chain holding a note the pool has
     * never heard of.
     *
     * **The second is the recoverable one, and `CLAUDE.md`'s rule is that
     * between two designs of similar cost the one that fails recoverably wins.**
     * The chain is authoritative and the note is derivable from the deposit the
     * owner made, so `replayVault` (`src/midnight/vault-recovery.ts`) rebuilds
     * the pool from the history and the money moves again.
     *
     * **SO `replayVault` IS NOT A SAFETY NET BESIDE THIS DESIGN. IT IS PART OF
     * IT.** Delete it, or let it rot, and this ordering silently becomes the
     * unrecoverable one — a vault whose money is stuck with no way back. That
     * is why it is named here rather than left to be discovered: a cleanup
     * round that greps for callers finds it apparently unused, and it is not.
     * `vault-ledger.test.ts` fails if this comment loses the name.
     *
     * `C200` WAS the open half — `replayVault` modelled one chained coin while
     * the vault held a pool — and `S6d` closed it: the recovery now proposes
     * every note the history has ever held to the chain's own `notes` set and
     * keeps what the chain confirms. **It is RUN, not asserted**:
     * `contracts/test/vault-recovery.test.ts` drives a vault to this exact
     * window, recovers, and SPENDS what comes back.
     */
    /*
     * **READ NOW AND WRITTEN NOW, WITH THE NOTE ADDED TO WHATEVER THE POOL
     * HOLDS.**
     *
     * The note is a DIFFERENCE, so it can be added to a pool another writer
     * advanced while this deposit was proving — that writer's note is carried
     * forward rather than erased, and this deposit's note is recorded rather
     * than refused after its money has moved. `afterDeposit` still refuses a
     * nonce the pool already holds, so a note written twice is impossible and
     * the second attempt throws rather than duplicating.     *
     * **AND THE RECOVERY IS STILL LOAD-BEARING, MORE SO RATHER THAN LESS.** The
     * pool is still written AFTER the money moves, so a crash BETWEEN the call
     * above and this write still leaves the chain holding a note the pool has
     * never heard of. Re-applying the change removes the case where another
     * writer caused that; it cannot remove the case where this process stops.
     * What rebuilds the pool from the chain and this vault's own history is
     * `replayVault` in `src/midnight/vault-recovery.ts`, and a round that deletes
     * it as unused makes this ordering the unrecoverable one without touching a
     * line of it.
     */
    await this.advancePool(vaultAddress, 'the deposit\'s note', (now) => afterDeposit(now, {
      ...note,
      ...(recorded.createdIn === undefined ? {} : { createdIn: recorded.createdIn }),
    }));
    return { ...this.txRef(result, by), ...recorded };
  }

  /**
   * **WHICH TRANSACTION CREATED THE NOTE, FROM THE CALL OR FROM THE CHAIN, AND
   * IT NEVER THROWS.**
   *
   * By the time this runs the transaction has settled and the money is on
   * chain. **Throwing here would lose the note from the pool entirely** - a
   * vault holding money it has no record of - which is strictly worse than a
   * note recorded without its transaction, because the second is repairable
   * from the pool and the first needs the whole history replayed. So every
   * failure below becomes `recordedFrom: 'nowhere'` WITH ITS REASON, and the
   * caller says so on screen.
   *
   * **THE TWO NAMES ARE DIFFERENT LENGTHS AND THE POOL HOLDS ONLY ONE.** A
   * finalised call reports a 33-byte identifier and a 32-byte hash, from two
   * different fields. The pool records the hash, because that is what a spend
   * names the transaction by. Where the hash is missing the identifier is the
   * only name there is, so the chain is asked by identifier and the hash it
   * answers with is what goes in - which is the same value, arrived at the
   * long way round.
   */
  private async creatingTransactionOf(
    result: unknown,
    events: NoteEvents | undefined,
    coin: { nonce: Hex; token: Hex; value: bigint },
    vaultAddress: string,
  ): Promise<{
    createdIn?: Hex;
    recordedFrom: 'the call' | 'the chain' | 'nowhere';
    stranded?: string;
    permanent?: boolean;
  }> {
    const fromTheCall = VaultLedger.createdInOf(result);
    if (fromTheCall !== undefined) return { createdIn: fromTheCall, recordedFrom: 'the call' };

    const identifier = VaultLedger.identifierOf(result);
    if (identifier === undefined) {
      return {
        recordedFrom: 'nowhere',
        stranded: 'the call reported neither a transaction hash nor an identifier, so there is '
          + 'no name to record and none to look one up by',
      };
    }
    if (events === undefined) {
      return {
        recordedFrom: 'nowhere',
        stranded: 'the call reported no transaction hash, and no source of the chain\x27s events '
          + 'was given to read one from the identifier it did report',
      };
    }
    try {
      const served = await events.eventsOf({ identifier });
      /*
       * **THE EVENTS MUST BE THIS NOTE'S, AND THAT IS CHECKED RATHER THAN
       * ASSUMED.**
       *
       * Taking the first event's transaction would record a hash nothing had
       * established created this note. The note would then read as healthy
       * everywhere - the pool, the screen, the pre-flight a payment makes - and
       * be refused at the spend, after a proposal and its approvals had been
       * paid for. So the same three questions the repair door goes through are
       * asked here: exactly one event carries this note's commitment, that
       * output is owned by this vault, and the events are all one transaction's.
       */
      const commitment = await vaultNoteCommitment(coin, vaultAddress as Hex);
      noteIndexFrom(served, { vault: vaultAddress as Hex, commitment, transaction: { identifier } });
      /*
       * **THE SHAPE OF A TRANSACTION HASH IS STATED ONCE.** This used to
       * re-derive and re-check the same value inline, three lines below the
       * call that had just checked it - two statements of one money rule,
       * agreeing until one of them was edited.
       */
      return {
        createdIn: theTransactionTheseEventsAreFrom(served, { identifier }),
        recordedFrom: 'the chain',
      };
    } catch (cause) {
      /*
       * **WHETHER READING AGAIN COULD ANSWER, AND ONLY ONE ERROR SAYS NO.**
       *
       * `NoteIndexUnaskable` means this client and that indexer are not in
       * step - a schema that has moved, a question it will not take - and no
       * amount of reading again brings them back.
       *
       * **`NoteIndexRefused` IS NOT THAT, AND TREATING IT AS THAT WAS A
       * MISTAKE WORTH WRITING DOWN.** Five of its six shapes name reading
       * again as the very thing that resolves them: a transaction that has not
       * reached the indexer yet, an answer about more than one transaction, an
       * answer that does not carry this note. Reporting those as final puts
       * "reading again will not answer" directly above a sentence that says to
       * read again - and somebody who believes the headline stops, leaving
       * money in the vault that the vault cannot pay out.
       *
       * So the asymmetry is the same one the classification one layer down
       * uses: final only on a positive match, and everything else stays
       * retryable, because telling somebody to stop waiting for an answer that
       * would have come is the worse of the two mistakes.
       */
      const finalWord = cause instanceof NoteIndexUnaskable;
      return {
        recordedFrom: 'nowhere',
        ...(finalWord ? { permanent: true } : {}),
        stranded: finalWord
          ? `${(cause as Error)?.message ?? String(cause)}`
          : `the chain could not say which transaction this was: `
            + `${(cause as Error)?.message ?? String(cause)}`,
      };
    }
  }

  /**
   * **PUBLIC MONEY ARRIVING, AND THE ROUND'S CENTRAL FACT IS THAT THIS METHOD
   * HAS NO POOL IN IT.**
   *
   * `deposit` above loads the note pool before it calls, which is correct for
   * shielded money and is why `C242` says a vault deployed without a pool
   * cannot take its first deposit. **None of that applies here, and the
   * difference is not a convenience.**
   *
   * `S6j` established from the ledger's own source what an unshielded balance
   * is: `ContractState.balance`, *"the public balances held by this contract"*,
   * per contract per colour, moved only by a call's declared effects and
   * defended by the chain itself — `unshielded_inputs` added with `checked_add`
   * and `unshielded_outputs` subtracted with `checked_sub`, an underflow being
   * `BalanceCheckOutOfBounds` (`ledger/src/semantics.rs:1408-1435`). **There is
   * no note, no nonce, no commitment, no merkle index, no pool, no ciphertext
   * and no recovery on that side.**
   *
   * **SO WHAT A VAULT HOLDING ONLY PUBLIC MONEY NEEDS, STATED AS A LIST,
   * BECAUSE THE ROUND ASKED FOR IT IN THOSE WORDS:**
   *
   *   · a deployed vault at an address, carrying this contract's seven circuits;
   *   · a wallet that can fund the call's declared `unshielded_input`;
   *   · **and nothing else.** No note pool, no sealed record, no signer-wrapped
   *     key, no `openPool`, no `replayVault`. A company that lost every device
   *     it owns can still read this balance off the chain, because the chain is
   *     where it has always been.
   *
   * **`openPool` IS UNNECESSARY HERE RATHER THAN TOLERATED, AND THAT IS
   * CHECKABLE.** This method does not reference `this.pool` — not to load, not
   * to save, not behind a branch — so a `VaultLedger` whose `NotePool` throws on
   * every method can still fund a vault and pay out of it publicly.
   * `vault-ledger.test.ts` constructs exactly that pool and drives both, because
   * *"the branch was not taken"* and *"there is no branch"* are different claims
   * and only the second survives somebody refactoring the first.
   *
   * **NO APPROVAL, for `deposit`'s reason: nobody needs permission to be paid.**
   * The contract refuses a zero deposit — it would seat a colour in
   * `unshieldedTokens` that `retire` then blocks on, jammable for free by
   * anybody — and this refuses it too, before a fee, for the reason every
   * duplicated guard in this file exists: the contract's assert gives an
   * attacker nothing and this one gives a person a sentence.
   *
   * **WHAT IS RECORDED ANYWHERE BY THIS CALL: the COLOUR, on chain, by the
   * circuit, inside the same transaction that moves the money.** Not a balance.
   * A second name for a number the chain already publishes is what `C124` and
   * `V-47` were both about, and `C199`'s crash window between a transaction and
   * a local write cannot exist where there is no local write.
   */
  async depositUnshielded(
    vaultAddress: string,
    money: { token: Hex; amount: bigint },
    by: SignerRef,
  ): Promise<TxRef> {
    if (money.amount <= 0n) {
      throw new Error(
        'a deposit of nothing is not a deposit. It moves no money and would seat a colour in '
        + 'this vault\'s unshielded token set, which retire then refuses to pass — a way to jam '
        + 'a vault\'s retirement for free, by anybody, since a deposit needs no approval.');
    }

    const { result } = await this.callWithoutPool(
      vaultAddress, 'depositUnshielded', [fromHex(money.token), money.amount]);
    return this.txRef(result, by);
  }

  /**
   * ONE PAYEE OF AN APPROVED RUN, IN WHICHEVER KIND OF MONEY THAT PAYEE IS OWED.
   *
   * Refused here before a fee if the pool cannot cover it. The contract refuses
   * too, and the duplication is deliberate: the contract's assert gives an
   * attacker nothing, and this one gives a person a sentence before eighty
   * seconds of proving.
   *
   * ----------------------------------------------------------------------
   * **ONE METHOD, AND THE PAYEE CHOOSES THE CIRCUIT. `C246`.**
   *
   * The contract has two circuits and that was measured and argued
   *: the arguments differ, the recipient `Either` is REVERSED
   * between them, and a boolean selecting one at run time is a way to lose
   * money that an entry-point name does not have.
   *
   * **The client's answer is the opposite shape for the same reason.** A second
   * public method — `payoutUnshielded(vault, p)` — would hand the caller back
   * exactly the choice the contract took away: they could call it with a
   * shielded payee, and the client would either refuse (a guard) or build the
   * call (money to an address in the wrong key space, against a real approval).
   * **Here there is nothing to choose.** The kind is read off `p.payee`, whose
   * tag came out of the same decode as the bytes that go to the circuit, so the
   * caller cannot name one kind and supply the other. The two are then two
   * private methods, and they share nothing but this line — which is the
   * contract's separation, kept.
   *
   * `events` is where a private payment reads the spent note's place in the
   * chain's commitment tree, just before it spends. A public payment spends no
   * note and does not read it.
   */
  async payout(
    vaultAddress: string,
    p: VaultPayment,
    by: SignerRef,
    /**
     * **THE CHAIN'S EVENTS, WHICH IS WHERE A NOTE'S INDEX IS READ.**
     *
     * A note's place in the commitment tree is assigned when the transaction
     * that created it is applied, and the ledger records it in that
     * transaction's events. `indexForSpend` reads it from there before every
     * private payment, so the index spent against is the chain's answer at
     * that moment and never a number written down earlier.
     *
     * **REQUIRED FOR A PRIVATE PAYMENT, AND ITS ABSENCE IS REFUSED BY NAME.**
     * Not given, a private payment stops before anything is proved.
     */
    events?: NoteEvents,
  ): Promise<VaultPaid> {
    /*
     * THE PAYEE'S ADDRESS AND THIS DEPLOYMENT MUST BE ON THE SAME NETWORK.
     *
     * A coin public key is network-independent bytes, so nothing downstream
     * would object: a preview address is spendable on stagenet and the payment
     * settles to a key belonging to a person on another chain. The address type
     * carries its network precisely so somebody can compare it, and this is the
     * one place where the comparison is worth a transaction.
     *
     * **TRUE OF BOTH KINDS, AND MORE SHARPLY OF THE PUBLIC ONE.** A
     * `UserAddress` is 32 network-independent bytes too, and an unshielded send
     * settles as a plain UTXO with nothing between it and the wrong chain's
     * key. It is checked once, here, before the dispatch, so neither path can
     * be reached without it.
     */
    const payee = p.payee;
    if (payee.network !== this.cfg.networkId) {
      throw new Error(
        `this payee's address is for ${payee.network} and this vault is on `
        + `${this.cfg.networkId}. The ${payee.kind === 'shielded' ? 'coin key' : 'user address'}`
        + ' would be accepted either way, so nothing further down would notice.');
    }

    if (payee.kind === 'unshielded') {
      return this.payPublicly(vaultAddress, p, payee.userAddress, by);
    }
    return this.payPrivately(vaultAddress, p, payee, by, events);
  }

  /**
   * **A PAYMENT IN PUBLIC MONEY. NO POOL, NO NOTE, NO CHANGE, NO RECOVERY.**
   *
   *
   * The whole of it, beside the same twelve arguments `payout` takes:
   *
   *   · **no `pool.load`** — there is nothing local to check the payment
   *     against, and nothing local that a crash could leave disagreeing with
   *     the chain. `C199`'s window does not exist here.
   *   · **no `noteToSpend`** — no note is chosen, so the client cannot pick the
   *     wrong one and `V-96`'s and `C205`'s territory is absent rather than
   *     handled.
   *   · **no encryption-key mapping** — `V-77`'s obligation has no counterpart:
   *     a UTXO addressed to a `UserAddress` is public and the payee's wallet
   *     finds it by looking. **So `C7`'s silent half — the right person paid
   *     into a coin they can never see — cannot arise on this path.** Passing an
   *     empty mapping and passing none are the same thing to midnight-js
   *     (`planCall`'s note), so this passes none and says why.
   *   · **no `changeCoinOf` and no `pool.save`** — `sendUnshielded` takes an
   *     exact amount and produces no change coin, which is `C239` absent for
   *     the same reason.
   *
   * **WHAT IS NOT ABSENT IS THE RULEBOOK.** The account's approval, `V-64`'s
   * paid-once record, `V-67`'s window and the run's root are checked by exactly
   * the same `recordPayment` call the shielded circuit makes, from inside
   * `payoutUnshielded`. That is the argument for this whole path: **it drops
   * the entire note model and keeps the entire rulebook.**
   *
   * **AND THE SUFFICIENCY CHECK IS THE LEDGER'S, NOT OURS.** There is no
   * client-side balance guard here to match `noteToSpend` on the private path,
   * and that is deliberate rather than missing: the circuit already asks
   * `unshieldedBalanceGte` for a refusal in words, and the ledger itself
   * refuses the transaction on `checked_sub` underflow whatever anybody
   * believes. A read here would be a THIRD answer to the same question, taken
   * at a different moment from either of the other two — which is how a client
   * refuses a payment the chain would have accepted, or waves through one it
   * will not. `unshieldedBalance` below exists for a person deciding, not for
   * this path.
   */
  private async payPublicly(
    vaultAddress: string, p: VaultPayment, userAddress: Hex, by: SignerRef,
  ): Promise<VaultPaid> {
    const { result } = await this.callWithoutPool(vaultAddress, 'payoutUnshielded', [
      fromHex(p.proposal), fromHex(p.root), p.payees, p.opensAt, p.closesAt, fromHex(p.salt),
      /*
       * THE RECIPIENT IS THE PAYEE'S `userAddress` AND NOTHING ELSE CAN REACH
       * THIS POSITION.
       *
       * It is a parameter of this method rather than re-read from `p.payee`,
       * because it was narrowed by the dispatch above: the only value that can
       * arrive here came off a payee whose bech32 decoded as an `addr`. A
       * `coinPublicKey` is not in scope in this method at all.
       */
      fromHex(userAddress), fromHex(p.token), p.amount,
      fromHex(p.blinding), fromHex(p.nonce), p.path,
    ]);
    return { ...this.txRef(result, by), kind: 'unshielded' };
  }

  /** A payment in private money — the path this client has always had. */
  private async payPrivately(
    vaultAddress: string, p: VaultPayment, payee: PayeeAddress, by: SignerRef,
    events?: NoteEvents,
  ): Promise<VaultPaid> {
    if (events === undefined) {
      throw new Error(
        'a private payment spends a note, and a note is spent by its place in the chain\x27s '
        + 'commitment tree, which is read from the chain just before the payment. No source of '
        + 'the chain\x27s events was given, so nothing is proved or paid. Pass the indexer\x27s '
        + 'events to payout and pay again.');
    }
    const current = await this.pool.load(vaultAddress);
    /* Throws with what the pool actually holds, and names merging if that is
     * the problem. See `noteToSpend`. */
    const chosen = noteToSpend(current.notes, p.token, p.amount);
    /*
     * **THE INDEX IS READ FROM THE CHAIN NOW, FOR THIS CALL ONLY.** Before a
     * fee and before a proof. A note with no recorded transaction, a chain that
     * cannot be read, or an answer that does not show this note created for
     * this vault, each stops the payment here with a sentence.
     */
    const index = await indexForSpend(vaultAddress as Hex, chosen, events);

    const { result, spent, notes: spentFrom, readAt } = await this.call(vaultAddress, 'payout', [
      fromHex(p.proposal), fromHex(p.root), p.payees, p.opensAt, p.closesAt, fromHex(p.salt),
      fromHex(payee.coinPublicKey), fromHex(p.token), p.amount,
      fromHex(p.blinding), fromHex(p.nonce), p.path,
      /*
       * BOTH HALVES OUT OF ONE VALUE, in one expression, so no call site can
       * pair one payee's coin key with another's reading key. That pairing was
       * the silent half of C7 and it no longer has anywhere to go wrong.
       */
    ], { [payee.coinPublicKey]: payee.encryptionPublicKey }, { note: chosen, index });

    if (!spent) {
      /*
       * The contract cannot have paid without asking which note to spend. If it
       * did, this client's model of the vault is wrong in a way that will
       * corrupt the pool on the next call, so it stops rather than guessing.
       */
      throw new Error(
        'the vault paid without asking for a note. The pool cannot be advanced safely; ' +
        'rebuild it from the chain with replayVault before paying again.');
    }

    /*
     * **THE CHANGE COIN IS READ OUT OF THE CALL'S OWN RESULT. `C239`, TAKEN.**
     *
     * `afterPayment` used to derive the change note's nonce here with
     * `changeNonceOf`, while this very line was holding the result the coin is
     * an output of. `V-47`'s rule is that a derived value and a readable value
     * must not both exist for the same money: the day the kernel changes a
     * domain separator, the read still works and the derivation silently does
     * not, on every payment, for a note nobody can then spend.
     *
     * **WHERE THE READ IS, from source rather than from the shape of a test.**
     * `withContractScopedTransaction` returns the root call's
     * `private` block unchanged (`midnight-js-contracts/dist/index.mjs`), whose
     * `nextZswapLocalState` is compact-js's
     * `decodeZswapLocalState(context.callContext.currentZswapLocalState)`
     * (`compact-js/dist/esm/effect/ContractExecutable.js`). That DECODED form
     * is not the one the contract tests read, and reading it was the blocker
     * `S6e` could not have known about: an address is a hex string rather than
     * `{ bytes }` and `color` is called `type`, so the old `changeCoinOf`
     * matched nothing and answered *"no change"*. `vault-coins.ts` reads both
     * spellings now and refuses a third.
     *
     * `changeCoinOf` throws rather than answering `undefined` when the state
     * cannot be read at all, which is what stops a missing result from
     * being recorded as a payment that kept nothing.
     */
    const kept = changeCoinOf(VaultLedger.zswapOf(result), vaultAddress as Hex);

    /*
     * **AFTER THE TRANSACTION, FOR THE REASON THE DEPOSIT SITE SPELLS OUT, AND
     * `replayVault` IS THE HALF OF THE DESIGN THAT LIVES IN ANOTHER FILE.**
     *
     *
     * A crash between the call above and this save leaves the chain holding the
     * change note and the pool still holding the note that was spent — the
     * worse of the two states, because the pool now believes it can spend
     * something the contract has already nullified. `replayVault`
     * (`src/midnight/vault-recovery.ts`) is what rebuilds it from the payment
     * history AND the chain's own note set; the guard above already tells an
     * operator to run it by name when the vault answers without asking for a
     * note.
     *
     * **Nothing about this ordering is safe on its own.** It is safe because a
     * recovery exists, and a round that removes the recovery as unused removes
     * the safety with it without touching this line.
     *
     * `C200` was the open half — the recovery modelled the vault's PREVIOUS
     * shape, one chained coin — and `S6d` closed it. **It is RUN, not
     * asserted**: `contracts/test/vault-recovery.test.ts` drives a vault to
     * this window, recovers, and SPENDS the note it gets back. A recovery path
     * nobody has run does not exist.
     */
    /*
     * **THE CHANGE IS APPLIED TO WHAT THE POOL HOLDS NOW, NOT TO THE COPY THE
     * CALL WAS MADE FROM.**
     *
     * A payment's change note was the one place left on this path where money
     * moved and the pool then failed to record it: the copy this write was built
     * on was read before a minute of proving, so a deposit or a repair landing in
     * that minute made this write a refusal — correct, and a refusal AFTER the
     * money has moved is a report of loss rather than a prevention of it.
     *
     * A payment is a difference: this note leaves, its change arrives. So it is
     * applied to the pool as it stands, and the other writer's note survives.
     * `afterPayment` refuses when the pool it is handed does not hold the note
     * that was spent, which is the case that must never be guessed at — two
     * payments cannot spend one note, because the contract nullifies the
     * commitment, so a pool without it means this is not the pool this payment
     * belongs to.
     *
     * **THE INDEX IS STRIPPED, WHICH IS WHAT `call` ALREADY DID.** A spend reads
     * a note's place in the commitment tree from the chain at the moment it
     * spends (`indexForSpend`), never from the pool, so a number stored here has
     * no reader that should trust it and is one a later change could hand over by
     * mistake. `spentFrom` carried no indexes because `call` dropped them; a
     * fresh load may hold some from an older write, so they are dropped here for
     * the same reason and the written shape is unchanged.     *
     * **AND THE RECOVERY IS STILL LOAD-BEARING, MORE SO RATHER THAN LESS.** The
     * pool is still written AFTER the money moves, so a crash BETWEEN the call
     * above and this write still leaves the chain holding a note the pool has
     * never heard of. Re-applying the change removes the case where another
     * writer caused that; it cannot remove the case where this process stops.
     * What rebuilds the pool from the chain and this vault's own history is
     * `replayVault` in `src/midnight/vault-recovery.ts`, and a round that deletes
     * it as unused makes this ordering the unrecoverable one without touching a
     * line of it.
     */
    await this.advancePool(vaultAddress, 'the payment\'s change note', (now) => afterPayment(
      { notes: now.notes.map(({ index: _readAtTheSpend, ...note }) => note) },
      spent, p.amount, kept, VaultLedger.createdInOf(result)));
    return { ...this.txRef(result, by), kind: 'shielded', spentNote: spent };
  }

  /**
   * **WHAT THE VAULT HOLDS OF ONE TOKEN — RECONCILED AGAINST THE CHAIN, OR NOT
   * ANSWERED AT ALL.**
   *
   * This used to sum the local pool and return it. It never asked the chain,
   * `matchesChain` existed with no production caller (it has since been
   * removed by `S6d` — a caller-supplied blinding is the pre-`C124` shape, and
   * `commitmentForNote` plus set membership is what replaces it), and so **every decision
   * taken from a vault balance — including whether a payroll run can be
   * afforded — rested on our bookkeeping agreeing with reality by luck.**
   *
   * **THREE OUTCOMES, AND THEY MUST BE THREE.**
   *
   *   · **agrees** — every note this pool holds is in the vault's on-chain set
   *     and the set holds nothing else. The sum is returned.
   *   · **disagrees** — `VaultPoolDisagreesWithChain`, saying by how much and
   *     in which direction. There is no best-effort number: a balance that
   *     disagrees with the chain is not a smaller balance, it is an unknown one.
   *   · **could not read the chain** — `VaultChainUnreadable`, saying THAT and
   *     never a local number with a caveat. `C110` is why this is separate from
   *     the second: a transaction the node had finalised read as `not found` to
   *     the indexer 168ms later, so *"we could not check"* and *"the chain says
   *     no"* are different answers with opposite consequences — one is retried,
   *     the other is investigated.
   *
   * **WHAT A CALLER DOES WITH A REFUSAL, decided here rather than left open.**
   * A screen that says *"we cannot confirm this balance"* is correct. A screen
   * that shows a stale number, with or without a caveat beside it, is not —
   * that is the state this row exists to end. An affordability check treats
   * either refusal as *cannot afford*, because a run started against an
   * unreconciled pool is `C203`'s and `C205`'s territory: a pool that disagrees
   * with the chain pays until it stops, mid-run.
   *
   * **AND THE FINDING THAT GOES WITH IT: THERE ARE NO PRODUCTION CALLERS
   * TODAY.** Nothing in `src/` outside this file calls `balance`; the only
   * consumers are tests. So no screen had to be changed, and none had to be
   * softened — which is the good version of `S6c`'s standing instruction that a
   * caller which cannot handle a refusal is a finding rather than a reason to
   * widen the return type. **The next caller inherits a function that refuses,
   * rather than one that has to be retrofitted with a refusal after a screen
   * has grown used to a number.**
   *
   * The reconciliation covers the WHOLE pool and not just `token`. A euro note
   * the chain does not hold means the pool and the chain disagree, and a pound
   * balance read out of a pool that is wrong about euros is a number nobody
   * should act on.
   */
  async balance(vaultAddress: string, token: Hex): Promise<bigint> {
    const { notes } = await this.pool.load(vaultAddress);
    await this.reconcile(vaultAddress, notes);
    return notes.filter((n: Note) => n.token === token).reduce((a, n) => a + n.value, 0n);
  }

  /**
   * **WHAT THE VAULT HOLDS OF ONE PUBLIC TOKEN — THE CHAIN'S OWN NUMBER.**
   * `C245`, `S6k` §1, and it is a SEPARATE FUNCTION from `balance` above on
   * purpose.
   *
   * ----------------------------------------------------------------------
   * **WHY NOT THE SAME FUNCTION. THE ROUND ASKED, AND THIS IS THE ANSWER.**
   *
   * The two questions have different TRUTH CONDITIONS, and a function whose
   * answer means different things depending on an argument is how *"could not
   * read"* becomes *"there is none"* — `C188`'s family, and this round is the
   * moment it would have been introduced.
   *
   *   · **`balance` is a RECONCILIATION.** It has a local record — the note
   *     pool — and the chain holds commitments. Its job is to say whether the
   *     two agree, and it has THREE outcomes because of that: agrees, return
   *     the sum; disagrees, `VaultPoolDisagreesWithChain` by how much and in
   *     which direction; could not read, `VaultChainUnreadable` (`C198`,
   *     `C110`). Its number is only meaningful BECAUSE it was reconciled.
   *   · **`unshieldedBalance` is a READ.** There is no local record to
   *     reconcile against and there never was one: an unshielded balance is
   *     `ContractState.balance`, the ledger's own figure per contract per
   *     colour. So it has TWO outcomes: the chain's number, or we
   *     could not read it. **There is no third, because there is nothing that
   *     could disagree.**
   *
   * Sharing a body would mean either inventing a disagreement outcome that
   * cannot occur, or collapsing three outcomes into two and losing the
   * distinction `C110` was measured to establish. Two names, two shapes, and a
   * caller has to know which of a vault's two treasuries it is asking about —
   * which it does, because it holds the payee whose kind decides.
   *
   * ----------------------------------------------------------------------
   * **ZERO IS AN ANSWER AND ABSENCE IS NOT.**
   *
   * The indexer's `queryUnshieldedBalances` is asked, which is its own door for
   * exactly this question and returns `{ tokenType, balance }` rows rather than
   * a `Map` keyed by `TokenType` OBJECTS — the shape `ContractState.balance`
   * has, whose keys cannot be looked up by value at all.
   *
   *   · a list arrives and this colour is not in it  → **`0n`**. The chain
   *     published what this contract holds and this colour is not among it.
   *     That is a true statement about the vault.
   *   · `null`, a throw, a provider that cannot answer, or a reply that is not
   *     a list → **`VaultChainUnreadable`**, saying THAT. `C110` is why: a
   *     state the node had finalised read as absent to the indexer 168ms
   *     later, and a vault that reads as empty because we asked too early is a
   *     vault whose whole float would be reported as nothing.
   *
   * ----------------------------------------------------------------------
   * **THIS IS NOT THE READ THE CIRCUIT MAKES, AND THE DIFFERENCE MATTERS FOR
   * TESTS.**
   *
   * `payoutUnshielded` asks `unshieldedBalanceGte`, which reads
   * `CallContext.balance` — filled by the runtime only when it is handed a real
   * `ContractState`, and therefore EMPTY in `AccountSimulator` and in
   * `vault-payout.test.ts`. **That hole is not in this function**: this asks the
   * indexer over the provider bundle, which a test controls by supplying the
   * answer. So a test of this function is testing a real read; a test of the
   * circuit's balance question is not, unless it rewraps the state. Any test
   * that asks a balance question must say which of the two it is doing.
   *
   * **WHAT A CALLER DOES WITH IT.** It is for a person deciding — a screen, an
   * operator sizing a run. **It is not a pre-flight for `payout`**, which
   * deliberately has none on the public path: see `payPublicly`.
   */
  async unshieldedBalance(vaultAddress: string, token: Hex): Promise<bigint> {
    const providers = await this.providers();
    const ask = providers?.publicDataProvider?.queryUnshieldedBalances;
    if (typeof ask !== 'function') {
      /*
       * NOT ZERO, AND NOT A FALLBACK TO `queryContractState().balance`. That
       * map is keyed by TokenType OBJECTS, so a value lookup on it silently
       * finds nothing and would answer "this vault holds none" for a vault
       * holding a float. A provider that cannot answer is us not knowing.
       */
      throw new VaultChainUnreadable(
        vaultAddress,
        'this provider bundle has no queryUnshieldedBalances, so nothing here can say what '
        + 'the chain published for this contract',
        'public-balance');
    }

    let rows: unknown;
    try {
      rows = await ask.call(providers.publicDataProvider, vaultAddress);
    } catch (cause) {
      throw new VaultChainUnreadable(
        vaultAddress, `the read itself failed: ${(cause as Error)?.message ?? String(cause)}`,
        'public-balance');
    }

    if (rows == null) {
      throw new VaultChainUnreadable(
        vaultAddress,
        'the indexer has no contract action for this address, so it has not published a '
        + 'balance for it yet. That is not a vault holding nothing',
        'public-balance');
    }
    if (!Array.isArray(rows)) {
      throw new VaultChainUnreadable(
        vaultAddress,
        `the indexer answered with ${typeof rows} rather than a list of balances. A shape this `
        + 'client cannot read is our ignorance, not an empty treasury',
        'public-balance');
    }

    /*
     * `RawTokenType` is the colour as hex — the same 32 bytes this client holds
     * as `token`, which is what `vault-unshielded.test.ts` reads off the
     * declared effects (`{ tag: 'unshielded', raw: <hex> }`). Compared
     * case-insensitively and with a `0x` tolerated, because a comparison that
     * silently fails on spelling answers ZERO for a vault that is funded.
     */
    const want = normalColour(token);
    let held = 0n;
    for (const row of rows as Array<{ tokenType?: unknown; balance?: unknown }>) {
      if (typeof row?.tokenType !== 'string' || typeof row?.balance !== 'bigint') {
        throw new VaultChainUnreadable(
          vaultAddress,
          'one of the indexer\'s balance rows is not { tokenType: string, balance: bigint }. '
          + 'Skipping it would understate a treasury, so nothing is returned',
          'public-balance');
      }
      if (normalColour(row.tokenType) === want) held += row.balance;
    }
    return held;
  }

  /**
   * The pool against the vault's own note set on chain.
   *
   * Returns nothing and throws on any disagreement — there is deliberately no
   * boolean, because a caller that can read a `false` and carry on is the
   * failure this replaces.
   *
   * **The commitment is computed by the VAULT CONTRACT'S OWN pure circuits**,
   * `noteBlindingOf` then `heldCommitmentOf`, exactly as `Vault.compact` does
   * when it inserts a note. That is one implementation and not two: `M-104` is
   * this project's standing reason never to write a second copy of a rule the
   * money depends on, and `contracts/test/one-definition.test.ts` is where
   * copies are policed. So what is checked here is the RECONCILIATION — which
   * notes are on both sides — and not the derivation, which is pinned by tests
   * that spend what they derive.
   */
  private async reconcile(vaultAddress: string, notes: Note[]): Promise<void> {
    const onChain = await this.chainNotes(vaultAddress);
    const { pureCircuits } = await import('../../contracts/managed-vault/contract/index.js');

    /*
     * **THE COMPOSITION IS IMPORTED, NOT SPELLED OUT AGAIN.** `M-104`, and
     * `S6d` is where the second copy was about to appear: `vault-recovery.ts`
     * needs exactly `heldCommitmentOf(coin, noteBlindingOf(vault, coin))` to
     * propose a rebuilt note to the chain, and two hand-written spellings of a
     * two-argument composition is two chances to write the arguments the other
     * way round. The circuits are still the CONTRACT's — what is shared is the
     * order they go in.
     */
    const commitmentOf = (n: Note): Hex =>
      commitmentForNote(pureCircuits, vaultAddress as Hex, n);

    const missing = notes.filter((n) => !onChain.member(fromHex(commitmentOf(n))));
    const held = BigInt(notes.length);
    const chainHolds = onChain.size();

    if (missing.length > 0) {
      /*
       * WE BELIEVE IN MONEY THE CHAIN WILL NOT HONOUR. Every one of these notes
       * would be offered to a payment and refused, so the amount is exactly the
       * amount this balance would have overstated by.
       */
      const overstated = missing.reduce((a, n) => a + n.value, 0n);
      throw new VaultPoolDisagreesWithChain(
        vaultAddress,
        `${missing.length} of ${notes.length} note(s) in this pool are NOT in the vault's ` +
        `on-chain set, worth ${overstated} between them. The pool claims MORE than the chain ` +
        'will honour, and every one of those notes would be refused at payment time. ' +
        `Unknown to the chain: ${missing.map((n) => n.nonce).join(', ')}`);
    }

    if (chainHolds !== held) {
      /*
       * THE OTHER DIRECTION, AND IT IS `C199`'s WINDOW. Every note we hold is
       * on chain, and the chain holds more — so a note reached the vault that
       * the pool never recorded, which is exactly what a crash between the call
       * and the pool save leaves behind. The amount cannot be stated: a
       * commitment discloses nothing, which is the point of it.
       */
      throw new VaultPoolDisagreesWithChain(
        vaultAddress,
        `the chain holds ${chainHolds} note(s) and this pool holds ${held}. Every note the ` +
        'pool knows about IS on chain, so the pool claims LESS than the vault holds — a note ' +
        'reached the vault and was never recorded, which is what a crash between a call and ' +
        'the pool write leaves behind. The amount cannot be stated from here, because a ' +
        'commitment discloses nothing. Rebuild the pool from the chain with replayVault.');
    }
  }

  /**
   * The vault's note set as the chain holds it, or a refusal saying we could
   * not read it. `C198`, and `C110` is why this refusal is its own.
   */
  private async chainNotes(
    vaultAddress: string,
  ): Promise<{ member(commitment: Uint8Array): boolean; size(): bigint }> {
    const providers = await this.providers();

    let state: any;
    try {
      state = await providers?.publicDataProvider?.queryContractState(vaultAddress);
    } catch (cause) {
      throw new VaultChainUnreadable(
        vaultAddress, `the read itself failed: ${(cause as Error)?.message ?? String(cause)}`);
    }
    if (!state) {
      /*
       * NOT "the vault holds nothing". A state the node had finalised
       * read as absent to the indexer 168ms later, and a vault that reads as
       * empty because we asked too early is a vault whose whole balance would
       * be reported as a disagreement — or, one coercion away, as zero.
       */
      throw new VaultChainUnreadable(
        vaultAddress, 'the indexer returned no state for this address');
    }

    /*
     * **THE SHAPE, BEFORE A SINGLE FIELD IS READ OFF THIS VAULT.**
     *
     * This read is not on the payment path - it is what answers `balance`,
     * `affordable` and `reconcile`, which is to say it is what decides whether a
     * run is raised at all. **A field is addressed by its position**, so a vault
     * deployed from another build answers the question about `notes` out of
     * whichever field is in that slot, and answers it silently when the two are
     * stored the same way. A number reached that way is not a wrong number about
     * this vault's money; it is a number about something else entirely.
     */
    await assertVaultLedgerIsThisBuilds(state);

    let parsed: any;
    try {
      const { ledger: readVault } = await import('../../contracts/managed-vault/contract/index.js');
      parsed = readVault(state.data);
    } catch (cause) {
      throw new VaultChainUnreadable(
        vaultAddress, `the state did not decode: ${(cause as Error)?.message ?? String(cause)}`);
    }

    const notes = parsed?.notes;
    if (notes == null || typeof notes.member !== 'function' || typeof notes.size !== 'function') {
      /*
       * `C188`'s guard, one contract along and by hand: a map the reader did
       * not hand over is not an empty one, and this is the boundary that keeps
       * them apart. `Vault.compact`'s `notes` is a `Set<Bytes<32>>`
       * (`contracts/managed-vault/contract/index.d.ts:117-122`), so `member`
       * and `size` are what it declares and what this needs.
       */
      throw new VaultChainUnreadable(
        vaultAddress,
        'the decoded state has no readable "notes" set. That is not an empty vault — an ' +
        'empty set is a true statement about the vault and a missing one is our ignorance');
    }
    return notes;
  }

  /** For a caller that wants the pool without reaching through the store. */
  async notes(vaultAddress: string): Promise<VaultNotes> {
    return this.pool.load(vaultAddress);
  }

  /** Named so a reader can see what this class does NOT hold. */
  describe(): string {
    return `vault client on ${this.cfg.networkId}, fees via ${this.sponsor ? 'sponsor' : 'none'}; `
      + 'the account it calls is pinned by the vault on chain, never by this client';
  }
}

/**
 * What a set of public payments owes, per colour.
 *
 * Summed per colour rather than over the run, because a vault holds a separate
 * ledger balance for each and covering one says nothing about another.
 */
const owedPerColour = (
  payments: ReadonlyArray<{ token: Hex; amount: bigint }>,
): Map<Hex, bigint> => {
  const owed = new Map<Hex, bigint>();
  for (const p of payments) owed.set(p.token, (owed.get(p.token) ?? 0n) + p.amount);
  return owed;
};

/** A colour as the chain spells it, so a comparison cannot fail on case or a prefix. */
const normalColour = (t: string): string =>
  (t.startsWith('0x') || t.startsWith('0X') ? t.slice(2) : t).toLowerCase();

export const toNote = (
  nonce: Hex, token: Hex, value: bigint, index: bigint,
): Note => ({ nonce, token, value, index });

export { toHex };
