import { Amount, PageHeader, Section, SectionRow, useText } from 'vaults-ui';
import { PAID, READ } from '../adapters/company-records.js';
import { PAGE } from '../pages.js';
import { PageLink, useCurrentPage } from '../router.js';
import { Approvals, PaidWords, paymentKindOf, ReadOf, RunMoney, RunStatus, UnbuiltAction, useMonth, WithRecords } from '../records/parts.js';

/**
 * A PAYROLL RUN'S OWN PAGE: its month and where it stands; for each currency,
 * in a section of its own, what it pays privately and publicly and the
 * approvals so far; and everyone it pays, each with their amount and whether
 * they are paid privately or publicly. Approving and exporting are not built
 * yet and are shown disabled.
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
              /* Null when the proposals could not be read: then no currency is said to be unsent. */
              const proposals = records.proposals.of === READ.read ? records.proposals.value.filter((p) => p.pays?.run === run.id) : null;
              const publicly = run.payees.filter((p) => p.paid === PAID.publicly).length;
              return (
                <>
                  <PageHeader
                    title={<span data-run={run.id}>{month(run.period)}</span>}
                    description={<RunStatus run={run} />}
                    actions={<UnbuiltAction data-action="export-run">{t('run.export')}</UnbuiltAction>}
                  />
                  {publicly > 0 ? <p className="max-w-prose text-sm" data-public-payees>{t('run.publicPayees', { count: publicly })}</p> : null}
                  <div className="flex flex-col gap-4" data-part="currencies">
                    {run.currencies.map((c) => {
                      const proposal = proposals?.find((p) => p.pays?.currency === c.code);
                      return (
                        <Section
                          key={c.code}
                          title={t('run.currency', { currency: c.code })}
                          actions={<UnbuiltAction data-action="approve">{t('proposals.approve')}</UnbuiltAction>}
                          list={false}
                          data-currency={c.code}
                        >
                          <RunMoney run={{ ...run, currencies: [c], unrecognised: 0 }} />
                          <div className="text-sm">
                            {proposals === null ? <span className="text-muted-foreground" data-unreadable>{t('run.approvalsUnreadable')}</span>
                              : proposal === undefined ? <span className="text-muted-foreground" data-not-sent>{t('run.notSentForApproval')}</span> : <Approvals row={proposal} />}
                          </div>
                        </Section>
                      );
                    })}
                    {run.unrecognised === 0 ? null : <RunMoney run={{ ...run, currencies: [] }} />}
                  </div>
                  <Section title={t('run.whoIsPaid')} empty={null} data-part="payees">
                    {run.payees.map((p) => (
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
