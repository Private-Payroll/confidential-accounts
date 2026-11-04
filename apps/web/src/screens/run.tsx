import { Invoice01Icon } from '@hugeicons/core-free-icons';
import { Amount, Button, EmptyState, PageHeader, Section, SectionRow, useText } from 'vaults-ui';
import { Approve } from '../actions/approve.js';
import { PayRun } from '../actions/pay-run.js';
import { RetryRun } from '../actions/retry-run.js';
import { Withdraw } from '../actions/withdraw.js';
import { canApprove, canPay, canRetry, canWithdraw, legOfRetry, PAID, PAID_STATE, READ, type CompanyRecords, type Paid, type ProposalRow, type Read, type RunCurrency, type RunLeg, type RunRow } from '../adapters/company-records.js';
import { PAGE } from '../pages.js';
import { PageLink, useCurrentPage } from '../router.js';
import { Approvals, PaidWords, paymentKindOf, ReadOf, RunMoney, RunStatus, UnbuiltAction, useMonth, WithRecords } from '../records/parts.js';
import { usePanel } from '../shell/right-panel.js';

/** The order a run's forms and its people are shown in: the private payments, then the public ones, then those whose form is not known. */
const FORM_ORDER: readonly Paid[] = [PAID.privately, PAID.publicly, PAID.notKnown, PAID.notSetUp];
const formRank = (paid: Paid): number => FORM_ORDER.indexOf(paid);

/**
 * A PAYROLL RUN'S OWN PAGE: its month and where it stands; for each token, in
 * a section of its own, one line for each way it is paid, side by side, each
 * with its label, its amount, its approvals, what the chain shows paid of it
 * and its own Approve, Withdraw and Pay, because the private and the public
 * payments of a token are approved separately; and everyone it pays, the
 * people paid privately together and then those paid publicly, each with their
 * amount and how they are paid. Whether a run is paid is read on this device
 * from the chain, never from the service's status. Exporting is not built yet
 * and is shown disabled.
 */
export function Run() {
  const t = useText();
  const month = useMonth();
  const { params } = useCurrentPage();
  return (
    <div className="flex flex-col gap-6" data-screen="run">
      <PageLink to={PAGE.payroll} className="text-sm text-muted-foreground underline-offset-4 hover:underline">{t('run.back')}</PageLink>
      <WithRecords>
        {(records) => (
          <ReadOf read={records.runs}>
            {(runs) => {
              const run = runs.find((r) => r.id === params.run);
              if (run === undefined) return <EmptyState icon={Invoice01Icon}>{t('run.notFound')}</EmptyState>;
              /* Null when the proposals could not be read: then no payments are said to be unsent. */
              const proposals = records.proposals.of === READ.read ? records.proposals.value.filter((p) => p.pays?.run === run.id) : null;
              const publicly = run.payees.filter((p) => p.paid === PAID.publicly).length;
              const payees = [...run.payees].sort((a, b) => formRank(a.paid) - formRank(b.paid));
              return (
                <>
                  <PageHeader
                    title={<span data-run={run.id}>{month(run.period)}</span>}
                    description={<RunStatus run={run} />}
                    actions={<UnbuiltAction data-action="export-run">{t('run.export')}</UnbuiltAction>}
                  />
                  {publicly > 0 ? <p className="max-w-prose text-sm" data-public-payees>{t('run.publicPayees', { count: publicly })}</p> : null}
                  <div className="flex flex-col gap-4" data-part="currencies">
                    {run.currencies.map((c) => (
                      <Section key={c.code} title={t('run.currency', { token: c.symbol })} list={false} data-currency={c.code}>
                        <TokenForms run={run} token={c} proposals={proposals} records={records} />
                      </Section>
                    ))}
                    {run.unrecognised === 0 ? null : <RunMoney run={{ ...run, currencies: [] }} />}
                  </div>
                  <Section title={t('run.whoIsPaid')} empty={null} data-part="payees">
                    {payees.map((p) => (
                      <SectionRow key={p.id} data-payee={p.id}>
                        <span>{p.name}</span>
                        <span>{p.amount === null ? t('records.unrecognisedOne') : <Amount value={p.amount} kind={paymentKindOf(run)} />}</span>
                        <span className="text-muted-foreground"><PaidWords paid={p.paid} /></span>
                      </SectionRow>
                    ))}
                  </Section>
                </>
              );
            }}
          </ReadOf>
        )}
      </WithRecords>
    </div>
  );
}

/**
 * ONE TOKEN OF A RUN, ONE LINE FOR EACH WAY IT IS PAID. A run's approvals are
 * per leg, one token in one form, so the forms with a line are those the
 * run's legs and its proposals name, and those its people's addresses add up
 * to. A leg written before a run paid one form is put on the token's one form
 * when it has only one, and on a line of its own otherwise, so its approvals
 * are never said of payments they do not cover.
 */
function TokenForms({ run, token, proposals, records }: { run: RunRow; token: RunCurrency; proposals: readonly ProposalRow[] | null; records: CompanyRecords }) {
  const t = useText();
  const retried = new Set(run.legs.flatMap((l) => (l.retries ?? []).map((r) => r.proposal)));
  const ofToken = proposals?.filter((p) => p.pays?.asset === token.code && !retried.has(p.id)) ?? [];
  const known = new Set<Paid>();
  if (token.privately !== null) known.add(PAID.privately);
  if (token.publicly !== null) known.add(PAID.publicly);
  const named = [...run.legs.filter((l) => l.asset === token.code).map((l) => l.paid), ...ofToken.map((p) => p.pays!.paid)];
  for (const paid of named) if (paid === PAID.privately || paid === PAID.publicly) known.add(paid);
  const single = known.size === 1;
  const forms = FORM_ORDER.filter((paid) => known.has(paid) || (paid === PAID.notKnown && !single && named.includes(PAID.notKnown)));

  const proposalOf = (paid: Paid): ProposalRow | undefined => ofToken.find((p) => p.pays!.paid === paid)
    ?? (single && paid !== PAID.notKnown ? ofToken.find((p) => p.pays!.paid === PAID.notKnown) : undefined);
  const amountOf = (paid: Paid) => (paid === PAID.privately ? token.privately : paid === PAID.publicly ? token.publicly : null);
  const label = (paid: Paid) => (paid === PAID.privately ? t('payroll.runTotal.privately') : paid === PAID.publicly ? t('payroll.runTotal.publicly') : <PaidWords paid={paid} />);
  return (
    <div className="flex flex-col gap-3">
      {known.has(PAID.privately) && known.has(PAID.publicly) ? <p className="max-w-prose text-sm" data-paid-both-ways>{t('run.paidBothWays', { token: token.symbol })}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {forms.map((paid) => {
          const amount = amountOf(paid);
          const proposal = proposalOf(paid);
          const leg = proposal === undefined ? undefined : run.legs.find((l) => l.proposal === proposal.id);
          return (
            <div key={paid} className="flex flex-col gap-1.5 text-sm" data-round={paid}>
              <span className="text-xs text-muted-foreground" data-form-label>{label(paid)}</span>
              {amount === null ? null : <Amount value={amount} kind={paymentKindOf(run)} />}
              {proposals === null ? <span className="text-muted-foreground" data-unreadable>{t('run.approvalsUnreadable')}</span>
                : proposal === undefined ? <span className="text-muted-foreground" data-not-sent>{t('run.notSentForApproval')}</span> : <Approvals row={proposal} />}
              {leg === undefined ? null : <PaidOnChain state={leg.paidOnChain} />}
              <Acts run={run} records={records} proposal={proposal} leg={leg} />
              {leg === undefined ? null : (leg.retries ?? []).map((retry) => (
                <RetryOf key={retry.proposal ?? ''} run={run} records={records} proposals={proposals} leg={legOfRetry(leg, retry)} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** What the chain shows of a leg's payments, read on this device: never the service's word for it. */
function PaidOnChain({ state }: { state: RunLeg['paidOnChain'] }) {
  const t = useText();
  const says = state === PAID_STATE.all ? t('run.legPaid.inFull') : state === PAID_STATE.some ? t('run.legPaid.inPart') : state === PAID_STATE.none ? t('run.legPaid.notSeen') : t('run.legPaid.unread');
  return <span className="text-muted-foreground" data-leg-paid={state ?? ''}>{says}</span>;
}

/** An attempt at a leg for some of its people, raised as a proposal of its own: said with its approvals, what the chain shows paid, and the same presses. */
function RetryOf({ run, records, proposals, leg }: { run: RunRow; records: CompanyRecords; proposals: readonly ProposalRow[] | null; leg: RunLeg }) {
  const t = useText();
  const proposal = proposals?.find((p) => p.id === leg.proposal);
  return (
    <div className="flex flex-col gap-1.5 border-t pt-1.5" data-retry={leg.proposal ?? ''}>
      <span className="text-xs text-muted-foreground">{t('run.retry', { count: leg.people })}</span>
      {proposal === undefined ? null : <Approvals row={proposal} />}
      <PaidOnChain state={leg.paidOnChain} />
      <Acts run={run} records={records} proposal={proposal} leg={leg} />
    </div>
  );
}

/**
 * THE PRESSES ON A PROPOSAL OF A RUN: Approve, Withdraw and Pay, each opening the shell's panel, where the one action
 * the person presses runs and its answer stays through the records being read again. Each is offered by the page's own
 * rule for it (`canApprove`, `canWithdraw`, `canPay`), and a Retry of the people the chain shows unpaid once the leg can no longer
 * pay them (`canRetry`); the wallet decides again before it signs anything.
 */
function Acts({ run, records, proposal, leg }: { run: RunRow; records: CompanyRecords; proposal: ProposalRow | undefined; leg: RunLeg | undefined }) {
  const t = useText();
  const month = useMonth();
  const panel = usePanel();
  if (proposal === undefined) return null;
  const vaults: Read<readonly { readonly vault: string }[]> = records.vaults;
  const number = vaults.of === READ.read ? vaults.value.findIndex((v) => v.vault.toLowerCase() === leg?.vault.toLowerCase()) + 1 : 0;
  const pay = leg !== undefined && number > 0 && canPay(leg, records.proposals);
  const retry = leg !== undefined && canRetry(leg, records.proposals, Date.now());
  return (
    <div className="flex flex-wrap gap-2">
      {!canApprove(proposal) ? null : (
        <Button size="sm" variant="outline" data-action="approve" onClick={() => panel.open({ title: t('run.approve.title', { month: month(run.period) }), body: <Approve row={proposal} /> })}>
          {t('proposals.approve')}
        </Button>
      )}
      {!canWithdraw(proposal) ? null : (
        <Button size="sm" variant="outline" data-action="withdraw" onClick={() => panel.open({ title: t('run.withdraw.title', { month: month(run.period) }), body: <Withdraw row={proposal} /> })}>
          {t('proposals.withdraw')}
        </Button>
      )}
      {!retry || leg === undefined ? null : (
        <Button size="sm" variant="outline" data-action="retry-run" onClick={() => panel.open({ title: t('run.retry.title', { month: month(run.period) }), body: <RetryRun run={run} leg={leg} /> })}>
          {t('run.retry.button')}
        </Button>
      )}
      {!pay ? null : (
        <Button size="sm" variant="outline" data-action="pay-run" data-pay-leg={leg.code}
          onClick={() => panel.open({ title: t('payRun.title', { month: month(run.period) }), body: <PayRun run={run} leg={leg} vaultName={t('vaults.tile.name', { number })} /> })}>
          {t('run.pay')}
        </Button>
      )}
    </div>
  );
}
