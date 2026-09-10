/**
 * **THE CHAIN SET REFUSES A WRITE WITHOUT TOUCHING THE LEDGER UNDERNEATH.**
 *
 * The property being pinned is not "a write fails" — a write would fail anyway,
 * for want of a wallet, several layers down. It is that the failure happens
 * ABOVE the ledger, so that nothing is staged on the way to it.
 *
 * Why that distinction is the whole test: raising a round stages a proposal
 * salt into the device's private state before the transaction is built. A
 * failure after that step leaves the device holding a salt for a round that was
 * never raised, and the next governance change recomputes an already-approved
 * round's identity from it and refuses about the wrong thing. That governance
 * round is then
 * unapplicable from that device for good. **A refusal one layer higher costs a
 * sentence; a refusal one layer lower costs a round that reached its
 * threshold.**
 *
 * So the inner ledger here is a recorder that throws if it is called at all,
 * and every write case asserts the recorder stayed empty.
 */
import { describe, it, expect } from 'vitest';
import { ChainLedger } from './chain.js';
import type { Deployment } from './deployment.js';
import type { WriteCapability } from './write-capability.js';

const DEPLOYMENT: Deployment = {
  network: 'stagenet',
  contractAddress: 'bcb61fef',
  indexerUrl: 'https://indexer.example/api/v4/graphql',
  indexerWsUrl: 'wss://indexer.example/api/v4/graphql/ws',
  nodeUrl: 'https://rpc.example',
  proverUrl: 'http://prover.invalid:1',
  sealedStateRoot: '/nowhere/.midnight/sealed',
  privateStateId: 'confidential-accounts-stagenet',
  zkConfigPath: '/nowhere/contracts/managed',
};

/**
 * A deployment that holds everything writing needs.
 *
 * Nothing here is real and nothing needs to be: what decides whether a write
 * refuses or is delegated is whether this object exists and is whole, and that
 * is deliberately the only question the boundary asks. A real one is a funded
 * wallet, and a case that needed one would be a case nobody runs.
 */
const CAPABLE: WriteCapability = {
  maintenanceAuthority: { kind: 'unmaintainable' },
  compiled: { it: 'is here' },
  /*
   * **NOT `{}`, AND THAT IS THE POINT OF THESE SIX LINES.** Both members used
   * to be empty objects here, and the rule accepted them - so the fixture was
   * asserting that a deployment holding nothing where the wallet and the fee
   * payer go could write. The members are the ones the write path actually
   * calls; nothing behind them is real, and nothing needs to be.
   */
  customer: {
    coinPublicKey: () => 'not-a-secret: a test literal',
    encryptionPublicKey: () => 'not-a-secret: a test literal',
    balanceOwnLegs: async (tx: unknown) => tx,
    release: async () => {},
  } as WriteCapability['customer'],
  sponsor: {
    addFeeAndFinalise: async (tx: unknown) => tx,
    submit: async () => ({ ref: 'tx', at: '' }),
    release: async () => {},
    payingFor: () => {},
    capacity: async () => ({ dust: 0n, night: 0n }),
  } as WriteCapability['sponsor'],
  storagePassword: async () => 'not-a-secret: a test literal',
};

/** Records every call, and answers reads. A write reaching it is the defect. */
const recorder = (capability?: WriteCapability) => {
  const calls: string[] = [];
  const inner: any = new Proxy({}, {
    get: (_t, prop: string) => (...args: unknown[]) => {
      calls.push(prop);
      if (prop === 'status') return Promise.resolve(null);
      if (prop === 'address') return Promise.resolve({ value: 'bcb61fef', source: 'chain' });
      if (prop === 'paidAmong') return Promise.resolve({ known: true, paid: [] });
      if (prop === 'fetch') return Promise.resolve(null);
      if (prop === 'reseal') return Promise.resolve(undefined);
      return Promise.resolve({ txRef: 'SHOULD-NOT-HAPPEN', args });
    },
  });
  return { calls, ledger: new ChainLedger(inner, DEPLOYMENT, capability) };
};

const WRITES: ReadonlyArray<[string, (l: ChainLedger) => Promise<unknown>]> = [
  ['open',              l => l.open('a', {} as never)],
  ['propose',           l => (l as any).propose('a', {} as never, {} as never)],
  ['proposeRun',        l => (l as any).proposeRun('a', {} as never, {} as never)],
  ['approve',           l => l.approve('a', '0x1' as never, {} as never)],
  ['cancel',            l => l.cancel('a', '0x1' as never, {} as never)],
  ['addSigner',         l => l.addSigner('a', '0x1' as never, null, {} as never)],
  ['removeSigner',      l => l.removeSigner('a', '0x1' as never, '0x2' as never, {} as never)],
  ['setThreshold',      l => (l as any).setThreshold('a', 2, '0x1', {})],
  ['setVaultThreshold', l => (l as any).setVaultThreshold('a', '0x1', 2, '0x2', {})],
];

describe('the chain wiring refuses a write above the ledger', () => {
  /*
   * RED WHEN: any write method in `ChainLedger` is changed to delegate to
   * `this.inner`. Watched, per method, by delegating each one in turn on a copy
   * outside this repository: the case for that method fails on `calls`.
   */
  for (const [name, call] of WRITES) {
    it(`${name} refuses, and the ledger underneath is never called`, async () => {
      const { calls, ledger } = recorder();
      await expect(call(ledger)).rejects.toThrow(/cannot write to it/);
      expect(calls, `${name} reached the ledger before refusing`).toEqual([]);
    });
  }

  /*
   * RED WHEN: the refusal is reworded to name a thing to run rather than the
   * state that resolves it. An operator holding this sentence has to be able to
   * tell "this is broken" from "this deployment was built to watch".
   */
  it('the refusal says what is missing, not what to type', async () => {
    const { ledger } = recorder();
    const message = await ledger.open('a', {} as never).then(
      () => 'it did not refuse', (e: Error) => e.message);
    /*
     * It names the pieces this deployment has not got rather than the general
     * fact that it has not got them - so an operator short of one thing is not
     * handed the same paragraph as one short of five.
     */
    expect(message).toMatch(/no wallet is wired/);
    expect(message).toMatch(/nothing is wired to pay the transaction fee/);
    /* And it says what still works, so "broken" and "built to watch" come apart. */
    expect(message).toMatch(/Reading an account, its balances and its open rounds works/);
    /* Names a state, not a thing to type. */
    expect(message).not.toMatch(/\.command|npm run|MIDNIGHT_/);
  });

  /*
   * RED WHEN: a read is refused too. Refusing reads buys no safety and costs
   * the whole reason this set exists.
   */
  it('reads are delegated whole', async () => {
    const { calls, ledger } = recorder();
    await ledger.status('a');
    await ledger.address('a');
    await ledger.paidAmong('a', []);
    await ledger.fetch('a', 0);
    await ledger.reseal('a', {} as never);
    expect(calls).toEqual(['status', 'address', 'paidAmong', 'fetch', 'reseal']);
  });

  /*
   * **AN UNANSWERED READ IS NOT TURNED INTO AN ANSWER.**
   *
   * RED WHEN: `status` is changed to repair a `null` into an empty status —
   * which is the obvious-looking repair, because an empty status is what every
   * screen would rather have than a null. It is also the one that lets a caller
   * close a record the chain still holds.
   *
   * The earlier version of this asserted only that `status` returned null when
   * the stub returned null, under a comment claiming it pinned "could not ask".
   * It pinned no such thing — the two meanings are not separated at this
   * boundary at all — and an assertion whose comment claims more than it checks
   * is worse than no assertion. This one checks what is actually true: the
   * wrapper passes the ledger's answer through, whatever it is, and a rejection
   * stays a rejection rather than becoming a null.
   */
  it('passes an unanswered read through rather than repairing it', async () => {
    const { ledger } = recorder();
    expect(await ledger.status('a')).toBeNull();
  });

  it('a chain read that rejects stays a rejection and does not become a null', async () => {
    const inner: any = { status: () => Promise.reject(new Error('indexer unreachable')) };
    const ledger = new ChainLedger(inner, DEPLOYMENT);
    await expect(ledger.status('a')).rejects.toThrow(/indexer unreachable/);
  });

  /*
   * RED WHEN: `describe()` is delegated to the ledger underneath, whose own
   * sentence ends "fees sponsored" — a claim about a component this deployment
   * has not got.
   */
  it('describes what is running and claims no sponsorship', async () => {
    const { ledger } = recorder();
    expect(ledger.describe()).toContain('read-only');
    expect(ledger.describe()).not.toContain('sponsored');
    expect(ledger.describe()).toContain('stagenet');
  });

  /*
   * **AND THE SENTENCE MOVES WHEN THE DEPLOYMENT DOES.**
   *
   * RED WHEN: `describe()` says read-only whatever this deployment holds. That
   * is the half a fixed string passes: an operator on a deployment that CAN
   * write would be told it cannot, on the one line the health route prints.
   */
  it('a deployment that can write does not describe itself as read-only', async () => {
    const { ledger } = recorder(CAPABLE);
    expect(ledger.describe()).not.toContain('read-only');
    expect(ledger.describe()).toContain('reading and writing');
    expect(ledger.describe()).toContain('stagenet');
  });
});

/**
 * **THE POSITIVE CONTROL, AND IT IS THE HALF THAT WAS MISSING.**
 *
 * Every case above passes against a boundary that refuses every write for ever
 * - which is what this one did. So each of them is paired here with the same
 * call on a deployment that holds what writing needs, and the pair is what
 * makes either assertion mean anything: **the refusal has to be caused by the
 * absence, not by the method.**
 */
describe('and a deployment that can write is not stopped here', () => {
  for (const [name, call] of WRITES) {
    /*
     * RED WHEN: a write method refuses whatever the deployment holds - which is
     * the state this file pinned before there was anything to pin against, and
     * the state a boundary falls back into the moment somebody re-adds an
     * unconditional refusal "to be safe".
     */
    it(`${name} is delegated whole`, async () => {
      const { calls, ledger } = recorder(CAPABLE);
      await call(ledger);
      expect(calls, `${name} did not reach the ledger`).toEqual([name]);
    });
  }

  /*
   * **EVERY WRITE SAYS WHOSE TRANSACTION IT IS, AND THIS IS THE LAST LAYER
   * THAT KNOWS.**
   *
   * What the fee payer is handed is a bound, shielded transaction. Whose it is
   * cannot be read off it, off a receipt or off the chain, so the answer exists
   * for exactly as long as this call frame does - and a fee payer that pays for
   * whatever arrives has discarded it before anybody thinks to ask.
   *
   * RED WHEN: `payingFor` is dropped from `write`, or is called with anything
   * but the account the write is about. Both go unnoticed everywhere else: no
   * write changes, no refusal changes, and the only symptom is a record that
   * cannot be billed, audited or explained a month later.
   */
  it('names the company to the fee payer, on every one of the nine writes', async () => {
    for (const [name, call] of WRITES) {
      const named: string[] = [];
      const capability: WriteCapability = {
        ...CAPABLE,
        sponsor: { ...CAPABLE.sponsor, payingFor: (id: string) => { named.push(id); } },
      };
      const inner: any = new Proxy({}, {
        get: () => () => Promise.resolve({ ref: 'x' }),
      });
      await call(new ChainLedger(inner, DEPLOYMENT, capability));
      expect(named, `${name} paid for a company it never named`).toEqual(['a']);
    }
  });

  /*
   * **AND IT IS TOLD BEFORE THE WORK STARTS, NOT AFTER IT.**
   *
   * The fee payer reads the company at the moment it records a payment, which
   * happens inside the call below. Told afterwards, every record carries the
   * PREVIOUS company - which is worse than an empty one, because nothing
   * distinguishes it from a right answer.
   *
   * RED WHEN: the `payingFor` call is moved below `go()`.
   */
  it('and it is told before the ledger is reached, not after', async () => {
    const order: string[] = [];
    const capability: WriteCapability = {
      ...CAPABLE,
      sponsor: { ...CAPABLE.sponsor, payingFor: () => { order.push('named'); } },
    };
    const inner: any = new Proxy({}, {
      get: () => () => { order.push('reached the ledger'); return Promise.resolve({ ref: 'x' }); },
    });
    await new ChainLedger(inner, DEPLOYMENT, capability).open('a', {} as never);
    expect(order).toEqual(['named', 'reached the ledger']);
  });

  /*
   * **A REFUSED WRITE NAMES NOBODY.**
   *
   * A deployment that cannot write has nothing to attribute, and telling a fee
   * payer it is about to pay for a company when no transaction will exist
   * leaves a company name standing against whatever the NEXT deployment does
   * pay for.
   *
   * RED WHEN: the `payingFor` call is moved above the `cannotWrite` check.
   */
  it('a write that is refused tells the fee payer nothing', async () => {
    const named: string[] = [];
    const capability = {
      ...CAPABLE,
      sponsor: { ...CAPABLE.sponsor, payingFor: (id: string) => { named.push(id); } },
      // short of one piece, so every write refuses
      compiled: undefined,
    } as unknown as WriteCapability;
    const inner: any = new Proxy({}, { get: () => () => Promise.resolve({ ref: 'x' }) });
    await expect(new ChainLedger(inner, DEPLOYMENT, capability).open('a', {} as never))
      .rejects.toThrow(/cannot write to it/);
    expect(named, 'a deployment that cannot pay said whose transaction it was paying for')
      .toEqual([]);
  });

  /*
   * **AND THE ARGUMENTS ARRIVE UNCHANGED.**
   *
   * RED WHEN: a delegated write drops, reorders or invents an argument. A
   * wrapper that forwards the call and not its arguments is green on every case
   * above: the ledger is reached, so the refusal is gone, and the transaction
   * is about something else.
   */
  it('a delegated write carries its arguments through untouched', async () => {
    const seen: unknown[][] = [];
    const inner: any = new Proxy({}, {
      get: () => (...args: unknown[]) => { seen.push(args); return Promise.resolve({ ref: 'x' }); },
    });
    const ledger = new ChainLedger(inner, DEPLOYMENT, CAPABLE);
    const by = { signerId: 'sgn_1', leaf: '0xleaf' } as never;

    await ledger.approve('acc_1', '0xprop' as never, by);
    expect(seen[0]).toEqual(['acc_1', '0xprop', by]);

    await ledger.addSigner('acc_2', '0xnew' as never, '0xprop2' as never, by);
    expect(seen[1]).toEqual(['acc_2', '0xnew', '0xprop2', by]);

    await ledger.removeSigner('acc_3', '0xold' as never, '0xprop3' as never, by);
    expect(seen[2]).toEqual(['acc_3', '0xold', '0xprop3', by]);

    /*
     * **`cancel` IS HERE BECAUSE IT IS THE ONE THAT CAN BE TRANSPOSED IN
     * SILENCE.** An account id and a proposal id are both plain strings, so
     * swapping them typechecks - and this was the only hand-written delegation
     * whose two same-typed arguments nothing pinned. Measured: transposing them
     * left every other case in this file green. `cancel` is what closes an open
     * round, and an account may hold only one at a time, so a broken one is an
     * account that cannot un-wedge itself.
     */
    await ledger.cancel('acc_4', '0xprop4' as never, by);
    expect(seen[3]).toEqual(['acc_4', '0xprop4', by]);
  });
});
