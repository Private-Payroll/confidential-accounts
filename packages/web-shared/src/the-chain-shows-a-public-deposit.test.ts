/**
 * **WHETHER THE CHAIN SHOWS A PUBLIC DEPOSIT, AS THE VAULT WORKER LOOKS FOR IT.**
 *
 * The worker is handed the finished deposit exactly as the person's wallet signed it and the indexer the wallet names.
 * It works out the transaction's identifiers from those bytes and asks that indexer for the transactions carrying them;
 * a deposit counts only when the ledger applied it in full and it calls this vault's public deposit. The ledger and the
 * indexer are stood in here; the indexer's own question is read off what is posted to it.
 */
import { describe, it, expect } from 'vitest';
import { answerVaultAsk } from './vault-worker-entry.js';
import type { VaultAsk } from './vault-worker-client.js';
import {
  indexerTransactionsByIdentifier, NoteIndexUnaskable, NoteIndexUnreadable, type TransactionByIdentifier,
} from '../../../src/midnight/note-index.js';

const VAULT = 'ab'.repeat(32);
const OTHER_VAULT = 'ee'.repeat(32);
const SIGNED = btoa('the deposit as the wallet signed it');
const INDEXER = { indexerUri: 'https://indexer.example/api/v4/graphql', indexerWsUri: 'wss://indexer.example/api/v4/graphql/ws' };
/* The deposit's own identifier, and another deposit's: the same token and amount into the same vault, another transaction. */
const MINE = `00${'11'.repeat(32)}`;
const ANOTHERS = `00${'22'.repeat(32)}`;
const HASH = 'c4'.repeat(32);

const deposit = (over: Partial<TransactionByIdentifier> = {}): TransactionByIdentifier => ({
  hash: HASH, status: 'SUCCESS', calls: [{ address: VAULT, entryPoint: 'depositUnshielded' }], ...over,
});

/** Asks the worker whether the deposit landed, with a stood-in ledger reading `identifiers` off the bytes and an indexer holding `index`. */
const look = async (
  index: Record<string, TransactionByIdentifier[] | Error>, identifiers: string[] | Error = [MINE],
) => {
  const read: unknown[] = [];
  const at: unknown[] = [];
  const asked: string[] = [];
  const ledger = {
    Transaction: {
      deserialize: (...args: unknown[]) => {
        read.push(args);
        if (identifiers instanceof Error) throw identifiers;
        return { identifiers: () => identifiers };
      },
    },
  };
  const deps = async () => ({
    ledger,
    transactionsAt: (i: unknown) => {
      at.push(i);
      return {
        byIdentifier: async (id: string) => {
          asked.push(id);
          const held = index[id] ?? [];
          if (held instanceof Error) throw held;
          return held;
        },
      };
    },
  });
  const answer = await answerVaultAsk(deps as never, {
    id: 1, network: 'undeployed', ask: 'public-deposit-landed', vault: VAULT, transaction: SIGNED, indexer: INDEXER,
  } as VaultAsk) as unknown as { found: { transactionHash: string } | null };
  return { found: answer.found, read, at, asked };
};

describe('THE WORKER FINDS A PUBLIC DEPOSIT ONLY AS THE TRANSACTION THE WALLET SIGNED', () => {
  it('FINDS IT BY THE IDENTIFIERS OF THE SIGNED BYTES, AT THE INDEXER THE WALLET NAMES, AND ANSWERS THE CHAIN\'S HASH', async () => {
    const { found, read, at, asked } = await look({ [MINE]: [deposit()] });
    expect(found).toEqual({ transactionHash: HASH });
    /* RED WHEN: the identifiers are worked out from anything but the finished deposit the wallet signed, read as a finished transaction. */
    expect(read).toHaveLength(1);
    const [s, p, b, bytes] = read[0] as [string, string, string, Uint8Array];
    expect([s, p, b]).toEqual(['signature', 'proof', 'binding']);
    expect(new TextDecoder().decode(bytes)).toBe('the deposit as the wallet signed it');
    /* RED WHEN: the deposit is looked for anywhere but the indexer the wallet names. */
    expect(at).toEqual([INDEXER]);
    expect(asked).toEqual([MINE]);
  });

  it('ANOTHER DEPOSIT OF THE SAME TOKEN AND AMOUNT INTO THE SAME VAULT DOES NOT COUNT', async () => {
    /* RED WHEN: the page looks up any transaction but the one its wallet signed, so another deposit of the same token and amount counts as this one. */
    expect((await look({ [ANOTHERS]: [deposit({ hash: 'd5'.repeat(32) })] })).found).toBeNull();
  });

  it('A TRANSACTION THE LEDGER APPLIED WITH FAILURE, OR ONLY IN PART, DOES NOT COUNT', async () => {
    for (const status of ['FAILURE', 'PARTIAL_SUCCESS', null]) {
      /* RED WHEN: a transaction the indexer lists is believed landed whatever result the ledger applied it with. */
      expect((await look({ [MINE]: [deposit({ status })] })).found, String(status)).toBeNull();
    }
  });

  it('A TRANSACTION THAT DOES NOT CALL THIS VAULT\'S PUBLIC DEPOSIT DOES NOT COUNT', async () => {
    for (const [why, calls] of [
      ['another vault', [{ address: OTHER_VAULT, entryPoint: 'depositUnshielded' }]],
      ['the private deposit', [{ address: VAULT, entryPoint: 'deposit' }]],
      ['no call', []],
    ] as const) {
      /* RED WHEN: the deposit is believed on a transaction that puts nothing into this vault publicly. */
      expect((await look({ [MINE]: [deposit({ calls: [...calls] })] })).found, why).toBeNull();
    }
  });

  it('EVERY IDENTIFIER OF THE SIGNED DEPOSIT IS ASKED ABOUT UNTIL ONE IS FOUND', async () => {
    const { found, asked } = await look({ [ANOTHERS]: [deposit()] }, [MINE, ANOTHERS]);
    /* RED WHEN: only the first identifier is asked about, so a deposit found under another is never seen. */
    expect(found).toEqual({ transactionHash: HASH });
    expect(asked).toEqual([MINE, ANOTHERS]);
  });
});

describe('A LOOK THAT FAILS SAYS WHETHER ASKING AGAIN CAN HELP', () => {
  /* What the page reads of a failure the worker answers with: its name, which the worker passes on unless it is a plain Error. */
  const nameOf = (e: unknown): string => String((e as Error)?.name);

  it('AN INDEXER THAT COULD NOT BE READ IS NAMED SO, AND ONE THAT REFUSES THE QUESTION, SIGNED BYTES THAT CANNOT BE READ, OR NONE TO LOOK FOR, ARE NOT', async () => {
    /* RED WHEN: an indexer that could not be read loses its name, so the page stops waiting for a read that may still come right. */
    expect(nameOf(await look({ [MINE]: new NoteIndexUnreadable('the indexer answered HTTP 503') }).catch((e: unknown) => e))).toBe('NoteIndexUnreadable');
    /* RED WHEN: a question the indexer will never take is passed on as one that may come right, so the page asks it until the wait runs out. */
    expect(nameOf(await look({ [MINE]: new NoteIndexUnaskable('unknown argument "identifier"') }).catch((e: unknown) => e))).toBe('NoteIndexUnaskable');
    /* RED WHEN: bytes that do not read as a finished transaction, or name no identifier, are passed on as an indexer that may answer later. */
    const unreadable = await look({}, new Error('Unable to deserialize Transaction')).catch((e: unknown) => e);
    expect(nameOf(unreadable)).not.toBe('NoteIndexUnreadable');
    const none = await look({}, []).catch((e: unknown) => e);
    expect(nameOf(none)).not.toBe('NoteIndexUnreadable');
    expect((none as Error).message).toMatch(/names no identifier/);
  });
});

describe('THE INDEXER IS ASKED FOR TRANSACTIONS BY IDENTIFIER, WITH THEIR RESULT AND THEIR CALLS', () => {
  const answering = (body: unknown, status = 200) => {
    const posted: Array<{ url: string; body: { query: string; variables: unknown } }> = [];
    const post = (async (url: string, init: { body: string }) => {
      posted.push({ url, body: JSON.parse(init.body) });
      return { ok: status === 200, status, json: async () => body };
    }) as unknown as typeof fetch;
    return { posted, reader: indexerTransactionsByIdentifier(INDEXER.indexerUri, post) };
  };

  it('ASKS BY THE IDENTIFIER, FOR EACH TRANSACTION\'S RESULT AND CONTRACT CALLS, AND READS THEM AS SERVED', async () => {
    const { posted, reader } = answering({
      data: {
        transactions: [{
          hash: `0x${HASH.toUpperCase()}`, transactionResult: { status: 'SUCCESS' },
          contractActions: [{ address: VAULT.toUpperCase(), entryPoint: 'depositUnshielded' }, { address: OTHER_VAULT }],
        }],
      },
    });
    const found = await reader.byIdentifier(` 0x${MINE.toUpperCase()} `);
    /* RED WHEN: the indexer is asked by anything but the identifier, or not asked for the result the ledger applied. */
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe(INDEXER.indexerUri);
    expect(posted[0]!.body.variables).toEqual({ offset: { identifier: MINE } });
    expect(posted[0]!.body.query).toMatch(/transactionResult \{ status \}/);
    expect(posted[0]!.body.query).toMatch(/contractActions \{ address \.\.\. on ContractCall \{ entryPoint \} \}/);
    /* RED WHEN: a hash, address or result is read in another form than the one the page compares. */
    expect(found).toEqual([{
      hash: HASH, status: 'SUCCESS',
      calls: [{ address: VAULT, entryPoint: 'depositUnshielded' }, { address: OTHER_VAULT, entryPoint: null }],
    }]);
  });

  it('AN INDEXER THAT CANNOT BE REACHED, REFUSES, OR ANSWERS WITH NO LIST IS NOT TAKEN AS "NO SUCH TRANSACTION"', async () => {
    for (const [why, body, status] of [
      ['an HTTP failure', {}, 503],
      ['a refusal', { errors: [{ message: 'the database is busy' }] }, 200],
      ['no list', { data: {} }, 200],
    ] as const) {
      /* RED WHEN: a read that gave no answer reads as an empty one, so the page would stop looking as if nothing were there. */
      await expect(answering(body, status).reader.byIdentifier(MINE), why).rejects.toBeInstanceOf(NoteIndexUnreadable);
    }
  });
});
