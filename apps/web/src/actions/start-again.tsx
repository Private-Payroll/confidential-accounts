import { useState, useSyncExternalStore } from 'react';
import { Alert, AlertDescription, Button, ConfirmInYourAccount, useText } from 'vaults-ui';
import { ACTED, refusalOf, type ActRefusal } from '../adapters/refusals.js';
import { AGAIN, startAgain, type StartedOver } from '../adapters/start-again.js';
import { lane } from '../adapters/sends.js';
import { ActRefused } from '../act-refused.js';
import { useSession } from '../session.js';

/*
 * What the last press of Start it again came to. It is kept here, outside the component, so a screen that is drawn
 * again (the creation steps look at the chain every few seconds and swap what they show) or drawn anew still says it.
 */
/** What the last press came to, compared by the code and never shown; each is turned into words by its key. */
const NOW = { queued: 'queued', working: 'working', cancelled: 'cancelled', came: 'came' } as const;

export type Said =
  | { of: typeof NOW.queued; companyId: string | null }
  | { of: typeof NOW.working; companyId: string | null }
  | { of: typeof NOW.cancelled; companyId: string | null }
  | { of: typeof NOW.came; companyId: string | null; came: StartedOver };

let said: Said | null = null;
const listeners = new Set<() => void>();
function say(next: Said | null): void {
  said = next;
  for (const l of [...listeners]) l();
}
function watch(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
const nowSaid = (): Said | null => said;

/** Forgets what was said (the person has gone on to a new company). */
export function forgetWhatStartAgainSaid(): void { say(null); }

const sendIsGoingOut = (): boolean => lane.carrying !== null || lane.pressing !== null || lane.holding !== null;

export function StartAgain({ companyId }: { companyId: string | null }) {
  const t = useText();
  const { person } = useSession();
  const [asking, setAsking] = useState(false);
  const now = useSyncExternalStore(watch, nowSaid, nowSaid);
  const busy = now !== null && (now.of === NOW.queued || now.of === NOW.working);

  const confirm = async (): Promise<void> => {
    setAsking(false);
    say({ of: sendIsGoingOut() ? NOW.queued : NOW.working, companyId });
    let came: StartedOver;
    try {
      came = await startAgain(person.id, companyId);
    } catch (e) {
      came = { of: ACTED.refused, why: refusalOf(e) };
    }
    say({ of: NOW.came, companyId, came });
  };
  const cancel = (): void => {
    setAsking(false);
    say({ of: NOW.cancelled, companyId });
  };

  return (
    <div className="flex flex-col gap-2" data-start-again>
      {asking ? (
        <ConfirmInYourAccount summary={t('setup.again.confirm')} onConfirm={() => { void confirm(); }} onCancel={cancel} busy={busy} />
      ) : (
        <div><Button variant="outline" disabled={busy} onClick={() => { say(null); setAsking(true); }} data-action="start-again">{t('setup.createCompany.again')}</Button></div>
      )}
    </div>
  );
}

/**
 * The words for what the press of Start it again did, or why it could not. Drawn once by the screen that offers the
 * button, so they stay when the part of the screen that holds the button is swapped for another. Said for the company
 * `shown` is the one the screen is on; a company set aside or never kept is said whichever company the screen is on.
 */
export function StartAgainWords({ shown, onStartNew }: { shown: string | null; onStartNew?: () => void }) {
  const t = useText();
  const now = useSyncExternalStore(watch, nowSaid, nowSaid);
  if (now === null) return null;
  const ended = now.of === NOW.came && (now.came.of === ACTED.done || now.came.of === AGAIN.nothing);
  if (!ended && now.companyId !== shown) return null;

  let words: string | null = null;
  let why: ActRefusal | null = null;
  let over = false;
  if (now.of === NOW.queued) words = t('setup.again.queued');
  else if (now.of === NOW.working) words = t('setup.again.working');
  else if (now.of === NOW.cancelled) words = t('setup.again.cancelled');
  else if (now.came.of === ACTED.done) { words = t('setup.again.dropped'); over = true; }
  else if (now.came.of === AGAIN.nothing) { words = t('setup.again.nothing'); over = true; }
  else if (now.came.of === AGAIN.landed) words = t('setup.again.landed');
  else if (now.came.of === AGAIN.wait) words = t('setup.again.wait', { minutes: now.came.minutes });
  else if (now.came.of === ACTED.refused) why = now.came.why;
  else words = t('setup.again.unsure');

  return (
    <div className="flex flex-col gap-2" data-start-again-said={now.of === NOW.came ? now.came.of : now.of}>
      {words === null ? null : <Alert data-start-again-kept><AlertDescription>{words}</AlertDescription></Alert>}
      {why === null ? null : <ActRefused why={why} />}
      {over && onStartNew !== undefined ? (
        <div><Button onClick={() => { forgetWhatStartAgainSaid(); onStartNew(); }} data-action="start-new-company">{t('setup.again.new')}</Button></div>
      ) : null}
    </div>
  );
}
