/**
 * V-74: the vault client, against a chain whose answers we control.
 *
 * What only this layer can get wrong: advancing the pool on a call that did not
 * happen, advancing it by the wrong note, or holding a copy of it taken before
 * the call. Each of those is a vault whose money stops moving, and none of them
 * is visible in the contract tests.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  VaultLedger, VaultChainUnreadable, VaultPoolDisagreesWithChain,
  VaultCannotAfford, VaultAlreadyHoldsNotes,
  type NotePool, type VaultPayment, type PaymentAttempt, type PaymentJournal,
  type DepositAttempt, type DepositJournal,
} from './vault-ledger.js';
import { VaultPoolAdvancedSinceRead, VaultPoolVersionAlreadyFiled } from './vault-pool.js';
/*
 * The VAULT's own pure circuits, imported for real. `C198`'s reconciliation
 * computes a note's commitment with these, and a fake chain that computed them
 * any other way would be a second implementation of the rule the money depends
 * on — which is `M-104`, the failure this project has paid for most often.
 */
import { pureCircuits as vaultCircuits } from '../../contracts/managed-vault/contract/index.js';
import { readFileSync } from 'node:fs';
import { balanceOf, type VaultNotes } from './vault-notes.js';
import { toHex } from '../core/crypto.js';
import { payeeFor, unshieldedPayeeFor } from '../testing/payees.js';
import {
  NoteIndexUnaskable, NoteIndexUnreadable, vaultNoteCommitment, indexForSpend,
  type CreatingTransaction, type NoteEvents, type ServedEvent,
} from './note-index.js';

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
 * **REGISTERED ONCE, AT MODULE SCOPE, AND STATELESS.** `C222` is what a factory
 * closing over per-test state costs: the binding becomes module-global, the
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

const GBP = 'aa'.repeat(32);
/** The token the product launches with, and it is UNSHIELDED by definition. */
const NIGHT = '99'.repeat(32);
const SEED = '5e'.repeat(32);
/*
 * A REAL 32-BYTE CONTRACT ADDRESS, because `C198`'s reconciliation decodes it:
 * the note blinding is a function of the vault's own address
 * (`Vault.compact`'s `noteBlindingOf`), so a placeholder string is no longer
 * something this harness can hand over.
 */
const VAULT = 'a7'.repeat(32);
/* The VAULT's compiled artefacts, not the account's. The arity guard reads these. */
const VAULT_ARTEFACTS = new URL('../../contracts/managed-vault', import.meta.url).pathname;
/*
 * ONE PAYEE, ONE VALUE. A-1.
 *
 * This used to be a separate `PAYEE_KEY` sitting beside a separate 32-byte
 * `recipient`, which is exactly the pair that could disagree — and the test
 * that constructed them independently is the reason nobody noticed nothing in
 * `src/` ever constructed them together. V-80.
 */
const PAYEE = payeeFor(new Uint8Array(32).fill(0x44), 'preview');   // the harness's network
/*
 * **THE SAME 32 BYTES, IN THE OTHER KEY SPACE.**
 *
 * Deliberately identical to `PAYEE`'s coin key, because that is the hazard: a
 * `UserAddress` and a `ZswapCoinPublicKey` of the same bytes are
 * indistinguishable to everything downstream of the address type. If this
 * fixture used different bytes, the dispatch tests below could pass because the
 * values differed rather than because the KIND did.
 */
const PUBLIC_PAYEE = unshieldedPayeeFor(new Uint8Array(32).fill(0x44), 'preview');
const BY = { id: 'kc' } as never;

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
const SEEDED_TX = 'd0'.repeat(32);
const DEP_TX = 'de'.repeat(32);
/**
 * The other name the same transaction has: 33 bytes, not 32, and a different
 * field of the same result. A real one begins `00`, and the length is what
 * tells the two names apart.
 */
const DEP_ID = `00${'de'.repeat(32)}`;
const payHash = (k: number) => k.toString(16).padStart(64, 'c');
const seededIndex = (i: number) => 40n + BigInt(i) * 3n;

/*
 * The events the harness in use serves, reached through one constant so every
 * payout below passes the same source. Replaced each time a harness is built.
 */
let eventsInUse: NoteEvents = { eventsOf: async () => { throw new Error('no harness built'); } };
const EVENTS: NoteEvents = { eventsOf: (tx) => eventsInUse.eventsOf(tx) };

const payment = (amount: bigint): VaultPayment => ({
  proposal: '11'.repeat(32), root: '22'.repeat(32), payees: 3n,
  opensAt: 1_800_000_000n, closesAt: 1_800_604_800n, salt: '33'.repeat(32),
  payee: PAYEE, token: GBP, amount,
  blinding: '55'.repeat(32), nonce: '66'.repeat(32), path: {},
});

function harness(opts: {
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
   * **WHERE A PRIVATE DEPOSIT WRITES ITS COIN DOWN.** The same three shapes as
   * `journal`, remembered in `depositsJournalled`.
   */
  depositJournal?: 'none' | 'refuses';
  /**
   * **WHAT THE CHAIN SAYS THIS VAULT HOLDS IN PUBLIC MONEY.**
   *
   * The indexer's own door, `queryUnshieldedBalances`, which returns
   * `{ tokenType, balance }` rows rather than the `Map` keyed by TokenType
   * OBJECTS that `ContractState.balance` is.
   *
   *   omitted        the vault holds 1,000 of NIGHT
   *   'no-provider'  a bundle whose provider cannot answer the question at all
   *   'unreadable'   the indexer has no contract action for this address (null)
   *   'read-throws'  the read itself fails
   *   'not-a-list'   an answer of a shape this client cannot read
   *   'bad-row'      a list containing a row that is not { tokenType, balance }
   *   rows           exactly these colours and amounts
   */
  publicBalances?: 'no-provider' | 'unreadable' | 'read-throws' | 'not-a-list' | 'bad-row'
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
      const named = 'hash' in tx ? tx.hash : (tx.identifier === DEP_ID ? DEP_TX : '');
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
     * anything — `T-34`. A fake that would happily create a second pool is a
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
   * IT NOW ENFORCES THE SDK'S DISPATCH RULE INSTEAD OF ACCEPTING ANYTHING. V-82.
   *
   * The previous version was `(...args) => …`, so thirteen arguments were as
   * welcome as twelve and a plain object was as welcome as a transaction
   * context — and the comment beside it wrote the WRONG convention down as
   * fact. `createCircuitCallTxInterface` takes the context from position ZERO
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
   * GETS.** `C239`, and `T-34`'s obligation applied to a shape rather than to a
   * circuit list.
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
  const payoutResult = (coin: any, amount: bigint, recipient: string) => {
    const kept = (coin.value as bigint) - amount;
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
      public: { txId: 'tx_pay', txHash: hash },
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
       * `payoutUnshielded` — the same TWELVE arguments as `payout`, and the
       * arity guard reads them off the vault's own contract-info.json, so this
       * count is the compiler's rather than this file's.
       *
       *   0 proposal  1 root      2 payees    3 opensAt  4 closesAt
       *   5 salt      6 recipient 7 token     8 amount
       *   9 blinding  10 nonce    11 path
       *
       * **It calls NO WITNESS and returns NO Zswap local state**, because the
       * circuit has neither. A fake that handed back a change coin here would
       * hide the thing being tested.
       */
      payoutUnshielded: async (...raw: unknown[]) => {
        const args = dispatch('payoutUnshielded', 12)(...raw);
        calls.push({ circuit: 'payoutUnshielded', args, ctx: raw[0] });
        if (opts.throws) throw new Error(opts.throws);
        return { public: { txId: 'tx_pay_public' } };
      },
      payout: async (...raw: unknown[]) => {
        const args = dispatch('payout', 12)(...raw);
        calls.push({ circuit: 'payout', args, ctx: raw[0] });
        anotherWriter();
        if (opts.throws) throw new Error(opts.throws);
        if (opts.asksForANote !== false) {
          /*
           * Index 8 is the amount. It has now been 8, then 9, then 8 again —
           * moved by `payslipKey` arriving (V-75) and by it being deleted
           * (V-77) — and each move failed as a Uint8Array coerced into an
           * error message as `170,170,170,...`, which names nothing.
           *
           * Positional arguments into a fake contract are the one place this
           * repo cannot lean on the compiler, so the list is written out
           * beside the index that reads it, and updated with it.
           *
           *   0 proposal  1 root      2 payees    3 opensAt  4 closesAt
           *   5 salt      6 recipient 7 token     8 amount
           *   9 blinding  10 nonce    11 path
           *
           * TWELVE, and nothing after them. The encryption mapping is NOT an
           * argument: it travels in the transaction context that arrives
           * BEFORE these, and `dispatch` above has already stripped it. The
           * previous version of this comment said the opposite and was the
           * reason V-82 survived.
           */
          const [, coin] = witnesses.noteToSpend({}, Buffer.from(GBP, 'hex'), args[8] as bigint);
          spentCoins.push(coin);
          return payoutResult(coin, args[8] as bigint, toHex(args[6] as Uint8Array));
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
   * **THE INDEXER'S OWN DOOR FOR A CONTRACT'S PUBLIC BALANCES.**
   *
   * `queryUnshieldedBalances` returns `UnshieldedBalance[]` —
   * `{ tokenType: RawTokenType, balance: bigint }` — and `null` when the
   * indexer has no contract action for the address. Mirrored rather than
   * simplified: the shape is what the client reads, and `null` is the
   * answer the client must NOT turn into zero.
   */
  const publicBalanceProvider = () => {
    if (opts.publicBalances === 'no-provider') return {};
    return {
      queryUnshieldedBalances: async () => {
        if (opts.publicBalances === 'read-throws') throw new Error('indexer said no');
        if (opts.publicBalances === 'unreadable') return null;
        if (opts.publicBalances === 'not-a-list') return { tokenType: NIGHT, balance: 5n };
        if (opts.publicBalances === 'bad-row') {
          return [{ tokenType: NIGHT, balance: 5n }, { tokenType: NIGHT, balance: '7' }];
        }
        const rows: Array<[string, bigint]> = Array.isArray(opts.publicBalances)
          ? opts.publicBalances
          : [[NIGHT, 1_000n]];
        return rows.map(([tokenType, balance]) => ({ tokenType, balance }));
      },
    };
  };

  const providers = async () => ({
    publicDataProvider: {
      ...publicBalanceProvider(),
      queryContractState: async () => {
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
      },
    },
  });

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
  const depositsJournalled: Array<DepositAttempt & { callsMadeSoFar: number; savesMadeSoFar: number }> = [];
  const depositJournal: DepositJournal = {
    record: async (_vault, attempt) => {
      if (opts.depositJournal === 'refuses') throw new Error('the deposit journal cannot be written');
      depositsJournalled.push({ ...attempt, callsMadeSoFar: calls.length, savesMadeSoFar: saves.length });
    },
  };
  const ledger = new VaultLedger(
    { networkId: 'preview' } as never, {} as never, providers as never, {},
    opts.poolThrows ? refusesEverything : pool,
    VAULT_ARTEFACTS,
    kept ? kept.payments : opts.journal === 'none' ? undefined : journal,
    kept ? kept.deposits : opts.depositJournal === 'none' ? undefined : depositJournal);
  (ledger as any).connect = async (_a: string, w: unknown) => { witnesses = w; return contract; };

  /*
   * A STAND-IN FOR THE TRANSACTION CONTEXT, carrying the one thing midnight-js
   * reads off it. This seam exists so the client can be driven without a node —
   * **it is not where the convention is pinned.** A test that only watches an
   * overridden method is a test of our own model, which is the failure that
   * produced V-82. `vault-call-convention.test.ts` drives the real SDK.
   */
  const scopes: Array<{ scopeName: string; mappings: ReadonlyMap<string, string> }> = [];
  (ledger as any).scopedCall = async (fn: any, plan: any) => {
    scopes.push({ scopeName: `vault:${plan.circuit}`, mappings: plan.mappings });
    const txCtx = { getAdditionalMappings: () => plan.mappings };
    return fn(txCtx, ...plan.args);
  };

  return {
    ledger, calls, saves, creates, scopes, eventReads, spentCoins, journalled, depositsJournalled,
    current: () => stored, witnessesUsed: () => witnesses,
  };
}

describe('V-74: the vault client', () => {
  it('hands the deposit circuit the COIN AND NOTHING ELSE, and adds the note once it lands', async () => {
    /*
     * S6a: the second argument was the blinding, and the circuit no longer has
     * one. A client that still passed it would be caught by the arity guard
     * rather than here — this pins that it does not, because the argument that
     * could carry a value nobody can reproduce is the whole of C124.
     */
    const { ledger, calls, current } = harness({ notes: [] });
    await ledger.deposit(VAULT, { nonce: '77'.repeat(32), token: GBP, value: 500n }, BY);

    expect(calls[0].circuit).toBe('deposit');
    expect(calls[0].args).toHaveLength(1);
    expect(balanceOf(current(), GBP)).toBe(500n);
    /* Where its index is to be read from, off the finalised result, and no index. */
    expect(current().notes[0].createdIn).toBe(DEP_TX);
    expect(current().notes[0]).not.toHaveProperty('index');
  });

  /* ------------------------------------------------------------------ *
   * A DEPOSIT RECORDS THE TRANSACTION THAT CREATED ITS NOTE, IN THE SAME
   * ACTION - because a note that records none is money the vault owns and
   * cannot spend, and the repair was a second command somebody had to remember.
   * ------------------------------------------------------------------ */

  it('records the creating transaction off the call, and does not ask the chain when it does not have to', async () => {
    const { ledger, current, eventReads, saves } = harness({ notes: [] });
    const out = await ledger.deposit(
      VAULT, { nonce: '77'.repeat(32), token: GBP, value: 500n }, BY, eventsInUse);

    /* RED WHEN the ordinary path stops recording the transaction the call reported. */
    expect(out.recordedFrom).toBe('the call');
    expect(out.createdIn).toBe(DEP_TX);
    expect(current().notes[0].createdIn).toBe(DEP_TX);
    /* RED WHEN a deposit reads the chain it did not need to read, which is a network call per deposit. */
    expect(eventReads).toEqual([]);
    /* RED WHEN the note is written by more than one save, which would be a fourth writer of this pool. */
    expect(saves).toHaveLength(1);
  });

  it('READS IT FROM THE CHAIN when the call reports only the identifier, still in ONE write', async () => {
    const { ledger, current, eventReads, saves } = harness({ notes: [], depositResult: 'no-hash' });
    const out = await ledger.deposit(
      VAULT, { nonce: '77'.repeat(32), token: GBP, value: 500n }, BY, eventsInUse);

    /*
     * RED WHEN a result carrying no hash strands the note. This is the branch
     * that used to write a note with no creating transaction and say nothing.
     */
    expect(out.recordedFrom).toBe('the chain');
    expect(out.createdIn).toBe(DEP_TX);
    expect(current().notes[0].createdIn).toBe(DEP_TX);
    /* RED WHEN the chain is asked by a name it was never given: the pool holds the hash, the call reported the identifier. */
    expect(eventReads).toEqual([{ identifier: DEP_ID }]);
    /* RED WHEN the repair becomes a second write, which is what makes it a fourth writer of an unlocked pool. */
    expect(saves).toHaveLength(1);
  });

  it('STILL WRITES THE NOTE when nothing can be recorded, and SAYS the note is stranded', async () => {
    const { ledger, current, saves } = harness({ notes: [], depositResult: 'no-hash' });
    /* No events source at all: the money has landed and there is nothing to read the hash from. */
    const out = await ledger.deposit(VAULT, { nonce: '77'.repeat(32), token: GBP, value: 500n }, BY);

    /*
     * RED WHEN the deposit throws here. The transaction has settled: throwing
     * loses the note from the pool entirely, and a vault holding money it has
     * no record of needs its whole history replayed, which is strictly worse
     * than a note that records no transaction.
     */
    expect(out.recordedFrom).toBe('nowhere');
    expect(saves).toHaveLength(1);
    expect(current().notes[0].value).toBe(500n);
    /* RED WHEN a note is written with no creating transaction and nothing says so. */
    expect(out.stranded).toContain('no source of the chain');
    expect(current().notes[0]).not.toHaveProperty('createdIn');
  });

  it('says WHY when the chain refuses the question, rather than only that it failed', async () => {
    const { ledger, current, saves } = harness({
      notes: [], depositResult: 'no-hash', events: 'unreadable' });
    const out = await ledger.deposit(
      VAULT, { nonce: '77'.repeat(32), token: GBP, value: 500n }, BY, eventsInUse);

    /* RED WHEN a chain read that throws takes the deposit down with it. */
    expect(out.recordedFrom).toBe('nowhere');
    expect(saves).toHaveLength(1);
    /* RED WHEN the reason is swallowed, leaving somebody to guess which of the three failures it was. */
    expect(out.stranded).toContain('the indexer is not answering');
    expect(current().notes[0]).not.toHaveProperty('createdIn');
  });

  it('WILL NOT TAKE A 32-BYTE VALUE AS THE 33-BYTE NAME, and asks the chain nothing', async () => {
    const { ledger, eventReads } = harness({
      notes: [], depositResult: 'hash-shaped-identifier' });
    const out = await ledger.deposit(
      VAULT, { nonce: '77'.repeat(32), token: GBP, value: 500n }, BY, eventsInUse);

    /*
     * RED WHEN the length check on the identifier widens. The two names are 32
     * and 33 bytes and the chain is asked by one or the other; a hash handed
     * over as an identifier is a question about a transaction nothing is filed
     * under, and the answer to it would be recorded against this note.
     */
    expect(out.recordedFrom).toBe('nowhere');
    expect(out.stranded).toContain('neither a transaction hash nor an identifier');
    /* RED WHEN the chain is asked anyway, with a name it cannot use. */
    expect(eventReads).toEqual([]);
  });

  it('WILL NOT RECORD A TRANSACTION THAT DID NOT CREATE THIS NOTE, even though one answered', async () => {
    const { ledger, current, saves } = harness({
      notes: [], depositResult: 'no-hash', chainDoesNotFileTheNote: true });
    const out = await ledger.deposit(
      VAULT, { nonce: '77'.repeat(32), token: GBP, value: 500n }, BY, eventsInUse);

    /*
     * RED WHEN the hash is taken off the first event the chain returns. A hash
     * nothing established created this note reads as a HEALTHY note everywhere
     * afterwards - in the pool, on the screen, and in the check a payment makes
     * before it proposes - and is refused only at the spend, after a proposal
     * and its approvals have been proved and paid for.
     */
    expect(out.recordedFrom).toBe('nowhere');
    expect(out.createdIn).toBeUndefined();
    expect(current().notes[0]).not.toHaveProperty('createdIn');
    /* RED WHEN the reason stops saying it was the chain's answer that did not match. */
    expect(out.stranded).toMatch(/did not create this note|not for a contract|different contract/);
    /* RED WHEN the note is lost because the check threw instead of answering. */
    expect(saves).toHaveLength(1);
    expect(current().notes[0].value).toBe(500n);
  });

  /**
   * **WHETHER READING AGAIN COULD ANSWER IS PART OF WHAT A STRANDED NOTE
   * REPORTS**, because it is the whole of what the person holding it does next.
   *
   * An indexer a moment behind a node answers in a minute and the note is
   * repaired by asking again. An indexer this client can no longer ask never
   * answers, and somebody told to ask again asks again for ever.
   */
  it('SAYS A SLOW INDEXER IS RETRYABLE, and does not call it final', async () => {
    const { ledger, current, saves } = harness({
      notes: [], depositResult: 'no-hash', events: 'unreadable' });
    const out = await ledger.deposit(
      VAULT, { nonce: '77'.repeat(32), token: GBP, value: 500n }, BY, eventsInUse);

    /*
     * RED WHEN a read that could succeed in a minute is reported as the chain's
     * final word. Telling somebody to stop waiting for an answer that would
     * have come is the worse of the two mistakes: a note whose place is never
     * read is money nobody reaches.
     */
    expect(out.recordedFrom).toBe('nowhere');
    expect(out.permanent).toBeUndefined();
    expect(out.stranded).toContain('the chain could not say which transaction this was');
    expect(saves).toHaveLength(1);
    expect(current().notes[0]).not.toHaveProperty('createdIn');
  });

  it('AND A REFUSAL IS NOT FINAL: only a question the indexer will not take is', async () => {
    /*
     * **THE ASYMMETRY, DRIVEN ON BOTH SIDES.** Every refusal but one names
     * reading again as what resolves it, so only the one that does not may be
     * reported as final. This is the pair that keeps the classification from
     * quietly widening back.
     */
    const refused = harness({ notes: [], depositResult: 'no-hash', chainDoesNotFileTheNote: true });
    const a = await refused.ledger.deposit(
      VAULT, { nonce: '77'.repeat(32), token: GBP, value: 500n }, BY, eventsInUse);
    /* RED WHEN a refusal the chain can answer differently tomorrow is called
     * final. Its own sentence tells the reader to read again. */
    expect(a.recordedFrom).toBe('nowhere');
    expect(a.permanent).toBeUndefined();

    const unaskable = harness({ notes: [], depositResult: 'no-hash', events: 'unaskable' });
    const b = await unaskable.ledger.deposit(
      VAULT, { nonce: '77'.repeat(32), token: GBP, value: 500n }, BY, eventsInUse);
    /* RED WHEN the one error that IS final stops being reported as final,
     * which leaves somebody reading again for ever. */
    expect(b.permanent).toBe(true);
  });

  it('SAYS A QUESTION THE INDEXER WILL NOT TAKE IS FINAL, and does not say try again', async () => {
    const { ledger, current, saves } = harness({
      notes: [], depositResult: 'no-hash', events: 'unaskable' });
    const out = await ledger.deposit(
      VAULT, { nonce: '77'.repeat(32), token: GBP, value: 500n }, BY, eventsInUse);

    /*
     * RED WHEN the two are not told apart. They used to produce the identical
     * result, so the screen printed the identical frame, whose word is YET.
     */
    expect(out.recordedFrom).toBe('nowhere');
    expect(out.permanent).toBe(true);
    /* RED WHEN the refusal's own words are wrapped in the sentence for a read
     * that merely failed, which says the chain could not say - it said. */
    expect(out.stranded).toBe('the indexer will not take this question');
    /* RED WHEN a final answer loses the note, which is what throwing here does. */
    expect(saves).toHaveLength(1);
    expect(current().notes[0].value).toBe(500n);
    expect(current().notes[0]).not.toHaveProperty('createdIn');
  });

  it('WILL NOT RECORD A HASH THE CHAIN DID NOT NAME, even when the events are this note\x27s', async () => {
    const { ledger, current, saves } = harness({
      notes: [], depositResult: 'no-hash', events: 'no-hash-named' });
    const out = await ledger.deposit(
      VAULT, { nonce: '77'.repeat(32), token: GBP, value: 500n }, BY, eventsInUse);

    /*
     * **THE ONE VALUE ON THIS PATH THAT NOTHING CHECKED.** Every event agrees
     * with every other, the commitment matches and the output is this vault's -
     * so every question the client asked was answered yes, and the value
     * written into the pool as the note's creating transaction was `0x`.
     *
     * RED WHEN a value that is not a transaction hash is recorded. A note
     * carrying one reads as HEALTHY in the pool, on the screen and in the
     * check a payment makes before it proposes, and is refused only at the
     * spend - after a proposal and its approvals have been proved and paid for.
     */
    expect(out.recordedFrom).toBe('nowhere');
    expect(out.createdIn).toBeUndefined();
    expect(current().notes[0]).not.toHaveProperty('createdIn');
    expect(out.stranded).toMatch(/without naming its hash|sixty-four hex characters/);
    /*
     * **AND IT IS NOT FINAL.** An event whose transaction hash is not a hash
     * is an indexer that has not caught up with the node, and the refusal's own
     * sentence says to read again once the transaction shows on it.
     *
     * RED WHEN it is reported as the chain's last word - which puts "reading
     * again will not answer" above a reason that says to read again, and stops
     * the one act that repairs the note.
     */
    expect(out.permanent).toBeUndefined();
    /* RED WHEN the note is lost because the refusal threw instead of answering. */
    expect(saves).toHaveLength(1);
    expect(current().notes[0].value).toBe(500n);
  });

  it('says so when the call names the transaction NEITHER way', async () => {
    const { ledger, current } = harness({ notes: [], depositResult: 'nothing-to-go-on' });
    const out = await ledger.deposit(
      VAULT, { nonce: '77'.repeat(32), token: GBP, value: 500n }, BY, eventsInUse);

    /* RED WHEN a result with no name at all is reported as some other failure. */
    expect(out.recordedFrom).toBe('nowhere');
    expect(out.stranded).toContain('neither a transaction hash nor an identifier');
    expect(current().notes[0]).not.toHaveProperty('createdIn');
  });

  it('REFUSES TO READ A VAULT OF ANOTHER BUILD\x27S SHAPE, before a field is read off it', async () => {
    /*
     * RED WHEN this read is left outside the shape gate. It is not on the
     * payment path: it is what answers `balance` and `affordable`, which is
     * what decides whether a run is raised. A field is addressed by position,
     * so on a vault of another shape the answer about notes comes out of
     * whichever field is in that slot - silently, where the two are stored the
     * same way.
     */
    const { ledger } = harness({ ledgerSlots: ['cell', 'map', 'map', 'cell'] });
    const failed = await ledger.balance(VAULT, GBP).then(() => null, (e: Error) => e);
    expect(failed?.name).toBe('VaultLedgerShapeMismatch');
    expect(failed?.message).toMatch(/holds 4 ledger fields/);
  });

  it('AND A STRANDED NOTE IS EXACTLY THE ONE A PAYMENT REFUSES, which is why it is worth saying', async () => {
    const { ledger, current } = harness({ notes: [], depositResult: 'no-hash' });
    await ledger.deposit(VAULT, { nonce: '77'.repeat(32), token: GBP, value: 500n }, BY);

    /*
     * RED WHEN a note with no recorded transaction becomes spendable, or stops
     * being refused by name. The claim "this note cannot be paid out" is
     * measured here against the product's own refusal rather than asserted in
     * a comment.
     */
    const stranded = current().notes[0];
    await expect(indexForSpend(VAULT as `${string}`, stranded, eventsInUse)).rejects
      .toThrow(/does not record which transaction created it/);
  });

  it('ADVANCES THE POOL BY THE NOTE THE CONTRACT ACTUALLY TOOK, not the one it assumed', async () => {
    /*
     * The client does not choose the note twice. It reads back which one the
     * witness handed over, because a client that assumed would drift from the
     * chain on the first payment where the assumption was wrong — and then
     * every later payment is refused as "not in this vault's pool".
     */
    const { ledger, current } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 1_000n }, { nonce: '02'.repeat(32), value: 300n }],
    });
    const r = await ledger.payout(VAULT, payment(200n), BY, EVENTS);

    /*
     * **THE KIND IS ESTABLISHED BEFORE THE NOTE IS READ.**
     *
     * `VaultPaid` is a union: an unshielded payment spends no note and reports
     * none. A caller that wants the note has to say which payment it made, and
     * that one line is what stops a pool being advanced by a payment that never
     * touched one.
     */
    if (r.kind !== 'shielded') throw new Error('a shielded payee was paid through another door');
    // The smallest covering note, chosen by the witness and reported back.
    expect(r.spentNote).toBe('02'.repeat(32));
    expect(balanceOf(current(), GBP)).toBe(1_100n);
    expect(current().notes.some(n => n.value === 100n && n.createdIn === payHash(1) && n.index === undefined))
      .toBe(true);
  });

  /*
   * C7's SILENT HALF, PINNED AT THE ONLY LAYER THAT CAN SEE IT. A-1, V-80.
   *
   * The coin ciphertext that makes a payment visible in the payee's own wallet
   * is encrypted to whatever key rides in `additionalCoinEncPublicKeyMappings`.
   * That mapping is a TRANSACTION option, so the contract never sees it, it is
   * not part of what the signers approved, and no assert anywhere can reach it.
   * Hand it the wrong key and the payment settles perfectly into a coin the
   * payee will never be shown.
   *
   * There is no contract test for this and there cannot be. This is it.
   */
  it('ENCRYPTS THE PAYMENT TO THE SAME PAYEE IT PAYS, from one value', async () => {
    const { ledger, calls } = harness();
    await ledger.payout(VAULT, payment(200n), BY, EVENTS);

    const call = calls.find(c => c.circuit === 'payout')!;
    /* 6 is the recipient — the coin key, the only half the circuit sees. */
    const recipient = toHex(call.args[6] as Uint8Array);
    /*
     * And the mapping is on the CONTEXT, which is what midnight-js reads. The
     * circuit's own arguments end at eleven; a thirteenth argument is the V-82
     * defect and `dispatch` now refuses it.
     */
    expect(call.args).toHaveLength(12);
    const mappings = [...(call.ctx as any).getAdditionalMappings().entries()];

    expect(recipient).toBe(PAYEE.coinPublicKey);
    expect(mappings).toHaveLength(1);
    expect(mappings[0][0]).toBe(recipient);
    expect(mappings[0][1]).toBe(PAYEE.encryptionPublicKey);

    /*
     * And the reading key is NOT the spending key. If the fixture ever made
     * them equal, everything above would pass while proving nothing.
     */
    expect(PAYEE.encryptionPublicKey).not.toBe(PAYEE.coinPublicKey);
  });

  it('REFUSES A CALL WITH THE WRONG NUMBER OF ARGUMENTS, before anything is built', async () => {
    /*
     * The guard `ledger.ts` has had since M-38 and this client did not — which
     * is exactly how an options object became a thirteenth argument to a circuit
     * that declares twelve. It reads the VAULT's own compiled ABI, so it moves
     * when the contract does.
     */
    const { ledger, calls } = harness();
    await expect((ledger as any).call(VAULT, 'payout', [1, 2, 3]))
      .rejects.toThrow(/circuit "payout" takes 12 argument\(s\), got 3/);
    expect(calls).toHaveLength(0);

    await expect((ledger as any).call(VAULT, 'payout', new Array(13).fill(0)))
      .rejects.toThrow(/takes 12 argument\(s\), got 13/);
  });

  it('REFUSES A PAYEE WHOSE ADDRESS IS FOR ANOTHER NETWORK, which nothing downstream would', async () => {
    /*
     * A coin public key is network-independent bytes. Hand this vault an address
     * built for another chain and the payment settles to a key belonging to
     * somebody on a network this deployment has never heard of — correctly, as
     * far as every layer below can tell.
     */
    const { ledger, calls } = harness();
    const elsewhere = { ...payment(100n), payee: payeeFor(new Uint8Array(32).fill(0x44), 'stagenet') };
    await expect(ledger.payout(VAULT, elsewhere, BY, EVENTS))
      .rejects.toThrow(/for stagenet and this vault is on preview/);
    expect(calls).toHaveLength(0);
  });

  it('has nowhere to put a reading key that belongs to somebody else', async () => {
    /*
     * The type-level claim, tested rather than asserted in a comment: a payment
     * carries a payee, not a pair of keys, so there is no field a caller could
     * fill with one person's coin key and another's reading key. Both halves
     * come out of decoding one address, and a different reading key is a
     * DIFFERENT ADDRESS — a different payee, not the same payee misread.
     */
    const other = payeeFor(new Uint8Array(32).fill(0x44).map((b, i) => (i === 31 ? b ^ 1 : b)), 'preview');
    expect(other.bech32).not.toBe(PAYEE.bech32);
    expect(other.encryptionPublicKey).not.toBe(PAYEE.encryptionPublicKey);
    expect(Object.keys(payment(1n))).not.toContain('payslipKey');
    expect(Object.keys(payment(1n))).not.toContain('recipient');
  });

  it('REFUSES BEFORE A FEE when no single note covers the payment', async () => {
    const { ledger, calls } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 60n }, { nonce: '02'.repeat(32), value: 60n }],
    });
    await expect(ledger.payout(VAULT, payment(100n), BY, EVENTS))
      .rejects.toThrow(/no single note covers 100/i);
    expect(calls).toEqual([]);
  });

  it('DOES NOT TOUCH THE POOL when the call fails', async () => {
    /*
     * A pool advanced for a payment that never landed is a vault that will
     * refuse its own next payment, with the money still there and unreachable
     * until somebody replays it from the chain.
     */
    const { ledger, saves, current } = harness({ throws: 'node said no' });
    await expect(ledger.payout(VAULT, payment(100n), BY, EVENTS)).rejects.toThrow(/node said no/);
    expect(saves).toEqual([]);
    expect(balanceOf(current(), GBP)).toBe(1_000n);
  });

  it('STOPS rather than guessing if the vault paid without asking for a note', async () => {
    /*
     * Impossible against the real contract, which is why it matters: if it
     * happens, this client's model of the vault is wrong in a way that would
     * corrupt the pool on the next call. Advancing by a guess is how a vault
     * quietly loses track of its own money.
     */
    const { ledger, saves } = harness({ asksForANote: false });
    await expect(ledger.payout(VAULT, payment(100n), BY, EVENTS))
      .rejects.toThrow(/paid without asking for a note|rebuild it from the chain/i);
    expect(saves).toEqual([]);
  });

  it('loads the pool fresh on every call, never a copy taken at construction', async () => {
    /*
     * The "can make exactly one payment" defect wearing a closure. It has
     * already appeared once in this repo, in the first vault test helper.
     */
    const { ledger, current } = harness();
    await ledger.payout(VAULT, payment(100n), BY, EVENTS);
    await ledger.payout(VAULT, payment(200n), BY, EVENTS);
    expect(balanceOf(current(), GBP)).toBe(700n);
    expect(current().notes).toHaveLength(1);
  });

  it('never mentions the account: the vault pins it on chain, not this client', async () => {
    const { ledger } = harness();
    expect(ledger.describe()).toMatch(/pinned by the vault on chain/i);
  });
});

/**
 * **A BALANCE NOTHING HAS RECONCILED IS NOT A BALANCE.**
 *
 * `balance` summed the local pool and returned it. It never asked the chain,
 * `matchesChain` had no production caller, and so every decision taken from a
 * vault balance — including whether a payroll run can be afforded — rested on
 * our bookkeeping agreeing with reality by luck.
 *
 * **THREE OUTCOMES, PINNED AS THREE.** Two would be the defect in a different
 * shape: `C110` measured a transaction the node had finalised reading as `not
 * found` to the indexer 168ms later, so *"we could not check"* and *"the chain
 * says no"* are different answers with opposite consequences, and a test that
 * accepted either refusal for either cause would not notice them merging.
 */
describe('C198: balance reconciles against the chain, or refuses to answer', () => {
  it('AGREES: returns the sum when every note the pool holds is on chain, and only those',
    async () => {
      const { ledger } = harness({
        notes: [{ nonce: '01'.repeat(32), value: 600n }, { nonce: '02'.repeat(32), value: 400n }],
      });
      expect(await ledger.balance(VAULT, GBP)).toBe(1_000n);
    });

  it('DISAGREES, pool claims MORE: names the amount the chain will not honour', async () => {
    /*
     * The direction that costs money at payment time: the vault would offer a
     * note the commitment set does not contain, and the payment is refused —
     * mid-run, after earlier payees have been paid.
     */
    const { ledger } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 600n }, { nonce: '02'.repeat(32), value: 400n }],
      chain: [{ nonce: '01'.repeat(32), value: 600n }],
    });
    const failed = await ledger.balance(VAULT, GBP).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultPoolDisagreesWithChain);
    // By how much, and in which direction — both, in words a person can act on.
    expect(failed?.message).toMatch(/claims MORE than the chain will honour/);
    expect(failed?.message).toContain('worth 400 between them');
    expect(failed?.message).toContain('02'.repeat(32));
    // And NOT the other refusal: naming the wrong fault is the defect.
    expect(failed).not.toBeInstanceOf(VaultChainUnreadable);
  });

  it('DISAGREES, pool claims LESS: says a note reached the vault unrecorded', async () => {
    /*
     * `C199`'s window seen from the other side — the chain holding a note the
     * pool never learned about. The amount cannot be stated and this says so
     * rather than inventing one: a commitment discloses nothing, which is the
     * entire point of it.
     */
    const { ledger } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 600n }],
      chain: [{ nonce: '01'.repeat(32), value: 600n }, { nonce: '02'.repeat(32), value: 400n }],
    });
    const failed = await ledger.balance(VAULT, GBP).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultPoolDisagreesWithChain);
    expect(failed?.message).toMatch(/claims LESS than the vault holds/);
    expect(failed?.message).toMatch(/chain holds 2 note\(s\) and this pool holds 1/);
    expect(failed?.message).toMatch(/amount cannot be stated/);
    // And it names the recovery, because that is what the operator does next.
    expect(failed?.message).toMatch(/replayVault/);
  });

  it('COULD NOT READ: refuses when the indexer returns no state, and never a local number',
    async () => {
      /*
       * A vault that reads as absent because we asked too early is not a
       * vault that disagrees, and it is certainly not a vault holding nothing.
       */
      const { ledger } = harness({ notes: [{ nonce: '01'.repeat(32), value: 600n }],
        chain: 'unreadable' });
      const failed = await ledger.balance(VAULT, GBP).then(() => null, (e: Error) => e);
      expect(failed).toBeInstanceOf(VaultChainUnreadable);
      expect(failed).not.toBeInstanceOf(VaultPoolDisagreesWithChain);
      expect(failed?.message).toMatch(/could not be read/);
      // The number it would have returned appears NOWHERE, with or without a caveat.
      expect(failed?.message).not.toContain('600');
    });

  it('COULD NOT READ: refuses when the read itself fails, naming the cause', async () => {
    const { ledger } = harness({ chain: 'read-throws' });
    const failed = await ledger.balance(VAULT, GBP).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultChainUnreadable);
    expect(failed?.message).toContain('indexer said no');
  });

  it('COULD NOT READ: a state with no notes set is ignorance, not an empty vault', async () => {
    /*
     * `C188`'s distinction, one contract along: an empty set is a true statement
     * about the vault and a missing one is ours. Answering "empty" here would
     * report every note in the pool as a disagreement — or, one coercion away,
     * a balance of zero.
     */
    const { ledger } = harness({ chain: 'no-notes-field' });
    const failed = await ledger.balance(VAULT, GBP).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultChainUnreadable);
    expect(failed?.message).toMatch(/not an empty vault/);
  });

  it('reconciles the WHOLE pool, not just the token asked about', async () => {
    /*
     * A euro note the chain does not hold means the pool and the chain
     * disagree. A pound balance read out of a pool that is wrong about euros is
     * a number nobody should act on, and reconciling only the asked-for token
     * is how it would be answered anyway.
     */
    const EUR = 'bb'.repeat(32);
    const { ledger, current } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 600n }],
      chain: [{ nonce: '01'.repeat(32), value: 600n }],
    });
    // A euro note the pool believes in and the chain has never held.
    current().notes.push({ nonce: '09'.repeat(32), token: EUR as never, value: 5n, index: 0n });
    const failed = await ledger.balance(VAULT, GBP).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultPoolDisagreesWithChain);
    // The pound sum it would have returned is not in the message either.
    expect(failed?.message).toMatch(/claims MORE than the chain will honour/);
  });
});

/**
 * **THE POOL IS WRITTEN AFTER THE TRANSACTION, AND THE RECOVERY THAT
 * MAKES THAT SAFE IS LOAD-BEARING.**
 *
 * The ordering is correct — of the two ways to fail, it picks the recoverable
 * one — but its justification lived nowhere, which is how a cleanup round finds
 * `replayVault` apparently unused and deletes it. The comments at both write
 * sites now say so.
 *
 * **A comment nothing checks is a comment that gets tidied away**, so this is
 * the grep-style test that fails if either site loses the name. It is the same
 * shape as the `signerScope` test in `contracts/test/vault-scoping.test.ts`:
 * read the source, assert about the text, fail by name.
 */
describe('both pool-write sites name the recovery they depend on', () => {
  const source = readFileSync(new URL('./vault-ledger.ts', import.meta.url), 'utf8');

  it('names replayVault at the deposit site and at the payout site', () => {
    /*
     * Two mentions minimum, one per site. Counted rather than merely found,
     * because a single mention would pass while the other site went bare —
     * which is the "guard on some of N" shape `C188` is about.
     */
    const mentions = source.match(/replayVault/g) ?? [];
    expect(mentions.length).toBeGreaterThanOrEqual(2);

    /*
     * AND EACH SAVE IS PRECEDED BY A COMMENT THAT SAYS THE WHOLE THING, WITHIN
     * THE SAME BLOCK — NOT BY A COMMENT THAT CITES A ROW.
     *
     * **THIS USED TO REQUIRE THE STRING `C199` BESIDE `replayVault`, AND THAT
     * HALF PINNED THE WRONG THING.** A register id is a pointer into a document
     * that does not ship: a stranger who clones this repository, reads the
     * comment and wants to check the claim has nowhere to go, and the suite was
     * defending their inability to check it. It is the same correction the
     * assertion below already made for `C200`, and for the same reason.
     *
     * **WHAT REPLACES IT IS THE CLAIM ITSELF, IN FOUR PARTS, EVERY ONE OF WHICH
     * RESOLVES INSIDE THIS REPOSITORY.** The comment at each site must name the
     * recovery, say where it lives, say what the window is, and say what closes
     * it. A comment that keeps the word `replayVault` and loses any of the other
     * three has lost the reason — which is precisely how the ordering here
     * silently becomes the unrecoverable one.
     *
     * **EACH ASSERTION NAMES THE CHANGE THAT TURNS IT RED, and all four were
     * watched doing it** against a copy of the source outside this tree.
     */
    /*
     * **THE SITES ARE FOUND BY `advancePool` NOW, AND THE OLD SPELLING IS PINNED
     * AS WELL.** both writes go through one method that re-reads the
     * pool, re-applies the change and files the next version, so the two places
     * that DECIDE a write are its two call sites.
     *
     * The second assertion is the one worth having: **exactly one `pool.save` in
     * the whole file, and it is inside `advancePool`.** A later change adding a
     * bare `this.pool.save(...)` beside a call would get no retry, no re-read and
     * none of this comment -- and without this line the suite would not notice,
     * because the four checks below would still find their two good sites.
     */
    const saves = [...source.matchAll(/this\s*\.\s*advancePool\s*\(/g)].map(m => m.index!);
    /*
     * **WHITESPACE-INSENSITIVE, AND `await` IS NOT REQUIRED.** A second reading pointed
     * out that a third site written `return this.advancePool(…)` or
     * `void this.advancePool(…)` kept the count at 2 and carried no comment, and
     * that `this.pool\n.save(` slipped past the second check.
     */
    const sites = [...source.matchAll(/this\s*\.\s*advancePool\s*\(/g)];
    expect(sites, 'RED WHEN: a pool-write site is added or removed without carrying the four-part claim below, however it is spelled').toHaveLength(2);
    expect(
      [...source.matchAll(/this\s*\.\s*pool\s*\.\s*save\s*\(/g)],
      'RED WHEN: a write goes straight to the pool instead of through advancePool, which skips the re-read, the re-apply and the retry -- the three things that stop a payment losing its change note',
    ).toHaveLength(1);
    for (const at of saves) {
      /*
       * Flattened, for the reason the assertion below gives about itself: a
       * comment is line-wrapped, and a check that broke when a sentence
       * rewrapped would be noise rather than a guard.
       */
      const before = source.slice(Math.max(0, at - 2_500), at)
        .replace(/^\s*\*/gm, ' ').replace(/\s+/g, ' ');

      expect(before, 'RED WHEN: the name of the recovery is deleted from this comment, which is what lets a cleanup round grep for callers, find none, and delete it')
        .toMatch(/replayVault/);

      expect(before, 'RED WHEN: the comment stops saying WHERE the recovery lives, so a reader who wants to check the claim has to go looking for it')
        .toMatch(/src\/midnight\/vault-recovery\.ts/);

      expect(before, 'RED WHEN: the comment stops saying that the failure window is a crash BETWEEN the chain call and this write — which is the ordering, and without it the next reader cannot tell why the pool is not written first')
        .toMatch(/crash[^.]{0,160}between/i);

      expect(before, 'RED WHEN: the comment stops saying that the recovery REBUILDS the pool — the dependency rather than the mention, and the half that says this ordering is safe only because something else exists')
        .toMatch(/rebuild/i);
    }
  });

  it('says what breaks without it, rather than only naming it', () => {
    /*
     * The point of the comment is the DEPENDENCY, not the word. A future reader
     * has to learn that deleting the recovery changes this ordering from
     * recoverable to not — which is the whole reason the row exists.
     *
     * Matched against whitespace-flattened source, because a comment is
     * line-wrapped and a test that broke when a sentence rewrapped would be
     * noise rather than a check.
     */
    const flat = source.replace(/^\s*\*/gm, ' ').replace(/\s+/g, ' ');
    expect(flat).toMatch(/not a safety net beside this design\. it is part of it/i);
    expect(flat).toMatch(/nothing about this ordering is safe on its own/i);

    /*
     * **AND THE RECOVERY IS NAMED AS RUN, NOT MERELY AS EXISTING.**
     *
     * This assertion used to require the string `C200` — the row saying the
     * recovery was written for the vault's PREVIOUS shape — so that nobody read
     * the dependency as discharged while it was not. That row is closed, and
     * leaving the check as it was would have made a stale citation the thing
     * the suite defends.
     *
     * What replaces it is the stronger claim, and the one `CLAUDE.md` actually
     * cares about: **a recovery path nobody has run does not exist**, so both
     * sites must name the test that runs it. A round that rewrites the recovery
     * again and does not re-run it against a real vault fails here.
     */
    expect(flat).toMatch(/C200/);
    expect(flat).toMatch(/contracts\/test\/vault-recovery\.test\.ts/);
    expect(flat).toMatch(/RUN, not\s*\*?\s*asserted/i);
  });
});

/**
 * **A VAULT DEPLOYED TODAY CANNOT BE FUNDED, AND THIS IS WHERE THAT
 * ENDS.**
 *
 * `SealedNotePool.load` refuses when no record exists and `deposit` loads
 * before it calls, so the client could not take the first deposit. The deploy
 * cannot create one — a pool is wrapped per signer and a deploy holds no signer
 * key material (`V-91`) — so it is created here, by whatever supplied the
 * `NotePool`, which is the thing that does hold them.
 *
 * **AND THE HALF THAT IS NOT ABOUT CREATION AT ALL.** `S6d` established that
 * answering *empty* where the truth is *unreadable* makes `balance` report zero
 * and leaves every note on chain unexplained. An instrument that can write an
 * empty pool is exactly how that state gets MANUFACTURED — for a vault whose
 * record was lost, `create` sees nothing and succeeds. So the chain is asked
 * first, and these are the three answers.
 */
describe('C242: an empty pool is created only for a vault the CHAIN says is empty', () => {
  it('creates one when the vault exists and its on-chain note set is empty', async () => {
    const { ledger, creates, current } = harness({ notes: [], chain: [], poolExists: false });
    await ledger.openPool(VAULT);
    expect(creates).toEqual([{ notes: [] }]);
    expect(current()).toEqual({ notes: [] });
  });

  it('REFUSES for a vault the chain says holds notes, and names the recovery', async () => {
    /*
     * **THE CASE THIS GUARD EXISTS FOR, AND IT IS NOT A NEW VAULT.** A vault
     * whose pool record has been lost looks identical to one that never had a
     * pool, and `create` alone would write a truthful-looking empty pool over a
     * treasury that is not empty. `balance` would then report zero and every
     * commitment on chain would read as unexplained — which is a rebuild
     * (`replayVault`), not an initialisation.
     */
    const { ledger, creates } = harness({
      notes: [], poolExists: false, chain: [{ nonce: '01'.repeat(32), value: 900n }],
    });
    const failed = await ledger.openPool(VAULT).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultAlreadyHoldsNotes);
    expect(failed?.message).toMatch(/on-chain set holds 1 note/);
    expect(failed?.message).toMatch(/replayVault/);
    expect(failed?.message).toMatch(/is NOT a new vault|not a new vault/i);
    expect(creates).toEqual([]);
  });

  it('REFUSES when the chain could not be read, and writes nothing', async () => {
    /*
     * A state the node had finalised read as absent to the indexer
     * 168ms later. A vault that reads as empty because we asked too early is
     * the vault this refusal exists for, and the cost of getting it wrong here
     * is the whole treasury reported as zero.
     */
    for (const chain of ['unreadable', 'read-throws', 'no-notes-field'] as const) {
      const { ledger, creates } = harness({ notes: [], poolExists: false, chain });
      const failed = await ledger.openPool(VAULT).then(() => null, (e: Error) => e);
      expect(failed).toBeInstanceOf(VaultChainUnreadable);
      expect(failed).not.toBeInstanceOf(VaultAlreadyHoldsNotes);
      expect(creates).toEqual([]);
    }
  });

  it('leaves the store\'s own refusal to overwrite in place, rather than repeating it', async () => {
    /*
     * Two implementations of "do not replace the record of every note
     * a vault holds" is two chances to soften one of them. The store refuses,
     * this reports it.
     */
    const { ledger, creates } = harness({ notes: [], chain: [], poolExists: true });
    await expect(ledger.openPool(VAULT)).rejects.toThrow(/already has a note pool/);
    expect(creates).toEqual([]);
  });
});

/**
 * **THE CHANGE NOTE IS READ FROM THE CALL, NOT DERIVED BESIDE IT.**
 *
 * The client holds the payout's own result, and the change coin is an OUTPUT of
 * that transaction — `V-47`'s rule, in the file `V-47` was written in. What
 * these pin is that the pool is advanced by the READING, and that a reading
 * which cannot be had is a refusal rather than a payment recorded as keeping
 * nothing.
 */
describe('a private payment spends against the index the chain reports at that moment', () => {
  it('hands the contract the index read from the creating transaction, never a position or a count', async () => {
    const { ledger, spentCoins, eventReads } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 60n }, { nonce: '02'.repeat(32), value: 1_000n }],
    });
    await ledger.payout(VAULT, payment(200n), BY, EVENTS);

    /* The note of 1,000 is the second seeded note, filed by the chain at 43. */
    expect(eventReads).toEqual([{ hash: SEEDED_TX }]);
    expect(spentCoins).toHaveLength(1);
    expect(spentCoins[0].value).toBe(1_000n);
    expect(spentCoins[0].mt_index).toBe(seededIndex(1));
  });

  it('never writes that index into the pool: the next spend reads it again', async () => {
    const { ledger, saves } = harness();
    await ledger.payout(VAULT, payment(100n), BY, EVENTS);
    for (const saved of saves) {
      for (const n of saved.notes) expect(n).not.toHaveProperty('index');
    }
  });

  it('spends the change of the last payment by reading ITS transaction', async () => {
    const { ledger, spentCoins, eventReads } = harness();
    await ledger.payout(VAULT, payment(100n), BY, EVENTS);
    await ledger.payout(VAULT, payment(200n), BY, EVENTS);
    expect(eventReads).toEqual([{ hash: SEEDED_TX }, { hash: payHash(1) }]);
    expect(spentCoins[1].value).toBe(900n);
    expect(spentCoins[1].mt_index).toBe(91n);
  });

  it('REFUSES before a fee when the chain cannot be read, and moves nothing', async () => {
    const { ledger, calls, saves } = harness({ events: 'unreadable' });
    await expect(ledger.payout(VAULT, payment(100n), BY, EVENTS)).rejects.toThrow(NoteIndexUnreadable);
    expect(calls).toEqual([]);
    expect(saves).toEqual([]);
  });

  it('spends at the index the chain gives now, whatever index the pool held', async () => {
    const { ledger, spentCoins, current } = harness({ events: 'moved' });
    current().notes[0] = { ...current().notes[0], index: seededIndex(0) };
    await ledger.payout(VAULT, payment(100n), BY, EVENTS);
    expect(spentCoins[0].mt_index).toBe(seededIndex(0) + 1n);
  });

  it('REFUSES when the chosen note\'s coin changes under the same nonce while its index is read', async () => {
    const { ledger, calls, saves, spentCoins, current } = harness({ notes: [{ nonce: '01'.repeat(32), value: 1_000n }] });
    const reading = eventsInUse;
    eventsInUse = {
      eventsOf: async (tx) => {
        const answer = await reading.eventsOf(tx);
        current().notes[0] = { ...current().notes[0], value: 1_200n };
        return answer;
      },
    };
    await expect(ledger.payout(VAULT, payment(200n), BY, EVENTS)).rejects.toThrow(/changed or left the pool/);
    expect(calls).toEqual([]);
    expect(spentCoins).toEqual([]);
    expect(saves).toEqual([]);
  });

  it('REFUSES before a fee a note that does not record which transaction created it, and names the way out', async () => {
    const { ledger, calls, saves } = harness({ noCreatingTransaction: true });
    await expect(ledger.payout(VAULT, payment(100n), BY, EVENTS)).rejects.toThrow(/recordCreatingTransaction/);
    expect(calls).toEqual([]);
    expect(saves).toEqual([]);
  });

  it('never hands the contract an index the pool stored for a note other than the one just read', async () => {
    /*
     * The pool changes while the chosen note's index is being read: a smaller
     * note that also covers the payment arrives, carrying a stored index. The
     * witness picks it. It must be refused, not spent at the stored number.
     */
    const { ledger, saves, spentCoins, current } = harness({ notes: [{ nonce: '01'.repeat(32), value: 1_000n }] });
    const reading = eventsInUse;
    eventsInUse = {
      eventsOf: async (tx) => {
        current().notes.push({ nonce: '02'.repeat(32), token: GBP, value: 300n, index: 7n, createdIn: SEEDED_TX });
        return reading.eventsOf(tx);
      },
    };
    await expect(ledger.payout(VAULT, payment(200n), BY, EVENTS)).rejects.toThrow(/has not been read for this call/);
    expect(spentCoins).toEqual([]);
    expect(saves).toEqual([]);
  });

  it('saves no index for any note, including one the pool held before the payment', async () => {
    const { ledger, saves, current } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 60n }, { nonce: '02'.repeat(32), value: 1_000n }],
    });
    current().notes[0] = { ...current().notes[0], index: 5n };
    await ledger.payout(VAULT, payment(200n), BY, EVENTS);
    expect(saves).toHaveLength(1);
    for (const n of saves[0].notes) expect(n).not.toHaveProperty('index');
  });

  it('a public payment reads no events at all', async () => {
    const { ledger, eventReads } = harness({ poolThrows: true });
    await ledger.payout(VAULT, { ...payment(200n), payee: PUBLIC_PAYEE, token: NIGHT }, BY, EVENTS);
    expect(eventReads).toEqual([]);
  });
});

describe('a write to the pool is applied to what the pool holds NOW', () => {
  /*
   * **THIS BLOCK USED TO ASSERT THE OPPOSITE, AND THAT IS THE POINT OF IT.**
   *
   * A private payment loads the pool, proves for a minute or more, submits, and
   * then writes the change note. A deposit does the same with its new note. The
   * write must not erase whatever another process recorded in that minute -- and
   * before this change the way it did not erase it was to REFUSE, which these two
   * tests pinned by name.
   *
   * **A REFUSAL AFTER THE MONEY HAS MOVED IS A REPORT OF LOSS, NOT A PREVENTION
   * OF IT.** The chain holds the change note, the pool is the only thing that
   * can say what that note IS -- a commitment discloses nothing and cannot be
   * inverted -- so a refused write leaves money in the vault that this machine
   * cannot name and no payment can reach.
   *
   * So the write is now a DIFFERENCE applied to the pool as it stands: the other
   * writer's note survives AND this one is recorded. Both halves are asserted,
   * because keeping one without the other is a way to pass this block while
   * losing either the other process's money or this one's.
   */
  const OTHER = { nonce: '0f'.repeat(32), value: 42n };
  const DEPOSITED = '77'.repeat(32);

  it('RECORDS the change of a payment when another process wrote the pool while it proved, and keeps what that process wrote', async () => {
    const { ledger, current, saves } = harness({ anotherWriterAddsDuringTheCall: OTHER });
    await ledger.payout(VAULT, payment(200n), BY, EVENTS);

    /*
     * RED WHEN: `advancePool` stops retrying, or stops re-reading the pool
     * before it re-applies -- either of which puts this back to a refusal after
     * the money has moved, which is the whole defect.
     */
    expect(saves, 'RED WHEN: the payment gives up instead of applying its change to the pool as it stands, which leaves the chain holding a change note the pool cannot name').toHaveLength(1);

    const after = current().notes.map((n) => n.nonce);
    /*
     * RED WHEN: the re-applied write is built from the copy the call was made
     * from rather than from a fresh load -- which erases the other writer
     * silently, the failure the version check was added for.
     */
    expect(after, 'RED WHEN: the other process\'s note is erased by this write, which is the silent overwrite the version check exists to prevent').toContain(OTHER.nonce);
    /*
     * RED WHEN: the change note is dropped. `payment(200n)` spends a 1,000 note,
     * so the change is the vault's own 800 coming back, and the fake's outputs
     * carry it under its own nonce.
     */
    expect(after, 'RED WHEN: the payment\'s change note is not recorded, so the vault holds 800 on chain that nothing can spend').toContain('ab'.repeat(32));
    /*
     * RED WHEN: the spent note is left in the pool. It is nullified on chain, so
     * a pool still offering it makes every later payment die inside the circuit
     * after two fees.
     */
    expect(after, 'RED WHEN: the note that was spent stays in the pool, which offers the next payment a note the chain no longer holds').not.toContain('01'.repeat(32));
  });

  it('RECORDS the note of a deposit when another process wrote the pool while it proved, and keeps what that process wrote', async () => {
    const { ledger, current, saves } = harness({ notes: [], anotherWriterAddsDuringTheCall: OTHER });
    await ledger.deposit(VAULT, { nonce: DEPOSITED, token: GBP, value: 500n }, BY);

    expect(saves, 'RED WHEN: the deposit gives up instead of adding its note to the pool as it stands, which leaves money on chain the pool has never heard of').toHaveLength(1);
    const after = current().notes.map((n) => n.nonce);
    expect(after, 'RED WHEN: the other process\'s note is erased by the deposit\'s write').toContain(OTHER.nonce);
    expect(after, 'RED WHEN: the deposit\'s own note is not recorded, which is the money it just moved').toContain(DEPOSITED);
  });

  /**
   * **THE RACE NO RE-READ CAN REMOVE, AND THE ONLY THING THAT EXERCISES THE
   * RETRY.**
   *
   * Re-reading the pool after the money has moved closes the window that is
   * MINUTES wide -- the proof. What is left is the microseconds between that read
   * and the filing of the next version, and two processes were watched walking
   * through it together: both passed the version check, both filed, and one
   * note was lost with nothing refused.
   *
   * **WITHOUT THESE TESTS THE WHOLE RETRY COULD BE DELETED WITH EVERY OTHER TEST
   * GREEN**, which is how it was found: two mutations -- one attempt only, and
   * re-throwing instead of retrying -- left all 88 assertions passing.
   */
  it('FILES THE CHANGE ANYWAY when another writer wins the race, by applying it again to what the pool then holds', async () => {
    const { ledger, current, saves } = harness({ poolRaceLostTimes: 2 });
    /*
     * **THE PREMISE IS STATED AS AN ASSERTION AND NOT AS A BARE `await`.** A bare
     * await makes a failure an unhandled rejection, which a mutation harness cannot
     * tell from the code blowing up on an unrelated path -- so the mutation that
     * deletes the retry was reported as "broke the code" rather than as caught. An
     * second reading made the general point; this is the specific fix.
     */
    await expect(
      ledger.payout(VAULT, payment(200n), BY, EVENTS),
      'RED WHEN: the payment does not survive a lost race at all, which is the whole of it: the money has moved and the pool does not record it',
    ).resolves.toMatchObject({ kind: 'shielded' });
    expect(
      saves,
      'RED WHEN: the write stops being re-derived after a lost race, which leaves the chain holding a change note the pool cannot name -- a refusal after the money has moved is a report of loss, not a prevention of it',
    ).toHaveLength(1);
    expect(current().notes.map((n) => n.nonce), 'RED WHEN: the change note is not recorded')
      .toContain('ab'.repeat(32));
  });

  it('and it STOPS after a fixed number of attempts, saying the money has moved and the pool does not record it', async () => {
    const { ledger, saves } = harness({ poolRaceLostTimes: 99 });
    /*
     * RED WHEN: the retry becomes unbounded. A write that cannot land must end in
     * a sentence somebody can act on, not in a loop -- the one state left where
     * the money is on chain and no record names it, and the operator has to know
     * they are in it.
     */
    await expect(ledger.payout(VAULT, payment(200n), BY, EVENTS))
      .rejects.toThrow(/the money has already moved on chain/);
    expect(saves, 'RED WHEN: a write reports failure and lands anyway').toHaveLength(0);
  });

  it('names the recovery, and names nothing a public reader cannot open', async () => {
    const { ledger } = harness({ poolRaceLostTimes: 99 });
    const why = await ledger.payout(VAULT, payment(200n), BY, EVENTS).catch((e: Error) => e.message);
    /*
     * **`reconcileVaultPool` AND NOT AN ALTERNATION.** A second reading pointed out that
     * `/reconcileVaultPool|replayVault/` would accept `replayVault`, which needs a
     * history of the vault's events that nothing in this repository produces -- so
     * the refusal would name a remedy nobody can carry out, which is the defect
     * this whole round started from.
     */
    expect(why, 'RED WHEN: the refusal names replayVault, or nothing -- replayVault needs a history no tool here produces, so naming it is naming something a person cannot do')
      .toMatch(/reconcileVaultPool/);
    /*
     * RED WHEN: a `.command` name is put back into this message. None of them
     * ship, so a public reader meets an instruction naming a file that is not in
     * the repository -- the failure the citation rule was written for.
     */
    expect(why, 'RED WHEN: shipping code names an instrument that is not in the shipping set')
      .not.toMatch(/\.command/);
  });

  /**
   * **THE PAYMENT'S HALF OF WHAT MAKES RE-APPLYING SAFE, PINNED AT THE RETRY SITE.**
   *
   * The whole retry rests on the change functions refusing when the pool they are
   * handed cannot be the one the change belongs to. That is asserted twice for a
   * deposit and, until it was read again, **nowhere for a payment** --
   * the only pin was a unit test of `afterPayment` itself, which says nothing
   * about whether the retry swallows it.
   *
   * The state: the pool no longer holds the note this payment spent. Two payments
   * cannot spend one note -- the contract nullifies the commitment -- so a pool
   * without it is not the pool this payment belongs to, and guessing would drop a
   * note the chain still holds and add a change note against nothing.
   */
  it('REFUSES rather than retrying when the pool no longer holds the note the payment spent', async () => {
    const { ledger, current, saves } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 1_000n }],
      /*
       * The pool becomes one that does not hold the note this payment spent, while
       * the call is being proved -- so the money moves and only then does the write
       * meet a pool its change cannot be applied to.
       */
      poolBecomesDuringTheCall: [{ nonce: '0f'.repeat(32), value: 42n }],
    });
    const why = await ledger.payout(VAULT, payment(200n), BY, EVENTS)
      .then(() => 'IT DID NOT REFUSE', (e: Error) => e.message);

    /*
     * **THE MESSAGE, NOT MERELY A THROW.** A bare `.rejects.toThrow()` here was
     * satisfied by the exhaustion error -- so deleting `if (!isALostPoolRace(cause))
     * throw cause;` left this green, which is the one mutation it exists to catch.
     * A second reading proved it.
     */
    expect(
      why,
      'RED WHEN: the retry treats "this is not the pool my change belongs to" as contention, attempts it five times, and reports it as contention -- which is a guess about which notes exist',
    ).toMatch(/no note .* to spend|does not hold/i);
    expect(
      why,
      'RED WHEN: the refusal arrives as the retry giving up, which tells the operator another writer is busy when what actually happened is that this is not the pool this payment belongs to',
    ).not.toMatch(/all 5 attempts|another writer filed the next version first/);
    expect(saves, 'RED WHEN: a change note is written against a pool that does not hold the note it came from').toHaveLength(0);
    expect(
      current().notes.map((n) => n.nonce),
      'RED WHEN: the other writer\'s note is erased by a payment that could not be applied',
    ).toEqual(['0f'.repeat(32)]);
  });

  /**
   * **THE DEPOSIT'S CHAIN READ IS OUTSIDE THE WINDOW, AND THIS IS THE
   * ASSERTION THAT SAYS SO.**
   *
   * A deposit whose call reports only the 33-byte identifier has to ask the chain
   * for the transaction hash, because that is what a spend names the creating
   * transaction by. That read used to sit BETWEEN the load the write was built on
   * and the write itself, which made the window a network round trip wide rather
   * than an instant -- and in that branch a refusal lost the note from the pool
   * entirely.
   *
   * **SO THE OTHER WRITER LANDS INSIDE THE CHAIN READ**, which is the one place
   * `anotherWriterAddsDuringTheCall` cannot reach: it fires in the circuit, and
   * the chain read happens after the circuit returns. Same hook the
   * index-read test above uses, for the same reason -- the window has to be
   * entered from inside to be measured.
   */
  it('records the deposit\'s note when another writer lands inside the CHAIN READ, and keeps what that writer wrote', async () => {
    const { ledger, current, saves, eventReads } = harness({
      notes: [], depositResult: 'no-hash',
      anotherWriterAddsDuringTheChainRead: OTHER,
    });

    await ledger.deposit(VAULT, { nonce: DEPOSITED, token: GBP, value: 500n }, BY, eventsInUse);

    expect(eventReads, 'RED WHEN: the chain is not asked at all, so this test is not in the branch it is about').not.toEqual([]);
    /*
     * RED WHEN: the pool is read before the chain read rather than after -- then
     * this write is built on a copy that predates the other writer, the version
     * check refuses it, and the deposit's own note is lost from the pool while its
     * money sits on chain. That is the defect exactly, and it is the branch the earlier change
     * measured as the one where a refusal loses the note entirely.
     */
    /*
     * **ONE SAVE, ON THE FIRST ATTEMPT.** The first version of this said the write
     * would be *refused* if the chain read went back inside the window -- and an
     * second reading pointed out the retry absorbs exactly that, so the message named a
     * failure that can no longer happen and would have sent the next reader
     * somewhere wrong. What the ordering actually buys is that the write lands
     * without contending at all.
     */
    expect(saves, 'RED WHEN: the deposit writes more than once, or not at all -- either means its chain read is back inside the window between the load and the write, where it has to contend with whoever wrote during it').toHaveLength(1);
    const after = current().notes.map((n) => n.nonce);
    expect(after, 'RED WHEN: the writer that landed during the chain read is erased').toContain(OTHER.nonce);
    expect(after, 'RED WHEN: the deposit\'s own note is lost, which is money on chain that nothing names').toContain(DEPOSITED);
  });

  /**
   * **THE HALF THAT MUST STILL REFUSE, AND IT IS WHY RE-APPLYING IS SAFE AT ALL.**
   *
   * `advancePool` retries by calling the change again against a fresh pool. That
   * is only safe because the change REFUSES when the pool it is handed cannot be
   * the one the change belongs to -- so a retry cannot write the same note twice
   * and cannot invent one. A deposit of a nonce the pool already holds is that
   * case, and the refusal is thrown out of the retry rather than swallowed by it.
   */
  it('still REFUSES a deposit of a note the pool already holds, and the retry does not swallow it', async () => {
    /*
     * **THE DUPLICATE ARRIVES DURING THE CALL, WHICH IS THE ONLY WAY TO REACH THE
     * RETRY WITH IT.** The first version of this test started from a pool that
     * already held the nonce -- so the deposit's own pre-flight refused it before
     * any call was made, `advancePool` was never entered, and the title's claim
     * about the retry was unexercised. A second reading found that.
     */
    const { ledger, saves } = harness({
      notes: [],
      anotherWriterAddsDuringTheCall: { nonce: DEPOSITED, value: 1n },
    });
    await expect(
      ledger.deposit(VAULT, { nonce: DEPOSITED, token: GBP, value: 500n }, BY),
      'RED WHEN: the retry catches everything rather than only a lost race, so a change that cannot be true is attempted five times and then reported as contention',
    ).rejects.toThrow(/already holds a note/);
    expect(saves, 'RED WHEN: a refused change is written anyway').toHaveLength(0);
  });

  /**
   * **AND IT REFUSES BEFORE THE MONEY MOVES, WHICH IS THE OTHER HALF.**
   *
   * The same refusal, reached with no call made at all: the deposit tries its own
   * write against the pool before it proves anything, so a deposit that cannot be
   * recorded costs nothing rather than a fee and a note on chain nobody can name.
   */
  it('refuses that deposit BEFORE the call, so no money moves', async () => {
    const { ledger, calls } = harness({ notes: [{ nonce: DEPOSITED, value: 1_000n }] });
    await expect(ledger.deposit(VAULT, { nonce: DEPOSITED, token: GBP, value: 500n }, BY))
      .rejects.toThrow(/already holds a note/);
    expect(
      calls.filter((c) => c.circuit === 'deposit'),
      'RED WHEN: the pre-flight write moves below the call, so the vault pays a fee to deposit a note that cannot be recorded',
    ).toEqual([]);
  });

  it('and with nobody else writing, both still advance the pool', async () => {
    const paid = harness({});
    await paid.ledger.payout(VAULT, payment(200n), BY, EVENTS);
    expect(paid.saves).toHaveLength(1);
    const deposited = harness({ notes: [] });
    await deposited.ledger.deposit(VAULT, { nonce: '77'.repeat(32), token: GBP, value: 500n }, BY);
    expect(deposited.saves).toHaveLength(1);
  });

  it('seals only the notes, never the version a load read', async () => {
    const { ledger, saves } = harness({});
    await ledger.payout(VAULT, payment(200n), BY, EVENTS);
    expect(Object.keys(saves[0])).toEqual(['notes']);
  });
});

describe('C239: the pool advances by the coin the call reported', () => {
  it('records the change coin\'s OWN nonce, which no derivation here produced', async () => {
    const { ledger, current } = harness({ notes: [{ nonce: '01'.repeat(32), value: 1_000n }] });
    await ledger.payout(VAULT, payment(250n), BY, EVENTS);

    const change = current().notes.find(n => n.value === 750n)!;
    expect(change).toBeDefined();
    expect(change.nonce).toBe('ab'.repeat(32));   // what the fake's outputs carried
    expect(change.createdIn).toBe(payHash(1));
    expect(change).not.toHaveProperty('index');
  });

  it('REFUSES when the call carries no readable Zswap state, rather than recording nothing kept',
    async () => {
      /*
       * **`C197` AT THE MONEY PATH'S LAST STEP.** A result we could not read,
       * answered as "no change", drops the change note from the pool: the
       * commitment stays on chain and nobody can ever say which note it
       * describes (`B1`). The pool must not move.
       */
      const { ledger, saves } = harness({
        notes: [{ nonce: '01'.repeat(32), value: 1_000n }], reads: 'absent',
      });
      await expect(ledger.payout(VAULT, payment(250n), BY, EVENTS))
        .rejects.toThrow(/no readable "outputs"/);
      expect(saves).toEqual([]);
    });

  it('REFUSES when the call says the vault kept nothing and the arithmetic says otherwise',
    async () => {
      const { ledger, saves } = harness({
        notes: [{ nonce: '01'.repeat(32), value: 1_000n }], reads: 'none',
      });
      await expect(ledger.payout(VAULT, payment(250n), BY, EVENTS))
        .rejects.toThrow(/no coin coming back to it/);
      expect(saves).toEqual([]);
    });

  it('REFUSES when the coin read back disagrees with the arithmetic', async () => {
    const { ledger, saves } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 1_000n }], reads: 'wrong-value',
    });
    await expect(ledger.payout(VAULT, payment(250n), BY, EVENTS))
      .rejects.toThrow(/two claims about the same money/);
    expect(saves).toEqual([]);
  });

  it('REFUSES a private payment given nowhere to read the note\'s index, before anything is called', async () => {
    const { ledger, calls, saves } = harness({ notes: [{ nonce: '01'.repeat(32), value: 1_000n }] });
    await expect(ledger.payout(VAULT, payment(250n), BY))
      .rejects.toThrow(/No source of the chain\x27s events was given/);
    expect(calls).toEqual([]);
    expect(saves).toEqual([]);
  });
});

/**
 * **`T-38`: `balance` GETS ITS FIRST PRODUCTION CALLER, AND EITHER REFUSAL IS
 * *CANNOT AFFORD*.**
 *
 * `C203`'s mitigation — *"a run reconciles the pool before it starts"* — has
 * been code since `S6c` and had nobody calling it. The rule the register asks
 * for is the one thing these tests are about: a caller must not be able to read
 * *"we could not check"* and decide it is safe to start paying people.
 */
describe('T-38: an affordability check refuses on EITHER refusal', () => {
  /*
   * Every payee here is SHIELDED, which is what makes these the pool's
   * question. `S6k` split `affordable` by the payee's own kind, so a run of
   * public payees goes to the chain's balance instead and never touches the
   * pool — that half is its own describe below.
   */
  const run = (...amounts: bigint[]) =>
    amounts.map(amount => ({ payee: PAYEE, token: GBP as never, amount }));

  it('passes a run the reconciled pool can pay, one payment at a time', async () => {
    const { ledger } = harness({ notes: [{ nonce: '01'.repeat(32), value: 1_000n }] });
    await expect(ledger.affordable(VAULT, run(250n, 250n, 400n))).resolves.toBeUndefined();
  });

  it('CANNOT AFFORD when the chain could not be read — not "probably fine"', async () => {
    const { ledger } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 1_000n }], chain: 'unreadable',
    });
    const failed = await ledger.affordable(VAULT, run(10n)).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultCannotAfford);
    expect((failed as VaultCannotAfford).why).toBe('chain-unreadable');
    /* The refusal is kept, so an operator can tell the two apart afterwards. */
    expect((failed as VaultCannotAfford).cause).toBeInstanceOf(VaultChainUnreadable);
    /* And the sum it would have had appears nowhere. */
    expect(failed?.message).not.toContain('1000');
  });

  it('CANNOT AFFORD a run whose note records no creating transaction, which the payment would refuse', async () => {
    /*
     * The same note, the same reconciled pool, and the same payment that
     * `payout` refuses before a fee (see "REFUSES before a fee a note that does
     * not record which transaction created it"). The check before a proposal is
     * raised must say the same, or the proposal is approved and paid for first.
     */
    const { ledger } = harness({ notes: [{ nonce: '01'.repeat(32), value: 1_000n }], noCreatingTransaction: true });
    const failed = await ledger.affordable(VAULT, run(250n)).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultCannotAfford);
    expect((failed as VaultCannotAfford).why).toBe('notes-do-not-cover');
    expect(failed?.message).toMatch(/does not record which transaction created it/);
    await expect(ledger.payout(VAULT, payment(250n), BY, EVENTS)).rejects.toThrow(/does not record which transaction created it/);
  });

  it('AFFORDS AND PAYS a run out of a larger recorded note when the smallest covering note records no transaction, and leaves that note in the pool', async () => {
    /*
     * The pool this was filed about: 150 that records no creating transaction,
     * beside 5,000 that does, paying 100. The check before a proposal used to
     * answer "the vault no longer holds the money" and the payment used to
     * refuse, while the vault could pay out of the 5,000 all along.
     */
    const { ledger, spentCoins, eventReads, saves, journalled, current } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 150n }, { nonce: '02'.repeat(32), value: 5_000n }],
    });
    const { createdIn: _never, ...unrecorded } = current().notes[0]!;
    current().notes[0] = unrecorded;
    await expect(
      ledger.affordable(VAULT, run(100n)),
      'RED WHEN: the affordability walk refuses a vault that can pay, because it chose a note the payment cannot spend',
    ).resolves.toBeUndefined();
    await ledger.payout(VAULT, payment(100n), BY, EVENTS);
    expect(spentCoins.map((c) => c.value), 'RED WHEN: the payment spends a different note from the one the walk chose').toEqual([5_000n]);
    expect(eventReads, 'the index is read from the transaction the spent note records').toEqual([{ hash: SEEDED_TX }]);
    expect(journalled.map((j) => j.spent.value), 'the attempt journalled is the note actually spent').toEqual([5_000n]);
    const after = saves[saves.length - 1]!.notes;
    expect(
      after.find((n) => n.nonce === '01'.repeat(32)),
      'RED WHEN: the note the payment passed over leaves the pool, which is money on chain nobody can name again',
    ).toEqual({ nonce: '01'.repeat(32), token: GBP, value: 150n });
    expect(after.map((n) => n.value).sort((a, b) => Number(a - b))).toEqual([150n, 4_900n]);
    /* And a payment only the unrecorded note could make is refused before anything is called, naming it. */
    const again = harness({ notes: [{ nonce: '01'.repeat(32), value: 150n }], noCreatingTransaction: true });
    await expect(again.ledger.payout(VAULT, payment(100n), BY, EVENTS)).rejects.toThrow(/One note does: 0101.*\(150\)/);
    expect(again.calls).toEqual([]);
  });

  it('CANNOT AFFORD when the pool and the chain disagree', async () => {
    const { ledger } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 600n }, { nonce: '02'.repeat(32), value: 400n }],
      chain: [{ nonce: '01'.repeat(32), value: 600n }],
    });
    const failed = await ledger.affordable(VAULT, run(10n)).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultCannotAfford);
    expect((failed as VaultCannotAfford).why).toBe('pool-disagrees');
    expect((failed as VaultCannotAfford).cause).toBeInstanceOf(VaultPoolDisagreesWithChain);
  });

  it('CANNOT AFFORD when the notes do not cover it, even though the SUM does', async () => {
    /*
     * The question a balance answers wrongly. Two notes of 60 reconcile
     * perfectly and cannot pay 100, because `noteToSpend` does not merge — so a
     * check built on `balance` alone passes a run that stops on its first payee.
     */
    const { ledger } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 60n }, { nonce: '02'.repeat(32), value: 60n }],
    });
    const failed = await ledger.affordable(VAULT, run(100n)).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultCannotAfford);
    expect((failed as VaultCannotAfford).why).toBe('notes-do-not-cover');
    expect(failed?.message).toMatch(/payment 1 of 1/);
  });

  it('says WHERE a run would stop, because stopping mid-run is the failure', async () => {
    const { ledger } = harness({ notes: [{ nonce: '01'.repeat(32), value: 1_000n }] });
    const failed = await ledger.affordable(VAULT, run(400n, 400n, 400n))
      .then(() => null, (e: Error) => e);
    expect(failed?.message).toMatch(/payment 3 of 3/);
    expect(failed?.message).toMatch(/pays until it stops/);
  });

  it('reconciles BEFORE it asks whether the notes cover it', async () => {
    /*
     * The order matters and is not cosmetic. A pool that disagrees with the
     * chain can easily "cover" a run out of notes the chain will refuse, and
     * answering `notes-do-not-cover` — or worse, answering yes — for a pool
     * nothing had checked is `C198`'s defect wearing this function's name.
     */
    const { ledger } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 1_000n }],
      chain: [{ nonce: '01'.repeat(32), value: 1_000n }, { nonce: '02'.repeat(32), value: 5n }],
    });
    const failed = await ledger.affordable(VAULT, run(999_999n)).then(() => null, (e: Error) => e);
    expect((failed as VaultCannotAfford).why).toBe('pool-disagrees');
  });
});

/* ------------------------------------------------------------------------
 * PUBLIC MONEY, THROUGH THE CLIENT.
 * ------------------------------------------------------------------------ */

/**
 * **A VAULT HOLDING ONLY PUBLIC MONEY NEEDS NO POOL, AND THAT IS TESTED BY
 * TAKING THE POOL AWAY.**
 *
 * `C242`'s row is that a vault deployed today cannot be funded, because
 * `SealedNotePool.load` correctly refuses when no record exists and
 * `VaultLedger.deposit` loads before it calls. That is right for shielded money
 * and it must not gate public money, or a vault that needs no pool could not be
 * funded without one.
 *
 * **So every test in this describe runs against a `NotePool` whose `load`,
 * `save` and `create` all THROW BY NAME.** A branch that merely skipped the
 * pool would pass a test that supplied a working one; nothing but an
 * unreachable pool distinguishes *"unnecessary"* from *"tolerated"*, which is
 * the distinction the round asked for in those words.
 */
describe('S6k: public money needs no pool', () => {
  const publicMoney = { token: NIGHT, amount: 500n };

  it('FUNDS A VAULT WHOSE NOTE POOL CANNOT BE REACHED AT ALL', async () => {
    const { ledger, calls, saves, creates } = harness({ poolThrows: true });

    const tx = await ledger.depositUnshielded(VAULT, publicMoney, BY);

    expect(tx.ref).toBe('tx_dep_public');
    /* The colour and the amount, and nothing else — the circuit takes two. */
    const call = calls.find(c => c.circuit === 'depositUnshielded')!;
    expect(call.args).toHaveLength(2);
    expect(toHex(call.args[0] as Uint8Array)).toBe(NIGHT);
    expect(call.args[1]).toBe(500n);
    /* And nothing local moved, because there is nothing local to move. */
    expect(saves).toHaveLength(0);
    expect(creates).toHaveLength(0);
  });

  it('PAYS A PUBLIC PAYEE WITH THE POOL STILL UNREACHABLE', async () => {
    const { ledger, calls, saves } = harness({ poolThrows: true });

    const paid = await ledger.payout(
      VAULT, { ...payment(250n), payee: PUBLIC_PAYEE, token: NIGHT }, BY);

    expect(paid.kind).toBe('unshielded');
    expect(paid.ref).toBe('tx_pay_public');
    expect(calls.map(c => c.circuit)).toEqual(['payoutUnshielded']);
    expect(saves).toHaveLength(0);
  });

  it('refuses a deposit of nothing, which would jam the vault\'s retirement for free', async () => {
    const { ledger, calls } = harness({ poolThrows: true });
    await expect(ledger.depositUnshielded(VAULT, { token: NIGHT, amount: 0n }, BY))
      .rejects.toThrow(/deposit of nothing/i);
    /* Before a fee, before a proof, and before the contract's own assert. */
    expect(calls).toHaveLength(0);
  });

  it('still loads the pool for a SHIELDED deposit, which is C242 unchanged', async () => {
    const { ledger } = harness({ poolThrows: true });
    await expect(ledger.deposit(VAULT, { nonce: '77'.repeat(32), token: GBP, value: 5n }, BY))
      .rejects.toThrow(/note pool was LOADED/);
  });
});

/**
 * **`C246` AT THE CLIENT: THE PAYEE CHOOSES THE CIRCUIT, AND NOTHING ELSE
 * CAN.**
 *
 * `PAYEE` and `PUBLIC_PAYEE` are built from the SAME 32 bytes. So every
 * assertion here is about the KIND and never about the values — if the dispatch
 * read the wrong field, the recipient bytes would still be right and the
 * failure would be invisible at this layer.
 *
 * What this layer can prove that the contract tests cannot: which CIRCUIT was
 * called, and whether an encryption mapping travelled with it.
 */
describe('C246: which door a payment leaves by', () => {
  it('a SHIELDED payee goes through `payout`, with the encryption mapping', async () => {
    const { ledger, calls, scopes } = harness();
    const paid = await ledger.payout(VAULT, payment(200n), BY, EVENTS);

    expect(paid.kind).toBe('shielded');
    expect(calls.map(c => c.circuit)).toEqual(['payout']);
    expect([...scopes[0].mappings.entries()]).toHaveLength(1);
  });

  it('an UNSHIELDED payee goes through `payoutUnshielded`, with NO mapping', async () => {
    const { ledger, calls, scopes } = harness({ poolThrows: true });
    const paid = await ledger.payout(
      VAULT, { ...payment(200n), payee: PUBLIC_PAYEE, token: NIGHT }, BY, EVENTS);

    expect(paid.kind).toBe('unshielded');
    expect(calls.map(c => c.circuit)).toEqual(['payoutUnshielded']);
    /*
     * **AND THE ABSENCE IS THE POINT, NOT AN OMISSION.** `V-77`'s obligation —
     * the payer must carry the payee's encryption key so their wallet can find
     * the coin — has no counterpart for a public UTXO: the payee's wallet finds
     * it by looking. A mapping here would be a key nobody reads, attached to a
     * payment that is already visible.
     */
    expect([...scopes[0].mappings.entries()]).toHaveLength(0);
    expect(scopes[0].scopeName).toBe('vault:payoutUnshielded');
  });

  it('hands the public circuit the payee\'s USER ADDRESS, in the recipient position', async () => {
    const { ledger, calls } = harness({ poolThrows: true });
    await ledger.payout(VAULT, { ...payment(200n), payee: PUBLIC_PAYEE, token: NIGHT }, BY);

    const call = calls.find(c => c.circuit === 'payoutUnshielded')!;
    expect(call.args).toHaveLength(12);
    /* 6 is the recipient. See the argument list beside the fake's payout. */
    expect(toHex(call.args[6] as Uint8Array)).toBe(PUBLIC_PAYEE.userAddress);
  });

  it('REFUSES A PUBLIC PAYEE ON ANOTHER NETWORK, which nothing downstream would', async () => {
    const { ledger, calls } = harness({ poolThrows: true });
    const elsewhere = unshieldedPayeeFor(new Uint8Array(32).fill(0x44), 'stagenet');
    await expect(ledger.payout(VAULT, { ...payment(200n), payee: elsewhere }, BY))
      .rejects.toThrow(/user address would be accepted either way/);
    expect(calls).toHaveLength(0);
  });
});

/**
 * **WHAT `balance` MEANS FOR PUBLIC MONEY, AND WHY IT IS A DIFFERENT
 * FUNCTION.** `C198`, `C110`, `C188`'s family.
 *
 * `balance` reconciles a local record against the chain and has THREE outcomes.
 * `unshieldedBalance` has no local record to reconcile — the ledger's figure is
 * the only record there has ever been — so it has TWO. Conflating them is how
 * *"could not read"* becomes *"there is none"*, and a vault's whole float reads
 * as zero.
 *
 * **`C248` DOES NOT REACH THIS FUNCTION, AND THE DISTINCTION IS THE POINT OF
 * SAYING SO.** The empty-map hole is in `CallContext.balance`, which is what
 * the CIRCUIT's `unshieldedBalanceGte` reads. This asks the indexer through the
 * provider bundle, which these tests supply. So the answers below are a real
 * read of a controlled chain, not a circuit's question asked of an empty map.
 */
describe('S6k: the public balance is the chain\'s number, or no number', () => {
  it('returns what the chain published for that colour', async () => {
    const { ledger } = harness({ publicBalances: [[NIGHT, 4_200n], [GBP, 7n]] });
    expect(await ledger.unshieldedBalance(VAULT, NIGHT)).toBe(4_200n);
  });

  it('ZERO for a colour the chain answered about and did not list', async () => {
    /*
     * A true statement about the vault, and the ONE place a zero is correct
     * here: the indexer published what this contract holds and this colour is
     * not among it.
     */
    const { ledger } = harness({ publicBalances: [[GBP, 7n]] });
    expect(await ledger.unshieldedBalance(VAULT, NIGHT)).toBe(0n);
  });

  it('does NOT read a balance the pool would have to be loaded for', async () => {
    const { ledger } = harness({ poolThrows: true, publicBalances: [[NIGHT, 9n]] });
    expect(await ledger.unshieldedBalance(VAULT, NIGHT)).toBe(9n);
  });

  /*
   * THE FOUR WAYS IT MUST REFUSE RATHER THAN ANSWER ZERO. C110's class: "we
   * could not check" and "the chain says none" are different answers with
   * opposite consequences, and only one of them is a reason to stop.
   */
  it.each([
    ['the indexer has no contract action for this address', 'unreadable' as const],
    ['the read itself failed', 'read-throws' as const],
    ['a shape this client cannot read', 'not-a-list' as const],
    ['a provider that cannot answer at all', 'no-provider' as const],
    ['a row that is not a balance', 'bad-row' as const],
  ])('REFUSES rather than answering zero: %s', async (_why, publicBalances) => {
    const { ledger } = harness({ publicBalances });
    await expect(ledger.unshieldedBalance(VAULT, NIGHT))
      .rejects.toThrow(VaultChainUnreadable);
  });

  it('says there is no local number to fall back to, which is the design', async () => {
    const { ledger } = harness({ publicBalances: 'unreadable' });
    const failed = await ledger.unshieldedBalance(VAULT, NIGHT).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultChainUnreadable);
    expect(failed!.message).toMatch(/no local number to fall back to/i);
    /* And the shielded refusal still says the opposite thing, which is also true. */
    const { ledger: l2 } = harness({ chain: 'unreadable' });
    const other = await l2.balance(VAULT, GBP).then(() => null, (e: Error) => e);
    expect(other!.message).toMatch(/the pool alone is our bookkeeping/i);
  });

  it('never names the vault in its words, and carries it as a property', async () => {
    const { ledger } = harness({ publicBalances: 'unreadable' });
    const failed = await ledger.unshieldedBalance(VAULT, NIGHT)
      .then(() => null, (e: VaultChainUnreadable) => e);
    /* C236: an error message is a screen. */
    expect(failed!.message).not.toContain(VAULT.slice(0, 8));
    expect(failed!.vaultAddress).toBe(VAULT);
  });
});

/**
 * **AFFORDABILITY, SPLIT BY THE PAYEE'S OWN KIND.**
 *
 * A run can hold both kinds side by side — that is `S6j`'s property, and it
 * falls out of the leaf carrying the kind rather than the run. So one question
 * gets the wrong answer twice: the pool knows nothing about NIGHT, and the
 * chain's public balance says nothing about notes.
 *
 * **AND A SUM IS THE RIGHT QUESTION HERE, WHICH IS EXACTLY WHAT IT IS NOT ON
 * THE PRIVATE SIDE.** Notes do not merge, so a pool of two sixties
 * cannot pay a hundred. A public balance is one number the ledger subtracts
 * from, so a total is precisely the question.
 */
describe('S6k: an affordability check reads the right treasury', () => {
  const publicRun = (...amounts: bigint[]) =>
    amounts.map(amount => ({ payee: PUBLIC_PAYEE, token: NIGHT, amount }));

  it('passes a public run the chain says the vault can cover, and TOUCHES NO POOL', async () => {
    const { ledger } = harness({ poolThrows: true, publicBalances: [[NIGHT, 1_000n]] });
    await expect(ledger.affordable(VAULT, publicRun(400n, 400n))).resolves.toBeUndefined();
  });

  it('CANNOT AFFORD when the total exceeds what the chain says, not the largest payment', async () => {
    /*
     * Each payment fits on its own; the run does not. On the private side that
     * distinction is `paymentsFit`'s and is about notes not merging. Here it is
     * arithmetic on one number, and the run would pay until it stopped.
     */
    const { ledger } = harness({ poolThrows: true, publicBalances: [[NIGHT, 1_000n]] });
    const failed = await ledger.affordable(VAULT, publicRun(600n, 600n))
      .then(() => null, (e: VaultCannotAfford) => e);
    expect(failed).toBeInstanceOf(VaultCannotAfford);
    expect(failed!.why).toBe('public-balance-short');
    expect(failed!.message).toMatch(/pays 1200 of a public token .* holds 1000/);
  });

  it('CANNOT AFFORD when the public balance could not be read — not "probably fine"', async () => {
    const { ledger } = harness({ poolThrows: true, publicBalances: 'unreadable' });
    const failed = await ledger.affordable(VAULT, publicRun(1n))
      .then(() => null, (e: VaultCannotAfford) => e);
    expect(failed).toBeInstanceOf(VaultCannotAfford);
    expect(failed!.why).toBe('chain-unreadable');
  });

  it('A MIXED RUN ASKS BOTH, and refuses if EITHER half is short', async () => {
    /*
     * The pool holds 1,000 of GBP and the chain says 100 of NIGHT. The private
     * half fits and the public half does not, so the run does not.
     */
    const { ledger } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 1_000n }],
      publicBalances: [[NIGHT, 100n]],
    });
    const failed = await ledger.affordable(VAULT, [
      { payee: PAYEE, token: GBP, amount: 250n },
      { payee: PUBLIC_PAYEE, token: NIGHT, amount: 250n },
    ]).then(() => null, (e: VaultCannotAfford) => e);
    expect(failed!.why).toBe('public-balance-short');
  });

  it('and passes a mixed run both halves cover', async () => {
    const { ledger } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 1_000n }],
      publicBalances: [[NIGHT, 1_000n]],
    });
    await expect(ledger.affordable(VAULT, [
      { payee: PAYEE, token: GBP, amount: 250n },
      { payee: PUBLIC_PAYEE, token: NIGHT, amount: 250n },
    ])).resolves.toBeUndefined();
  });
});

/**
 * **THE AMOUNT IS WRITTEN DOWN BEFORE THE MONEY MOVES.**
 *
 * A payment's change note is on chain as a commitment the moment the call
 * lands, and the pool is written after. The nonce and colour of that note can
 * be derived from the note that was spent; **its value cannot** -- it is the
 * spent value minus an amount that until this record existed lived in one
 * process's memory. A crash between the call and the pool write therefore
 * left money the vault owned and could not name. These pin that the attempt
 * is recorded, that it is recorded BEFORE the call, that it carries what a
 * rebuild needs, and that a ledger with nowhere to record it refuses rather
 * than pays.
 */
describe('a private payment journals its attempt before the call', () => {
  it('records the note it is about to spend and the amount, BEFORE the payout call', async () => {
    const { ledger, journalled, calls, spentCoins } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 60n }, { nonce: '02'.repeat(32), value: 1_000n }],
    });
    await ledger.payout(VAULT, payment(200n), BY, EVENTS);

    expect(journalled).toHaveLength(1);
    expect(
      journalled[0].callsMadeSoFar,
      'RED WHEN: the journal write is moved below the call -- an attempt recorded after the money moved is not on disk when the process stops in between, which is the only moment this record exists for',
    ).toBe(0);
    expect(calls.map((c) => c.circuit)).toEqual(['payout']);

    /* What a rebuild needs to name the change note without inverting anything. */
    expect(journalled[0].spent).toEqual({ nonce: '02'.repeat(32), token: GBP, value: 1_000n });
    expect(journalled[0].amount).toBe(200n);
    expect(
      journalled[0].spent.nonce,
      'RED WHEN: the note journalled is not the note the contract then spent, so the change note the rebuild derives belongs to no payment',
    ).toBe(toHex(spentCoins[0].nonce));
  });

  it('REFUSES a private payment by name when the ledger has nowhere to write the attempt, and calls nothing', async () => {
    const { ledger, calls, saves } = harness({ journal: 'none' });
    await expect(ledger.payout(VAULT, payment(100n), BY, EVENTS))
      .rejects.toThrow(/nowhere to write it/);
    expect(calls, 'RED WHEN: a payment proceeds unjournalled, which reopens the window silently').toEqual([]);
    expect(saves).toHaveLength(0);
  });

  it('a journal that cannot be written STOPS the payment with nothing spent', async () => {
    const { ledger, calls, saves } = harness({ journal: 'refuses' });
    await expect(ledger.payout(VAULT, payment(100n), BY, EVENTS))
      .rejects.toThrow(/journal cannot be written/);
    expect(calls, 'RED WHEN: the journal refusal arrives after the call, which moves the loss rather than removing it').toEqual([]);
    expect(saves).toHaveLength(0);
  });

  it('a PUBLIC payment writes no journal line: it spends no note and keeps no change', async () => {
    const { ledger, journalled, calls } = harness({ poolThrows: true });
    await ledger.payout(VAULT, { ...payment(200n), payee: PUBLIC_PAYEE, token: NIGHT }, BY);
    expect(calls.map((c) => c.circuit)).toEqual(['payoutUnshielded']);
    expect(journalled, 'RED WHEN: a public payment is journalled -- it spends no note, so the line would name money that does not exist').toHaveLength(0);
  });

  it('one line per payment, each naming the note THAT payment spent', async () => {
    const { ledger, journalled, spentCoins } = harness();
    await ledger.payout(VAULT, payment(100n), BY, EVENTS);
    await ledger.payout(VAULT, payment(200n), BY, EVENTS);
    expect(journalled).toHaveLength(2);
    expect(journalled.map((j) => j.spent.nonce)).toEqual(spentCoins.map((c: any) => toHex(c.nonce)));
    expect(journalled.map((j) => j.amount)).toEqual([100n, 200n]);
    /* The second spends the first's change, so its journalled value is what was kept. */
    expect(journalled[1].spent.value).toBe(900n);
  });
});

/**
 * **JOURNALLING A DEPOSIT IS THE LEDGER'S, NOT A HABIT OF ONE DOOR.** The same
 * four facts the payment's journal is held to: the coin is recorded, before the
 * call, whole, and a ledger with nowhere to record it refuses rather than
 * deposits.
 */
describe('a private deposit journals its coin before the call', () => {
  const COIN = { nonce: '77'.repeat(32), token: GBP, value: 500n };

  it('records the coin it is about to create, whole, BEFORE the deposit call and before the pool write', async () => {
    const { ledger, depositsJournalled, calls, current } = harness({ notes: [] });
    await ledger.deposit(VAULT, COIN, BY);
    expect(depositsJournalled).toHaveLength(1);
    expect(
      depositsJournalled[0].callsMadeSoFar,
      'RED WHEN: the deposit\'s line is written after the call -- a nonce recorded after the money moved is not on disk when the process stops in between, which is the only moment this record exists for',
    ).toBe(0);
    expect(depositsJournalled[0].savesMadeSoFar).toBe(0);
    expect(calls.map((c) => c.circuit)).toEqual(['deposit']);
    expect(
      depositsJournalled[0].coin,
      'RED WHEN: the line is not the coin the call creates -- a different nonce or value names a note the chain never held, and the real one stays unnameable',
    ).toEqual(COIN);
    expect(Number.isNaN(Date.parse(depositsJournalled[0].attemptedAt))).toBe(false);
    expect(current().notes.map((n) => n.nonce)).toEqual([COIN.nonce]);
  });

  it('REFUSES a private deposit by name when the ledger has nowhere to write the coin, and calls nothing', async () => {
    const { ledger, calls, saves } = harness({ notes: [], depositJournal: 'none' });
    await expect(
      ledger.deposit(VAULT, COIN, BY),
      'RED WHEN: a ledger built without a deposit journal deposits anyway -- the first private deposit through any caller but the door reopens the crash window with nothing red',
    ).rejects.toThrow(/nowhere to write it/);
    await expect(ledger.deposit(VAULT, COIN, BY), 'RED WHEN: the refusal stops naming what resolves it, in terms the reader can act on')
      .rejects.toThrow(/Construct the ledger with a deposit journal/);
    expect(calls, 'RED WHEN: the refusal arrives after the call').toEqual([]);
    expect(saves).toHaveLength(0);
  });

  it('a deposit journal that cannot be written STOPS the deposit with nothing spent', async () => {
    const { ledger, calls, saves } = harness({ notes: [], depositJournal: 'refuses' });
    await expect(ledger.deposit(VAULT, COIN, BY))
      .rejects.toThrow(/deposit journal cannot be written/);
    expect(calls, 'RED WHEN: a journal failure is swallowed and the deposit goes ahead unjournalled').toEqual([]);
    expect(saves).toHaveLength(0);
  });

  it('a deposit the pool would refuse journals NOTHING: the pre-flight comes first', async () => {
    const { ledger, depositsJournalled, calls } = harness({ notes: [{ nonce: '77'.repeat(32), value: 9n }] });
    await expect(ledger.deposit(VAULT, COIN, BY)).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(
      depositsJournalled,
      'RED WHEN: the line is written before the pre-flight, so every refused deposit leaves a line naming a coin nobody tried to make',
    ).toHaveLength(0);
  });

  it('a PUBLIC deposit writes no deposit line and needs no deposit journal', async () => {
    const { ledger, depositsJournalled, calls } = harness({ poolThrows: true, depositJournal: 'none' });
    await ledger.depositUnshielded(VAULT, { token: NIGHT, amount: 10n }, BY);
    expect(calls.map((c) => c.circuit)).toEqual(['depositUnshielded']);
    expect(depositsJournalled, 'RED WHEN: a public deposit is journalled or refused for want of a journal -- it creates no note').toHaveLength(0);
  });

  it('a PRIVATE PAYMENT needs no deposit journal, and a deposit needs no payment journal', async () => {
    const paying = harness({ depositJournal: 'none' });
    await expect(paying.ledger.payout(VAULT, payment(100n), BY, EVENTS)).resolves.toBeDefined();
    const depositing = harness({ notes: [], journal: 'none' });
    await expect(depositing.ledger.deposit(VAULT, COIN, BY)).resolves.toBeDefined();
    expect(depositing.depositsJournalled).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * THE PRODUCT'S OWN STORE, WATCHED FROM THE CLIENT. A pool created, a
 * deposit recorded into it and a private payment made against it, through
 * `VaultLedger` with the pool and both journals kept in the product's
 * database - and then everything read back by a second connection that
 * shares nothing with the first, and rebuilt from.
 * ------------------------------------------------------------------ */
const STORE_DB = process.env.TEST_DATABASE_URL;
(STORE_DB ? describe : describe.skip)('the product\'s store, from where a person stands', () => {
  const OWN_DB = 'ca_test_vault_client';
  let admin: any;
  let url: string;

  beforeAll(async () => {
    const { default: postgres } = await import('postgres');
    admin = postgres(STORE_DB!, { onnotice: () => {} });
    const [row] = await admin`SELECT count(*)::int AS n FROM pg_database WHERE datname = ${OWN_DB}`;
    if (row.n === 0) await admin.unsafe(`CREATE DATABASE "${OWN_DB}"`);
    const u = new URL(STORE_DB!);
    u.pathname = `/${OWN_DB}`;
    url = u.toString();
    /*
     * THIS DATABASE IS THIS TEST'S ALONE, AND IT STARTS EMPTY. The vault's
     * address is a constant of this file, so a record left by an earlier run
     * would make `create` refuse. A table is dropped, which its triggers do not
     * stop, and nothing else uses this database.
     */
    const own = postgres(url, { onnotice: () => {} });
    const [me] = await own`SELECT current_database() AS db`;
    if (me.db !== OWN_DB) throw new Error(`refusing to run: connected to ${me.db}, not ${OWN_DB}`);
    await own`DROP TABLE IF EXISTS vault_sealed_records`;
    await own.unsafe(readFileSync('db/migrations/0002_vault_sealed_records.sql', 'utf8'));
    await own.end({ timeout: 2 });
  });
  afterAll(async () => { if (admin) await admin.end({ timeout: 2 }); });

  it('CREATES, DEPOSITS AND PAYS through the ledger with every record in the database, and a second connection rebuilds the vault from them', async () => {
    const { default: postgres } = await import('postgres');
    const { openVaultRecords, NOTHING_IS_KEPT_ELSEWHERE } = await import('../db/vault-records.js');
    const { SealedNotePool, openPool } = await import('./vault-pool.js');
    const { PaymentJournalInStore, DepositJournalInStore, attemptsFromJournalVersions } = await import('./vault-journal.js');
    const { reconcileVaultPool, commitmentForNote } = await import('./vault-recovery.js');
    const { newWrappingKeypair } = await import('../core/crypto.js');

    const k = newWrappingKeypair();
    const signers = async () => [{ id: 'kc', wrappingPublicKey: k.publicKey }];
    const opener = { id: 'kc', wrappingSecret: k.secret };
    const one = postgres(url, { onnotice: () => {} });
    const other = postgres(url, { onnotice: () => {} });
    try {
      const records = await openVaultRecords(one, { refuseToCreate: NOTHING_IS_KEPT_ELSEWHERE });
      const h = harness({
        notes: [],
        poolExists: false,
        keptIn: {
          pool: new SealedNotePool(records.of('pool'), { signerId: 'kc', wrappingSecret: k.secret }, signers),
          payments: new PaymentJournalInStore(records.of('payment-journal'), VAULT, opener, signers),
          deposits: new DepositJournalInStore(records.of('deposit-journal'), VAULT, opener, signers),
        },
      });

      await h.ledger.openPool(VAULT);
      await h.ledger.deposit(VAULT, { nonce: '77'.repeat(32), token: GBP, value: 500n }, BY, eventsInUse);
      const paid = await h.ledger.payout(VAULT, payment(200n), BY, EVENTS);
      if (paid.kind !== 'shielded') throw new Error('a private payee was paid through another door');
      expect(paid.spentNote).toBe('77'.repeat(32));

      /* A second connection, and a store object that shares nothing with the one that wrote. */
      const theirs = await openVaultRecords(other, { refuseToCreate: NOTHING_IS_KEPT_ELSEWHERE });
      const versions = await theirs.of('pool').versions(VAULT);
      expect(
        versions.map((v) => v.version),
        'RED WHEN: the pool the client created, deposited into and paid from is not the record the database holds - one version per write',
      ).toEqual([1, 2, 3]);
      const now = openPool(versions[2]!.sealed, 'kc', k.secret);
      expect(now.notes.map((n) => [n.value, n.createdIn]),
        'RED WHEN: the change note the payment made is not what the store now says the vault holds').toEqual([[300n, payHash(1)]]);

      const attempted = attemptsFromJournalVersions({
        deposits: await theirs.of('deposit-journal').versions(VAULT),
        payments: await theirs.of('payment-journal').versions(VAULT),
        opener,
      });
      expect(attempted.deposits, 'RED WHEN: the deposit was made without its coin written down first, in the store')
        .toEqual([{ nonce: '77'.repeat(32), token: GBP, value: 500n }]);
      expect(attempted.payments, 'RED WHEN: the payment moved money without its amount written down first, in the store')
        .toEqual([{ spent: { nonce: '77'.repeat(32), token: GBP, value: 500n }, amount: 200n }]);

      /* And the rebuild, from nothing but what the store holds and what the chain holds. */
      const change = now.notes[0]!;
      const rebuilt = reconcileVaultPool({
        vault: VAULT as never,
        chain: [commitmentForNote(vaultCircuits as never, VAULT as never, change)],
        versions: versions.map((v) => ({ version: v.version, notes: openPool(v.sealed, 'kc', k.secret).notes })),
        attempted,
        circuits: vaultCircuits as never,
      });
      expect(rebuilt.held.map((n) => n.value)).toEqual([300n]);
      expect(rebuilt.unexplained).toEqual([]);
    } finally {
      await one.end({ timeout: 2 });
      await other.end({ timeout: 2 });
    }
  });
});
