import { describe, expect, it } from 'vitest';
import {
  Event, LedgerState, Transaction, TransactionContext, WellFormedStrictness, ZswapOffer, ZswapOutput,
  createShieldedCoinInfo, sampleCoinPublicKey, sampleEncryptionPublicKey, sampleRawTokenType,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';

import {
  NoteIndexRefused, NoteIndexUnreadable, indexForSpend, indexerNoteEvents, noteIndexFrom,
  recordCreatingTransaction, vaultNoteCommitment, type NoteEvents, type ServedEvent,
} from './note-index.js';
import type { NotePool } from './vault-ledger.js';
import { VaultPoolAdvancedSinceRead } from './vault-pool.js';
import type { Note, VaultNotes } from './vault-notes.js';

/**
 * **A NOTE'S INDEX IS READ FROM THE CHAIN'S EVENTS, AND FROM NOTHING ELSE.**
 *
 * §1 uses events the ledger itself produced, in this process: a transaction is
 * applied to a blank ledger state and the events it emits are serialised,
 * served the way the indexer serves them, and deserialised by the code under
 * test. The ledger refuses an output owned by a contract unless a contract
 * call claims it, so those real events are for outputs owned by nobody; the
 * contract-owned case is built from the event's documented shape in §2.
 */

const NETWORK = 'undeployed';
const VAULT = 'a7'.repeat(32);
const OTHER_VAULT = 'b8'.repeat(32);
const TX = 'c9'.repeat(32);

/* ------------------------------------------------------------------ *
 * real events, from a real ledger, in this process
 * ------------------------------------------------------------------ */

const lenient = () => {
  const s = new WellFormedStrictness();
  s.enforceBalancing = false;
  s.verifyNativeProofs = false;
  s.verifyContractProofs = false;
  s.enforceLimits = false;
  s.verifySignatures = false;
  return s;
};

const blockAt = (now: Date) => {
  const seconds = BigInt(Math.floor(now.getTime() / 1000));
  return { secondsSinceEpoch: seconds, secondsSinceEpochErr: 0, parentBlockHash: '00'.repeat(32), lastBlockTime: seconds - 1n };
};

/** Applies one transaction of user-owned outputs to `state`; returns the next state and its events. */
const applyOutputs = (state: LedgerState, values: bigint[]) => {
  const colour = sampleRawTokenType();
  const outputs = values.map((v) => ZswapOutput.new(
    createShieldedCoinInfo(colour, v), 0, sampleCoinPublicKey(), sampleEncryptionPublicKey()));
  let offer = ZswapOffer.fromOutput(outputs[0], colour, values[0]);
  for (let i = 1; i < outputs.length; i++) offer = offer.merge(ZswapOffer.fromOutput(outputs[i], colour, values[i]));
  const now = new Date();
  const verified = Transaction.fromParts(NETWORK, offer).eraseProofs().wellFormed(state, lenient(), now);
  const [next, result] = state.apply(verified, new TransactionContext(state, blockAt(now)));
  expect(result.type).toBe('success');
  return { next, events: result.events, outputs };
};

/** A fetch that answers one GraphQL request the way the indexer does, and remembers the request. */
const indexerAnswering = (answer: unknown, status = 200) => {
  const asked: any[] = [];
  const post = (async (_url: string, init: any) => {
    asked.push(JSON.parse(init.body));
    return { ok: status >= 200 && status < 300, status, json: async () => answer } as Response;
  }) as typeof fetch;
  return { post, asked };
};

const served = (events: Array<{ serialize(): Uint8Array }>, hash: string) => ({
  data: {
    transactions: [{
      hash,
      zswapLedgerEvents: events.map((e) => ({ raw: Buffer.from(e.serialize()).toString('hex') })),
    }],
  },
});

describe('§1 the events of a real transaction, as the indexer would serve them', () => {
  it('deserialises every served event and keeps the transaction each one says it came from', async () => {
    const { events, outputs } = applyOutputs(LedgerState.blank(NETWORK), [100n, 7n]);
    const hash = events[0].source.transactionHash;
    const { post, asked } = indexerAnswering(served(events, hash));

    const got = await indexerNoteEvents('https://indexer.example/graphql', post).eventsOf({ hash });

    expect(asked).toHaveLength(1);
    expect(asked[0].query).toMatch(/transactions\(offset: \$offset\)/);
    expect(asked[0].variables).toEqual({ offset: { hash } });
    expect(got).toHaveLength(2);
    expect(got.every((e) => e.transactionHash === hash)).toBe(true);
    expect(got.map((e) => e.details.tag)).toEqual(['zswapOutput', 'zswapOutput']);
    expect(new Set(got.map((e) => e.details.commitment)))
      .toEqual(new Set(outputs.map((o) => o.commitment)));
    expect(new Set(got.map((e) => e.details.mtIndex))).toEqual(new Set([0n, 1n]));
  });

  it('reads the index the ledger assigned, which a second transaction shows is not a position', async () => {
    const first = applyOutputs(LedgerState.blank(NETWORK), [100n, 7n]);
    const second = applyOutputs(first.next, [5n]);
    const hash = second.events[0].source.transactionHash;
    const { post } = indexerAnswering(served(second.events, hash));
    const got = await indexerNoteEvents('https://indexer.example/graphql', post).eventsOf({ hash });

    /* The only output of the second transaction sits at position 0 and index 2. */
    expect(got).toHaveLength(1);
    expect(got[0].details.mtIndex).toBe(2n);
    expect(got[0].details.commitment).toBe(second.outputs[0].commitment);
  });

  it('refuses a real output that no contract owns, rather than recording it for a vault', async () => {
    const { events, outputs } = applyOutputs(LedgerState.blank(NETWORK), [100n]);
    const hash = events[0].source.transactionHash;
    const { post } = indexerAnswering(served(events, hash));
    const got = await indexerNoteEvents('https://indexer.example/graphql', post).eventsOf({ hash });

    expect(() => noteIndexFrom(got, { vault: VAULT, commitment: outputs[0].commitment, transaction: { hash } }))
      .toThrow(/not for a contract/);
  });

  it('stops at a served event that does not deserialise, instead of skipping it', async () => {
    const { events } = applyOutputs(LedgerState.blank(NETWORK), [100n]);
    const hash = events[0].source.transactionHash;
    const whole = Buffer.from(events[0].serialize()).toString('hex');
    const cut = { data: { transactions: [{ hash, zswapLedgerEvents: [{ raw: whole }, { raw: whole.slice(0, -10) }] }] } };
    const { post } = indexerAnswering(cut);
    const read = indexerNoteEvents('https://indexer.example/graphql', post).eventsOf({ hash });
    await expect(read).rejects.toThrow(NoteIndexUnreadable);
    await expect(indexerNoteEvents('u', indexerAnswering(cut).post).eventsOf({ hash }))
      .rejects.toThrow(/event 2 of transaction .* did not deserialise/);
  });
});

/* ------------------------------------------------------------------ *
 * the index of one vault note, out of a transaction's events
 * ------------------------------------------------------------------ */

const output = (commitment: string, mtIndex: bigint, contract?: string, hash = TX): ServedEvent => ({
  transactionHash: hash,
  details: { tag: 'zswapOutput', commitment, mtIndex, ...(contract === undefined ? {} : { contract }) },
});
const input = (hash = TX): ServedEvent => ({ transactionHash: hash, details: { tag: 'zswapInput' } });
const MINE = 'e1'.repeat(32);

describe('§2 which event is this note\'s, and what it says', () => {
  it('takes the mtIndex of the one output with this note\'s commitment, owned by this vault', () => {
    const events = [input(), output('f0'.repeat(32), 0n), output('f1'.repeat(32), 1n, VAULT), output(MINE, 616n, VAULT)];
    expect(noteIndexFrom(events, { vault: VAULT, commitment: MINE, transaction: { hash: TX } })).toBe(616n);
  });

  it('matches hex regardless of case or a 0x prefix on either side', () => {
    const events = [output(MINE.toUpperCase(), 616n, '0x' + VAULT.toUpperCase())];
    expect(noteIndexFrom(events, { vault: '0x' + VAULT, commitment: '0x' + MINE, transaction: { hash: TX.toUpperCase() } }))
      .toBe(616n);
  });

  it('reads nothing into an empty answer: it is "could not read", not "no note"', () => {
    expect(() => noteIndexFrom([], { vault: VAULT, commitment: MINE, transaction: { hash: TX } }))
      .toThrow(NoteIndexUnreadable);
  });

  it('refuses an answer that mixes transactions, whether the question named a hash or an identifier', () => {
    const mixed = [output(MINE, 616n, VAULT), output('f0'.repeat(32), 1n, undefined, 'dd'.repeat(32))];
    expect(() => noteIndexFrom(mixed, { vault: VAULT, commitment: MINE, transaction: { hash: TX } }))
      .toThrow(NoteIndexRefused);
    expect(() => noteIndexFrom(mixed, { vault: VAULT, commitment: MINE, transaction: { identifier: '00'.repeat(33) } }))
      .toThrow(/more than one transaction/);
    const wrong = [output(MINE, 616n, VAULT, 'dd'.repeat(32))];
    expect(() => noteIndexFrom(wrong, { vault: VAULT, commitment: MINE, transaction: { hash: TX } }))
      .toThrow(/include one from transaction/);
  });

  it('refuses a transaction that did not create this note', () => {
    expect(() => noteIndexFrom([input(), output('f0'.repeat(32), 3n, VAULT)], { vault: VAULT, commitment: MINE, transaction: { hash: TX } }))
      .toThrow(/did not create this note/);
  });

  it('refuses the same commitment reported twice', () => {
    expect(() => noteIndexFrom([output(MINE, 5n, VAULT), output(MINE, 6n, VAULT)], { vault: VAULT, commitment: MINE, transaction: { hash: TX } }))
      .toThrow(/2 times/);
  });

  it('refuses an output owned by a different contract', () => {
    expect(() => noteIndexFrom([output(MINE, 616n, OTHER_VAULT)], { vault: VAULT, commitment: MINE, transaction: { hash: TX } }))
      .toThrow(/for a different contract/);
  });

  it('refuses an output whose index is missing or negative', () => {
    const noIndex: ServedEvent = { transactionHash: TX, details: { tag: 'zswapOutput', commitment: MINE, contract: VAULT } };
    expect(() => noteIndexFrom([noIndex], { vault: VAULT, commitment: MINE, transaction: { hash: TX } }))
      .toThrow(/without a readable index/);
    expect(() => noteIndexFrom([output(MINE, -1n, VAULT)], { vault: VAULT, commitment: MINE, transaction: { hash: TX } }))
      .toThrow(/without a readable index/);
  });
});

describe('§3 asking the indexer, and every way the answer can fail', () => {
  const ask = (answer: unknown, status = 200) =>
    indexerNoteEvents('https://indexer.example/graphql', indexerAnswering(answer, status).post);

  it('asks by identifier when that is what names the transaction', async () => {
    const { post, asked } = indexerAnswering({ data: { transactions: [{ hash: TX, zswapLedgerEvents: [] }] } });
    await indexerNoteEvents('u', post).eventsOf({ identifier: '0x' + '00'.repeat(33) });
    expect(asked[0].variables).toEqual({ offset: { identifier: '00'.repeat(33) } });
  });

  it('a failed request, an error reply, or a reply with no transaction is "could not read"', async () => {
    await expect(ask({}, 502).eventsOf({ hash: TX })).rejects.toThrow(/HTTP 502/);
    await expect(ask({}, 502).eventsOf({ hash: TX })).rejects.toThrow(NoteIndexUnreadable);
    await expect(ask({ errors: [{ message: 'no such field' }] }).eventsOf({ hash: TX })).rejects.toThrow(/no such field/);
    await expect(ask({ data: {} }).eventsOf({ hash: TX })).rejects.toThrow(/not a list of transactions/);
    await expect(ask({ data: { transactions: [] } }).eventsOf({ hash: TX })).rejects.toThrow(/does not hold/);
    await expect(ask({ data: { transactions: [{ hash: TX }] } }).eventsOf({ hash: TX })).rejects.toThrow(/no event list/);
    await expect(ask({ data: { transactions: [{ hash: TX, zswapLedgerEvents: [{ raw: 'xyz' }] }] } }).eventsOf({ hash: TX }))
      .rejects.toThrow(/is not hex/);
  });

  it('refuses two transactions for one question', async () => {
    const two = { data: { transactions: [{ hash: TX, zswapLedgerEvents: [] }, { hash: 'dd'.repeat(32), zswapLedgerEvents: [] }] } };
    await expect(ask(two).eventsOf({ identifier: '00'.repeat(33) })).rejects.toThrow(NoteIndexRefused);
  });
});

describe('§4 the commitment a vault note has on chain', () => {
  const coin = { nonce: '01'.repeat(32), token: 'aa'.repeat(32), value: 1_000n };

  it('does not depend on the segment the output is built for, which is what lets it be computed here', () => {
    const at = (segment: number | undefined) =>
      ZswapOutput.newContractOwned({ type: coin.token, nonce: coin.nonce, value: coin.value }, segment, VAULT).commitment;
    expect(at(1)).toBe(at(0));
    expect(at(undefined)).toBe(at(0));
  });

  it('changes with the vault, the nonce and the value, and ignores spelling', async () => {
    const base = await vaultNoteCommitment(coin, VAULT);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await vaultNoteCommitment(coin, OTHER_VAULT)).not.toBe(base);
    expect(await vaultNoteCommitment({ ...coin, nonce: '02'.repeat(32) }, VAULT)).not.toBe(base);
    expect(await vaultNoteCommitment({ ...coin, value: 999n }, VAULT)).not.toBe(base);
    expect(await vaultNoteCommitment({ ...coin, token: '0x' + coin.token.toUpperCase() }, '0x' + VAULT)).toBe(base);
  });
});

/* ------------------------------------------------------------------ *
 * a spend, and a record
 * ------------------------------------------------------------------ */

const eventsFor = async (notes: Array<{ note: Note; index: bigint; hash: string; owner?: string }>, reads: unknown[] = []): Promise<NoteEvents> => ({
  eventsOf: async (tx) => {
    reads.push(tx);
    const out: ServedEvent[] = [];
    for (const n of notes) {
      if ('hash' in tx ? n.hash !== tx.hash : n.hash !== TX) continue;
      out.push(output(await vaultNoteCommitment(n.note, VAULT), n.index, n.owner ?? VAULT, n.hash));
    }
    return out;
  },
});

const memoryPool = (initial: VaultNotes, duringRead?: (p: { notes: VaultNotes }) => void) => {
  /* Versioned, and a write built on an older version is refused, as the real pool's is. */
  const box = { notes: initial, version: 1 };
  const saves: VaultNotes[] = [];
  const pool: NotePool = {
    load: async () => ({ notes: box.notes.notes, readAt: { vault: VAULT, version: box.version } }),
    save: async (v, n, builtOn) => {
      if (builtOn.version !== box.version) throw new VaultPoolAdvancedSinceRead(v, builtOn.version, box.version);
      box.notes = n; box.version += 1; saves.push(n);
    },
    create: async () => { throw new Error('not here'); },
  };
  return { pool, box, saves, duringRead: () => duringRead?.(box) };
};

const NOTE: Note = { nonce: '01'.repeat(32), token: 'aa'.repeat(32), value: 1_000n, createdIn: TX };

describe('§5 the index a spend uses is read at the spend', () => {
  it('reads the creating transaction and returns what the chain says', async () => {
    const reads: unknown[] = [];
    const events = await eventsFor([{ note: NOTE, index: 616n, hash: TX }], reads);
    expect(await indexForSpend(VAULT, NOTE, events)).toBe(616n);
    expect(reads).toEqual([{ hash: TX }]);
  });

  it('refuses a note that does not record which transaction created it, and names what to do', async () => {
    const { createdIn: _gone, ...unrecorded } = NOTE;
    const events = await eventsFor([]);
    await expect(indexForSpend(VAULT, unrecorded, events)).rejects.toThrow(/recordCreatingTransaction/);
  });

  it('ignores an index the pool holds, and returns what the chain says now', async () => {
    const reads: unknown[] = [];
    const events = await eventsFor([{ note: NOTE, index: 617n, hash: TX }], reads);
    expect(await indexForSpend(VAULT, { ...NOTE, index: 616n }, events)).toBe(617n);
    expect(await indexForSpend(VAULT, { ...NOTE, index: 617n }, events)).toBe(617n);
    expect(reads).toHaveLength(2);
  });
});

describe('§6 recording which transaction created a note, and never its index', () => {
  const LEGACY: Note = { nonce: '02'.repeat(32), token: 'aa'.repeat(32), value: 10_000n };

  it('records the transaction the chain reports for a note that had none, named by identifier, and no index', async () => {
    const { pool, box } = memoryPool({ notes: [LEGACY] });
    const events: NoteEvents = {
      eventsOf: async () => [output(await vaultNoteCommitment(LEGACY, VAULT), 616n, VAULT, TX), output('f0'.repeat(32), 617n, undefined, TX)],
    };
    const r = await recordCreatingTransaction(pool, VAULT, LEGACY.nonce, events, { identifier: '00'.repeat(33) });
    expect(r).toEqual({ index: 616n, createdIn: TX });
    expect(box.notes.notes[0]).toEqual({ ...LEGACY, createdIn: TX });
    expect(box.notes.notes[0]).not.toHaveProperty('index');
  });

  it('replaces a recorded transaction the chain shows did not create the note, and says what it was', async () => {
    const wrong = { ...NOTE, createdIn: 'dd'.repeat(32) };
    const { pool, box } = memoryPool({ notes: [wrong] });
    const events = await eventsFor([{ note: NOTE, index: 616n, hash: TX }]);
    expect(await recordCreatingTransaction(pool, VAULT, NOTE.nonce, events, { hash: TX }))
      .toEqual({ index: 616n, createdIn: TX, previously: 'dd'.repeat(32) });
    expect(box.notes.notes[0].createdIn).toBe(TX);
  });

  it('writes against the pool as it is after the read, so a note added meanwhile is kept', async () => {
    const arrived: Note = { nonce: '03'.repeat(32), token: 'aa'.repeat(32), value: 5n, createdIn: 'ab'.repeat(32) };
    const m = memoryPool({ notes: [LEGACY] });
    const inner = await eventsFor([{ note: LEGACY, index: 616n, hash: TX }]);
    const events: NoteEvents = {
      eventsOf: async (tx) => {
        m.box.notes = { notes: [...m.box.notes.notes, arrived] };
        m.box.version += 1;
        return inner.eventsOf(tx);
      },
    };
    await recordCreatingTransaction(m.pool, VAULT, LEGACY.nonce, events, { hash: TX });
    expect(m.box.notes.notes).toHaveLength(2);
    expect(m.box.notes.notes.find((n) => n.nonce === arrived.nonce)).toEqual(arrived);
    expect(m.box.notes.notes.find((n) => n.nonce === LEGACY.nonce)!.createdIn).toBe(TX);
  });

  it('refuses a note whose coin changed under the same nonce during the read, and writes nothing', async () => {
    const m = memoryPool({ notes: [LEGACY] });
    const inner = await eventsFor([{ note: LEGACY, index: 616n, hash: TX }]);
    const events: NoteEvents = {
      eventsOf: async (tx) => { m.box.notes = { notes: [{ ...LEGACY, value: 12_000n }] }; return inner.eventsOf(tx); },
    };
    await expect(recordCreatingTransaction(m.pool, VAULT, LEGACY.nonce, events, { hash: TX }))
      .rejects.toThrow(/no longer the coin whose commitment was checked/);
    expect(m.saves).toEqual([]);
  });

  it('refuses a note that left the pool during the read, and writes nothing', async () => {
    const m = memoryPool({ notes: [LEGACY] });
    const inner = await eventsFor([{ note: LEGACY, index: 616n, hash: TX }]);
    const events: NoteEvents = {
      eventsOf: async (tx) => { m.box.notes = { notes: [] }; return inner.eventsOf(tx); },
    };
    await expect(recordCreatingTransaction(m.pool, VAULT, LEGACY.nonce, events, { hash: TX }))
      .rejects.toThrow(/left this vault's pool/);
    expect(m.saves).toEqual([]);
  });

  it('writes nothing for a transaction that did not create the note, or a note the pool does not hold', async () => {
    const { pool, saves } = memoryPool({ notes: [LEGACY] });
    const events = await eventsFor([{ note: NOTE, index: 616n, hash: TX }]);
    await expect(recordCreatingTransaction(pool, VAULT, LEGACY.nonce, events, { hash: TX }))
      .rejects.toThrow(/did not create this note/);
    await expect(recordCreatingTransaction(pool, VAULT, '09'.repeat(32), events, { hash: TX }))
      .rejects.toThrow(/has no note/);
    expect(saves).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * WHICH KIND OF NO A GRAPHQL ERROR IS
 * ------------------------------------------------------------------ */

describe('a question the indexer will not take is not a question to ask again', () => {
  it('names the permanent shapes as permanent, by code and by what they say', async () => {
    const { theQuestionCannotBeAsked } = await import('./note-index.js');
    const permanent = [
      [{ message: 'x', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }],
      [{ message: 'x', extensions: { code: 'GRAPHQL_PARSE_FAILED' } }],
      [{ message: 'x', extensions: { code: 'BAD_USER_INPUT' } }],
      [{ message: 'Cannot query field "zswapLedgerEvents" on type "Transaction".' }],
      [{ message: 'Unknown field "raw" on type "ZswapChainStateEvent".' }],
      [{ message: 'Unknown argument "offset" on field "transactions".' }],
      [{ message: 'Unknown type "TransactionOffset".' }],
      [{ message: 'Syntax Error: Expected Name, found "}".' }],
      [{ message: 'Field "raw" of required type "String!" was not provided.' }],
      [{ message: 'Field "hash" is not defined by type "TransactionOffset".' }],
      /* The permanent one second in the list, so a check that reads only the first goes red. */
      [{ message: 'something else' }, { message: 'Cannot query field "raw".' }],
    ];
    for (const errors of permanent) {
      /* RED WHEN a schema error is reported as "read again shortly", which is somebody waiting for ever. */
      expect(theQuestionCannotBeAsked(errors), JSON.stringify(errors)).toBe(true);
    }
  });

  it('LEAVES EVERYTHING IT DOES NOT RECOGNISE RETRYABLE, which is the safe direction', async () => {
    const { theQuestionCannotBeAsked } = await import('./note-index.js');
    const unknown: unknown[][] = [
      [], [{ message: 'internal server error' }], [{ message: 'timeout' }],
      [{ message: 'x', extensions: { code: 'INTERNAL_SERVER_ERROR' } }],
      [{ message: 'too many requests' }], [{}], [null], [{ message: 42 }],
      [{ message: 'x', extensions: { code: 42 } }],
      /*
       * The convention that sends this one means "send the same question again
       * with its full text", so the act it asks for is one more request. RED
       * WHEN it is added to the permanent codes.
       */
      [{ message: 'PersistedQueryNotFound', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } }],
      /* A server's own fault, worded like a schema complaint. Nothing a client changes fixes it. */
      [{ message: 'ERROR: syntax error at or near ")" in the indexer\x27s own query' }],
      [{ message: 'decoder met an unknown type tag while reading a block' }],
    ];
    for (const errors of unknown) {
      /*
       * RED WHEN an unrecognised error is called permanent. Telling somebody to
       * stop waiting for an answer that would have come is worse than the
       * defect this replaces: a note whose index is never read is money nobody
       * reaches.
       */
      expect(theQuestionCannotBeAsked(errors), JSON.stringify(errors)).toBe(false);
    }
  });

  it('carries EVERY error, with its code, not the first one only', async () => {
    const { everyThingSaid } = await import('./note-index.js');
    const said = everyThingSaid([
      { message: 'first', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } },
      { message: 'second' },
      {},
    ]);
    /* RED WHEN errors after the first are dropped, which is how one of several fixes gets fixed. */
    expect(said).toContain('first');
    expect(said).toContain('second');
    /* RED WHEN the code is dropped, which is the half a reader can look up. */
    expect(said).toContain('[GRAPHQL_VALIDATION_FAILED]');
    /* RED WHEN an error with no message prints as undefined. */
    expect(said).toContain('no message');
    /* RED WHEN somebody else's error list is printed without a bound. */
    expect(everyThingSaid(Array.from({ length: 9 }, (_, i) => ({ message: `e${i}` }))))
      .toContain('(and 4 more)');
    /*
     * RED WHEN a message is passed on at whatever length it arrives. Five
     * messages with no length limit are as unbounded as fifty, and this text
     * goes into a thrown error and on to a terminal.
     */
    expect(everyThingSaid([{ message: 'x'.repeat(5_000) }]).length).toBeLessThan(500);
    /*
     * RED WHEN control characters survive. An escape sequence in an indexer's
     * error message moves the cursor back over lines this door has already
     * printed, including the one saying nothing was written.
     */
    const nasty = everyThingSaid([{ message: 'before\u001b[1A\u001b[2Kafter\r\n' }]);
    expect(nasty).toContain('before');
    expect(nasty).toContain('after');
    expect(/[\u0000-\u001f]/.test(nasty)).toBe(false);
  });

  it('THE READER THROWS THE THIRD ANSWER, and it is not either of the other two', async () => {
    const { indexerNoteEvents, NoteIndexUnaskable, NoteIndexUnreadable } =
      await import('./note-index.js');
    const answering = (errors: unknown[]) => (async () => ({
      ok: true, json: async () => ({ errors }),
    })) as unknown as typeof fetch;

    const schema = indexerNoteEvents('http://indexer.invalid',
      answering([{ message: 'Cannot query field "raw" on type "ZswapChainStateEvent".' }]));
    const failed = await schema.eventsOf({ hash: 'ab'.repeat(32) }).then(() => null, (e: Error) => e);
    /* RED WHEN a permanent schema error is still reported as the chain not having caught up. */
    expect(failed).toBeInstanceOf(NoteIndexUnaskable);
    expect(failed).not.toBeInstanceOf(NoteIndexUnreadable);
    expect((failed as Error).message).toMatch(/asking again changes\s+nothing/);
    expect((failed as Error).message).toContain('Cannot query field');

    const busy = indexerNoteEvents('http://indexer.invalid', answering([{ message: 'service unavailable' }]));
    const later = await busy.eventsOf({ hash: 'ab'.repeat(32) }).then(() => null, (e: Error) => e);
    /* RED WHEN an ordinary server error is reported as something reading again cannot fix. */
    expect(later).toBeInstanceOf(NoteIndexUnreadable);
    expect(later).not.toBeInstanceOf(NoteIndexUnaskable);
  });
});
