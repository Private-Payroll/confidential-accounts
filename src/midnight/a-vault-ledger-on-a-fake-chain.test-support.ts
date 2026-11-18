/*
 * The fake vault chain the vault client tests run against: a harness that records every call,
 * the module mock that hands the vault's contract back to the client, and the values every test shares.
 */
import { served } from '../testing/served-state.js';
import { vi } from 'vitest';
import { VaultLedger, type NotePool, type VaultPayment, type PaymentAttempt, type PaymentJournal, type DepositAttempt, type DepositJournal } from './vault-ledger.js';
import { VaultPoolAdvancedSinceRead, VaultPoolVersionAlreadyFiled } from './vault-pool.js';
import { type VaultOutputHistory } from './deposit-nonce.js';
/*
 * The VAULT's own pure circuits, imported for real. The reconciliation
 * computes a note's commitment with these, and a fake chain that computed them
 * any other way would be a second implementation of the rule the money depends
 * on.
 */
import { pureCircuits as vaultCircuits } from '../../contracts/managed-vault/contract/index.js';
import { type VaultNotes } from './vault-notes.js';
import { toHex } from '../core/crypto.js';
import { payeeFor, unshieldedPayeeFor } from '../testing/payees.js';
import { NoteIndexUnaskable, NoteIndexUnreadable, vaultNoteCommitment, type CreatingTransaction, type NoteEvents, type ServedEvent } from './note-index.js';

export const itemAt = <T,>(xs: readonly T[], i: number): T => {
  const x = xs[i];
  if (x === undefined) throw new Error(`expected an item at place ${i}, and the list holds ${xs.length}`);
  return x;
};

/*
 * **THE VAULT'S GENERATED MODULE, FAKED DOWN TO ITS READER AND NOTHING ELSE.**
 *
 *
 * `ledger()` is identity — this harness supplies the decoded public state
 * directly, exactly as `ledger.test.ts` does for the account — while
 * `pureCircuits` is the REAL one, so every commitment the reconciliation
 * compares is the one the chain would hold. A stub that answered every question
 * with the same bytes could not tell agreement from disagreement.
 *
 * **REGISTERED ONCE, AT MODULE SCOPE, AND STATELESS.** A factory
 * closing over per-test state costs this: the binding becomes module-global, the
 * most recently constructed harness wins, and the failure only shows up when
 * two exist.
 */
/**
 * **THE SHAPE THIS BUILD'S CONTRACT MAKES, AS THE FAKE STATES IT.**
 *
 * The real vault's ledger is five fields, stored `cell, map, map, cell, map` -
 * measured off the contract's own constructor. Every read of a deployed vault
 * now compares against it, so a fake whose state has no shape is a fake no
 * vault resembles.
 */
const CANONICAL_SLOTS = ['cell', 'map', 'map', 'cell', 'map'] as const;
const shapedLike = (slots: readonly string[]) => ({
  state: { type: () => 'array', asArray: () => slots.map((k) => ({ type: () => k })) },
});

vi.doMock('../../contracts/managed-vault/contract/index.js', () => ({
  ledger: (d: any) => d,
  pureCircuits: vaultCircuits,
  /* The constructor, faked down to the one thing the shape reader asks it. */
  Contract: class {
    constructor(_witnesses: unknown) { /* runs no circuit */ }
    async initialState() {
      return { currentContractState: { data: shapedLike(CANONICAL_SLOTS) } };
    }
  },
}));

export const GBP = 'aa'.repeat(32);
/** The token the product launches with, and it is UNSHIELDED by definition. */
export const NIGHT = '99'.repeat(32);
/*
 * A REAL 32-BYTE CONTRACT ADDRESS, because the reconciliation decodes it:
 * the note blinding is a function of the vault's own address
 * (`Vault.compact`'s `noteBlindingOf`), so a placeholder string is no longer
 * something this harness can hand over.
 */
export const VAULT = 'a7'.repeat(32);
/* The VAULT's compiled artefacts, not the account's. The arity guard reads these. */
const VAULT_ARTEFACTS = new URL('../../contracts/managed-vault', import.meta.url).pathname;
/*
 * ONE PAYEE, ONE VALUE.
 *
 * A separate payee key beside a separate 32-byte `recipient` is exactly the
 * pair that could disagree, so both come from this one decoded payee.
 */
export const PAYEE = payeeFor(new Uint8Array(32).fill(0x44), 'preview');   // the harness's network
/*
 * **THE SAME 32 BYTES, IN THE OTHER KEY SPACE.**
 *
 * Deliberately identical to `PAYEE`'s coin key, because that is the hazard: a
 * `UserAddress` and a `ZswapCoinPublicKey` of the same bytes are
 * indistinguishable to everything downstream of the address type. If this
 * fixture used different bytes, the dispatch tests below could pass because the
 * values differed rather than because the KIND did.
 */
export const PUBLIC_PAYEE = unshieldedPayeeFor(new Uint8Array(32).fill(0x44), 'preview');
export const BY = { id: 'kc' } as never;

/*
 * **WHERE THE HARNESS'S NOTES CAME FROM, AND WHAT THE CHAIN SAYS ABOUT THEM.**
 *
 * Every seeded note records that `SEEDED_TX` created it and carries no index.
 * The chain's events for that transaction file the seeded notes at 40, 43, 46,
 * which is neither their position in the pool nor a count, so a client that
 * spent against either would hand the contract the wrong number and the tests
 * that read `mt_index` would say so. A deposit's finalised result carries
 * `DEP_TX`; each payout's carries its own hash, from `payHash`.
 */
export const SEEDED_TX = 'd0'.repeat(32);
export const DEP_TX = 'de'.repeat(32);
/**
 * The other name the same transaction has: 33 bytes, not 32, and a different
 * field of the same result. A real one begins `00`, and the length is what
 * tells the two names apart.
 */
export const DEP_ID = `00${'de'.repeat(32)}`;
export const payHash = (k: number) => k.toString(16).padStart(64, 'c');
/** A payment's 33-byte identifier, the other name its finalised result carries. */
export const payId = (k: number) => `00${payHash(k)}`;
/** The nonce the harness's fake deposit claim hands back on its `n`th claim: `77…`, `78…`, … */
const claimedNonce = (n: number): string => (0x76 + n).toString(16).repeat(32);
export const seededIndex = (i: number) => 40n + BigInt(i) * 3n;

/*
 * The events the harness in use serves, reached through one constant so every
 * payout below passes the same source. Replaced each time a harness is built.
 */
export let eventsInUse: NoteEvents = { eventsOf: async () => { throw new Error('no harness built'); } };
export const EVENTS: NoteEvents = { eventsOf: (tx) => eventsInUse.eventsOf(tx) };
/** Replaces the events the harness in use serves; a module that imports `eventsInUse` cannot assign it. */
export const useEvents = (events: NoteEvents): void => { eventsInUse = events; };

/** The vault's current nonce secret, as a signer's device opens it from the company's record. */
export const SECRET = '51'.repeat(32);
/** Sixteen levels, each distinct, so a step dropped, reordered or rewritten reads differently. */
export const PATH = Array.from({ length: 16 }, (_, d) => ({ sibling: 1_000n + BigInt(d), siblingSum: BigInt(d * 7), goesLeft: d % 3 === 0 }));

export const payment = (amount: bigint): VaultPayment => ({
  proposal: '11'.repeat(32), root: '22'.repeat(32), payees: 3n,
  opensAt: 1_800_000_000n, closesAt: 1_800_604_800n, salt: '33'.repeat(32),
  payee: PAYEE, token: GBP, amount,
  blinding: '55'.repeat(32), nonce: '66'.repeat(32),
  runVault: VAULT, required: 2n, asset: GBP, path: PATH,
});

export function harness(opts: {
  notes?: Array<{ nonce: string; value: bigint }>;
  /** What the fake contract's witnesses do. Defaults to asking for a note. */
  asksForANote?: boolean;
  throws?: string;
  /**
   * **WHAT THE CHAIN HOLDS FOR THIS VAULT.**
   *
   *   omitted            the chain agrees with the pool exactly
   *   'unreadable'       `queryContractState` returns nothing
   *   'read-throws'      the read itself fails
   *   'no-notes-field'   a state arrives whose decoded form has no `notes` set
   *   Note[]             the chain holds exactly these, whatever the pool says
   */
  chain?: 'unreadable' | 'read-throws' | 'no-notes-field'
    | Array<{ nonce: string; value: bigint }>;
  /**
   * **WHAT THE PAYOUT CALL'S OWN RESULT SAYS THE VAULT KEPT.**
   *
   *   omitted        the change coin the contract would really have produced
   *   'absent'       a result carrying no Zswap local state at all
   *   'none'         a readable state with nothing coming back to the vault
   *   'wrong-value'  a change coin that disagrees with the arithmetic
   */
  reads?: 'absent' | 'none' | 'wrong-value';
  /** The store already holds a pool for this vault, so `create` must refuse. */
  poolExists?: boolean;
  /**
   * **A NOTE POOL THAT REFUSES EVERY QUESTION.**
   *
   * Not a pool that is empty — one that cannot be reached at all, which is what
   * a vault holding only public money actually has: nothing created it, nothing
   * sealed it, and no signer wrapped a key for it. A public deposit and a public
   * payout have to work against this, and *"the branch was not taken"* and
   * *"there is no branch"* are different claims. Only the second survives
   * somebody refactoring the first.
   */
  poolThrows?: boolean;
  /**
   * **WHERE A PRIVATE PAYMENT WRITES ITS ATTEMPT DOWN.**
   *
   *   omitted     a journal that remembers, in `journalled`, in order
   *   'none'      the ledger is built without one, and must refuse by name
   *   'refuses'   a journal whose write throws, which must stop the payment
   */
  journal?: 'none' | 'refuses';
  /**
   * **WHERE A PRIVATE DEPOSIT WRITES ITS COIN DOWN, AND WHAT NONCE ITS CLAIM
   * HANDS BACK.** The same three shapes as `journal`, remembered in
   * `depositsJournalled`. The fake claim's `n`th nonce is `claimedNonce(n)`:
   * `77…` first, then `78…`, and so on, unless `depositNonces` says otherwise.
   */
  depositJournal?: 'none' | 'refuses';
  depositNonces?: readonly string[];
  /**
   * **EVERY COIN THE CHAIN HAS EVER CREATED FOR THIS VAULT.**
   *
   *   omitted        every coin this harness's chain has made, seeded and produced
   *   'none'         the ledger is built without a history, and must refuse by name
   *   'unreadable'   the read throws
   *   string[]       also these nonces, as coins of 500 GBP made and since spent
   */
  history?: 'none' | 'unreadable' | readonly string[];
  /**
   * **WHAT THE CHAIN SAYS THIS VAULT HOLDS IN PUBLIC MONEY.**
   *
   * The balance inside the vault's contract state, `ContractState.balance`: a
   * `Map` keyed by `{ tag, raw }` token types, served with the same state the
   * notes are read from.
   *
   *   omitted        the vault holds 1,000 of NIGHT
   *   'no-provider'  a bundle whose provider cannot read a contract's state
   *   'unreadable'   the indexer has no state for this address (null)
   *   'read-throws'  the read itself fails
   *   'no-balance'   a state that carries no balance map at all
   *   'not-a-map'    a balance of a shape this client cannot read
   *   'bad-row'      a map holding an entry that is not a public token and an amount
   *   rows           exactly these colours and amounts
   */
  publicBalances?: 'no-provider' | 'unreadable' | 'read-throws' | 'no-balance' | 'not-a-map' | 'bad-row'
    | Array<[string, bigint]>;
  /**
   * What the chain's events say about the notes.
   *
   *   'unreadable'  the indexer cannot be asked
   *   'moved'       every seeded note is filed one place later than the pool says
   *   'unaskable'   the indexer will not take the question at all, and reading
   *                 again will never answer - a schema that has moved rather
   *                 than a node the indexer is a moment behind
   *   'no-hash-named'  the chain answers about this note and names its
   *                 transaction with something that is not a transaction hash
   */
  events?: 'unreadable' | 'moved' | 'unaskable' | 'no-hash-named';
  /** Seeded notes that record no creating transaction, as notes written before it was kept. */
  noCreatingTransaction?: boolean;
  /**
   * **ANOTHER PROCESS WRITES THE POOL WHILE THE CALL IS BEING PROVED**, adding
   * this note. The circuit is where a real call spends its minute, so that is
   * where the other write lands.
   */
  anotherWriterAddsDuringTheCall?: { nonce: string; value: bigint };
  /**
   * **ANOTHER WRITER FILES THE NEXT VERSION BETWEEN THE WRITE'S OWN LOAD AND ITS
   * SAVE**, this many times running, and then stops.
   *
   * The window `anotherWriterAddsDuringTheCall` opens is the CALL -- minutes of
   * proving -- and a write that re-reads the pool afterwards is past it. This is
   * the window that is left: the microseconds between the load a write is built
   * on and the filing of it, which no re-read can remove and which two processes
   * were watched walking through together. It is the only thing that exercises
   * the retry, and without it the retry could be deleted with every test green.
   */
  poolRaceLostTimes?: number;
  /**
   * **ANOTHER WRITER LANDS WHILE THE DEPOSIT IS ASKING THE CHAIN**, which is the
   * window this is about and the one `anotherWriterAddsDuringTheCall` cannot
   * reach: that one fires inside the circuit, and the chain read happens after
   * the circuit returns.
   *
   * **IT REPLACES `stored` RATHER THAN PUSHING INTO IT, AND THAT IS NOT A
   * STYLE CHOICE.** `load` hands back `stored.notes` itself, so a writer that
   * pushed into that array would also be mutating every copy already loaded from
   * it -- and a test built on a copy being STALE would then be comparing a thing
   * to itself. The first version of this test did exactly that and stayed green
   * over the defect it was written to catch.
   */
  anotherWriterAddsDuringTheChainRead?: { nonce: string; value: bigint };
  /**
   * **ANOTHER WRITER REPLACES THE POOL WHILE THE CALL IS BEING PROVED**, with
   * exactly these notes, and advances the version.
   *
   * It fires in the CIRCUIT, where a real call spends its minute, because that is
   * the only window that reaches `advancePool` with a pool the change cannot be
   * applied to. Replacing it during the chain READ is caught a step earlier, by
   * `call`'s own index guard, before any money moves -- which is correct, and is
   * not what this option is for.
   *
   * REPLACES, not mutates. `load` hands back `stored.notes` itself, so a test that
   * pushed into that array would be rewriting the copy the payment already loaded
   * -- comparing a thing to itself. A second reading found the first version of the
   * refusal test below doing precisely that, and it reached the right refusal by a
   * route no real writer can take.
   */
  poolBecomesDuringTheCall?: Array<{ nonce: string; value: bigint }>;
  /**
   * **WHAT THE FINALISED DEPOSIT CALL REPORTS ABOUT ITS OWN TRANSACTION.**
   *
   * A real result carries two names for it, off two different fields and of two
   * different lengths: a 32-byte `txHash` and a 33-byte `txId`. The pool
   * records the hash, because that is what a spend names the transaction by.
   *
   *   omitted              both, which is the ordinary case
   *   'no-hash'            only the identifier, so the hash has to be read from the chain
   *   'nothing-to-go-on'   neither, so there is no name at all
   */
  depositResult?: 'no-hash' | 'nothing-to-go-on' | 'hash-shaped-identifier';
  /** **WHAT A FINALISED PRIVATE PAYMENT REPORTS ABOUT ITS OWN TRANSACTION**, in the same three shapes. */
  payoutResult?: 'no-hash' | 'nothing-to-go-on';
  /**
   * **THE CHAIN'S EVENTS DO NOT CARRY THIS DEPOSIT'S NOTE.** What a wrong
   * identifier, or an identifier belonging to somebody else's transaction,
   * looks like from here: events that exist and say nothing about this note.
   */
  chainDoesNotFileTheNote?: boolean;
  /** How the DEPLOYED vault's ledger is shaped. Defaults to what this build makes. */
  ledgerSlots?: readonly string[];
  /**
   * **THE POOL AND BOTH JOURNALS ARE KEPT IN A REAL STORE**, and this harness
   * only watches them. The chain this harness answers for still follows the
   * pool, so every load and save is mirrored into `stored` as it happens.
   */
  keptIn?: { pool: NotePool; payments: PaymentJournal; deposits: DepositJournal };
} = {}) {
  let stored: VaultNotes = {
    notes: (opts.notes ?? [{ nonce: '01'.repeat(32), value: 1_000n }])
      .map(n => ({
        nonce: n.nonce, token: GBP, value: n.value,
        ...(opts.noCreatingTransaction ? {} : { createdIn: SEEDED_TX }),
      })),
  };
  const seeded = stored.notes.map((n, i) => ({ coin: n, hash: SEEDED_TX, index: seededIndex(i) }));
  const produced: Array<{ coin: { nonce: string; token: string; value: bigint }; hash: string; index: bigint }> = [];
  const eventReads: CreatingTransaction[] = [];
  const spentCoins: any[] = [];
  /** Every nonce secret the fake's payout was handed, as hex, in order. */
  const secretsRead: string[] = [];
  let payouts = 0;
  eventsInUse = {
    eventsOf: async (tx) => {
      eventReads.push(tx);
      const during = opts.anotherWriterAddsDuringTheChainRead;
      if (during) {
        stored = { notes: [...stored.notes, { nonce: during.nonce, token: GBP, value: during.value, createdIn: SEEDED_TX }] };
        version += 1;
      }
      if (opts.events === 'unreadable') throw new NoteIndexUnreadable('the indexer is not answering');
      if (opts.events === 'unaskable') throw new NoteIndexUnaskable('the indexer will not take this question');
      /*
       * **BY EITHER NAME**, because a deposit whose result carried no hash can
       * only ask by the identifier it did report, and the chain answers with
       * the hash. The real indexer takes both offsets; a fake that took only
       * one could not fail the way the product does.
       */
      const named = 'hash' in tx ? tx.hash
        : tx.identifier === DEP_ID ? DEP_TX
          : (Array.from({ length: payouts }, (_, i) => i + 1).find((k) => payId(k) === tx.identifier) ?? 0) > 0
            ? payHash(Array.from({ length: payouts }, (_, i) => i + 1).find((k) => payId(k) === tx.identifier)!)
            : '';
      /*
       * **WHAT THE CHAIN PUTS ON AN EVENT IS NOT ALWAYS A TRANSACTION HASH**,
       * and the events still describe this note. This is the answer nothing
       * checked: every event agrees with every other, the commitment matches,
       * the output is the vault's - and the value written into the pool as the
       * note's creating transaction is `0x`.
       */
      const hash = opts.events === 'no-hash-named' ? '0x' : named;
      const out: ServedEvent[] = [
        /* Another output of the same transaction, owned by nobody, to be passed over. */
        { transactionHash: hash, details: { tag: 'zswapOutput', commitment: 'ee'.repeat(32), mtIndex: 0n } },
      ];
      for (const o of [...seeded, ...produced].filter((x) => x.hash === named)) {
        out.push({
          transactionHash: hash,
          details: {
            tag: 'zswapOutput',
            commitment: await vaultNoteCommitment(o.coin, VAULT),
            contract: VAULT,
            mtIndex: opts.events === 'moved' ? o.index + 1n : o.index,
          },
        });
      }
      return out;
    },
  };
  const saves: VaultNotes[] = [];
  const creates: VaultNotes[] = [];
  let exists = opts.poolExists ?? true;
  /*
   * **VERSIONED, AND IT REFUSES A WRITE BUILT ON AN OLDER READ**, which is
   * `SealedNotePool.save`'s own refusal mirrored here for `create`'s reason
   * below: a fake that accepted any write would let the client hand back a
   * version it did not load and nothing here would object.
   */
  let version = 1;
  let racesLeftToLose = opts.poolRaceLostTimes ?? 0;
  const kept = opts.keptIn;
  const watched: NotePool | undefined = kept && {
    load: async (a) => {
      const r = await kept.pool.load(a);
      stored = { notes: r.notes }; version = r.readAt.version;
      return r;
    },
    save: async (a, n, builtOn) => {
      await kept.pool.save(a, n, builtOn);
      stored = { notes: n.notes }; version = builtOn.version + 1; saves.push(n);
    },
    create: async (a, n) => {
      await kept.pool.create(a, n);
      exists = true; stored = { notes: n.notes }; version = 1; creates.push(n);
    },
  };
  const pool: NotePool = watched ?? {
    load: async () => ({ notes: stored.notes, readAt: { vault: VAULT, version } }),
    save: async (a, n, builtOn) => {
      if (builtOn.version !== version) throw new VaultPoolAdvancedSinceRead(a, builtOn.version, version);
      /*
       * **THE RACE THE VERSION CHECK ABOVE CANNOT CATCH**, mirrored from the
       * shipped store: two writers whose copies were both current, both filing
       * the version after it. The store settles it by CLAIMING the number, and
       * the loser is told by this class. Counted down rather than latched, so a
       * test can say how many attempts are lost.
       */
      if (racesLeftToLose > 0) {
        racesLeftToLose -= 1;
        version += 1;              // the other writer's version is now filed
        throw new VaultPoolVersionAlreadyFiled(a, builtOn.version + 1);
      }
      stored = n; version += 1; saves.push(n);
    },
    /*
     * MIRRORS `SealedNotePool.create`'s own refusal rather than accepting
     * anything. A fake that would happily create a second pool is a
     * fake of a store this project does not have, and `openPool`'s guard would
     * then be the only thing standing between a lost record and a fabricated
     * empty treasury.
     */
    create: async (a, n) => {
      if (exists) throw new Error(`${a} already has a note pool`);
      exists = true; stored = n; creates.push(n);
    },
  };

  /*
   * A pool nobody can reach, for the vault that never needed one. Every method
   * throws by the same name, so a failure says which verb was reached for.
   */
  const refusesEverything: NotePool = {
    load: async () => { throw new Error('the note pool was LOADED on a path that has none'); },
    save: async () => { throw new Error('the note pool was SAVED on a path that has none'); },
    create: async () => { throw new Error('the note pool was CREATED on a path that has none'); },
  };

  const calls: Array<{ circuit: string; args: unknown[]; ctx: unknown }> = [];
  /*
   * A fake deployed contract whose circuits CALL THE WITNESSES, exactly as the
   * real ones do. A stub that ignored them would let the pool be advanced by a
   * note the contract never asked for — the defect this file is here to catch.
   *
   * IT ENFORCES THE SDK'S DISPATCH RULE INSTEAD OF ACCEPTING ANYTHING.
   *
   * A fake of `(...args) => …` would welcome any number of arguments and a plain
   * object as readily as a transaction context. `createCircuitCallTxInterface` takes the context from position ZERO
   * and passes everything after it to the circuit; nothing is read from the
   * end. So this fake refuses a first argument that is not a context, and
   * refuses more circuit arguments than the contract declares.
   *
   * A fake that mirrors the SDK's dispatch cannot share the code's blind spot
   * about the SDK's dispatch. It is still not proof — that is
   * `vault-call-convention.test.ts`, which drives the real thing.
   */
  const looksLikeContext = (u: unknown): boolean =>
    typeof u === 'object' && u !== null && typeof (u as any).getAdditionalMappings === 'function';

  const dispatch = (circuit: string, expectedArity: number) =>
    (...raw: unknown[]) => {
      if (!looksLikeContext(raw[0])) {
        throw new Error(
          `${circuit} was called without a transaction context first. midnight-js reads the `
          + 'context from position 0 and nowhere else, so the encryption mapping would be '
          + 'dropped and this would be an extra circuit argument.');
      }
      const args = raw.slice(1);
      if (args.length !== expectedArity) {
        throw new Error(`${circuit} takes ${expectedArity} argument(s), got ${args.length}`);
      }
      return args;
    };

  /**
   * **WHAT A REAL PAYOUT CALL HANDS BACK, IN THE SPELLING A CLIENT ACTUALLY
   * GETS.** A fake has to carry the real shape, not just the real circuit list.
   *
   * The client reads the change coin out of `private.nextZswapLocalState` —
   * compact-js's `decodeZswapLocalState(...)`, carried through
   * `withContractScopedTransaction` unchanged. **That is the DECODED form**: an
   * address is a hex string, not `{ bytes }`, and the token field is `type`,
   * not `color` (`onchain-runtime-v4.d.ts`). Every existing test of
   * `changeCoinOf` built the ENCODED form by hand, which is precisely why the
   * reader could not read the shape the client gets and nothing said so.
   *
   * So this fake produces the decoded form, with BOTH outputs a payment really
   * has: the payee's, addressed to a person, and the change, addressed back to
   * the vault. A fake carrying only the change would let a reader that ignored
   * `is_left` pass.
   */
  const payoutResult = (coin: any, amount: bigint, recipient: string, further: any[] = []) => {
    /* What the vault spends: the note offered, and every live further place the call carried. */
    const kept = (coin.value as bigint) + further.reduce((t, c) => t + (c.value as bigint), 0n) - amount;
    const outputs: unknown[] = [
      {
        recipient: { is_left: true, left: recipient, right: '' },
        coinInfo: { nonce: 'e0'.repeat(32), type: GBP, value: amount },
      },
    ];
    if (opts.reads !== 'none' && kept > 0n) {
      outputs.push({
        recipient: { is_left: false, left: '', right: VAULT },
        coinInfo: {
          /*
           * A nonce the kernel's derivation would NOT produce, deliberately.
           * If the client ever went back to deriving it, every assertion about
           * this value would start failing rather than quietly agreeing.
           */
          nonce: 'ab'.repeat(32),
          type: GBP,
          value: opts.reads === 'wrong-value' ? kept + 1n : kept,
        },
      });
    }
    payouts += 1;
    const hash = payHash(payouts);
    if (kept > 0n) {
      produced.push({ coin: { nonce: 'ab'.repeat(32), token: GBP, value: kept }, hash, index: 90n + BigInt(payouts) });
    }
    return {
      public: opts.payoutResult === 'no-hash' ? { txId: payId(payouts) }
        : opts.payoutResult === 'nothing-to-go-on' ? { txId: 'tx_pay' }
          : { txId: 'tx_pay', txHash: hash },
      private: opts.reads === 'absent' ? {} : { nextZswapLocalState: { outputs } },
    };
  };

  /* A direct write to the store, as another process's `save` would land. */
  const anotherWriter = (): void => {
    const becomes = opts.poolBecomesDuringTheCall;
    if (becomes) {
      stored = { notes: becomes.map((n) => ({ nonce: n.nonce, token: GBP, value: n.value, createdIn: SEEDED_TX })) };
      version += 1;
    }
    const added = opts.anotherWriterAddsDuringTheCall;
    if (!added) return;
    stored = { notes: [...stored.notes, { nonce: added.nonce, token: GBP, value: added.value, createdIn: SEEDED_TX }] };
    version += 1;
  };

  const contract: any = {
    callTx: {
      deposit: async (...raw: unknown[]) => {
        const args = dispatch('deposit', 1)(...raw);
        calls.push({ circuit: 'deposit', args, ctx: raw[0] });
        anotherWriter();
        /*
         * THE CHAIN FILES THE NOTE THIS DEPOSIT MADE. Without it the events a
         * deposit reads back would carry no output for its own commitment, and
         * the check that the events really are this note's would refuse - which
         * is a fake that cannot fail the way the product does.
         */
        const made: any = args[0];
        if (!opts.chainDoesNotFileTheNote) {
          produced.push({
            coin: { nonce: toHex(made.nonce), token: toHex(made.color), value: made.value },
            hash: DEP_TX, index: 777n,
          });
        }
        if (opts.depositResult === 'nothing-to-go-on') return { public: {} };
        if (opts.depositResult === 'hash-shaped-identifier') return { public: { txId: DEP_TX } };
        if (opts.depositResult === 'no-hash') return { public: { txId: DEP_ID } };
        return { public: { txId: DEP_ID, txHash: DEP_TX } };
      },
      /*
       * `depositUnshielded(token, amount)` — TWO arguments, and no coin. There
       * is no note to record, so this fake records nothing either: the whole
       * claim of the tests below is that nothing local moves.
       */
      depositUnshielded: async (...raw: unknown[]) => {
        const args = dispatch('depositUnshielded', 2)(...raw);
        calls.push({ circuit: 'depositUnshielded', args, ctx: raw[0] });
        if (opts.throws) throw new Error(opts.throws);
        return { public: { txId: 'tx_dep_public' } };
      },
      /*
       * `payoutUnshielded`: the same FIVE arguments as `payout`, and the
       * arity guard reads them off the vault's own contract-info.json, so this
       * count is the compiler's rather than this file's.
       *
       *   0 run  1 recipient  2 token  3 amount  4 blinding
       *
       * **It calls NO WITNESS and returns NO Zswap local state**, because the
       * circuit has neither. A fake that handed back a change coin here would
       * hide the thing being tested.
       */
      payoutUnshielded: async (...raw: unknown[]) => {
        const args = dispatch('payoutUnshielded', 5)(...raw);
        calls.push({ circuit: 'payoutUnshielded', args, ctx: raw[0] });
        if (opts.throws) throw new Error(opts.throws);
        return { public: { txId: 'tx_pay_public' } };
      },
      payout: async (...raw: unknown[]) => {
        const args = dispatch('payout', 6)(...raw);
        calls.push({ circuit: 'payout', args, ctx: raw[0] });
        anotherWriter();
        if (opts.throws) throw new Error(opts.throws);
        if (opts.asksForANote !== false) {
          /*
           * Index 3 is the amount. It has moved before, and each move failed
           * as a Uint8Array coerced into an error message as
           * `170,170,170,...`, which names nothing.
           *
           * Positional arguments into a fake contract are the one place this
           * repo cannot lean on the compiler, so the list is written out
           * beside the index that reads it, and updated with it.
           *
           *   0 run  1 recipient  2 token  3 amount  4 blinding
           *
           * FIVE, and nothing after them. The encryption mapping is NOT an
           * argument: it travels in the transaction context that arrives
           * BEFORE these, and `dispatch` above has already stripped it.
           *
           * The secret is asked for first, as the circuit asks for it before
           * it asks for a note.
           */
          const [, secret] = witnesses.nonceSecret({ privateState: undefined });
          secretsRead.push(toHex(secret as Uint8Array));
          const [, coin] = witnesses.noteToSpend({}, Buffer.from(GBP, 'hex'), args[3] as bigint);
          const further = (args[5] as any[] ?? []).filter((c) => (c.value as bigint) > 0n);
          spentCoins.push(coin, ...further);
          return payoutResult(coin, args[3] as bigint, toHex(args[1] as Uint8Array), further);
        }
        return { public: { txId: 'tx_pay' } };
      },
    },
  };

  /*
   * The witnesses now arrive at `connect` rather than being assigned onto the
   * returned contract, because that is where the SDK reads them — they belong
   * to the CompiledContract. Captured here so the fake's circuits can call them,
   * which is what makes this a fake of the contract rather than of the client.
   */
  let witnesses: any;

  /*
   * **A PUBLIC DATA PROVIDER, BECAUSE `balance` NOW ASKS THE CHAIN.**
   *
   * The state it hands back is `{ data }` and the vault's real generated
   * `ledger()` reader decodes it — which is why the commitments below are built
   * with the CONTRACT's own pure circuits rather than with a second derivation
   * written here. What this harness controls is WHICH notes the chain holds,
   * which is the thing the reconciliation is about.
   */
  const chainNotesOf = (): Uint8Array[] => {
    const source = Array.isArray(opts.chain)
      ? opts.chain.map(n => ({ nonce: n.nonce, token: GBP, value: n.value, index: 0n }))
      : stored.notes;
    const vault = Uint8Array.from(Buffer.from(VAULT, 'hex'));
    return source.map((n) => {
      const coin = {
        nonce: Uint8Array.from(Buffer.from(n.nonce, 'hex')),
        color: Uint8Array.from(Buffer.from(n.token, 'hex')),
        value: n.value,
      };
      return vaultCircuits.heldCommitmentOf(coin, vaultCircuits.noteBlindingOf(vault, coin));
    });
  };

  /*
   * **THE VAULT'S PUBLIC BALANCE, AS ITS CONTRACT STATE CARRIES IT.**
   *
   * `ContractState.balance` is a `Map` whose keys are token-type OBJECTS,
   * `{ tag: 'unshielded', raw }`, and the fee token `{ tag: 'dust' }` sits in
   * it too. Mirrored rather than simplified: the shape is what the client
   * reads, and a missing map is the answer the client must NOT turn into zero.
   */
  const unshielded = (raw: string) => ({ tag: 'unshielded', raw });
  const balanceOf = (): unknown => {
    if (opts.publicBalances === 'not-a-map') return [{ tokenType: NIGHT, balance: 5n }];
    if (opts.publicBalances === 'bad-row') {
      return new Map<unknown, unknown>([[unshielded(NIGHT), 5n], [unshielded(NIGHT), '7']]);
    }
    const rows: Array<[string, bigint]> = Array.isArray(opts.publicBalances)
      ? opts.publicBalances
      : [[NIGHT, 1_000n]];
    return new Map<unknown, unknown>([[{ tag: 'dust' }, 3n], ...rows.map(([raw, v]) => [unshielded(raw), v] as const)]);
  };

  const providers = async () => ({
    publicDataProvider: opts.publicBalances === 'no-provider' ? {} : {
      queryContractState: async () => served(await (async () => {
        if (opts.publicBalances === 'read-throws') throw new Error('indexer said no');
        if (opts.publicBalances === 'unreadable') return null;
        const state = await chainState();
        if (state === null || opts.publicBalances === 'no-balance') return state;
        return { ...state, balance: balanceOf() };
      })()),
    },
  });

  const chainState = async (): Promise<Record<string, unknown> | null> => {
    if (opts.chain === 'read-throws') throw new Error('indexer said no');
    if (opts.chain === 'unreadable') return null;
    if (opts.chain === 'no-notes-field') {
      /*
       * A STATE OF THE RIGHT SHAPE WHOSE DECODED FORM HAS NO NOTES SET.
       * The shape is what it should be, so this stays a test of the reader
       * refusing rather than of the shape gate refusing first - the two are
       * different failures and want different answers.
       */
      return { data: { ...shapedLike(CANONICAL_SLOTS), account: { bytes: new Uint8Array(32) } } };
    }
    const held = chainNotesOf().map(toHex);
    return {
      data: {
        /* What the shape reader asks the state, before any field is read off it. */
        ...shapedLike(opts.ledgerSlots ?? CANONICAL_SLOTS),
        account: { bytes: Uint8Array.from(Buffer.from(VAULT, 'hex')) },
        notes: {
          member: (c: Uint8Array) => held.includes(toHex(c)),
          size: () => BigInt(held.length),
        },
        payments: 0n,
      },
    };
  };

  /*
   * The journal is a list this harness holds, and each entry also notes how
   * many circuit calls had been made when it was written -- **which is the
   * fact under test**: an attempt written after the call closes nothing.
   */
  const journalled: Array<PaymentAttempt & { callsMadeSoFar: number }> = [];
  const journal: PaymentJournal = {
    record: async (_vault, attempt) => {
      if (opts.journal === 'refuses') throw new Error('the journal cannot be written');
      journalled.push({ ...attempt, callsMadeSoFar: calls.length });
    },
  };
  const depositsJournalled: Array<DepositAttempt & { slot: number; callsMadeSoFar: number; savesMadeSoFar: number }> = [];
  /* A slot's nonce, as the journal derives it: the `slot`th of the nonces this harness was handed. */
  const nonceOfSlot = (slot: number) => opts.depositNonces?.[slot - 1] ?? claimedNonce(slot);
  const depositJournal: DepositJournal = {
    nonceAt: (_vault, _money, slot) => nonceOfSlot(slot) as never,
    claim: async (_vault, money, slot, attemptedAt) => {
      if (opts.depositJournal === 'refuses') throw new Error('the deposit journal cannot be written');
      const nonce = nonceOfSlot(slot);
      const attempt = { coin: { nonce, token: money.token, value: money.value }, attemptedAt };
      depositsJournalled.push({ ...attempt, slot, callsMadeSoFar: calls.length, savesMadeSoFar: saves.length });
      return attempt;
    },
  };
  const history: VaultOutputHistory = {
    everCreated: async () => {
      if (opts.history === 'unreadable') throw new Error('the vault\x27s outputs cannot be listed');
      const spentBefore = (Array.isArray(opts.history) ? opts.history : [])
        .map((nonce) => ({ nonce, token: GBP, value: 500n }));
      const coins = [...seeded.map((x) => x.coin), ...produced.map((x) => x.coin), ...spentBefore];
      return new Set(await Promise.all(coins.map((c) => vaultNoteCommitment(c, VAULT))));
    },
  };
  const ledger = new VaultLedger(
    { networkId: 'preview' } as never, {} as never, providers as never, {},
    opts.poolThrows ? refusesEverything : pool,
    VAULT_ARTEFACTS,
    kept ? kept.payments : opts.journal === 'none' ? undefined : journal,
    kept ? kept.deposits : opts.depositJournal === 'none' ? undefined : depositJournal,
    opts.history === 'none' ? undefined : history);
  (ledger as any).connect = async (_a: string, w: unknown) => { witnesses = w; return contract; };

  /*
   * A STAND-IN FOR THE TRANSACTION CONTEXT, carrying the one thing midnight-js
   * reads off it. This seam exists so the client can be driven without a node —
   * **it is not where the convention is pinned.** A test that only watches an
   * overridden method is a test of our own model.
   * `vault-call-convention.test.ts` drives the real SDK.
   */
  const scopes: Array<{ scopeName: string; mappings: ReadonlyMap<string, string> }> = [];
  (ledger as any).scopedCall = async (fn: any, plan: any) => {
    scopes.push({ scopeName: `vault:${plan.circuit}`, mappings: plan.mappings });
    const txCtx = { getAdditionalMappings: () => plan.mappings };
    return fn(txCtx, ...plan.args);
  };

  return {
    ledger, calls, saves, creates, scopes, eventReads, spentCoins, secretsRead, journalled, depositsJournalled,
    current: () => stored, witnessesUsed: () => witnesses,
  };
}

