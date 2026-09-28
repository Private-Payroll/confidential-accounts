import { Amount, useText } from 'vaults-ui';
import { PAID, READ } from '../adapters/company-records.js';
import { PAGE } from '../pages.js';
import { PageLink, useCurrentPage } from '../router.js';
import { Approvals, PaidWords, paymentKindOf, ReadOf, RunMoney, RunStatus, SoonAction, useMonth, WithRecords } from '../records/parts.js';

/**
 * A PAYROLL RUN'S OWN PAGE: its month and where it stands; for each currency,
 * what it pays privately and publicly and the approvals so far; and everyone
 * it pays, each with their amount and whether they are paid privately or
 * publicly. Approving is shown, and is Coming soon.
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
                  <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-semibold" data-run={run.id}>{month(run.period)}</h1>
                    <RunStatus run={run} />
                  </div>
                  {publicly > 0 ? <p className="max-w-prose text-sm" data-public-payees>{t('run.publicPayees', { count: publicly })}</p> : null}
                  <section className="flex flex-col gap-3" data-part="currencies">
                    {run.currencies.map((c) => {
                      const proposal = proposals?.find((p) => p.pays?.currency === c.code);
                      return (
                        <div key={c.code} className="flex flex-col gap-2 rounded-lg border p-4" data-currency={c.code}>
                          <h2 className="font-medium">{t('run.currency', { currency: c.code })}</h2>
                          <RunMoney run={{ ...run, currencies: [c], unrecognised: 0 }} />
                          <div className="flex flex-wrap items-center gap-3 text-sm">
                            {proposals === null ? <span className="text-muted-foreground" data-unreadable>{t('run.approvalsUnreadable')}</span>
                              : proposal === undefined ? <span className="text-muted-foreground" data-not-sent>{t('run.notSentForApproval')}</span> : <Approvals row={proposal} />}
                            <SoonAction label={t('proposals.approve')} soon={t('proposals.approve.soon')} data-action="approve" />
                          </div>
                        </div>
                      );
                    })}
                    {run.unrecognised === 0 ? null : <RunMoney run={{ ...run, currencies: [] }} />}
                  </section>
                  <section className="flex flex-col gap-2" data-part="payees">
                    <h2 className="font-medium">{t('run.whoIsPaid')}</h2>
                    <table className="w-full text-sm">
                      <tbody>
                        {run.payees.map((p) => (
                          <tr key={p.id} className="border-t" data-payee={p.id}>
                            <td className="py-2">{p.name}</td>
                            <td className="py-2">{p.amount === null ? t('records.unrecognisedOne') : <Amount value={p.amount} kind={paymentKindOf(run)} />}</td>
                            <td className="py-2 text-muted-foreground"><PaidWords paid={p.paid} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                  <SoonAction label={t('run.export')} soon={t('run.export.soon')} data-action="export-run" />
                </>
              );
            }}
          </ReadOf>
        )}
      </WithRecords>
    </div>
  );
}
