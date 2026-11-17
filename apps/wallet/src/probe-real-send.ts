import type { WalletFacade } from '@midnightntwrk/wallet-sdk';
import type { Identity, Secret } from 'midnight-identity';
import { unshieldedKeystoreFor, unshieldedWalletFor } from './chain/unshielded.js';
import { SUBWALLET_ACCOUNTS, slotNumberOf } from './accounts/subwallets.js';
import { exactSpecks, exactStars, nightFromStars } from './chain/amount.js';
import { NETWORK } from './config.js';
import { parseRecipient, startSend } from './chain/send.js';
import type { SendDoors, SendState } from './chain/send.js';
import {
  loadPendingSends, observedPendingGuard, outcomeOfAnswer, transactionStatusOnChain,
} from './chain/pending.js';
import type { PendingSend } from './chain/pending.js';
import { describeFailure } from './lib/failure-text.js';
import { NETWORK_NAME, NIGHT_UNSHIELDED_RAW, probeWindow, result, step } from './probe-record.js';

/** Set by the driver when `PROBE_SAME_PAYMENT=1` — see `recipientAccountFor`. */
const forcedSamePayment = (): boolean =>
  probeWindow.__PROBE_SAME_PAYMENT__ === true;


/**
 * WHICH SUBWALLET THIS RUN PAYS — and why it is not the same one every time.
 *
 * The duplicate guard keys on RECIPIENT AND AMOUNT (`pending.ts`,
 * `duplicateUnresolved`), and every probe run used to send exactly 25 tNIGHT
 * to subwallet 1. So a run that left a record unresolved — which the killed
 * run does BY DESIGN — made every later run's payment identical to it, and
 * the guard refused it. Correctly: it IS the same payment. The consequence
 * was that the kill test and the lag measurement could not both happen in
 * the same hour, and the lag measurement never ran at all.
 *
 * **This is not a way around the guard.** The point of the guard is that the
 * IDENTICAL payment is not made twice while its outcome is unknown, and a
 * payment to a different wallet is a different payment — not the same one
 * wearing a different key. Cycling the RECIPIENT rather than nudging the
 * amount is deliberate for exactly that reason: 25 tNIGHT to subwallet 3 is
 * a payment somebody could mean to make, while 25.000001 tNIGHT to
 * subwallet 1 is the same payment with the key filed off.
 *
 * The account is chosen from the minute the run starts, cycling through the
 * ten subwallets (accounts 2–11, `subwallets.ts`). Two runs in the same
 * minute get the same recipient, which is right — that really is a repeat.
 *
 * `PROBE_SAME_PAYMENT=1` pins it to subwallet 1 so a collision can be caused
 * ON PURPOSE and the guard stays exercised. That matters: a guard nothing
 * ever trips is a guard nobody would notice had broken.
 */
function recipientAccountFor(): number {
  if (forcedSamePayment()) return SUBWALLET_ACCOUNTS[0] ?? 2;
  const minute = Math.floor(Date.now() / 60_000);
  return SUBWALLET_ACCOUNTS[minute % SUBWALLET_ACCOUNTS.length] ?? 2;
}

/* THE RESOLUTION AGAINST THE CHAIN — asked separately, by the record's
 * own identifier, with the call the home screen's resolver uses, and
 * read through the same `outcomeOfAnswer`. The engine settles a
 * successful submit from the submission's own answer; this asks the
 * CHAIN, which is a different question and the one the guard is about.
 * SILENCE RESOLVES NOTHING and that is reported as the property it is. */
async function resolveAgainstChain(
  key: string, after: PendingSend, setStage: (message: string) => void,
): Promise<void> {
  setStage('resolving the pending record against the chain');
  try {
    const answer = await transactionStatusOnChain(key);
    const resolved = outcomeOfAnswer({ ttlAt: after.ttlAt }, answer, Date.now());
    result.pendingChainResolution = {
      identifier: key,
      answer: answer.found ? `found, status ${answer.status}` : 'not found',
      resolvedTo: resolved === null
        ? 'NOTHING — the chain has not answered yet, and no answer decides nothing'
        : resolved.name,
    };
    step('pending-chain-resolution', `asked the indexer by the record's own identifier: `
      + `${result.pendingChainResolution.answer} → resolves to `
      + `${result.pendingChainResolution.resolvedTo}`);
  } catch (e) {
    result.pendingChainResolution = {
      identifier: key,
      answer: `the indexer did not answer: ${describeFailure(e)}`,
      resolvedTo: 'NOTHING — silence about the chain is not an answer about the chain',
    };
    step('pending-chain-resolution', 'the indexer did not answer, so the record resolves '
      + 'to NOTHING — silence decides nothing, which is the property');
  }
}

/* THE MEASUREMENT NOBODY HAD TAKEN.
 *
 * The node finalised a transaction and 168ms later the indexer, asked by
 * that transaction's own identifier, said `not found`. The wallet read
 * nothing into that and was right to. But `outcomeOfAnswer` turns a
 * SUSTAINED not-found past the deadline into `failed`, and the margin
 * defending that sentence — `TTL_SETTLE_MARGIN_MS`, five minutes — was
 * chosen to cover clock disagreement between this machine and the
 * chain. Nobody had measured indexer lag, because nobody had yet watched
 * a finalised transaction be invisible.
 *
 * So: keep asking, by the record's own identifier, until the chain shows
 * it. Time it. The margin should be set from THIS number and not from a
 * guess about clocks. A run that never finds it is not a failure of the
 * send — the send is finalised — it is a lag longer than this run's
 * patience, and that is reported as exactly that. */
async function timeIndexerLag(key: string, setStage: (message: string) => void): Promise<void> {
  const LAG_PATIENCE_MS = 240_000;
  const LAG_ASK_EVERY_MS = 1_000;
  setStage('timing how long the indexer takes to show a finalised transaction');
  const lagStart = performance.now();
  let asks = 0;
  let foundAfterMs: number | null = null;
  let answerText = 'never found within this run\'s patience';
  while (performance.now() - lagStart < LAG_PATIENCE_MS) {
    asks += 1;
    try {
      const answer = await transactionStatusOnChain(key);
      if (answer.found) {
        foundAfterMs = Math.round(performance.now() - lagStart);
        answerText = `found, status ${answer.status}`;
        break;
      }
    } catch {
      /* An indexer that will not answer is not an indexer that says no.
       * Keep asking; the count below says how many asks it took. */
    }
    await new Promise((r) => setTimeout(r, LAG_ASK_EVERY_MS));
  }
  result.indexerLag = {
    identifier: key,
    foundAfterMs,
    asks,
    patienceMs: LAG_PATIENCE_MS,
    answer: answerText,
  };
  step('indexer-lag', foundAfterMs === null
    ? `the indexer did NOT show this finalised transaction within `
      + `${LAG_PATIENCE_MS / 1000}s (${asks} asks). The send is finalised; this is `
      + 'the lag being longer than this run waited, and it is the number the '
      + 'settle margin needs.'
    : `the indexer first showed this finalised transaction after ${foundAfterMs}ms `
      + `(${asks} ask(s)) — ${answerText}. THIS is what TTL_SETTLE_MARGIN_MS must `
      + 'be set from.');
}

/* End to end: the RECIPIENT wallet reads the money, on its own sync. */
async function readRecipientStars(
  identity: Identity, recipientAccount: number, setStage: (message: string) => void,
): Promise<bigint> {
  setStage('reading the recipient wallet');
  const recipientStars = await unshieldedWalletFor(identity, recipientAccount).then((recipientWallet) => new Promise<bigint>((resolve, reject) => {
    const timer = setTimeout(() => {
      recipientSub.unsubscribe();
      void recipientWallet.stop().catch(() => { /* a wallet that is already stopping is fine */ });
      reject(new Error('the recipient wallet did not sync within 120s — the send is '
        + 'finalised; rerun to read it'));
    }, 120_000);
    const recipientSub = recipientWallet.state.subscribe({
      next: (state) => {
        if (state.progress.isConnected && state.progress.isStrictlyComplete()) {
          clearTimeout(timer);
          recipientSub.unsubscribe();
          void recipientWallet.stop().catch(() => { /* a wallet that is already stopping is fine */ });
          resolve(state.balances[NIGHT_UNSHIELDED_RAW] ?? 0n);
        }
      },
      error: (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(describeFailure(e), { cause: e }));
      },
    });
    recipientWallet.start().catch((e: unknown) => {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(describeFailure(e), { cause: e }));
    });
  }));
  return recipientStars;
}

/* ---------- The real send --------------
 *
 * REAL tNIGHT MOVES BETWEEN TWO WALLETS ON THE NETWORK THIS WALLET IS BUILT FOR: 25 tNIGHT from the
 * test wallet's main account to one of its own subwallets (`recipientAccountFor` picks which) —
 * two wallets, one identity, so nothing leaves the fixture however many times this runs.
 * It goes UNSHIELDED because that is the only kind of NIGHT this ledger
 * lets a wallet hold without a contract (the no-shield-door fact, pinned)
 * — and the transaction is still REALLY PROVED: its fee is paid from real
 * DUST, and a dust spend carries a real circuit, proved by the same
 * in-browser prover the measurement timed, then accepted by the real
 * chain. The dangerous middle is handled the way the send screen handles
 * it: identifiers taken BEFORE submission, and a failure after proving
 * reported as exactly what is known, never a guess.
 */
export async function runRealSend(
  identity: Identity, secret: Secret,
  facade: WalletFacade, unshieldedStars: bigint, setStage: (message: string) => void,
): Promise<void> {
  const AMOUNT = 25_000_000n; /* 25 tNIGHT */
  if (unshieldedStars < AMOUNT) {
    step('real-send-skipped', `the wallet holds ${exactStars(unshieldedStars)} unshielded — `
      + 'not enough to move 25 tNIGHT; fund it and rerun');
    return;
  }
  const recipientAccount = recipientAccountFor();
  const slot = slotNumberOf(recipientAccount);
  setStage('building the real send');
  step('real-send-phase', `moving ${nightFromStars(AMOUNT)} tNIGHT on ${NETWORK_NAME} — main wallet `
    + `to subwallet ${slot}, real money, irreversible`
    + (forcedSamePayment()
      ? ' — PROBE_SAME_PAYMENT=1, so this run deliberately repeats the payment '
        + 'subwallet 1 always gets, to exercise the duplicate guard'
      : ' — the recipient cycles per run (a run that leaves a record '
        + 'unresolved must not refuse the NEXT run\'s payment, and a different '
        + 'wallet is a different payment)'));
  const recipientBech = unshieldedKeystoreFor(identity, recipientAccount)
    .getBech32Address().asString();

  /* THE PENDING GUARD AGAINST A REAL SEND. This runs THE ENGINE, with the
   * same doors the send screen builds: the real facade, the real signer,
   * `pendingGuardFor` over real storage, and the indexer as the thing the
   * middle asks. So the machinery the guard exists for — the payment
   * written down BEFORE the network is touched, the duplicate refused while
   * one is in flight, the record resolved against the chain by its own
   * identifier — meets a real event here, not only a test's.
   *
   * The pending doors are WRAPPED, not replaced. Every call goes to the
   * real guard first; the wrapper only watches, and what it reports about
   * the record it reads BACK OUT OF STORAGE rather than echoing the draft
   * it was handed — the draft is what the engine intended, the store is
   * what a killed tab would leave behind. */
  /* The wrapper lives in `pending.ts` — beside the guard it wraps, where a
   * test can reach it. */
  /* WHICH ANSWER SETTLED IT. The engine settles a successful submit from
   * the submission's own reply; if the submission goes quiet or throws it
   * says `unknown` FIRST and then settles from the chain, through its
   * watcher. Seeing `unknown` is therefore how this run tells the two
   * apart — and they are different claims, so the report says which. */
  let sawUnknown = false;
  const pending = observedPendingGuard(secret, 0, {
    wrote: (stored) => {
      result.pendingBeforeSubmit = {
        key: stored.key,
        identifiers: stored.identifiers,
        kind: stored.kind,
        recipientBech32: stored.recipientBech32,
        stars: stored.stars,
        feeSpecks: stored.feeSpecks,
        submittedAt: stored.submittedAt,
        ttlAt: stored.ttlAt,
        outcome: stored.outcome === null ? 'null — unresolved' : stored.outcome.name,
      };
      step('pending-written', 'the payment is ON DISK before the network is touched — '
        + `key ${stored.key.slice(0, 18)}…, ${stored.identifiers.length} identifier(s), `
        + `${exactStars(BigInt(stored.stars))}, outcome `
        + `${result.pendingBeforeSubmit.outcome}`);
    },
    settled: (key, outcome) => {
      result.pendingSettled = {
        key,
        outcome: outcome.name,
        from: sawUnknown
          ? 'the engine\'s watcher, asking the CHAIN by identifier'
          : 'the submission\'s own answer',
      };
      step('pending-settled', `the record is resolved: ${outcome.name}`
        + (outcome.name === 'failed' ? ` — ${outcome.reason}` : ''));
    },
  });

  const doors: SendDoors = {
    facade: async () => facade,
    signSegment: () => unshieldedKeystoreFor(identity, 0).signDataAsync,
    ownUnshieldedHex: unshieldedKeystoreFor(identity, 0).getAddress(),
    pending,
    transactionStatus: transactionStatusOnChain,
  };

  /* The engine's states, watched the way a screen watches them — and the
   * proving time taken from the stage boundaries rather than from a
   * stopwatch this function holds, because the engine owns the stages now. */
  let stageEnteredAt = performance.now();
  let currentStage: string | null = null;
  let sending: ReturnType<typeof startSend> | null = null;
  /* HOW LONG THIS RUN WAITS FOR A MIDDLE TO END. A watched middle may
   * legitimately last until the transaction's TTL plus its margin — over
   * an hour — and a probe cannot sit there. When patience runs out the run
   * says so and stops watching FROM HERE; the record stays on disk,
   * unresolved, and the next run's start-up resolution (and the home
   * screen) carry it to its answer. An unresolved middle is not a failed
   * send and this run must not write it down as one. */
  const MIDDLE_PATIENCE_MS = 180_000;
  const finished = await new Promise<SendState | 'patience-ran-out'>((resolve) => {
    const patience = setTimeout(() => {
      sending?.detach();
      resolve('patience-ran-out');
    }, MIDDLE_PATIENCE_MS);
    const done = (state: SendState): void => { clearTimeout(patience); resolve(state); };
    sending = startSend(doors, {
      recipient: parseRecipient(recipientBech, NETWORK), stars: AMOUNT,
    }, (state) => {
      if (state.name === 'working') {
        if (state.stage === currentStage) return;
        if (currentStage === 'proving') {
          result.realSendProvingMs = Math.round(performance.now() - stageEnteredAt);
          step('real-send-proved', `${result.realSendProvingMs}ms in-browser — a REAL proof `
            + 'on a REAL transaction (the fee\'s dust spend)');
        }
        currentStage = state.stage;
        stageEnteredAt = performance.now();
        setStage(`the send engine: ${state.stage}`);
        return;
      }
      if (state.name === 'confirm') {
        result.realSendStars = String(state.facts.stars);
        step('real-send-balanced', 'fee, read back from the recipe\'s own dust spends: '
          + `${exactSpecks(state.facts.feeSpecks)}`);
        step('real-send-signed', 'the engine signs the unshielded inputs before proving '
          + 'and counts them off the transaction — its own step, not this one\'s');
        /* The person's yes. There is nobody here, so the probe says it —
         * and says so, rather than letting the log read as if a human
         * approved a real payment. */
        step('real-send-confirmed', 'THE PROBE confirmed on the person\'s behalf — an '
          + 'unattended run, and the engine required a decision before proving');
        sending?.confirm();
        return;
      }
      if (state.name === 'unknown') {
        sawUnknown = true;
        step('real-send-UNKNOWN-middle', 'the submission has not answered — the engine is '
          + 'now watching the chain by identifier, and the record is on disk either way');
        return;
      }
      done(state);
    });
  });

  if (finished === 'patience-ran-out') {
    step('real-send-STILL-UNRESOLVED', `no answer within ${MIDDLE_PATIENCE_MS / 1000}s. `
      + 'The payment is written down on disk and is NOT resolved. Whether the money '
      + 'moved is not known from here — it is not a failure and must not be read as '
      + 'one. Rerun the probe: its start-up resolution asks the chain again.');
  }
  const outcome: SendState | 'patience-ran-out' = finished;
  if (outcome === 'patience-ran-out') {
    /* nothing more to say here — the disk read and the chain resolution
     * below are exactly what an unresolved middle is entitled to. */
  } else if (outcome.name === 'sent') {
    result.realSendTxId = outcome.txId;
    result.realSendIdentifiers = [...(result.pendingBeforeSubmit?.identifiers ?? [outcome.txId])];
    step('real-send-submitted', `FINALIZED on ${NETWORK_NAME} — transaction ${outcome.txId}`);
  } else if (outcome.name === 'unknown') {
    result.realSendIdentifiers = [...outcome.identifiers];
    step('real-send-UNKNOWN', `${outcome.message}`);
  } else if (outcome.name === 'failed') {
    result.realSendIdentifiers = [...outcome.identifiers];
    step('real-send-failed', outcome.message);
  } else if (outcome.name === 'refused') {
    step('real-send-refused', outcome.message);
  } else {
    step('real-send-cancelled', 'the engine reported cancelled, which nothing here asked for');
  }

  /* WHAT IS ON DISK NOW, read independently of anything the engine said. */
  const after = loadPendingSends(secret).find(
    (r) => r.key === result.pendingBeforeSubmit?.key);
  result.pendingAfter = after
    ? { key: after.key, outcome: after.outcome === null ? 'null — still unresolved' : after.outcome.name }
    : 'no record on disk';

  const key = result.pendingBeforeSubmit?.key;
  if (key && after) await resolveAgainstChain(key, after, setStage);

  if (outcome !== 'patience-ran-out' && outcome.name === 'sent' && key) {
    await timeIndexerLag(key, setStage);
  }

  if (outcome === 'patience-ran-out' || outcome.name !== 'sent') return;

  const recipientStars = await readRecipientStars(identity, recipientAccount, setStage);
  result.realSendRecipientStars = String(recipientStars);
  step('real-send-landed', `subwallet ${slot} now reads ${exactStars(recipientStars)} `
    + `(${nightFromStars(recipientStars)} tNIGHT) — moved end to end on ${NETWORK_NAME}`);
  step('registration-note', 'the spent NIGHT UTXO\'s dust registration ended with it '
    + '(generation follows the coin) — the change came back unregistered, and the next '
    + 'run of this probe re-registers it');
}
