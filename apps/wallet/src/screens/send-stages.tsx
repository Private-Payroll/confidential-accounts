import type { ReactNode } from 'react';
import { Button, Card, CardContent, Section } from 'vaults-ui';
import { dustFromSpecks, nightFromStars } from '../chain/amount.js';
import { STAGE_WORDS } from '../chain/send.js';
import type { SendState } from '../chain/send.js';
import { CopyButton } from '../components/ui.js';
import { StatusAlert } from '../components/status.js';
import { GLYPH, Glyph } from '../glyphs.js';
import type { WakeState } from './send-hooks.js';
import { Bytes, PROVING_USUALLY_MS, Refusal, asClock, shortUnshieldedOrPayee } from './send-parts.js';

type Stage<N extends SendState['name']> = Extract<SendState, { readonly name: N }>;

/** The send engine's own state, said while it works: the stage, the clock and what to expect. */
export function WorkingCard({
  engineState,
  wake
}: {
  readonly engineState: Stage<'working'>;
  readonly wake: WakeState;
}): ReactNode {
  return (
    <Section
      list={false}
      box={false}
      aria-label={
        (
          {
            starting: 'Reading the wallet…',
            balancing: 'Building and balancing…',
            signing: 'Authorising…',
            proving: 'Proving…',
            submitting: 'Submitting…'
          } as Record<string, string>
        )[engineState.stage]
      }
      title={
        <>
          {engineState.stage === 'starting' && 'Reading the wallet…'}
          {engineState.stage === 'balancing' && 'Building and balancing…'}
          {engineState.stage === 'signing' && 'Authorising…'}
          {engineState.stage === 'proving' && 'Proving…'}
          {engineState.stage === 'submitting' && 'Submitting…'}
        </>
      }
    >
      <Card>
        <CardContent className="flex flex-col gap-3">
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
            className="m-0 font-mono text-3xl tracking-tight tabular-nums text-foreground"
            aria-hidden="true"
          >
            {asClock(engineState.forMs)}
          </p>
          <p className="m-0 text-sm text-muted-foreground" role="status" aria-live="polite">
            {STAGE_WORDS[engineState.stage]}
          </p>
          {engineState.stage === 'proving' && (
            <>
              {/* HONEST PROGRESS: how long this usually takes, and where the
               * number came from. Never a bar pretending to know a
               * percentage — nothing on this screen can know one. */}
              <p className="m-0 text-sm text-muted-foreground">
                On a laptop this usually finishes in around {asClock(PROVING_USUALLY_MS)}. A phone has never been
                measured and may be several times that. There is no percentage to show you — a proof does not report its
                own progress — so the clock above is the honest one.
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
              <StatusAlert tone="warning" role={null} title="Stay on this screen.">
                <p className="m-0">
                  Nothing has been sent yet. If this tab closes, or the browser is put to sleep or switched away from on
                  a phone, the proof stops and this payment simply does not happen — no money moves, nothing is left
                  pending, and there is nothing to come back to. You would begin again from the form.
                </p>
              </StatusAlert>
            </>
          )}
        </CardContent>
      </Card>
    </Section>
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
      <p className="m-0 flex items-start gap-2 text-sm text-muted-foreground">
        <Glyph icon={GLYPH.success} className="size-5 mt-0.5 text-good" />
        This browser is keeping the screen awake while the proof is built.
      </p>
    );
  }
  if (wake === 'unheld') {
    return (
      <p className="m-0 flex items-start gap-2 text-sm text-muted-foreground">
        <Glyph icon={GLYPH.warning} className="size-5 mt-0.5 text-warn" />
        This browser will not keep the screen awake — keep it awake yourself, and do not let the device lock while this
        runs.
      </p>
    );
  }
  return null;
}

function CancelledCard({ reset }: { readonly reset: () => void }): ReactNode {
  return (
    <Section list={false} box={false} aria-label="Nothing was sent." title="Nothing was sent.">
      <Card>
        <CardContent className="flex flex-col gap-4">
          <p className="m-0 text-sm text-muted-foreground">
            The transaction was discarded and the coins it had set aside are released. No money moved.
          </p>
          <p className="m-0">
            <Button type="button" variant="outline" onClick={reset}>
              Start again
            </Button>
          </p>
        </CardContent>
      </Card>
    </Section>
  );
}

function RefusedCard({
  engineState,
  reset
}: {
  readonly engineState: Stage<'refused'>;
  readonly reset: () => void;
}): ReactNode {
  return (
    <Section list={false} box={false} aria-label="This payment was refused." title="This payment was refused.">
      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* The engine's message says what happened and that nothing moved —
           * verbatim, never rewritten (§3, an old habit). */}
          <Refusal>{engineState.message}</Refusal>
          <p className="m-0">
            <Button type="button" variant="outline" onClick={reset}>
              Start again
            </Button>
          </p>
        </CardContent>
      </Card>
    </Section>
  );
}

function FailedCard({
  engineState,
  reset
}: {
  readonly engineState: Stage<'failed'>;
  readonly reset: () => void;
}): ReactNode {
  return (
    <Section
      list={false}
      box={false}
      aria-label="This payment did not go through."
      title="This payment did not go through."
    >
      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* A RESOLVED middle — the chain itself answered, so unlike
           * the unknown state this one is allowed the word "failed". */}
          <Refusal>{engineState.message}</Refusal>
          <div>
            <p className="m-0 text-sm text-muted-foreground">
              The identifier{engineState.identifiers.length === 1 ? '' : 's'}, for records:
            </p>
            {engineState.identifiers.map((id) => (
              <Bytes key={id}>{id}</Bytes>
            ))}
          </div>
          <p className="m-0">
            <Button type="button" variant="outline" onClick={reset}>
              Start again
            </Button>
          </p>
        </CardContent>
      </Card>
    </Section>
  );
}

function SentCard({
  engineState,
  reset
}: {
  readonly engineState: Stage<'sent'>;
  readonly reset: () => void;
}): ReactNode {
  return (
    <Section
      list={false}
      box={false}
      aria-label="Sent."
      title={
        <span className="flex items-center gap-2">
          <Glyph icon={GLYPH.success} className="size-5 text-good" />
          Sent.
        </span>
      }
    >
      <Card>
        <CardContent className="flex flex-col gap-4">
          <p className="m-0 text-sm text-muted-foreground">
            The network accepted the transaction: {nightFromStars(engineState.facts.stars)} tNIGHT to{' '}
            {shortUnshieldedOrPayee(engineState.facts)} — with a fee of {dustFromSpecks(engineState.facts.feeSpecks)}{' '}
            tDUST. DUST grows back on its own; the fee is not gone for ever, only for a while.
          </p>
          <div>
            <p className="m-0 text-sm text-muted-foreground">Its identifier, for checking or for records:</p>
            <Bytes>{engineState.txId}</Bytes>
            <CopyButton kit text={engineState.txId} label="Copy the transaction identifier" />
          </div>
          <p className="m-0">
            <Button type="button" variant="outline" onClick={reset}>
              Start again
            </Button>
          </p>
        </CardContent>
      </Card>
    </Section>
  );
}

function UnknownCard({ engineState }: { readonly engineState: Stage<'unknown'> }): ReactNode {
  return (
    <Section
      list={false}
      box={false}
      aria-label="Whether this sent is not known."
      title="Whether this sent is not known."
    >
      <StatusAlert tone="warning" role="alert">
        <div className="flex flex-col gap-3 text-foreground">
          <p className="m-0 text-sm">{engineState.message}</p>
          <div>
            <p className="m-0 text-sm">The identifier{engineState.identifiers.length === 1 ? '' : 's'} to check:</p>
            {engineState.identifiers.map((id) => (
              <Bytes key={id}>{id}</Bytes>
            ))}
            <CopyButton kit text={engineState.identifiers.join('\n')} label="Copy the identifiers" />
          </div>
          {/* The middle is WATCHED, always — stillWaiting can no
           * longer be false, and the copy button above is a courtesy,
           * never the remedy. */}
          <p className="m-0 text-sm" role="status" aria-live="polite">
            Still confirming — this wallet is watching the chain and will say sent or failed on its own. This payment is
            also carried on the home screen until it settles. Do not send it again.
          </p>
        </div>
      </StatusAlert>
    </Section>
  );
}

/** How a send ended, or where it is still unknown: one card per ending. */
export function SendEnding({
  engineState,
  reset
}: {
  readonly engineState: SendState | null;
  readonly reset: () => void;
}): ReactNode {
  return (
    <>
      {engineState?.name === 'cancelled' && <CancelledCard reset={reset} />}
      {engineState?.name === 'refused' && <RefusedCard engineState={engineState} reset={reset} />}
      {engineState?.name === 'failed' && <FailedCard engineState={engineState} reset={reset} />}
      {engineState?.name === 'sent' && <SentCard engineState={engineState} reset={reset} />}
      {engineState?.name === 'unknown' && <UnknownCard engineState={engineState} />}
    </>
  );
}
