import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Section, useText } from 'vaults-ui';
import type { Identity, Secret } from 'midnight-identity/keys/derivation';
import type { ActRequest } from 'midnight-identity/profile/request';
import type { ActingChannel } from 'midnight-identity/profile/channel';
import { StatusAlert } from '../components/status.js';
import { useSession } from '../session.js';
import type { Consent } from '../framing.js';
import type { ActionDefinition, ActionStep, ShownLine, WalletRecord, Words } from './definition.js';
import { keepTheEnd } from './ended-here.js';
import { runAction } from './run.js';
import type { RunState } from './run.js';

/**
 * THE SCREEN AN ACTION RUNS ON, AND WHAT ITS WINDOW SHOWS BEFORE THE PASSKEY.
 *
 * Before: what the action acts on, each line marked as this wallet's own read
 * or only the page's words, and the action's own account of what it does left
 * unmarked; its steps; and what is checked after the passkey.
 * While it runs: the steps, the one running, how many transactions the page
 * has handed over, and Stop, there at every step and held by no check on what
 * can be seen. Nothing waits for another press once it runs. When it ends, the
 * wallet locks itself, so the keys the passkey opened are held no longer than
 * the action.
 */

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
      {action.checks.length > 0 && (
        <Section
          list={false} box={false} aria-label={t('ask.act.checks-title')} title={t('ask.act.checks-title')}
          description={t('ask.act.checks-why')}
        >
          <ul className="m-0 ps-6" data-checked-after-the-passkey>
            {action.checks.map((check, i) => <li key={i} className="text-sm">{say(t, check)}</li>)}
          </ul>
        </Section>
      )}
    </>
  );
}

/**
 * RUNS AN APPROVED ACTION. `atOnce` is the Approve pressed in the window before
 * the passkey: the action starts as soon as the wallet is open, with no second
 * press. Without it (the wallet was already open when the ask came) this shows
 * what the action does and an Approve of its own, held by the same check on
 * what can be seen as every Approve.
 */
export function ActionRunner({
  request, action, channel, identity, secret, consent, atOnce, onDecline, now = Date.now, wallet, account, payingFrom,
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
}): ReactNode {
  const t = useText();
  const { lock } = useSession();
  const shown = useShown(request, action);
  const [pressed, setPressed] = useState(false);
  const [state, setState] = useState<RunState | null>(null);
  const [stopping, setStopping] = useState(false);
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

  const steps = stepsOf(action, request);
  const at = state ?? { step: 1, steps: Math.max(1, steps.length), relayed: 0, unconfirmed: 0 };
  return (
    <>
      <h1 data-act-running data-headline>{t('act.running.title', { step: at.step, steps: at.steps })}</h1>
      <p className="lede">{t('act.running.lede')}</p>
      <ol className="m-0 ps-6" data-act-steps>
        {steps.map((step, i) => {
          const n = i + 1;
          const where = n < at.step ? 'done' : n === at.step ? 'running' : 'waiting';
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
