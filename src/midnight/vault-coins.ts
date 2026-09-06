/**
 * WHAT A PAYMENT LEFT THE VAULT HOLDING. V-47.
 *
 * A vault holds its money privately: the chain keeps a commitment, and the coin
 * itself comes back in by witness on the next payment. So after every payment
 * the owner's device has to know EXACTLY what the vault now holds — nonce,
 * token and value — or the next payment offers a coin the commitment does not
 * match and the money can never be moved again.
 *
 * **The nonce is not the one that was spent, and it cannot be derived.**
 * `sendShielded` hashes a new one under the kernel's `nonce_evolve/2` domain,
 * which is a different function from the standard library's `evolveNonce` in
 * spite of the name. A circuit built on `evolveNonce` was written, tested, and
 * found to produce a different value — see the note where it used to live in
 * `Vault.compact`.
 *
 * So it is READ rather than computed. The change is an output of the very
 * transaction that made the payment, addressed back to the vault, and it sits
 * in the call's Zswap local state alongside the payee's. That is how any wallet
 * learns about a coin it has just received; a vault is no different.
 */
import type { Hex } from '../core/crypto.js';
import { toHex } from '../core/crypto.js';

/** A shielded coin as the vault must hold it to spend it again. */
export interface VaultCoin {
  nonce: Hex;
  token: Hex;
  value: bigint;
}

/**
 * **THE CALL'S OUTPUTS, OR A REFUSAL. NEVER AN EMPTY LIST.**
 *
 * Both readers in this file used to open with
 *
 *     const outputs = (zswap as { outputs?: unknown[] } | undefined)?.outputs;
 *     if (!Array.isArray(outputs)) return undefined;
 *
 * and `undefined` from these functions has a MEANING — the header below says
 * it, one line above where the defect was: *"a payment of the whole balance
 * leaves no change, and the vault's entry for that token disappears."* So a
 * state we could not read was answering *the vault kept nothing*, and the two
 * are opposite claims about money.
 *
 * **WHAT IT COSTS. The pool is the record of the money.** A change coin dropped
 * from it is a note nobody can spend: the commitment stays on chain, correct
 * and permanent, and what is lost is our knowledge of which note it describes —
 * nonce, token and value, none of them derivable (`V-47`, and the nonce is not
 * `evolveNonce`'s). No rescan finds it, because Midnight creates no coin
 * ciphertext. `B1`.
 *
 * `C188`'s family, in the money path rather than beside it, and the same
 * remedy: **refuse at the boundary, do not coerce.** `?? []`, `?? 0` and an
 * early `return undefined` are one defect wearing three spellings.
 *
 * The two cases are trivially distinguishable and this is where they are kept
 * apart: a PRESENT `outputs` array with nothing addressed to us is a true
 * statement about the transaction; a state with no readable `outputs` at all is
 * our ignorance.
 */
export class UnreadableZswapState extends Error {
  constructor(readonly what: string, saw: string) {
    super(
      `this call's Zswap local state has no readable "outputs", so nothing here can say what ` +
      `${what}. **This is not the same as there being none** — an outputs list that holds ` +
      'nothing addressed to us is a fact about the transaction, and a state we could not read ' +
      'is our ignorance. Answering "none" for it drops a note from the pool, and the pool is ' +
      'the record of the money: the commitment stays on chain and nobody can ever say which ' +
      `note it describes. Read the call's result again. (saw: ${saw})`);
    this.name = 'UnreadableZswapState';
  }
}

/**
 * The outputs of one call, refusing rather than coercing.
 *
 * `what` completes the sentence "nothing here can say what …", so each caller
 * says which reading was lost rather than sharing one anonymous message.
 */
const outputsOf = (zswap: unknown, what: string): unknown[] => {
  const outputs = (zswap as { outputs?: unknown } | null | undefined)?.outputs;
  if (!Array.isArray(outputs)) {
    throw new UnreadableZswapState(
      what,
      zswap === undefined || zswap === null
        ? String(zswap)
        : `${typeof zswap}, outputs=${outputs === undefined ? 'absent' : typeof outputs}`);
  }
  return outputs;
};

/**
 * **THE SAME OUTPUT ARRIVES IN TWO SPELLINGS, AND ONE OF THEM USED TO READ AS
 * "THERE WAS NO CHANGE". `C239`, and it is `C197` reached through a shape
 * rather than through a `?? []`.**
 *
 * Read from source in `node_modules`, not assumed:
 *
 *   · **ENCODED** — `EncodedZswapLocalState`
 *     (`compact-runtime/dist/zswap.d.ts`): `recipient.right` is
 *     `{ bytes: Uint8Array }` and `coinInfo.nonce`/`color` are `Uint8Array`.
 *     This is what a circuit context hands back — `callContext.currentZswapLocalState`
 *     — and it is the only shape these readers used to accept.
 *   · **DECODED** — `ZswapLocalState` (same file): `recipient.right` is
 *     `ocrt.ContractAddress`, which is `string`
 *     (`onchain-runtime-v4.d.ts:33`), and `coinInfo.nonce`/`color` are
 *     `Nonce`/`RawTokenType`, both `string` too
 *     (`:135`, `:41`). **This is what the SDK hands a CLIENT**:
 *     compact-js returns `zswapLocalState: decodeZswapLocalState(...)`
 *     (`compact-js/dist/esm/effect/ContractExecutable.js`), midnight-js
 *     carries it through as `private.nextZswapLocalState`
 *     (`midnight-js-contracts/dist/index.mjs`), and
 *     `withContractScopedTransaction` returns that object unchanged.
 *
 * **WHY THIS IS THE SHAPE OF A LOST NOTE RATHER THAN A TYPE ERROR.** Handed
 * the decoded form, the old filter read `r.right?.bytes` as `undefined`,
 * matched nothing, and answered `undefined` — *"this payout left no change"* —
 * for a payment that left change. Nothing throws, nothing logs, and the pool
 * advances without the change note. The commitment stays on chain and nobody
 * can ever say which note it describes. That is `B1`, produced by a reader
 * that was correct for the shape the TESTS had and wrong for the shape the
 * CLIENT gets — which is exactly why `vault-coins.test.ts` never caught it:
 * every test built the encoded form by hand.
 *
 * **SO BOTH SPELLINGS ARE READ AND ANYTHING ELSE IS REFUSED.** Not coerced,
 * not skipped: an output whose recipient cannot be classified in either
 * spelling throws, because an output silently dropped from this filter is
 * indistinguishable from an output that was never addressed to us, and those
 * are the two claims this whole file exists to keep apart.
 */
const hexOf = (
  half: unknown, what: string, saw: string,
): Hex | undefined => {
  /* The DECODED spelling: every one of these fields IS the hex string. */
  if (typeof half === 'string') return half as Hex;
  /*
   * The ENCODED spelling, in its two forms — and they differ by a wrapper
   * rather than by a rule. A recipient's half is a one-field struct
   * (`EncodedContractAddress`, `EncodedCoinPublicKey`), because Compact
   * declares them as structs; a coin's `nonce` and `color` are bare bytes.
   * Reading both here rather than at two call sites is what keeps this a
   * SINGLE classification with a single refusal.
   */
  if (half instanceof Uint8Array) return toHex(half);
  const bytes = (half as { bytes?: unknown } | null | undefined)?.bytes;
  if (bytes instanceof Uint8Array) return toHex(bytes);
  if (half === undefined || half === null) return undefined;
  throw new UnreadableZswapState(what, `${saw} is a ${typeof half} in neither spelling`);
};

/**
 * One output, in whichever spelling it arrived, or a refusal.
 *
 * `is_left` is a boolean in both — it is not encoded — so it is the one field
 * that can be read before the spelling is known, and a value that is not a
 * boolean means this is not an output at all.
 */
const recipientOf = (o: unknown, what: string): { toContract?: Hex; toPerson?: Hex } => {
  const r = (o as { recipient?: unknown } | null | undefined)?.recipient as {
    is_left?: unknown; left?: unknown; right?: unknown;
  } | undefined;
  if (r == null || typeof r.is_left !== 'boolean') {
    throw new UnreadableZswapState(
      what, `an output whose recipient has no is_left (${r == null ? String(r) : typeof r})`);
  }
  return r.is_left
    ? { toPerson: hexOf(r.left, what, 'recipient.left') }
    : { toContract: hexOf(r.right, what, 'recipient.right') };
};

/**
 * The coin on one output, in whichever spelling, or a refusal.
 *
 * A value that is not a bigint is refused rather than coerced: `Number` on a
 * value is the shape `M-125` names, and a pool entry holding a number instead
 * of a bigint is arithmetic that answers `NaN` or a concatenation later.
 */
const coinOn = (o: unknown, what: string): VaultCoin => {
  const c = (o as { coinInfo?: unknown } | null | undefined)?.coinInfo as {
    nonce?: unknown; color?: unknown; type?: unknown; value?: unknown;
  } | undefined;
  const nonce = hexOf(c?.nonce, what, 'coinInfo.nonce');
  /*
   * **AND THE TOKEN FIELD IS RENAMED BETWEEN THE TWO SPELLINGS, WHICH IS WORSE
   * THAN BEING RE-ENCODED.**
   *
   * Encoded, a coin is `{ color: Uint8Array, nonce, value }` — the Compact
   * struct (`onchain-runtime-v4.d.ts:511`). Decoded, it is
   * `{ type: RawTokenType, nonce, value }` (`:163-167`). So a reader that
   * knows only `color` finds nothing on the shape the SDK hands back, and a
   * reader that answered `undefined` for it would drop the change note.
   *
   * BOTH present is refused rather than resolved. That is not a shape either
   * side of the runtime produces, so it is a hand-built object, and choosing
   * between two token fields is choosing which currency a note is in.
   */
  if (c?.color !== undefined && c?.type !== undefined) {
    throw new UnreadableZswapState(
      what, 'an output whose coin carries BOTH color and type, which is neither spelling');
  }
  const token = hexOf(c?.color ?? c?.type, what, 'coinInfo.color/type');
  if (nonce === undefined || token === undefined || typeof c?.value !== 'bigint') {
    throw new UnreadableZswapState(
      what,
      `an output whose coin is not readable (nonce ${nonce === undefined ? 'absent' : 'ok'}, `
      + `token ${token === undefined ? 'absent' : 'ok'}, value ${typeof c?.value})`);
  }
  return { nonce, token, value: c.value };
};

export const changeCoinOf = (zswap: unknown, vaultAddress: Hex): VaultCoin | undefined => {
  /*
   * REFUSES rather than answering `undefined`, which above means "it paid out
   * everything". `C197`, and the header three lines up is what forbids it.
   */
  const what = 'coin this payout left the vault';
  const outputs = outputsOf(zswap, what);

  const mine = outputs.filter((o) => {
    /*
     * `is_left` false means the recipient is a CONTRACT rather than a person —
     * and then the address must be this vault's own. Both halves matter: the
     * payee's output is in this same list, and paying one contract from another
     * is a thing this vault will eventually do.
     *
     * **BOTH SPELLINGS, AND A THIRD IS A REFUSAL.** `C239` — see `recipientOf`.
     * An output this cannot classify throws from in there rather than being
     * filtered away, because a dropped output and an output addressed
     * elsewhere are the two things this file exists to tell apart.
     */
    return recipientOf(o, what).toContract === vaultAddress;
  });

  if (mine.length === 0) return undefined;
  if (mine.length > 1) {
    /*
     * Refused rather than guessed. One payment produces at most one change
     * coin; more than one means this function is being pointed at something it
     * does not understand, and picking the first would hand the caller a coin
     * that is not the whole of what the vault holds.
     *
     * **`C205`, AND IT IS NOT THIS ROUND'S TO CLOSE.** `splitNote` produces
     * exactly two outputs back to the vault, so a plural reader is what that
     * circuit's client needs — `S6h`. Making this throw go away by taking the
     * first is how the pool holds one note where the chain holds two.
     */
    throw new Error(
      `expected at most one coin returning to the vault, found ${mine.length}`);
  }

  return coinOn(mine[0], what);
};


/**
 * The coin a PAYEE received from a payment, read from the call's outputs.
 *
 * The everyday counterpart to `paidCoinOf` in `vault-recovery.ts`: this is what
 * the payer captures at payment time and seals to the payee, because a shielded
 * payment tells them nothing on its own (V-50). Deriving it is the fallback for
 * when this was never captured or has been lost.
 *
 * @param recipient the payee's shielded public key, hex
 */
export const paidCoinTo = (zswap: unknown, recipient: Hex): VaultCoin | undefined => {
  /*
   * The same refusal as `changeCoinOf`'s and for the same reason. Here
   * `undefined` means this call paid that recipient nothing — so a state we
   * could not read, answered as `undefined`, is what sends a payee away with
   * "you were not paid" about a payment that settled, and their coin is one
   * nobody can hand them again (`B4`).
   */
  const what = 'coin this payment sent';
  const outputs = outputsOf(zswap, what);

  const theirs = outputs.filter((o) =>
    /* `is_left` true means a person rather than a contract — the opposite of the
     * change, which comes back to the vault. Both spellings. */
    recipientOf(o, what).toPerson === recipient);

  if (theirs.length === 0) return undefined;
  if (theirs.length > 1) {
    throw new Error(`expected one coin for ${recipient}, found ${theirs.length}`);
  }
  return coinOn(theirs[0], what);
};
