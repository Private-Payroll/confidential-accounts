/**
 * **THE POOL DELETED, THE VAULT REBUILT FROM THE COMPANY'S SEED AND ITS OWN
 * RECORDS, AND A NOTE THAT COMES BACK SPENT.**
 *
 * Everything this product keeps about a vault's notes -- the sealed pool, the
 * deposit journal, the payment journal -- is thrown away. What is left is what
 * a company keeps whether or not we exist: the recovery words of the person who
 * deposited, the amounts it put in, the amounts it paid, and the chain.
 *
 * The vault is the real compiled contract, run in process. Deposits go through
 * the product's own claim (the nonce is derived inside it, from the version it
 * files) and the product's own check that the coin is new. Payments go through
 * the contract's own `payout`. The chain's record of which transaction made
 * which output is read off each call's own Zswap state, never derived.
 *
 * **A RECOVERED NOTE THAT CANNOT BE SPENT IS NOT RECOVERED**, so the claim is
 * only made once one of the rebuilt notes has been paid out of.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createConstructorContext, createCircuitContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { identityFromWords, newWords } from 'midnight-identity';
import { parseAsk } from 'midnight-identity/profile/request';
import { unlockKeyFor } from 'midnight-identity/profile/unlock';
import {
  Contract as Vault, ledger as vaultLedger, pureCircuits as vaultCircuits,
} from '../managed-vault/contract/index.js';
import { pureCircuits } from '../managed/contract/index.js';
import { AccountSimulator, privateStateFor, change, type Change } from './simulator.js';
import { buildPayoutTree, type PayoutLeafInput } from '../../src/midnight/payout-tree.js';
import { changeCoinOf } from '../../src/midnight/vault-coins.js';
import {
  reconcileVaultPool, commitmentForNote, changeNonceOf, describeRecovery,
} from '../../src/midnight/vault-recovery.js';
import { smallestNoteCovering, type Note } from '../../src/midnight/vault-notes.js';
import {
  creatingTransactionsAmong, vaultNoteCommitment,
  type NoteEvents, type ServedEvent, type VaultTransactions,
} from '../../src/midnight/note-index.js';
import {
  MemorySealedPoolStore, SealedNotePool, type PoolSigner,
} from '../../src/midnight/vault-pool.js';
import {
  DepositJournalInStore, PaymentJournalInStore, attemptsFromJournalVersions,
} from '../../src/midnight/vault-journal.js';
import {
  depositNonceKeyFor, vaultOutputHistoryFrom, whyThisCoinIsNotNew, type DepositNonceKey,
} from '../../src/midnight/deposit-nonce.js';
import { walkCompanyRecords, type CompanyRecords } from '../../src/midnight/rebuild-from-records.js';
import { UNLOCK_PURPOSE, UNLOCK_WINDOW_MS, unlockAsk } from '../../src/core/wallet-unlock.js';
import { toHex, fromHex, newWrappingKeypair, randomBytes, type Hex } from '../../src/core/crypto.js';

const VAULT_NOW = 1_800_000_000;
const WIN_FROM = BigInt(VAULT_NOW - 3_600);
const WIN_UNTIL = BigInt(VAULT_NOW + 3_600);
const BLOCK = '0'.repeat(64);
const bytes = (n: number) => new Uint8Array(32).fill(n);
const A = privateStateFor(1);
const B = privateStateFor(2);
const GBP = bytes(0x9b);
const ALICE = bytes(0x0a);
const BOB = bytes(0x0b);
const CAROL = bytes(0x0c);
const DAVE = bytes(0x0d);
const NO_INDEX_YET = 0n;

/**
 * **THE KEY THE COMPANY'S WALLET RELEASES FOR THIS COMPANY, FROM THE WORDS
 * ALONE**, through the wallet's own code: the same parse, the same derivation.
 * Nothing stored reaches it, which is the property the rebuild rests on.
 */
const releasedCompanyKey = (words: string, company: string): Uint8Array => {
  const ask = parseAsk(unlockAsk({
    name: 'Confidential Accounts',
    rdns: 'social.lemonade.confidential-accounts',
    purpose: UNLOCK_PURPOSE,
    nonce: 'derivation-has-no-conversation',
    expiresAt: 0 + UNLOCK_WINDOW_MS,
    company,
  }), 'https://payroll.example', 0);
  if (ask.kind !== 'unlock') throw new Error(`built a ${ask.kind}, not an unlock`);
  return unlockKeyFor(identityFromWords(words), ask);
};

interface VaultPrivate { notes: Note[] }

const vaultWitnesses = {
  noteToSpend: (ctx: { privateState: VaultPrivate }, token: Uint8Array, amount: bigint) => {
    const n = smallestNoteCovering(ctx.privateState.notes, toHex(token), amount);
    if (n === undefined) throw new Error(`the device's pool has no note covering ${amount}`);
    return [ctx.privateState, {
      nonce: fromHex(n.nonce), color: fromHex(n.token), value: n.value, mt_index: n.index ?? NO_INDEX_YET,
    }];
  },
};

describe('a vault whose every record of ours is gone', () => {
  let sim: AccountSimulator;
  let vault: Vault<VaultPrivate>;
  let vaultAddr: Hex;
  let vaultState: any;
  let priv: VaultPrivate;
  let company: string;
  let chainLog: Array<{ hash: Hex; made: { nonce: Hex; token: Hex; value: bigint } | undefined; index: bigint }>;

  const WORDS = newWords().join(' ');
  const SOMEBODY_ELSE = newWords().join(' ');

  const provider = () => ({
    getContractState: async (_b: string, address: unknown) =>
      String(address) === String(sim.address) ? (sim.contractStateForCall as never) : undefined,
  });
  const ctx = (circuit: string) => createCircuitContext<VaultPrivate>(
    circuit, vaultAddr as never, BLOCK, vaultState, priv,
    provider() as never, undefined, undefined, VAULT_NOW, BLOCK);
  /* Before the first call the state is the deployment's ContractState; after it, the call's charged state. */
  const charged = () => (vaultState?.constructor?.name === 'ContractState' ? vaultState.data : vaultState);
  const chainNotes = (): Hex[] => [...vaultLedger(charged() as never).notes].map((c: Uint8Array) => toHex(c));
  const held = (coin: { nonce: Hex; token: Hex; value: bigint }) => commitmentForNote(vaultCircuits, vaultAddr, coin);

  const logCall = (r: { context: { callContext: { currentZswapLocalState: unknown } } }) => {
    const hash = (chainLog.length + 1).toString(16).padStart(64, '0') as Hex;
    chainLog.push({
      hash, made: changeCoinOf(r.context.callContext.currentZswapLocalState, vaultAddr), index: BigInt(100 + chainLog.length),
    });
  };
  /*
   * **THE CHAIN'S COMMITMENT OF AN OUTPUT, COMPUTED BY THE COMPILED CONTRACT'S
   * OWN RUNTIME** - the value its `receiveShielded` and `sendShielded` claim, which
   * the ledger checks against the output it makes. Deliberately not
   * `vaultNoteCommitment`, which is what the walk looks things up with: if the
   * two ever disagreed, the walk would name nothing and this test would say so.
   */
  const outputCommitment = (coin: { nonce: Hex; token: Hex; value: bigint }): string => toHex((vault as any)._coinCommitment_0(
    { nonce: fromHex(coin.nonce), color: fromHex(coin.token), value: coin.value },
    { is_left: false, left: { bytes: new Uint8Array(32) }, right: { bytes: fromHex(vaultAddr) } }));
  const theChain = (): { transactions: VaultTransactions; events: NoteEvents } => ({
    transactions: { of: async () => [...chainLog].reverse().map((t) => t.hash) },
    events: {
      eventsOf: async (tx) => {
        const t = chainLog.find((x) => 'hash' in tx && x.hash === tx.hash);
        if (!t) throw new Error(`the test chain holds no transaction ${JSON.stringify(tx)}`);
        const events: ServedEvent[] = [{ transactionHash: t.hash, details: { tag: 'zswapInput' } }];
        if (t.made) {
          events.push({
            transactionHash: t.hash,
            details: {
              tag: 'zswapOutput', commitment: outputCommitment(t.made), contract: vaultAddr, mtIndex: t.index,
            },
          });
        }
        return events;
      },
    },
  });

  const approvedRun = async (payments: Array<{ to: Uint8Array; amount: bigint; nonce: number }>, c: Change) => {
    const leaves: PayoutLeafInput[] = payments.map((p, i) => ({
      details: toHex(vaultCircuits.payoutDetails(p.to, GBP, p.amount, bytes(0x40 + i))),
      nonce: toHex(bytes(p.nonce)),
    }));
    const tree = buildPayoutTree(leaves);
    const payload = pureCircuits.runPayload(fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL);
    const vaultBytes = fromHex(vaultAddr);
    await sim.as(sim.applying(A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees, from: WIN_FROM, until: WIN_UNTIL, vault: vaultBytes,
    });
    const id = sim.proposalId(payload, c.salt, vaultBytes);
    await sim.as(sim.applying(A, c)).approve(id);
    await sim.as(sim.applying(B, c)).approve(id);
    return { tree, id };
  };

  const pay = async (to: Uint8Array, amount: bigint, seed: number) => {
    const c = change(0n, seed);
    const run = await approvedRun([{ to, amount, nonce: seed }], c);
    const r = await vault.impureCircuits.payout(
      ctx('payout'), run.id, fromHex(run.tree.root), run.tree.payees, WIN_FROM, WIN_UNTIL,
      c.salt, to, GBP, amount, bytes(0x40), bytes(seed), run.tree.pathFor(0) as never);
    vaultState = r.context.callContext.currentQueryContext.state;
    logCall(r);
    return r;
  };

  beforeEach(async () => {
    sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(VAULT_NOW);
    company = String(sim.address);
    vault = new Vault<VaultPrivate>(vaultWitnesses as never);
    vaultAddr = sampleContractAddress() as never as Hex;
    const init = await vault.initialState(
      createConstructorContext({} as VaultPrivate, BLOCK),
      { bytes: fromHex(company) } as never);
    vaultState = init.currentContractState;
    priv = { notes: [] };
    chainLog = [];
  });

  /**
   * **THE PRODUCT'S OWN RECORDS, KEPT AS THE PRODUCT KEEPS THEM**, and a
   * company that deposits and pays through them. Returns what the company's
   * own books say, and nothing else survives the test that calls it.
   */
  const aCompanyAtWork = async (nonces: DepositNonceKey) => {
    const me = newWrappingKeypair();
    const signers = async (): Promise<readonly PoolSigner[]> => [{ id: 'owner', wrappingPublicKey: me.publicKey }];
    const opener = { id: 'owner', wrappingSecret: me.secret };
    const stores = {
      pool: new MemorySealedPoolStore(), deposits: new MemorySealedPoolStore(), payments: new MemorySealedPoolStore(),
    };
    const pool = new SealedNotePool(stores.pool, { signerId: 'owner', wrappingSecret: me.secret }, signers);
    const depositJournal = new DepositJournalInStore(stores.deposits, vaultAddr, opener, signers, nonces);
    const paymentJournal = new PaymentJournalInStore(stores.payments, vaultAddr, opener, signers);
    await pool.create(vaultAddr, { notes: [] });

    const record = async (next: (notes: Note[]) => Note[]) => {
      const now = await pool.load(vaultAddr);
      await pool.save(vaultAddr, { notes: next(now.notes) }, now.readAt);
      priv = { notes: (await pool.load(vaultAddr)).notes };
    };

    /* A deposit, the way the product makes one: claim, check the coin is new, call, record. */
    const deposit = async (value: bigint, opts: { abandon?: boolean } = {}) => {
      const createdBefore = await vaultOutputHistoryFrom(theChain()).everCreated(vaultAddr);
      const { coin } = await depositJournal.claim(vaultAddr, { token: toHex(GBP), value }, new Date().toISOString());
      expect(whyThisCoinIsNotNew({
        poolHoldsTheNonce: (await pool.load(vaultAddr)).notes.some((n) => n.nonce === coin.nonce),
        heldNow: chainNotes().includes(held(coin)),
        createdBefore: createdBefore.has(await vaultNoteCommitment(coin, vaultAddr)),
      })).toBeNull();
      if (opts.abandon) return coin;
      const r = await vault.impureCircuits.deposit(ctx('deposit'), {
        nonce: fromHex(coin.nonce), color: fromHex(coin.token), value: coin.value,
      });
      vaultState = r.context.callContext.currentQueryContext.state;
      logCall(r);
      await record((notes) => [...notes, { ...coin, index: NO_INDEX_YET }]);
      return coin;
    };

    /* A payment, the way the product makes one: journal the attempt, call, record the change. */
    const payFromThePool = async (to: Uint8Array, amount: bigint, seed: number) => {
      const spent = smallestNoteCovering(priv.notes, toHex(GBP), amount)!;
      await paymentJournal.record(vaultAddr, {
        spent: { nonce: spent.nonce, token: spent.token, value: spent.value }, amount, attemptedAt: new Date().toISOString(),
      });
      const r = await pay(to, amount, seed);
      const kept = changeCoinOf(r.context.callContext.currentZswapLocalState, vaultAddr);
      await record((notes) => [
        ...notes.filter((n) => n.nonce !== spent.nonce),
        ...(kept ? [{ ...kept, index: NO_INDEX_YET }] : []),
      ]);
      return { spent, kept };
    };

    return { stores, opener, deposit, payFromThePool };
  };

  it('THE POOL DELETED, THE VAULT REBUILT FROM THE COMPANY\'S SEED AND ITS OWN RECORDS, AND A NOTE THAT COMES BACK SPENT', async () => {
    const work = await aCompanyAtWork(depositNonceKeyFor(releasedCompanyKey(WORDS, company), vaultAddr));

    const first = await work.deposit(1_000n);                       // version 1
    const second = await work.deposit(400n);                        // version 2
    await work.deposit(5_000n, { abandon: true });                  // version 3: filed, never called
    const third = await work.deposit(1_000n);                       // version 4: the same amount as the first
    expect(third.nonce, 'RED WHEN: two deposits of one amount share a nonce').not.toBe(first.nonce);

    const toBob = await work.payFromThePool(BOB, 250n, 0xb1);        // 400 -> change 150
    expect(toBob.spent.nonce).toBe(second.nonce);
    const toAlice = await work.payFromThePool(ALICE, 700n, 0xa1);    // a 1,000 -> change 300
    const toCarol = await work.payFromThePool(CAROL, 100n, 0xc1);    // 150 -> change 50: a change of a change
    expect(toCarol.spent.nonce, 'the setup meant to spend the 150 here').toBe(toBob.kept!.nonce);
    const toErin = await work.payFromThePool(ALICE, 1_000n, 0xe1);   // the other 1,000, spent exactly: no change
    expect(toErin.kept, 'the setup meant an exact spend here').toBeUndefined();
    const before = priv.notes.map((n) => n.value).sort((a, b) => Number(a - b));
    expect(before).toEqual([50n, 300n]);

    /* What the company's books say. Nothing else below comes from this test's past. */
    const records: CompanyRecords = {
      deposited: [{ token: toHex(GBP), value: 1_000n }, { token: toHex(GBP), value: 400n }, { token: toHex(GBP), value: 1_000n }],
      paid: [
        { token: toHex(GBP), amount: 250n }, { token: toHex(GBP), amount: 700n },
        { token: toHex(GBP), amount: 100n }, { token: toHex(GBP), amount: 1_000n },
      ],
    };

    /* ---------------- THE POOL AND BOTH JOURNALS DELETED ---------------- */
    const gone = {
      pool: new MemorySealedPoolStore(), deposits: new MemorySealedPoolStore(), payments: new MemorySealedPoolStore(),
    };
    for (const s of Object.values(gone)) expect(await s.versions(vaultAddr)).toEqual([]);
    priv = { notes: [] };
    const journals = attemptsFromJournalVersions({
      deposits: await gone.deposits.versions(vaultAddr), payments: await gone.payments.versions(vaultAddr), opener: work.opener,
    });
    expect(journals.deposits.length + journals.payments.length, 'nothing of ours is left to read').toBe(0);
    expect(
      () => reconcileVaultPool({ vault: vaultAddr, chain: chainNotes(), versions: [], circuits: vaultCircuits }),
      'RED WHEN: a rebuild with nothing to propose answers as though the vault were empty',
    ).toThrow(/no filed versions/);

    /* ---------------- REBUILT FROM THE WORDS AND THE BOOKS ---------------- */
    const key = depositNonceKeyFor(releasedCompanyKey(WORDS, company), vaultAddr);
    const everCreated = await vaultOutputHistoryFrom(theChain()).everCreated(vaultAddr);
    const walk = await walkCompanyRecords({
      vault: vaultAddr, keys: [key], records, everCreated, commitmentOf: vaultNoteCommitment,
    });
    expect(
      walk.found,
      'RED WHEN: a deposit, or a change that a spent note became, is not named from the records -- the 50 is only reachable through a 400 and a 150 the vault no longer holds',
    ).toEqual({ deposits: 3, changes: 3, pieces: 0 });
    expect(walk.versions, 'RED WHEN: an abandoned attempt stops the walk, so the deposit after it is never named')
      .toEqual([{ walked: 24, lastFound: 4 }]);

    const rebuilt = reconcileVaultPool({
      vault: vaultAddr, chain: chainNotes(), versions: [], named: walk.coins, circuits: vaultCircuits,
    });
    expect(rebuilt.unexplained, `RED WHEN: a note the vault holds is not named: ${describeRecovery(rebuilt)}`).toEqual([]);
    expect(rebuilt.held.map((n) => n.value).sort((a, b) => Number(a - b)), 'RED WHEN: the rebuild holds anything but what the vault holds')
      .toEqual([50n, 300n]);
    const recoveredChange = rebuilt.held.find((n) => n.value === 50n)!;
    expect(recoveredChange.nonce, 'RED WHEN: the change of a change is rebuilt under any nonce but the one the chain made')
      .toBe(toCarol.kept!.nonce);
    expect(rebuilt.held.find((n) => n.value === 300n)!.nonce).toBe(toAlice.kept!.nonce);

    /* Each rebuilt note is given the transaction that created it, from the chain. */
    const created = await creatingTransactionsAmong(vaultAddr, rebuilt.held, theChain());
    expect(created.found.every((f) => 'createdIn' in f), 'RED WHEN: a rebuilt note cannot be given its creating transaction').toBe(true);

    /* ---------------- AND A NOTE THAT COMES BACK SPENT ---------------- */
    priv = { notes: rebuilt.held.map((n) => ({ nonce: n.nonce, token: n.token, value: n.value, index: NO_INDEX_YET })) };
    const paymentsBefore = vaultLedger(charged() as never).payments;
    const r = await pay(DAVE, 40n, 0xd1);                        // the smallest note covering 40 is the rebuilt 50
    expect(vaultLedger(charged() as never).payments, 'RED WHEN: the rebuilt note does not spend').toBe(paymentsBefore + 1n);
    const kept = changeCoinOf(r.context.callContext.currentZswapLocalState, vaultAddr)!;
    expect(kept.value, 'RED WHEN: a note other than the rebuilt change was spent').toBe(10n);
    expect(kept.nonce).toBe(toHex(changeNonceOf(fromHex(recoveredChange.nonce))));
    expect(chainNotes(), 'RED WHEN: the rebuilt note is still in the vault after it was spent')
      .not.toContain(held(recoveredChange));
  });

  it('A NONCE NOBODY ELSE CAN DERIVE: another person\'s words, or a rounded amount, name nothing, and the rebuild SAYS so rather than guessing', async () => {
    const work = await aCompanyAtWork(depositNonceKeyFor(releasedCompanyKey(WORDS, company), vaultAddr));
    await work.deposit(1_234n);
    const everCreated = await vaultOutputHistoryFrom(theChain()).everCreated(vaultAddr);
    const exact: CompanyRecords = { deposited: [{ token: toHex(GBP), value: 1_234n }], paid: [] };

    const stranger = await walkCompanyRecords({
      vault: vaultAddr, keys: [depositNonceKeyFor(releasedCompanyKey(SOMEBODY_ELSE, company), vaultAddr)],
      records: exact, everCreated, commitmentOf: vaultNoteCommitment,
    });
    expect(stranger.coins, 'RED WHEN: a deposit can be named without the depositor\'s words, so a guessed amount can be confirmed against the chain').toEqual([]);

    const rounded = await walkCompanyRecords({
      vault: vaultAddr, keys: [depositNonceKeyFor(releasedCompanyKey(WORDS, company), vaultAddr)],
      records: { deposited: [{ token: toHex(GBP), value: 1_230n }], paid: [] }, everCreated, commitmentOf: vaultNoteCommitment,
    });
    expect(rounded.coins, 'RED WHEN: an amount that is not the one deposited names a coin').toEqual([]);
    const said = reconcileVaultPool({
      vault: vaultAddr, chain: chainNotes(), versions: [], named: rounded.coins,
      attempted: { deposits: [{ nonce: toHex(bytes(1)), token: toHex(GBP), value: 1n }], payments: [] },
      circuits: vaultCircuits,
    });
    expect(said.unexplained, 'RED WHEN: a note nothing names is dropped silently instead of reported').toHaveLength(1);
    expect(said.held).toEqual([]);
  });

  it('A NOTE MADE WITH A RANDOM NONCE IS NAMED BY ITS JOURNAL AND BY NOTHING ELSE, and is left exactly as it is', async () => {
    const work = await aCompanyAtWork(depositNonceKeyFor(releasedCompanyKey(WORDS, company), vaultAddr));
    const legacy = { nonce: toHex(randomBytes(32)), token: toHex(GBP), value: 900n };
    const r = await vault.impureCircuits.deposit(ctx('deposit'), {
      nonce: fromHex(legacy.nonce), color: fromHex(legacy.token), value: legacy.value,
    });
    vaultState = r.context.callContext.currentQueryContext.state;
    logCall(r);
    await work.deposit(900n);

    const everCreated = await vaultOutputHistoryFrom(theChain()).everCreated(vaultAddr);
    const walk = await walkCompanyRecords({
      vault: vaultAddr, keys: [depositNonceKeyFor(releasedCompanyKey(WORDS, company), vaultAddr)],
      records: { deposited: [{ token: toHex(GBP), value: 900n }], paid: [] }, everCreated, commitmentOf: vaultNoteCommitment,
    });
    const fromRecords = reconcileVaultPool({ vault: vaultAddr, chain: chainNotes(), versions: [], named: walk.coins, circuits: vaultCircuits });
    expect(fromRecords.held, 'the derived deposit is named').toHaveLength(1);
    expect(fromRecords.unexplained, 'RED WHEN: a random nonce is claimed to be nameable from the records').toEqual([held(legacy)]);

    const withTheJournal = reconcileVaultPool({
      vault: vaultAddr, chain: chainNotes(), versions: [], named: walk.coins,
      attempted: { deposits: [legacy], payments: [] }, circuits: vaultCircuits,
    });
    expect(withTheJournal.unexplained, 'RED WHEN: the journal stops naming a note only it can name').toEqual([]);
    expect(withTheJournal.held.find((n) => n.nonce === legacy.nonce)?.value).toBe(900n);
  });
});
