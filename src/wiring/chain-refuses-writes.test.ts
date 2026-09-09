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
import { ChainLedger, agreedAddress } from './chain.js';
import type { Deployment } from './deployment.js';

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

/** Records every call, and answers reads. A write reaching it is the defect. */
const recorder = () => {
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
  return { calls, ledger: new ChainLedger(inner, DEPLOYMENT) };
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
    expect(message).toMatch(/no funded wallet is wired/);
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
   * **THE RECORDED CONTRACT ADDRESS IS LOAD-BEARING, NOT DECORATION.**
   *
   * RED WHEN: `chainLedger` goes back to passing `addressOf` straight through.
   * Watched red that way on a copy outside this repository. Without the check
   * the deployment record's address is validated on the way past and then never
   * used, and every read resolves its contract from the product's own row
   * instead — so the two can drift and nothing says so.
   */
  it('refuses an account recorded against a different contract', () => {
    expect(() => agreedAddress('a', 'a-different-contract', DEPLOYMENT))
      .toThrow(/recorded against contract a-different-contract.*built against bcb61fef/s);
  });

  it('allows the contract this deployment was built against', () => {
    expect(agreedAddress('a', DEPLOYMENT.contractAddress, DEPLOYMENT))
      .toBe(DEPLOYMENT.contractAddress);
  });

  /*
   * An account with no address yet is not a disagreement - it is an account
   * that has not been deployed. Refusing it would stop the product ever
   * reporting that, which is the answer the caller needs.
   */
  it('lets a not-yet-deployed account through as null', () => {
    expect(agreedAddress('a', null, DEPLOYMENT)).toBeNull();
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
});
