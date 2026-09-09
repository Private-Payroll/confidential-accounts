/**
 * **WHAT THE PRODUCT DOES WHEN IT HAS NOT BEEN TOLD WHICH CHAIN IT IS ON.**
 *
 * The selection is the chain and there is no other mode to fall back to, so
 * every deployment now has four facts it must be given and cannot guess: the
 * address of the deployed contract, an indexer, a node, and a proof server.
 * **The question this file answers is what a person sees when one of them is
 * absent**, because that is the moment at which a product either says something
 * useful or prints its own insides.
 *
 * ── THE THREE FAILURES IT IS POINTED AT ──────────────────────────────────
 *
 * **A STACK TRACE.** Somebody configuring a deployment is handed a description
 * of this program's internals and no sentence about what to supply.
 *
 * **A SILENT FALLBACK.** The process comes up, serves, and answers questions
 * about accounts that are not there. There is nothing to fall back TO any more,
 * and this file is where that is checked rather than asserted.
 *
 * **A HALF START.** The process listens and refuses every request. To whoever
 * pointed a browser at it that reads as a broken product; to whoever deployed
 * it, as a working one. Both readings cost money, so the process exits instead.
 *
 * ── AND THE RULES ARE PURE SO THEY CAN BE EXERCISED WITHOUT A DEPLOYMENT ──
 *
 * `startupRefusal` takes a thrown value and returns text; `assembleFor` takes a
 * resolved deployment. Neither needs a filesystem, a network or a process, so
 * every case below names the change that turns it red and can plant that change
 * in an argument rather than in this repository.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startProduct, startupRefusal, assembleFor, unconfiguredLedger,
  unconfiguredProofSystem, unconfiguredWiring, halvesDisagree, CANNOT_START,
} from './product.js';
import { ContractBook } from './account-contract.js';
import { wiring } from './selection.js';
import { deploymentRecordPath, type Deployment } from './deployment.js';
import { networkOfThePair } from '../midnight/network.js';

/** The network this pair is compiled for. Read, never spelled out here. */
const NETWORK = networkOfThePair(undefined);

/** A deployment that is complete and points at nothing reachable. */
const FACTS: Deployment = {
  network: NETWORK,
  contractAddress: '0200aabb',
  indexerUrl: 'https://indexer.invalid/api/v1/graphql',
  indexerWsUrl: 'wss://indexer.invalid/api/v1/graphql/ws',
  nodeUrl: 'https://node.invalid',
  proverUrl: 'http://127.0.0.1:1',   // not-a-secret: a port nothing listens on
  sealedStateRoot: join(tmpdir(), 'mn-s97-sealed'),
  privateStateId: 'confidential-accounts-test',
  zkConfigPath: join(tmpdir(), 'mn-s97-zk'),
};

/**
 * A book over a store with nothing in it. Every account resolves to no
 * contract, which is what an account nobody has opened looks like.
 */
const noAddress = new ContractBook(() => null, 'chain');

describe('what a person is told when there is no deployment', () => {
  /**
   * **NO STACK, AND THE REASON IT IS ASSERTED RATHER THAN TRUSTED.**
   *
   * An `Error`'s `stack` BEGINS with its own message, so a formatter that
   * reached for `.stack` would still produce something that starts correctly
   * and then runs on into this program's internals. Reading the message alone
   * looks identical in the passing case and is the whole of the difference in
   * the failing one.
   *
   * Turns red if the formatter is changed to carry `.stack`: built below as
   * an error whose stack contains a frame, with the assertion on the frame.
   */
  it('carries the cause and never the stack', () => {
    const e = new Error('the deployment record is not at /tmp/x/.midnight/y-contract.json');
    e.stack = `${e.message}\n    at somewhere (/src/wiring/product.ts:1:1)`;
    const text = startupRefusal(e);

    expect(text).toContain('the deployment record is not at /tmp/x/.midnight/y-contract.json');
    expect(text).not.toContain('at somewhere');
    expect(text).not.toContain('product.ts:1:1');
  });

  /**
   * **THE CAUSE IS QUOTED WHOLE AND NEVER SUMMARISED.** The sentences that
   * arrive here already name the missing fact and say why it has no default. A
   * layer that reworded them is a layer that will one day reword them wrongly,
   * and the reader would be looking for a file nobody named.
   */
  it('quotes the cause whole rather than summarising it', () => {
    const long = 'no proof server is configured, and there is deliberately no default, because '
      + 'a deployment that guesses wrong comes up looking healthy and fails at the first round.';
    expect(startupRefusal(new Error(long))).toContain(long);
  });

  /** Whatever was thrown, a person still gets words. */
  it('survives something that is not an Error', () => {
    expect(startupRefusal('a bare string')).toContain('a bare string');
    expect(startupRefusal(undefined)).toContain(CANNOT_START);
  });

  /**
   * **IT SAYS WHAT STATE FOLLOWED, AND THAT IS THE HALF A CAUSE CANNOT SAY.**
   * The cause explains what is missing. Only this says the process is not up
   * and is not half up - which is the reading that decides whether somebody
   * goes looking for a half-served product.
   */
  it('says that nothing was served and that there is no other mode', () => {
    const text = startupRefusal(new Error('anything'));
    expect(text).toContain(CANNOT_START);
    expect(text).toContain('nothing has been served');
    expect(text).toContain('no other mode to fall back to');
  });
});

describe('starting the product with nothing configured', () => {
  /**
   * The ordinary case, and the one a person actually meets: a directory with no
   * deployment record in it.
   *
   * **THE PATH IS IN THE SENTENCE.** A refusal that says a record is missing
   * without saying where it was looked for sends somebody to search a
   * filesystem, and the two candidate directories differ only by the network
   * name.
   */
  it('refuses, names the record it looked for, and hands back no chain ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'mn-s97-empty-'));
    const started = startProduct(noAddress, root, {});

    expect(started.started).toBe(false);
    if (started.started) return;

    expect(started.refusal).toContain(CANNOT_START);
    expect(started.refusal).toContain(deploymentRecordPath(root, NETWORK));
    expect(started.refusal).toContain(NETWORK);
  });

  /**
   * **AND A RECORD IS NOT ENOUGH ON ITS OWN.** With the address in place the
   * proof server is the next thing with no default, and the refusal has to move
   * on to it rather than reporting the problem that was just fixed.
   *
   * This is the case that catches a refusal wired to the first check only.
   */
  it('moves on to the next missing fact rather than repeating the first', () => {
    const root = mkdtempSync(join(tmpdir(), 'mn-s97-record-'));
    mkdirSync(join(root, '.midnight'), { recursive: true });
    writeFileSync(
      deploymentRecordPath(root, NETWORK),
      JSON.stringify({ network: NETWORK, contractAddress: '0200aabb' }),
    );

    const started = startProduct(noAddress, root, {});
    expect(started.started).toBe(false);
    if (started.started) return;

    expect(started.refusal).toContain('proof server');
    expect(started.refusal,
      'the refusal is still talking about the record, which is now present')
      .not.toContain('there is nothing for the product to talk to');
  });

  /**
   * **THE POSITIVE CONTROL: THE SAME CALL SUCCEEDS WHEN THE FACTS ARE THERE.**
   *
   * Without it every case above would also pass against a `startProduct` that
   * refused unconditionally, which is the shape of a guard that is really a
   * disabled feature. Nothing is dialled - the ledger's providers are a thunk,
   * so assembling a set needs no indexer, node or proof server to be reachable.
   */
  it('and it starts when the four facts are there', () => {
    const root = mkdtempSync(join(tmpdir(), 'mn-s97-full-'));
    mkdirSync(join(root, '.midnight'), { recursive: true });
    writeFileSync(
      deploymentRecordPath(root, NETWORK),
      JSON.stringify({ network: NETWORK, contractAddress: '0200aabb' }),
    );

    const started = startProduct(noAddress, root, { MIDNIGHT_PROVER_URL: 'http://127.0.0.1:1' });
    expect(started.started, started.started ? '' : started.refusal).toBe(true);
    if (!started.started) return;

    expect(started.deployment.contractAddress).toBe('0200aabb');
    expect(started.wiring.name).toBe('chain');
    /* One scheme, taken off the selector and never restated here. */
    expect(started.wiring.commitments).toBe(wiring().commitments);
  });
});

describe('the set a process holds when it could not resolve one', () => {
  const REFUSAL = 'this deployment has not been told which contract to talk to';

  /**
   * **EVERY QUESTION IS REFUSED BY NAME, AND NONE OF THEM ANSWERS EMPTY.**
   *
   * An empty answer is the dangerous shape: a company shown no rounds cannot
   * tell that from a company that has none. So the assertion is on every
   * member, and it is a rejection carrying the reason.
   */
  it('refuses every read and every write, and says why', async () => {
    const ledger = unconfiguredLedger(REFUSAL, 'chain');
    const calls: Array<[string, Promise<unknown>]> = [
      ['open', ledger.open('a', {} as never)],
      ['address', ledger.address('a')],
      ['status', ledger.status('a')],
      ['paidAmong', ledger.paidAmong('a', [])],
      ['fetch', ledger.fetch('a', 0)],
      ['reseal', ledger.reseal('a', {} as never)],
      ['propose', ledger.propose('a', '00' as never, {} as never, {} as never, '00' as never)],
      ['proposeRun', ledger.proposeRun('a', {} as never, {} as never, {} as never)],
      ['approve', ledger.approve('a', '00' as never, {} as never)],
      ['cancel', ledger.cancel('a', '00' as never, {} as never)],
      ['addSigner', ledger.addSigner('a', '00' as never, null, {} as never)],
      ['removeSigner', ledger.removeSigner('a', '00' as never, '00' as never, {} as never)],
      ['setThreshold', ledger.setThreshold('a', 2, '00' as never, {} as never)],
      ['setVaultThreshold', ledger.setVaultThreshold('a', '00' as never, 2, '00' as never, {} as never)],
    ];
    for (const [name, call] of calls) {
      await expect(call, `${name} did not refuse`).rejects.toThrow(REFUSAL);
    }
    expect(calls).toHaveLength(14);
  });

  /**
   * **A REJECTED PROMISE, NEVER A SYNCHRONOUS THROW**, for the reason the chain
   * ledger gives about its own refusals: a caller that wrote `.catch(...)` on a
   * method that throws before it returns does not catch anything, because the
   * exception comes out of the call rather than out of the promise. **A refusal
   * that escapes the caller's error handling is a refusal the product cannot
   * report** - it becomes a crash instead of a message on a screen.
   *
   * Turns red the moment any member is written to `throw` directly.
   */
  it('every member rejects, and none of them throws out of the call', async () => {
    const ledger = unconfiguredLedger(REFUSAL, 'chain');
    /*
     * **LAZY, AND THAT IS THE WHOLE POINT OF THIS CASE.** The case above builds
     * all fourteen promises in one array literal, so a member rewritten to
     * `throw` synchronously fails it during construction - which means that
     * case, not this one, was carrying the pin. Called one at a time here, each
     * member is asked the two questions separately: did the call return, and
     * did what it returned reject.
     *
     * RED WHEN: any member throws before returning (the first assertion), or
     * answers instead of refusing (the second). **An empty answer is the
     * dangerous shape** - a company shown no rounds cannot tell that from a
     * company that has none - so `resolves` is a failure here, not a pass.
     */
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['open', () => ledger.open('a', {} as never)],
      ['address', () => ledger.address('a')],
      ['status', () => ledger.status('a')],
      ['paidAmong', () => ledger.paidAmong('a', [])],
      ['fetch', () => ledger.fetch('a', 0)],
      ['reseal', () => ledger.reseal('a', {} as never)],
      ['propose', () => ledger.propose('a', '00' as never, {} as never, {} as never, '00' as never)],
      ['proposeRun', () => ledger.proposeRun('a', {} as never, {} as never, {} as never)],
      ['approve', () => ledger.approve('a', '00' as never, {} as never)],
      ['cancel', () => ledger.cancel('a', '00' as never, {} as never)],
      ['addSigner', () => ledger.addSigner('a', '00' as never, null, {} as never)],
      ['removeSigner', () => ledger.removeSigner('a', '00' as never, '00' as never, {} as never)],
      ['setThreshold', () => ledger.setThreshold('a', 2, '00' as never, {} as never)],
      ['setVaultThreshold', () => ledger.setVaultThreshold('a', '00' as never, 2, '00' as never, {} as never)],
    ];
    expect(calls, 'a member was added to the boundary and not to this list').toHaveLength(14);

    for (const [name, call] of calls) {
      let returned: Promise<unknown> | undefined;
      expect(() => { returned = call(); },
        `${name} threw out of the call instead of rejecting, so a caller's .catch does not see it`)
        .not.toThrow();
      await expect(returned!, `${name} answered instead of refusing`).rejects.toThrow(REFUSAL);
    }
  });

  /**
   * **AND THE ONE THING IT WILL NOT ANSWER AT ALL: WHICH LEDGER WROTE A
   * RECORD.**
   *
   * This getter is where a record's marker comes from. Returning the SELECTED
   * word here - `'chain'` - would stamp records with what was MEANT to be
   * running, by something that has never written anything. **A record falsely
   * marked as a chain's can never be unpicked afterwards**, where an unmarked
   * one at least reads as *not known*.
   *
   * RED WHEN: the getter answers a word instead of refusing. Watched by
   * returning the selected name, which is what it did when this was written.
   */
  it('refuses to say which ledger wrote a record, because it has written none', () => {
    const ledger = unconfiguredLedger(REFUSAL, 'chain');
    expect(() => ledger.wiring).toThrow(/cannot be answered/);
    expect(() => ledger.wiring).toThrow(/nothing has been written/);
  });

  it('describes itself as having no ledger rather than naming one', () => {
    expect(unconfiguredLedger(REFUSAL, 'chain').describe()).toContain('no ledger');
    expect(unconfiguredProofSystem(REFUSAL).describe()).toContain('no proof system');
  });

  /**
   * **THE COMMITMENT SCHEME IS STILL THE REAL ONE AND THAT IS DELIBERATE.**
   *
   * It needs no configuration, a device still derives its own seat with it, and
   * handing back a different scheme here would be the one thing the selector
   * exists to prevent: two schemes inside one product, which typechecks, boots
   * and says nothing until a proof is attempted on chain.
   */
  it('keeps the one commitment scheme even with nothing configured', () => {
    const w = unconfiguredWiring(REFUSAL);
    expect(w.commitments).toBe(wiring().commitments);
    expect(w.name).toBe(wiring().name);
  });
});

describe('the two halves cannot be assembled apart', () => {
  const scheme = { a: 1 };

  it('agrees when the scheme and the word are the same object and the same word', () => {
    expect(halvesDisagree(
      { name: 'chain', commitments: scheme },
      { name: 'chain', commitments: scheme },
    )).toBeNull();
  });

  /**
   * **THE PAGE WAS HANDED ONE SCHEME AND THE LEDGER WRITES UNDER ANOTHER.**
   *
   * This is the failure that is silent all the way to the chain: it typechecks,
   * it boots, it serves pages, and nothing says so until a proof is attempted -
   * by which point the leaves already written cannot be proved and the money
   * behind them cannot be spent by the signers it belongs to.
   *
   * **THE ASSERTION IS ON THE MESSAGE AND NOT ONLY ON THE REFUSAL.** Whoever
   * reads it is about to lose that argument, and it has to say which two things
   * disagreed and what it costs.
   */
  it('refuses when the ledger computes under a different scheme', () => {
    const said = halvesDisagree(
      { name: 'chain', commitments: { a: 1 } },   // equal, and not the same object
      { name: 'chain', commitments: scheme },
    );
    expect(said).not.toBeNull();
    expect(said).toContain('different scheme');
    expect(said).toContain('cannot be spent by the signers');
  });

  /**
   * **AND THE WORD, WHICH IS A SEPARATE FAILURE WITH A SEPARATE COST.** A
   * record is read back by the marker it carries, so a ledger stamping one word
   * while the build is selected as another produces records nothing can
   * classify afterwards - and *not known* is permanent.
   */
  it('refuses when the ledger would mark records with the other word', () => {
    const said = halvesDisagree(
      { name: 'simulated', commitments: scheme },
      { name: 'chain', commitments: scheme },
    );
    expect(said).toContain('"simulated"');
    expect(said).toContain('"chain"');
    expect(said).toContain('nothing can classify');
  });

  /** And the real assembly passes its own rule, which is what makes it worth having. */
  it('the assembled set carries the selector\'s own scheme and word', () => {
    const real = assembleFor(FACTS, noAddress);
    expect(real.commitments).toBe(wiring().commitments);
    expect(real.name).toBe(wiring().name);
  });
});
