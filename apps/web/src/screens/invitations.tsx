import { useState } from 'react';
import { ComingSoon, Tabs, TabsList, TabsTrigger, useText } from 'vaults-ui';
import { INVITED, STANDING, type InvitationRow } from '../adapters/company-records.js';
import { ReadOf, SoonAction, useDay, WithRecords } from '../records/parts.js';

/** The tabs of the invitations page that are built. Codes received is Coming soon: nothing receives a code yet. */
const TABS = { sent: 'sent', waiting: 'waiting' } as const;
type Tab = (typeof TABS)[keyof typeof TABS];

/**
 * INVITATIONS: the links sent and not yet used, withdrawn or expired; and the
 * people who accepted and are waiting for the fingerprint check. Withdrawing a
 * link and checking a fingerprint are shown, and are Coming soon; so is the
 * tab of codes received.
 */
export function Invitations() {
  const t = useText();
  const [tab, setTab] = useState<Tab>(TABS.sent);
  const names: Record<Tab, string> = { [TABS.sent]: t('invitations.tab.sent'), [TABS.waiting]: t('invitations.tab.waiting') };
  return (
    <div className="flex flex-col gap-4" data-screen="invitations">
      <h1 className="text-xl font-semibold">{t('page.invitations.name')}</h1>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} data-tabs>
        <TabsList>
          {(Object.values(TABS) as Tab[]).map((id) => (
            <TabsTrigger key={id} value={id} data-tab={id}>{names[id]}</TabsTrigger>
          ))}
          <span className="inline-flex items-center gap-1 px-3 py-2 text-sm text-muted-foreground" data-tab="codes">
            {t('invitations.tab.codes')}<ComingSoon explanation={t('invitations.codes.soon')} />
          </span>
        </TabsList>
      </Tabs>
      <WithRecords>
        {(records) => tab === TABS.sent ? (
          <ReadOf read={records.invitations}>
            {(rows) => rows.length === 0 ? <p className="text-sm text-muted-foreground" data-empty>{t('invitations.sent.none')}</p> : (
              <ul className="flex flex-col gap-2 text-sm" data-sent>
                {rows.map((r, i) => <SentLink key={i} row={r} />)}
              </ul>
            )}
          </ReadOf>
        ) : (
          <div className="flex flex-col gap-3" data-waiting>
            <ReadOf read={records.people}>
              {(rows) => {
                const waiting = rows.filter((p) => p.standing === STANDING.waitingForCheck);
                return waiting.length === 0 ? <p className="text-sm text-muted-foreground" data-empty>{t('invitations.waiting.none')}</p> : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {waiting.map((p) => (
                      <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-2" data-person={p.id}>
                        <span>{p.name}</span>
                        <SoonAction label={t('people.checkFingerprint')} soon={t('people.checkFingerprint.soon')} data-action="check-fingerprint" />
                      </li>
                    ))}
                  </ul>
                );
              }}
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

/** A link sent: to a signer or to someone to be paid, who it names, when it was sent and when it expires. Withdrawing it is Coming soon. */
function SentLink({ row }: { row: InvitationRow }) {
  const t = useText();
  const day = useDay();
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-t pt-2" data-invitation={row.kind}>
      <span className="flex flex-col">
        <span className="font-medium">{row.name ?? t('invitations.noName')}</span>
        <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span data-kind={row.kind}>{row.kind === INVITED.signer ? t('invitations.kind.signer') : t('invitations.kind.employee')}</span>
          <span>{t('invitations.sentOn', { date: day(row.sentAt) })}</span>
          {row.expiresAt === null ? null : <span>{t('invitations.expires', { date: day(row.expiresAt) })}</span>}
        </span>
      </span>
      <SoonAction label={t('invitations.withdraw')} soon={t('invitations.withdraw.soon')} data-action="withdraw" />
    </li>
  );
}
