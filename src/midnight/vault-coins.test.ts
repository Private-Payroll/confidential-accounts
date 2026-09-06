/**
 * **"I COULD NOT READ IT" IS NOT "THERE IS NONE", IN THE MONEY PATH.**
 *
 * This file had no test at all, which is part of why the defect it now pins
 * survived a round that had already fixed the same defect one map along
 *. The only exercise these two readers got was through
 * `contracts/test/vault-payout.test.ts` and `vault-recovery.test.ts`, which
 * drive the real circuits and therefore ALWAYS hand over a well-formed Zswap
 * local state — so the unreadable branch was never once taken, and returning
 * `undefined` from it looked like careful code forever.
 *
 * **THE DISTINCTION IS THE WHOLE SUBJECT**, so both sides are pinned for both
 * readers:
 *
 *   · a PRESENT outputs list with nothing addressed to us — a true statement
 *     about the transaction, answered `undefined`
 *   · a state with no readable outputs — our ignorance, refused by name
 *
 * A test for only the second would pass against a reader that refused
 * everything; a test for only the first is what the old code passed.
 */
import { describe, it, expect } from 'vitest';
import { changeCoinOf, paidCoinTo, UnreadableZswapState } from './vault-coins.js';
import { toHex, type Hex } from '../core/crypto.js';

const bytes = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, () => n);

const VAULT = toHex(bytes(0xa1)) as Hex;
const PAYEE = toHex(bytes(0xb2)) as Hex;
const GBP = toHex(bytes(0xcc)) as Hex;
const NONCE = toHex(bytes(0xdd)) as Hex;

/** An output addressed to a CONTRACT — `is_left` false — as the change is. */
const toContract = (address: Hex, value: bigint) => ({
  recipient: { is_left: false, right: { bytes: Uint8Array.from(Buffer.from(address, 'hex')) } },
  coinInfo: { nonce: bytes(0xdd), color: bytes(0xcc), value },
});

/** An output addressed to a PERSON — `is_left` true — as a payee's is. */
const toPerson = (key: Hex, value: bigint) => ({
  recipient: { is_left: true, left: { bytes: Uint8Array.from(Buffer.from(key, 'hex')) } },
  coinInfo: { nonce: bytes(0xdd), color: bytes(0xcc), value },
});

describe('C197: changeCoinOf tells "no change" apart from "could not read"', () => {
  it('reads the coin the vault kept', async () => {
    const zswap = { outputs: [toContract(VAULT, 800n), toPerson(PAYEE, 200n)] };
    expect(changeCoinOf(zswap, VAULT)).toEqual({ nonce: NONCE, token: GBP, value: 800n });
  });

  it('answers undefined when the outputs are THERE and hold no change', async () => {
    /*
     * The true `undefined`, and the header of `vault-coins.ts` is what defines
     * it: a payment of the whole balance leaves no change and the vault's entry
     * for that token disappears. This is the ONLY thing `undefined` may mean.
     */
    const zswap = { outputs: [toPerson(PAYEE, 1_000n)] };
    expect(changeCoinOf(zswap, VAULT)).toBeUndefined();
  });

  it('answers undefined for an empty outputs list, which is still a state we read', async () => {
    expect(changeCoinOf({ outputs: [] }, VAULT)).toBeUndefined();
  });

  it('REFUSES a state with no readable outputs, rather than saying there was no change', async () => {
    /*
     * **THE DEFECT THIS FILE EXISTS FOR.** Each of these returned `undefined`
     * before `S6c` — indistinguishable, at the call site, from a payout that
     * spent everything — and the pool would then be advanced as though the
     * vault kept nothing. The commitment for the change stays on chain and
     * nobody can ever say which note it describes.
     */
    for (const unreadable of [undefined, null, {}, { outputs: null }, { outputs: 'nope' }, 42]) {
      expect(() => changeCoinOf(unreadable, VAULT)).toThrow(UnreadableZswapState);
      expect(() => changeCoinOf(unreadable, VAULT)).toThrow(/no readable "outputs"/);
      // And it says WHY the distinction matters, in the message a person reads.
      expect(() => changeCoinOf(unreadable, VAULT)).toThrow(/not the same as there being none/);
    }
  });

  it('still refuses when more than one output comes back to the vault', async () => {
    /*
     * `C205`, unchanged by this round and re-pinned here because the refusal
     * above must not be mistaken for it: this one is about a shape we
     * understand and will not guess at, and the obvious "fix" — taking the
     * first — is a pool holding one note where the chain holds two.
     */
    const zswap = { outputs: [toContract(VAULT, 400n), toContract(VAULT, 400n)] };
    expect(() => changeCoinOf(zswap, VAULT)).toThrow(/found 2/);
  });
});

describe('C197: paidCoinTo tells "not paid" apart from "could not read"', () => {
  it('reads the coin a payee received', async () => {
    const zswap = { outputs: [toContract(VAULT, 800n), toPerson(PAYEE, 200n)] };
    expect(paidCoinTo(zswap, PAYEE)).toEqual({ nonce: NONCE, token: GBP, value: 200n });
  });

  it('answers undefined when the outputs are THERE and none is theirs', async () => {
    const zswap = { outputs: [toContract(VAULT, 1_000n)] };
    expect(paidCoinTo(zswap, PAYEE)).toBeUndefined();
  });

  it('REFUSES a state with no readable outputs, rather than saying they were not paid', async () => {
    /*
     * The consequence differs from `changeCoinOf`'s and is no smaller: this is
     * what the payer hands a payee who lost their payslip (`B4`). A shielded
     * payment tells the payee nothing on its own, so "you were not paid",
     * answered about a payment that settled, is money they hold and cannot
     * spend.
     */
    for (const unreadable of [undefined, null, {}, { outputs: undefined }]) {
      expect(() => paidCoinTo(unreadable, PAYEE)).toThrow(UnreadableZswapState);
      expect(() => paidCoinTo(unreadable, PAYEE)).toThrow(/coin this payment sent/);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * **THE SHAPE THE CLIENT ACTUALLY GETS, WHICH IS NOT THE SHAPE EVERY
 * TEST ABOVE BUILDS.**
 *
 * Every case above hands these readers an `EncodedZswapLocalState` — the form a
 * circuit context carries (`callContext.currentZswapLocalState`) and the form
 * `contracts/test/vault-payout.test.ts` reads. **The SDK hands a client the
 * DECODED form**: compact-js returns `decodeZswapLocalState(...)` and
 * midnight-js carries it through unchanged as `private.nextZswapLocalState`.
 * In that form an address is a hex STRING, not `{ bytes }`.
 *
 * Against the old reader the decoded form matched nothing and answered
 * `undefined` — *"this payout left no change"* — which is a change note dropped
 * from the pool on every payment, silently. The tests could not have caught it,
 * because they all built the shape the reader already understood.
 *
 * **SO THE CONVERSION IS THE RUNTIME'S OWN, NOT A SECOND MODEL WRITTEN HERE.**
 * One state is built, `decodeZswapLocalState` produces the other, and both must
 * give the identical answer. A hand-written "decoded-looking" object would be
 * this file guessing at the very shape the defect was about.
 */
describe('C239: both spellings of a Zswap output, and anything else refused', () => {
  const decoded = async (encoded: unknown) => {
    const { decodeZswapLocalState } = await import('@midnight-ntwrk/compact-runtime');
    return (decodeZswapLocalState as (s: never) => unknown)({
      coinPublicKey: { bytes: bytes(0x01) },
      currentIndex: 0n,
      inputs: [],
      /*
       * `decodeRecipient` reads BOTH halves unconditionally, so the encoded
       * form it takes carries both — which the helpers above do not, since
       * `changeCoinOf` never looks at the half `is_left` rules out. Filled in
       * here rather than in the helpers so every test above still builds the
       * minimum shape the readers are asked to cope with.
       */
      outputs: (encoded as { outputs: any[] }).outputs.map((o) => ({
        ...o,
        recipient: {
          is_left: o.recipient.is_left,
          left: o.recipient.left ?? { bytes: bytes(0) },
          right: o.recipient.right ?? { bytes: bytes(0) },
        },
      })),
    } as never);
  };

  it('reads the change the SDK hands back, identically to the circuit context form', async () => {
    const encoded = { outputs: [toContract(VAULT, 800n), toPerson(PAYEE, 200n)] };
    const asSdk = await decoded(encoded);
    expect(changeCoinOf(asSdk, VAULT)).toEqual(changeCoinOf(encoded, VAULT));
    expect(changeCoinOf(asSdk, VAULT)).toEqual({ nonce: NONCE, token: GBP, value: 800n });
  });

  it('reads the payee\'s coin in the SDK\'s form too', async () => {
    const encoded = { outputs: [toContract(VAULT, 800n), toPerson(PAYEE, 200n)] };
    const asSdk = await decoded(encoded);
    expect(paidCoinTo(asSdk, PAYEE)).toEqual({ nonce: NONCE, token: GBP, value: 200n });
  });

  it('still says "no change" for a whole-balance payment in the SDK\'s form', async () => {
    /*
     * The half that matters most: `undefined` must still mean what the header
     * says it means. A reader repaired by making it accept everything would
     * pass the test above and answer `undefined` here for the wrong reason.
     */
    const asSdk = await decoded({ outputs: [toPerson(PAYEE, 1_000n)] });
    expect(changeCoinOf(asSdk, VAULT)).toBeUndefined();
  });

  it('keeps C205\'s refusal in the SDK\'s form, so a split is still not silently halved', async () => {
    const asSdk = await decoded({ outputs: [toContract(VAULT, 400n), toContract(VAULT, 400n)] });
    expect(() => changeCoinOf(asSdk, VAULT)).toThrow(/found 2/);
  });

  it('REFUSES an output in neither spelling, rather than filtering it away', async () => {
    /*
     * The rule this round adds, and the reason it is a refusal: an output
     * dropped from the filter is indistinguishable from an output addressed to
     * somebody else, and telling those two apart is the whole of `C197`.
     */
    const nonsense = {
      outputs: [{ recipient: { is_left: false, right: 42 }, coinInfo: { nonce: bytes(1), color: bytes(2), value: 1n } }],
    };
    expect(() => changeCoinOf(nonsense, VAULT)).toThrow(UnreadableZswapState);
    expect(() => changeCoinOf(nonsense, VAULT)).toThrow(/neither spelling/);

    const noRecipient = { outputs: [{ coinInfo: { nonce: bytes(1), color: bytes(2), value: 1n } }] };
    expect(() => changeCoinOf(noRecipient, VAULT)).toThrow(/no is_left/);
  });

  it('REFUSES a coin whose value is not a bigint, rather than coercing it', async () => {
    /*
     * A value that arrives as a number or a `{"$n":…}` object reads as
     * a note the pool can do arithmetic on and cannot. A pool that opens and is
     * wrong is worse than one that refuses.
     */
    const wrong = {
      outputs: [{
        recipient: { is_left: false, right: { bytes: Uint8Array.from(Buffer.from(VAULT, 'hex')) } },
        coinInfo: { nonce: bytes(0xdd), color: bytes(0xcc), value: 800 },
      }],
    };
    expect(() => changeCoinOf(wrong, VAULT)).toThrow(/value number/);

    /*
     * And the rename trap: a coin carrying BOTH token fields is a hand-built
     * object, and picking one of them is picking which currency a note is in.
     */
    const both = {
      outputs: [{
        recipient: { is_left: false, right: { bytes: Uint8Array.from(Buffer.from(VAULT, 'hex')) } },
        coinInfo: { nonce: bytes(0xdd), color: bytes(0xcc), type: bytes(0xee), value: 800n },
      }],
    };
    expect(() => changeCoinOf(both, VAULT)).toThrow(/BOTH color and type/);
  });
});
