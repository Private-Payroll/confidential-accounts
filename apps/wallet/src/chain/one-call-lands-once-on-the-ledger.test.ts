// @vitest-environment node
/**
 * **THE TWO LEDGER FACTS A CALL SENT AROUND A SERVICE THAT GAVE NO ANSWER RESTS ON, READ OFF THE INSTALLED LEDGER.**
 *
 * The wallet looks for its call on the chain by the identifiers of the call as it was proven, before any fee was
 * added, and when the call is not there it sends that same call itself. That is safe only if (1) the transaction
 * that reaches the chain carries those identifiers whichever way its fee was paid, and (2) the ledger takes one call
 * once: a second transaction carrying the same call with another fee is refused whole. Both are run here on the
 * ledger itself. The calls are built without proofs: no contract proof can be made in a test, and a call's
 * identifiers and the hash the ledger keeps for it are taken from its binding, never from its proofs.
 */
import { describe, expect, it } from 'vitest';
import { Intent, LedgerState, Transaction, TransactionContext, WellFormedStrictness } from '@midnightntwrk/ledger-v9';

const NOW = Date.now();
const TTL = new Date(NOW + 10 * 60_000);
/** One intent in its own segment, as the call is in segment 1 and a fee is added in a segment of its own. */
const intentIn = (segment: number) => Transaction.fromParts('undeployed').addIntent({ tag: 'specific', value: segment }, Intent.new(TTL));

describe('THE CALL IS KNOWN ON THE CHAIN BY WHAT THE WALLET HOLDS, WHOEVER PAID ITS FEE', () => {
  it('the identifiers of the call before its fee are among those of the bound transaction, its fee merged either way', () => {
    const call = intentIn(1);
    const held = call.identifiers();
    expect(held.length).toBeGreaterThan(0);
    /* What the wallet holds is the call written out before binding; read back, it names the same identifiers. */
    const read = Transaction.deserialize('signature', 'pre-proof', 'pre-binding', call.serialize());
    /* RED WHEN: a call read back from its bytes is looked for by other identifiers than the call itself carries. */
    expect(read.identifiers()).toEqual(held);
    /* The person's own DUST: the call bound, then the fee's transaction merged in. The sponsorship finishes it the same way. */
    const ownDust = call.bind().merge(intentIn(2).bind());
    /* Bound with its fee merged before binding. */
    const mergedFirst = call.merge(intentIn(2)).bind();
    for (const [how, sent] of [['bound, then the fee merged', ownDust], ['the fee merged, then bound', mergedFirst]] as const) {
      const onTheWire = Transaction.deserialize('signature', 'pre-proof', 'binding', sent.serialize());
      /* RED WHEN: the transaction that reaches the chain does not carry the identifiers the wallet looks for. */
      for (const id of held) expect(onTheWire.identifiers(), how).toContain(id);
    }
    /* RED WHEN: another call of the same shape could be mistaken for this one. */
    expect(intentIn(1).identifiers()).not.toEqual(held);
  });
});

describe('THE LEDGER TAKES ONE CALL ONCE, WHATEVER FEE CAME WITH IT', () => {
  const strictness = (): WellFormedStrictness => {
    const s = new WellFormedStrictness();
    s.enforceBalancing = false;
    s.verifyNativeProofs = false;
    s.verifyContractProofs = false;
    s.verifySignatures = false;
    s.enforceLimits = false;
    return s;
  };
  const seconds = BigInt(Math.floor(NOW / 1000));
  const contextOf = (state: LedgerState) => new TransactionContext(state, {
    secondsSinceEpoch: seconds, secondsSinceEpochErr: 10, parentBlockHash: '00'.repeat(32), lastBlockTime: seconds - 6n,
  });
  const applied = (state: LedgerState, tx: ReturnType<typeof intentIn>) => {
    const sent = tx.eraseProofs();
    return state.apply(sent.wellFormed(state, strictness(), new Date(NOW)), contextOf(state));
  };

  it('a second transaction carrying the same call with another fee is refused whole, and changes nothing', () => {
    const call = intentIn(1);
    const first = call.merge(intentIn(2));
    const second = call.merge(intentIn(2));
    /* The two differ in their fee alone. */
    expect(first.identifiers()).not.toEqual(second.identifiers());
    const blank = LedgerState.blank('undeployed');
    const [after, landed] = applied(blank, first);
    /* RED WHEN: the first copy of the call does not land, so nothing here is measured. */
    expect(landed.type).toBe('success');
    const [still, again] = applied(after, second);
    /* RED WHEN: the ledger lands one call twice because its second copy came with a different fee. */
    expect(again.type).toBe('failure');
    expect(again.error).toMatch(/replay protection has been violated: IntentAlreadyExists/u);
    /* RED WHEN: the refused copy leaves anything behind on the ledger, a fee included. */
    expect(Buffer.from(still.serialize()).equals(Buffer.from(after.serialize()))).toBe(true);
    /* RED WHEN: the ledger refuses every later call, not just the same one again, so the refusal says nothing about this call. */
    expect(applied(after, intentIn(1).merge(intentIn(2)))[1].type).toBe('success');
  });
});
