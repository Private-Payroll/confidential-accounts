import { Amount, PageHeader, Section, SectionRow, useText } from 'vaults-ui';
import { PAID, READ, type Paid, type ProposalRow, type RunCurrency, type RunRow } from '../adapters/company-records.js';
import { PAGE } from '../pages.js';
import { PageLink, useCurrentPage } from '../router.js';
import { Approvals, PaidWords, paymentKindOf, ReadOf, RunMoney, RunStatus, UnbuiltAction, useMonth, WithRecords } from '../records/parts.js';

/** The order a run's forms and its people are shown in: the private payments, then the public ones, then those whose form is not known. */
const FORM_ORDER: readonly Paid[] = [PAID.privately, PAID.publicly, PAID.notKnown, PAID.notSetUp];
const formRank = (paid: Paid): number => FORM_ORDER.indexOf(paid);

/**
 * A PAYROLL RUN'S OWN PAGE: its month and where it stands; for each token, in
 * a section of its own, one line for each way it is paid, side by side, each
 * with its label, its amount, its approvals and its own Approve, because the
 * private and the public payments of a token are approved separately; and
 * everyone it pays, the people paid privately together and then those paid
 * publicly, each with their amount and how they are paid. Approving and
 * exporting are not built yet and are shown disabled.
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
              if (run === undefined) return <p className="text-sm text-muted-foreground" data-no-run>{t('run.notFound')}</p>;
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
                        <TokenForms run={run} token={c} proposals={proposals} />
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
function TokenForms({ run, token, proposals }: { run: RunRow; token: RunCurrency; proposals: readonly ProposalRow[] | null }) {
  const t = useText();
  const ofToken = proposals?.filter((p) => p.pays?.asset === token.code) ?? [];
  const known = new Set<Paid>();
  if (token.privately !== null) known.add(PAID.privately);
  if (token.publicly !== null) known.add(PAID.publicly);
  const named = [...run.legs.filter((l) => l.asset === token.code).map((l) => l.paid), ...ofToken.map((p) => p.pays!.paid)];
  for (const paid of named) if (paid === PAID.privately || paid === PAID.publicly) known.add(paid);
  const single = known.size === 1;
  const forms = FORM_ORDER.filter((paid) => known.has(paid) || (paid === PAID.notKnown && !single && named.includes(PAID.notKnown)));
  /* The exact form's proposal first; one whose form is not known only for a token paid one way. */
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
          return (
            <div key={paid} className="flex flex-col gap-1.5 text-sm" data-round={paid}>
              <span className="text-xs text-muted-foreground" data-form-label>{label(paid)}</span>
              {amount === null ? null : <Amount value={amount} kind={paymentKindOf(run)} />}
              {proposals === null ? <span className="text-muted-foreground" data-unreadable>{t('run.approvalsUnreadable')}</span>
                : proposal === undefined ? <span className="text-muted-foreground" data-not-sent>{t('run.notSentForApproval')}</span> : <Approvals row={proposal} />}
              <div><UnbuiltAction variant="outline" size="sm" data-action="approve">{t('proposals.approve')}</UnbuiltAction></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
