import { useEffect, useState, type ReactNode } from 'react';
import { SquareLock02Icon } from '@hugeicons/core-free-icons';
import { Alert, AlertDescription, AlertTitle, Amount, AMOUNT_KIND, AmountLoading, Badge, Button, EmptyState, formatDate, PageLoading, PrivatePill, StatTile, useLanguage, useText, type AmountKind } from 'vaults-ui';
import { isPending, PendingPill, useStandingSays } from './vault-pending.js';
import { OPENED, PAID, READ, readVaultPublicMoney, type CompanyRecords, type Paid, type ProposalRow, type Read, type RunRow, type VaultRow } from '../adapters/company-records.js';
import { readVaultPrivateMoney, type VaultPrivateMoney as VaultPrivateMoneyHeld } from '../adapters/vault-private-money.js';
import type { VaultPublicMoney as VaultPublicMoneyHeld } from '../adapters/vault-public-money.js';
import type { ActRefusal } from '../adapters/refusals.js';
import { ActRefused } from '../act-refused.js';
import { PAGE } from '../pages.js';
import { PageLink } from '../router.js';
import { useSession } from '../session.js';
import { useCompanyRecords } from './company-records.js';

/*
 * THE PIECES THE PAGES THAT READ ARE MADE OF: the company's records opened or
 * the reason they are not, one read's rows or the reason they could not be
 * read, and the ways the same thing is shown on more than one page (a month,
 * a day, what a proposal does, a vault's tile, an action not built yet).
 */

/** How a day and a month are written: in the person's language. A run's month is read as written, in no time zone, so it is the same month everywhere. */
const DAY = { dateStyle: 'medium' } as const;
const MONTH = { month: 'long', year: 'numeric', timeZone: 'UTC' } as const;

/** A day the service wrote, in the person's language, for a phrase to carry; empty when the service wrote no day. */
export function useDay(): (at: string) => string {
  const language = useLanguage();
  return (at) => {
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? '' : formatDate(d, language, DAY);
  };
}

/** A day the service wrote, in the person's language, on its own. */
export function Day({ at }: { at: string }) {
  const day = useDay();
  return <time dateTime={at}>{day(at)}</time>;
}

/** A run's month, in the person's language. */
export function useMonth(): (period: string) => string {
  const language = useLanguage();
  return (period) => {
    /* A month written as the service writes one (`2026-10`) is read as its first day, in no time zone. */
    const d = new Date(period);
    return Number.isNaN(d.getTime()) ? period : formatDate(d, language, MONTH);
  };
}

/**
 * ONE READ: its rows when it was read, and a line saying so when it could not
 * be. Each read on a page is shown this way on its own, so one that could not
 * be read hides nothing another read.
 */
export function ReadOf<T>({ read, children }: { read: Read<T>; children: (value: T) => ReactNode }) {
  const t = useText();
  if (read.of === READ.unreadable) return <p className="text-sm text-muted-foreground" data-unreadable>{t('records.unreadable')}</p>;
  return <>{children(read.value)}</>;
}

/**
 * THE SHOWN COMPANY'S RECORDS, OPENED, handed to `children`; or why they are
 * not, and what opens them. The kit's page loading while they are read.
 */
export function WithRecords({ children }: { children: (records: CompanyRecords) => ReactNode }) {
  const t = useText();
  const { company: shown } = useSession();
  const { company, openKeys, reload } = useCompanyRecords();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<ActRefusal | null>(null);
  if (shown === null) return <p className="text-sm text-muted-foreground" data-no-company>{t('records.noCompany')}</p>;
  if (company === null) return <PageLoading data-reading="" />;
  if (company.of === OPENED.open) return <>{children(company)}</>;
  if (company.of === OPENED.refused) {
    return (
      <div className="flex max-w-xl flex-col gap-3" data-records={company.of}>
        <ActRefused why={company.why} />
        <div><Button variant="outline" onClick={reload} data-action="read-again">{t('records.readAgain')}</Button></div>
      </div>
    );
  }
  if (company.of === OPENED.noKeysHere) {
    return (
      <Alert className="max-w-xl" data-records={company.of}>
        <AlertTitle>{t('records.noKeysHere.title')}</AlertTitle>
        <AlertDescription>{t('act.refused.noKeysHere')}</AlertDescription>
      </Alert>
    );
  }
  const open = async (): Promise<void> => {
    setBusy(true); setRefused(null);
    setRefused(await openKeys());
    setBusy(false);
  };
  return (
    <div className="flex flex-col gap-3" data-records={company.of}>
      <EmptyState
        icon={SquareLock02Icon}
        title={t('records.locked.title')}
        action={<Button disabled={busy} onClick={() => { void open(); }} data-action="open-with-your-account">{t('records.locked.open')}</Button>}
      >
        {t('records.locked.body')}
      </EmptyState>
      {refused === null ? null : <ActRefused why={refused} />}
    </div>
  );
}

/* An action not built yet is the kit's; re-exported so the screens that read keep importing it from here. */
export { SoonAction } from 'vaults-ui';

/** How a payment is made, in words: privately, publicly, not set up yet, or not known. A public payment's amount, and one not known, carries the Public pill where it is shown. */
export function PaidWords({ paid }: { paid: Paid }) {
  const t = useText();
  const says: Record<Paid, string> = {
    [PAID.privately]: t('records.paid.privately'),
    [PAID.publicly]: t('records.paid.publicly'),
    [PAID.notSetUp]: t('records.paid.notSetUp'),
    [PAID.notKnown]: t('records.paid.notKnown'),
  };
  return <span data-paid={paid}>{says[paid]}</span>;
}

/** What each kind of proposal does, by the kind the service's record names, in plain words. */
const KIND_SAYS: Readonly<Record<ProposalRow['kind'], (t: ReturnType<typeof useText>) => string>> = {
  transfer: (t) => t('proposals.kind.transfer'),
  payroll: (t) => t('proposals.kind.payroll'),
  'add-signer': (t) => t('proposals.kind.addSigner'),
  'remove-signer': (t) => t('proposals.kind.removeSigner'),
  'set-threshold': (t) => t('proposals.kind.setThreshold'),
  'set-vault-threshold': (t) => t('proposals.kind.setVaultThreshold'),
  'change-policy': (t) => t('proposals.kind.changePolicy'),
};

/** What a proposal does, in plain words; a kind this does not know is said as a change to the company, never as nothing. */
export function ProposalWhat({ row }: { row: ProposalRow }) {
  const t = useText();
  const month = useMonth();
  if (row.pays !== null) return <>{t('proposals.kind.payRun', { month: month(row.pays.period), currency: row.pays.currency })}</>;
  const says = KIND_SAYS[row.kind] as ((x: typeof t) => string) | undefined;
  return <>{says === undefined ? t('proposals.kind.other') : says(t)}</>;
}

/** How many have approved a proposal, and of how many when the record says. */
export function Approvals({ row }: { row: ProposalRow }) {
  const t = useText();
  return <span data-approvals>{row.needed === null ? t('proposals.approvals', { count: row.approvals }) : t('proposals.approvalsOf', { have: row.approvals, count: row.needed })}</span>;
}

/** Where a proposal stands, in words. */
export function ProposalStatus({ row }: { row: ProposalRow }) {
  const t = useText();
  const says: Record<ProposalRow['status'], string> = {
    open: t('proposals.status.open'),
    approved: t('proposals.status.approved'),
    executed: t('proposals.status.executed'),
    rejected: t('proposals.status.rejected'),
    blocked: t('proposals.status.blocked'),
    cancelled: t('proposals.status.cancelled'),
  };
  return <Badge variant={row.status === 'open' ? 'default' : 'outline'} data-status={row.status}>{says[row.status]}</Badge>;
}

/** Where a run stands, in words; a paid run says the day it was paid. */
export function RunStatus({ run }: { run: RunRow }) {
  const t = useText();
  const day = useDay();
  if (run.status === 'settled') {
    return <span data-status={run.status}>{run.settledAt === null ? t('payroll.status.paid') : t('payroll.status.paidOn', { date: day(run.settledAt) })}</span>;
  }
  return <span data-status={run.status}>{run.status === 'draft' ? t('payroll.status.draft') : t('payroll.status.proposed')}</span>;
}

/**
 * What a run's amounts are for the Public pill: payments made once the run is
 * paid, and before that payments to be made, so the pill never says anyone
 * received what has not been paid.
 */
export const paymentKindOf = (run: RunRow): AmountKind => (run.status === 'settled' ? AMOUNT_KIND.paid : AMOUNT_KIND.toBePaid);

/** A run's money, one currency to a line and each split by how it is paid, never added into one figure. */
export function RunMoney({ run }: { run: RunRow }) {
  const t = useText();
  return (
    <div className="flex flex-col gap-1" data-run-money>
      {run.currencies.map((c) => (
        <div key={c.code} className="flex flex-col gap-0.5" data-currency={c.code}>
          {c.privately === null ? null : <span className="flex flex-wrap items-center gap-1.5"><span className="text-xs text-muted-foreground">{t('payroll.runTotal.privately')}</span><Amount value={c.privately} kind={paymentKindOf(run)} /></span>}
          {c.publicly === null ? null : <span className="flex flex-wrap items-center gap-1.5"><span className="text-xs text-muted-foreground">{t('payroll.runTotal.publicly')}</span><Amount value={c.publicly} kind={paymentKindOf(run)} /></span>}
        </div>
      ))}
      {run.unrecognised === 0 ? null : <span className="text-xs text-muted-foreground" data-unrecognised={run.unrecognised}>{t('records.unrecognised', { count: run.unrecognised })}</span>}
    </div>
  );
}

/** Where one side of a vault's money is: being read, or not readable. */
export const MONEY = { reading: 'reading', unreadable: 'unreadable' } as const;
type Side<T> = T | (typeof MONEY)[keyof typeof MONEY];

/** A vault's money, each side read on its own: what it holds privately, read on this device, and publicly, read from the company's service. */
export interface VaultMoney {
  private: Side<VaultPrivateMoneyHeld>;
  public: Side<VaultPublicMoneyHeld>;
}

/**
 * WHAT A VAULT HOLDS, READ WHEN IT IS SHOWN AND EACH TIME `asked` CHANGES:
 * privately on this device, with this signer's own keys, and publicly from
 * the company's service. Each side is read on its own, and one that could not
 * be read is said as that, never as nothing held.
 */
export function useVaultMoney(company: string, vault: string, asked = 0): VaultMoney {
  const { person } = useSession();
  const [money, setMoney] = useState<VaultMoney>({ private: MONEY.reading, public: MONEY.reading });
  useEffect(() => {
    let alive = true;
    setMoney({ private: MONEY.reading, public: MONEY.reading });
    void readVaultPrivateMoney(person.id, company, vault).then((h) => { if (alive) setMoney((m) => ({ ...m, private: h ?? MONEY.unreadable })); });
    void readVaultPublicMoney(person.id, company, vault).then((h) => { if (alive) setMoney((m) => ({ ...m, public: h ?? MONEY.unreadable })); });
    return () => { alive = false; };
  }, [person.id, company, vault, asked]);
  return money;
}

/**
 * A VAULT'S MONEY ON ITS TILE: each currency it holds on a line of its own,
 * with its Private or Public pill, never added together. A side being read is
 * a bar; a side that could not be read says so; a currency the registry does
 * not know is counted.
 */
function VaultMoneyLines({ money }: { money: VaultMoney }) {
  const t = useText();
  const priv = money.private;
  const pub = money.public;
  const holdsNone = typeof priv !== 'string' && typeof pub !== 'string' && priv.amounts.length === 0 && pub.amounts.length === 0 && pub.unrecognised === 0;
  return (
    <span className="flex flex-col gap-1" data-money-lines>
      {priv === MONEY.reading ? <AmountLoading /> : null}
      {priv === MONEY.unreadable ? <span className="text-muted-foreground" data-unreadable="private">{t('vaults.privateMoney.unreadable')}</span> : null}
      {typeof priv === 'string' ? null : priv.amounts.map((a) => (
        <span key={a.code} className="flex flex-wrap items-center gap-1.5" data-held={a.code} data-visibility="private"><Amount value={a} kind={AMOUNT_KIND.held} /><PrivatePill /></span>
      ))}
      {pub === MONEY.reading ? <AmountLoading /> : null}
      {pub === MONEY.unreadable ? <span className="text-muted-foreground" data-unreadable="public">{t('vaults.publicMoney.unreadable')}</span> : null}
      {typeof pub === 'string' ? null : (
        <>
          {pub.amounts.map((a) => <span key={a.code} data-held={a.code} data-visibility="public"><Amount value={a} kind={AMOUNT_KIND.held} /></span>)}
          {pub.unrecognised === 0 ? null : <span data-unrecognised={pub.unrecognised}>{t('vault.publicMoney.unrecognised', { count: pub.unrecognised })}</span>}
        </>
      )}
      {holdsNone ? <span className="text-muted-foreground" data-holds-none>{t('vaults.money.none')}</span> : null}
    </span>
  );
}

/**
 * A VAULT'S TILE, the kit's stat tile, linking to the vault's page: its name,
 * with the Pending pill when it waits on something, where it stands when it
 * does not, when it was created, and each currency it holds on a line with
 * its Private or Public pill. No change badge is shown: nothing here has an
 * amount to compare with.
 */
export function VaultTile({ company, vault, index }: { company: string; vault: VaultRow; index: number }) {
  const t = useText();
  const day = useDay();
  const says = useStandingSays();
  const money = useVaultMoney(company, vault.vault);
  return (
    <StatTile
      link={<PageLink to={PAGE.vault} params={{ vault: vault.vault }} data-vault={vault.vault} />}
      title={<span className="flex flex-wrap items-center gap-2"><span>{t('vaults.tile.name', { number: index + 1 })}</span><PendingPill vault={vault} /></span>}
      tagline={isPending(vault.standing) ? undefined : <span data-standing={vault.standing}>{says(vault.standing)}</span>}
      subtext={t('vaults.tile.created', { date: day(vault.createdAt) })}
    >
      <span className="pt-2"><VaultMoneyLines money={money} /></span>
    </StatTile>
  );
}
