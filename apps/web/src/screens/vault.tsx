import { Invoice01Icon } from '@hugeicons/core-free-icons';
import { Button, EmptyState, PageHeader, Section, SectionRow, SoonAction, StatTile, StatTiles, useText } from 'vaults-ui';
import { VAULT, type CompanyRecords } from '../adapters/company-records.js';
import { PAGE } from '../pages.js';
import { PageLink, useCurrentPage } from '../router.js';
import { ReadOf, useDay, useMonth, VaultPrivateMoney, VaultPublicMoney, VaultStandingWords, WithRecords } from '../records/parts.js';

/**
 * A VAULT'S OWN PAGE: where it stands; its money on two tiles, never added
 * together; its payouts; and depositing and checking the last deposit, both
 * shown and Coming soon.
 *
 * ITS PUBLIC MONEY IS READ WHEN THE PAGE IS SHOWN, and can be read again;
 * every amount carries the Public pill. ITS PRIVATE MONEY is not read by this
 * app yet: the tile says so, and never shows it as nothing. A vault
 * whose creation is not finished says so, with the way to the Vaults page,
 * where it is finished.
 */
export function Vault() {
  const t = useText();
  const day = useDay();
  const { params } = useCurrentPage();
  return (
    <div className="flex flex-col gap-6" data-screen="vault">
      <PageLink to={PAGE.vaults} className="text-sm text-muted-foreground underline-offset-4 hover:underline">{t('vault.back')}</PageLink>
      <WithRecords>
        {(records) => (
          <ReadOf read={records.vaults}>
            {(rows) => {
              const index = rows.findIndex((v) => v.vault === params.vault);
              const vault = rows[index];
              if (vault === undefined) return <p className="text-sm text-muted-foreground" data-no-vault>{t('vault.notFound')}</p>;
              return (
                <>
                  <PageHeader
                    title={<span data-vault={vault.vault}>{t('vaults.tile.name', { number: index + 1 })}</span>}
                    description={t('vaults.tile.created', { date: day(vault.createdAt) })}
                    actions={(
                      <>
                        <SoonAction label={t('vault.deposit')} soon={t('vault.deposit.soon')} data-action="deposit" />
                        <SoonAction label={t('vault.checkLastDeposit')} soon={t('vault.checkLastDeposit.soon')} data-action="check-last-deposit" />
                      </>
                    )}
                  />
                  <div className="flex flex-wrap items-center gap-3 text-sm" data-part="standing">
                    <VaultStandingWords standing={vault.standing} />
                    {vault.standing === VAULT.handoverOwed
                      ? <Button variant="outline" size="sm" asChild><PageLink to={PAGE.vaults} data-action="finish-creating">{t('vault.finishCreating')}</PageLink></Button>
                      : null}
                  </div>
                  <Section title={t('vault.money')} list={false} box={false} data-part="money">
                    <StatTiles>
                      <StatTile title={t('vaults.publicMoney')}><VaultPublicMoney company={records.id} vault={vault.vault} again labelled={false} /></StatTile>
                      <StatTile title={t('vaults.privateMoney')}><VaultPrivateMoney labelled={false} /></StatTile>
                    </StatTiles>
                  </Section>
                  <Payouts records={records} vault={vault.vault} />
                </>
              );
            }}
          </ReadOf>
        )}
      </WithRecords>
    </div>
  );
}

/** What the company's runs pay out of this vault, one row a currency of a run. */
function Payouts({ records, vault }: { records: CompanyRecords; vault: string }) {
  const t = useText();
  const month = useMonth();
  const payOut = <SoonAction label={t('vault.payOut')} soon={t('vault.payOut.soon')} data-action="pay-out" />;
  return (
    <ReadOf read={records.runs}>
      {(runs) => {
        const legs = runs.flatMap((r) => r.legs.filter((l) => l.vault.toLowerCase() === vault.toLowerCase()).map((l) => ({ run: r, leg: l })));
        return (
          <Section
            title={t('vault.payouts')}
            count={legs.length}
            actions={legs.length === 0 ? undefined : payOut}
            empty={<EmptyState icon={Invoice01Icon} action={payOut}>{t('vault.payouts.none')}</EmptyState>}
            data-part="payouts"
          >
            {legs.map(({ run, leg }, i) => (
              <SectionRow key={i} data-payout={run.id}>
                <PageLink to={PAGE.run} params={{ run: run.id }} className="font-medium underline-offset-4 hover:underline">{month(run.period)}</PageLink>
                <span>{leg.code}</span>
                <span className="text-muted-foreground">{t('payroll.people', { count: leg.payees })}</span>
              </SectionRow>
            ))}
          </Section>
        );
      }}
    </ReadOf>
  );
}
