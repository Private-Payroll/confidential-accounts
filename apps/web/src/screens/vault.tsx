import { useEffect, useState } from 'react';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { Invoice01Icon, RefreshIcon, SafeIcon, SentIcon, Shield01Icon, ShieldOffIcon } from '@hugeicons/core-free-icons';
import {
  AMOUNT_KIND, AmountFigureOnly, AmountState, Button, EmptyState, formatTimeAgo, PageHeader, Section, SectionRow, Tooltip, TooltipContent, TooltipTrigger,
  useLanguage, useText, type PrivateAmount, type PublicAmount,
} from 'vaults-ui';
import { COLUMN_SIZE, DataTable, type DataTableColumn, type DataTableFilter } from 'vaults-ui/data-table';
import { isPending, PendingPill, useStandingSays } from '../records/vault-pending.js';
import type { CompanyRecords } from '../adapters/company-records.js';
import { PAGE } from '../pages.js';
import { PageLink, useCurrentPage } from '../router.js';
import { MONEY, ReadOf, UnbuiltAction, useDay, useMonth, useVaultMoney, WithRecords, type VaultMoney } from '../records/parts.js';

/**
 * A VAULT'S OWN PAGE: its name, with the Pending pill when it waits on
 * something and where it stands when it does not; the money it holds, in the
 * kit's table; its payouts; and depositing and checking the last deposit,
 * both not built yet and shown disabled.
 *
 * ITS MONEY IS READ WHEN THE PAGE IS SHOWN, and can be read again: privately
 * on this device, with this signer's own keys, and publicly from the
 * company's service. A row an asset and state, private and public never
 * added together.
 */
export function Vault() {
  const t = useText();
  const day = useDay();
  const says = useStandingSays();
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
                    title={<span className="flex flex-wrap items-center gap-2" data-vault={vault.vault}><span>{t('vaults.tile.name', { number: index + 1 })}</span><PendingPill vault={vault} /></span>}
                    description={t('vaults.tile.created', { date: day(vault.createdAt) })}
                    actions={(
                      <>
                        <UnbuiltAction data-action="deposit">{t('vault.deposit')}</UnbuiltAction>
                        <UnbuiltAction data-action="check-last-deposit">{t('vault.checkLastDeposit')}</UnbuiltAction>
                      </>
                    )}
                  />
                  {isPending(vault.standing) ? null : <p className="text-sm" data-standing={vault.standing}>{says(vault.standing)}</p>}
                  <MoneyHeld company={records.id} vault={vault.vault} />
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

/** The ids of the money table's columns and filters, compared by the code and never shown. */
const HELD = { asset: 'asset', amount: 'amount', state: 'state', actions: 'actions', all: 'all', private: 'private', public: 'public' } as const;

/** How often the time since the money was read is said again. */
const TICK_MS = 30_000;

/** One asset the vault holds in one state: privately or publicly. An asset held both ways is two of these, told apart by their ids, the asset's code and the state, compared and never shown. */
interface HeldRow { id: string; amount: PrivateAmount | PublicAmount; private: boolean }

/** What the vault holds, a row an asset and state: those held privately first, each side in the order read. */
function heldRows(money: VaultMoney): HeldRow[] {
  return [
    ...(typeof money.private === 'string' ? [] : money.private.amounts.map((a) => ({ id: a.code + HELD.private, amount: a, private: true }))),
    ...(typeof money.public === 'string' ? [] : money.public.amounts.map((a) => ({ id: a.code + HELD.public, amount: a, private: false }))),
  ];
}

/**
 * AN ACTION DRAWN AS AN ICON, named by its hover text. A disabled one keeps
 * its hover text and its name: what holds the button can be reached with the
 * keyboard and says it is disabled, which a disabled button cannot.
 */
function IconAction({ icon, label, disabled = false, onPress, ...marks }: { icon: IconSvgElement; label: string; disabled?: boolean; onPress?: () => void; 'data-action': string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={disabled ? 0 : undefined} role={disabled ? 'button' : undefined} aria-disabled={disabled ? true : undefined} aria-label={disabled ? label : undefined} data-hover={label}>
          <Button variant="ghost" size="icon-sm" disabled={disabled} aria-label={label} onClick={onPress} {...marks}>
            <HugeiconsIcon icon={icon} strokeWidth={2} />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * THE MONEY THE VAULT HOLDS, in the kit's table: a row an asset and state,
 * with its balance, whether it is private or public, and sending it and
 * shielding or unshielding it, both not built yet and so disabled. Tabs show
 * every row, those held privately or those held publicly. Checking again is
 * on the title line, with how long ago it was read. A side that could not be
 * read says so under the table; a currency the registry does not know is
 * counted.
 */
function MoneyHeld({ company, vault }: { company: string; vault: string }) {
  const t = useText();
  const language = useLanguage();
  const [asked, setAsked] = useState(0);
  const money = useVaultMoney(company, vault, asked);
  const reading = money.private === MONEY.reading || money.public === MONEY.reading;
  const [readAt, setReadAt] = useState<Date | null>(null);
  const [now, setNow] = useState(() => new Date());
  /* How long ago is said of the last read that read both sides; a read that failed does not make the page look fresher. */
  const bothRead = typeof money.private !== 'string' && typeof money.public !== 'string';
  useEffect(() => { if (bothRead) { const at = new Date(); setReadAt(at); setNow(at); } }, [bothRead, money]);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const columns: DataTableColumn<HeldRow>[] = [
    { id: HELD.asset, header: t('vault.money.asset'), cell: (r) => <span className="font-medium">{r.amount.code}</span>, size: COLUMN_SIZE.wide },
    { id: HELD.amount, header: t('vault.money.balance'), cell: (r) => <AmountFigureOnly value={r.amount} />, centred: true },
    { id: HELD.state, header: t('vault.money.state'), cell: (r) => <AmountState value={r.amount} kind={AMOUNT_KIND.held} />, centred: true },
    {
      id: HELD.actions, header: t('vault.money.actions'), centred: true, size: COLUMN_SIZE.narrow,
      cell: (r) => (
        <span className="inline-flex items-center gap-1">
          <IconAction icon={SentIcon} label={t('vault.money.send')} disabled data-action="send" />
          {r.private
            ? <IconAction icon={ShieldOffIcon} label={t('vault.money.unshield')} disabled data-action="unshield" />
            : <IconAction icon={Shield01Icon} label={t('vault.money.shield')} disabled data-action="shield" />}
        </span>
      ),
    },
  ];
  const filters: DataTableFilter<HeldRow>[] = [
    { id: HELD.all, label: t('vault.money.all'), keeps: () => true },
    { id: HELD.private, label: t('vault.money.private'), keeps: (r) => r.private },
    { id: HELD.public, label: t('vault.money.public'), keeps: (r) => !r.private },
  ];
  const rows = heldRows(money);
  const again = (
    <span className="flex items-center gap-2">
      {readAt === null ? null : <span className="text-sm text-muted-foreground" data-updated>{t('vault.money.updated', { ago: formatTimeAgo(readAt, now, language) })}</span>}
      <IconAction icon={RefreshIcon} label={t('vault.money.readAgain')} disabled={reading} onPress={() => setAsked((n) => n + 1)} data-action="read-money" />
    </span>
  );
  return (
    <Section title={t('vault.money')} actions={again} list={false} data-part="money">
      <div className="flex flex-col gap-3">
        <DataTable
          label={t('vault.money')}
          rows={rows}
          rowId={(r) => r.id}
          columns={columns}
          filters={filters}
          loading={reading}
          empty={!bothRead ? null : <EmptyState icon={SafeIcon}>{rows.length === 0 ? t('vaults.money.none') : t('vault.money.noneThisWay')}</EmptyState>}
        />
        {money.private === MONEY.unreadable ? <p className="text-sm text-muted-foreground" data-unreadable="private">{t('vault.privateMoney.unreadable')}</p> : null}
        {money.public === MONEY.unreadable ? <p className="text-sm text-muted-foreground" data-unreadable="public">{t('vault.publicMoney.unreadable')}</p> : null}
        {typeof money.public === 'string' || money.public.unrecognised === 0 ? null : <p className="text-sm" data-unrecognised={money.public.unrecognised}>{t('vault.publicMoney.unrecognised', { count: money.public.unrecognised })}</p>}
      </div>
    </Section>
  );
}

/** What the company's runs pay out of this vault, one row a currency of a run. */
function Payouts({ records, vault }: { records: CompanyRecords; vault: string }) {
  const t = useText();
  const month = useMonth();
  const payOut = <UnbuiltAction data-action="pay-out">{t('vault.payOut')}</UnbuiltAction>;
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
