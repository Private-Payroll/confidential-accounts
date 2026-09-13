/**
 * **THE INDEX READER, AGAINST A REAL SETTLED TRANSACTION, WITH A KNOWN ANSWER.**
 *
 * Every other test of this reader builds its own events and then reads them
 * back, so it establishes that the reader is self-consistent. **That is not the
 * same claim as the reader being right about a chain.** A reader that agreed
 * with itself and disagreed with the ledger would pass all of them.
 *
 * So this file is a POSITIVE CONTROL and it is the only kind that answers:
 * three events, recorded verbatim off the chain as the indexer served them for
 * one transaction that really settled, and one number the reader must produce.
 * The number was established twice by two different means before this file
 * existed — once by walking the ledger's events by hand, and once by putting
 * these bytes through this reader — and the two agree.
 *
 * **A CONTROL THAT ONLY PASSES IS HALF A CONTROL.** Four addresses that all
 * hold nothing answer the same as a reader that is broken, and an empty answer
 * that everybody reads as "no money" is how a treasury nobody can read looks
 * like a treasury holding nothing. So every case below that can refuse is here
 * with its refusal, taken from these same real bytes: the output this vault
 * does not own, the output no contract owns, a commitment this transaction
 * never created, and no answer at all.
 *
 * **THE BYTES ARE FROZEN ON PURPOSE AND THE TEST NEVER ASKS THE NETWORK.** A
 * test that reached a live indexer would be a test of today's network, would
 * fail on an aeroplane, and would stop being a control the day the record was
 * pruned.
 */
import { describe, it, expect } from 'vitest';
import { noteIndexFrom, NoteIndexRefused, NoteIndexUnreadable, type ServedEvent } from './note-index.js';
import type { Hex } from '../core/crypto.js';

/**
 * The three zswap events of one settled transaction, each exactly as the
 * indexer serves it: one serialised ledger event, hex encoded.
 *
 * That transaction paid a private note into a vault. It produced one input, one
 * output owned by the vault, and one output owned by nobody on chain — which is
 * the change going back to the wallet that funded it.
 */
const SERVED_RAW = [
  '6d69646e696768743a6576656e745b7631345d3a040019016519fd029e9d51bba5929465844ef71d0faed4de7894283cc8b02f43f205d524000000000056ec0d7656a09fe2ebd74a6f9ccf097684b6138e524c18231af77e00fde107b301',
  '6d69646e696768743a6576656e745b7631345d3a08008082e1dde93f015c4f3cf6d229b2e422f49aeec2438235786fe441e47e6e7cfaea040025016519fd029e9d51bba5929465844ef71d0faed4de7894283cc8b02f43f205d5240000000001e0ad5f5fc68fa7e19fc074a547d1cc40bcdf89f6f5f63d645dfaac4b6fa53b9c0200a109',  // not-a-secret: a deployed contract address on a test network, published by the chain itself and readable by anyone; it is here because a real settled event names the contract it paid, and this file is withheld from the published set for exactly that reason
  '6d69646e696768743a6576656e745b7631345d3a0400bd046519fd029e9d51bba5929465844ef71d0faed4de7894283cc8b02f43f205d5240000000001f5510cab4b94397caa2819678c120be79823d60a8d7aba0e01f2bb7940ee31e0001f259af84a85869c8ca3045ceb895f966f4083b42c2a50c57e67312354f66695734254de6352c91606ca735cdd4ea89aa5915b29748eb607b15711866e23ef2b6f73dda4ed14de20bd79a8be5eb087e91be884893af04e15ba90ee1b564fff4c2926738867e1d1ef772f6e4944e4250c301703b0eabce2293cdc57e69a1e4bbb06253f7355dc4160fa099bdb3844dee75a598c379092beaeffac2e67bc36426965df2470731c77e9fd4ce36948e5db2faf3dde810140b65de92f93784af07e0b0d3b7f496d73971bcac14cd967eeb8f7c6518959007ea3cb29122e587ffeb9faa9f96799c56801a509',
] as const;

const TRANSACTION = { hash: '6519fd029e9d51bba5929465844ef71d0faed4de7894283cc8b02f43f205d524' as Hex };
const VAULT = '82e1dde93f015c4f3cf6d229b2e422f49aeec2438235786fe441e47e6e7cfaea' as Hex;  // not-a-secret: a deployed contract address on a test network, published by the chain itself and readable by anyone; it is here because a real settled event names the contract it paid, and this file is withheld from the published set for exactly that reason
/** The output that transaction created FOR the vault. */
const THE_VAULTS_OUTPUT = 'e0ad5f5fc68fa7e19fc074a547d1cc40bcdf89f6f5f63d645dfaac4b6fa53b9c';
/** The output it created for nobody on chain: the funding wallet's change. */
const SOMEBODY_ELSES_OUTPUT = 'f5510cab4b94397caa2819678c120be79823d60a8d7aba0e01f2bb7940ee31e0';
/** What the ledger assigned the vault's output, established independently. */
const THE_ANSWER = 616n;

/**
 * The events as `indexerNoteEvents` hands them on: deserialised by the ledger,
 * reduced to a hash and the event's own content. Deserialised here rather than
 * written out as objects, so the shape under test is the ledger's shape and not
 * one this file imagines.
 */
async function served(): Promise<ServedEvent[]> {
  const { Event } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
  return SERVED_RAW.map((hex) => {
    const event: any = Event.deserialize(Uint8Array.from(Buffer.from(hex, 'hex')));
    return { transactionHash: String(event.source.transactionHash), details: event.content };
  });
}

describe('the index reader, against events a chain really produced', () => {
  it('deserialises all three, and they all name the one transaction', async () => {
    /* RED WHEN: the ledger's event encoding changes under us, or `Event.content`
     * stops carrying `transactionHash` on its source. Either makes every
     * reading below a reading of nothing, and this is the assertion that says
     * so rather than letting the refusals below look like correct refusals. */
    const events = await served();
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.transactionHash))).toEqual(new Set([TRANSACTION.hash]));
  });

  it('the events carry one input and two outputs, and only one output is a contract\'s', async () => {
    /* RED WHEN: the tags or the `contract` field move. A reader that saw no
     * contract on any output would refuse everything, and refusing everything
     * passes every negative test there is. */
    const events = await served();
    expect(events.map((e) => e.details.tag)).toEqual(['zswapInput', 'zswapOutput', 'zswapOutput']);
    expect(events.filter((e) => typeof e.details.contract === 'string')).toHaveLength(1);
  });

  it('READS THE INDEX THE LEDGER ASSIGNED, AND IT IS THE NUMBER MEASURED OFF THE CHAIN', async () => {
    /* RED WHEN: `noteIndexFrom` returns anything but the ledger's own `mtIndex`
     * — a count of events, a position in the offer, or a number derived from
     * either. Each of those is right in a transaction with one offer and wrong
     * the moment there are two, and this transaction has an input, so the
     * output's position and its index are different numbers.
     *
     * THIS IS THE ASSERTION THE WHOLE FILE EXISTS FOR: a known answer, from a
     * chain, through the product's own code. */
    const index = noteIndexFrom(await served(), {
      vault: VAULT, commitment: THE_VAULTS_OUTPUT, transaction: TRANSACTION,
    });
    expect(index).toBe(THE_ANSWER);
  });

  it('and the index is NOT the output\'s position, which is what a guess would give', async () => {
    /* RED WHEN: the read is replaced by a count of outputs or a position in the
     * offer. The two agree in a toy transaction; they do not agree in these
     * bytes, which is why these are the bytes recorded -- the vault's output is
     * FIRST among the outputs and SIX HUNDRED AND SIXTEENTH in the tree. */
    const events = await served();
    const positionAmongOutputs = BigInt(events.filter((e) => e.details.tag === 'zswapOutput')
      .findIndex((e) => e.details.commitment === THE_VAULTS_OUTPUT));
    expect(positionAmongOutputs).toBe(0n);
    /* The product function is called here on purpose. An earlier version of this
     * assertion compared two values the test itself had computed, so no change to
     * the reader could turn it red -- it was a comment with an expect around it. */
    expect(noteIndexFrom(events, {
      vault: VAULT, commitment: THE_VAULTS_OUTPUT, transaction: TRANSACTION,
    })).not.toBe(positionAmongOutputs);
  });

  it('REFUSES the output this vault does not own, rather than reading its index', async () => {
    /* RED WHEN: the owning-contract check is dropped. That check is the whole
     * difference between this vault's money and somebody else's: the change
     * output below sits in the same transaction and has an index of its own. */
    const events = await served();
    expect(() => noteIndexFrom(events, {
      vault: VAULT, commitment: SOMEBODY_ELSES_OUTPUT, transaction: TRANSACTION,
    })).toThrow(NoteIndexRefused);
  });

  it('REFUSES this vault\'s own output when a different vault claims it', async () => {
    /* RED WHEN: the contract comparison stops comparing. A vault that could
     * read another vault's index would build a spend against a note it does
     * not hold, and the refusal would come from a prover rather than here. */
    const events = await served();
    expect(() => noteIndexFrom(events, {
      vault: ('11'.repeat(32)) as Hex, commitment: THE_VAULTS_OUTPUT, transaction: TRANSACTION,
    })).toThrow(/for a different contract/);
  });

  it('REFUSES a commitment this transaction never created, and says which it was asked about', async () => {
    /* RED WHEN: an unmatched commitment stops refusing, or the refusal stops
     * naming the transaction — which is the one thing the reader knows and the
     * person does not. */
    const events = await served();
    expect(() => noteIndexFrom(events, {
      vault: VAULT, commitment: 'ab'.repeat(32), transaction: TRANSACTION,
    })).toThrow(/did not create this note/);
  });

  it('CALLS AN EMPTY ANSWER UNREADABLE AND NOT EMPTY, which is the difference that loses money', async () => {
    /* RED WHEN: no events becomes an answer instead of a silence. A chain that
     * has not caught up and a chain that says no are opposite claims, and
     * treating the first as the second is a vault reported as holding nothing. */
    expect(() => noteIndexFrom([], {
      vault: VAULT, commitment: THE_VAULTS_OUTPUT, transaction: TRANSACTION,
    })).toThrow(NoteIndexUnreadable);
  });
});
