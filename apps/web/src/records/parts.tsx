import { useState, type HTMLAttributes, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle, Amount, AMOUNT_KIND, Badge, Button, ComingSoon, formatDate, Skeleton, useLanguage, useText, type AmountKind } from 'vaults-ui';
import { OPENED, PAID, READ, VAULT, type CompanyRecords, type Paid, type ProposalRow, type Read, type RunRow, type VaultRow, type VaultStanding } from '../adapters/company-records.js';
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

/** Placeholder rows while something is read, the shape of what will be there and nothing that could be read as an answer. */
export function Rows({ count = 3 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-busy={true} data-reading>
      {Array.from({ length: count }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}
    </div>
  );
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
 * not, and what opens them. Placeholder rows while they are read.
 */
export function WithRecords({ children }: { children: (records: CompanyRecords) => ReactNode }) {
  const t = useText();
  const { company: shown } = useSession();
  const { company, openKeys, reload } = useCompanyRecords();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<ActRefusal | null>(null);
  if (shown === null) return <p className="text-sm text-muted-foreground" data-no-company>{t('records.noCompany')}</p>;
  if (company === null) return <Rows />;
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
    <section className="flex max-w-xl flex-col gap-3" data-records={company.of}>
      <h2 className="text-base font-semibold">{t('records.locked.title')}</h2>
      <p className="text-sm text-muted-foreground">{t('records.locked.body')}</p>
      <div><Button disabled={busy} onClick={() => { void open(); }} data-action="open-with-your-account">{t('records.locked.open')}</Button></div>
      {refused === null ? null : <ActRefused why={refused} />}
    </section>
  );
}

/** An action not built yet: always shown, never pressable, with the Coming soon pill saying what it will do. */
export function SoonAction({ label, soon, ...marks }: { label: string; soon: string } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className="inline-flex items-center gap-2" {...marks} data-soon>
      <Button variant="outline" size="sm" disabled>{label}</Button>
      <ComingSoon explanation={soon} />
    </span>
  );
}

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

/** Where a vault stands, in words. */
export function VaultStandingWords({ standing }: { standing: VaultStanding }) {
  const t = useText();
  const says: Record<VaultStanding, string> = {
    [VAULT.held]: t('vaults.standing.held'),
    [VAULT.handoverOwed]: t('vaults.standing.handoverOwed'),
    [VAULT.notOnChain]: t('vaults.standing.notOnChain'),
    [VAULT.notFundable]: t('vaults.standing.notFundable'),
    [VAULT.accountNotHandedOver]: t('vaults.standing.accountNotHandedOver'),
    [VAULT.accountNotFundable]: t('vaults.standing.accountNotFundable'),
    [VAULT.heldByOtherKeys]: t('vaults.standing.heldByOtherKeys'),
    [VAULT.unknown]: t('vaults.standing.unknown'),
  };
  return <span data-standing={standing}>{says[standing]}</span>;
}

/**
 * A VAULT'S TILE: when it was created, where it stands, and its money on two
 * lines. The private line is read on a signer's device, which this page does
 * not do yet, so it is Coming soon and never shown as nothing; the public
 * line is read on the vault's page, when the person asks.
 */
export function VaultTile({ vault, index }: { vault: VaultRow; index: number }) {
  const t = useText();
  const day = useDay();
  return (
    <PageLink to={PAGE.vault} params={{ vault: vault.vault }} className="flex flex-col gap-2 rounded-lg border p-4 hover:bg-accent" data-vault={vault.vault}>
      <span className="font-medium">{t('vaults.tile.name', { number: index + 1 })}</span>
      <span className="text-xs text-muted-foreground">{t('vaults.tile.created', { date: day(vault.createdAt) })}</span>
      <span className="text-sm"><VaultStandingWords standing={vault.standing} /></span>
      <span className="flex items-center gap-2 text-sm text-muted-foreground" data-private-line>
        {t('vaults.privateMoney')}<ComingSoon explanation={t('vaults.privateMoney.soon')} />
      </span>
      <span className="text-sm text-muted-foreground" data-public-line>{t('vaults.publicMoney.onItsPage')}</span>
    </PageLink>
  );
}
