/**
 * V-74: the vault client, against a chain whose answers we control.
 *
 * What only this layer can get wrong: advancing the pool on a call that did not
 * happen, advancing it by the wrong note, or holding a copy of it taken before
 * the call. Each of those is a vault whose money stops moving, and none of them
 * is visible in the contract tests.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  VaultLedger, VaultChainUnreadable, VaultPoolDisagreesWithChain,
  VaultCannotAfford, VaultAlreadyHoldsNotes,
  type NotePool, type VaultPayment,
} from './vault-ledger.js';
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
vi.doMock('../../contracts/managed-vault/contract/index.js', () => ({
  ledger: (d: any) => d,
  pureCircuits: vaultCircuits,
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
} = {}) {
  let stored: VaultNotes = {
    notes: (opts.notes ?? [{ nonce: '01'.repeat(32), value: 1_000n }])
      .map(n => ({ nonce: n.nonce, token: GBP, value: n.value, index: 0n })),
  };
  const saves: VaultNotes[] = [];
  const creates: VaultNotes[] = [];
  let exists = opts.poolExists ?? true;
  const pool: NotePool = {
    load: async () => stored,
    save: async (_a, n) => { stored = n; saves.push(n); },
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
    return {
      public: { txId: 'tx_pay' },
      private: opts.reads === 'absent' ? {} : { nextZswapLocalState: { outputs } },
    };
  };

  const contract: any = {
    callTx: {
      deposit: async (...raw: unknown[]) => {
        const args = dispatch('deposit', 1)(...raw);
        calls.push({ circuit: 'deposit', args, ctx: raw[0] });
        return { public: { txId: 'tx_dep' } };
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
        if (opts.chain === 'no-notes-field') return { data: { account: { bytes: new Uint8Array(32) } } };
        const held = chainNotesOf().map(toHex);
        return {
          data: {
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

  const ledger = new VaultLedger(
    { networkId: 'preview' } as never, {} as never, providers as never, {},
    opts.poolThrows ? refusesEverything : pool,
    VAULT_ARTEFACTS);
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
    ledger, calls, saves, creates, scopes,
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
    await ledger.deposit(VAULT, { nonce: '77'.repeat(32), token: GBP, value: 500n, index: 4n }, BY);

    expect(calls[0].circuit).toBe('deposit');
    expect(calls[0].args).toHaveLength(1);
    expect(balanceOf(current(), GBP)).toBe(500n);
    expect(current().notes[0].index).toBe(4n);
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
    const r = await ledger.payout(VAULT, payment(200n), BY, 9n);

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
    expect(current().notes.some(n => n.value === 100n && n.index === 9n)).toBe(true);
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
    await ledger.payout(VAULT, payment(200n), BY, 1n);

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
    await expect(ledger.payout(VAULT, elsewhere, BY, 0n))
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
    await expect(ledger.payout(VAULT, payment(100n), BY, 0n))
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
    await expect(ledger.payout(VAULT, payment(100n), BY, 0n)).rejects.toThrow(/node said no/);
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
    await expect(ledger.payout(VAULT, payment(100n), BY, 0n))
      .rejects.toThrow(/paid without asking for a note|rebuild it from the chain/i);
    expect(saves).toEqual([]);
  });

  it('loads the pool fresh on every call, never a copy taken at construction', async () => {
    /*
     * The "can make exactly one payment" defect wearing a closure. It has
     * already appeared once in this repo, in the first vault test helper.
     */
    const { ledger, current } = harness();
    await ledger.payout(VAULT, payment(100n), BY, 1n);
    await ledger.payout(VAULT, payment(200n), BY, 2n);
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
    const saves = [...source.matchAll(/await this\.pool\.save\(/g)].map(m => m.index!);
    expect(saves).toHaveLength(2);
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
describe('C239: the pool advances by the coin the call reported', () => {
  it('records the change coin\'s OWN nonce, which no derivation here produced', async () => {
    const { ledger, current } = harness({ notes: [{ nonce: '01'.repeat(32), value: 1_000n }] });
    await ledger.payout(VAULT, payment(250n), BY, 9n);

    const change = current().notes.find(n => n.value === 750n)!;
    expect(change).toBeDefined();
    expect(change.nonce).toBe('ab'.repeat(32));   // what the fake's outputs carried
    expect(change.index).toBe(9n);
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
      await expect(ledger.payout(VAULT, payment(250n), BY, 9n))
        .rejects.toThrow(/no readable "outputs"/);
      expect(saves).toEqual([]);
    });

  it('REFUSES when the call says the vault kept nothing and the arithmetic says otherwise',
    async () => {
      const { ledger, saves } = harness({
        notes: [{ nonce: '01'.repeat(32), value: 1_000n }], reads: 'none',
      });
      await expect(ledger.payout(VAULT, payment(250n), BY, 9n))
        .rejects.toThrow(/no coin coming back to it/);
      expect(saves).toEqual([]);
    });

  it('REFUSES when the coin read back disagrees with the arithmetic', async () => {
    const { ledger, saves } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 1_000n }], reads: 'wrong-value',
    });
    await expect(ledger.payout(VAULT, payment(250n), BY, 9n))
      .rejects.toThrow(/two claims about the same money/);
    expect(saves).toEqual([]);
  });

  it('records NO INDEX when the caller has none, rather than a zero', async () => {
    /*
     * The ordinary case, because nothing in this repository reads a
     * commitment's place in the tree back. A zero would be a plausible wrong
     * number and `witnessesOver` would spend against it.
     */
    const { ledger, current } = harness({ notes: [{ nonce: '01'.repeat(32), value: 1_000n }] });
    await ledger.payout(VAULT, payment(250n), BY);
    expect(current().notes.find(n => n.value === 750n)!.index).toBeUndefined();
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
    const paid = await ledger.payout(VAULT, payment(200n), BY, 1n);

    expect(paid.kind).toBe('shielded');
    expect(calls.map(c => c.circuit)).toEqual(['payout']);
    expect([...scopes[0].mappings.entries()]).toHaveLength(1);
  });

  it('an UNSHIELDED payee goes through `payoutUnshielded`, with NO mapping', async () => {
    const { ledger, calls, scopes } = harness({ poolThrows: true });
    const paid = await ledger.payout(
      VAULT, { ...payment(200n), payee: PUBLIC_PAYEE, token: NIGHT }, BY, 1n);

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
