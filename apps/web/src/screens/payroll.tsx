import type { ReactNode } from 'react';
import { useText } from 'vaults-ui';
import { PAGE } from '../pages.js';
import { PageLink } from '../router.js';
import { ReadOf, RunMoney, RunStatus, UnbuiltAction, useMonth, WithRecords } from '../records/parts.js';

/**
 * PAYROLL: every payroll run, newest month first, each with how many it pays,
 * what it pays in each currency, privately and publicly on their own lines,
 * and where it stands. A row opens the run's own page, which is shown here in
 * place of the list. Starting a run is not built yet and is shown disabled.
 */
export function Payroll({ children }: { children?: ReactNode }) {
  const t = useText();
  const month = useMonth();
  if (children !== undefined) return <>{children}</>;
  return (
    <div className="flex flex-col gap-4" data-screen="payroll">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('page.payroll.name')}</h1>
        <UnbuiltAction data-action="new-run">{t('payroll.newRun')}</UnbuiltAction>
      </div>
      <WithRecords>
        {(records) => (
          <ReadOf read={records.runs}>
            {(runs) => runs.length === 0 ? <p className="text-sm text-muted-foreground" data-empty>{t('payroll.none')}</p> : (
              <table className="w-full text-sm" data-runs>
                <thead className="text-xs text-muted-foreground">
                  <tr><th className="py-2 text-start font-normal">{t('payroll.column.month')}</th><th className="text-start font-normal">{t('payroll.column.people')}</th><th className="text-start font-normal">{t('payroll.column.total')}</th><th className="text-start font-normal">{t('payroll.column.status')}</th></tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className="border-t align-top" data-run={r.id}>
                      <td className="py-2"><PageLink to={PAGE.run} params={{ run: r.id }} className="font-medium underline-offset-4 hover:underline">{month(r.period)}</PageLink></td>
                      <td className="py-2">{t('payroll.people', { count: r.payees.length })}</td>
                      <td className="py-2"><RunMoney run={r} /></td>
                      <td className="py-2"><RunStatus run={r} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </ReadOf>
        )}
      </WithRecords>
    </div>
  );
}
