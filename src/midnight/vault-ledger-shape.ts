/**
 * **WHETHER A DEPLOYED VAULT HOLDS THE LEDGER THIS BUILD'S CONTRACT DESCRIBES.**
 *
 * A contract's ledger is a positional array on chain. The names of its fields
 * exist only in the compiled artefacts on this machine; what the chain holds is
 * slot 0, slot 1, slot 2 and so on. **So a client reads a vault's fields by
 * counting**, and a vault deployed from an older contract answers the count
 * with somebody else's money.
 *
 * ── WHAT GOES WRONG, MEASURED RATHER THAN IMAGINED ───────────────────────
 *
 * Three vaults deployed from three builds of the same contract were read
 * through this build's own reader:
 *
 *     this build's contract, its own constructor run:  5 slots  cell,map,map,cell,map
 *     a vault deployed 28 Aug                          3 slots  cell,map,cell
 *     a vault deployed 29 Aug                          4 slots  cell,map,map,cell
 *     a vault deployed  9 Sep                          5 slots  cell,map,map,cell,map
 *
 * **THE READER DOES NOT NOTICE.** Asked for the field list it answers with all
 * five names on every one of them, because the accessors are built unread and
 * each one addresses its slot only when it is touched. On the 28 Aug vault the
 * third field's accessor reached the third slot and found the FOURTH field's
 * value there, and it threw only because the two happen to be stored
 * differently. **Two fields of the same storage would have answered, with each
 * other's contents, and said nothing.**
 *
 * ── AND THE CHECK THAT ALREADY EXISTS DOES NOT CATCH IT ──────────────────
 *
 * Before any call, the deployed verifier keys are compared byte for byte
 * against the compiled ones. That comparison PASSES on the 29 Aug vault, whose
 * ledger is a field short of this build's - measured, both vaults, one
 * afternoon. A field no circuit reads yet is invisible to a verifier key, and
 * a field no circuit reads yet is one edit from being a field that does.
 *
 * ── WHAT THIS DOES AND WHAT IT CANNOT DO ─────────────────────────────────
 *
 * It compares two shapes: how many fields, and how each one is stored. It
 * catches a vault with fields missing, a vault with fields this build does not
 * have, and a vault whose fields are stored differently in any position.
 *
 * **TWO THINGS IT CANNOT CATCH, AND THEY ARE WRITTEN HERE RATHER THAN LEFT FOR
 * SOMEBODY TO DISCOVER IN THE ONE CASE THEY MATTER.**
 *
 *   · **Two fields of the same storage swapped with each other.** No client
 *     can: the chain holds no names, so two maps in the other order are the
 *     same bytes in the same places.
 *   · **A field of the same storage whose contents are typed differently** - a
 *     map of one key type in one build and another in the next reads as a map
 *     in both. The top level says how a field is stored and not what is in it.
 *
 * Both are properties of the ledger rather than gaps in this file.
 */

/**
 * **THE SHAPE OF A LEDGER: HOW EACH TOP-LEVEL FIELD IS STORED, IN ORDER.**
 *
 * The words are the ledger's own - `cell`, `map`, `array`, `boundedMerkleTree`,
 * `null` - and they are not translated. A word this file has never seen is
 * still comparable, which is the point: the comparison has to keep working on a
 * storage kind that did not exist when it was written.
 */
export interface LedgerShape {
  readonly slots: readonly string[];
}

/** What a comparison of two shapes says. */
export type ShapeVerdict =
  | { readonly of: 'matches' }
  | { readonly of: 'differs'; readonly why: string };

/**
 * Thrown in front of every call that deposits into or pays out of a vault.
 *
 * It carries both shapes, because a caller that only gets a sentence cannot
 * report what it saw and the next person re-measures it by hand.
 */
export class VaultLedgerShapeMismatch extends Error {
  constructor(
    message: string,
    readonly compiled: LedgerShape,
    readonly deployed: LedgerShape,
  ) {
    super(message);
    this.name = 'VaultLedgerShapeMismatch';
  }
}

/**
 * How a field is named in a message when the two shapes disagree at its
 * position. **A position past the end of the name list still gets a name**, so
 * a contract that grew a field after this was written does not produce a
 * refusal that says `undefined`.
 */
function fieldAt(fields: readonly string[], at: number): string {
  const named = fields[at];
  return typeof named === 'string' && named.length > 0 ? `"${named}"` : `field ${at + 1}`;
}

const listOf = (names: readonly string[]): string => names.join(', ');

/**
 * **THE COMPARISON, AND IT IS PURE.** No chain, no artefacts, no clock: two
 * shapes and the field names this build knows, in and a verdict out. Every
 * refusal it can produce is reachable from invented shapes, which is how it is
 * tested.
 *
 * `fields` names this build's fields in order and is used only to write the
 * message. A shorter list than `compiled.slots` is not an error here - it
 * produces positional names for the fields it does not cover.
 */
export function compareLedgerShape(
  compiled: LedgerShape,
  deployed: LedgerShape,
  fields: readonly string[] = [],
): ShapeVerdict {
  if (deployed.slots.length !== compiled.slots.length) {
    const missing = fields.slice(deployed.slots.length, compiled.slots.length);
    const shortfall = deployed.slots.length < compiled.slots.length
      ? `It is missing ${compiled.slots.length - deployed.slots.length} of them`
        + `${missing.length > 0 ? `, and by position those are ${listOf(missing)}` : ''}. `
        + 'Reading one of those fields off this vault reads past the end of its ledger, and '
        + 'reading any field after a missing one reads a different field\x27s value.'
      : 'It has more of them than this build\x27s contract declares, so it was deployed from a '
        + 'contract this build is not. Every field this build reads by position may be another '
        + 'field\x27s value.';
    return {
      of: 'differs',
      why: `this vault holds ${deployed.slots.length} ledger `
        + `${deployed.slots.length === 1 ? 'field' : 'fields'} and the vault contract this build `
        + `compiled has ${compiled.slots.length}. ${shortfall}`,
    };
  }
  for (let at = 0; at < compiled.slots.length; at++) {
    const here = deployed.slots[at];
    const there = compiled.slots[at];
    if (here !== there) {
      return {
        of: 'differs',
        why: `this vault stores ${fieldAt(fields, at)} as a "${here}" and the vault contract this `
          + `build compiled stores it as a "${there}". The two are different money: a value read `
          + 'out of the wrong kind of storage is either refused or is another field\x27s.',
      };
    }
  }
  return { of: 'matches' };
}

/**
 * **THE REFUSAL, AND IT NAMES WHAT RESOLVES IT.**
 *
 * There is nothing to repair on a vault whose ledger is the wrong shape. The
 * contract that deployed it is the one that decided the shape, and a contract's
 * ledger is fixed at its deploy. So the resolution is a vault deployed from
 * this build, and any money already in the mismatched one is reached by the
 * build that deployed it - which is a statement about where to look, not an
 * instruction to go and do it.
 */
export function assertLedgerShapesAgree(
  compiled: LedgerShape,
  deployed: LedgerShape,
  fields: readonly string[],
): void {
  const verdict = compareLedgerShape(compiled, deployed, fields);
  if (verdict.of === 'matches') return;
  throw new VaultLedgerShapeMismatch(
    `this vault was deployed from a different build of the vault contract, so nothing here will `
    + `deposit into it or pay out of it: ${verdict.why} Nothing was proved, submitted or spent. `
    + 'Deploy a vault from this build and use that one; money already held by this vault is '
    + 'reached by the build that deployed it, and no client can make this one the right shape - '
    + 'a contract\x27s ledger is fixed when it is deployed.',
    compiled,
    deployed,
  );
}

/* ------------------------------------------------------------------ *
 * reading the two shapes
 * ------------------------------------------------------------------ */

/**
 * **THE SHAPE A DEPLOYED VAULT ACTUALLY HAS, OFF ITS OWN STATE.**
 *
 * The top level of a contract's state is an array with one entry per ledger
 * field, and each entry says how it is stored. **Nothing here is decoded** - no
 * field is read, no value is opened - so this answers on a vault whose fields
 * this build cannot read at all, which is exactly the vault it exists for.
 */
export function shapeOfDeployedState(state: unknown): LedgerShape {
  const top = (state as { data?: { state?: unknown } })?.data?.state as {
    type?: () => string;
    asArray?: () => Array<{ type?: () => string }>;
  } | undefined;
  if (!top || typeof top.asArray !== 'function' || typeof top.type !== 'function') {
    throw new VaultLedgerShapeMismatch(
      'this vault\x27s state does not open as a ledger at all, so nothing here will deposit '
      + 'into it or pay out of it. That is not an empty vault: an empty vault still has the '
      + 'shape its contract gave it. Nothing was proved, submitted or spent.',
      { slots: [] }, { slots: [] });
  }
  const kind = top.type();
  if (kind !== 'array') {
    throw new VaultLedgerShapeMismatch(
      `this vault's state is a "${kind}" where a contract's ledger is an array of its `
      + 'fields, so nothing here will deposit into it or pay out of it. Nothing was proved, '
      + 'submitted or spent.',
      { slots: [] }, { slots: [kind] });
  }
  return {
    slots: top.asArray().map((slot) => (typeof slot?.type === 'function' ? slot.type() : 'unreadable')),
  };
}

/**
 * **THE SHAPE THIS BUILD'S OWN CONTRACT PRODUCES, BY RUNNING ITS CONSTRUCTOR.**
 *
 * Not a table somebody transcribed and not the compiled module's text: the
 * contract this build would deploy, asked to make its initial state, and the
 * state it makes read the same way the deployed one is read. **A table would be
 * a second statement of the field list to drift from; the constructor is the
 * same one every deploy uses.**
 *
 * It touches no network, proves nothing and starts no proof server. **The
 * constructor does run** - the contract's own constructor body, against a fresh
 * state - and it calls no witness, so the witnesses it is handed are a stand-in
 * that throws if anything ever does. They are supplied without naming a single
 * witness, so a contract that DECLARES a new one still builds here; a
 * constructor that started CALLING one would throw, and every deposit and
 * payout would refuse until this was looked at. That is the right way round,
 * and it is said here because the two are easy to read as the same thing.
 *
 * The account address it is constructed with is thirty-two zero bytes. It is
 * never deployed, never signed and never leaves this process; it is there
 * because the constructor takes one, and the shape does not depend on it.
 */
let compiledShape: Promise<{ shape: LedgerShape; fields: readonly string[] }> | null = null;

export function compiledVaultLedgerShape(): Promise<{ shape: LedgerShape; fields: readonly string[] }> {
  /*
   * **A FAILURE IS NOT REMEMBERED, AND THAT IS THE WHOLE OF THIS LINE.**
   *
   * The answer is the same every time, so it is worked out once. But a promise
   * that rejected is an answer too, and keeping it would mean one transient
   * failure - a module that did not load, a constructor that threw once -
   * refusing every deposit and every payout for the life of the process, with
   * the reason long gone. It fails closed either way; what it must not do is
   * stay closed after the reason has passed.
   */
  compiledShape ??= (async () => {
    const { Contract, ledger } = await import('../../contracts/managed-vault/contract/index.js');
    const nothingCallsThese = new Proxy({}, {
      get: () => () => {
        throw new Error('reading a vault\x27s ledger shape runs no circuit and no witness');
      },
    });
    const built = await new (Contract as new (w: unknown) => {
      initialState(context: unknown, account: { bytes: Uint8Array }): Promise<{
        currentContractState: { data: unknown };
      }>;
    })(nothingCallsThese).initialState(
      { initialPrivateState: {}, initialZswapLocalState: { coinPublicKey: new Uint8Array(32) } },
      { bytes: new Uint8Array(32) });
    const state = { data: built.currentContractState.data };
    return {
      shape: shapeOfDeployedState(state),
      fields: Object.keys((ledger as (d: unknown) => object)(built.currentContractState.data)),
    };
  })().catch((cause) => { compiledShape = null; throw cause; });
  return compiledShape;
}

/**
 * **THE GATE. IN FRONT OF EVERY CALL THAT MOVES MONEY INTO OR OUT OF A VAULT.**
 *
 * A vault whose ledger is not the shape this build compiled is a vault this
 * build refuses to touch, and it refuses here - before a fee, before a proof,
 * before a proposal - because every one of those is spent whether or not the
 * call can work.
 */
export async function assertVaultLedgerIsThisBuilds(state: unknown): Promise<void> {
  const deployed = shapeOfDeployedState(state);
  const { shape, fields } = await compiledVaultLedgerShape();
  assertLedgerShapesAgree(shape, deployed, fields);
}
