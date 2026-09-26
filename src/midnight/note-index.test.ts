import { describe, expect, it } from 'vitest';
import {
  Event, LedgerState, Transaction, TransactionContext, WellFormedStrictness, ZswapOffer, ZswapOutput,
  createShieldedCoinInfo, sampleCoinPublicKey, sampleEncryptionPublicKey, sampleRawTokenType,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';

import {
  NoteIndexRefused, NoteIndexUnaskable, NoteIndexUnreadable, creatingTransactionsAmong, transactionThatCreatedOutput,
  establishCreatingTransaction, indexForSpend, indexerNoteEvents, indexerVaultTransactions,
  noteIndexFrom, recordCreatingTransaction, vaultNoteCommitment,
  type IndexerSocket, type NoteEvents, type ServedEvent,
} from './note-index.js';
import type { Hex } from '../core/crypto.js';
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

  /**
   * **THE ONE VALUE ON THIS PATH THAT NOTHING CHECKED.**
   *
   * When a transaction is named by its 33-byte identifier, the hash is not
   * something the caller holds: it is read off the first event, and every
   * other event is then compared against it. **So the comparison is against a
   * value taken out of the answer, and cannot refuse it.**
   *
   * A note written with a hash no spend can read reads as a HEALTHY note in
   * the pool, on the screen and in the pre-flight a payment makes, and is
   * refused only at the spend - after a proposal and its approvals have been
   * paid for.
   */
  const eventsSaying = (hash: string, note: Note = LEGACY): NoteEvents => ({
    eventsOf: async () => [output(await vaultNoteCommitment(note, VAULT), 616n, VAULT, hash)],
  });

  it('REFUSES A HASH THE CHAIN DID NOT NAME, AND WRITES NOTHING', async () => {
    for (const answered of ['', '0x', 'c9'.repeat(20), `${TX}ab`, 'ab'.repeat(32).toUpperCase() + 'zz',
      'not-a-hash', '0x' + 'c9'.repeat(31)]) {
      const m = memoryPool({ notes: [LEGACY] });
      /*
       * RED WHEN the hash read off the answer is written without being shaped.
       * Every value here passed every check this function made before, because
       * the only comparison on this branch was against this same value.
       */
      await expect(
        recordCreatingTransaction(m.pool, VAULT, LEGACY.nonce, eventsSaying(answered), { identifier: '00'.repeat(33) }),
        JSON.stringify(answered),
      ).rejects.toThrow(/without naming its hash|sixty-four hex characters/);
      /* RED WHEN it refuses after writing, which strands the note it was
       * called to repair. */
      expect(m.saves, JSON.stringify(answered)).toEqual([]);
    }
  });

  it('and a well-formed hash on the same path is still recorded, so the guard is not a wall', async () => {
    const m = memoryPool({ notes: [LEGACY] });
    /* RED WHEN the guard refuses the ordinary answer, which would make the
     * repair door useless and the assertions above vacuous. */
    expect(await recordCreatingTransaction(m.pool, VAULT, LEGACY.nonce, eventsSaying(TX), { identifier: '00'.repeat(33) }))
      .toEqual({ index: 616n, createdIn: TX });
    expect(m.box.notes.notes[0].createdIn).toBe(TX);
    /* An upper-case or 0x-prefixed answer is the same hash and is normalised,
     * not refused: the shape rule is about what the value IS. */
    const upper = memoryPool({ notes: [LEGACY] });
    expect(await recordCreatingTransaction(upper.pool, VAULT, LEGACY.nonce, eventsSaying(`0x${TX.toUpperCase()}`), { identifier: '00'.repeat(33) }))
      .toEqual({ index: 616n, createdIn: TX });
  });

  it('REFUSES a hash the CALLER named that is not a hash, before any chain read is trusted', async () => {
    const m = memoryPool({ notes: [LEGACY] });
    /* RED WHEN a caller's own malformed hash is compared against the events
     * and written. It is a different branch from the one above and it had the
     * same ending. */
    await expect(recordCreatingTransaction(m.pool, VAULT, LEGACY.nonce, eventsSaying(TX), { hash: 'c9'.repeat(20) }))
      .rejects.toThrow(/is not a transaction hash/);
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

/* ------------------------------------------------------------------ *
 * a note nobody recorded the transaction of
 * ------------------------------------------------------------------ */

describe('§7 which transaction created a note nobody wrote the transaction down for', () => {
  const H = (n: number) => n.toString(16).padStart(2, '0').repeat(32) as Hex;
  const COIN = { nonce: '5a'.repeat(32) as Hex, token: 'aa'.repeat(32) as Hex, value: 300n };
  const OTHER = { nonce: '5b'.repeat(32) as Hex, token: 'aa'.repeat(32) as Hex, value: 40n };

  /** A chain: the vault's transactions newest first, and the events each one served. */
  const chainOf = (txs: Array<{ hash: Hex; events: ServedEvent[] | Error }>) => {
    const reads: string[] = [];
    let listings = 0;
    return {
      reads,
      listings: () => listings,
      transactions: { of: async () => { listings += 1; return txs.map((t) => t.hash); } },
      events: {
        eventsOf: async (tx: { hash?: string; identifier?: string }) => {
          reads.push(String(tx.hash));
          const t = txs.find((x) => x.hash === tx.hash);
          if (!t) throw new NoteIndexUnreadable('not held');
          if (t.events instanceof Error) throw t.events;
          return t.events;
        },
      } satisfies NoteEvents,
    };
  };

  it('names the one listed transaction whose events answer all three questions for the note, and no other', async () => {
    const mine = await vaultNoteCommitment(COIN, VAULT);
    const chain = chainOf([
      { hash: H(0x31), events: [output('f0'.repeat(32), 9n, VAULT, H(0x31))] },
      { hash: H(0x32), events: [input(H(0x32)), output(mine, 616n, VAULT, H(0x32))] },
      { hash: H(0x33), events: [output('f1'.repeat(32), 2n, VAULT, H(0x33))] },
    ]);
    const got = await creatingTransactionsAmong(VAULT as Hex, [COIN], chain);
    expect(
      got.found,
      'RED WHEN: a listed transaction is recorded without its events carrying this note\'s output for this vault -- the first one listed, say -- which makes the note read as healthy until the spend',
    ).toEqual([{ nonce: COIN.nonce, createdIn: H(0x32) }]);
    expect(got.listed).toBe(3);
  });

  it('NEVER records a transaction that carries the commitment for a different contract, and says why', async () => {
    const mine = await vaultNoteCommitment(COIN, VAULT);
    const chain = chainOf([{ hash: H(0x41), events: [output(mine, 7n, OTHER_VAULT, H(0x41))] }]);
    const got = await creatingTransactionsAmong(VAULT as Hex, [COIN], chain);
    expect(
      'createdIn' in got.found[0]!,
      'RED WHEN: the three questions are skipped for a transaction that merely carries the commitment, so an output owned by another contract is recorded as this vault\'s',
    ).toBe(false);
    expect(
      (got.found[0] as { unresolved: string }).unresolved,
      'RED WHEN: a candidate that carried the commitment and was refused is dropped silently, so the operator is told only that nothing answered',
    ).toMatch(/carries it and was refused: .*different contract/);
  });

  it('refuses an answer about a different transaction than the one asked, even when it carries the note', async () => {
    const mine = await vaultNoteCommitment(COIN, VAULT);
    const chain = chainOf([{ hash: H(0x42), events: [output(mine, 7n, VAULT, H(0x43))] }]);
    const got = await creatingTransactionsAmong(VAULT as Hex, [COIN], chain);
    expect(
      got.found[0],
      'RED WHEN: the three questions stop comparing every event\'s transaction with the one asked about, so an answer about another transaction gives this note a hash',
    ).not.toHaveProperty('createdIn');
  });

  it('reads newest first and STOPS once every note is answered', async () => {
    const mine = await vaultNoteCommitment(COIN, VAULT);
    const chain = chainOf([
      { hash: H(0x51), events: [output(mine, 3n, VAULT, H(0x51))] },
      { hash: H(0x52), events: [output('f0'.repeat(32), 1n, VAULT, H(0x52))] },
      { hash: H(0x53), events: [output('f1'.repeat(32), 0n, VAULT, H(0x53))] },
    ]);
    const got = await creatingTransactionsAmong(VAULT as Hex, [COIN], chain);
    expect(got.found).toEqual([{ nonce: COIN.nonce, createdIn: H(0x51) }]);
    expect(
      chain.reads,
      'RED WHEN: the search reads every transaction the vault has ever had after the note is answered -- one indexer request per payroll payment, for nothing',
    ).toEqual([H(0x51)]);
    expect(got.read).toBe(1);
  });

  it('a transaction that could not be read is skipped, NAMED in what is left unanswered, and the search goes on', async () => {
    const mine = await vaultNoteCommitment(COIN, VAULT);
    const chain = chainOf([
      { hash: H(0x61), events: new NoteIndexUnreadable('the indexer is behind') },
      { hash: H(0x62), events: [output(mine, 3n, VAULT, H(0x62))] },
    ]);
    const got = await creatingTransactionsAmong(VAULT as Hex, [COIN, OTHER], chain);
    expect(
      got.found[0],
      'RED WHEN: one unreadable transaction stops the search, so a note a later transaction answers for is left unspendable',
    ).toEqual({ nonce: COIN.nonce, createdIn: H(0x62) });
    const left = (got.found[1] as { unresolved: string }).unresolved;
    expect(
      left,
      'RED WHEN: an unreadable candidate is treated as one that did not create the note, so the reason reads as final when reading again could answer',
    ).toMatch(/1 of them could not be read, so they were never asked: 6161616161616161… \(the indexer is behind\)/);
    expect(left).toMatch(/none of the 2 transaction\(s\) the chain lists for this vault answered for it/);
  });

  it('a list the chain cannot give leaves every note unanswered with the reason, and throws nothing', async () => {
    const chain = {
      transactions: { of: async () => { throw new NoteIndexUnaskable('Cannot query field "contractActions"'); } },
      events: { eventsOf: async () => { throw new Error('never asked'); } },
    };
    const got = await creatingTransactionsAmong(VAULT as Hex, [COIN, OTHER], chain)
      .then((r) => r, (e: Error) => ({ threw: e.message, found: [] as never[] }));
    expect(
      got,
      'RED WHEN: a listing failure throws, so the rebuild stops and the notes it recovered are not written at all',
    ).not.toHaveProperty('threw');
    expect(
      got.found.map((f) => 'unresolved' in f && f.unresolved),
      'RED WHEN: a listing failure throws, so the rebuild stops and the notes it recovered are not written at all -- money named by a journal and then left unnamed',
    ).toEqual([
      expect.stringMatching(/could not list the transactions that acted on this vault \(Cannot query field/),
      expect.stringMatching(/could not list/),
    ]);
  });

  it('asks the chain NOTHING when no note needs asking', async () => {
    const chain = chainOf([]);
    const got = await creatingTransactionsAmong(VAULT as Hex, [], chain);
    expect(got).toEqual({ found: [], listed: 0, read: 0 });
    expect(chain.listings(), 'RED WHEN: a pool that already names every transaction still costs a listing of the vault\'s whole history').toBe(0);
  });

  it('does not swallow an error that is not about the chain', async () => {
    const chain = chainOf([{ hash: H(0x71), events: new TypeError('a bug, not a chain') }]);
    await expect(
      creatingTransactionsAmong(VAULT as Hex, [COIN], chain),
      'RED WHEN: every error is turned into an unanswered note, so a defect in this client reads as the indexer being behind',
    ).rejects.toThrow(TypeError);
  });

  it('A NOTE LEFT UNANSWERED CARRIES, IN FULL, EVERY TRANSACTION A PERSON COULD NAME FOR IT: two transactions, one carrying the note and refused, one unreadable', async () => {
    const mine = await vaultNoteCommitment(COIN, VAULT);
    const chain = chainOf([
      { hash: H(0x91), events: [output(mine, 7n, OTHER_VAULT, H(0x91))] },
      { hash: H(0x92), events: new NoteIndexUnreadable('the indexer is behind') },
      { hash: H(0x93), events: [output('f2'.repeat(32), 1n, VAULT, H(0x93))] },
    ]);
    const got = await creatingTransactionsAmong(VAULT as Hex, [COIN], chain);
    const left = got.found[0] as { unresolved: string; candidates: readonly string[] };
    expect(
      left.candidates,
      'RED WHEN: the refusal says "name the transaction" and nothing hands the person a whole hash to name -- the sentence shortens every hash to sixteen characters',
    ).toEqual([H(0x91), H(0x92)]);
    expect(left.candidates.every((c) => c.length === 64)).toBe(true);
    expect(left.candidates, 'RED WHEN: a transaction that does not carry the note is offered as the one that created it').not.toContain(H(0x93));
  });

  it('offers no candidate when the chain could not list the vault\'s transactions at all', async () => {
    const chain = {
      transactions: { of: async () => { throw new NoteIndexUnreadable('behind'); } },
      events: { eventsOf: async () => { throw new Error('never asked'); } },
    };
    const got = await creatingTransactionsAmong(VAULT as Hex, [COIN], chain);
    expect((got.found[0] as { candidates: readonly string[] }).candidates).toEqual([]);
  });

  it('establishCreatingTransaction is the three questions and the hash, and nothing else', async () => {
    const mine = await vaultNoteCommitment(COIN, VAULT);
    expect(establishCreatingTransaction(
      [output(mine, 12n, VAULT, H(0x81))], { vault: VAULT as Hex, commitment: mine, transaction: { hash: H(0x81) } },
    )).toEqual({ index: 12n, createdIn: H(0x81) });
    expect(() => establishCreatingTransaction(
      [output(mine, 12n, VAULT, H(0x81))], { vault: VAULT as Hex, commitment: mine, transaction: { hash: 'not-a-hash' as Hex } },
    ), 'RED WHEN: the hash is recorded without the shape a spend can read it in').toThrow(NoteIndexRefused);
  });
});

describe('§7a the transaction that created an output, found by the output alone', () => {
  const H = (n: number) => n.toString(16).padStart(2, '0').repeat(32) as Hex;
  const COIN = { nonce: '6a'.repeat(32) as Hex, token: 'aa'.repeat(32) as Hex, value: 300n };
  const chainOf = (txs: Array<{ hash: Hex; events: ServedEvent[] | Error }>) => {
    const reads: string[] = [];
    return {
      reads,
      transactions: { of: async (v: Hex) => { reads.push(`list ${v.slice(0, 2)}`); return txs.map((t) => t.hash); } },
      events: {
        eventsOf: async (tx: { hash?: string; identifier?: string }) => {
          reads.push(String(tx.hash).slice(0, 2));
          const t = txs.find((x) => x.hash === tx.hash)!;
          if (t.events instanceof Error) throw t.events;
          return t.events;
        },
      } satisfies NoteEvents,
    };
  };

  it('ANSWERS THE NEWEST OF THE VAULT\'S OWN TRANSACTIONS WHOSE EVENTS CARRY THE OUTPUT FOR THIS VAULT, AND STOPS THERE', async () => {
    const mine = await vaultNoteCommitment(COIN, VAULT);
    const chain = chainOf([
      { hash: H(0x51), events: [output('f0'.repeat(32), 9n, VAULT, H(0x51))] },
      { hash: H(0x52), events: [input(H(0x52)), output(mine.toUpperCase(), 3n, VAULT.toUpperCase() as Hex, H(0x52))] },
      { hash: H(0x53), events: [output(mine, 4n, VAULT, H(0x53))] },
    ]);
    const got = await transactionThatCreatedOutput(VAULT as Hex, `0x${mine}`, chain);
    /* RED WHEN: a transaction is answered whose events do not carry the output, or the list is read past the answer. */
    expect(got?.transactionHash).toBe(H(0x52));
    expect(got?.events).toHaveLength(2);
    expect(chain.reads).toEqual([`list ${VAULT.slice(0, 2)}`, '51', '52']);
  });

  it('NEVER ANSWERS AN OUTPUT OF THIS COMMITMENT MADE FOR ANOTHER CONTRACT, OR ANY OTHER EVENT CARRYING IT', async () => {
    const mine = await vaultNoteCommitment(COIN, VAULT);
    const chain = chainOf([
      { hash: H(0x61), events: [output(mine, 1n, OTHER_VAULT, H(0x61))] },
      { hash: H(0x62), events: [{ transactionHash: H(0x62), details: { tag: 'zswapInput', commitment: mine, contract: VAULT } }] },
    ]);
    /* RED WHEN: the owner is not compared, or any event tag carrying the commitment is taken as its output. */
    expect(await transactionThatCreatedOutput(VAULT as Hex, mine, chain)).toBeNull();
  });

  it('A TRANSACTION THAT CANNOT BE READ IS NOT ONE THAT DID NOT CREATE IT: WITH NOTHING ELSE ANSWERING, IT IS NOT YET, NOT NONE', async () => {
    const mine = await vaultNoteCommitment(COIN, VAULT);
    const unread = chainOf([
      { hash: H(0x71), events: new NoteIndexUnreadable('not held yet') },
      { hash: H(0x72), events: [output('f2'.repeat(32), 1n, VAULT, H(0x72))] },
    ]);
    /* RED WHEN: an unread transaction is skipped and the answer is "none" - the payment it made would be forgotten. */
    await expect(transactionThatCreatedOutput(VAULT as Hex, mine, unread)).rejects.toBeInstanceOf(NoteIndexUnreadable);
    const readLater = chainOf([
      { hash: H(0x73), events: new NoteIndexUnreadable('not held yet') },
      { hash: H(0x74), events: [output(mine, 1n, VAULT, H(0x74))] },
    ]);
    expect((await transactionThatCreatedOutput(VAULT as Hex, mine, readLater))?.transactionHash).toBe(H(0x74));
    /* Anything else is not the chain being slow, and is not swallowed. */
    await expect(transactionThatCreatedOutput(VAULT as Hex, mine, chainOf([{ hash: H(0x75), events: new Error('a bug') }])))
      .rejects.toThrow('a bug');
  });
});

describe('§8 the transactions that acted on a vault, from the indexer', () => {
  const H = (n: number) => n.toString(16).padStart(2, '0').repeat(32);

  /** A socket that speaks `graphql-transport-ws` from a script, and remembers what it was sent. */
  const scriptedSocket = (script: (subscribe: any) => unknown[], opts: { ack?: boolean } = {}) => {
    const sent: any[] = [];
    let closed = 0;
    const open = () => {
      const s: IndexerSocket = {
        onopen: null, onmessage: null, onerror: null, onclose: null,
        send: (data: string) => {
          const m = JSON.parse(data);
          sent.push(m);
          const reply = (msgs: unknown[]) => setTimeout(() => {
            for (const r of msgs) s.onmessage?.({ data: JSON.stringify(r) });
          }, 0);
          if (m.type === 'connection_init' && opts.ack !== false) reply([{ type: 'connection_ack' }]);
          if (m.type === 'subscribe') reply(script(m));
        },
        close: () => { closed += 1; },
      };
      setTimeout(() => s.onopen?.({}), 0);
      return s;
    };
    return { open, sent, closed: () => closed };
  };
  const action = (hash: string) => ({ id: '1', type: 'next', payload: { data: { contractActions: { transaction: { hash } } } } });
  const latestIs = (hash: string | null) => indexerAnswering(
    { data: { contractAction: hash === null ? null : { transaction: { hash } } } });

  it('lists every transaction up to the latest one, newest first, and asks from the first block', async () => {
    const latest = latestIs(H(0x03));
    const socket = scriptedSocket(() => [action(H(0x01)), action(H(0x02)), action(H(0x02)), action(H(0x03)), action(H(0x04))]);
    const list = await indexerVaultTransactions('https://i/graphql', 'wss://i/ws', { post: latest.post, open: socket.open })
      .of(('0x' + VAULT.toUpperCase()) as Hex);
    expect(
      list,
      'RED WHEN: the list is returned oldest first, or carries a duplicate, or runs past the transaction the indexer named as latest',
    ).toEqual([H(0x03), H(0x02), H(0x01)]);
    const subscribe = socket.sent.find((m) => m.type === 'subscribe');
    expect(subscribe.payload.query).toMatch(/contractActions\(address: \$a/);
    expect(
      subscribe.payload.variables,
      'RED WHEN: the subscription starts anywhere but the first block -- omitted, it starts at the latest one and lists nothing that came before',
    ).toEqual({ a: VAULT, o: { height: 0 } });
    expect(latest.asked[0].variables).toEqual({ a: VAULT });
    expect(socket.closed(), 'RED WHEN: the subscription is left open after the answer').toBeGreaterThan(0);
  });

  it('REFUSES a list that ended before the latest transaction, rather than answering a short one', async () => {
    const socket = scriptedSocket(() => [action(H(0x01)), { id: '1', type: 'complete' }]);
    await expect(
      indexerVaultTransactions('u', 'w', { post: latestIs(H(0x03)).post, open: socket.open }).of(VAULT as Hex),
      'RED WHEN: a list that never reached the latest transaction is returned, so a note it created is reported as created by none of them',
    ).rejects.toThrow(/stopped before the latest one \(the subscription ended\), after 1 transaction/);
  });

  it('a list that never comes is "could not read" after the time allowed', async () => {
    const socket = scriptedSocket(() => []);
    const failed = await indexerVaultTransactions('u', 'w', { post: latestIs(H(0x03)).post, open: socket.open, timeoutMs: 30 })
      .of(VAULT as Hex).then(() => null, (e: Error) => e);
    expect(failed, 'RED WHEN: a silent indexer hangs the rebuild for ever').toBeInstanceOf(NoteIndexUnreadable);
    expect((failed as Error).message).toMatch(/no answer within/);
  });

  it('a question the indexer will not take is the third answer, over either transport', async () => {
    const socket = scriptedSocket(() => [{ id: '1', type: 'error', payload: [{ message: 'Unknown argument "offset" on field "contractActions".' }] }]);
    const failed = await indexerVaultTransactions('u', 'w', { post: latestIs(H(0x03)).post, open: socket.open })
      .of(VAULT as Hex).then(() => null, (e: Error) => e);
    expect(failed, 'RED WHEN: a schema the client is out of step with is reported as the chain being behind').toBeInstanceOf(NoteIndexUnaskable);

    const refusingHttp = indexerAnswering({ errors: [{ message: 'Cannot query field "contractAction" on type "Query".' }] });
    const early = await indexerVaultTransactions('u', 'w', { post: refusingHttp.post, open: socket.open })
      .of(VAULT as Hex).then(() => null, (e: Error) => e);
    expect(early).toBeInstanceOf(NoteIndexUnaskable);
  });

  it('no latest transaction, or a malformed hash anywhere, is "could not read" and lists nothing', async () => {
    const never = scriptedSocket(() => [action(H(0x03))]);
    await expect(indexerVaultTransactions('u', 'w', { post: latestIs(null).post, open: never.open }).of(VAULT as Hex))
      .rejects.toThrow(NoteIndexUnreadable);
    expect(never.sent, 'RED WHEN: the subscription is opened for a vault the indexer says has no transaction').toHaveLength(0);
    await expect(
      indexerVaultTransactions('u', 'w', { post: latestIs('0x').post, open: never.open, timeoutMs: 50 }).of(VAULT as Hex),
      'RED WHEN: a latest transaction with no usable hash is accepted, so nothing can tell when the list is complete',
    ).rejects.toThrow(/without a hash of sixty-four hex characters/);
    const bad = scriptedSocket(() => [action('abc'), action(H(0x03))]);
    await expect(
      indexerVaultTransactions('u', 'w', { post: latestIs(H(0x03)).post, open: bad.open }).of(VAULT as Hex),
      'RED WHEN: a listed transaction with no usable hash is passed on as a candidate',
    ).rejects.toThrow(/a transaction without a hash of sixty-four hex characters/);
  });
});
