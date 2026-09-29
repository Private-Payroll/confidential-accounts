import { HugeiconsIcon } from '@hugeicons/react';
import { GridViewIcon } from '@hugeicons/core-free-icons';
import { useState } from 'react';
import { Badge, Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle, ComingSoon, PageHeader, useText } from 'vaults-ui';
import type { Text } from '../pages.js';

/** An app that will be offered: its name and what it does, each asked for by its key. */
interface App { name: (t: Text) => string; summary: (t: Text) => string }

/**
 * THE APPS THAT WILL BE OFFERED, in their groups: the groups in the order
 * their first app is listed, and the apps of a group in the order they are
 * listed.
 */
const APP_GROUPS: readonly { name: (t: Text) => string; apps: readonly App[] }[] = [
  {
    name: (t) => t('apps.category.interop'),
    apps: [
      { name: (t) => t('apps.safe-bridge.name'), summary: (t) => t('apps.safe-bridge.summary') },
    ],
  },
  {
    name: (t) => t('apps.category.offramp'),
    apps: [
      { name: (t) => t('apps.moneygram-payout.name'), summary: (t) => t('apps.moneygram-payout.summary') },
      { name: (t) => t('apps.wise-payout.name'), summary: (t) => t('apps.wise-payout.summary') },
      { name: (t) => t('apps.monument-gbp.name'), summary: (t) => t('apps.monument-gbp.summary') },
    ],
  },
  {
    name: (t) => t('apps.category.treasury'),
    apps: [
      { name: (t) => t('apps.treasury-yield.name'), summary: (t) => t('apps.treasury-yield.summary') },
      { name: (t) => t('apps.vesting.name'), summary: (t) => t('apps.vesting.summary') },
      { name: (t) => t('apps.contributor-bounties.name'), summary: (t) => t('apps.contributor-bounties.summary') },
    ],
  },
  {
    name: (t) => t('apps.category.accounting'),
    apps: [
      { name: (t) => t('apps.xero-sync.name'), summary: (t) => t('apps.xero-sync.summary') },
      { name: (t) => t('apps.quickbooks-sync.name'), summary: (t) => t('apps.quickbooks-sync.summary') },
    ],
  },
  {
    name: (t) => t('apps.category.compliance'),
    apps: [
      { name: (t) => t('apps.hmrc-rti.name'), summary: (t) => t('apps.hmrc-rti.summary') },
      { name: (t) => t('apps.auditor-portal.name'), summary: (t) => t('apps.auditor-portal.summary') },
    ],
  },
];

/**
 * APPS: every app that will be offered, one card each in one grid, with its
 * category, what it does, and the Coming soon pill at the card's top right.
 * None can be installed yet, so no Install is drawn. The categories are tags
 * across the top: none chosen shows every app, and choosing one or more shows
 * only the apps in those.
 */
export function Apps() {
  const t = useText();
  const [chosen, setChosen] = useState<readonly number[]>([]);
  const flip = (i: number): void => setChosen((c) => (c.includes(i) ? c.filter((x) => x !== i) : [...c, i]));
  return (
    <div className="flex flex-col gap-6" data-screen="apps">
      <PageHeader title={<><HugeiconsIcon icon={GridViewIcon} strokeWidth={2} className="size-5 text-muted-foreground" />{t('page.apps.name')}</>} />
      <div role="group" aria-label={t('apps.filter.label')} className="flex flex-wrap gap-2" data-app-filters>
        {APP_GROUPS.map((g, i) => (
          <Badge key={i} asChild variant={chosen.includes(i) ? 'default' : 'outline'} className="h-7 cursor-pointer px-3 text-sm">
            <button type="button" aria-pressed={chosen.includes(i)} onClick={() => flip(i)} data-app-filter>{g.name(t)}</button>
          </Badge>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-app-grid>
        {APP_GROUPS.flatMap((g, i) => (chosen.length === 0 || chosen.includes(i) ? g.apps.map((a, j) => (
          <Card key={i * 100 + j} className="h-full" data-app>
            <CardHeader>
              <CardTitle data-app-name>{a.name(t)}</CardTitle>
              <CardDescription data-app-category>{g.name(t)}</CardDescription>
              <CardAction><ComingSoon explanation={t('apps.install.soon')} /></CardAction>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground" data-app-summary>{a.summary(t)}</CardContent>
          </Card>
        )) : []))}
      </div>
    </div>
  );
}
