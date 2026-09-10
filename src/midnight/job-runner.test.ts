/**
 * The Midnight job runner. Decision 0008, M-82.
 *
 * The claims under test are the ones that cost money if they are wrong:
 * that nothing reaches the chain during proving, that balancing happens late
 * enough not to expire, and that recovery never guesses where a guess could
 * duplicate a payment or a signer.
 *
 * The SDK is faked here. That is honest rather than convenient: this file is
 * about the ORDER and the DECISIONS, and a live run is the only thing that can
 * check the calls themselves — which is why M-82 is not closed by these passing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MidnightJobRunner, expectationFor, type JobRunnerDeps } from './job-runner.js';
import type { Job } from '../core/jobs.js';
import type { LedgerStatus } from '../core/ledger.js';
import { viewDigestOf } from '../core/ledger.js';
import type { Hex } from '../core/crypto.js';

/*
 * The SDK is mocked, because the real `createCallTxOptions` rejects a fake
 * contract address before anything interesting happens.
 *
 * That matters more than it sounds: an earlier version of this file asserted
 * "proving never submits" against a `prove` that threw on its FIRST SDK call,
 * so the assertion could not have failed however wrong the code was. Same shape
 * as M-72 and as the vacuous correlation test in `jobs-worker`. With the SDK
 * mocked, `prove` runs to completion and the assertions mean something.
 */
const sdk = {
  createCallTxOptions: vi.fn((_compiled: unknown, circuit: string, address: string, psId: string, _m: unknown, args: unknown[]) => ({
    circuitId: circuit, contractAddress: address, privateStateId: psId, args,
  })),
  createUnprovenCallTx: vi.fn(async () => ({
    private: { unprovenTx: 'UNPROVEN', newCoins: [] },
    public: {},
  })),
};
vi.mock('@midnight-ntwrk/midnight-js-contracts', () => sdk);

beforeEach(() => {
  sdk.createUnprovenCallTx.mockClear();
  sdk.createCallTxOptions.mockClear();
  sdk.createUnprovenCallTx.mockImplementation(async () => ({
    private: { unprovenTx: 'UNPROVEN', newCoins: [] },
    public: {},
  }));
});

/*
 * **THE DEFAULT KIND WAS `'execute'` AND IS NOW `'approve'`. `C292`.**
 *
 * `JobKind` no longer has `'execute'` — the account's balance ledger went and
 * the circuit with it — so a job of that kind is an unrecognised kind, which
 * `expectationFor` correctly treats as UNSAFE TO REDO. Left as the default it
 * would have quietly moved every test in this file onto the unsafe arm while
 * still reporting green about ordering and recovery.
 *
 * `'approve'` is the substitute because it is what those tests were actually
 * about: a durable job that is submitted, can be interrupted, and is safe to
 * redo because the CIRCUIT rejects the duplicate. None of the claims below —
 * nothing reaches the chain during proving, balancing happens last, recovery
 * never guesses — was ever a claim about a spend in particular.
 */
const job = (over: Partial<Job> = {}): Job => ({
  id: 'job_1',
  accountId: 'acc_1',
  kind: 'approve',
  state: 'submitting',
  signerId: 'sgn_1',
  payload: {},
  attempts: 1,
  createdAt: 'x',
  updatedAt: 'x',
  ...over,
});

/**
 * The proposal this job was built against.
 *
 * `round: 4` used to stand here, and an account had exactly one open proposal
 * at a time. Recovery asks about the proposal now, which is both narrower and
 * more accurate — under the round design an unrelated payment settling moved
 * the round and made this job look unrecoverable.
 */
const PROPOSAL = 'bb'.repeat(32) as Hex;

/**
 * TWO DIFFERENT ANSWERS FROM `viewDigestOf`, WHICH IS ALL THESE ARE FOR NOW.
 *
 * They used to be the on-chain balance map before and after a job's transition
 *, and `C292`/`S26` removed that map: `LedgerStatus.assets` survives on
 * the interface but BOTH implementations now answer `[]` and nothing can ever
 * put an entry in it (`src/core/ledger.ts:911`, `src/midnight/ledger.ts`
 * `readContractState`). So these are no longer a picture of anything the chain
 * holds.
 *
 * They are kept because the RULE they drive is not about a balance: `recover`
 * answers *settled* only on an exact match between what the chain reports and
 * what the job expected, and never on a guess. Feeding it a status whose digest
 * matches and one whose digest does not is the only way to exercise both sides
 * of that comparison, and the comparison is the property.
 *
 * **WHAT IS HONESTLY LOST, SAID HERE RATHER THAN LEFT TO BE DISCOVERED:** with
 * `assets` empty everywhere, `viewDigestOf(status.assets)` is one constant for
 * every account, so branch 1 of `recover` cannot fire in production. It is
 * exercised here and enforced by nothing there.
 */
const ASSETS_BEFORE = [{ key: 'aa'.repeat(32), commitment: 'cc'.repeat(32) }];
const ASSETS_AFTER = [{ key: 'aa'.repeat(32), commitment: 'dd'.repeat(32) }];
const LANDED = viewDigestOf(ASSETS_AFTER);

const status = (over: Partial<LedgerStatus> = {}): LedgerStatus => ({
  signerCount: 3,
  assets: ASSETS_BEFORE,
  openProposals: [{ id: PROPOSAL, change: 'ee'.repeat(32), approvals: 2 }],
  threshold: 2,
  /* Absence means inherit, so an account with no deliberate exception
   * reports an empty map and every vault is judged by `threshold` above. */
  vaultThresholds: [], movementCount: 0, retiredVaults: [], 
  ...over,
});

/**
 * How many times a bundle was asked to let go of an unspent booking.
 *
 * Counted rather than ignored: `submit` releases in a `finally`, so a double
 * that swallowed the call would let the release be deleted without a single
 * case noticing - which is the shape of defect this change is carrying rows for.
 */
let released = 0;
beforeEach(() => { released = 0; });

const deps = (over: Partial<JobRunnerDeps> = {}): JobRunnerDeps => ({
  providers: {
    releaseUnspent: async () => { released += 1; return 0; },
    proofProvider: { proveTx: async () => 'PROVEN' },
    walletProvider: { balanceTx: async () => 'FINALISED' },
    midnightProvider: { submitTx: async () => 'tx_1' },
  },
  compiled: {},
  plan: async () => ({
    contractAddress: '0xcontract',
    // `'execute'` stood here and went with the circuit. What is
    // under test is the ORDER of prove/balance/submit, which no circuit name
    // changes — but a name the contract does not declare is a fixture lying
    // about the product, which is the one thing a fake must never do.
    circuit: 'approve',
    args: [],
    privateStateId: 'ps_acc_1',
  }),
  status: async () => status(),
  expectation: async () => ({ viewDigest: null, proposalId: null, duplicateRejectedOnChain: true }),
  ...over,
});

describe('submit', () => {
  it('balances and then submits, in that order', async () => {
    const order: string[] = [];
    const runner = new MidnightJobRunner(
      deps({
        providers: {
          releaseUnspent: async () => { released += 1; return 0; },
          proofProvider: { proveTx: async () => 'PROVEN' },
          walletProvider: {
            balanceTx: async () => {
              order.push('balance');
              return 'FINALISED';
            },
          },
          midnightProvider: {
            submitTx: async (tx) => {
              order.push('submit');
              expect(tx).toBe('FINALISED'); // the BALANCED one, not the proven one
              return 'tx_1';
            },
          },
        },
      }),
    );
    const out = await runner.submit(job(), { plan: {}, provenTx: 'PROVEN' });
    expect(order).toEqual(['balance', 'submit']);
    expect(out.txRef).toBe('tx_1');
  });

  it('balances at SUBMIT time, not at prove time, because a balance expires', async () => {
    /*
     * `balanceTx` takes a ttl. A job that balanced during proving and then sat
     * in `proven` behind a slow job — or through a closed laptop — would submit
     * a transaction that had already expired, and the failure would look like a
     * network problem rather than a design one.
     */
    const balanceTx = vi.fn(async () => 'FINALISED');
    const runner = new MidnightJobRunner(
      deps({
        providers: {
          releaseUnspent: async () => { released += 1; return 0; },
          proofProvider: { proveTx: async () => 'PROVEN' },
          walletProvider: { balanceTx },
          midnightProvider: { submitTx: async () => 'tx_1' },
        },
      }),
    );

    await runner.prove(job());
    expect(balanceTx).not.toHaveBeenCalled();

    await runner.submit(job(), { plan: {}, provenTx: 'PROVEN' });
    expect(balanceTx).toHaveBeenCalledOnce();
  });

  it('gives the balancer a ttl in the future', async () => {
    let seen: Date | undefined;
    const runner = new MidnightJobRunner(
      deps({
        now: () => new Date('2026-08-13T00:00:00.000Z'),
        ttlMinutes: 20,
        providers: {
          releaseUnspent: async () => { released += 1; return 0; },
          proofProvider: { proveTx: async () => 'PROVEN' },
          walletProvider: {
            balanceTx: async (_tx, ttl) => {
              seen = ttl;
              return 'FINALISED';
            },
          },
          midnightProvider: { submitTx: async () => 'tx_1' },
        },
      }),
    );
    await runner.submit(job(), { plan: {}, provenTx: 'PROVEN' });
    expect(seen!.toISOString()).toBe('2026-08-13T00:20:00.000Z');
  });

  it('refuses to submit without a proof rather than sending something empty', async () => {
    const runner = new MidnightJobRunner(deps());
    await expect(runner.submit(job(), undefined)).rejects.toThrow(/no proof in hand/);
  });

  it('treats a missing transaction id as a failure, not a success', async () => {
    // A job marked settled with no txRef is unrecoverable later: there is
    // nothing to look up and nothing to show a person.
    const runner = new MidnightJobRunner(
      deps({
        providers: {
          releaseUnspent: async () => { released += 1; return 0; },
          proofProvider: { proveTx: async () => 'PROVEN' },
          walletProvider: { balanceTx: async () => 'FINALISED' },
          midnightProvider: { submitTx: async () => '' },
        },
      }),
    );
    await expect(runner.submit(job(), { plan: {}, provenTx: 'P' })).rejects.toThrow(/no transaction id/);
  });
});

describe('recover', () => {
  it('says settled when the chain already holds the state this job meant to write', async () => {
    // The strongest answer available, and it needs no memory of the transaction.
    // The comparison is a digest over the whole balance map, because M-125 left
    // no single commitment to compare and M-128 no entry digest either.
    const runner = new MidnightJobRunner(
      deps({
        status: async () => status({ assets: ASSETS_AFTER }),
        expectation: async () => ({ viewDigest: LANDED, proposalId: null, duplicateRejectedOnChain: true }),
      }),
    );
    expect(await runner.recover(job({ txRef: 'tx_maybe' }))).toEqual({
      settled: true,
      txRef: 'tx_maybe',
    });
  });

  it('is not fooled by a view digest that is merely different', async () => {
    const runner = new MidnightJobRunner(
      deps({
        status: async () => status({ assets: ASSETS_BEFORE }),
        expectation: async () => ({ viewDigest: LANDED, proposalId: null, duplicateRejectedOnChain: true }),
      }),
    );
    expect(await runner.recover(job())).toBeNull();
  });

  it('refuses when the proposal this job was built against is no longer open', async () => {
    /*
     * The proposal closing might have been this transaction or another — it
     * either settled or was cancelled and nothing observable says which. Saying
     * "settled" would tell someone a payment went out that may not have; saying
     * "retry" would rebuild against a proposal that no longer exists.
     *
     * This replaced "the round has moved past the one this job was built
     * against". Narrower on purpose: under the round design an
     * unrelated payment settling rotated the round and triggered this branch
     * for a job that was still perfectly applicable.
     */
    const runner = new MidnightJobRunner(
      deps({
        status: async () => status({ openProposals: [] }),
        expectation: async () => ({ viewDigest: LANDED, proposalId: PROPOSAL, duplicateRejectedOnChain: true }),
      }),
    );
    await expect(runner.recover(job())).rejects.toThrow(/no longer open on the account/);
  });

  it('is not disturbed by somebody ELSE\'s proposal settling', async () => {
    /*
     * The other half of M-128, and the reason the question is asked about one
     * proposal rather than the account. Payroll and a vendor invoice are open
     * at once; the invoice settles and disappears. This job is still exactly as
     * applicable as it was, so recovery must say "redo", not "a person must
     * look".
     */
    const runner = new MidnightJobRunner(
      deps({
        status: async () => status({
          openProposals: [{ id: PROPOSAL, change: 'ee'.repeat(32), approvals: 2 }],
        }),
        expectation: async () => ({ viewDigest: LANDED, proposalId: PROPOSAL, duplicateRejectedOnChain: true }),
      }),
    );
    expect(await runner.recover(job())).toBeNull();
  });

  it('allows a redo only where the CIRCUIT rejects a duplicate', async () => {
    /*
     * `approve` carries `assert(!approvals.member(nul))`, so a second attempt
     * fails on chain rather than counting twice. That is what makes returning
     * null safe here — not optimism about the network.
     */
    const runner = new MidnightJobRunner(
      deps({
        expectation: async () => ({
          viewDigest: null, proposalId: PROPOSAL, duplicateRejectedOnChain: true,
        }),
      }),
    );
    expect(await runner.recover(job({ kind: 'approve' }))).toBeNull();
  });

  it('REFUSES TO GUESS where there is no on-chain duplicate check', async () => {
    /*
     * THE ONE THAT MATTERS. Bootstrap `addSigner` has no guard, so a blind redo
     * inserts the same signer twice. The message has to say what to check,
     * because a person is about to do it.
     */
    const runner = new MidnightJobRunner(
      deps({
        expectation: async () => ({
          viewDigest: null,
          proposalId: null,
          duplicateRejectedOnChain: false,
          duplicateHazard: 'A second attempt would add the signer twice.',
        }),
      }),
    );
    await expect(runner.recover(job({ kind: 'addSigner' }))).rejects.toThrow(/add the signer twice/);
  });

  it('refuses rather than assuming, when the account has no state at all', async () => {
    const runner = new MidnightJobRunner(deps({ status: async () => null }));
    await expect(runner.recover(job())).rejects.toThrow(/no state on chain/);
  });

  it('never calls watchForTxData, because it cannot answer "no"', async () => {
    /*
     * The SDK's own docs say it waits indefinitely and asks implementations not
     * to add timeouts. Reading a timeout as "it never landed" is precisely the
     * guess decision 0008 exists to forbid, so the temptation is tested away.
     */
    const watchForTxData = vi.fn();
    const d = deps();
    (d.providers as any).publicDataProvider = { watchForTxData };
    const runner = new MidnightJobRunner(d);
    await runner.recover(job());
    expect(watchForTxData).not.toHaveBeenCalled();
  });
});

describe('expectationFor', () => {
  /*
   * `'execute'` WAS THE FOURTH NAME IN THIS LIST AND IS GONE.
   *
   * `JobKind` no longer declares it and `expectationFor` no longer has a case
   * for it, so it now falls to the `default` arm — UNSAFE to redo. Leaving it
   * in the list would assert the opposite of what the code does; moving it to
   * the unsafe test below would pin a name nothing can enqueue. The rule it
   * shared with the three that remain — *safe only where the circuit itself
   * rejects the duplicate* — is what those three still check.
   */
  it.each(['approve', 'propose', 'cancel'] as const)(
    '%s is safe to redo, because the circuit rejects a duplicate',
    (kind) => {
      expect(expectationFor(job({ kind }), PROPOSAL, null).duplicateRejectedOnChain).toBe(true);
    },
  );

  it('addSigner is NOT safe to redo, and says why', () => {
    /*
     * Read out of the circuit, not assumed. On the approved path `addSigner`
     * closes the round so a replay fails; on the bootstrap path it just inserts
     * and increments, with nothing stopping it twice. Which path applied
     * depends on `signerCount` at execution time, which is exactly what cannot
     * be observed afterwards — so both are treated as unsafe.
     */
    const e = expectationFor(job({ kind: 'addSigner' }), PROPOSAL, null);
    expect(e.duplicateRejectedOnChain).toBe(false);
    expect(e.duplicateHazard).toMatch(/twice/);
    expect(e.duplicateHazard).toMatch(/threshold/);
  });

  it('an unrecognised kind is unsafe, not safe', () => {
    // Being wrong in this direction costs a person a look at their account.
    // Being wrong in the other costs a duplicated payment.
    const e = expectationFor(job({ kind: 'somethingNew' as any }), PROPOSAL, null);
    expect(e.duplicateRejectedOnChain).toBe(false);
  });

  it('carries the intended view digest through when the caller supplies one', () => {
    /*
     * REPOINTED FROM `'execute'` ONTO `'approve'`.
     *
     * The rule is `expectationFor`'s, not the spend's: when the caller hands in
     * a digest the job was expected to produce, it must reach the expectation
     * intact ALONGSIDE the proposal id, so `recover` can compare rather than
     * guess. `approve`, `propose` and `cancel` share the one arm that carries
     * it, so the arm is still covered.
     *
     * The test's old name said "state-moving jobs", and no kind moves the
     * account's state any more. What decides the digest is whether the CALLER
     * supplied one, which is what the name says now.
     */
    const e = expectationFor(job({ kind: 'approve' }), PROPOSAL, LANDED);
    expect(e.viewDigest).toBe(LANDED);
    // And the proposal it was built against, which is what says whether it can
    // still be applied at all.
    expect(e.proposalId).toBe(PROPOSAL);
  });
});

describe('the split the whole design rests on', () => {
  it('proving touches neither the wallet nor the node', async () => {
    /*
     * If anything reached the chain during `prove`, a crash there would land in
     * `submitting` and demand recovery for something never sent — and
     * `jobs.ts` redoing an interrupted proof would become a double-spend.
     *
     * This only means anything because `prove` now runs to completion; see the
     * note on the mock at the top.
     */
    const balanceTx = vi.fn(async () => 'FINALISED');
    const submitTx = vi.fn(async () => 'tx_1');
    const runner = new MidnightJobRunner(
      deps({
        providers: {
          releaseUnspent: async () => { released += 1; return 0; },
          proofProvider: { proveTx: async () => 'PROVEN' },
          walletProvider: { balanceTx },
          midnightProvider: { submitTx },
        },
      }),
    );
    const { proof } = await runner.prove(job());
    expect((proof as any).provenTx).toBe('PROVEN');
    expect(balanceTx).not.toHaveBeenCalled();
    expect(submitTx).not.toHaveBeenCalled();
  });

  it('proves the transaction the builder produced, not something else', async () => {
    const proveTx = vi.fn(async () => 'PROVEN');
    const runner = new MidnightJobRunner(
      deps({
        providers: {
          releaseUnspent: async () => { released += 1; return 0; },
          proofProvider: { proveTx },
          walletProvider: { balanceTx: async () => 'F' },
          midnightProvider: { submitTx: async () => 't' },
        },
      }),
    );
    await runner.prove(job());
    expect(proveTx).toHaveBeenCalledWith('UNPROVEN');
  });

  it('passes the plan through to the SDK unchanged', async () => {
    // The circuit name and the private state id are what decide which witnesses
    // the circuit reads. Getting either wrong is an M-27-shaped failure.
    const runner = new MidnightJobRunner(
      deps({
        plan: async () => ({
          contractAddress: '0xcontract',
          circuit: 'approve',
          args: [1, 2],
          privateStateId: 'ps_acc_9',
        }),
      }),
    );
    await runner.prove(job());
    expect(sdk.createCallTxOptions).toHaveBeenCalledWith(
      expect.anything(), 'approve', '0xcontract', 'ps_acc_9', undefined, [1, 2],
    );
  });

  it('says what is wrong when the build produces nothing to prove', async () => {
    /*
     * This is what a missing private-state staging looks like from here: the
     * circuit ran and produced no transaction. The message names the likely
     * cause because the alternative is an undefined dereference inside the
     * prover.
     */
    sdk.createUnprovenCallTx.mockImplementation(async () => ({ private: {}, public: {} }) as any);
    const proveTx = vi.fn(async () => 'PROVEN');
    const runner = new MidnightJobRunner(
      deps({
        providers: {
          releaseUnspent: async () => { released += 1; return 0; },
          proofProvider: { proveTx },
          walletProvider: { balanceTx: async () => 'F' },
          midnightProvider: { submitTx: async () => 't' },
        },
      }),
    );
    await expect(runner.prove(job())).rejects.toThrow(/no transaction to prove/);
    expect(proveTx).not.toHaveBeenCalled();
  });

  it('keeps the proof out of anything that gets stored', async () => {
    /*
     * Decision 0008 says proofs are not persisted because they are large and
     * reproducible. The SDK says the same for a stronger reason: the unproven
     * transaction carries the ZK inputs and the next private state, and is
     * marked not-for-serialising. The job record must stay clean.
     */
    const runner = new MidnightJobRunner(deps());
    const j = job();
    await runner.prove(j);
    expect(JSON.stringify(j)).not.toMatch(/UNPROVEN|PROVEN/);
  });

  it('plans before proving, so an impossible job fails in a second not eighty', async () => {
    const proveTx = vi.fn(async () => 'PROVEN');
    const runner = new MidnightJobRunner(
      deps({
        plan: async () => {
          throw new Error('there is no open proposal on this account');
        },
        providers: {
          releaseUnspent: async () => { released += 1; return 0; },
          proofProvider: { proveTx },
          walletProvider: { balanceTx: async () => 'F' },
          midnightProvider: { submitTx: async () => 't' },
        },
      }),
    );
    await expect(runner.prove(job())).rejects.toThrow(/no open proposal/);
    expect(proveTx).not.toHaveBeenCalled();
  });
});
