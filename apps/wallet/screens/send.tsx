import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Identity, Secret } from 'midnight-identity';
import { NETWORK } from '../config.js';
import { dustFromSpecks, exactSpecks, exactStars, nightFromStars } from '../amount.js';
import { ownedAddressFor } from '../owned-address.js';
import { hrefOf } from '../routes.js';
import { loadSubwallets } from '../storage.js';
import { MAIN_ACCOUNT, isWalletAccount } from '../subwallets.js';
import { CopyButton } from '../ui.js';
import type { RehearsalScenario } from '../rehearsal.js';
import { SendContext } from '../send-context.js';
import { pendingGuardFor, transactionStatusOnChain } from '../pending.js';
import { STAGE_WORDS, parseRecipient, starsFromNight } from '../send.js';
import { loadTermsSeen, recordTermsSeen } from '../terms.js';
import type {
  Recipient, SendController, SendFacts, SendState,
} from '../send.js';
import { describeFailure } from '../failure-text.js';
import { Mark } from '../shell/mark.js';
import {
  Alert, Badge, Button, Card, CardContent, GLYPH, Icon, Input, Label, Section, Textarea,
  buttonClasses,
} from '../kit/index.js';

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
 * THE MODE IS A REHEARSAL AND THE SCREEN SAYS SO. Everything below the
 * banner is the real flow over the SDK's simulated chain — real balancing,
 * real fees, real (simulated) proving, real block inclusion, no network and
 * no real money. The scenario picker exists so the waiting states and the
 * dangerous middle can be rehearsed on purpose: the first time somebody
 * sees that screen must not be the time it is true.
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
 * **NOTHING NEW HERE READS MONEY.** The design freezes the money card for
 * later, and that deferral is only free while nothing else learns to read what
 * money exists. This file's mentions of the atomic units are the same six it
 * already had — the §7.17 line beside the typed amount, and the read-back on
 * the confirmation — and no accessor was added.
 */

/**
 * HOW LONG A PROOF USUALLY TAKES — ONE CONSTANT, AND IT IS COPY RATHER THAN
 * DESIGN.
 *
 * THE RULE: *"Where a duration is stated, it comes from one named
 * constant with a comment saying it is a laptop measurement and phones are
 * unmeasured. When the number lands it is one edit."*
 *
 * **74 SECONDS IS A MEASUREMENT AND IT IS A LAPTOP'S** — a real
 * plain-transfer proof in a real browser, on a laptop. **A PHONE HAS NEVER
 * BEEN MEASURED.** The SDK's prover is single-threaded WASM and a phone is
 * plausibly three to five times this, which is why the decision was to build
 * this screen for the WORST CASE and let the number arrive later.
 * The design below is the same design at fifteen
 * seconds and at six minutes; when somebody finally points the probe at a
 * phone, this line is the edit.
 */
const PROVING_USUALLY_MS = 74_000;

const asClock = (forMs: number): string => {
  const seconds = Math.floor(forMs / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
};

const kindWords = (recipient: Recipient): string => (recipient.kind === 'shielded'
  ? 'a SHIELDED address — a private payment; the amount and the parties stay '
    + 'hidden on the chain'
  : 'an UNSHIELDED address — an ordinary NIGHT transfer, visible on the chain');

/**
 * THE SCREEN WAKE LOCK, AND ITS ABSENCE IS A STATE RATHER THAN AN ERROR.
 *
 * THE RULE: *"a browser that refuses it still proves, and the screen
 * then says keep this awake yourself rather than pretending it has been
 * handled. Never let a rejected lock take the send down."*
 *
 * The API is not in this project's TypeScript lib and it is declared narrowly
 * here rather than widened globally, because this file uses exactly two
 * members of it. Two different facts reach the same sentence: `request`
 * REJECTS when a browser refuses (a hidden document, a policy, a battery
 * saver), and `navigator.wakeLock` is simply ABSENT where the API was never
 * implemented. They read the same to a person, who can do nothing different
 * about either, so they say the same thing.
 */
interface WakeSentinel { readonly release: () => Promise<void> }
interface WakeLockApi { readonly request: (kind: 'screen') => Promise<WakeSentinel> }
const wakeLockApi = (): WakeLockApi | null => {
  const holder = navigator as Navigator & { wakeLock?: WakeLockApi };
  return holder.wakeLock ?? null;
};

/** `idle` before and after; `held` while the browser is keeping the screen
 * on; `unheld` when it refused or never had the API. */
type WakeState = 'idle' | 'held' | 'unheld';

export function Send({ identity, secret }: {
  readonly identity: Identity;
  readonly secret: Secret;
}): ReactNode {
  const wiring = useContext(SendContext);

  /* The PAYING wallet is the one open on the home screen — same storage,
   * same guard. Switching wallets stays on home, where switching is
   * unmistakable; this screen only ever pays from the wallet it names. */
  const [{ names, account }] = useState(() => {
    const stored = loadSubwallets(secret);
    return {
      names: stored.names,
      account: isWalletAccount(stored.lastUsed) ? stored.lastUsed : MAIN_ACCOUNT,
    };
  });
  const owned = useMemo(
    () => ownedAddressFor(identity, account, names, NETWORK), [identity, account, names]);

  /* LIVE IS THE DEFAULT — the seam flipped. The rehearsal stays a
   * quiet click away, because a long wait and an unknown outcome are worth
   * practising before the day they are true. */
  const [mode, setMode] = useState<'live' | 'rehearsal'>(wiring.live ? 'live' : 'rehearsal');
  const [scenario, setScenario] = useState<RehearsalScenario>('ordinary');
  const [engineState, setEngineState] = useState<SendState | null>(null);
  const controller = useRef<SendController | null>(null);
  const doors = useMemo(
    () => (mode === 'live' && wiring.live
      /* The LIVE doors gain the two pending doors here, where the secret is:
       * the written-down middle (pending.ts, this account's store) and the
       * chain-by-identifier question the engine watches with. The rehearsal
       * doors carry their own throwaway versions. */
      ? {
        ...wiring.live.doorsFor(identity, account),
        pending: pendingGuardFor(secret, account),
        transactionStatus: transactionStatusOnChain,
      }
      : wiring.rehearsalDoorsFor(identity, account, scenario)),
    [wiring, mode, identity, secret, account, scenario]);
  /* Leaving the screen stops the listening, never an in-flight submission
   * (a transaction on its way to a network cannot be recalled), and ends
   * the rehearsal chain behind the doors. */
  useEffect(() => () => {
    controller.current?.detach();
    void doors.stop?.();
  }, [doors]);

  const [recipientText, setRecipientText] = useState('');
  const [amountText, setAmountText] = useState('');

  /* Live, per-keystroke honesty: the kind said back in words the moment an
   * address parses; the exact STARs the moment an amount does; the refusal
   * verbatim the moment either fails. */
  type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
  const tryParse = <T,>(parse: () => T): Parsed<T> => {
    try {
      return { ok: true, value: parse() };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };
  const recipientInfo: Parsed<Recipient> | null = useMemo(
    () => (recipientText.trim() ? tryParse(() => parseRecipient(recipientText, NETWORK)) : null),
    [recipientText]);
  const amountInfo: Parsed<bigint> | null = useMemo(
    () => (amountText.trim() ? tryParse(() => starsFromNight(amountText)) : null),
    [amountText]);

  const ready = recipientInfo?.ok === true && amountInfo?.ok === true;

  const begin = (): void => {
    if (!recipientInfo?.ok || !amountInfo?.ok) return;
    controller.current = wiring.start(
      doors,
      { recipient: recipientInfo.value, stars: amountInfo.value },
      setEngineState);
  };

  const reset = (): void => {
    controller.current?.detach();
    controller.current = null;
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
  const [wake, setWake] = useState<WakeState>('idle');
  useEffect(() => {
    if (!proving) {
      setWake('idle');
      return undefined;
    }
    const api = wakeLockApi();
    if (api === null) {
      setWake('unheld');
      return undefined;
    }
    let sentinel: WakeSentinel | null = null;
    let gone = false;
    /* A REJECTION IS A STATE. It is caught here and never reaches the engine,
     * so a browser that refuses the lock still proves and still sends — the
     * screen simply asks the person to do what the browser would not. */
    void api.request('screen').then(
      (granted) => {
        if (gone) {
          void granted.release().catch(() => { /* releasing twice is fine */ });
          return;
        }
        sentinel = granted;
        setWake('held');
      },
      () => { setWake('unheld'); },
    );
    /* Released when proving ends, however it ends — a terminal state, a
     * failure, or the screen going away under it. */
    return () => {
      gone = true;
      void sentinel?.release().catch(() => { /* the browser took it back */ });
    };
  }, [proving]);

  return (
    <div className="flex flex-col gap-6">
      {/* ----------------------------------------------------- who is paying */}
      <header className="flex flex-col gap-3">
        <h1 className="m-0">Send</h1>
        <Card>
          <CardContent className="flex items-start gap-3 pt-5">
            <Mark address={owned.address.bech32} account={owned.account} size={32} />
            <div className="min-w-0 flex-1">
              <p className="m-0 text-base font-semibold text-ink">{owned.name}</p>
              {owned.owner !== owned.name && (
                <p className="m-0 text-xs text-faint">{owned.slot}</p>
              )}
              <p className="m-0 mt-1 text-sm text-muted">
                Money leaves <strong className="font-medium text-ink">{owned.owner}</strong>
                {' '}— the wallet open on{' '}
                <a
                  className="text-accent underline-offset-4 hover:underline"
                  href={hrefOf('home')}
                >
                  the home screen
                </a>
                , where switching happens.
              </p>
            </div>
          </CardContent>
        </Card>
      </header>

      {/* -------------------------------------- which chain this screen is on */}
      {mode === 'live' && (
        <Section
          title={(
            <span className="flex flex-wrap items-center gap-2">
              This is real.
              <Badge tone="warning">{NETWORK}</Badge>
            </span>
          )}
        >
          <Card>
            <CardContent className="flex flex-col gap-3 pt-5">
              <p className="m-0 text-sm text-muted">
                Sending here moves real tNIGHT on {NETWORK}, pays a real fee in DUST, and
                cannot be taken back. Two hosts can be dialled, and nothing is asked of
                either until you press: checking a payment syncs this wallet from the
                indexer, and sending submits through the stagenet node. The proof is
                built in this browser, from circuit key material served by this
                wallet&rsquo;s own origin and verified against pinned fingerprints
                before use — no third party is asked for it.
              </p>
              {/*
                * SAID BEFORE THEY START, NOT AFTER THEY ARE TRAPPED —
                * Somebody who knows this takes a while and
                * needs the screen open can choose their moment; somebody told
                * halfway through a proof can only sit there.
                */}
              <p className="m-0 text-sm text-muted">
                Proving happens in this browser and can take minutes — the screen keeps
                its own clock and says which stage it is at.{' '}
                <strong className="font-medium text-ink">
                  You have to stay on this screen while it works.
                </strong>{' '}
                The proof is built in this tab and nothing is submitted until it is
                finished, so closing the tab or letting the phone sleep sends nothing —
                it throws the work away and it starts again from the form. Pick a moment
                when you can leave this open for {asClock(PROVING_USUALLY_MS)} or so.
              </p>
              {!inFlight && (
                <p className="m-0">
                  <Button variant="ghost" size="sm" onClick={() => switchMode('rehearsal')}>
                    Practise on a pretend chain first
                  </Button>
                </p>
              )}
            </CardContent>
          </Card>
        </Section>
      )}

      {mode === 'live' && <TermsCard fetchTerms={wiring.live?.fetchTerms ?? null} />}

      {mode === 'rehearsal' && (
        <Section
          title={(
            <span className="flex flex-wrap items-center gap-2">
              A rehearsal, not a real send
              <Badge tone="accent">rehearsal</Badge>
            </span>
          )}
        >
          <Card>
            <CardContent className="flex flex-col gap-4 pt-5">
              <p className="m-0 text-sm text-muted">
                Everything below runs the real send flow against a{' '}
                <strong className="font-medium text-ink">
                  pretend chain inside this browser
                </strong>{' '}
                — real coin selection, a real fee, and a block that really rejects a
                malformed transaction. Nothing talks to the network and no real money can
                move here.
              </p>
              {/*
                * THE SCENARIO PICKER SURVIVES THE RESTYLE, and the design
                * says why in one sentence: *"a restyle that loses the
                * picker loses the only way anybody has ever seen the dangerous
                * middle."* It is also how those states are photographed.
                *
                * `data-scenarios` replaces the old `send-scenarios` class: the
                * fact under test is that the FIELDSET disables in flight, and
                * a data attribute is a handle rather than a style.
                */}
              <fieldset
                data-scenarios=""
                className={[
                  'm-0 flex flex-col gap-1 rounded-tight border border-line',
                  'bg-sunken px-4 pt-2 pb-3 disabled:opacity-55',
                ].join(' ')}
                disabled={inFlight}
              >
                <legend className="px-1 text-xs font-medium text-muted">What to rehearse</legend>
                <ScenarioChoice
                  checked={scenario === 'ordinary'}
                  onChoose={() => setScenario('ordinary')}
                >
                  A send that works
                </ScenarioChoice>
                <ScenarioChoice
                  checked={scenario === 'slow-proving'}
                  onChoose={() => setScenario('slow-proving')}
                >
                  Slow proving — the proof takes minutes, as it may on the real chain
                </ScenarioChoice>
                <ScenarioChoice
                  checked={scenario === 'submission-fails'}
                  onChoose={() => setScenario('submission-fails')}
                >
                  The worst case — the proof succeeds and the network never answers
                </ScenarioChoice>
              </fieldset>
              {!inFlight && wiring.live && (
                <p className="m-0">
                  <Button variant="ghost" size="sm" onClick={() => switchMode('live')}>
                    Back to real sending
                  </Button>
                </p>
              )}
            </CardContent>
          </Card>
        </Section>
      )}

      {/* ------------------------------------------------- who, and how much */}
      {!inFlight && (
        <Section title="Who, and how much">
          <Card>
            <CardContent className="flex flex-col pt-5">
              <Label htmlFor="send-recipient">The recipient&rsquo;s address</Label>
              <Textarea
                id="send-recipient"
                mono
                aria-label="The recipient's address"
                value={recipientText}
                rows={3}
                spellCheck={false}
                aria-invalid={recipientInfo?.ok === false}
                placeholder={`mn_addr_${NETWORK}1… or mn_shield-addr_${NETWORK}1…`}
                onChange={(e) => setRecipientText(e.target.value)}
              />
              {recipientInfo?.ok === true && (
                <p className="m-0 mt-2 text-sm text-muted" role="status">
                  This is {kindWords(recipientInfo.value)}.
                </p>
              )}
              {recipientInfo?.ok === false && <Refusal>{recipientInfo.error}</Refusal>}

              <Label htmlFor="send-amount" className="mt-5">The amount, in tNIGHT</Label>
              <Input
                id="send-amount"
                aria-label="The amount, in tNIGHT"
                value={amountText}
                inputMode="decimal"
                aria-invalid={amountInfo?.ok === false}
                placeholder="0.000000"
                onChange={(e) => setAmountText(e.target.value)}
              />
              {amountInfo?.ok === true && (
                <p className="m-0 mt-2 text-sm text-muted" role="status">
                  {/* §7.17: the number that will actually move, beside the typed
                    * one, BEFORE anything is agreed to. */}
                  Exactly {exactStars(amountInfo.value)} — the chain counts STARs, and
                  this is the figure the transaction will carry.
                </p>
              )}
              {amountInfo?.ok === false && <Refusal>{amountInfo.error}</Refusal>}

              <div className="mt-5">
                <Button variant="primary" disabled={!ready} onClick={begin}>
                  Check this payment
                </Button>
              </div>
              <p className="m-0 mt-3 text-xs text-faint">
                Checking builds and balances the transaction so you can see what would
                actually happen — the fee, and the balance after. Nothing is sent until
                you agree on the next screen.
              </p>
            </CardContent>
          </Card>
        </Section>
      )}

      {/* -------------------------------------------------------- the working */}
      {engineState?.name === 'working' && (
        <Section
          title={(
            <>
              {engineState.stage === 'starting' && 'Reading the wallet…'}
              {engineState.stage === 'balancing' && 'Building and balancing…'}
              {engineState.stage === 'signing' && 'Authorising…'}
              {engineState.stage === 'proving' && 'Proving…'}
              {engineState.stage === 'submitting' && 'Submitting…'}
            </>
          )}
        >
          <Card>
            <CardContent className="flex flex-col gap-3 pt-5">
              {/* The wallet's own clock, on screen. Never a still frame:
                * the engine re-emits every second and this line moves. */}
              {/* `data-clock` is a HANDLE, not a style. The screenshot driver has
                * to wait for the clock to reach a minute to photograph the
                * waiting screen a minute in, and a duration went in the prose
                * beside it — so a walker matching the page for the text `1m`
                * now matches the sentence instead of the clock, instantly, and
                * photographs zero seconds while reporting a minute. */}
              <p
                data-clock=""
                className="m-0 font-mono text-display tabular-nums text-ink"
                aria-hidden="true"
              >
                {asClock(engineState.forMs)}
              </p>
              <p className="m-0 text-sm text-muted" role="status" aria-live="polite">
                {STAGE_WORDS[engineState.stage]}
              </p>
              {engineState.stage === 'proving' && (
                <>
                  {/* HONEST PROGRESS: how long this usually takes, and where the
                    * number came from. Never a bar pretending to know a
                    * percentage — nothing on this screen can know one. */}
                  <p className="m-0 text-sm text-muted">
                    On a laptop this usually finishes in around{' '}
                    {asClock(PROVING_USUALLY_MS)}. A phone has never been measured and
                    may be several times that. There is no percentage to show you — a
                    proof does not report its own progress — so the clock above is the
                    honest one.
                  </p>
                  <WakeNote wake={wake} />
                  {/*
                    * THE TAB THAT DIES ANYWAY GETS THE TRUTH, AND TODAY THE
                    * TRUTH IS THAT IT DID NOT HAPPEN. Nothing is submitted
                    * while a proof is being built, so no money moved and
                    * nothing is pending. The record's whole value is that it
                    * distinguishes SUBMITTED from NEVER STARTED, and this
                    * state is firmly the second — so the screen says so rather
                    * than implying it might still land.
                    */}
                  <Alert tone="warning" role={null} title="Stay on this screen.">
                    <p className="m-0">
                      Nothing has been sent yet. If this tab closes, or the browser is
                      put to sleep or switched away from on a phone, the proof stops and
                      this payment simply does not happen — no money moves, nothing is
                      left pending, and there is nothing to come back to. You would begin
                      again from the form.
                    </p>
                  </Alert>
                </>
              )}
            </CardContent>
          </Card>
        </Section>
      )}

      {/* --------------------------------------------------- the confirmation */}
      {engineState?.name === 'confirm' && (
        <ConfirmCard
          facts={engineState.facts}
          owner={owned.owner}
          onSend={() => controller.current?.confirm()}
          onCancel={() => controller.current?.cancel()}
        />
      )}

      {/* --------------------------------------------------------- the endings */}
      {engineState?.name === 'cancelled' && (
        <Section title="Nothing was sent.">
          <Card>
            <CardContent className="flex flex-col gap-4 pt-5">
              <p className="m-0 text-sm text-muted">
                The transaction was discarded and the coins it had set aside are released.
                No money moved.
              </p>
              <p className="m-0">
                <Button onClick={reset}>Start again</Button>
              </p>
            </CardContent>
          </Card>
        </Section>
      )}

      {engineState?.name === 'refused' && (
        <Section title="This payment was refused.">
          <Card>
            <CardContent className="flex flex-col gap-4 pt-5">
              {/* The engine's message says what happened and that nothing moved —
                * verbatim, never rewritten (§3, an old habit). */}
              <Refusal>{engineState.message}</Refusal>
              <p className="m-0">
                <Button onClick={reset}>Start again</Button>
              </p>
            </CardContent>
          </Card>
        </Section>
      )}

      {engineState?.name === 'failed' && (
        <Section title="This payment did not go through.">
          <Card>
            <CardContent className="flex flex-col gap-4 pt-5">
              {/* A RESOLVED middle — the chain itself answered, so unlike
                * the unknown state this one is allowed the word "failed". */}
              <Refusal>{engineState.message}</Refusal>
              <div>
                <p className="m-0 text-sm text-muted">
                  The identifier{engineState.identifiers.length === 1 ? '' : 's'}, for records:
                </p>
                {engineState.identifiers.map((id) => (
                  <Bytes key={id}>{id}</Bytes>
                ))}
              </div>
              <p className="m-0">
                <Button onClick={reset}>Start again</Button>
              </p>
            </CardContent>
          </Card>
        </Section>
      )}

      {engineState?.name === 'sent' && (
        <Section
          title={(
            <span className="flex items-center gap-2">
              <Icon glyph={GLYPH.success} className="text-good" />
              Sent.
            </span>
          )}
        >
          <Card>
            <CardContent className="flex flex-col gap-4 pt-5">
              <p className="m-0 text-sm text-muted">
                The network accepted the transaction: {nightFromStars(engineState.facts.stars)}{' '}
                tNIGHT to {shortUnshieldedOrPayee(engineState.facts)} — with a fee of{' '}
                {dustFromSpecks(engineState.facts.feeSpecks)} tDUST. DUST grows back on its
                own; the fee is not gone for ever, only for a while.
              </p>
              <div>
                <p className="m-0 text-sm text-muted">
                  Its identifier, for checking or for records:
                </p>
                <Bytes>{engineState.txId}</Bytes>
                <CopyButton
                  className={buttonClasses('secondary', 'sm')}
                  text={engineState.txId}
                  label="Copy the transaction identifier"
                />
              </div>
              <p className="m-0">
                <Button onClick={reset}>Start again</Button>
              </p>
            </CardContent>
          </Card>
        </Section>
      )}

      {engineState?.name === 'unknown' && (
        <Section title="Whether this sent is not known.">
          <Alert tone="warning" role="alert">
            <div className="flex flex-col gap-3 text-ink">
              <p className="m-0 text-sm">{engineState.message}</p>
              <div>
                <p className="m-0 text-sm">
                  The identifier{engineState.identifiers.length === 1 ? '' : 's'} to check:
                </p>
                {engineState.identifiers.map((id) => (
                  <Bytes key={id}>{id}</Bytes>
                ))}
                <CopyButton
                  className={buttonClasses('secondary', 'sm')}
                  text={engineState.identifiers.join('\n')}
                  label="Copy the identifiers"
                />
              </div>
              {/* The middle is WATCHED, always — stillWaiting can no
                * longer be false, and the copy button above is a courtesy,
                * never the remedy. */}
              <p className="m-0 text-sm" role="status" aria-live="polite">
                Still confirming — this wallet is watching the chain and will say
                sent or failed on its own. This payment is also carried on the home
                screen until it settles. Do not send it again.
              </p>
            </div>
          </Alert>
        </Section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- small pieces */

/**
 * A REFUSAL, VERBATIM. `role="alert"` is the fact and the colour follows it —
 * the same discipline `kit/input.tsx` states for `aria-invalid`.
 *
 * IT IS WRITTEN HERE RATHER THAN TAKEN FROM `kit/alert.tsx`, FOR ONE REASON
 * WORTH NAMING: the engine's refusal message is asserted CHARACTER FOR
 * CHARACTER by `send-screen.test.tsx`, so the element carrying `role="alert"`
 * has to contain that message and nothing else — no icon, no title, nothing
 * decorative with a text node in it.
 */
function Refusal({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <div
      role="alert"
      className={[
        'mt-2 rounded-tight border border-bad-border bg-bad-dim px-3 py-2',
        'text-sm break-words text-bad',
      ].join(' ')}
    >
      {children}
    </div>
  );
}

/**
 * BYTES SOMEBODY MAY HAVE TO COMPARE OR PASTE — an address, a transaction
 * identifier. `select-all` so one click takes the whole thing rather than a
 * word out of the middle of it.
 */
function Bytes({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <div
      className={[
        'my-2 rounded-tight border border-line bg-sunken px-3 py-2',
        'font-mono text-xs leading-relaxed break-all text-muted select-all',
      ].join(' ')}
    >
      {children}
    </div>
  );
}

/** One rehearsal scenario. A real radio in a real fieldset — the fieldset is
 * what disables the whole set in one attribute while a send is in flight. */
function ScenarioChoice({ checked, onChoose, children }: {
  readonly checked: boolean;
  readonly onChoose: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <label className="flex min-h-touch cursor-pointer items-center gap-2.5 text-sm text-ink">
      <input
        type="radio"
        name="scenario"
        className="size-4 shrink-0 accent-accent"
        checked={checked}
        onChange={onChoose}
      />
      {children}
    </label>
  );
}

/**
 * WHETHER THE BROWSER IS KEEPING THE SCREEN ON — and the refusal is a
 * SENTENCE, never a silence. THE RULE: *"its absence is a state, not
 * an error."* A browser that will not hold the lock still proves, so the
 * screen asks the person to do the one thing the browser would not.
 */
function WakeNote({ wake }: { readonly wake: WakeState }): ReactNode {
  if (wake === 'held') {
    return (
      <p className="m-0 flex items-start gap-2 text-sm text-muted">
        <Icon glyph={GLYPH.success} className="mt-0.5 text-good" />
        This browser is keeping the screen awake while the proof is built.
      </p>
    );
  }
  if (wake === 'unheld') {
    return (
      <p className="m-0 flex items-start gap-2 text-sm text-muted">
        <Icon glyph={GLYPH.warning} className="mt-0.5 text-warn" />
        This browser will not keep the screen awake — keep it awake yourself, and do
        not let the device lock while this runs.
      </p>
    );
  }
  return null;
}

const shortUnshieldedOrPayee = (facts: SendFacts): string => {
  const at = facts.recipientBech32.lastIndexOf('1');
  const payload = at > 0 ? facts.recipientBech32.slice(at + 1) : facts.recipientBech32;
  const network = at > 0 ? facts.recipientBech32.slice(0, at + 1) : '';
  return `${network}${payload.slice(0, 8)}…${payload.slice(-8)}`;
};

/**
 * THE NETWORK'S TERMS — a decision, built exactly as decided: shown
 * ONCE, on the first live send screen, the hash recorded locally, BLOCKING
 * NOTHING. Fetching is an indexer call, so it happens here — on a screen a
 * person deliberately opened to send real money — and nowhere else. A fetch
 * that fails blocks nothing either: the card says so quietly and the terms
 * show whenever they next can.
 */
function TermsCard({ fetchTerms }: {
  readonly fetchTerms: (() => Promise<{ hash: string; url: string }>) | null;
}): ReactNode {
  type TermsState =
    | { readonly name: 'already-seen' }
    | { readonly name: 'fetching' }
    | { readonly name: 'show'; readonly hash: string; readonly url: string }
    | { readonly name: 'failed'; readonly message: string };
  const [state, setState] = useState<TermsState>(() => (
    loadTermsSeen() !== null ? { name: 'already-seen' } : { name: 'fetching' }));
  useEffect(() => {
    if (state.name !== 'fetching' || !fetchTerms) return undefined;
    let stale = false;
    fetchTerms().then((terms) => {
      if (stale) return;
      recordTermsSeen(terms);
      setState({ name: 'show', hash: terms.hash, url: terms.url });
    }).catch((e: unknown) => {
      if (stale) return;
      setState({ name: 'failed', message: describeFailure(e) });
    });
    return () => { stale = true; };
    /* Runs once: 'fetching' is only ever the initial state. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (state.name === 'already-seen' || !fetchTerms) return null;
  return (
    <Section title={<>The network&rsquo;s terms</>}>
      <Card>
        <CardContent className="flex flex-col gap-3 pt-5">
          {state.name === 'fetching' && (
            <p className="m-0 text-sm text-muted" role="status">
              Asking the indexer for the network&rsquo;s current terms and
              conditions… Sending is not blocked by this.
            </p>
          )}
          {state.name === 'show' && (
            <>
              <p className="m-0 text-sm text-muted">
                The network publishes terms and conditions that wallets are expected to
                show once. They are at{' '}
                <a
                  className="text-accent underline-offset-4 hover:underline"
                  href={state.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {state.url}
                </a>
                . This is the network&rsquo;s expectation, not a gate of this
                wallet&rsquo;s: nothing about sending is blocked by it.
              </p>
              <p className="m-0 text-xs text-faint">
                Their fingerprint (SHA-256), recorded in this browser so this card is
                not shown again:{' '}
                <span className="font-mono break-all">{state.hash}</span>
              </p>
            </>
          )}
          {state.name === 'failed' && (
            <p className="m-0 text-xs text-faint" role="status">
              The network&rsquo;s terms could not be fetched right now
              ({state.message}). Sending is not blocked; they will be shown when they
              next can be.
            </p>
          )}
        </CardContent>
      </Card>
    </Section>
  );
}

/**
 * THE CONFIRMATION — read back from the balanced transaction, and the one
 * place the irreversibility sentence lives. §4: what is shown here is what
 * WILL HAPPEN, not what was typed; where the two could disagree, the engine
 * has already refused rather than let this card render.
 *
 * EVERY ONE OF THOSE SENTENCES IS KEPT AND ONLY WHAT CARRIES THEM CHANGES.
 * The four facts are four labelled rows in the order they were in — to,
 * amount, fee, what the balance becomes — because that is the order somebody
 * checks them in, and reordering it to look better is exactly what
 * the design forbids.
 *
 * TWO SENTENCES SIT BELOW THE CARD AND THEY ARE NOT THE SAME SENTENCE. The
 * first is §4's irreversibility line, said ONCE and only here. The second is
 * the other: how long this will hold somebody on this screen. Both belong BEFORE
 * the button, and neither may be moved after it.
 */
function ConfirmCard({ facts, owner, onSend, onCancel }: {
  readonly facts: SendFacts;
  readonly owner: string;
  readonly onSend: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  return (
    <Section title="Look at what will happen.">
      <Card>
        <CardContent className="flex flex-col divide-y divide-line pt-5">
          <Fact label="To">
            <p className="m-0 font-mono text-sm break-all text-ink">
              {shortUnshieldedOrPayee(facts)}
            </p>
            <p className="m-0 mt-1.5 text-sm text-muted">
              {facts.kind === 'shielded'
                ? 'A shielded address — a private payment.'
                : 'An unshielded address — an ordinary, visible NIGHT transfer.'}
              {' '}Check <strong className="font-medium text-ink">both ends</strong> against
              what you were given.
            </p>
            <details className="group mt-2">
              <summary
                className={[
                  'inline-flex cursor-pointer list-none items-center gap-1.5 text-sm',
                  'text-muted hover:text-ink [&::-webkit-details-marker]:hidden',
                ].join(' ')}
              >
                <Icon
                  glyph={GLYPH.next}
                  className="size-4 transition-transform duration-(--motion-quick) group-open:rotate-90"
                />
                Show the whole address
              </summary>
              <Bytes>{facts.recipientBech32}</Bytes>
            </details>
          </Fact>

          <Fact label="Amount">
            <p className="m-0 text-display font-semibold tabular-nums text-ink">
              {nightFromStars(facts.stars)}{' '}
              <span className="text-base font-medium text-muted">tNIGHT</span>
            </p>
            <p className="m-0 mt-1.5 text-sm text-muted">
              Exactly {exactStars(facts.stars)}.{' '}
              {facts.readBack === 'transaction'
                ? 'Read back out of the built transaction — this is what will actually move.'
                : 'A shielded amount cannot be read back off the transaction — it is '
                  + 'encrypted to its recipient, which is the privacy working. This is the '
                  + 'one value the transaction was built from; the fee below was read back.'}
            </p>
          </Fact>

          <Fact label="The fee, in DUST">
            <p className="m-0 text-sm text-ink">
              {dustFromSpecks(facts.feeSpecks)} tDUST
              <span className="text-xs text-faint"> — exactly {exactSpecks(facts.feeSpecks)}, read
              back from the transaction&rsquo;s own dust spends</span>
            </p>
          </Fact>

          <Fact label={`${owner} afterwards`}>
            <p className="m-0 text-sm text-ink">
              {facts.kind === 'shielded' ? 'Shielded' : 'Unshielded'} NIGHT:{' '}
              {nightFromStars(facts.nightBefore)} →{' '}
              <strong className="font-semibold">{nightFromStars(facts.nightAfter)}</strong>{' '}
              tNIGHT
              <span className="text-xs text-faint"> ({exactStars(facts.nightAfter)})</span>
            </p>
            <p className="m-0 mt-1 text-sm text-ink">
              DUST: {dustFromSpecks(facts.dustBefore)} →{' '}
              <strong className="font-semibold">{dustFromSpecks(facts.dustAfter)}</strong>{' '}
              tDUST
              <span className="text-xs text-faint"> — and it grows back from the registered NIGHT</span>
            </p>
          </Fact>
        </CardContent>
      </Card>

      {/* Said ONCE, plainly, BEFORE — and never afterwards. */}
      <p className="m-0 max-w-prose text-sm font-medium text-warn-text">
        Sending cannot be undone. There is no cancel and no refund on a chain —
        money that leaves comes back only if its recipient chooses to return it.
      </p>
      {/* The other thing somebody needs before pressing, and it is a different
        * fact from the one above: how long this will hold them here. */}
      <p className="m-0 max-w-prose text-sm text-muted">
        Building the proof takes around {asClock(PROVING_USUALLY_MS)} on a laptop and
        longer on a phone, and this screen has to stay open the whole time.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onSend}>Send it</Button>
        <Button onClick={onCancel}>Don&rsquo;t send</Button>
      </div>
    </Section>
  );
}

/** One labelled fact on the confirmation. The label is an `h3` under the
 * section's `h2` — the ladder `kit/section.tsx` sets out. */
function Fact({ label, children }: {
  readonly label: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <h3 className="m-0 mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
        {label}
      </h3>
      {children}
    </div>
  );
}
