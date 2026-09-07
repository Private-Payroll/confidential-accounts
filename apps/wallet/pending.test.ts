// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { newSecret } from 'midnight-identity';
import {
  TTL_SETTLE_MARGIN_MS, dismissPendingSend, duplicateUnresolved, loadPendingSends,
  answerFromTransactions, isKnownStatus, observedPendingGuard, outcomeOfAnswer,
  pendingGuardFor, resolvePendingSends,
  settlePendingSend, throwawayPendingGuard, unresolvedPendingSends, writePendingSend,
} from './pending.js';
import type { PendingDraft, PendingOutcome, PendingSend, ResolutionDoors } from './pending.js';

/*
 * THE WRITTEN-DOWN MIDDLE. What these tests hold, in their
 * own order:
 * the payment survives anything that kills a tab (it is in localStorage
 * before the submit call — the ORDERING itself is pinned in send.test.ts);
 * it resolves itself against the chain by identifier with nobody pressing
 * anything; a chain that answers decides; a chain that is SILENT decides
 * nothing until the transaction's own TTL has passed; and the same payment
 * cannot be made twice while the first is unresolved.
 */

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const draft = (over: Partial<PendingDraft> = {}): PendingDraft => ({
  identifiers: ['aa11', 'bb22'],
  account: 0,
  kind: 'unshielded',
  recipientBech32: 'mn_addr_stagenet1recipient',
  stars: 25_000_000n,
  feeSpecks: 681_461_485_385_268n,
  ttlAt: Date.now() + 60 * 60 * 1000,
  ...over,
});

beforeEach(() => { localStorage.clear(); });

describe('the record survives, and it is the account\'s own', () => {
  it('written, read back, exact — bigints and all', () => {
    const secret = newSecret();
    writePendingSend(secret, draft());
    const [record] = loadPendingSends(secret);
    if (!record) throw new Error('nothing was written');
    expect(record.key).toBe('aa11');
    expect(record.identifiers).toEqual(['aa11', 'bb22']);
    expect(record.stars).toBe('25000000');
    expect(record.outcome).toBeNull();
    expect(record.ttlAt).toBeGreaterThan(Date.now());
  });

  it('another account\'s pending payment is never shown here', () => {
    const mine = newSecret();
    const theirs = newSecret();
    writePendingSend(theirs, draft());
    expect(loadPendingSends(mine)).toEqual([]);
    /* And writing mine does not disturb theirs. */
    writePendingSend(mine, draft({ identifiers: ['cc33'] }));
    expect(loadPendingSends(theirs).length).toBe(1);
    expect(loadPendingSends(mine).length).toBe(1);
  });

  it('a damaged entry is skipped; the healthy ones still answer', () => {
    const secret = newSecret();
    writePendingSend(secret, draft());
    const raw = JSON.parse(localStorage.getItem('midnight-identity:pending-sends') ?? '[]') as unknown[];
    localStorage.setItem('midnight-identity:pending-sends',
      JSON.stringify([...raw, { half: 'a record' }, 42]));
    expect(loadPendingSends(secret).length).toBe(1);
  });

  it('settle keeps the record until a person dismisses it — an answer must find somebody', () => {
    const secret = newSecret();
    writePendingSend(secret, draft());
    settlePendingSend(secret, 'aa11', { name: 'sent', at: Date.now() });
    expect(loadPendingSends(secret)[0]?.outcome?.name).toBe('sent');
    expect(unresolvedPendingSends(secret)).toEqual([]);
    dismissPendingSend(secret, 'aa11');
    expect(loadPendingSends(secret)).toEqual([]);
  });
});

describe('the double-send question', () => {
  it('same recipient, same exact amount, unresolved: yes; anything else: no', () => {
    const secret = newSecret();
    writePendingSend(secret, draft());
    expect(duplicateUnresolved(secret, 'mn_addr_stagenet1recipient', 25_000_000n)).toBe(true);
    expect(duplicateUnresolved(secret, 'mn_addr_stagenet1recipient', 25_000_001n)).toBe(false);
    expect(duplicateUnresolved(secret, 'mn_addr_stagenet1other', 25_000_000n)).toBe(false);
    /* Resolution unlocks the payment again. */
    settlePendingSend(secret, 'aa11', { name: 'sent', at: Date.now() });
    expect(duplicateUnresolved(secret, 'mn_addr_stagenet1recipient', 25_000_000n)).toBe(false);
  });

  it('the rehearsal\'s throwaway guard behaves the same and touches no storage', () => {
    const guard = throwawayPendingGuard();
    guard.write({ ...draft(), stars: 1n });
    expect(guard.duplicateUnresolved('mn_addr_stagenet1recipient', 1n)).toBe(true);
    guard.settle('aa11', { name: 'sent', at: Date.now() });
    expect(guard.duplicateUnresolved('mn_addr_stagenet1recipient', 1n)).toBe(false);
    expect(localStorage.getItem('midnight-identity:pending-sends')).toBeNull();
  });
});

describe('what one chain answer means — shared by the engine and the home screen', () => {
  const record = { ttlAt: 1_000_000 };
  it('found SUCCESS is sent; found anything else is failed, in the chain\'s word', () => {
    expect(outcomeOfAnswer(record, { found: true, status: 'SUCCESS' }, 0)?.name).toBe('sent');
    const failed = outcomeOfAnswer(record, { found: true, status: 'FAILURE' }, 0);
    expect(failed?.name).toBe('failed');
    expect(failed?.name === 'failed' && failed.reason).toMatch(/FAILURE/u);
    expect(outcomeOfAnswer(record, { found: true, status: 'PARTIAL_SUCCESS' }, 0)?.name)
      .toBe('failed');
  });

  it('not found BEFORE the TTL decides nothing — the middle keeps being watched', () => {
    expect(outcomeOfAnswer(record, { found: false }, 999_999)).toBeNull();
    expect(outcomeOfAnswer(record, { found: false },
      1_000_000 + TTL_SETTLE_MARGIN_MS)).toBeNull();
  });

  it('not found PAST the TTL (plus margin) settles as failed — the middle must end', () => {
    const outcome = outcomeOfAnswer(record, { found: false },
      1_000_001 + TTL_SETTLE_MARGIN_MS);
    expect(outcome?.name).toBe('failed');
    expect(outcome?.name === 'failed' && outcome.reason).toMatch(/can no longer be included/u);
  });

  it('that failure NEVER claims nothing moved, and never says sending again is safe', () => {
    /* The evidence for this outcome is a SILENCE FROM THE INDEXER, and a
     * finalised transaction has been measured invisible to it — 168ms after
     * the node said FINALIZED (measured, 20 Aug). So
     * the record settles, because a middle that never ends is the whole
     * defect, but the words it settles with may not assert a fact about the
     * chain that nothing here established. Removing this pin is how the old
     * sentence comes back. */
    const outcome = outcomeOfAnswer(record, { found: false },
      1_000_001 + TTL_SETTLE_MARGIN_MS);
    const reason = outcome?.name === 'failed' ? outcome.reason : '';
    expect(reason).not.toMatch(/[Nn]othing moved/u);
    expect(reason).not.toMatch(/safe to send/u);
    expect(reason).toMatch(/NOT known/u);
    expect(reason).toMatch(/silence/u);
  });

  it('NO answer at all is not "not found" — silence never becomes failed', () => {
    /* null answer = every ask threw. Even a TTL long past decides nothing,
     * because "the indexer was unreachable" says nothing about the chain. */
    expect(outcomeOfAnswer(record, null, 1_000_001 + TTL_SETTLE_MARGIN_MS)).toBeNull();
  });
});

describe('resolution runs by itself and believes only answers', () => {
  it('settles what the chain confirms, leaves the silent one alone', async () => {
    const secret = newSecret();
    writePendingSend(secret, draft({ identifiers: ['found1'] }));
    writePendingSend(secret, draft({
      identifiers: ['quiet1'], recipientBech32: 'mn_addr_stagenet1other',
    }));
    const doors: ResolutionDoors = {
      status: async (id) => (id === 'found1'
        ? { found: true, status: 'SUCCESS' }
        : { found: false }),
      now: Date.now,
    };
    const settled = await resolvePendingSends(secret, doors);
    expect(settled.map((r) => r.key)).toEqual(['found1']);
    expect(unresolvedPendingSends(secret).map((r) => r.key)).toEqual(['quiet1']);
  });

  it('an indexer that cannot be reached resolves NOTHING — even past the TTL', async () => {
    const secret = newSecret();
    writePendingSend(secret, draft({ ttlAt: Date.now() - 24 * 60 * 60 * 1000 }));
    const settled = await resolvePendingSends(secret, {
      status: async () => { throw new Error('the indexer is down'); },
      now: Date.now,
    });
    expect(settled).toEqual([]);
    expect(unresolvedPendingSends(secret).length).toBe(1);
  });

  it('a second identifier answers when the first is silent', async () => {
    const secret = newSecret();
    writePendingSend(secret, draft({ identifiers: ['dead1', 'live2'] }));
    const settled = await resolvePendingSends(secret, {
      status: async (id) => {
        if (id === 'dead1') throw new Error('no answer');
        return { found: true, status: 'SUCCESS' };
      },
      now: Date.now,
    });
    expect(settled[0]?.outcome?.name).toBe('sent');
  });

  it('the guard the engine holds writes through to the same store', () => {
    const secret = newSecret();
    const guard = pendingGuardFor(secret, 3);
    guard.write({
      identifiers: ['gg77'], kind: 'unshielded',
      recipientBech32: 'mn_addr_stagenet1recipient',
      stars: 5n, feeSpecks: 1n, ttlAt: Date.now() + 1000,
    });
    expect(loadPendingSends(secret)[0]?.account).toBe(3);
    guard.settle('gg77', { name: 'failed', at: Date.now(), reason: 'test' });
    expect(loadPendingSends(secret)[0]?.outcome?.name).toBe('failed');
  });
});

/*
 * THE GUARD AGAINST A REAL SEND — the doors the probe drives the engine with.
 *
 * A rule governs how these are written: **every assertion counts something
 * on the RECORD, and none of them asks a simulated chain whether it
 * approves.** The chain that approves is the one that took an unsigned
 * transfer into a block, so its approval is worth nothing as evidence.
 *
 * What is countable here: that the record is IN STORAGE and not merely
 * returned; that what the run reports is what storage holds rather than what
 * the engine intended; that the key is an identifier the chain can actually
 * be asked about; and that a write which does not land REFUSES rather than
 * reporting success.
 */
describe('the watched guard reads the record back off disk', () => {
  const observerSpy = () => {
    const wrote: PendingSend[] = [];
    const settled: { key: string; outcome: PendingOutcome }[] = [];
    return {
      wrote, settled,
      observer: {
        wrote: (r: PendingSend) => { wrote.push(r); },
        settled: (key: string, outcome: PendingOutcome) => { settled.push({ key, outcome }); },
      },
    };
  };

  it('THE PIN: what the run reports is what STORAGE holds, not the draft', () => {
    const secret = newSecret();
    const spy = observerSpy();
    const guard = observedPendingGuard(secret, 0, spy.observer);

    guard.write(draft());

    /* Counted on the store, not taken from the call. */
    const onDisk = loadPendingSends(secret);
    expect(onDisk).toHaveLength(1);
    expect(spy.wrote).toHaveLength(1);
    expect(spy.wrote[0]).toEqual(onDisk[0]);
    /* And it is UNRESOLVED at the moment it is written — the whole point is
     * that a tab dying here leaves an open question, not an answer. */
    expect(spy.wrote[0]?.outcome).toBeNull();
  });

  it('THE PIN, sharpened: the STORE\'s key is reported, not the draft\'s', () => {
    /* A draft with no identifiers is where the two diverge: the store keys
     * the record by a constructed fallback, and a report built from the
     * draft would carry an empty string — a key nothing can be found under
     * and nothing can be asked of the chain about. The record on disk is the
     * only thing that answers a later question, so it is the only thing that
     * may be reported. */
    const secret = newSecret();
    const spy = observerSpy();
    observedPendingGuard(secret, 0, spy.observer).write(draft({ identifiers: [] }));

    const onDisk = loadPendingSends(secret)[0];
    expect(onDisk?.key).toBe('no-identifier:mn_addr_stagenet1recipient:25000000');
    expect(spy.wrote[0]?.key).toBe(onDisk?.key);
    expect(spy.wrote[0]?.key).not.toBe('');
    expect(spy.wrote[0]).toEqual(onDisk);
  });

  it('THE PIN: the key is an identifier the chain can be asked about', () => {
    const secret = newSecret();
    const spy = observerSpy();
    observedPendingGuard(secret, 0, spy.observer).write(draft());
    /* The record's key IS its first identifier — that is what makes
     * `transactionStatusOnChain(record.key)` a question about this
     * transaction rather than about a made-up string. */
    expect(spy.wrote[0]?.key).toBe('aa11');
    expect(spy.wrote[0]?.identifiers).toEqual(['aa11', 'bb22']);
  });

  it('THE PIN: a write that does not land THROWS, so the engine refuses the send', () => {
    const secret = newSecret();
    const spy = observerSpy();
    const guard = observedPendingGuard(secret, 0, spy.observer);

    /* Storage that accepts the write and forgets it — the failure mode a
     * `write` returning a value cannot detect. Quota, a dropped field, a
     * fingerprint that does not match on read-back: all look like this. */
    const realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function noop() { /* swallowed */ };
    try {
      expect(() => guard.write(draft())).toThrow(/NOT on disk/u);
    } finally {
      Storage.prototype.setItem = realSetItem;
    }
    expect(spy.wrote).toHaveLength(0);
    expect(loadPendingSends(secret)).toHaveLength(0);
  });

  it('settling goes through the real guard and is observed with its outcome', () => {
    const secret = newSecret();
    const spy = observerSpy();
    const guard = observedPendingGuard(secret, 0, spy.observer);
    guard.write(draft());
    guard.settle('aa11', { name: 'sent', at: 1_000 });

    expect(spy.settled).toEqual([{ key: 'aa11', outcome: { name: 'sent', at: 1_000 } }]);
    expect(loadPendingSends(secret)[0]?.outcome).toEqual({ name: 'sent', at: 1_000 });
    /* And a settled record is no longer unresolved, which is what stops the
     * duplicate guard refusing the NEXT payment for ever. */
    expect(unresolvedPendingSends(secret)).toHaveLength(0);
  });

  it('the duplicate guard still refuses the same payment while it is unresolved', () => {
    const secret = newSecret();
    const spy = observerSpy();
    const guard = observedPendingGuard(secret, 0, spy.observer);
    guard.write(draft());
    expect(guard.duplicateUnresolved('mn_addr_stagenet1recipient', 25_000_000n)).toBe(true);
    guard.settle('aa11', { name: 'sent', at: 1_000 });
    expect(guard.duplicateUnresolved('mn_addr_stagenet1recipient', 25_000_000n)).toBe(false);
  });

  it('the record is the ACCOUNT\'s own — another account cannot read it back', () => {
    const secret = newSecret();
    const other = newSecret();
    observedPendingGuard(secret, 0, observerSpy().observer).write(draft());
    expect(loadPendingSends(secret)).toHaveLength(1);
    expect(loadPendingSends(other)).toHaveLength(0);
  });
});

/*
 * THE LAST PLACE THE WALLET TURNED "I DO NOT KNOW" INTO AN ANSWER.
 *
 * Two defects, one line. `answer.status === 'SUCCESS' ? sent : failed` made
 * EVERY non-success a definite failure — including a status this wallet has
 * never heard of, which the indexer's own type promises will arrive
 * (`'%future added value'`, graphql.d.ts:759). And `TransactionStatus` has
 * always selected `segments { id success }` while the wallet threw them away
 * and described in prose which part had failed.
 *
 * By that rule, every assertion here counts something on the ANSWER. None of
 * them asks a simulated chain whether it approves.
 */
describe('an answer this wallet cannot read resolves nothing', () => {
  const ttl = { ttlAt: 1_000_000 };

  it('THE PIN: an unrecognised status is the null case — keep watching', () => {
    expect(outcomeOfAnswer(ttl, { found: true, status: '%future added value' }, 0)).toBeNull();
    expect(outcomeOfAnswer(ttl, { found: true, status: 'SOMETHING_NEW' }, 0)).toBeNull();
    expect(outcomeOfAnswer(ttl, { found: true, status: '' }, 0)).toBeNull();
  });

  it('THE PIN: an unrecognised status stays unresolved even PAST the deadline', () => {
    /* The TTL clause is only reachable through `found: false`. An answer the
     * wallet cannot read must not fall through to it and become "failed"
     * once enough time has passed — that would be the same guess, delayed. */
    expect(outcomeOfAnswer(ttl, { found: true, status: '%future added value' },
      2_000_000 + TTL_SETTLE_MARGIN_MS)).toBeNull();
  });

  it('the three statuses this wallet HAS heard of still resolve', () => {
    expect(outcomeOfAnswer(ttl, { found: true, status: 'SUCCESS' }, 0)?.name).toBe('sent');
    expect(outcomeOfAnswer(ttl, { found: true, status: 'FAILURE' }, 0)?.name).toBe('failed');
    expect(outcomeOfAnswer(ttl, { found: true, status: 'PARTIAL_SUCCESS' }, 0)?.name).toBe('failed');
    expect(isKnownStatus('SUCCESS')).toBe(true);
    expect(isKnownStatus('%future added value')).toBe(false);
  });
});

describe('which part failed is READ, not guessed', () => {
  const ttl = { ttlAt: 1_000_000 };
  const reasonOf = (answer: Parameters<typeof outcomeOfAnswer>[1]): string => {
    const outcome = outcomeOfAnswer(ttl, answer, 0);
    return outcome?.name === 'failed' ? outcome.reason : '';
  };

  it('THE PIN: the segments the query already selects appear in the answer', () => {
    const reason = reasonOf({
      found: true,
      status: 'PARTIAL_SUCCESS',
      segments: [{ id: 0, success: true }, { id: 1, success: false }],
    });
    expect(reason).toContain('part 1 failed');
    expect(reason).toContain('part 0 succeeded');
  });

  it('THE PIN: no segments means it SAYS it does not know, and does not guess', () => {
    const reason = reasonOf({ found: true, status: 'PARTIAL_SUCCESS' });
    expect(reason).toContain('did not say which part');
    expect(reason).toContain('not going to guess');
    /* And it must not invent a part number out of nothing. */
    expect(reason).not.toMatch(/part \d/u);
  });

  it('an EMPTY segment list is also "did not say" — not "nothing failed"', () => {
    const reason = reasonOf({ found: true, status: 'FAILURE', segments: [] });
    expect(reason).toContain('did not say which part');
  });

  it('the same rule lives here too: this failure does not claim the money is safe', () => {
    const reason = reasonOf({
      found: true, status: 'FAILURE', segments: [{ id: 0, success: false }],
    });
    expect(reason).not.toMatch(/[Nn]othing moved/u);
    expect(reason).not.toMatch(/safe to send/u);
    expect(reason).toContain('block explorer');
  });

  it('the answer carries segments as the chain gives them, ids and all', () => {
    const reason = reasonOf({
      found: true,
      status: 'PARTIAL_SUCCESS',
      segments: [{ id: 3, success: false }, { id: 7, success: false }],
    });
    expect(reason).toContain('part 3, 7 failed');
  });
});

describe('the segments are read OFF THE WIRE, not just handled once inside', () => {
  const regular = (status: string, segments: unknown) => ([{
    __typename: 'RegularTransaction',
    transactionResult: { status, segments },
  }] as Parameters<typeof answerFromTransactions>[0]);

  it('THE PIN: a segment list on the wire reaches the answer', () => {
    /* The mutation this exists for: `segments: undefined` in the mapping.
     * Everything downstream still passed, because every other test builds
     * its own answer by hand — so the one line that reads the wire had no
     * pin at all, which is how the field came to be dropped in the first
     * place. */
    const answer = answerFromTransactions(
      regular('PARTIAL_SUCCESS', [{ id: 0, success: true }, { id: 1, success: false }]));
    expect(answer.found).toBe(true);
    expect(answer.found === true && answer.segments).toEqual([
      { id: 0, success: true }, { id: 1, success: false },
    ]);
  });

  it('null segments from the server stay ABSENT, not an empty list', () => {
    const answer = answerFromTransactions(regular('FAILURE', null));
    expect(answer.found === true && answer.segments).toBeUndefined();
  });

  it('the status comes through verbatim, including one this wallet cannot read', () => {
    const answer = answerFromTransactions(regular('%future added value', null));
    expect(answer.found === true && answer.status).toBe('%future added value');
    /* And end to end: an answer off the wire that the wallet cannot read
     * resolves the record to nothing. */
    expect(outcomeOfAnswer({ ttlAt: 1_000_000 }, answer, 0)).toBeNull();
  });

  it('no RegularTransaction in the reply is "not found"', () => {
    expect(answerFromTransactions([]).found).toBe(false);
    expect(answerFromTransactions([{ __typename: 'SomethingElse' }]).found).toBe(false);
  });
});
