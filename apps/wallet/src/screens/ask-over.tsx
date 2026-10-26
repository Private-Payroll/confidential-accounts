import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useText } from 'vaults-ui';
import { hrefOf } from '../routes.js';
import { StatusAlert } from '../components/status.js';
import type { EndedHere } from '../actions/ended-here.js';

/**
 * **WHAT THE WALLET SAYS ONCE A REQUEST HAS BEEN ANSWERED AND NOTHING MORE IS
 * COMING** - after Close, Do not pay, Do not show them or any other answer
 * that leaves nothing on screen. Saying it is still waiting for the request
 * would be false: the page has its answer, and this window will not be asked
 * again. Focus moves to the heading, so a person using a keyboard or a screen
 * reader is told where they are rather than left on the page's body.
 */
export function AskOver({ framed }: { readonly framed: boolean }): ReactNode {
  const t = useText();
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <>
      <h1 ref={heading} tabIndex={-1} data-ask-over>{t('ask.over.title')}</h1>
      <p className="lede">{t('ask.over.lede')}</p>
      <p className="m-0 text-sm text-muted-foreground">{t(framed ? 'ask.over.framed' : 'ask.over.close')}</p>
      {!framed && <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('home')}>&larr; {t('ask.over.home')}</a></p>}
    </>
  );
}

/**
 * What pressing again on the page does, for an action where it differs from carrying on: Create vault starts a new
 * vault, and putting money in again makes a new deposit.
 */
const CONTINUE: Readonly<Record<string, string>> = Object.freeze({
  'create-vault': 'act.create-vault.over.continue',
  'private-deposit': 'act.private-deposit.over.continue',
  'one-off-payment': 'act.one-off-payment.over.continue',
});

/**
 * An action that can end with what it proposed still awaiting other signers' approvals: that end is titled and told as
 * not carried out yet, with the approvals it has and needs, never as every step done.
 */
const AWAITING: Readonly<Record<string, string>> = Object.freeze({
  'one-off-payment': 'act.one-off-payment.over.awaiting',
});

/** The awaiting words for an end that is done with what it proposed still short of its approvals, else null. */
export const awaitingOf = (ended: EndedHere['ended']): { readonly key: string; readonly approvals: number; readonly needed: number } | null => {
  const o = ended.outcome;
  if (ended.ended !== 'done' || o === undefined || o['state'] !== 'awaiting-approvals') return null;
  if (!Object.prototype.hasOwnProperty.call(AWAITING, ended.intent)) return null;
  const { approvals, needed } = o;
  return typeof approvals === 'number' && typeof needed === 'number' ? { key: AWAITING[ended.intent]!, approvals, needed } : null;
};

/**
 * The stopped window's title. A check or step that did not hold is titled by what had left the wallet by then, from
 * the runner's own counts: no transaction handed to the page, transactions the page confirmed it handed over, or one
 * it did not confirm and may still send. Every other stop is titled by why it stopped.
 */
const titleOf = (ended: EndedHere['ended']): string => {
  if (ended.why !== 'check-failed') return `act.why.${ended.why ?? 'step-failed'}`;
  if (ended.unconfirmed > 0) return 'act.over.refused-maybe-sent';
  if (ended.relayed > 0) return 'act.over.refused-sent';
  return 'act.why.check-failed';
};

/**
 * **WHAT THE WALLET SAYS ONCE AN ACTION HAS ENDED**, done or stopped. A stopped
 * action is never said to be finished: it says the step it stopped at, why,
 * how many transactions the page confirmed it handed over, how many it was
 * handed and did not confirm, which may still land, and what pressing again on
 * the page does. The wallet has locked itself by now, and says so; when a step
 * was still running it says that step is cut off from the keys, never that its
 * work is over.
 */
export function ActOver({ end, framed }: { readonly end: EndedHere; readonly framed: boolean }): ReactNode {
  const t = useText();
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const { ended, says } = end;
  const stopped = ended.ended === 'stopped';
  const awaiting = awaitingOf(ended);
  return (
    <>
      <h1 ref={heading} tabIndex={-1} data-ask-over data-act-ended={ended.ended}>
        {stopped ? t('act.over.stopped-title', { step: ended.step, steps: ended.steps })
          : awaiting !== null ? t(`${awaiting.key}-title`) : t('act.over.done-title')}
      </h1>
      {stopped ? (
        <StatusAlert tone="warning" title={t(titleOf(ended))}>
          {says !== null && <p className="m-0" data-act-says>{t(says.key, { ...(says.values ?? {}) })}</p>}
          <p className="m-0" data-act-relayed>{t('act.over.relayed', { relayed: ended.relayed })}</p>
          {ended.unconfirmed > 0 && (
            <p className="m-0" data-act-unconfirmed>{t('act.over.unconfirmed', { count: ended.unconfirmed })}</p>
          )}
          <p className="m-0" data-act-continue>{t(Object.prototype.hasOwnProperty.call(CONTINUE, ended.intent) ? CONTINUE[ended.intent]! : 'act.over.continue')}</p>
        </StatusAlert>
      ) : awaiting !== null ? (
        <p className="lede" data-act-awaiting>{t(awaiting.key, { approvals: awaiting.approvals, needed: awaiting.needed })}</p>
      ) : (
        <p className="lede" data-act-relayed>{t('act.over.done', { steps: ended.steps, relayed: ended.relayed })}</p>
      )}
      <p className="m-0 text-sm text-muted-foreground" data-act-locked>
        {t(end.abandoned ? 'act.over.locked-cut-off' : 'act.over.locked')}
      </p>
      <p className="m-0 text-sm text-muted-foreground">{t(framed ? 'ask.over.framed' : 'ask.over.close')}</p>
    </>
  );
}
