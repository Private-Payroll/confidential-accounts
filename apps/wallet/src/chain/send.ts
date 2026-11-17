import type { WalletFacade } from '@midnightntwrk/wallet-sdk';
import type { SignSegment } from '@midnightntwrk/wallet-sdk-facade';
import {
  MidnightBech32m, UnshieldedAddress,
} from '@midnightntwrk/wallet-sdk-address-format';
import { payeeAddress } from 'midnight-identity';
import type { PayeeAddress } from 'midnight-identity';
import type { NetworkName } from 'midnight-identity/network';
import { STARS_PER_NIGHT } from './amount.js';
import type { ChainAnswer, PendingOutcome } from './pending.js';
import { describeFailure } from '../lib/failure-text.js';
import { feeFromRecipe, unshieldedStarsTo, unsignedUnshieldedInputs } from './send-recipe.js';
import { SUBMIT_QUIET_MS, authorisedAndProven, balancedAndConfirmed, sendRun, submittedAndWatched } from './send-steps.js';

export { SUBMIT_QUIET_MS, feeFromRecipe, unshieldedStarsTo, unsignedUnshieldedInputs };

/*
 * SENDING — the first thing this wallet does that cannot be taken back.
 * THE SENDING RULES are the list of ways this file can lose money, and
 * every shape below exists because of one of them:
 *
 *  - two KINDS of address, not interchangeable: the recipient is a
 *    parsed, typed value that knows its kind, never a string a screen
 *    guesses about;
 *  - an amount ONE DIVISION from a millionfold error (§7.17): the amount is
 *    parsed once, exactly, into STARs, and the confirmation carries the
 *    exact atomic figure;
 *  - the confirmation is read back FROM THE BALANCED RECIPE, not from the
 *    form — what will actually happen, not what was typed;
 *  - proving may take minutes: the engine re-emits its state on its
 *    own clock, naming the stage, so no screen it drives can ever be still;
 *  - the DANGEROUS MIDDLE: after the proof
 *    succeeds, a failed or silent submission leaves the truth unknowable
 *    from here FOR A WHILE — the engine says exactly that, with the
 *    identifiers, and never guesses. The middle is not a
 *    destination: the payment is WRITTEN DOWN before submission, the engine
 *    keeps asking the chain by identifier until the answer exists, the home
 *    screen carries the question across reloads, and the transaction's own
 *    TTL bounds how long "unknown" can last before "failed, nothing moved"
 *    is a fact rather than a guess.
 *
 * NOTHING HERE MOVES MONEY BY ITSELF. The engine drives a `WalletFacade`
 * handed to it through `SendDoors` — the sending rule made a
 * seam: today every door leads to a REHEARSAL facade over the SDK's
 * simulated chain (`rehearsal.ts`), and stagenet makes the same flow real by
 * handing in a stagenet facade with a WASM prover, changing nothing in this
 * file. The facade owns building, balancing, fees, proving, validation and
 * submission (`WalletFacade` — wallet-sdk-facade/dist/index.d.ts); this
 * engine owns the ORDER, the reading-back, and the honesty of each state.
 */

/* ---------------------------------------------------------------- the plan */

export type RecipientFailure =
  | 'empty'
  | 'not-an-address'
  | 'wrong-network'
  | 'dust-address'
  | 'half-an-address'
  | 'unpayable-kind';

export class RecipientError extends Error {
  readonly code: RecipientFailure;
  constructor(code: RecipientFailure, message: string) {
    super(message);
    this.name = 'RecipientError';
    this.code = code;
  }
}

/**
 * WHO IS BEING PAID — one parsed value that knows which KIND of address it
 * is. The two kinds are different wallets over different keys, and the send
 * screen must say which one it was given in words (§4). The unshielded
 * variant keeps the hex form of the address too, because that is how the
 * ledger writes owners into transaction outputs — it is what lets the
 * confirmation read the recipient back out of the balanced recipe.
 */
export type Recipient =
  | { readonly kind: 'shielded'; readonly address: PayeeAddress }
  | { readonly kind: 'unshielded'; readonly bech32: string; readonly hex: string };

export const recipientBech32 = (recipient: Recipient): string =>
  recipient.kind === 'shielded' ? recipient.address.bech32 : recipient.bech32;

/**
 * The way a recipient enters from outside: parsed, checked, refused by
 * name. The checksum, the kind and the network are all the platform's own
 * checks (`MidnightBech32m.parse`, the codecs' `decode` — read in
 * wallet-sdk-address-format/dist/index.d.ts and index.js: the codec type
 * strings are `shield-addr`, `addr`, `dust`, `shield-cpk`, `shield-epk`).
 * A DUST address is refused with the reason a person can act on: DUST
 * receives generation, it cannot be paid.
 */
export function parseRecipient(raw: string, network: NetworkName): Recipient {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    throw new RecipientError('empty', 'a recipient is needed, and this is empty.');
  }
  let parsed: MidnightBech32m;
  try {
    parsed = MidnightBech32m.parse(trimmed);
  } catch (e) {
    throw new RecipientError('not-an-address',
      `"${trimmed}" is not a Midnight address: ${(e as Error).message}. An address `
      + 'carries its own checksum, so a single mistyped character fails here rather '
      + 'than paying a stranger.');
  }
  switch (parsed.type) {
    case 'shield-addr':
      /* The same door every shielded address enters by — checksum, kind and
       * network checks included, and both key halves from one decode. */
      return { kind: 'shielded', address: payeeAddress(trimmed, network) };
    case 'addr': {
      if (String(parsed.network) !== network) {
        throw new RecipientError('wrong-network',
          `this is an unshielded address for "${String(parsed.network)}", and this `
          + `wallet pays on ${network}. The same person has a different address here.`);
      }
      const address = parsed.decode(UnshieldedAddress, network);
      return { kind: 'unshielded', bech32: parsed.asString(), hex: address.hexString };
    }
    case 'dust':
      throw new RecipientError('dust-address',
        'this is a DUST address. DUST is the fee token: it grows from registered '
        + 'NIGHT and cannot be paid directly, so nothing can be sent to this address.');
    case 'shield-cpk':
    case 'shield-epk':
      throw new RecipientError('half-an-address',
        'this is one half of a shielded address — a single key. Paying somebody '
        + 'needs both halves in one string, the kind that starts mn_shield-addr.');
    default:
      throw new RecipientError('unpayable-kind',
        `this is a "${parsed.type}" value, not an address this wallet can pay.`);
  }
}

export type AmountFailure = 'empty' | 'not-a-number' | 'too-small' | 'zero' | 'negative';

export class AmountError extends Error {
  readonly code: AmountFailure;
  constructor(code: AmountFailure, message: string) {
    super(message);
    this.name = 'AmountError';
    this.code = code;
  }
}

/**
 * NIGHT as typed → STARs, exactly — the inverse of `nightFromStars`, held
 * to the same §7.17 bar: no floating point anywhere near money, every digit
 * accounted for, and a seventh decimal refused rather than rounded, because
 * rounding an amount is deciding to move different money than the person
 * typed.
 */
export function starsFromNight(text: string): bigint {
  const trimmed = (text ?? '').trim().replace(/,/gu, '');
  if (!trimmed) throw new AmountError('empty', 'an amount is needed.');
  const match = /^(?<sign>-?)(?<whole>\d+)?(?:\.(?<fraction>\d+))?$/u.exec(trimmed);
  if (!match?.groups || (!match.groups.whole && !match.groups.fraction)) {
    throw new AmountError('not-a-number',
      `"${text}" is not an amount. Digits and one dot, like 12 or 0.5.`);
  }
  if (match.groups.sign === '-') {
    throw new AmountError('negative', 'an amount below zero cannot be sent.');
  }
  const fraction = match.groups.fraction ?? '';
  if (fraction.length > 6 && /[1-9]/u.test(fraction.slice(6))) {
    throw new AmountError('too-small',
      'NIGHT has six decimal places — 1 NIGHT is 1,000,000 STARs — so digits '
      + 'past the sixth would name money that cannot exist. Nothing was rounded; '
      + 'shorten the amount instead.');
  }
  const stars = BigInt(match.groups.whole ?? '0') * STARS_PER_NIGHT
    + BigInt(fraction.slice(0, 6).padEnd(6, '0'));
  if (stars === 0n) throw new AmountError('zero', 'zero cannot be sent.');
  return stars;
}

export interface SendPlan {
  readonly recipient: Recipient;
  readonly stars: bigint;
}

/* ------------------------------------------------------------- the states */

export type SendStage = 'starting' | 'balancing' | 'signing' | 'proving' | 'submitting';

/** What each stage should say while it runs. */
export const STAGE_WORDS: Record<SendStage, string> = {
  starting: 'Reading what this wallet holds — nothing is being sent.',
  balancing: 'Choosing coins and computing the fee — nothing is being sent.',
  signing: 'Authorising the coins this payment spends — nothing is being sent yet.',
  proving: 'Building the proof. This can take minutes on a real chain, and the '
    + 'clock above is this wallet’s own — the screen is working, not stuck.',
  submitting: 'Handing the transaction to the network.',
};

/**
 * What the person is asked to agree to — READ BACK FROM THE BALANCED
 * RECIPE wherever the transaction can be read at all, and said plainly
 * where it cannot (a shielded output is ciphertext to everyone but its
 * recipient — that is the product working, and the confirmation says which
 * numbers are read back and which are the builder's input restated).
 */
export interface SendFacts {
  readonly kind: 'shielded' | 'unshielded';
  readonly recipientBech32: string;
  /** STARs to the recipient. For an unshielded send this is summed out of
   * the recipe's own outputs; for a shielded send it is the one value that
   * was handed to the builder (see `readBack`). */
  readonly stars: bigint;
  /** Where `stars` was read from — shown on the confirmation, because "the
   * transaction says" and "the form said" are different strengths of claim. */
  readonly readBack: 'transaction' | 'builder-input';
  /** The fee, in SPECKs, summed from the recipe's own dust spends. */
  readonly feeSpecks: bigint;
  /** The paying side's NIGHT before and after, in STARs. */
  readonly nightBefore: bigint;
  readonly nightAfter: bigint;
  /** DUST before and after the fee, in SPECKs, at the moment of balancing. */
  readonly dustBefore: bigint;
  readonly dustAfter: bigint;
}

export type SendState =
  /** A stage in flight. Re-emitted every second with a fresh `forMs` by the
   * engine's OWN clock — a screen rendering this can never be still. */
  | { readonly name: 'working'; readonly stage: SendStage; readonly forMs: number }
  /** The balanced recipe exists and nothing is signed, proved or sent.
   * Waiting for a person. */
  | { readonly name: 'confirm'; readonly facts: SendFacts }
  /** Stopped before anything moved — by refusal or by the person. The
   * booked coins were released (`facade.revert`). */
  | { readonly name: 'cancelled' }
  | { readonly name: 'refused'; readonly message: string }
  /** The network accepted it. The one state allowed a cheerful sentence. */
  | { readonly name: 'sent'; readonly txId: string; readonly facts: SendFacts }
  /**
   * The chain itself answered NO — included-and-failed, or the transaction's
   * own TTL passed without inclusion, so it can never land. Unlike `refused`
   * (stopped before submission) this is a RESOLVED middle: the answer came
   * from the chain, not from a guess (every send ends sent or
   * failed, and the only in-between is the watched one below).
   */
  | {
    readonly name: 'failed';
    readonly message: string;
    readonly identifiers: readonly string[];
    readonly facts: SendFacts;
  }
  /**
   * THE DANGEROUS MIDDLE: no longer a place to
   * end up. The proof succeeded and the submission failed or has not
   * answered; money may or may not have moved and this wallet does not know
   * YET — so it says exactly that, hands over the identifiers, and KEEPS
   * WATCHING THE CHAIN until the answer exists: found → `sent` or `failed`;
   * not found past the transaction's own TTL → `failed`, as a fact. The
   * payment was written down BEFORE submission, so the question survives a
   * killed tab and the home screen carries it to its answer. `stillWaiting`
   * is ALWAYS true — an unwatched middle was the defect.
   */
  | {
    readonly name: 'unknown';
    readonly identifiers: readonly string[];
    readonly message: string;
    readonly facts: SendFacts;
    readonly stillWaiting: true;
  };

/* -------------------------------------------------------------- the doors */

/**
 * Everything the engine needs handed in, nothing it constructs itself.
 * A rehearsal hands in rehearsal doors (`rehearsal.ts`); stagenet hands in stagenet doors
 * with the WASM prover. The engine cannot tell the difference — that is the
 * seam the design requires.
 */
export interface SendDoors {
  /** A STARTED facade over the paying wallet. */
  readonly facade: () => Promise<WalletFacade>;
  /**
   * THE UNSHIELDED SIGNER. Every unshielded input this wallet
   * spends must carry a signature over its intent's own `signatureData`,
   * and `transferTransaction` signs nothing: the signer is a separate
   * argument to a separate call, `signRecipe(recipe, signSegment)`, and this
   * door is where it comes from. The facade holds the account's keys from
   * when it was started, so no other secret is handed to the engine.
   *
   * `SignSegment` is `(data: Uint8Array) => Promise<Signature>` — async so an
   * out-of-process signer (MPC, HSM) can be handed in unchanged. The
   * keystore's own `signDataAsync` satisfies it directly. Derived per call.
   */
  readonly signSegment: () => SignSegment;
  /** The paying wallet's own unshielded address, hex form — how change is
   * told apart from payment when the recipe is read back. */
  readonly ownUnshieldedHex: string;
  /** How long a silent submission is given before the middle is said out
   * loud. Defaults to `SUBMIT_QUIET_MS`; tests shorten it because a test
   * that really waits 45 seconds is a test nobody runs. */
  readonly submitQuietMs?: number;
  /**
   * THE WRITTEN-DOWN MIDDLE. `write` is called BEFORE the submit
   * call (that ordering is pinned in tests: a payment that is not written
   * down is not submitted); `settle` when the engine learns the outcome;
   * `duplicateUnresolved` refuses the same payment while one is in flight.
   * Live doors bind this to the account's store (`pending.ts`); rehearsal
   * doors bind it to a throwaway, because a pretend send must never leave
   * a real record.
   */
  readonly pending?: {
    readonly duplicateUnresolved: (recipientBech32: string, stars: bigint) => boolean;
    readonly write: (draft: {
      readonly identifiers: readonly string[];
      readonly kind: 'shielded' | 'unshielded';
      readonly recipientBech32: string;
      readonly stars: bigint;
      readonly feeSpecks: bigint;
      readonly ttlAt: number;
    }) => void;
    readonly settle: (key: string, outcome: PendingOutcome) => void;
  };
  /** The chain, asked by identifier — what the unknown middle watches.
   * Absent means the engine cannot watch from here (the home screen still
   * can: the record was written), and the middle says it is being carried. */
  readonly transactionStatus?: (identifier: string) => Promise<ChainAnswer>;
  /** The transaction's time-to-live: one hour, the facade's own default,
   * unless a test shortens it to prove the TTL turns a silent chain into a fact. */
  readonly ttlMs?: number;
  /** How often the unknown middle re-asks the chain. */
  readonly watchEveryMs?: number;
  /** How far past the TTL "not found" becomes "failed" — see pending.ts. */
  readonly settleMarginMs?: number;
}

export interface SendController {
  /** Valid in `confirm` only: proceed to prove and submit. */
  readonly confirm: () => void;
  /** Valid in `confirm` only: release the booked coins and stop. */
  readonly cancel: () => void;
  /** Stop listening (leaving the screen). Never cancels an in-flight
   * submission — a transaction on its way to a network cannot be recalled,
   * so this only silences the reporting. */
  readonly detach: () => void;
}

/**
 * One send, driven start to finish. States arrive through `onState`; the
 * returned handle carries the person's two decisions (confirm, cancel)
 * and the screen's exit (detach).
 */
export function startSend(
  doors: SendDoors,
  plan: SendPlan,
  onState: (state: SendState) => void,
): SendController {
  const run = sendRun(onState);
  const { tell, leaveStages } = run;
  void (async (): Promise<void> => {
    /* No state is ever reported synchronously out of startSend — the caller
     * holds the handle before the first callback runs. (The duplicate
     * refusal below would otherwise fire before this function returned.) */
    await Promise.resolve();
    try {
      const confirmed = await balancedAndConfirmed(run, doors, plan);
      if (confirmed === null) return;
      const proven = await authorisedAndProven(run, doors, confirmed);
      if (proven === null) return;
      await submittedAndWatched(run, doors, plan, confirmed, proven);
    } catch (e) {
      /* Any failure before the middle: nothing signed, proved or sent. */
      leaveStages();
      tell({
        name: 'refused',
        message: `${describeFailure(e)}. Nothing was sent and no money moved.`,
      });
    } finally {
      leaveStages();
    }
  })();

  return {
    confirm: () => run.decideAs('confirm'),
    cancel: () => run.decideAs('cancel'),
    /* Detaching silences THIS engine — never the question: the pending
     * record survives in storage, and the home screen (and every start)
     * resolves it against the chain without being asked. */
    detach: run.detach,
  };
}
