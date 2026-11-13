import { Alert, AlertDescription, Button, useText } from 'vaults-ui';
import { policyPeriodOf, type ChangeCost, type ChangeHolders, type PublicFact } from '../adapters/policy-acts.js';

/*
 * WHAT A SPENDING POLICY CHANGE COSTS AND REVEALS, SHOWN BEFORE IT IS SAVED. Every figure comes from `whatAChangeCosts`, which reads the
 * account's approvals, bars and seats as the person's own wallet read them off the network: how many approvals the change needs and what sets
 * that number, the warnings a change of that kind earns, and exactly what it makes public. Nothing here judges who may make the change; that is
 * the wallet's to say when it is asked.
 */

type Words = ReturnType<typeof useText>;

/** Which change a review is of: a spending policy, or the policy bar. Compared by the code and set as a mark tests find it by. */
export const REVIEW_OF = { policy: 'policy', bar: 'bar' } as const;

/** How long a period is: one of the lengths a policy is offered in, named, or any other length as the policy holds it, in days. */
export function usePeriodSaid(): (seconds: bigint) => string {
  const t = useText();
  return (seconds) => {
    const named = policyPeriodOf(seconds);
    if (named.id === null) return t('policies.period.days', { days: named.days, count: named.days });
    switch (named.id) {
      case 'week': return t('policies.period.week');
      case 'two-weeks': return t('policies.period.two-weeks');
      case 'four-weeks': return t('policies.period.four-weeks');
      case 'year': return t('policies.period.year');
    }
  };
}

function PublicFactSays({ fact, t }: { fact: PublicFact; t: Words }) {
  switch (fact.fact) {
    case 'policy-bar': return <p data-public-fact={fact.fact}>{t('policies.review.public.bar', { value: fact.value })}</p>;
    case 'highest-band': return <p data-public-fact={fact.fact}>{t('policies.review.public.highest-band', { value: fact.value })}</p>;
    case 'vault-has-a-policy': return <p data-public-fact={fact.fact}>{t('policies.review.public.vault-has-a-policy')}</p>;
    case 'approval-count': return <p data-public-fact={fact.fact}>{t('policies.review.public.approval-count')}</p>;
    default: return null;
  }
}

interface ChangeReviewProps {
  readonly cost: ChangeCost;
  readonly held: ChangeHolders;
  /** A policy for one vault, or the bar for the whole company. */
  readonly kind: (typeof REVIEW_OF)[keyof typeof REVIEW_OF];
  /** How the vault the number is set by is called on this page, when it is one the page lists. */
  readonly vaultCalled: (vault: string) => string | null;
  /** The period length chosen, said beside the policy being saved. */
  readonly period?: string;
  readonly busy: boolean;
  readonly onConfirm: () => void;
}

/**
 * The review before a save: the approvals the change needs and what sets them, a warning for each way it can lock the company in, what it makes
 * public and what stays hidden, and, for a policy, that its period total starts again. The save is the one press at the end of it.
 */
export function ChangeReview({ cost, held, kind, vaultCalled, period, busy, onConfirm }: ChangeReviewProps) {
  const t = useText();
  const after = cost.barRaisedTo ?? cost.barLoweredTo ?? held.seatBar;
  const staysRaised = cost.barRaisedTo === undefined && after > held.approvals;
  const because = cost.because === 'account' ? t('policies.review.because.account')
    : cost.because === 'policy-bar' ? t('policies.review.because.bar')
      : t('policies.review.because.vault', { vault: vaultCalled(cost.because.vault) ?? t('policies.review.aVault') });
  return (
    <div className="flex flex-col gap-3 text-sm" data-review={kind}>
      <p className="font-medium">{t('policies.review.heading')}</p>
      <p data-needs={cost.needed}>{t('policies.review.needs', { count: cost.needed })} <span data-because>{because}</span></p>
      {period === undefined ? null : <p data-review-period>{t('policies.review.period', { period })}</p>}
      {!cost.everySigner ? null : (
        <Alert variant="destructive" data-warning="every-signer">
          <AlertDescription>{t('policies.warn.every-signer', { seated: held.seated })}</AlertDescription>
          {kind === REVIEW_OF.policy ? <AlertDescription>{t('policies.warn.every-signer.runs')}</AlertDescription> : null}
        </Alert>
      )}
      {cost.barRaisedTo === undefined ? null : <Alert data-warning="bar-raised"><AlertDescription>{t('policies.warn.bar-raised', { bar: cost.barRaisedTo })}</AlertDescription></Alert>}
      {cost.barLoweredTo === undefined ? null : <Alert data-warning="bar-lowered"><AlertDescription>{t('policies.warn.bar-lowered', { bar: cost.barLoweredTo })}</AlertDescription></Alert>}
      {!staysRaised ? null : (
        <Alert data-warning="bar-stays"><AlertDescription>{t('policies.warn.bar-stays', { bar: after, approvals: held.approvals })}</AlertDescription></Alert>
      )}
      <div className="flex flex-col gap-1" data-public>
        <p className="font-medium">{t('policies.review.public.heading')}</p>
        <div className="flex flex-col gap-1">{cost.publicFacts.map((f) => <PublicFactSays key={f.fact} fact={f} t={t} />)}</div>
        {kind === REVIEW_OF.policy ? <p className="text-muted-foreground" data-hidden>{t('policies.review.hidden')}</p> : null}
      </div>
      {kind === REVIEW_OF.policy ? <p data-reset-confirmation>{t('policies.review.reset')}</p> : null}
      <div>
        <Button type="button" disabled={busy} data-action={kind === REVIEW_OF.policy ? 'confirm-policy' : 'confirm-bar'} onClick={onConfirm}>{t('policies.review.confirm')}</Button>
      </div>
    </div>
  );
}
