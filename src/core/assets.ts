/**
 * The asset registry, and the only place that knows how many decimal places a
 * currency has. D10 and D11 in docs/scope-v1-data-model.md.
 *
 * TWO RULES, and everything here follows from them.
 *
 * 1. **Every amount is an integer in the asset's smallest unit.** $5,000.00 is
 *    `500000n`, one ether is `1000000000000000000n`. There is no float anywhere
 *    in this system and there must never be one: `0.1 + 0.2` is not `0.3`, so
 *    payroll totals drift by pennies and the drift gets blamed on us — and,
 *    worse, a JavaScript number cannot hold 18 significant digits at all, so an
 *    ETH amount does not round, it silently loses value.
 *
 * 2. **Nothing about an asset is secret.** There is nothing confidential about
 *    the existence of the euro, so this table is plaintext, and adding a
 *    currency is a row rather than a release. What IS confidential is the
 *    pairing of an asset with an account, which is why the on-chain map is keyed
 *    by `assetKeyOf(assetId, accountBlinding)` and never by a code.
 *
 * The registry lives in code here and in a Postgres table from migration 0004.
 * `SEED_ASSETS` below is what seeds it, so there is one list rather than two —
 * this project's oldest failure is a shared rule written twice.
 */

/** An asset's code. `GBP`, `USDC`, `NIGHT`. Uppercase, ASCII, no spaces. */
export type AssetId = string;

export interface Asset {
  code: AssetId;
  name: string;
  kind: 'fiat' | 'token';
  /**
   * How many of the smallest unit make one whole unit, as a power of ten.
   *
   * The only number in this system that converts between what a human types and
   * what everything else stores. It is on the asset and nowhere else, because a
   * second copy is how `500000` comes to mean five thousand dollars in one
   * place and half a USDC in another.
   */
  decimals: number;
  /** Null for fiat, which does not live on a chain. */
  chain: string | null;
  /**
   * Off means the asset exists and cannot be used. It is a switch rather than a
   * deletion because rows are referenced by sealed records we cannot rewrite —
   * an asset that has ever been held must stay resolvable forever, or its
   * balance becomes unreadable.
   */
  enabled: boolean;
  sortOrder: number;
}

/**
 * What migration 0004 inserts, and what a standalone build runs on.
 *
 * ETH is present and DISABLED on purpose. It is the asset that proves the
 * integer decision was necessary rather than tidy — 18 decimals do not fit in a
 * JavaScript number — so it belongs in the table and in the tests from the
 * first day, whether or not anybody is paid in it yet.
 */
export const SEED_ASSETS: readonly Asset[] = Object.freeze([
  { code: 'GBP', name: 'Pound Sterling', kind: 'fiat', decimals: 2, chain: null, enabled: true, sortOrder: 10 },
  { code: 'USD', name: 'US Dollar', kind: 'fiat', decimals: 2, chain: null, enabled: true, sortOrder: 20 },
  { code: 'EUR', name: 'Euro', kind: 'fiat', decimals: 2, chain: null, enabled: true, sortOrder: 30 },
  { code: 'USDC', name: 'USD Coin', kind: 'token', decimals: 6, chain: 'ethereum', enabled: true, sortOrder: 40 },
  { code: 'NIGHT', name: 'Night', kind: 'token', decimals: 6, chain: 'midnight', enabled: true, sortOrder: 50 },
  { code: 'ETH', name: 'Ether', kind: 'token', decimals: 18, chain: 'ethereum', enabled: false, sortOrder: 60 },
] as const);

/* ------------------------------------------------------------------ *
 * whether an asset can be held and paid PRIVATELY
 * ------------------------------------------------------------------ */

/**
 * **CAN MONEY IN THIS ASSET BE PAID PRIVATELY?**
 *
 * **A FUNCTION AND NOT A LIST AT A CALL SITE**, because the answer changes for
 * every asset at once on the day the converter is deployed, and a screen that
 * hardcoded it would go on saying no afterwards. `S12b` renders the unavailable
 * side of the private/public toggle from this, with `why` on the screen, so a
 * customer learns the product will do this and does not yet — rather than
 * concluding it never will.
 *
 * `why` is CUSTOMER-FACING and is audited as product copy.
 */
export type PrivateForm =
  | { readonly of: 'available' }
  | { readonly of: 'not-yet'; readonly why: string };

/**
 * **THE ANSWER IS NO FOR EVERY ASSET TODAY, AND THAT IS ESTABLISHED RATHER
 * THAN ASSUMED.**
 *
 * Money is paid privately by sending a SHIELDED note, and a note has a colour.
 * **NIGHT is unshielded by definition** — `nativeToken(): UnshieldedTokenType` —
 * so there is no private NIGHT to send. Every other asset in this registry sits
 * on another chain or on none at all, so there is no note of it here either.
 *
 * **The converter is the one thing that changes this**, for all of them by the
 * same mechanism: it takes a public deposit and mints a wrapped shielded token
 * against it. **Nothing in `src/` reaches a converter today** and no converter
 * is deployed, which is why this answers the way it does rather than by a list
 * somebody has to remember to edit.
 *
 * **TWO REASONS AND NOT SIX**, both read off `chain` rather than off a table of
 * asset codes. A per-code table is the hardcoded list this exists to replace.
 */
export function privateForm(asset: Asset): PrivateForm {
  /*
   * **`why` SAYS WHAT THE AVAILABLE SIDE COSTS, NOT ONLY THAT THE OTHER SIDE IS
   * SHUT.** product-copy pass.
   *
   * This is the sentence beside the option a company cannot pick, which makes
   * it the sentence they read at the moment they settle for a public payment.
   * A string that says only *private is coming* leaves them reading public as
   * the ordinary temporary option, and nothing tells them it publishes the
   * recipient and the amount for good.
   *
   * **AND IT PROMISES NOTHING.** *"Still being built"* and *"will open later"*
   * were both here and both are commitments: no converter is deployed and
   * nothing in `src/` reaches one.
   */
  if (asset.chain === 'midnight') {
    return {
      of: 'not-yet',
      why: `${asset.code} can only be sent publicly today, which puts the recipient's `
        + 'address and the amount on a record anyone can read. '
        + `There is no private form of ${asset.code} yet. This choice turns on when there is.`,
    };
  }
  return {
    of: 'not-yet',
    why: `${asset.code} cannot be sent privately. `
      + `Only money held on Midnight can be, and ${asset.code} is not.`,
  };
}

export interface AssetRegistry {
  /** Every asset, enabled or not. A held asset must stay resolvable forever. */
  all(): Asset[];
  /** The assets a person may choose from today. */
  enabled(): Asset[];
  find(code: AssetId): Asset | null;
  /** Throws with a readable message. Use this at every boundary. */
  require(code: AssetId): Asset;
}

export class StaticAssetRegistry implements AssetRegistry {
  private byCode: Map<AssetId, Asset>;

  constructor(assets: readonly Asset[] = SEED_ASSETS) {
    this.byCode = new Map(assets.map(a => [a.code, { ...a }]));
  }

  all(): Asset[] {
    return [...this.byCode.values()].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  enabled(): Asset[] {
    return this.all().filter(a => a.enabled);
  }

  find(code: AssetId): Asset | null {
    return this.byCode.get(code) ?? null;
  }

  require(code: AssetId): Asset {
    const a = this.find(code);
    if (!a) {
      throw new Error(
        `unknown asset "${code}". Assets come from the registry, and an amount without one ` +
          'has no decimal place — so there is no safe default to fall back to.',
      );
    }
    return a;
  }
}

/** The registry every caller gets unless it is handed another one. */
export const assets: AssetRegistry = new StaticAssetRegistry();

/* ------------------------------------------------------------------ *
 * the encoding the circuit sees
 * ------------------------------------------------------------------ */

/**
 * How an asset code reaches the contract: 32 bytes, ASCII, zero padded.
 *
 * ONE DEFINITION, here, because both halves of `assetKeyOf` depend on the bytes
 * being identical — the device that credits dollars and the device that spends
 * them derive the same map key or the account holds its money twice under two
 * names. There is no Compact copy of this to drift from: `assetId` is a witness,
 * so the encoding is entirely ours and the contract only ever sees the result.
 *
 * Refuses anything that would not round-trip. A code with a NUL in it, or one
 * longer than 32 bytes, would collide with another after padding — and a
 * collision here means two currencies sharing one balance.
 */
export const ASSET_ID_BYTES = 32;

/**
 * The asset a governance round moves, which is none.
 *
 * `addSigner`, `removeSigner` and `setThreshold` are approval rounds that move
 * no money — but they still go through `propose`, and `propose` commits to
 * `changeCommitmentOf(assetKey, amount, batch, salt)`, which needs an asset.
 * Passing a real one would be a lie in the ledger a client could read as "this
 * round concerns dollars", and picking "whatever the account holds first" would
 * fail on an account that holds nothing, which every account does at the moment
 * it seats its second signer.
 *
 * So there is a reserved code that means no asset. It derives a perfectly valid
 * key and **that key can never appear in `assetBalances`**, because the only
 * circuits that write to the map are `credit` and `execute`, and no governance
 * circuit calls either. Deliberately NOT in the registry: it has no decimals,
 * nothing may be denominated in it, and `require` refuses it like any other
 * unknown code.
 */
export const NO_ASSET: AssetId = 'NONE';

export function assetIdBytes(code: AssetId): Uint8Array {
  if (!/^[A-Z0-9]{1,32}$/.test(code)) {
    throw new Error(
      `"${code}" is not a usable asset code. Codes are 1 to 32 uppercase letters or digits, ` +
        'because they are zero padded to 32 bytes before they reach the circuit and anything ' +
        'else could collide with another code once padded.',
    );
  }
  const out = new Uint8Array(ASSET_ID_BYTES);
  for (let i = 0; i < code.length; i++) out[i] = code.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------------ *
 * amounts
 * ------------------------------------------------------------------ */

/**
 * Turns what a person typed into an integer in the asset's smallest unit.
 *
 * STRICT, on purpose, and every refusal below is a bug it would otherwise hide:
 *
 *   "5,000.00"   thousands separators are ambiguous across locales — in much of
 *                Europe that string means five, not five thousand.
 *   "5.005"      more decimal places than the asset has. Truncating silently is
 *                how someone is paid half a penny less every month; rounding
 *                silently is the same thing with a friendlier name. The caller
 *                has to decide, so this refuses and says by how much.
 *   "1e3"        exponent notation is a float in disguise.
 *   "-5"         negative amounts are not a thing this system moves. A refund
 *                is an entry in the other direction, not a negative one.
 */
export function parseAmount(text: string, asset: Asset): bigint {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(
      `"${text}" is not a plain decimal amount. Write digits and at most one point — no ` +
        'separators, no exponent, no sign.',
    );
  }
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > asset.decimals) {
    throw new Error(
      `${asset.code} has ${asset.decimals} decimal ${asset.decimals === 1 ? 'place' : 'places'}, ` +
        `and "${text}" has ${fraction.length}. Rounding somebody's pay without being asked is ` +
        'not something this will do quietly.',
    );
  }
  return BigInt(whole + fraction.padEnd(asset.decimals, '0'));
}

/**
 * Turns an integer in the smallest unit back into something a person reads.
 *
 * Always shows every decimal place the asset has, including trailing zeros:
 * `500000` in GBP is `5000.00` and not `5000`. Money with a variable number of
 * decimal places in a column is how a person misreads a figure by a factor of
 * ten, and this is the display path for payslips.
 */
export function formatAmount(value: bigint, asset: Asset): string {
  if (value < 0n) throw new Error('amounts are never negative');
  if (asset.decimals === 0) return value.toString();
  const digits = value.toString().padStart(asset.decimals + 1, '0');
  const cut = digits.length - asset.decimals;
  return `${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

/**
 * Adds up amounts OF ONE ASSET.
 *
 * There is deliberately no function here that adds amounts of different assets,
 * and there must not be one. "A run has a subtotal per asset, never one total" —
 * a single number across mixed currencies is a number that means nothing, and
 * the moment a helper exists to produce one, something will display it.
 */
export const sumAmounts = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

/**
 * **THE LARGEST AMOUNT ANY CHANGE MAY CARRY, AND THE ONE PLACE IT IS WRITTEN.**
 *
 *
 * `Uint<128>`, because that is what `changeCommitmentOf` argument 2 is
 * (`contracts/managed/contract/index.js:4220`) and what the `changeAmount`
 * witness is range-checked against before a call is built (`:1380`).
 *
 * **IT LIVES HERE AND NOT IN `src/midnight/`, AND THE DIRECTION IS FORCED.**
 * `core/` may not import `src/midnight/` — that dependency rule is what keeps
 * the standalone build working and it is stated at `src/wiring/selection.ts:84-93`
 * — and the value has to be readable from `core/` because that is where a
 * change is BUILT. `src/midnight/commitments.ts:42` now reads it from here
 * rather than declaring its own; a copy would be `M-104` for the eleventh time.
 */
export const MAX_CHANGE_AMOUNT = (1n << 128n) - 1n;

/**
 * **THE SUM A CHANGE COMMITS TO, REFUSED WHERE IT IS BUILT.** `T-205` `P2`,
 * raised to a money finding by `S46`'s money-safety pass.
 *
 * ── WHY A SECOND SUMMING FUNCTION AND NOT A CHECK INSIDE `sumAmounts` ────────
 *
 * `sumAmounts` above is used for display subtotals and for arithmetic that has
 * nothing to do with a circuit argument. **This one is for the value that
 * becomes `StateChange.amount`**, and it is separate so the refusal cannot be
 * inherited by a caller that only wanted to add three numbers up — the shape
 * `newProposalSalt` uses (`src/core/crypto.ts:141-146`): the assert is where
 * the value is MADE, not at either consumer, and it is a NAMED generator rather
 * than a widened shared one.
 *
 * ── WHAT WAS REACHABLE BEFORE IT, MEASURED ──────────────────────────────────
 *
 * `AccountService.propose` summed with a bare reduce and nothing bounded the
 * result. The live door is the plug-in one: `POST /api/accounts/:id/plugins`
 * takes `perProposal` as a string and converts it with `parseAmount`
 * (`src/server/index.ts:1482`), **which refuses a sign, separators and an
 * exponent and imposes NO MAXIMUM** (`:253-269` above) — so the only ceiling on
 * the path is a number the same caller sets. `POST /api/plugin/propose`
 * (`src/server/index.ts:1533`) then passes all four of `src/core/plugins.ts`'s
 * checks (`:308-326`) and writes `entries` at `:333`.
 *
 * **AND ON TODAY'S WIRING NOTHING DOWNSTREAM REFUSES IT.**
 * `src/wiring/selection.ts:144` selects the simulated scheme, whose
 * `changeCommitment` HMACs the decimal string (`src/core/ledger.ts:2106-2110`)
 * and takes a bigint of any magnitude. The round opens, collects approvals, and
 * names a change no contract can ever reproduce — `C375`'s state reached
 * through a second door. On the Midnight wiring it is loud instead, at the
 * witness range check, before anything is submitted.
 *
 * **THE GUARD THAT SHOULD HAVE CAUGHT IT EXISTS AND IS DEAD CODE**, which is
 * why this is a new function rather than a call to that one: `checkAmount`
 * (`src/midnight/commitments.ts:44-55`) does exactly this and its only caller
 * is `MidnightCommitments.changeCommitment` (`:219-222`), **which nothing in
 * `src/` calls** — `MidnightLedger` reaches `pureCircuits` directly
 * (`src/midnight/ledger.ts:1672`). A tested guard on a path the product does
 * not take is rule 27 inverted, and it is filed as `T-281`.
 *
 * **A NEGATIVE IS ALREADY REFUSED TWICE AND NEITHER REFUSAL IS PINNED** —
 * `parseAmount`'s regex (`:255`) and `src/core/plugins.ts:311`. It is refused
 * here as well, because the ceiling and the floor are one rule about one value
 * and splitting them across three files is how one of them goes missing.
 */
export const sumChangeAmount = (xs: readonly bigint[], what: string): bigint => {
  const total = sumAmounts(xs);
  if (total < 0n) {
    throw new Error(
      `${what} sums to ${total}, which is negative. A change commitment's amount is the ` +
        'contract\'s Uint<128> and cannot represent it, so this round would be approved and ' +
        'then impossible to settle. T-205.',
    );
  }
  if (total > MAX_CHANGE_AMOUNT) {
    throw new Error(
      `${what} sums to ${total}, which does not fit the contract's Uint<128>. The largest ` +
        `amount a change can carry is ${MAX_CHANGE_AMOUNT}. A round raised above it collects ` +
        'approvals and can never be settled by any payment. T-205.',
    );
  }
  return total;
};

/**
 * Subtotals per asset, which is what a mixed run actually has.
 *
 * Returned sorted by code so two runs over the same lines produce the same
 * object — anything that gets sealed or digested has to be deterministic.
 */
export function subtotals(
  lines: ReadonlyArray<{ asset: AssetId; amount: bigint }>,
): Record<AssetId, bigint> {
  const out: Record<AssetId, bigint> = {};
  for (const code of [...new Set(lines.map(l => l.asset))].sort()) {
    out[code] = sumAmounts(lines.filter(l => l.asset === code).map(l => l.amount));
  }
  return out;
}
