/**
 * **WHETHER THE CHAIN SHOWS ONE VAULT CALL OF A TRANSACTION THIS DEVICE HOLDS, AS THE VAULT WORKER LOOKS FOR IT.**
 *
 * The worker is handed the transaction exactly as the person's wallet signed it and the indexer the wallet names. It
 * reads the transaction's identifiers and the part that carries the vault's call from those bytes, and asks that
 * indexer for the transactions carrying them; the call counts as landed only when the part carrying it was applied,
 * and as refused when the chain took the transaction and that part failed. The ledger and the indexer are stood in
 * here; the indexer's own question is read off what is posted to it.
 */
import { describe, it, expect } from 'vitest';
import { answerVaultAsk } from './vault-worker-entry.js';
import type { VaultAsk } from './vault-worker-client.js';
import {
  indexerTransactionsByIdentifier, NoteIndexUnaskable, NoteIndexUnreadable, vaultCallOnChain, type TransactionByIdentifier,
} from '../../../src/midnight/note-index.js';

const VAULT = 'ab'.repeat(32);
const OTHER_VAULT = 'ee'.repeat(32);
const SIGNED = btoa('the deposit as the wallet signed it');
const INDEXER = { indexerUri: 'https://indexer.example/api/v4/graphql', indexerWsUri: 'wss://indexer.example/api/v4/graphql/ws' };
/* An identifier of the transaction the wallet signed, and one of somebody else's. */
const MINE = `00${'11'.repeat(32)}`;
const ANOTHERS = `00${'22'.repeat(32)}`;
const HASH = 'c4'.repeat(32);
const DEPOSIT = ['depositUnshielded'];

const deposit = (over: Partial<TransactionByIdentifier> = {}): TransactionByIdentifier => ({
  hash: HASH, status: 'SUCCESS', segments: null, calls: [{ address: VAULT, entryPoint: 'depositUnshielded' }], ...over,
});
/* The deposit's one call, as the wallet's bytes carry it: in the part that always runs, or in intent 7's own part. */
const theCall = (parts: { g?: boolean; f?: boolean } = { g: true }) => ({
  address: VAULT, entryPoint: new TextEncoder().encode('depositUnshielded'),
  ...(parts.g ? { guaranteedTranscript: { effects: {} } } : {}), ...(parts.f ? { fallibleTranscript: { effects: {} } } : {}),
});

/** The worker's look, with the indexer `index` standing in, for a signed transaction with `identifiers` and `actions` in intent 7. */
const look = async (
  index: Record<string, TransactionByIdentifier[] | Error>, identifiers: string[] | Error = [MINE],
  actions: unknown[] = [theCall()],
) => {
  const read: unknown[] = [];
  const at: unknown[] = [];
  const asked: string[] = [];
  const ledger = {
    Transaction: {
      deserialize: (...args: unknown[]) => {
        read.push(args);
        if (identifiers instanceof Error) throw identifiers;
        return { identifiers: () => identifiers, intents: new Map([[7, { ttl: new Date(1), actions }]]) };
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
    id: 1, network: 'undeployed', ask: 'vault-call-on-chain', vault: VAULT, entryPoints: DEPOSIT, transaction: SIGNED, indexer: INDEXER,
  } as VaultAsk) as unknown as { seen: ReturnType<typeof vaultCallOnChain> };
  return { seen: answer.seen, read, at, asked };
};

describe('THE WORKER FINDS A VAULT CALL ONLY AS THE TRANSACTION THE WALLET SIGNED', () => {
  it('FINDS IT BY THE IDENTIFIERS OF THE SIGNED BYTES, AT THE INDEXER THE WALLET NAMES, AND ANSWERS THE CHAIN\'S HASH', async () => {
    const { seen, read, at, asked } = await look({ [MINE]: [deposit()] });
    expect(seen).toEqual({ of: 'landed', transactionHash: HASH });
    /* RED WHEN: the signed deposit is read as anything but the finished, bound transaction the wallet handed back. */
    expect(read).toHaveLength(1);
    const [s, p, b, bytes] = read[0] as [string, string, string, Uint8Array];
    expect([s, p, b]).toEqual(['signature', 'proof', 'binding']);
    expect(new TextDecoder().decode(bytes)).toBe('the deposit as the wallet signed it');
    /* RED WHEN: the deposit is looked for at any indexer but the wallet's, or by anything but its own identifier. */
    expect(at).toEqual([INDEXER]);
    expect(asked).toEqual([MINE]);
  });

  it('ANOTHER DEPOSIT OF THE SAME TOKEN AND AMOUNT INTO THE SAME VAULT DOES NOT COUNT', async () => {
    /* RED WHEN: somebody else's deposit, found under their own identifier, is taken for this person's. */
    expect((await look({ [ANOTHERS]: [deposit({ hash: 'd5'.repeat(32) })] })).seen).toEqual({ of: 'not-seen' });
  });

  it('A DEPOSIT WHOSE OWN PART FAILED IS REFUSED AT ONCE, AND ONE WHOSE OWN PART WAS APPLIED HAS LANDED, WHATEVER ELSE FAILED', async () => {
    const inItsOwnPart = [theCall({ f: true })];
    /* RED WHEN: a deposit the chain took and refused is waited for as if it might still arrive. */
    expect((await look({ [MINE]: [deposit({ status: 'PARTIAL_SUCCESS', segments: [{ id: 0, success: true }, { id: 7, success: false }] })] }, [MINE], inItsOwnPart)).seen)
      .toEqual({ of: 'refused', transactionHash: HASH });
    expect((await look({ [MINE]: [deposit({ status: 'FAILURE' })] })).seen).toEqual({ of: 'refused', transactionHash: HASH });
    /* RED WHEN: a deposit the chain applied is read as refused because another part of the transaction failed, and the person puts the money in again. */
    expect((await look({ [MINE]: [deposit({ status: 'PARTIAL_SUCCESS', segments: [{ id: 0, success: true }, { id: 2, success: false }] })] })).seen)
      .toEqual({ of: 'landed', transactionHash: HASH });
    expect((await look({ [MINE]: [deposit({ status: 'PARTIAL_SUCCESS', segments: [{ id: 0, success: true }, { id: 7, success: true }, { id: 2, success: false }] })] }, [MINE], inItsOwnPart)).seen)
      .toEqual({ of: 'landed', transactionHash: HASH });
  });

  it('WHEN WHETHER THE DEPOSIT TOOK EFFECT CANNOT BE TOLD, IT IS NEITHER LANDED NOR REFUSED', async () => {
    for (const [why, found, actions] of [
      ['no result', deposit({ status: null }), [theCall()]],
      ['a partial success with no part results', deposit({ status: 'PARTIAL_SUCCESS', segments: null }), [theCall({ f: true })]],
      ['no result for its own part', deposit({ status: 'PARTIAL_SUCCESS', segments: [{ id: 0, success: true }] }), [theCall({ f: true })]],
      ['split across two parts, one failed', deposit({ status: 'PARTIAL_SUCCESS', segments: [{ id: 0, success: true }, { id: 7, success: false }] }), [theCall({ g: true, f: true })]],
      ['two such calls in the signed bytes', deposit(), [theCall(), theCall()]],
      ['no such call in the signed bytes', deposit(), []],
    ] as const) {
      /* RED WHEN: a deposit whose effect cannot be read is reported as landed, or as refused so that the money is put in again. */
      expect((await look({ [MINE]: [found] }, [MINE], [...actions])).seen.of, why).toBe('not-known');
    }
  });

  it('A TRANSACTION THAT DOES NOT CALL THIS VAULT\'S PUBLIC DEPOSIT DOES NOT COUNT', async () => {
    for (const [why, calls] of [
      ['another vault', [{ address: OTHER_VAULT, entryPoint: 'depositUnshielded' }]],
      ['the private deposit', [{ address: VAULT, entryPoint: 'deposit' }]],
      ['no call', []],
    ] as const) {
      /* RED WHEN: a transaction under this identifier that is not this vault's public deposit is taken for it. */
      expect((await look({ [MINE]: [deposit({ calls: [...calls] })] })).seen, why).toEqual({ of: 'not-seen' });
    }
  });

  it('THE CIRCUITS THAT COUNT ARE THE ONES ASKED FOR, SO A PAYMENT OUT IS JUDGED BY THE SAME READ', () => {
    const payout = [{ address: VAULT, entryPoint: 'payout', segments: [0] }];
    const listed = [deposit({ calls: [{ address: VAULT, entryPoint: 'payout' }] })];
    /* RED WHEN: a payment out of the vault is judged by any circuit but its own. */
    expect(vaultCallOnChain({ vault: VAULT, entryPoints: ['payout'] }, payout, listed)).toEqual({ of: 'landed', transactionHash: HASH });
    expect(vaultCallOnChain({ vault: VAULT, entryPoints: DEPOSIT }, payout, listed).of).toBe('not-known');
  });

  it('EVERY IDENTIFIER OF THE SIGNED DEPOSIT IS ASKED ABOUT UNTIL ONE IS FOUND', async () => {
    const { seen, asked } = await look({ [ANOTHERS]: [deposit()] }, [MINE, ANOTHERS]);
    /* RED WHEN: only the first identifier is asked about, so a deposit the indexer lists under its second is never found. */
    expect(seen).toEqual({ of: 'landed', transactionHash: HASH });
    expect(asked).toEqual([MINE, ANOTHERS]);
  });
});

describe('A LOOK THAT FAILS SAYS WHETHER ASKING AGAIN CAN HELP', () => {
  /* What the page reads off a failed look is the error's name, which the worker client carries across. */
  const nameOf = (e: unknown): string => String((e as Error)?.name);

  it('AN INDEXER THAT COULD NOT BE READ IS NAMED SO, AND ONE THAT REFUSES THE QUESTION, SIGNED BYTES THAT CANNOT BE READ, OR NONE TO LOOK FOR, ARE NOT', async () => {
    /* RED WHEN: an indexer that is down reads as an answer, or as something asking again cannot fix. */
    expect(nameOf(await look({ [MINE]: new NoteIndexUnreadable('the indexer answered HTTP 503') }).catch((e: unknown) => e))).toBe('NoteIndexUnreadable');
    /* RED WHEN: an indexer that will never take the question is asked again and again, ten minutes long. */
    expect(nameOf(await look({ [MINE]: new NoteIndexUnaskable('unknown argument "identifier"') }).catch((e: unknown) => e))).toBe('NoteIndexUnaskable');
    const unreadable = await look({}, new Error('Unable to deserialize Transaction')).catch((e: unknown) => e);
    expect(nameOf(unreadable)).not.toBe('NoteIndexUnreadable');
    expect((unreadable as Error).message).toMatch(/could not be read/);
    const none = await look({}, []).catch((e: unknown) => e);
    expect(nameOf(none)).not.toBe('NoteIndexUnreadable');
    expect((none as Error).message).toMatch(/names no identifier/);
  });
});

describe('THE INDEXER IS ASKED FOR TRANSACTIONS BY IDENTIFIER, WITH THEIR RESULT, EACH PART\'S RESULT AND THEIR CALLS', () => {
  const answering = (body: unknown, status = 200) => {
    const posted: Array<{ url: string; body: { query: string; variables: unknown } }> = [];
    const post = (async (url: string, init: { body: string }) => {
      posted.push({ url, body: JSON.parse(init.body) });
      return { ok: status === 200, status, json: async () => body };
    }) as unknown as typeof fetch;
    return { posted, reader: indexerTransactionsByIdentifier(INDEXER.indexerUri, post) };
  };

  it('ASKS BY THE IDENTIFIER, FOR EACH TRANSACTION\'S RESULT, EACH PART\'S RESULT AND CONTRACT CALLS, AND READS THEM AS SERVED', async () => {
    const { posted, reader } = answering({
      data: {
        transactions: [{
          hash: `0x${HASH.toUpperCase()}`, transactionResult: { status: 'PARTIAL_SUCCESS', segments: [{ id: 0, success: true }, { id: 7, success: false }, { id: 'x', success: true }] },
          contractActions: [{ address: VAULT.toUpperCase(), entryPoint: 'depositUnshielded' }, { address: OTHER_VAULT }],
        }],
      },
    });
    const found = await reader.byIdentifier(` 0x${MINE.toUpperCase()} `);
    /* RED WHEN: the indexer is asked by anything but the identifier, or not asked for the result of each part, so a refused deposit is waited for. */
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe(INDEXER.indexerUri);
    expect(posted[0]!.body.variables).toEqual({ offset: { identifier: MINE } });
    expect(posted[0]!.body.query).toMatch(/transactionResult \{ status segments \{ id success \} \}/);
    expect(posted[0]!.body.query).toMatch(/contractActions \{ address \.\.\. on ContractCall \{ entryPoint \} \}/);
    /* RED WHEN: a hash, address or result is read in another form than the one the page compares. */
    expect(found).toEqual([{
      hash: HASH, status: 'PARTIAL_SUCCESS', segments: [{ id: 0, success: true }, { id: 7, success: false }],
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
