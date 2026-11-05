import { useEffect, useState, type ReactNode } from 'react';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { Invoice01Icon, RefreshIcon, SafeIcon, SentIcon, Shield01Icon, ShieldOffIcon } from '@hugeicons/core-free-icons';
import {
  Amount, AMOUNT_KIND, AmountFigureOnly, AmountState, Button, EmptyState, formatTimeAgo, PageHeader, Section, SectionRow, Tooltip, TooltipContent, TooltipTrigger,
  useLanguage, useText, type PrivateAmount, type PublicAmount,
} from 'vaults-ui';
import { COLUMN_SIZE, DataTable, type DataTableColumn, type DataTableFilter } from 'vaults-ui/data-table';
import { isPending, PendingPill, useStandingSays, useVaultActions, VaultName } from '../records/vault-pending.js';
import { canPay, legOfRetry, openOneOffsOf, type CompanyRecords, type OneOffRow, type VaultRow } from '../adapters/company-records.js';
import { ChangeThreshold } from '../actions/change-threshold.js';
import { OneOffPayment } from '../actions/one-off.js';
import { PayRun } from '../actions/pay-run.js';
import { DepositActions, DepositStrip } from '../actions/deposit.js';
import { PRIVATE_MONEY } from '../adapters/vault-private-money.js';
import { PAGE } from '../pages.js';
import { PageLink, useCurrentPage } from '../router.js';
import { MONEY, PaidWords, PrivateMoneyUnshown, ReadOf, useDay, useMonth, useVaultMoney, WithRecords, type VaultMoney } from '../records/parts.js';

/**
 * A VAULT'S OWN PAGE: its name, with the Pending pill when it waits on
 * something and where it stands when it does not; the money it holds, in the
 * kit's table; its payouts; and depositing and checking the last deposit,
 * which open the right-hand panel, as does paying someone from the vault
 * (a one-off payment, raised from Send on a row or from Pay someone) and
 * approving one the vault's signers have raised and the chain holds open.
 * Paying a vault's money out in other ways is not built yet.
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
              if (vault === undefined) return <EmptyState icon={SafeIcon}>{t('vault.notFound')}</EmptyState>;
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
        actions={<><PaySomeone vault={vault.vault} /><DepositActions company={company} vault={vault.vault} standing={vault.standing} /></>}
      />
      <DepositStrip company={company} vault={vault.vault} standing={vault.standing} onDone={() => setDeposited((n) => n + 1)} />
      {isPending(vault.standing) ? null : <p className="text-sm" data-standing={vault.standing}>{says(vault.standing)}</p>}
      <Approvals vault={vault} />
      <MoneyHeld company={company} vault={vault.vault} deposited={deposited} />
      <Payouts records={records} vault={vault.vault} number={number} />
      <OneOffs records={records} vault={vault.vault} />
    </>
  );
}


/** Paying someone from this vault, from the page's title line: opens the one-off payment in the shell's panel, where its answer survives the records being read again. */
function PaySomeone({ vault }: { vault: string }) {
  const t = useText();
  const { inPanel } = useVaultActions();
  return (
    <Button variant="outline" data-action="pay-someone" onClick={() => inPanel(t('oneOff.title'), () => <OneOffPayment vault={vault} />)}>
      {t('vault.paySomeone')}
    </Button>
  );
}


/**
 * THE APPROVALS THIS VAULT ASKS FOR, as the chain holds them, and the control to change them. Only a vault the account adopted
 * has a number. The control opens in the shell's panel, never here: this page stands under the company's records, which a
 * change reads again, emptying everything drawn under them, and a result drawn here would go with them.
 */
function Approvals({ vault }: { vault: VaultRow }) {
  const t = useText();
  const { inPanel } = useVaultActions();
  if (vault.adopted !== true) return null;
  const count = vault.approvals;
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm" data-part="approvals">
      {count === undefined
        ? <p className="text-muted-foreground" data-unreadable="approvals">{t('vault.approvals.unread')}</p>
        : <p data-vault-approvals={count}>{t('vault.approvals', { count })}</p>}
      <Button size="sm" variant="outline" disabled={count === undefined} data-action="change-approvals"
        onClick={() => inPanel(t('vault.approvals.change'), () => <ChangeThreshold vault={vault.vault} />)}>
        {t('vault.approvals.change')}
      </Button>
    </div>
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
 * with its balance, whether it is private or public, and sending it, which
 * opens a one-off payment in that currency in the shell's panel, and shielding
 * or unshielding it, not built yet and so disabled. Tabs show
 * every row, those held privately or those held publicly. Checking again is
 * on the title line, with how long ago it was read. Under the table, a side
 * that could not be read says so, and for the private side says why; a
 * vault that holds nothing privately yet and a private record that was not
 * believed each say that; a currency the registry does not know is counted.
 */
function MoneyHeld({ company, vault, deposited }: { company: string; vault: string; deposited: number }) {
  const t = useText();
  const { inPanel } = useVaultActions();
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
          <IconAction icon={SentIcon} label={t('vault.money.send')} onPress={() => inPanel(t('oneOff.title'), () => <OneOffPayment vault={vault} symbol={r.amount.symbol} />)} data-action="send" />
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

/**
 * What the company's runs pay out of this vault, one row a currency of a run. Pay opens in the shell's panel, which keeps the
 * result when the records are read again after a payment, which a result drawn here would not. It is offered for a leg of a run
 * (or a retry on it, from its own proposal) only when the chain shows that proposal approved and the leg not paid in full; the
 * wallet decides again on the window and on what the chain holds before it pays.
 */
function Payouts({ records, vault, number }: { records: CompanyRecords; vault: string; number: number }) {
  const t = useText();
  const month = useMonth();
  const { inPanel } = useVaultActions();
  return (
    <ReadOf read={records.runs}>
      {(runs) => {
        const legs = runs.flatMap((r) => r.legs.filter((l) => l.vault.toLowerCase() === vault.toLowerCase()).map((l) => ({ run: r, leg: l })));
        return (
          <Section
            title={t('vault.payouts')}
            count={legs.length}
            empty={<EmptyState icon={Invoice01Icon}>{t('vault.payouts.none')}</EmptyState>}
            data-part="payouts"
          >
            {legs.map(({ run, leg }, i) => (
              <SectionRow key={i} data-payout={run.id}>
                <PageLink to={PAGE.run} params={{ run: run.id }} className="font-medium underline-offset-4 hover:underline">{month(run.period)}</PageLink>
                <span>{leg.symbol ?? t('records.unrecognisedOne')}</span>
                <span className="text-muted-foreground"><PaidWords paid={leg.paid} /></span>
                <span className="text-muted-foreground">{t('payroll.people', { count: leg.payees })}</span>
                {[{ leg, retry: false }, ...(leg.retries ?? []).filter((r) => r.vault.toLowerCase() === vault.toLowerCase()).map((r) => ({ leg: legOfRetry(leg, r), retry: true }))].filter((p) => canPay(p.leg, records.proposals)).map((p) => (
                  <Button key={p.leg.proposal} size="sm" variant="outline" data-action="pay-run" data-pay-leg={leg.code} data-pay-retry={p.retry ? p.leg.proposal : undefined}
                    onClick={() => inPanel(t('payRun.title', { month: month(run.period) }), () => <PayRun run={run} leg={p.leg} vaultName={t('vaults.tile.name', { number })} />)}>
                    {p.retry ? t('vault.payRetry') : t('vault.pay')}
                  </Button>
                ))}
              </SectionRow>
            ))}
          </Section>
        );
      }}
    </ReadOf>
  );
}


/**
 * The one-off payments the vault's signers have raised that wait on a signer, one row each: who is paid, how much, why, and how many
 * approvals it has of those it needs; nothing is drawn while none waits. Those the chain holds open are listed for approval, Approve
 * and pay; those it holds approved and shows not yet paid are listed apart, with Pay, since paying does not take them off the chain.
 * Either opens the payment in the shell's panel, because the records are read again after the wallet acts and a result drawn here
 * would go with them. A payment shown paid, or whose payment was not read, is not listed.
 */
function OneOffs({ records, vault }: { records: CompanyRecords; vault: string }) {
  const t = useText();
  const { inPanel } = useVaultActions();
  return (
    <ReadOf read={records.proposals}>
      {(proposals) => {
        const waiting = openOneOffsOf(proposals, vault);
        const open = waiting.filter((o) => o.proposal.status !== 'approved');
        const approved = waiting.filter((o) => o.proposal.status === 'approved');
        const rowOf = (o: OneOffRow, press: ReactNode) => (
          <SectionRow key={o.id} data-one-off-row={o.id}>
            <span className="font-medium">{o.payee}</span>
            {o.amount === null ? <span>{t('records.unrecognisedOne')}</span> : <Amount value={o.amount} kind={AMOUNT_KIND.toBePaid} />}
            <span className="text-muted-foreground">{o.reason}</span>
            <span className="text-muted-foreground">{o.needed === null ? t('oneOff.pay.approvalsUnknown', { approvals: o.approvals }) : t('oneOff.pay.approvals', { approvals: o.approvals, needed: o.needed })}</span>
            {press}
          </SectionRow>
        );
        return (
          <>
            {open.length === 0 ? null : (
              <Section title={t('vault.oneOffs')} count={open.length} empty={null} data-part="one-offs">
                {open.map((o) => rowOf(o, (
                  <Button size="sm" variant="outline" data-action="approve-one-off" onClick={() => inPanel(t('oneOff.pay.title'), () => <OneOffPayment vault={vault} pay={o} />)}>
                    {t('vault.oneOffs.approve')}
                  </Button>
                )))}
              </Section>
            )}
            {approved.length === 0 ? null : (
              <Section title={t('vault.oneOffs.approved')} count={approved.length} empty={null} data-part="one-offs-approved">
                {approved.map((o) => rowOf(o, (
                  <Button size="sm" variant="outline" data-action="pay-one-off" onClick={() => inPanel(t('oneOff.paying.title'), () => <OneOffPayment vault={vault} pay={o} />)}>
                    {t('vault.pay')}
                  </Button>
                )))}
              </Section>
            )}
          </>
        );
      }}
    </ReadOf>
  );
}
