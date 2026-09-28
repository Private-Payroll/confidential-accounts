import { useState } from 'react';
import { Amount, Button, ComingSoon, useText } from 'vaults-ui';
import { readVaultPublicMoney, type CompanyRecords } from '../adapters/company-records.js';
import type { VaultPublicMoney } from '../adapters/vault-public-money.js';
import { PAGE } from '../pages.js';
import { PageLink, useCurrentPage } from '../router.js';
import { useSession } from '../session.js';
import { ReadOf, SoonAction, useDay, useMonth, VaultStandingWords, WithRecords } from '../records/parts.js';

/** Where the public money shown is: not asked for yet, being read, read, or not readable. */
const PUBLIC = { notAsked: 'not-asked', reading: 'reading', unreadable: 'unreadable' } as const;

/**
 * A VAULT'S OWN PAGE: where it stands; its money on two lines, never added
 * together; its payouts; and depositing and checking the last deposit, both
 * shown and Coming soon.
 *
 * ITS PUBLIC MONEY IS READ WHEN THE PERSON ASKS, and every amount carries the
 * Public pill. A currency the registry does not name is counted beside the
 * amounts; while that count is above nothing, the page never says the vault
 * holds no public money. ITS PRIVATE MONEY is read on a signer's device, which
 * this page does not do yet: that line is Coming soon, never nothing.
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
                  <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-semibold" data-vault={vault.vault}>{t('vaults.tile.name', { number: index + 1 })}</h1>
                    <span className="text-sm text-muted-foreground">{t('vaults.tile.created', { date: day(vault.createdAt) })}</span>
                    <span className="text-sm"><VaultStandingWords standing={vault.standing} /></span>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <SoonAction label={t('vault.deposit')} soon={t('vault.deposit.soon')} data-action="deposit" />
                    <SoonAction label={t('vault.checkLastDeposit')} soon={t('vault.checkLastDeposit.soon')} data-action="check-last-deposit" />
                  </div>
                  <section className="flex flex-col gap-3 rounded-lg border p-4" data-part="money">
                    <h2 className="font-medium">{t('vault.money')}</h2>
                    <div className="flex items-center gap-2 text-sm" data-private-line>
                      <span className="text-muted-foreground">{t('vaults.privateMoney')}</span><ComingSoon explanation={t('vaults.privateMoney.soon')} />
                    </div>
                    <PublicMoney company={records.id} vault={vault.vault} />
                  </section>
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

/** The vault's public money, read when the person asks. */
function PublicMoney({ company, vault }: { company: string; vault: string }) {
  const t = useText();
  const { person } = useSession();
  const [held, setHeld] = useState<VaultPublicMoney | (typeof PUBLIC)[keyof typeof PUBLIC]>(PUBLIC.notAsked);
  const read = async (): Promise<void> => {
    setHeld(PUBLIC.reading);
    setHeld((await readVaultPublicMoney(person.id, company, vault)) ?? PUBLIC.unreadable);
  };
  return (
    <div className="flex flex-col gap-2 text-sm" data-public-money={typeof held === 'string' ? held : 'read'}>
      <div><Button variant="outline" size="sm" disabled={held === PUBLIC.reading} onClick={() => { void read(); }} data-action="show-public-money">{t('vault.showPublicMoney')}</Button></div>
      {held === PUBLIC.unreadable ? <p className="text-muted-foreground" data-unreadable>{t('vault.publicMoney.unreadable')}</p> : null}
      {typeof held === 'string' ? null : (
        <>
          {held.amounts.map((a) => <span key={a.code} data-held={a.code}><Amount value={a} kind="balance" /></span>)}
          {held.unrecognised === 0 ? null : <p data-unrecognised={held.unrecognised}>{t('vault.publicMoney.unrecognised', { count: held.unrecognised })}</p>}
          {held.amounts.length === 0 && held.unrecognised === 0 ? <p className="text-muted-foreground" data-holds-none>{t('vault.publicMoney.none')}</p> : null}
        </>
      )}
    </div>
  );
}

/** What the company's runs pay out of this vault, one row a currency of a run. */
function Payouts({ records, vault }: { records: CompanyRecords; vault: string }) {
  const t = useText();
  const month = useMonth();
  return (
    <section className="flex flex-col gap-2" data-part="payouts">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">{t('vault.payouts')}</h2>
        <SoonAction label={t('vault.payOut')} soon={t('vault.payOut.soon')} data-action="pay-out" />
      </div>
      <ReadOf read={records.runs}>
        {(runs) => {
          const legs = runs.flatMap((r) => r.legs.filter((l) => l.vault.toLowerCase() === vault.toLowerCase()).map((l) => ({ run: r, leg: l })));
          if (legs.length === 0) return <p className="text-sm text-muted-foreground" data-empty>{t('vault.payouts.none')}</p>;
          return (
            <ul className="flex flex-col gap-1 text-sm">
              {legs.map(({ run, leg }, i) => (
                <li key={i} className="flex flex-wrap items-center gap-3" data-payout={run.id}>
                  <PageLink to={PAGE.run} params={{ run: run.id }} className="font-medium underline-offset-4 hover:underline">{month(run.period)}</PageLink>
                  <span>{leg.code}</span>
                  <span className="text-muted-foreground">{t('payroll.people', { count: leg.payees })}</span>
                </li>
              ))}
            </ul>
          );
        }}
      </ReadOf>
    </section>
  );
}
