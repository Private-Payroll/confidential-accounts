import { useState } from 'react';
import { FingerPrintIcon, Link01Icon } from '@hugeicons/core-free-icons';
import { EmptyState, PageHeader, Section, SectionRow, Tabs, TabsList, TabsTrigger, useText } from 'vaults-ui';
import type { InvitationRow } from '../adapters/company-records.js';
import { InvitePeople } from '../actions/invite.js';
import { CheckFingerprint, ReadOf, UnbuiltAction, useDay, useInvitedKindSays, WaitingName, waitingRead, WithRecords } from '../records/parts.js';

/** The tabs of the invitations page. */
const TABS = { sent: 'sent', waiting: 'waiting' } as const;
type Tab = (typeof TABS)[keyof typeof TABS];

/**
 * INVITATIONS: the links sent and not yet used, withdrawn or expired; and the
 * people and vendors who accepted and are waiting for the fingerprint check, each list the
 * kit's section under its tab. Inviting is the one invite panel, and the check is the one admit
 * control, each opened in the right-hand panel. Withdrawing a link is not built yet and is
 * shown disabled.
 */
export function Invitations() {
  const t = useText();
  const [tab, setTab] = useState<Tab>(TABS.sent);
  const names: Record<Tab, string> = { [TABS.sent]: t('invitations.tab.sent'), [TABS.waiting]: t('invitations.tab.waiting') };
  return (
    <div className="flex flex-col gap-6" data-screen="invitations">
      <PageHeader title={t('page.invitations.name')} actions={<InvitePeople />} />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} data-tabs>
        <TabsList>
          {([TABS.sent, TABS.waiting] as const).map((id) => (
            <TabsTrigger key={id} value={id} data-tab={id}>{names[id]}</TabsTrigger>
          ))}
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
          <div data-waiting>
            <ReadOf read={waitingRead(records)}>
              {(rows) => (
                <Section title={names[TABS.waiting]} empty={<EmptyState icon={FingerPrintIcon}>{t('invitations.waiting.none')}</EmptyState>}>
                  {rows.map((w) => (
                    <SectionRow key={w.id} data-person={w.id} actions={<CheckFingerprint one={w} />}>
                      <WaitingName one={w} />
                    </SectionRow>
                  ))}
                </Section>
              )}
            </ReadOf>
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
  const kinds = useInvitedKindSays();
  return (
    <SectionRow data-invitation={row.kind} actions={<UnbuiltAction data-action="withdraw">{t('invitations.withdraw')}</UnbuiltAction>}>
      <span className="flex flex-col">
        <span className="font-medium">{row.name ?? t('invitations.noName')}</span>
        <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span data-kind={row.kind}>{kinds[row.kind]}</span>
          <span>{t('invitations.sentOn', { date: day(row.sentAt) })}</span>
          {row.expiresAt === null ? null : <span>{t('invitations.expires', { date: day(row.expiresAt) })}</span>}
        </span>
      </span>
    </SectionRow>
  );
}
