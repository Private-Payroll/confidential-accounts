import { useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Identity, Secret } from 'midnight-identity';
import type { RehearsalScenario } from '../chain/rehearsal.js';
import { SendContext } from '../chain/send-context.js';
import type { SendController, SendState } from '../chain/send.js';
import { ConfirmCard } from './send-confirm.js';
import { SendForm } from './send-form.js';
import { usePayingWallet, useSendDoors, useSendForm, useWakeLock } from './send-hooks.js';
import { LiveNotice, PayingWalletCard, RehearsalNotice } from './send-notices.js';
import { SendEnding, WorkingCard } from './send-stages.js';
import { TermsCard } from './send-terms.js';

/**
 * SENDING — the screen where every sending rule faces a
 * person. What this screen owes them, in order:
 *
 *  - to say WHICH KIND of address it was given, in words, and to refuse a
 *    kind it cannot pay — the two kinds are different wallets;
 *  - to put the exact STAR figure beside the typed amount BEFORE anything
 *    is agreed to — the number that will actually move, not the typed one
 *    (§7.17, the millionfold trap);
 *  - to confirm against the BALANCED TRANSACTION, not the form — recipient,
 *    amount, fee in DUST, and what the balance becomes, read back;
 *  - to say ONCE, plainly, BEFORE the send, that it cannot be undone — and
 *    never afterwards, when it is only cruelty;
 *  - never to show a still screen while proving or submitting: the
 *    engine re-announces itself every second and this screen prints the
 *    stage and the clock;
 *  - in the dangerous middle — proof succeeded, submission failed — to
 *    report exactly what is known and hand over the identifiers,
 *    never a cheerful summary it has not earned.
 *
 * THE MODE IS NAMED AND THE SCREEN SAYS SO. Live is the default, and its
 * notice says the send is real. The rehearsal, one quiet click away, is the
 * same flow over the SDK's simulated chain — real balancing, real fees, real
 * (simulated) proving, real block inclusion, no network and no real money —
 * and its banner says so. The scenario picker exists so the waiting states
 * and the dangerous middle can be rehearsed on purpose: the first time
 * somebody sees that screen must not be the time it is true.
 *
 * ==========================================================================
 * THE RESTYLE, AND WHAT IT WAS NOT ALLOWED TO MOVE
 * ==========================================================================
 *
 * THE RULE: *"the failure mode here is not an ugly screen,
 * it is a rule quietly leaving with the markup it lived in."* So the six
 * items above are unchanged, word for word, and every sentence they govern is
 * the sentence that was already here. `app.css` classes became kit components
 * and tokens; nothing else did.
 *
 * **THE STEP ORDER IS A SECURITY PROPERTY, NOT A LAYOUT.** The blocks below
 * appear in the order they appeared in: who pays · which chain this is · the
 * form · the work · the confirmation · the ending. There are
 * ordering defects inside ceremonies, and a flow's steps may not
 * be reordered to read better.
 *
 * **THE WAITING BEHAVIOUR IS ONE SHAPE: STAY ON THIS
 * SCREEN, AWAKE.** A proof runs in a worker and the worker dies with the page;
 * on a phone, backgrounding the browser or locking the screen suspends
 * JavaScript. The pending record covers a SUBMITTED transaction surviving a dead tab — it
 * does not cover an IN-PROGRESS PROOF, which has no record anywhere until
 * there is something to record. So this screen now carries honest progress
 * with one named duration, a wake-lock whose REFUSAL is a state rather than an
 * error, the truth for the tab that dies anyway (it did not happen), and the
 * warning said BEFORE somebody is trapped rather than after.
 *
 * **NOTHING HERE READS MONEY.** The design freezes the money card for
 * later, and that deferral is only free while nothing else learns to read what
 * money exists. The atomic units appear in two places only — the §7.17 line
 * beside the typed amount (`send-form.tsx`) and the read-back on the
 * confirmation (`send-confirm.tsx`) — and no accessor was added.
 */

export function Send({ identity, secret }: {
  readonly identity: Identity;
  readonly secret: Secret;
}): ReactNode {
  const wiring = useContext(SendContext);
  const { account, owned } = usePayingWallet(identity, secret);

  /* LIVE IS THE DEFAULT — the seam flipped. The rehearsal stays a
   * quiet click away, because a long wait and an unknown outcome are worth
   * practising before the day they are true. */
  const [mode, setMode] = useState<'live' | 'rehearsal'>(wiring.live ? 'live' : 'rehearsal');
  const [scenario, setScenario] = useState<RehearsalScenario>('ordinary');
  const [engineState, setEngineState] = useState<SendState | null>(null);
  const engine = useRef<SendController | null>(null);
  const doors = useSendDoors(wiring, mode, identity, secret, account, scenario);
  /* Leaving the screen stops the listening, never an in-flight submission
   * (a transaction on its way to a network cannot be recalled), and ends
   * the rehearsal chain behind the doors. */
  useEffect(() => () => {
    engine.current?.detach();
    void doors.stop?.();
  }, [doors]);

  const {
    recipientText, setRecipientText, amountText, setAmountText, recipientInfo, amountInfo, ready,
  } = useSendForm();

  const begin = (): void => {
    if (!recipientInfo?.ok || !amountInfo?.ok) return;
    engine.current = wiring.start(
      doors,
      { recipient: recipientInfo.value, stars: amountInfo.value },
      setEngineState);
  };

  const reset = (): void => {
    engine.current?.detach();
    engine.current = null;
    setEngineState(null);
  };

  const switchMode = (next: 'live' | 'rehearsal'): void => {
    reset();
    setMode(next);
  };

  /* A send is IN FLIGHT while it can still change the world: working,
   * awaiting the person, or in the unknown middle. The terminal states —
   * cancelled, refused, sent — release the scenario picker again. */
  const inFlight = engineState !== null
    && engineState.name !== 'cancelled'
    && engineState.name !== 'refused'
    && engineState.name !== 'failed'
    && engineState.name !== 'sent';

  /*
   * THE WAKE LOCK IS HELD FOR THE PROOF AND FOR NOTHING ELSE, AND THE LINE IS
   * DRAWN WHERE THE PENDING RECORD DRAWS IT.
   *
   * A proof has no record anywhere: the worker dies with the page and there is
   * nothing to come back to, so this is the one stretch where a sleeping
   * screen destroys work. From SUBMISSION onwards the payment has been written
   * down BEFORE it was submitted (`pending.ts`, the fourth clause), so a
   * dead tab is survivable and the home screen carries the question to its
   * answer. Holding the lock past that point would be asking somebody to keep
   * a phone awake for something that no longer needs them.
   */
  const proving = engineState?.name === 'working' && engineState.stage === 'proving';
  const wake = useWakeLock(proving);

  return (
    <div className="flex flex-col gap-6">
      {/* ----------------------------------------------------- who is paying */}
      <PayingWalletCard owned={owned} />

      {/* -------------------------------------- which chain this screen is on */}
      {mode === 'live' && <LiveNotice inFlight={inFlight} switchMode={switchMode} />}

      {mode === 'live' && <TermsCard fetchTerms={wiring.live?.fetchTerms ?? null} />}

      {mode === 'rehearsal' && (
        <RehearsalNotice
          inFlight={inFlight} scenario={scenario} setScenario={setScenario}
          wiring={wiring} switchMode={switchMode}
        />
      )}

      {/* ------------------------------------------------- who, and how much */}
      {!inFlight && (
        <SendForm
          recipientText={recipientText} setRecipientText={setRecipientText}
          recipientInfo={recipientInfo}
          amountText={amountText} setAmountText={setAmountText} amountInfo={amountInfo}
          ready={ready} begin={begin}
        />
      )}

      {/* -------------------------------------------------------- the working */}
      {engineState?.name === 'working' && <WorkingCard engineState={engineState} wake={wake} />}

      {/* --------------------------------------------------- the confirmation */}
      {engineState?.name === 'confirm' && (
        <ConfirmCard
          facts={engineState.facts}
          owner={owned.owner}
          onSend={() => engine.current?.confirm()}
          onCancel={() => engine.current?.cancel()}
        />
      )}

      {/* --------------------------------------------------------- the endings */}
      <SendEnding engineState={engineState} reset={reset} />
    </div>
  );
}
