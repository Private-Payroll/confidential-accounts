import { useEffect, useState } from 'react';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { Invoice01Icon, RefreshIcon, SafeIcon, SentIcon, Shield01Icon, ShieldOffIcon } from '@hugeicons/core-free-icons';
import {
  AMOUNT_KIND, AmountFigureOnly, AmountState, Button, EmptyState, formatTimeAgo, PageHeader, Section, SectionRow, Tooltip, TooltipContent, TooltipTrigger,
  useLanguage, useText, type PrivateAmount, type PublicAmount,
} from 'vaults-ui';
import { COLUMN_SIZE, DataTable, type DataTableColumn, type DataTableFilter } from 'vaults-ui/data-table';
import { isPending, PendingPill, useStandingSays, VaultName } from '../records/vault-pending.js';
import type { CompanyRecords, VaultRow } from '../adapters/company-records.js';
import { DepositActions, DepositStrip } from '../actions/deposit.js';
import { PRIVATE_MONEY } from '../adapters/vault-private-money.js';
import { PAGE } from '../pages.js';
import { PageLink, useCurrentPage } from '../router.js';
import { MONEY, PaidWords, PrivateMoneyUnshown, ReadOf, UnbuiltAction, useDay, useMonth, useVaultMoney, WithRecords, type VaultMoney } from '../records/parts.js';

/**
 * A VAULT'S OWN PAGE: its name, with the Pending pill when it waits on
 * something and where it stands when it does not; the money it holds, in the
 * kit's table; its payouts; and depositing and checking the last deposit,
 * which open the right-hand panel (paying a vault's money out is not built
 * yet and is shown disabled).
 *
 * ITS MONEY IS READ WHEN THE PAGE IS SHOWN, and can be read again: privately
 * on this device, with this signer's own keys, and publicly from the
 * company's service. A row an asset and state, private and public never
 * added together.
 */
export function Vault() {
  const t = useText();
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
              return <VaultBody records={records} vault={vault} number={index + 1} />;
            }}
          </ReadOf>
        )}
      </WithRecords>
    </div>
  );
}


/**
 * THE VAULT THE PAGE SHOWS: its name, its two actions, a deposit that runs or has ended, its money and its payouts. A
 * deposit that finishes makes the money below be read again.
 */
function VaultBody({ records, vault, number }: { records: CompanyRecords; vault: VaultRow; number: number }) {
  const t = useText();
  const day = useDay();
  const says = useStandingSays();
  const [deposited, setDeposited] = useState(0);
  const company = records.id;
  return (
    <>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-2" data-vault={vault.vault}><span><VaultName company={company} vault={vault} number={number} /></span><PendingPill vault={vault} /></span>}
        description={t('vaults.tile.created', { date: day(vault.createdAt) })}
        actions={<DepositActions company={company} vault={vault.vault} />}
      />
      <DepositStrip company={company} vault={vault.vault} onDone={() => setDeposited((n) => n + 1)} />
      {isPending(vault.standing) ? null : <p className="text-sm" data-standing={vault.standing}>{says(vault.standing)}</p>}
      <MoneyHeld company={company} vault={vault.vault} deposited={deposited} />
      <Payouts records={records} vault={vault.vault} />
    </>
  );
}


const HELD = { asset: 'asset', amount: 'amount', state: 'state', actions: 'actions', all: 'all', private: 'private', public: 'public' } as const;

/** How often the time since the money was read is said again. */
const TICK_MS = 30_000;

/** One asset the vault holds in one state: privately or publicly. An asset held both ways is two of these, told apart by their ids, the asset's code and the state, compared and never shown. */
interface HeldRow { id: string; amount: PrivateAmount | PublicAmount; private: boolean }

/** What the vault holds, a row an asset and state: those held privately first, each side in the order read. */
function heldRows(money: VaultMoney): HeldRow[] {
  return [
    ...(money.private === MONEY.reading || money.private.of !== PRIVATE_MONEY.held ? [] : money.private.amounts.map((a) => ({ id: a.symbol + HELD.private, amount: a, private: true }))),
    ...(typeof money.public === 'string' ? [] : money.public.amounts.map((a) => ({ id: a.symbol + HELD.public, amount: a, private: false }))),
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
 * on the title line, with how long ago it was read. Under the table, a side
 * that could not be read says so, and for the private side says why; a
 * vault that holds nothing privately yet and a private record that was not
 * believed each say that; a currency the registry does not know is counted.
 */
function MoneyHeld({ company, vault, deposited }: { company: string; vault: string; deposited: number }) {
  const t = useText();
  const language = useLanguage();
  const [asked, setAsked] = useState(0);
  const money = useVaultMoney(company, vault, asked + deposited);
  const reading = money.private === MONEY.reading || money.public === MONEY.reading;
  const [readAt, setReadAt] = useState<Date | null>(null);
  const [now, setNow] = useState(() => new Date());
  /* How long ago is said of the last read that read both sides, a vault with nothing held yet counting as read; a read that failed, or a record not believed, does not make the page look fresher. */
  const privateRead = money.private !== MONEY.reading && (money.private.of === PRIVATE_MONEY.held || money.private.of === PRIVATE_MONEY.nothingYet);
  const publicRead = typeof money.public !== 'string';
  const bothRead = privateRead && publicRead;
  useEffect(() => { if (bothRead) { const at = new Date(); setReadAt(at); setNow(at); } }, [bothRead, money]);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const columns: DataTableColumn<HeldRow>[] = [
    { id: HELD.asset, header: t('vault.money.asset'), cell: (r) => <span className="font-medium">{r.amount.symbol}</span>, size: COLUMN_SIZE.wide },
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
  /* A tab counts only a side that was read: a side not believed or that could not be read has no rows because they were not known, and its tab says no number rather than 0. A vault with nothing held yet was read, and holds nothing. */
  const filters: DataTableFilter<HeldRow>[] = [
    { id: HELD.all, label: t('vault.money.all'), keeps: () => true, counted: bothRead },
    { id: HELD.private, label: t('vault.money.private'), keeps: (r) => r.private, counted: privateRead },
    { id: HELD.public, label: t('vault.money.public'), keeps: (r) => !r.private, counted: publicRead },
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
        {money.private === MONEY.reading || money.private.of === PRIVATE_MONEY.held ? null : <p className="text-sm text-muted-foreground"><PrivateMoneyUnshown money={money.private} /></p>}
        {money.private === MONEY.reading || money.private.of !== PRIVATE_MONEY.held || money.private.unrecognised === 0 ? null : <p className="text-sm" data-unrecognised={money.private.unrecognised} data-side="private">{t('vault.privateMoney.unrecognised', { count: money.private.unrecognised })}</p>}
        {money.public === MONEY.unreadable ? <p className="text-sm text-muted-foreground" data-unreadable="public">{t('vault.publicMoney.unreadable')}</p> : null}
        {typeof money.public === 'string' || money.public.unrecognised === 0 ? null : <p className="text-sm" data-unrecognised={money.public.unrecognised} data-side="public">{t('vault.publicMoney.unrecognised', { count: money.public.unrecognised })}</p>}
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
                <span>{leg.symbol ?? t('records.unrecognisedOne')}</span>
                <span className="text-muted-foreground"><PaidWords paid={leg.paid} /></span>
                <span className="text-muted-foreground">{t('payroll.people', { count: leg.payees })}</span>
              </SectionRow>
            ))}
          </Section>
        );
      }}
    </ReadOf>
  );
}
