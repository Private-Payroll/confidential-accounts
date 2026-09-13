/**
 * THE SEVEN THINGS THAT STOP A FEE PAYER BEING FUNDED, AND THE ONE THAT
 * PROTECTS THE MONEY RATHER THAN THE TRANSACTION.
 *
 * ── WHAT THE ACT IS ─────────────────────────────────────────────────────────
 *
 * One transaction takes the whole of a wallet's NIGHT and splits it into
 * several outputs owned by a fresh wallet, registering that wallet for dust
 * generation in the same transaction, and leaves one output behind with the
 * old wallet. After it lands the new wallet can pay for several transactions
 * instead of one, because a wallet can emit one dust spend per NIGHT output it
 * holds that is registered.
 *
 * ── WHY THE RULES LIVE HERE AND NOT IN THE DOOR ─────────────────────────────
 *
 * Nobody may run the door by hand to find out whether it refuses correctly,
 * and a door that submits is the worst possible instrument for its own
 * refusals. So everything here is a pure function: readings in, verdicts out.
 * No wallet, no network, no clock, no output. A test drives every one of them
 * and watches each assertion turn red against a named change.
 *
 * ── THE ONE THAT IS NOT LIKE THE OTHERS ─────────────────────────────────────
 *
 * Six of these protect a transaction. If one is wrong the transaction is
 * refused, nothing is spent, and it is tried again.
 *
 * THE REGISTRATION CHECK IS NOT LIKE THAT. Fees are payable in exactly one
 * token and it is not NIGHT. A wallet holding NIGHT that was never registered
 * for dust generation earns nothing, so it cannot pay for any transaction at
 * all, INCLUDING THE ONE THAT WOULD REGISTER IT. On a network with no faucet
 * there is no remedy, and under this act the only other wallet that could have
 * sponsored a repair has just been emptied into the one that cannot pay.
 *
 * AND THE LEDGER DOES NOT REFUSE IT. Measured: three NIGHT outputs sent to an
 * address whose key is not the one the transaction registers apply cleanly and
 * the recipient ends up holding three NIGHT and no dust. The transaction
 * succeeds. The money is gone.
 *
 * A PARTIAL MATCH IS THE SHAPE TO FEAR, AND IT WAS MEASURED TOO. Two outputs
 * to a registered address and one to an unregistered address gives two dust
 * and one stranded output, and every check that asks whether SOME output is
 * covered passes it. So the rule is EVERY output, and an output whose coverage
 * could not be established counts as uncovered rather than as unknown.
 *
 * ── PRIOR REGISTRATION COUNTS, AND LEAVING IT OUT WOULD REFUSE THE SPARE ────
 *
 * An output sent to an address registered in some EARLIER transaction
 * generates dust with no registration in the transaction that creates it.
 * Measured. That matters because the spare output deliberately goes back to
 * the old wallet, which registered long ago, so a check that demanded this
 * transaction's own registration cover every output would refuse the exact
 * shape the act requires. Coverage therefore has two sources and the door must
 * have READ the second one, not assumed it.
 */

import type { ParametersReading } from './live-ledger-parameters.js';

/**
 * HOW MANY NIGHT OUTPUTS THE NEW WALLET IS GIVEN, AND THE SHAPE IT IS SAFE IN.
 *
 * Three: one for ordinary work, one for the exit, one spare.
 *
 * THIS NUMBER IS ONLY SAFE WHERE THESE OUTPUTS ACTUALLY GO. The chain charges
 * a transaction a time-to-dismiss allowance computed over its GUARANTEED half
 * alone. Measured against the parameters stagenet is running, three NIGHT
 * outputs in the guaranteed half are refused, and so are two: the largest
 * workable count there is ONE. In the fallible half every count up to twelve
 * is accepted. The wallet library puts every NIGHT transfer it builds in the
 * fallible half unconditionally, which is the only reason three works.
 *
 * So this is not "the chain's limit", and writing it as one would be false in
 * both directions. If a future library version moves NIGHT transfers into the
 * guaranteed half, this number stops being safe with no other warning, which
 * is what the section check below exists to notice.
 */
export const FEE_PAYER_NIGHT_OUTPUTS = 3;

/** Which half of the transaction an output sits in. The allowance is charged on one of them. */
export type Section = 'guaranteed' | 'fallible';

/** A NIGHT output the plan asked for. */
export type IntendedOutput = {
  /** Owner address, as the transaction carries it. */
  owner: string;
  value: bigint;
  /** What this output is for, in the operator's terms. */
  purpose: string;
};

/** A NIGHT output read back off the transaction that was actually built. */
export type BuiltOutput = {
  owner: string;
  value: bigint;
  section: Section;
};

/**
 * Whose NIGHT outputs are registered for dust generation, and on what evidence.
 *
 * `derivedFromThisTransaction` is one entry per registration the built
 * transaction carries, each being the owner address that registration's
 * verifying key derives. A NULL entry is a registration whose key could not be
 * turned into an address, which is a check that did not run rather than a
 * check that passed.
 */
export type RegistrationCoverage = {
  derivedFromThisTransaction: BuiltRegistration[];
  /** Owner addresses READ off the chain as already registered. Never assumed. */
  alreadyRegisteredOnChain: string[];
  /** Set when the chain could not be asked, which makes the second source unusable. */
  chainProblem?: string;
};

/**
 * One registration read back off the built transaction.
 *
 * TWO ADDRESSES AND THEY ARE NOT THE SAME QUESTION. `owner` is the address the
 * registration's night key derives, which decides WHICH outputs start
 * generating. `dustReceiver` is the address the generation is delegated TO,
 * which decides WHO CAN SPEND IT.
 *
 * A registration naming the right owner and somebody else's receiver looks
 * completely correct from the owner's side and delivers nothing: the outputs
 * are registered, they generate, and every speck belongs to another wallet.
 * The chain does exactly what it was asked; the wallet holding the NIGHT
 * cannot pay a fee, which is the same end state as never registering at all.
 *
 * So both are read off the transaction, and `expectedDustReceiver` is derived
 * separately, from the wallet the outputs are FOR. The two arrive from
 * different places on purpose: a check comparing a value against itself cannot
 * fail.
 */
export type BuiltRegistration = {
  /** The owner address this registration's night key derives, or null if it would not derive. */
  owner: string | null;
  /** The address generation is delegated to, read off the registration. */
  dustReceiver: string | null;
  /** Where it should be going, derived from the wallet these outputs are for. */
  expectedDustReceiver: string | null;
};

/**
 * What the fee balancer did. There is no fourth answer and `unknown` is not a pass.
 *
 * `converged` COUNTS WHAT ENDED UP ON THE TRANSACTION, NOT HOW MANY TIMES THE
 * LIBRARY WENT ROUND. The balancing is a fixed point - cover what is owed,
 * which makes the transaction bigger, which raises what is owed - and the only
 * part of it visible from outside the library is its result: how many
 * fee-paying spends the finished transaction carries. Counting the passes
 * themselves needs a method the library does not put on anything a caller
 * holds, and a count taken from an object that does not have it is zero, which
 * reads as convergence on the first pass and passes every comparison. The
 * spends are read off the artefact and cannot be zero by accident.
 */
export type BalancerOutcome =
  | { kind: 'converged'; feePayingSpends: number }
  | { kind: 'threw'; message: string }
  | { kind: 'unknown'; why: string };

/** The three numbers the dismiss check turns on, in picoseconds and bytes. */
export type DismissNumbers = {
  dismissPs: number | null;
  sizeBytes: number | null;
  allowancePs: number | null;
};

/**
 * What the chain's own cost call said about the finished transaction.
 *
 * `refused` CARRIES THE NUMBERS. The call reports the failure by throwing, and
 * the throw is the one branch where the numbers matter, so they are parsed out
 * of the message rather than discarded in favour of the message.
 */
export type CostOutcome =
  | { kind: 'within'; numbers: DismissNumbers }
  | { kind: 'refused'; numbers: DismissNumbers; message: string }
  | { kind: 'unreadable'; message: string };

/** Everything the seven checks are computed from. Gathered once by the door, never re-derived. */
export type FundingReading = {
  parameters: ParametersReading;
  cost: CostOutcome;
  intended: IntendedOutput[];
  built: BuiltOutput[];
  coverage: RegistrationCoverage;
  /** Registered NIGHT outputs the OLD wallet would still hold afterwards. Null means not established. */
  oldWalletRegisteredOutputsAfter: number | null;
  balancer: BalancerOutcome;
  /** How many fee-paying spends this shape is expected to carry. */
  feePayingSpendsExpected: number;
};

/**
 * One check's answer.
 *
 * THERE IS ALWAYS ONE OF THESE PER CHECK, PASSED OR NOT. A door that prints
 * only its failures cannot show that a check ran, and a check that silently
 * did not run looks exactly like a check that passed.
 */
export type Verdict = {
  /** Stable number, so the door and a person can talk about the same check. */
  check: number;
  name: string;
  passed: boolean;
  /** One line, in terms the reader can act on. */
  line: string;
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/* ------------------------------------------------- reading a built thing -- */

/**
 * WHAT A TRANSACTION ACTUALLY CARRIES, AS OPPOSED TO WHAT IT WAS ASKED TO.
 *
 * These four are the door's eyes and they are here rather than in the door
 * because the door cannot be run and nothing in it can be pinned. Each takes a
 * plain shape - a map of intents, offers with outputs - so a test drives them
 * with an object rather than with a wallet.
 *
 * THE SHIELDED OFFERS ARE NOT READ AND THAT IS DELIBERATE. A transaction also
 * carries `guaranteedOffer` and `fallibleOffer`; those are the shielded side,
 * whose outputs carry no owner, type or value. Reading them matched nothing,
 * cost nothing, and was a line standing on a wrong belief.
 */
export type IntentLike = {
  guaranteedUnshieldedOffer?: { outputs?: unknown[]; inputs?: unknown[]; signatures?: unknown[] } | undefined;
  fallibleUnshieldedOffer?: { outputs?: unknown[]; inputs?: unknown[]; signatures?: unknown[] } | undefined;
  dustActions?: { spends?: unknown[]; registrations?: unknown[] } | undefined;
};

/**
 * The intents of a transaction, keyed by the segment each sits in.
 *
 * A transaction carries them in a map of segment to intent, so iterating gives
 * pairs and the intent is the second of each. THAT IS THE ONLY SHAPE HANDLED,
 * AND TWO OTHERS WERE DELETED RATHER THAN LEFT IN: a branch for bare intents
 * and a filter for empty entries, neither of which any transaction produces.
 * They were unreachable, and therefore unpinned, in a reader that money
 * decisions are taken from - which is the same fault as the shielded offers
 * this file already removed once.
 *
 * ANYTHING ELSE READS AS NOTHING, AND NOTHING IS REFUSED RATHER THAN PASSED.
 * An empty reading reaches the section check and the registration check, and
 * both of those refuse on empty, so a shape this does not understand becomes a
 * loud verdict rather than a quiet zero.
 */
export const intentsOf = (tx: unknown): IntentLike[] => {
  const held = (tx as any)?.intents;
  if (!held || typeof held[Symbol.iterator] !== 'function') return [];
  const out: IntentLike[] = [];
  for (const entry of held as Iterable<unknown>) {
    if (Array.isArray(entry) && entry[1]) out.push(entry[1] as IntentLike);
  }
  return out;
};

/** Every output of the fee-paying token, with the half it sits in. */
export function outputsOf(tx: unknown, nightToken: string): BuiltOutput[] {
  const found: BuiltOutput[] = [];
  for (const intent of intentsOf(tx)) {
    for (const [offer, section] of [
      [intent?.guaranteedUnshieldedOffer, 'guaranteed' as Section],
      [intent?.fallibleUnshieldedOffer, 'fallible' as Section],
    ] as const) {
      for (const o of (offer as any)?.outputs ?? []) {
        if ((o as any)?.type !== nightToken) continue;
        found.push({ owner: String((o as any).owner), value: BigInt((o as any).value), section });
      }
    }
  }
  return found;
}

/**
 * Every registration, with BOTH of its addresses and where they should point.
 *
 * A registration names the address that starts earning AND the address the
 * earnings belong to. Reading only the first is how a transaction comes to look
 * entirely correct while handing a wallet NIGHT it cannot spend a speck of.
 */
export function registrationsOf(
  tx: unknown,
  ownerFromKey: (key: unknown) => string,
  expectedDustReceiver: string | null,
): BuiltRegistration[] {
  const found: BuiltRegistration[] = [];
  for (const intent of intentsOf(tx)) {
    for (const reg of (intent?.dustActions?.registrations ?? []) as any[]) {
      let owner: string | null = null;
      try { owner = String(ownerFromKey(reg?.nightKey)); } catch { owner = null; }
      const raw = reg?.dustAddress;
      found.push({
        owner,
        dustReceiver: raw === undefined || raw === null ? null : String(raw),
        expectedDustReceiver,
      });
    }
  }
  return found;
}

/**
 * How many fee-paying spends the finished transaction carries.
 *
 * The balancing's RESULT rather than its working, and the only part of it
 * visible from outside the wallet library. A transaction owing a fee and
 * carrying none of these is refused as malformed, so zero is a refusal.
 */
export function feePayingSpendsOf(tx: unknown): number {
  let n = 0;
  for (const intent of intentsOf(tx)) n += (intent?.dustActions?.spends ?? []).length;
  return n;
}

/**
 * Whether everything that has to be signed has been.
 *
 * READ OFF THE TRANSACTION, NOT INFERRED FROM HAVING CALLED A SIGNER. The two
 * signatures here come from two different wallets: the inputs belong to the one
 * paying, and the registration has to be signed by the key it registers, which
 * is the one being funded. A single signer cannot make both, and a transaction
 * missing either is refused by the chain.
 */
export function signaturesOf(tx: unknown): { inputs: number; signatures: number; registrations: number; signedRegistrations: number } {
  let inputs = 0, signatures = 0, registrations = 0, signedRegistrations = 0;
  for (const intent of intentsOf(tx)) {
    for (const offer of [intent?.guaranteedUnshieldedOffer, intent?.fallibleUnshieldedOffer]) {
      inputs += ((offer as any)?.inputs ?? []).length;
      signatures += ((offer as any)?.signatures ?? []).length;
    }
    for (const reg of (intent?.dustActions?.registrations ?? []) as any[]) {
      registrations += 1;
      if (reg?.signature !== undefined && reg?.signature !== null) signedRegistrations += 1;
    }
  }
  return { inputs, signatures, registrations, signedRegistrations };
}

/* --------------------------------------------------------------- the plan -- */

/**
 * Splitting one wallet's holding into the outputs the act needs.
 *
 * THE REMAINDER GOES TO THE OLD WALLET ON PURPOSE. Dividing into equal shares
 * leaves a remainder, and it has to land somewhere; putting it on the output
 * left behind means the spare is never the SMALLEST of the outputs, and the
 * arithmetic adds back to exactly what was there. NIGHT that does not add up is
 * refused by the chain rather than burnt, so a mistake here costs the act and
 * not the money - but it costs the act every time until somebody finds it.
 */
export function planOutputs(total: bigint, count: number, newOwner: string, oldOwner: string): IntendedOutput[] | null {
  if (count < 1) return null;
  const share = total / BigInt(count + 1);
  if (share <= 0n) return null;
  const purposes = ['ordinary work', 'the exit', 'a spare'];
  const out: IntendedOutput[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ owner: newOwner, value: share, purpose: purposes[i] ?? 'a spare' });
  }
  out.push({ owner: oldOwner, value: total - share * BigInt(count), purpose: 'left with the old wallet, the only repair there is' });
  return out;
}

/* ------------------------------------------------------------------ 1 ---- */

/**
 * The chain's parameters were read from the chain.
 *
 * Every fee, limit and dismiss figure below is computed at whatever parameters
 * are handed in. The library's built-in starting values are not what any live
 * chain runs, so a verdict computed at them describes a chain that does not
 * exist. A reading that fell back is refused BY NAME rather than downgraded to
 * a warning, because the warning is what a person skips.
 */
export function checkParameters(reading: ParametersReading): Verdict {
  const name = 'the chain\'s own parameters were read';
  if (reading.source === 'fallback') {
    return {
      check: 1, name, passed: false,
      line: 'the parameters came from the library\'s built-in starting values, not from the chain. '
        + `The check that could not run is the state call that asks the node what it is running: ${reading.problem ?? 'no reason given'}. `
        + 'Every number below would describe a chain nobody is running.',
    };
  }
  if (reading.parameters === null) {
    return {
      check: 1, name, passed: false,
      line: `the chain's parameters could not be read from ${reading.node ?? 'the node'}, so nothing below could be computed against them: ${reading.problem ?? 'no reason given'}`,
    };
  }
  return {
    check: 1, name, passed: true,
    line: `read from ${reading.node ?? 'the node'}, ${reading.payloadBytes ?? 0} bytes, tagged ${reading.tag ?? '(none)'}`,
  };
}

/* ------------------------------------------------------------------ 2 ---- */

const ps = (v: number | null) =>
  v === null ? '(not read)' : `${(v / 1e9).toFixed(3)}ms`;

/**
 * The chain's own cost call accepted the finished transaction.
 *
 * This is the same arithmetic the node performs before it answers, asked
 * locally, for nothing, while everything is still retryable.
 */
export function checkCost(cost: CostOutcome): Verdict {
  const name = 'the chain\'s own cost call accepts the transaction';
  if (cost.kind === 'unreadable') {
    return {
      check: 2, name, passed: false,
      line: `the cost could not be computed, so the node's answer cannot be anticipated: ${cost.message}`,
    };
  }
  if (cost.kind === 'refused') {
    const { dismissPs, allowancePs, sizeBytes } = cost.numbers;
    const over =
      dismissPs !== null && allowancePs !== null
        ? `, over by ${ps(dismissPs - allowancePs)} (${(((dismissPs - allowancePs) / allowancePs) * 100).toFixed(1)}%)`
        : '';
    return {
      check: 2, name, passed: false,
      line: `the transaction would take ${ps(dismissPs)} to dismiss against an allowance of ${ps(allowancePs)} `
        + `at ${sizeBytes === null ? '(size not read)' : `${sizeBytes} bytes`}${over}. `
        + 'Submitting it would be refused without a fee being taken.',
    };
  }
  const { dismissPs, allowancePs, sizeBytes } = cost.numbers;
  if (dismissPs === null || allowancePs === null) {
    /*
     * ACCEPTED, AND THE MARGIN IS NOT KNOWN. Saying so is the point: the line
     * this replaced printed "(not read)" in place of both numbers and read like
     * a margin somebody had measured. The verdict still passes, because what
     * passed it is the chain's own call accepting the transaction, not the
     * numbers printed beside it.
     */
    return {
      check: 2, name, passed: true,
      line: 'accepted by the chain\'s own cost call'
        + (sizeBytes === null ? '' : ` at ${sizeBytes} bytes`)
        + '. THE MARGIN WAS NOT ESTABLISHED, so nothing here says how close it came.',
    };
  }
  return {
    check: 2, name, passed: true,
    line: `${ps(dismissPs)} to dismiss against an allowance of ${ps(allowancePs)} at ${sizeBytes === null ? '(size not read)' : `${sizeBytes} bytes`}`
      + `, ${ps(allowancePs - dismissPs)} under (${((1 - dismissPs / allowancePs) * 100).toFixed(1)}% of the allowance to spare)`,
  };
}

/**
 * The three numbers out of the cost call's refusal message.
 *
 * The refusal is delivered as text and the numbers are in it. Returning nulls
 * on a message that does not match is deliberate: a parser that invents a
 * number when the wording changes is worse than one that says it did not read
 * it, because the number is what the reader acts on.
 *
 * THE MICRO SIGN IS THE GREEK LETTER AND NOT THE LETTER U. A parser written
 * for `us` reads every microsecond figure as unmatched. It is spelled as an
 * escape rather than as the character itself, because this file crosses
 * machines and an encoding that mangles one glyph would silently disarm the
 * only place it appears.
 */
export function parseDismissMessage(message: string): DismissNumbers {
  const out: DismissNumbers = { dismissPs: null, sizeBytes: null, allowancePs: null };
  const take = /would take ([0-9.]+)(ps|ns|\u03bcs|ms|s) to dismiss/.exec(message);
  if (take) out.dismissPs = toPicoseconds(Number(take[1]), take[2]!);
  const size = /size of ([0-9]+) bytes/.exec(message);
  if (size) out.sizeBytes = Number(size[1]);
  const most = /at most ([0-9.]+)(ps|ns|\u03bcs|ms|s)/.exec(message);
  if (most) out.allowancePs = toPicoseconds(Number(most[1]), most[2]!);
  return out;
}

const UNITS: Record<string, number> = { ps: 1, ns: 1e3, '\u03bcs': 1e6, ms: 1e9, s: 1e12 };

/**
 * THE TWO CONSTANTS THE ALLOWANCE IS BUILT FROM, OUT OF THE PARAMETERS' OWN TEXT.
 *
 * The allowance a transaction is granted for being dismissed is
 * `max(per-byte cost x size, a floor)`. Both terms live in the ledger
 * parameters and NEITHER IS EXPOSED TO A CALLER: the object published to
 * JavaScript offers the cost model, the dust parameters, the fee prices, a
 * normaliser and a serialiser, and no limits at all. Reading them off the
 * printed form is the only route there is.
 *
 * IT IS A WEAKER READING THAN THE REST OF THIS FILE AND IS TREATED AS ONE. A
 * printed form can be reworded, so a failure to match returns nulls and the
 * margin is reported as not established rather than filled in with a guess.
 * Nothing is REFUSED on it: a cost the chain's own call accepted is accepted
 * whether or not the margin could be printed beside it.
 */
export function dismissLimitsFrom(parametersText: string): { perBytePs: number | null; floorPs: number | null } {
  const grab = (field: string): number | null => {
    const m = new RegExp(field + ':\\s*([0-9.]+)(ps|ns|\\u03bcs|ms|s)\\b').exec(parametersText);
    return m ? toPicoseconds(Number(m[1]), m[2]!) : null;
  };
  return { perBytePs: grab('time_to_dismiss_per_byte'), floorPs: grab('min_time_to_dismiss') };
}

/** `max(per byte x size, the floor)`, or null when either term was not read. */
export function allowanceFor(limits: { perBytePs: number | null; floorPs: number | null }, sizeBytes: number | null): number | null {
  if (limits.perBytePs === null || limits.floorPs === null || sizeBytes === null) return null;
  return Math.max(limits.perBytePs * sizeBytes, limits.floorPs);
}

export function toPicoseconds(value: number, unit: string): number | null {
  const scale = UNITS[unit];
  if (scale === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * scale);
}

/* ------------------------------------------------------------------ 3 ---- */

/**
 * Every NIGHT output is in the fallible half.
 *
 * The allowance is charged on the guaranteed half alone, and in that half the
 * largest workable number of NIGHT outputs is one. This check is what stands
 * between a library change nobody announced and an act that quietly stops
 * fitting. It is asserted on the transaction that was BUILT, not on the
 * library's documented behaviour.
 */
export function checkSection(built: BuiltOutput[]): Verdict {
  const name = 'every NIGHT output is in the fallible half';
  if (built.length === 0) {
    return {
      check: 3, name, passed: false,
      line: 'no NIGHT outputs were read off the built transaction, so the half they sit in was never established',
    };
  }
  const guaranteed = built.filter((o) => o.section !== 'fallible');
  if (guaranteed.length > 0) {
    return {
      check: 3, name, passed: false,
      line: `${guaranteed.length} of ${built.length} NIGHT ${plural(guaranteed.length, 'output is', 'outputs are')} in the guaranteed half. `
        + 'The dismiss allowance is charged there, and against the parameters this chain runs the largest workable '
        + 'number of NIGHT outputs in the guaranteed half is one. This transaction would be refused.',
    };
  }
  return { check: 3, name, passed: true, line: `all ${built.length} in the fallible half` };
}

/* ------------------------------------------------------------------ 4 ---- */

const key = (o: { owner: string; value: bigint }) => `${o.owner}:${o.value}`;

/**
 * The transaction carries exactly the NIGHT outputs the plan asked for.
 *
 * Coin selection prepends its own change output inside the wallet library,
 * where the caller never sees it, and that output counts against the same
 * allowance as every other. So the list is read back off the built transaction
 * and compared, in both directions: an output nobody asked for is a surprise,
 * and an output that was asked for and is missing is a different failure with
 * the same remedy, which is to stop.
 */
export function checkOutputs(intended: IntendedOutput[], built: BuiltOutput[]): Verdict {
  const name = 'the transaction carries exactly the planned NIGHT outputs';
  const wanted = new Map<string, number>();
  for (const o of intended) wanted.set(key(o), (wanted.get(key(o)) ?? 0) + 1);
  const got = new Map<string, number>();
  for (const o of built) got.set(key(o), (got.get(key(o)) ?? 0) + 1);

  let extra = 0;
  for (const [k, n] of got) extra += Math.max(0, n - (wanted.get(k) ?? 0));
  let missing = 0;
  for (const [k, n] of wanted) missing += Math.max(0, n - (got.get(k) ?? 0));

  if (extra === 0 && missing === 0) {
    return { check: 4, name, passed: true, line: `${built.length} planned, ${built.length} built, no others` };
  }
  const parts: string[] = [];
  if (extra > 0) {
    parts.push(`${extra} NIGHT ${plural(extra, 'output', 'outputs')} nobody asked for`
      + ' (the wallet library prepends its own coin-selection change, which the caller never sees)');
  }
  if (missing > 0) parts.push(`${missing} planned NIGHT ${plural(missing, 'output is', 'outputs are')} not on the transaction`);
  return { check: 4, name, passed: false, line: parts.join(', ') };
}

/* ------------------------------------------------------------------ 5 ---- */

/**
 * EVERY NIGHT OUTPUT GOES TO AN ADDRESS REGISTERED FOR DUST GENERATION.
 *
 * THIS IS THE ONE THAT PROTECTS THE MONEY. The other six protect a
 * transaction: get one wrong and the transaction is refused, nothing is spent,
 * and it is tried again. Get this one wrong and the transaction SUCCEEDS and
 * the NIGHT it delivered can never be spent by anybody, because the fee for
 * spending it is payable only in dust and the address that holds it generates
 * none.
 *
 * Coverage has two sources and both must be EVIDENCE. A registration on this
 * transaction covers the address its verifying key derives. A registration
 * made earlier covers an address the door has READ off the chain. If the chain
 * could not be asked, the second source is unusable and every output relying
 * on it is uncovered, because the alternative is to assume the thing that
 * cannot be undone.
 */
export function checkRegistration(built: BuiltOutput[], coverage: RegistrationCoverage): Verdict {
  const name = 'every NIGHT output is registered, and its generation goes to its own owner';
  const undecidable = coverage.derivedFromThisTransaction.filter((r) => r.owner === null).length;
  if (undecidable > 0) {
    return {
      check: 5, name, passed: false,
      line: `${undecidable} ${plural(undecidable, 'registration on this transaction carries a verifying key', 'registrations on this transaction carry verifying keys')} `
        + 'that could not be turned into an owner address, so the addresses they cover are unknown. '
        + 'NIGHT delivered to an unregistered address is unspendable for ever, so an unknown is refused exactly like a mismatch.',
    };
  }
  /*
   * WHERE THE GENERATION GOES, WHICH IS A SEPARATE QUESTION FROM WHO IS
   * REGISTERED, AND IS THE ONE THAT DECIDES WHETHER THE MONEY CAN MOVE.
   *
   * Checked before coverage, because a registration delegating elsewhere is
   * worse than no registration: no registration leaves the outputs plainly
   * unable to pay, and a misdirected one leaves them looking able to.
   */
  const misdirected = coverage.derivedFromThisTransaction.filter(
    (r) => r.dustReceiver === null || r.expectedDustReceiver === null || r.dustReceiver !== r.expectedDustReceiver,
  );
  if (misdirected.length > 0) {
    const unread = misdirected.filter((r) => r.dustReceiver === null || r.expectedDustReceiver === null).length;
    return {
      check: 5, name, passed: false,
      line: unread > 0
        ? `${unread} ${plural(unread, 'registration does', 'registrations do')} not say where the generation would go, `
          + 'so whether the wallet holding this NIGHT could ever spend it was not established.'
        : `${misdirected.length} ${plural(misdirected.length, 'registration sends', 'registrations send')} the generation to an address `
          + 'other than the one these outputs are for. The outputs would be registered and would generate, and every speck '
          + 'would belong to a different wallet, so the one holding the NIGHT still could not pay a fee to move it. '
          + 'That is the same end state as no registration at all, reached by a transaction that looks correct.',
    };
  }
  if (built.length === 0) {
    return {
      check: 5, name, passed: false,
      line: 'no NIGHT outputs were read off the built transaction, so none of them was checked',
    };
  }
  const here = new Set(coverage.derivedFromThisTransaction
    .map((r) => r.owner)
    .filter((a): a is string => a !== null));
  const earlier = new Set(coverage.alreadyRegisteredOnChain);

  const uncovered: BuiltOutput[] = [];
  const relyingOnChain: BuiltOutput[] = [];
  for (const o of built) {
    if (here.has(o.owner)) continue;
    relyingOnChain.push(o);
    if (!earlier.has(o.owner)) uncovered.push(o);
  }

  if (coverage.chainProblem !== undefined && relyingOnChain.length > 0) {
    return {
      check: 5, name, passed: false,
      line: `${relyingOnChain.length} NIGHT ${plural(relyingOnChain.length, 'output is', 'outputs are')} sent to ${plural(relyingOnChain.length, 'an address', 'addresses')} `
        + 'this transaction does not register, and whether they were registered earlier could not be read from the chain: '
        + `${coverage.chainProblem}. An unread registration is not a registration.`,
    };
  }
  if (uncovered.length > 0) {
    const owners = [...new Set(uncovered.map((o) => o.owner))];
    return {
      check: 5, name, passed: false,
      line: `${uncovered.length} of ${built.length} NIGHT ${plural(uncovered.length, 'output goes', 'outputs go')} to `
        + `${owners.length} ${plural(owners.length, 'address', 'addresses')} not registered for dust generation, here or earlier. `
        + 'That NIGHT would arrive and could never be spent by anyone: its fee is payable only in dust, and an '
        + 'unregistered address generates none. There is no faucet and no repair.',
    };
  }
  const fromHere = built.filter((o) => here.has(o.owner)).length;
  return {
    check: 5, name, passed: true,
    line: `${built.length} of ${built.length} covered: ${fromHere} by a registration on this transaction, `
      + `${built.length - fromHere} by a registration read off the chain`,
  };
}

/* ------------------------------------------------------------------ 6 ---- */

/**
 * The old wallet keeps at least one registered NIGHT output.
 *
 * It is the only thing on chain that could repair a mistake in the new
 * wallet's registration, and it stops being able to the moment it holds
 * nothing that generates dust. Leaving one behind costs nothing measurable in
 * the fallible half.
 */
export function checkSpare(registeredAfter: number | null): Verdict {
  const name = 'the old wallet keeps a registered NIGHT output';
  if (registeredAfter === null) {
    return {
      check: 6, name, passed: false,
      line: 'what the old wallet would hold afterwards was not established, so nothing here can say whether a repair would still be possible',
    };
  }
  if (registeredAfter < 1) {
    return {
      check: 6, name, passed: false,
      line: 'the old wallet would be left with no registered NIGHT output, so it could pay for nothing. '
        + 'If the new wallet turns out to be wrong, there would be no wallet left able to fix it.',
    };
  }
  return {
    check: 6, name, passed: true,
    line: `${registeredAfter} registered NIGHT ${plural(registeredAfter, 'output', 'outputs')} left behind, able to pay for a repair`,
  };
}

/* ------------------------------------------------------------------ 7 ---- */

/**
 * The fee balancer finished, and finished where it was expected to.
 *
 * It is a fixed-point loop: cover the fee, which makes the transaction bigger,
 * which raises the fee. A wallet holding several spendable outputs is the
 * state in which it has something to iterate over. A throw is a refusal and
 * MUST NOT read as nothing-happened, which is the shape that has let this
 * project submit on a wallet it believed was configured and was not.
 */
export function checkBalancer(outcome: BalancerOutcome, expected: number): Verdict {
  const name = 'the fee balancer finished, and paid with what this shape was measured to need';
  if (outcome.kind === 'threw') {
    return { check: 7, name, passed: false, line: `the fee balancer failed: ${outcome.message}` };
  }
  if (outcome.kind === 'unknown') {
    return {
      check: 7, name, passed: false,
      line: `what the fee balancer did was not established: ${outcome.why}. A failure that is not recorded reads exactly like a success.`,
    };
  }
  if (outcome.feePayingSpends < 1) {
    /*
     * A TRANSACTION OWING A FEE AND CARRYING NO SPEND TO PAY IT IS REFUSED AS
     * MALFORMED, and zero is also what a broken count returns, so the two
     * failures are refused together rather than one of them passing as the other.
     */
    return {
      check: 7, name, passed: false,
      line: 'the transaction carries no fee-paying spend at all. A transaction that owes a fee and '
        + 'offers nothing to pay it with is refused as malformed, and a count that came out at zero '
        + 'because nothing was counted looks exactly the same from here.',
    };
  }
  if (outcome.feePayingSpends > expected) {
    return {
      check: 7, name, passed: false,
      line: `the transaction carries ${outcome.feePayingSpends} fee-paying spends where ${expected} ${plural(expected, 'was', 'were')} expected. `
        + 'Each one raises the fee, which is what makes another necessary, so more than expected means the fee is '
        + 'climbing against itself and this is not the shape that was measured.',
    };
  }
  return {
    check: 7, name, passed: true,
    line: `${outcome.feePayingSpends} fee-paying ${plural(outcome.feePayingSpends, 'spend', 'spends')}, at or under the ${expected} expected`,
  };
}

/* ------------------------------------------------------------- all seven -- */

/**
 * ALL SEVEN, ALWAYS, IN ORDER.
 *
 * The array is always seven long whatever the readings say. A door that
 * returned only its failures could not show that a check ran at all, and a
 * check that quietly did not run is indistinguishable from one that passed.
 */
export function fundingVerdicts(reading: FundingReading): Verdict[] {
  return [
    checkParameters(reading.parameters),
    checkCost(reading.cost),
    checkSection(reading.built),
    checkOutputs(reading.intended, reading.built),
    checkRegistration(reading.built, reading.coverage),
    checkSpare(reading.oldWalletRegisteredOutputsAfter),
    checkBalancer(reading.balancer, reading.feePayingSpendsExpected),
  ];
}

/**
 * Nothing is submitted unless every one of the seven passed.
 *
 * EXACTLY SEVEN, NOT AT LEAST SEVEN. A longer list means the caller assembled
 * something other than what this module produces, and a rule that accepts more
 * than it expects accepts a list somebody else built.
 */
export const maySubmit = (verdicts: Verdict[]): boolean =>
  verdicts.length === 7 && verdicts.every((v) => v.passed);

/* ---------------------------------------------------- what it can pay for -- */

/**
 * Whether the new wallet can pay for what comes next, WHICH IS NOT A COUNT.
 *
 * How many registered NIGHT outputs a wallet holds is the CEILING on how many
 * dust spends it can put in one transaction. It is not evidence that it can
 * pay for anything: dust accrues over time, and for roughly half a minute
 * after it is funded a new wallet holds the outputs and not the balance.
 *
 * So this answers from the balance against the fee, says "not yet" while it is
 * short, and never converts a count into a capability.
 */
export function abilityToPay(dustBalance: bigint, feeNeeded: bigint | null, registeredOutputs: number): string {
  const ceiling = `it holds ${registeredOutputs} registered NIGHT ${plural(registeredOutputs, 'output', 'outputs')}, `
    + `so at most ${registeredOutputs} dust ${plural(registeredOutputs, 'spend', 'spends')} can go in one transaction`;
  if (feeNeeded === null) {
    return `dust balance ${dustBalance}. What it will next be asked to pay is not known here, so whether that is enough is not answered. ${ceiling}.`;
  }
  if (dustBalance < feeNeeded) {
    return `NOT YET: dust balance ${dustBalance} against the ${feeNeeded} it will next need. `
      + `Dust accrues over time and this is normal for about half a minute after funding. ${ceiling}.`;
  }
  return `dust balance ${dustBalance}, against the ${feeNeeded} it will next need. ${ceiling}.`;
}
