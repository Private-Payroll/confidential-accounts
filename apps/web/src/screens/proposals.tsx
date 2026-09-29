import { useState } from 'react';
import { ComingSoon, Tabs, TabsList, TabsTrigger, useText } from 'vaults-ui';
import type { ProposalRow } from '../adapters/company-records.js';
import { Approvals, Day, ProposalStatus, ProposalWhat, ReadOf, UnbuiltAction, WithRecords } from '../records/parts.js';
import { usePanel } from '../shell/right-panel.js';

/** The tabs of the proposals list, and which proposals each shows. Declined is Coming soon: nothing declines a proposal today. */
const TABS = { all: 'all', pending: 'pending', approved: 'approved' } as const;
type Tab = (typeof TABS)[keyof typeof TABS];
const inTab: Record<Tab, (r: ProposalRow) => boolean> = {
  [TABS.all]: () => true,
  [TABS.pending]: (r) => r.status === 'open',
  [TABS.approved]: (r) => r.status === 'approved' || r.status === 'executed',
};

/**
 * PROPOSALS: every proposal the signers raised, newest first, with tabs for
 * all of them, those waiting and those approved. A row opens its panel.
 * Declining and approving are not built yet and are shown disabled.
 */
export function Proposals() {
  const t = useText();
  const [tab, setTab] = useState<Tab>(TABS.all);
  const panel = usePanel();
  const names: Record<Tab, string> = { [TABS.all]: t('proposals.tab.all'), [TABS.pending]: t('proposals.tab.pending'), [TABS.approved]: t('proposals.tab.approved') };
  return (
    <div className="flex flex-col gap-4" data-screen="proposals">
      <h1 className="text-xl font-semibold">{t('page.proposals.name')}</h1>
      <WithRecords>
        {(records) => (
          <ReadOf read={records.proposals}>
            {(rows) => {
              const shown = rows.filter(inTab[tab]).sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
              return (
                <>
                  <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} data-tabs>
                    <TabsList>
                      {(Object.values(TABS) as Tab[]).map((id) => (
                        <TabsTrigger key={id} value={id} data-tab={id}>
                          {names[id]} <span className="text-muted-foreground">{rows.filter(inTab[id]).length}</span>
                        </TabsTrigger>
                      ))}
                      <span className="inline-flex items-center gap-1 px-3 py-2 text-sm text-muted-foreground" data-tab="declined">
                        {t('proposals.tab.declined')}<ComingSoon explanation={t('proposals.declined.soon')} />
                      </span>
                    </TabsList>
                  </Tabs>
                  {shown.length === 0 ? <p className="text-sm text-muted-foreground" data-empty>{t('proposals.none')}</p> : (
                    <table className="w-full text-sm" data-proposals>
                      <thead className="text-start text-xs text-muted-foreground">
                        <tr><th className="py-2 text-start font-normal">{t('proposals.column.what')}</th><th className="text-start font-normal">{t('proposals.column.raisedBy')}</th><th className="text-start font-normal">{t('proposals.column.approvals')}</th><th className="text-start font-normal">{t('proposals.column.raised')}</th><th className="text-start font-normal">{t('proposals.column.status')}</th></tr>
                      </thead>
                      <tbody>
                        {shown.map((r) => (
                          <tr key={r.id} className="cursor-pointer border-t hover:bg-accent" onClick={() => panel.open({ title: t('proposals.panel.title'), body: <ProposalPanel row={r} /> })} data-proposal={r.id}>
                            <td className="py-2"><ProposalWhat row={r} /></td>
                            <td>{r.raisedBy ?? t('proposals.raisedBy.unknown')}</td>
                            <td><Approvals row={r} /></td>
                            <td><Day at={r.raisedAt} /></td>
                            <td><ProposalStatus row={r} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              );
            }}
          </ReadOf>
        )}
      </WithRecords>
    </div>
  );
}

/** A proposal's panel: what it does, who raised it, how many have approved, and Approve and Decline, both not built yet and shown disabled. */
function ProposalPanel({ row }: { row: ProposalRow }) {
  const t = useText();
  return (
    <div className="flex flex-col gap-4 text-sm" data-proposal-panel={row.id}>
      <p className="font-medium"><ProposalWhat row={row} /></p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <dt className="text-muted-foreground">{t('proposals.column.raisedBy')}</dt><dd>{row.raisedBy ?? t('proposals.raisedBy.unknown')}</dd>
        <dt className="text-muted-foreground">{t('proposals.column.raised')}</dt><dd><Day at={row.raisedAt} /></dd>
        <dt className="text-muted-foreground">{t('proposals.column.approvals')}</dt><dd><Approvals row={row} /></dd>
        <dt className="text-muted-foreground">{t('proposals.column.status')}</dt><dd><ProposalStatus row={row} /></dd>
      </dl>
      <div className="flex flex-wrap gap-3">
        <UnbuiltAction data-action="approve">{t('proposals.approve')}</UnbuiltAction>
        <UnbuiltAction data-action="decline">{t('proposals.decline')}</UnbuiltAction>
      </div>
    </div>
  );
}
