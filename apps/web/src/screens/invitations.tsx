import { useState } from 'react';
import { FingerPrintIcon, Link01Icon } from '@hugeicons/core-free-icons';
import { ComingSoon, EmptyState, PageHeader, Section, SectionRow, Tabs, TabsList, TabsTrigger, useText } from 'vaults-ui';
import { INVITED, STANDING, type InvitationRow } from '../adapters/company-records.js';
import { ReadOf, UnbuiltAction, useDay, WithRecords } from '../records/parts.js';

/** The tabs of the invitations page. Codes received is Coming soon: nothing receives a code yet. */
const TABS = { sent: 'sent', waiting: 'waiting', codes: 'codes' } as const;
type Tab = typeof TABS.sent | typeof TABS.waiting;

/**
 * INVITATIONS: the links sent and not yet used, withdrawn or expired; and the
 * people who accepted and are waiting for the fingerprint check, each list the
 * kit's section under its tab. Withdrawing a link and checking a fingerprint
 * are not built yet and are shown disabled; the tab of codes received is not
 * built yet and is shown disabled, with its Coming soon pill.
 */
export function Invitations() {
  const t = useText();
  const [tab, setTab] = useState<Tab>(TABS.sent);
  const names: Record<Tab, string> = { [TABS.sent]: t('invitations.tab.sent'), [TABS.waiting]: t('invitations.tab.waiting') };
  return (
    <div className="flex flex-col gap-6" data-screen="invitations">
      <PageHeader title={t('page.invitations.name')} />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} data-tabs>
        <TabsList>
          {([TABS.sent, TABS.waiting] as const).map((id) => (
            <TabsTrigger key={id} value={id} data-tab={id}>{names[id]}</TabsTrigger>
          ))}
          {/* The tab, disabled, and its pill beside it rather than in it: the pill can still be pressed to say what the tab will be, and a tab holds nothing that can be pressed on its own. */}
          <span className="inline-flex items-center" data-tab-soon={TABS.codes}>
            <TabsTrigger value={TABS.codes} disabled asChild data-tab={TABS.codes}>
              <span className="cursor-default opacity-50 hover:text-muted-foreground">{t('invitations.tab.codes')}</span>
            </TabsTrigger>
            <ComingSoon explanation={t('invitations.codes.soon')} />
          </span>
        </TabsList>
      </Tabs>
      <WithRecords>
        {(records) => tab === TABS.sent ? (
          <ReadOf read={records.invitations}>
            {(rows) => (
              <Section title={names[TABS.sent]} empty={<EmptyState icon={Link01Icon}>{t('invitations.sent.none')}</EmptyState>} data-sent>
                {rows.map((r, i) => <SentLink key={i} row={r} />)}
              </Section>
            )}
          </ReadOf>
        ) : (
          <div className="flex flex-col gap-3" data-waiting>
            <ReadOf read={records.people}>
              {(rows) => (
                <Section title={names[TABS.waiting]} empty={<EmptyState icon={FingerPrintIcon}>{t('invitations.waiting.none')}</EmptyState>}>
                  {rows.filter((p) => p.standing === STANDING.waitingForCheck).map((p) => (
                    <SectionRow key={p.id} data-person={p.id} actions={<UnbuiltAction data-action="check-fingerprint">{t('people.checkFingerprint')}</UnbuiltAction>}>
                      <span>{p.name}</span>
                    </SectionRow>
                  ))}
                </Section>
              )}
            </ReadOf>
            <p className="flex items-center gap-2 text-sm text-muted-foreground" data-signers-waiting>
              {t('invitations.waiting.signers')}<ComingSoon explanation={t('invitations.waiting.signers.soon')} />
            </p>
          </div>
        )}
      </WithRecords>
    </div>
  );
}

/** A link sent: to a signer or to someone to be paid, who it names, when it was sent and when it expires. Withdrawing it is not built yet and is shown disabled. */
function SentLink({ row }: { row: InvitationRow }) {
  const t = useText();
  const day = useDay();
  return (
    <SectionRow data-invitation={row.kind} actions={<UnbuiltAction data-action="withdraw">{t('invitations.withdraw')}</UnbuiltAction>}>
      <span className="flex flex-col">
        <span className="font-medium">{row.name ?? t('invitations.noName')}</span>
        <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span data-kind={row.kind}>{row.kind === INVITED.signer ? t('invitations.kind.signer') : t('invitations.kind.employee')}</span>
          <span>{t('invitations.sentOn', { date: day(row.sentAt) })}</span>
          {row.expiresAt === null ? null : <span>{t('invitations.expires', { date: day(row.expiresAt) })}</span>}
        </span>
      </span>
    </SectionRow>
  );
}
