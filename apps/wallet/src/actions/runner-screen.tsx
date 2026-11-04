import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Section, useText } from 'vaults-ui';
import type { Identity, Secret } from 'midnight-identity/keys/derivation';
import type { ActRequest } from 'midnight-identity/profile/request';
import type { ActingChannel, Framing } from 'midnight-identity/profile/channel';
import { StatusAlert } from '../components/status.js';
import { useSession } from '../session.js';
import { FRAMING, useConsent, type Consent } from '../framing.js';
import type { ActionDefinition, ActionStep, ShownLine, WalletRecord, Words } from './definition.js';
import { keepTheEnd } from './ended-here.js';
import { runAction } from './run.js';
import type { RunState } from './run.js';

/**
 * THE SCREEN AN ACTION RUNS ON, AND WHAT ITS WINDOW SHOWS BEFORE THE PASSKEY.
 *
 * Before: what the action acts on, each line marked as this wallet's own read
 * or only the page's words, and the action's own account of what it does left
 * unmarked - with, when the act sends its calls straight to the chain, the line
 * that says so and that the person's own wallet pays their fees; its steps; and
 * what is checked after the passkey.
 * While it runs: the steps, the one running, how many transactions the page
 * has handed over, and Stop, there at every step and held by no check on what
 * can be seen. The one press it may wait for is a Confirm: when a step reads
 * with the seat's keys what the approval is about, before anything is handed
 * over, this window shows what it read and waits for Confirm or Stop, with no
 * second passkey; that Confirm is held by the same guard as Approve. When it ends, the wallet locks itself, so the keys the
 * passkey opened are held no longer than the action.
 */

/** How the running window lists step `n`: passed steps are done, or not needed when the step says nothing was owed of it. */
export const stepStateOf = (step: ActionStep, n: number, at: RunState): 'done' | 'not-needed' | 'running' | 'waiting' => {
  if (n === at.step) return 'running';
  if (n > at.step) return 'waiting';
  return step.notNeeded?.(at.told ?? {}) === true ? 'not-needed' : 'done';
};

export type ShownState =
  | { readonly of: 'reading' }
  | { readonly of: 'read'; readonly lines: readonly ShownLine[] }
  | { readonly of: 'refused' };

/** Reads the lines the window shows before the passkey; any read behind them is this wallet's own and needs no seed. */
export function useShown(request: ActRequest | null, action: ActionDefinition | null): ShownState {
  const [shown, setShown] = useState<ShownState>({ of: 'reading' });
  useEffect(() => {
    if (request === null || action === null) return undefined;
    let alive = true;
    setShown({ of: 'reading' });
    action.shown(request.intent).then(
      (lines) => { if (alive) setShown({ of: 'read', lines }); },
      () => { if (alive) setShown({ of: 'refused' }); },
    );
    return () => { alive = false; };
  }, [request, action]);
  return shown;
}

/** An action's steps, or none when its definition cannot list them; the runner then ends it as a failed step. */
const stepsOf = (action: ActionDefinition, request: ActRequest): readonly ActionStep[] => {
  try { return action.steps(request.intent); } catch { return []; }
};

const say = (t: (key: string, values?: Record<string, unknown>) => string, words: Words): string =>
  t(words.key, { ...(words.values ?? {}) });

/** What the action does, as its window shows it before the passkey and before it runs. */
export function ActWhatItDoes({ request, action, shown }: {
  readonly request: ActRequest; readonly action: ActionDefinition; readonly shown: ShownState;
}): ReactNode {
  const t = useText();
  const steps = stepsOf(action, request);
  const checks = action.checksFor?.(request.intent) ?? action.checks;
  return (
    <>
      <p className="lede" data-what-it-does>{t('ask.act.lede')}</p>
      <Section list={false} box={false} aria-label={t('ask.act.shown-title')} title={t('ask.act.shown-title')}>
        {shown.of === 'reading' && <p className="m-0 text-sm" data-act-reading>{t('ask.act.reading')}</p>}
        {shown.of === 'refused' && (
          <StatusAlert tone="danger" title={t('ask.act.unread-title')}>
            <p className="m-0" data-act-unread>{t('ask.act.unread')}</p>
          </StatusAlert>
        )}
        {shown.of === 'read' && (
          <ul className="m-0 ps-6" data-act-shown>
            {shown.lines.map((line, i) => (
              <li key={i} className="text-sm" data-shown-from={line.from}>
                {line.from === 'action' ? say(t, line) : t(line.from === 'page' ? 'ask.act.from-the-page' : 'ask.act.from-this-wallet', { line: say(t, line) })}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section
        list={false} box={false} aria-label={t('ask.act.steps-title')} title={t('ask.act.steps-title')}
        description={t('ask.act.steps-why', { count: steps.length })}
      >
        <ol className="m-0 ps-6" data-act-steps>
          {steps.map((step, i) => <li key={i} className="text-sm">{say(t, step.title)}</li>)}
        </ol>
      </Section>
      {checks.length > 0 && (
        <Section
          list={false} box={false} aria-label={t('ask.act.checks-title')} title={t('ask.act.checks-title')}
          description={t('ask.act.checks-why')}
        >
          <ul className="m-0 ps-6" data-checked-after-the-passkey>
            {checks.map((check, i) => <li key={i} className="text-sm">{say(t, check)}</li>)}
          </ul>
        </Section>
      )}
    </>
  );
}

/**
 * RUNS AN APPROVED ACTION. `atOnce` is the Approve pressed in the window before
 * the passkey: the action starts as soon as the wallet is open, with no second
 * press and no second passkey; the one press it may still ask for is the
 * Confirm of what a step read with the seat's keys, before anything is sent.
 * Without it (the wallet was already open when the ask came) this shows
 * what the action does and an Approve of its own, held by the same check on
 * what can be seen as every Approve.
 */
export function ActionRunner({
  request, action, channel, identity, secret, consent, atOnce, onDecline, now = Date.now, wallet, account, payingFrom, framing = FRAMING,
}: {
  readonly request: ActRequest;
  readonly action: ActionDefinition;
  readonly channel: ActingChannel | null;
  readonly identity: Identity;
  readonly secret: Secret;
  readonly consent: Consent;
  readonly atOnce: boolean;
  readonly onDecline: () => void;
  readonly now?: () => number;
  /** This wallet's own record of the companies it started, for an action that reads or adds to it. */
  readonly wallet?: WalletRecord;
  /** The account the person chose in the window, for an action that pays from it. */
  readonly account?: number;
  /** For an action that pays: where the person chooses which of their accounts pays, shown before they approve. */
  readonly payingFrom?: ReactNode;
  /** Where this wallet is drawn, the same as the window's own: what the Confirm's guard measures. */
  readonly framing?: Framing;
}): ReactNode {
  const t = useText();
  const { lock } = useSession();
  const shown = useShown(request, action);
  const [pressed, setPressed] = useState(false);
  const [state, setState] = useState<RunState | null>(null);
  const [stopping, setStopping] = useState(false);
  /* What a step read with the seat's keys and waits on the person to confirm, with how to answer it. */
  const [asked, setAsked] = useState<{ readonly lines: readonly Words[]; readonly answer: (yes: boolean) => void } | null>(null);
  const stop = useRef<AbortController | null>(null);
  const started = useRef(false);
  const mounted = useRef(true);
  const go = atOnce || pressed;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      /* Put away for good, not only re-run: the action stops with the screen that runs it. */
      setTimeout(() => { if (!mounted.current) stop.current?.abort(); }, 0);
    };
  }, []);

  useEffect(() => {
    if (!go || channel === null || started.current) return;
    started.current = true;
    const halt = new AbortController();
    stop.current = halt;
    const steps = stepsOf(action, request).length;
    setState({ step: 1, steps: Math.max(1, steps), relayed: 0, unconfirmed: 0 });
    void runAction({
      definition: action, request, channel, held: { identity, secret, ...(wallet === undefined ? {} : { wallet }), ...(account === undefined ? {} : { account }) }, stop: halt.signal, now,
      watch: (next) => { if (mounted.current) setState(next); },
      confirm: (lines, cut) => new Promise<boolean>((resolve) => {
        let answered = false;
        const answer = (yes: boolean): void => {
          if (answered) return;
          answered = true;
          if (mounted.current) setAsked(null);
          resolve(yes);
        };
        cut.addEventListener('abort', () => answer(false), { once: true });
        if (cut.aborted || !mounted.current) answer(false);
        else setAsked({ lines, answer });
      }),
    }).then((end) => {
      keepTheEnd(end);
      lock();
    }, () => {
      /* The runner answers whatever a definition does; should it still fail, the wallet locks all the same. */
      lock();
    });
  }, [go, channel, action, request, identity, secret, now, lock, wallet, account]);

  if (!go) {
    return (
      <>
        <h1 data-ask-window="act" data-headline>{t(action.headline, { origin: request.requester.origin })}</h1>
        <ActWhatItDoes request={request} action={action} shown={shown} />
        {payingFrom}
        <div className="flex flex-wrap gap-2" data-ask-actions>
          <Button
            size="lg" type="button" onClick={() => setPressed(true)} data-approve
            disabled={!consent.ok || channel === null || shown.of !== 'read'}
          >
            {t('ask.approve')}
          </Button>
          <Button size="lg" type="button" variant="ghost" onClick={onDecline} data-decline>{t('ask.decline')}</Button>
        </div>
        {!consent.ok && <p className="m-0 w-full text-sm text-muted-foreground" data-consent-refused>{consent.says}</p>}
      </>
    );
  }

  if (asked !== null) {
    const at = state ?? { step: 1, steps: Math.max(1, stepsOf(action, request).length) };
    return <ConfirmWhatWasRead lines={asked.lines} answer={asked.answer} framing={framing} step={at.step} steps={at.steps} />;
  }

  const steps = stepsOf(action, request);
  const at = state ?? { step: 1, steps: Math.max(1, steps.length), relayed: 0, unconfirmed: 0 };
  return (
    <>
      <h1 data-act-running data-headline>{t('act.running.title', { step: at.step, steps: at.steps })}</h1>
      <p className="lede">{t('act.running.lede')}</p>
      <ol className="m-0 ps-6" data-act-steps>
        {steps.map((step, i) => {
          const n = i + 1;
          const where = stepStateOf(step, n, at);
          return (
            <li key={i} className="text-sm" data-step={n} data-step-state={where}>
              {say(t, step.title)} <span className="text-muted-foreground">{t(`act.step.${where}`)}</span>
            </li>
          );
        })}
      </ol>
      <p className="m-0 text-sm" data-act-relayed>{t('act.relayed', { count: at.relayed })}</p>
      {at.unconfirmed > 0 && <p className="m-0 text-sm" data-act-unconfirmed>{t('act.over.unconfirmed', { count: at.unconfirmed })}</p>}
      <div className="sticky bottom-0 z-10 -mx-1 flex flex-col gap-2 border-t border-border bg-background px-1 py-3" data-ask-actions>
        <Button
          size="lg" type="button" variant="outline" data-act-stop disabled={stopping}
          onClick={() => { setStopping(true); stop.current?.abort(); }}
        >
          {t('act.stop')}
        </Button>
        <p className="m-0 text-sm text-muted-foreground">{t(stopping ? 'act.stopping' : 'act.stop-why')}</p>
      </div>
    </>
  );
}

/**
 * **THE CONFIRM OF WHAT A STEP READ WITH THE SEAT'S KEYS.** Its Confirm is held by the same guard as every Approve
 * (`useConsent`), measured afresh from the moment this question appears, so a framed wallet shown too small, hidden or
 * only just drawn cannot be confirmed unread. Stop stands where the running window's Stop stood, and Confirm below it,
 * so a press meant for Stop never lands on Confirm. Focus moves to the heading, never to a button, so a key pressed as
 * the question appears answers nothing.
 */
function ConfirmWhatWasRead({ lines, answer, framing, step, steps }: {
  readonly lines: readonly Words[]; readonly answer: (yes: boolean) => void; readonly framing: Framing; readonly step: number; readonly steps: number;
}): ReactNode {
  const t = useText();
  const consent = useConsent(framing, lines);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <>
      <h1 ref={heading} tabIndex={-1} data-act-confirm data-headline>{t('act.confirm.title')}</h1>
      <p className="lede" data-act-confirm-lede>{t('act.confirm.lede', { step, steps })}</p>
      <ul className="m-0 ps-6" data-act-read>
        {lines.map((line, i) => <li key={i} className="text-sm break-all" data-shown-from="wallet">{say(t, line)}</li>)}
      </ul>
      <div className="sticky bottom-0 z-10 -mx-1 flex flex-col gap-2 border-t border-border bg-background px-1 py-3" data-ask-actions>
        <Button size="lg" type="button" variant="outline" onClick={() => answer(false)} data-act-stop>{t('act.stop')}</Button>
        <Button size="lg" type="button" onClick={() => answer(true)} disabled={!consent.ok} data-act-confirm-button>{t('act.confirm.button')}</Button>
        <p className="m-0 text-sm text-muted-foreground">{t('act.confirm.stop-why')}</p>
        {!consent.ok && <p className="m-0 w-full text-sm text-muted-foreground" data-consent-refused>{consent.says}</p>}
      </div>
    </>
  );
}
