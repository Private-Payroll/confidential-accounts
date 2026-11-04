import { useState, type ReactNode } from 'react';
import { Alert, AlertDescription, useText } from 'vaults-ui';
import { PROPOSAL_ACTED, WHY, type ProposalActed, type ProposalWhy } from '../adapters/proposal-acts.js';
import { ActRefused } from '../act-refused.js';
import type { ActRefusal } from '../adapters/refusals.js';
import { useSession } from '../session.js';
import { useCompanyRecords } from './company-records.js';

/** How far a wallet act has got: which step of how many (both 0 until the wallet says). */
export type ActStep = { readonly step: number; readonly steps: number };
export type ActPhase = ActStep | null;


/** One wallet act on one proposal: whether it is running (and at which step), what it ended as, and the press that starts it, which reads the records again when the act may have changed them. */
export function useProposalAct(): {
  readonly phase: ActPhase; readonly result: ProposalActed | null; readonly done: boolean;
  readonly start: (act: (personId: string, companyId: string, onStep: (step: number, steps: number) => void) => Promise<ProposalActed>) => void;
} {
  const { person, company } = useSession();
  const { reload } = useCompanyRecords();
  const [phase, setPhase] = useState<ActPhase>(null);
  const [result, setResult] = useState<ProposalActed | null>(null);
  const start = (act: (personId: string, companyId: string, onStep: (step: number, steps: number) => void) => Promise<ProposalActed>): void => {
    if (company === null || phase !== null) return;
    setResult(null);
    setPhase({ step: 0, steps: 0 });
    void act(person.id, company, (step, steps) => setPhase({ step, steps })).then((ended) => {
      setPhase(null);
      setResult(ended);
      if (ended.of === PROPOSAL_ACTED.done || (ended.of === PROPOSAL_ACTED.stopped && (ended.partial || ended.handedOver))) reload();
    });
  };
  return { phase, result, done: result?.of === PROPOSAL_ACTED.done, start };
}


function useWhySays(own: Partial<Record<ProposalWhy, string>>): Record<ProposalWhy, string> {
  const t = useText();
  return {
    [WHY.seat]: t('proposal.act.why.seat'), [WHY.notAProposal]: t('proposal.act.why.not-a-proposal'), [WHY.notApproved]: t('proposal.act.why.not-approved'),
    [WHY.alreadyCounted]: t('proposal.act.why.already-counted'), [WHY.carriedOut]: t('proposal.act.why.carried-out'), [WHY.withdrawn]: t('proposal.act.why.withdrawn'),
    [WHY.mayBeSent]: t('proposal.act.why.may-be-sent'), [WHY.stopped]: t('signers.why.stopped'), [WHY.other]: t('proposal.act.why.other'),
    [WHY.notAsShown]: t('proposal.act.why.not-as-shown'), [WHY.closed]: t('proposal.act.why.closed'), [WHY.notRaised]: t('proposal.act.why.not-raised'),
    [WHY.outrun]: t('proposal.act.why.outrun'), [WHY.oneOffHeld]: t('proposal.act.why.other'), [WHY.notWithdrawn]: t('proposal.act.why.other'),
    ...own,
  };
}


type DataMarks = { readonly [mark: `data-${string}`]: string | boolean };

/**
 * WHAT A WALLET ACT IS DOING AND WHAT IT ENDED AS, IN ONE PLACE: working, refused, or what the act's own screen says it
 * ended as (`children`: an `ActDone` or an `ActStopped`). It is a polite live region (the status role is polite) that is always on the page, empty
 * until the act starts, so a screen reader hears the words arrive; a region that appears with its words already in it
 * is often not read out.
 */
export function ActOutcome({ phase, refused = null, children }: { phase: ActPhase; refused?: ActRefusal | null; children?: ReactNode }) {
  const t = useText();
  return (
    <div role="status" className="flex flex-col gap-2 empty:hidden" data-act-outcome>
      {phase !== null ? (
        <p className="text-sm text-muted-foreground" data-working>{phase.steps > 0 ? t('signers.working.step', { step: phase.step, steps: phase.steps }) : t('signers.working')}</p>
      ) : refused !== null ? <ActRefused why={refused} /> : children}
    </div>
  );
}

/** What a finished act says, marked for what it did; `next` is a second line saying what happens next. */
export function ActDone({ next, children, ...marks }: { next?: ReactNode; children: ReactNode } & DataMarks) {
  return (
    <>
      <p className="text-sm" {...marks}>{children}</p>
      {next === undefined || next === null ? null : <p className="text-sm text-muted-foreground" data-next-steps>{next}</p>}
    </>
  );
}

/** A stop, one `AlertDescription` a line: `calm` when the wallet had handed something over or part of it was done, so it is not told as a failure. */
export function ActStopped({ calm, children, ...marks }: { calm: boolean; children: ReactNode } & DataMarks) {
  return <Alert variant={calm ? 'default' : 'destructive'} {...marks}>{children}</Alert>;
}


/**
 * What a wallet act on a proposal is doing while it runs, and what it ended as, in words; `done` is what a finished act
 * says, and `own` the words for reasons only this act has. Only a stop the wallet says may have sent part of it, or one
 * that handed transactions over, is told as anything but a refusal that sent nothing.
 */
export function ActedSays({ phase, result, done, own = {} }: { phase: ActPhase; result: ProposalActed | null; done: string; own?: Partial<Record<ProposalWhy, string>> }) {
  const t = useText();
  const whySays = useWhySays(own);
  const stopped = result?.of === PROPOSAL_ACTED.stopped ? result : null;
  const ended = result?.of === PROPOSAL_ACTED.done ? result : null;
  return (
    <ActOutcome phase={phase} refused={result?.of === PROPOSAL_ACTED.refused ? result.why : null}>
      {ended === null ? null : (
        <ActDone data-acted>
          {done}
          {ended.approvals !== null && ended.needed !== null ? <> {t('proposal.act.counted', { approvals: ended.approvals, needed: ended.needed })}</> : null}
        </ActDone>
      )}
      {stopped === null ? null : (
        <ActStopped calm={stopped.partial || stopped.handedOver} data-proposal-stopped={stopped.why}>
          <AlertDescription>{stopped.handedOver && !stopped.partial ? t('signers.sent') : whySays[stopped.why]}</AlertDescription>
          {stopped.partial ? <AlertDescription data-partial>{t('signers.partial')}</AlertDescription> : null}
        </ActStopped>
      )}
    </ActOutcome>
  );
}
