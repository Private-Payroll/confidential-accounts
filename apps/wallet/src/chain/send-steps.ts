import type { WalletFacade } from '@midnightntwrk/wallet-sdk';
import type { BalancingRecipe, CombinedTokenTransfer } from '@midnightntwrk/wallet-sdk-facade';
import {
  MidnightBech32m, ShieldedAddress, UnshieldedAddress,
} from '@midnightntwrk/wallet-sdk-address-format';
import { nativeToken, shieldedToken } from '@midnightntwrk/ledger-v9';
import { TTL_SETTLE_MARGIN_MS, outcomeOfAnswer } from './pending.js';
import type { ChainAnswer, PendingOutcome } from './pending.js';
import { describeFailure } from '../lib/failure-text.js';
import { feeFromRecipe, identifiersOf, unshieldedStarsTo, unsignedUnshieldedInputs } from './send-recipe.js';
import { recipientBech32 } from './send.js';
import type { SendDoors, SendFacts, SendPlan, SendStage, SendState } from './send.js';

/*
 * THE SEND ENGINE'S STEPS, in the order a payment takes them: balance it and
 * ask the person, then sign and prove it, then write it down and submit it
 * and watch the chain for its answer. Each step returns what the next one
 * needs, or null once it has told the screen why the payment stopped.
 */

/** How long a silent submission is given before the middle is named out
 * loud. The same figure as the balance engines' give-up — one
 * project, one patience. */
export const SUBMIT_QUIET_MS = 45_000;

/** One send's own state: what it tells the screen, its clock, the person's
 * choice and the watch on the chain. */
export interface SendRun {
  readonly tell: (state: SendState) => void;
  readonly enterStage: (stage: SendStage) => void;
  readonly leaveStages: () => void;
  readonly stopWatching: () => void;
  readonly choice: () => Promise<'confirm' | 'cancel'>;
  readonly decideAs: (choice: 'confirm' | 'cancel') => void;
  readonly detach: () => void;
  readonly detached: () => boolean;
  readonly watching: () => boolean;
  readonly watchEvery: (ask: () => void, everyMs: number) => void;
}

/** The state one send keeps while it runs. */
export function sendRun(onState: (state: SendState) => void): SendRun {
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

  return {
    tell, enterStage, leaveStages, stopWatching,
    choice: () => (decided !== null ? Promise.resolve(decided) : new Promise<'confirm' | 'cancel'>((resolve) => {
      decide = resolve;
    })),
    decideAs: (choice) => { decided = choice; decide?.(choice); },
    detach: () => { detached = true; leaveStages(); stopWatching(); },
    detached: () => detached,
    watching: () => watcher !== null,
    watchEvery: (ask, everyMs) => { watcher = setInterval(ask, everyMs); },
  };
}

/** What the first step hands on: a balanced recipe the person said yes to. */
export interface Confirmed {
  readonly facade: WalletFacade;
  readonly recipe: BalancingRecipe;
  readonly facts: SendFacts;
  readonly ttl: Date;
}

/** The one output the plan pays, in the facade's own transfer shape. */
/**
 * Reads the transaction the coins were booked for; a read that throws releases
 * the booking before the refusal goes on, so the coins are not held until the
 * transaction's time-to-live for a send that never happened.
 */
const readOrRelease = async <T>(
  facade: WalletFacade, booked: Parameters<WalletFacade['revert']>[0], read: () => T,
): Promise<T> => {
  try {
    return read();
  } catch (e) {
    await facade.revert(booked).catch(() => { /* release is best effort; the refusal still tells */ });
    throw e;
  }
};

const outputOf = (plan: SendPlan): CombinedTokenTransfer => {
  return plan.recipient.kind === 'unshielded'
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
};

/** Balances the payment, reads back what it will do and asks the person;
 * null when it was refused or cancelled. */
export async function balancedAndConfirmed(
  run: SendRun, doors: SendDoors, plan: SendPlan,
): Promise<Confirmed | null> {
  const { tell, enterStage, leaveStages } = run;
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
    return null;
  }

  /* STARTING — what does this wallet hold, right now? */
  enterStage('starting');
  const facade = await doors.facade();
  const before = await facade.waitForSyncedState();
  const now = facade.clock.now();
  const nightBefore = plan.recipient.kind === 'unshielded'
    ? before.unshielded.balances[nativeToken().raw] ?? 0n
    : before.shielded.balances[shieldedToken().raw] ?? 0n;
  const dustBefore = before.dust.balance(now);

  /* BALANCING — the facade builds and balances in one call
   * (`transferTransaction(outputs, {ttl})`) with the keys it was started
   * with; the recipe that comes back is the fact the confirmation is read
   * from. */
  enterStage('balancing');
  const output = outputOf(plan);
  /* The TTL is one hour from the facade's own clock, the facade's own
   * default, unless a test shortens it — and it is ALSO the middle's own
   * exit: a transaction not on chain past its TTL can never land, which is
   * what lets "unknown" end as a fact. */
  const ttl = new Date(facade.clock.now().getTime() + (doors.ttlMs ?? 60 * 60 * 1000));
  const recipe = await facade.transferTransaction([output], { ttl });

  /* READ BACK what will actually happen. */
  const feeSpecks = await readOrRelease(facade, recipe, () => feeFromRecipe(recipe));
  let stars = plan.stars;
  let readBack: SendFacts['readBack'] = 'builder-input';
  if (plan.recipient.kind === 'unshielded') {
    const to = plan.recipient.hex;
    stars = await readOrRelease(facade, recipe, () => unshieldedStarsTo(recipe, to));
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
      return null;
    }
    /* The whole flow of NIGHT, cross-checked: what leaves equals what
     * arrives plus change (the fee leaves in DUST, not NIGHT). */
  }
  const facts: SendFacts = {
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
   * (`facade.revert(recipe)`). */
  leaveStages();
  tell({ name: 'confirm', facts });
  const choice = await run.choice();
  if (choice === 'cancel') {
    await facade.revert(recipe).catch(() => { /* release is best effort */ });
    tell({ name: 'cancelled' });
    return null;
  }
  return { facade, recipe, facts, ttl };
}

/** What the second step hands on: the signed recipe and its proved transaction. */
export interface Proven {
  readonly signed: BalancingRecipe;
  readonly finalized: Awaited<ReturnType<WalletFacade['finalizeRecipe']>>;
}

/** Signs, counts the signatures, proves and checks the payment; null when it
 * stopped, with the coins released. */
export async function authorisedAndProven(
  run: SendRun, doors: SendDoors, { facade, recipe }: Confirmed,
): Promise<Proven | null> {
  const { tell, enterStage, leaveStages } = run;
  /* SIGNING, and the reason this stage exists at all.
   *
   * An unshielded input is authorised by a signature over its intent's
   * own `signatureData`, and `transferTransaction` signs nothing. Signing is
   * a SEPARATE CALL — `signRecipe(recipe, signSegment)` — and an unshielded
   * transfer that skips it is refused by the chain at the last gate:
   *
   *     unshielded offer action validation error: mismatch between
   *     number of inputs (1) and signatures (0)
   *
   * IT HAPPENS HERE, AFTER THE PERSON SAYS YES AND BEFORE PROVING, and
   * both halves of that are load-bearing. After the confirmation,
   * because a signature IS the authorisation and this wallet does not
   * authorise anything the person has not agreed to. Before proving,
   * because adding a signature is refused on an intent that is already
   * bound and `finalizeRecipe` binds — after proving it is too late, and the
   * SDK's own registration path signs at the same point, one step before it
   * finalizes. The fee is computed by the balancer BEFORE this, which is
   * also the SDK's own order, so nothing the person was shown changes here. */
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
    return null;
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
    return null;
  }

  /* PROVING — `finalizeRecipe` hands the transaction to the injected
   * proving service and binds the result. Under the simulator this is
   * milliseconds; under the WASM prover it may be minutes, which is why the
   * stage has its own clock. A proving failure reverts the wallets'
   * bookkeeping inside the facade itself — nothing was sent, and the state
   * says so. */
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
    return null;
  }

  /* The facade's own pre-submit check, with every check it offers on,
   * reusing the block data the balancer already fetched. A transaction that fails here is refused
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
    return null;
  }
  return { signed, finalized };
}

/** Writes the payment down before the network is touched; false, with the
 * coins released and the screen told, when it could not be written. */
async function writtenDownFirst(
  run: SendRun, doors: SendDoors, plan: SendPlan, { facade, facts }: Pick<Confirmed, 'facade' | 'facts'>,
  finalized: Proven['finalized'], identifiers: string[], ttlAt: number,
): Promise<boolean> {
  const { tell, leaveStages } = run;
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
      return false;
    }
  }
  return true;
}

/** Writes the payment down, submits it and watches the chain until it has an answer. */
export async function submittedAndWatched(
  run: SendRun, doors: SendDoors, plan: SendPlan, { facade, facts, ttl }: Confirmed, { finalized }: Proven,
): Promise<void> {
  const { tell, enterStage, leaveStages, stopWatching } = run;
  /* SUBMITTING — and the middle. From here on "nothing moved" can stop
   * being true without this wallet hearing about it, so the reporting
   * changes shape: the identifiers come off the transaction BEFORE the
   * attempt, THE PAYMENT IS WRITTEN DOWN BEFORE THE ATTEMPT (a
   * killed tab must keep the question), the engine's clock names a
   * silence that goes on too long, and a failure is reported as UNKNOWN,
   * never as "it failed" — the facade throws on a rejected submission
   * but a transaction can be accepted and the answer lost.
   * `submitTransaction` also reverts the wallets' local bookkeeping when
   * it throws, so the balances shown
   * afterwards may read as if nothing left — the unknown state says so
   * rather than letting a reassuring number stand unchallenged. */
  enterStage('submitting');
  const quietMs = doors.submitQuietMs ?? SUBMIT_QUIET_MS;
  const identifiers = await readOrRelease(facade, finalized, () => identifiersOf(finalized));
  const ttlAt = ttl.getTime();
  const pendingKey = identifiers[0] ?? '';
  if (!await writtenDownFirst(run, doors, plan, { facade, facts }, finalized, identifiers, ttlAt)) return;

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
    if (run.watching() || run.detached() || !doors.transactionStatus) return;
    let asking = false;
    run.watchEvery(() => {
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
        if (answer !== null && run.watching()) {
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
}
