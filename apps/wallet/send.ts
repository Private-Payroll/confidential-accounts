import type { WalletFacade } from '@midnightntwrk/wallet-sdk';
import type { BalancingRecipe, SignSegment } from '@midnightntwrk/wallet-sdk-facade';
import {
  MidnightBech32m, ShieldedAddress, UnshieldedAddress,
} from '@midnightntwrk/wallet-sdk-address-format';
import type { DustSecretKey, ZswapSecretKeys } from '@midnightntwrk/ledger-v9';
import { nativeToken, shieldedToken } from '@midnightntwrk/ledger-v9';
import { payeeAddress } from 'midnight-identity';
import type { PayeeAddress } from 'midnight-identity';
import type { NetworkName } from 'midnight-identity/network';
import { STARS_PER_NIGHT } from './amount.js';
import { TTL_SETTLE_MARGIN_MS, outcomeOfAnswer } from './pending.js';
import type { ChainAnswer, PendingOutcome } from './pending.js';
import { describeFailure } from './failure-text.js';

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
   * Fresh secret keys, derived per call. The names are the facade's own
   * parameter shape (`transferTransaction(outputs, secretKeys, …)` takes
   * `{shieldedSecretKeys, dustSecretKey}` — wallet-sdk-facade/dist/
   * index.d.ts:427). Misnaming these fields does not fail loudly: the
   * facade destructures them, hands `undefined` to the ledger and the
   * error says "expected instance of ZswapSecretKeys" — measured, the
   * hard way, while building this file.
   */
  readonly keys: () => {
    readonly shieldedSecretKeys: ZswapSecretKeys;
    readonly dustSecretKey: DustSecretKey;
  };
  /**
   * THE UNSHIELDED SIGNER. Every unshielded input this wallet
   * spends must carry a signature over its intent's own `signatureData`,
   * and `transferTransaction`'s `secretKeys` has NOWHERE to pass one:
   * it takes `{shieldedSecretKeys, dustSecretKey}` and nothing else
   * (`wallet-sdk-facade/dist/index.d.ts:427-433`). The signer is a
   * separate argument to a separate call, `signRecipe(recipe, signSegment)`
   * (`index.d.ts:416`), and this door is where it comes from.
   *
   * `SignSegment` is `(data: Uint8Array) => Promise<Signature>`
   * (`wallet-sdk-unshielded-wallet/dist/v1/Signing.d.ts:10`) — async so an
   * out-of-process signer (MPC, HSM) can be handed in unchanged. The
   * keystore's own `signDataAsync` satisfies it directly, and its type
   * comment names `signRecipe` as the intended call site
   * (`KeyStore.d.ts:23-29`). Derived per call, like `keys()`.
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
  /** The transaction's time-to-live. Defaults to the facade's own figure
   * (one hour — DEFAULT_TTL_MS, wallet-sdk-facade/dist/index.js:152); tests
   * shorten it to prove the TTL turns a silent chain into a fact. */
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

/* ------------------------------------------------------- reading the recipe */

/** The recipe's own fee: every dust spend's `vFee`, summed (`DustSpend`
 * carries it — ledger-v9.d.ts:1543). */
export const feeFromRecipe = (recipe: BalancingRecipe): bigint => {
  let fee = 0n;
  for (const tx of BalancingRecipeTransactions(recipe)) {
    for (const intent of tx.intents?.values() ?? []) {
      for (const spend of intent.dustActions?.spends ?? []) fee += spend.vFee;
    }
  }
  return fee;
};

/** STARs paid to one unshielded address, read out of the recipe's outputs
 * (`UtxoOutput.owner`/`value` — ledger-v9.d.ts:1882). */
export const unshieldedStarsTo = (recipe: BalancingRecipe, ownerHex: string): bigint => {
  const night = nativeToken().raw;
  let stars = 0n;
  for (const tx of BalancingRecipeTransactions(recipe)) {
    for (const intent of tx.intents?.values() ?? []) {
      for (const offer of [intent.guaranteedUnshieldedOffer, intent.fallibleUnshieldedOffer]) {
        for (const out of offer?.outputs ?? []) {
          if (out.owner === ownerHex && out.type === night) stars += out.value;
        }
      }
    }
  }
  return stars;
};

/* The transactions a recipe carries, whatever its shape — the three recipe
 * variants are the SDK's (wallet-sdk-facade/dist/index.d.ts:114–131). */
const BalancingRecipeTransactions = (recipe: BalancingRecipe) => {
  switch (recipe.type) {
    case 'UNPROVEN_TRANSACTION': return [recipe.transaction];
    case 'FINALIZED_TRANSACTION': return [recipe.originalTransaction, recipe.balancingTransaction];
    case 'UNBOUND_TRANSACTION':
      return recipe.balancingTransaction
        ? [recipe.baseTransaction, recipe.balancingTransaction]
        : [recipe.baseTransaction];
  }
};

/* ------------------------------------------------- The signature check */

/**
 * WHAT AN UNSIGNED TRANSFER LOOKS LIKE, counted.
 *
 * An unshielded input is authorised by a signature over the intent's own
 * `signatureData`. `UnshieldedOffer` carries `inputs`, `outputs` and
 * `signatures` side by side (`ledger-v9.d.ts:2163-2177`), and the chain
 * refuses a transfer whose counts do not match — measured on stagenet, in
 * the ledger's own words:
 *
 *     unshielded offer action validation error: mismatch between number of
 *     inputs (1) and signatures (0)
 *
 * Both offers on an intent are counted: `guaranteedUnshieldedOffer` and
 * `fallibleUnshieldedOffer` (`ledger-v9.d.ts:2133, 2139`) — a plain transfer
 * lands in the fallible one, and reading only the guaranteed offer would
 * have found nothing to complain about.
 */
export const unsignedUnshieldedInputs = (recipe: BalancingRecipe): number => {
  let missing = 0;
  for (const tx of BalancingRecipeTransactions(recipe)) {
    const intents = (tx as { intents?: Map<number, unknown> }).intents;
    for (const intent of intents?.values() ?? []) {
      const offers = intent as {
        guaranteedUnshieldedOffer?: { inputs?: unknown[]; signatures?: unknown[] };
        fallibleUnshieldedOffer?: { inputs?: unknown[]; signatures?: unknown[] };
      };
      for (const offer of [offers.guaranteedUnshieldedOffer, offers.fallibleUnshieldedOffer]) {
        if (!offer) continue;
        const inputs = offer.inputs?.length ?? 0;
        const signatures = offer.signatures?.length ?? 0;
        if (inputs > signatures) missing += inputs - signatures;
      }
    }
  }
  return missing;
};

/* --------------------------------------------------------------- the engine */

/** How long a silent submission is given before the middle is named out
 * loud. The same figure as the balance engines' give-up — one
 * project, one patience. */
export const SUBMIT_QUIET_MS = 45_000;

/**
 * One send, driven start to finish. States arrive through `onState`; the
 * returned controller carries the person's two decisions (confirm, cancel)
 * and the screen's exit (detach).
 */
export function startSend(
  doors: SendDoors,
  plan: SendPlan,
  onState: (state: SendState) => void,
): SendController {
  let detached = false;
  let decided: 'confirm' | 'cancel' | null = null;
  let decide: ((choice: 'confirm' | 'cancel') => void) | null = null;

  /* THE WATCH ON THE MIDDLE. Started the moment the outcome stops
   * being known; stopped only by an answer or by the screen leaving (the
   * record in storage keeps the question alive either way — the home screen
   * and every future start resolve it without being asked). */
  let watcher: ReturnType<typeof setInterval> | null = null;
  const stopWatching = (): void => { if (watcher) { clearInterval(watcher); watcher = null; } };

  /* THE ENGINE'S OWN CLOCK. Every working stage re-announces itself
   * every second with its elapsed time, from here, not from the SDK: the
   * lesson taught is that the SDK does not always report its own
   * silence, so the wallet must. */
  let ticker: ReturnType<typeof setInterval> | null = null;
  const tell = (state: SendState): void => { if (!detached) onState(state); };
  const enterStage = (stage: SendStage): void => {
    if (ticker) clearInterval(ticker);
    const startedAt = Date.now();
    tell({ name: 'working', stage, forMs: 0 });
    ticker = setInterval(() => {
      tell({ name: 'working', stage, forMs: Date.now() - startedAt });
    }, 1_000);
  };
  const leaveStages = (): void => { if (ticker) { clearInterval(ticker); ticker = null; } };

  void (async (): Promise<void> => {
    /* No state is ever reported synchronously out of startSend — the caller
     * holds the controller before the first callback runs. (The duplicate
     * refusal below would otherwise fire before this function returned.) */
    await Promise.resolve();
    let facade: WalletFacade;
    let facts: SendFacts | null = null;
    try {
      /* THE DOUBLE-SEND GUARD — the oldest money-loss shape in
       * this product: a person who believes a payment failed sends
       * it again. While THIS payment — same recipient, same exact amount —
       * sits unresolved, the engine refuses at the door, before any wallet
       * is even dialled. */
      if (doors.pending?.duplicateUnresolved(recipientBech32(plan.recipient), plan.stars)) {
        tell({
          name: 'refused',
          message: 'this exact payment — the same recipient, the same amount — was '
            + 'already handed to the network and its outcome is not known yet. '
            + 'Sending it again now is how money gets sent twice. This wallet is '
            + 'watching the first attempt (the home screen carries it); when it '
            + 'settles as sent or failed, this payment can be made again.',
        });
        return;
      }

      /* STARTING — what does this wallet hold, right now? */
      enterStage('starting');
      facade = await doors.facade();
      const before = await facade.waitForSyncedState();
      const now = facade.clock.now();
      const nightBefore = plan.recipient.kind === 'unshielded'
        ? before.unshielded.balances[nativeToken().raw] ?? 0n
        : before.shielded.balances[shieldedToken().raw] ?? 0n;
      const dustBefore = before.dust.balance(now);

      /* BALANCING — the facade builds and balances in one call; the recipe
       * that comes back is the fact the confirmation is read from.
       * `transferTransaction(outputs, secretKeys, {ttl})` and the recipe
       * types: wallet-sdk-facade/dist/index.d.ts:427 and :126. The TTL is
       * the facade's own default figure (DEFAULT_TTL_MS = one hour,
       * index.js:152), from the facade's own clock. */
      enterStage('balancing');
      const output = plan.recipient.kind === 'unshielded'
        ? {
          type: 'unshielded' as const,
          outputs: [{
            type: nativeToken().raw,
            receiverAddress: MidnightBech32m.parse(plan.recipient.bech32)
              .decode(UnshieldedAddress, String(MidnightBech32m.parse(plan.recipient.bech32).network)),
            amount: plan.stars,
          }],
        }
        : {
          type: 'shielded' as const,
          outputs: [{
            type: shieldedToken().raw,
            receiverAddress: MidnightBech32m.parse(plan.recipient.address.bech32)
              .decode(ShieldedAddress, plan.recipient.address.network),
            amount: plan.stars,
          }],
        };
      /* The TTL is the facade's own default figure (DEFAULT_TTL_MS = one
       * hour, index.js:152) unless a test shortens it — and it is
       * ALSO the middle's own exit: a transaction not on chain past its TTL
       * can never land, which is what lets "unknown" end as a fact. */
      const ttl = new Date(facade.clock.now().getTime() + (doors.ttlMs ?? 60 * 60 * 1000));
      const recipe = await facade.transferTransaction([output], doors.keys(), { ttl });

      /* READ BACK what will actually happen. */
      const feeSpecks = feeFromRecipe(recipe);
      let stars = plan.stars;
      let readBack: SendFacts['readBack'] = 'builder-input';
      if (plan.recipient.kind === 'unshielded') {
        stars = unshieldedStarsTo(recipe, plan.recipient.hex);
        readBack = 'transaction';
        /* THE TRIPWIRE: if the transaction does not say what the plan said,
         * the confirmation must not be shown at all — a mismatch here is a
         * defect in this wallet, and no person should be asked to approve
         * a defect. The booked coins are released before refusing. */
        if (stars !== plan.stars) {
          await facade.revert(recipe).catch(() => { /* release is best effort */ });
          tell({
            name: 'refused',
            message: 'the transaction this wallet built does not pay what was asked: '
              + `the form said ${plan.stars} STARs and the transaction says ${stars}. `
              + 'That is a defect in this wallet, nothing was sent, and no money moved.',
          });
          return;
        }
        /* The whole flow of NIGHT, cross-checked: what leaves equals what
         * arrives plus change (the fee leaves in DUST, not NIGHT). */
      }
      facts = {
        kind: plan.recipient.kind,
        recipientBech32: recipientBech32(plan.recipient),
        stars,
        readBack,
        feeSpecks,
        nightBefore,
        nightAfter: nightBefore - stars,
        dustBefore,
        dustAfter: dustBefore - feeSpecks,
      };

      /* CONFIRM — a person decides. Nothing is signed, proved or sent yet,
       * and cancelling releases the coins the balancer booked
       * (`facade.revert(txOrRecipe)` — wallet-sdk-facade/dist/index.d.ts:467). */
      leaveStages();
      tell({ name: 'confirm', facts });
      const choice = decided ?? await new Promise<'confirm' | 'cancel'>((resolve) => {
        decide = resolve;
      });
      if (choice === 'cancel') {
        await facade.revert(recipe).catch(() => { /* release is best effort */ });
        tell({ name: 'cancelled' });
        return;
      }

      /* SIGNING, and the reason this stage exists at all.
       *
       * An unshielded input is authorised by a signature over its intent's
       * own `signatureData`, and `transferTransaction` has nowhere to put a
       * signer: its `secretKeys` is `{shieldedSecretKeys, dustSecretKey}`
       * and nothing else (facade/index.d.ts:427-433). Signing is a SEPARATE
       * CALL — `signRecipe(recipe, signSegment)` (index.d.ts:416) — and
       * until recently this wallet never made it, so every unshielded transfer it
       * ever built was refused by the chain at the last gate:
       *
       *     unshielded offer action validation error: mismatch between
       *     number of inputs (1) and signatures (0)
       *
       * IT HAPPENS HERE, AFTER THE PERSON SAYS YES AND BEFORE PROVING, and
       * both halves of that are load-bearing. After the confirmation,
       * because a signature IS the authorisation and this wallet does not
       * authorise anything the person has not agreed to. Before proving,
       * because `addSignature` refuses an intent that is already bound
       * (unshielded-wallet/dist/v1/TransactionOps.js:62) and `finalizeRecipe`
       * binds — after proving it is too late, and the SDK's own registration
       * path signs at the same point, one step before it finalizes
       * (facade/index.js:402-409). The fee is computed by the balancer
       * BEFORE this, which is also the SDK's own order (its Step 4 precedes
       * its Step 5), so nothing the person was shown changes here. */
      enterStage('signing');
      let signed: BalancingRecipe;
      try {
        signed = await facade.signRecipe(recipe, doors.signSegment());
      } catch (e) {
        leaveStages();
        await facade.revert(recipe).catch(() => { /* release is best effort */ });
        tell({
          name: 'refused',
          message: `this payment could not be authorised: ${describeFailure(e)}. `
            + 'Nothing was sent and no money moved; the coins are released.',
        });
        return;
      }

      /* AND THEN COUNT, rather than trust the call. The rehearsal chain
       * accepts an unshielded transfer with no signatures at all — measured:
       * `validateTransaction` with `verifySignatures: true` passes it and
       * the simulator submits it — so a green suite is not evidence that
       * this worked. The wallet checks the property itself, in the same
       * terms the real chain refused it in, and refuses BEFORE spending
       * minutes on a proof that cannot be submitted. */
      const unsigned = unsignedUnshieldedInputs(signed);
      if (unsigned > 0) {
        leaveStages();
        await facade.revert(recipe).catch(() => { /* release is best effort */ });
        tell({
          name: 'refused',
          message: `this wallet built a payment with ${unsigned} unshielded `
            + `${unsigned === 1 ? 'input that carries' : 'inputs that carry'} no `
            + 'signature, and the chain refuses such a transaction. That is a defect '
            + 'in this wallet. Nothing was sent and no money moved.',
        });
        return;
      }

      /* PROVING — `finalizeRecipe` hands the transaction to the injected
       * proving service and binds the result (index.js:586 and :661). Under
       * the simulator this is milliseconds; under the WASM prover it may be
       * minutes, WHICH IS WHY the stage exists with its own clock now — it
       * is much cheaper to build the waiting state before anything measures the
       * real number than to retrofit it after. A proving failure reverts
       * the wallets' bookkeeping inside the facade itself (finalizeTransaction's
       * catch, index.js:668) — nothing was sent, and the state says so. */
      enterStage('proving');
      let finalized;
      try {
        finalized = await facade.finalizeRecipe(signed);
      } catch (e) {
        leaveStages();
        tell({
          name: 'refused',
          message: `the proof could not be built: ${describeFailure(e)}. Nothing was `
            + 'sent and no money moved; the coins are released.',
        });
        return;
      }

      /* The facade's own pre-submit check, with its own recommended flags
       * (the table in index.d.ts:307–314), reusing the block data the
       * balancer already fetched. A transaction that fails here is refused
       * LOUDLY AND EARLY — before submission, while "nothing moved" is
       * still a true sentence. */
      try {
        await facade.validateTransaction(finalized, {
          flags: { enforceBalancing: true, verifySignatures: true, enforceLimits: true },
          blockData: signed.blockData ?? recipe.blockData,
        });
      } catch (e) {
        leaveStages();
        await facade.revert(finalized).catch(() => { /* release is best effort */ });
        tell({
          name: 'refused',
          message: `the finished transaction failed its own pre-flight check: `
            + `${describeFailure(e)}. It was NOT submitted; nothing moved.`,
        });
        return;
      }

      /* SUBMITTING — and the middle. From here on "nothing moved" can stop
       * being true without this wallet hearing about it, so the reporting
       * changes shape: the identifiers come off the transaction BEFORE the
       * attempt, THE PAYMENT IS WRITTEN DOWN BEFORE THE ATTEMPT (a
       * killed tab must keep the question), the engine's clock names a
       * silence that goes on too long, and a failure is reported as UNKNOWN,
       * never as "it failed" — the facade throws on a rejected submission
       * but a transaction can be accepted and the answer lost.
       * `submitTransaction` also reverts the wallets' local bookkeeping when
       * it throws (index.js:submitTransaction catch), so the balances shown
       * afterwards may read as if nothing left — the unknown state says so
       * rather than letting a reassuring number stand unchallenged. */
      enterStage('submitting');
      const quietMs = doors.submitQuietMs ?? SUBMIT_QUIET_MS;
      const identifiers = finalized.identifiers();
      const ttlAt = ttl.getTime();
      const pendingKey = identifiers[0] ?? '';
      /* WRITTEN DOWN FIRST — synchronously, before the network is touched.
       * If writing fails, the send is refused: a payment this wallet cannot
       * remember is a payment it must not make (the forgotten middle IS the
       * defect). */
      if (doors.pending) {
        try {
          doors.pending.write({
            identifiers,
            kind: plan.recipient.kind,
            recipientBech32: recipientBech32(plan.recipient),
            stars: facts.stars,
            feeSpecks: facts.feeSpecks,
            ttlAt,
          });
        } catch (e) {
          leaveStages();
          await facade.revert(finalized).catch(() => { /* release is best effort */ });
          tell({
            name: 'refused',
            message: 'this payment could not be written down before submission '
              + `(${describeFailure(e)}), and a payment this wallet cannot remember is one `
              + 'it must not make: if the tab died mid-send, nobody would ever know '
              + 'to ask whether the money moved. It was NOT submitted; nothing moved.',
          });
          return;
        }
      }

      /* THE WATCH: once the outcome is in doubt, the engine asks
       * the chain by identifier until an answer exists, on its own clock,
       * with nobody pressing anything. Found → sent or failed as the chain
       * says; not found past the transaction's own TTL → failed, as a fact.
       * Leaving the screen stops THIS watcher only — the written record
       * keeps the question, and the home screen watches it to its answer. */
      const settleMargin = doors.settleMarginMs ?? TTL_SETTLE_MARGIN_MS;
      const sendFacts = facts;
      const settleAs = (outcome: PendingOutcome): void => {
        stopWatching();
        leaveStages();
        try { doors.pending?.settle(pendingKey, outcome); } catch { /* the state below still tells */ }
        if (outcome.name === 'sent') {
          tell({ name: 'sent', txId: pendingKey, facts: sendFacts });
        } else {
          tell({
            name: 'failed', identifiers, facts: sendFacts,
            message: `this payment did not go through: ${outcome.reason}`,
          });
        }
      };
      const startWatching = (): void => {
        if (watcher || detached || !doors.transactionStatus) return;
        let asking = false;
        watcher = setInterval(() => {
          if (asking) return;
          asking = true;
          void (async () => {
            let answer: ChainAnswer | null = null;
            for (const identifier of identifiers) {
              try {
                const found = await doors.transactionStatus!(identifier);
                if (found.found) { answer = found; break; }
                answer ??= found;
              } catch { /* silence is not an answer; ask again next round */ }
            }
            if (answer !== null && watcher) {
              const outcome = outcomeOfAnswer({ ttlAt }, answer, Date.now(), settleMargin);
              if (outcome) settleAs(outcome);
            }
          })().finally(() => { asking = false; });
        }, doors.watchEveryMs ?? 15_000);
      };

      const submitted = facade.submitTransaction(finalized);
      const quiet = setTimeout(() => {
        tell({
          name: 'unknown',
          identifiers,
          facts: sendFacts,
          stillWaiting: true,
          message: `the network has not answered in ${Math.round(quietMs / 1000)} `
            + 'seconds. The transaction was signed, proved and handed over, so it may '
            + 'be on its way, already accepted, or lost — this wallet does not know '
            + 'YET, and it keeps asking the chain by identifier until it does; the '
            + 'payment is also written down and carried on the home screen, so the '
            + 'answer arrives even if this screen is closed. Do not send this '
            + 'payment again — the wallet will refuse it while this one is '
            + 'unresolved.',
        });
        startWatching();
      }, quietMs);
      try {
        const txId = await submitted;
        clearTimeout(quiet);
        stopWatching();
        leaveStages();
        try { doors.pending?.settle(pendingKey, { name: 'sent', at: Date.now() }); } catch { /* told below */ }
        tell({ name: 'sent', txId, facts: sendFacts });
      } catch (e) {
        clearTimeout(quiet);
        tell({
          name: 'unknown',
          identifiers,
          facts: sendFacts,
          stillWaiting: true,
          message: `the submission failed after the proof succeeded: ${describeFailure(e)}. `
            + 'Whether the money moved is NOT KNOWN from here YET: a transaction can '
            + 'reach the network and the answer be lost. The balances on the home '
            + 'screen may show the money still here — that is this wallet’s own '
            + 'bookkeeping being reset, not the chain’s answer. This wallet keeps '
            + 'asking the chain by identifier until the answer exists — sent, or '
            + 'failed with nothing moved — and the payment is written down and '
            + 'carried on the home screen either way. Do not send this payment '
            + 'again; the wallet will refuse it while this one is unresolved.',
        });
        startWatching();
      }
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
    confirm: () => { decided = 'confirm'; decide?.('confirm'); },
    cancel: () => { decided = 'cancel'; decide?.('cancel'); },
    /* Detaching silences THIS engine — never the question: the pending
     * record survives in storage, and the home screen (and every start)
     * resolves it against the chain without being asked. */
    detach: () => { detached = true; leaveStages(); stopWatching(); },
  };
}
