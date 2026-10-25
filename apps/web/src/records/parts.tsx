import { useEffect, useState, type ReactNode } from 'react';
import { SquareLock02Icon } from '@hugeicons/core-free-icons';
import { Alert, AlertDescription, AlertTitle, Amount, AMOUNT_KIND, AmountLoading, Badge, Button, EmptyState, formatDate, PageLoading, PrivatePill, StatTile, useLanguage, useText, type AmountKind } from 'vaults-ui';
import { isPending, PendingPill, useStandingSays, VaultName } from './vault-pending.js';
import { companyPagesOpen, OPENED, PAID, READ, readVaultPublicMoney, type CompanyRecords, type Paid, type ProposalRow, type Read, type RunRow, type VaultRow } from '../adapters/company-records.js';
import { COULD_NOT_READ, PRIVATE_MONEY, readVaultPrivateMoney, watchPrivateMoneyReadable, type VaultPrivateMoney as VaultPrivateMoneyHeld } from '../adapters/vault-private-money.js';
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
 * be read hides nothing another read. `unreadable`, when given, is the words
 * for the read that could not be read, in place of the general line.
 */
export function ReadOf<T>({ read, unreadable, children }: { read: Read<T>; unreadable?: ReactNode; children: (value: T) => ReactNode }) {
  const t = useText();
  if (read.of === READ.unreadable) return <p className="text-sm text-muted-foreground" data-unreadable>{unreadable ?? t('records.unreadable')}</p>;
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
  /* While these pages are on screen, opening the saved keys opens this company too; leaving them names none. */
  useEffect(() => (shown === null ? undefined : companyPagesOpen(shown)), [shown]);
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

/**
 * AN ACTION NOT BUILT YET: the kit's button, where the action will be and at
 * the size and weight it will have, disabled. Nothing is drawn beside it and
 * nothing appears on hover; the menu entries and page headings of what is not
 * built yet carry the Coming soon pill, never an action.
 */
export function UnbuiltAction({ children, variant = 'default', size = 'default', ...marks }: {
  children: ReactNode; variant?: 'default' | 'outline'; size?: 'default' | 'sm'; 'data-action': string;
}) {
  return <Button variant={variant} size={size} disabled data-soon {...marks}>{children}</Button>;
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
  if (row.pays !== null) {
    const { period, symbol, paid } = row.pays;
    if (symbol === null) {
      const at = { month: month(period) };
      return <>{paid === PAID.privately ? t('proposals.kind.payRunPrivatelyUnknownToken', at) : paid === PAID.publicly ? t('proposals.kind.payRunPubliclyUnknownToken', at) : t('proposals.kind.payRunUnknownToken', at)}</>;
    }
    const said = { month: month(period), token: symbol };
    return <>{paid === PAID.privately ? t('proposals.kind.payRunPrivately', said) : paid === PAID.publicly ? t('proposals.kind.payRunPublicly', said) : t('proposals.kind.payRun', said)}</>;
  }
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

/** A run's money, one token to a line and each split by how it is paid, never added into one figure. */
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

/** Where one side of a vault's money is: being read, or (the public side only) not readable. The private side says what it found itself. */
export const MONEY = { reading: 'reading', unreadable: 'unreadable' } as const;
type Side<T> = T | (typeof MONEY)[keyof typeof MONEY];

/** A vault's money, each side read on its own: what it holds privately, read on this device, and publicly, read from the company's service. */
export interface VaultMoney {
  private: typeof MONEY.reading | VaultPrivateMoneyHeld;
  public: Side<VaultPublicMoneyHeld>;
}

/**
 * WHAT A VAULT HOLDS, READ WHEN IT IS SHOWN, EACH TIME `asked` CHANGES, AND
 * EACH TIME THE PERSON'S WALLET RELEASES THE COMPANY'S KEY TO THIS TAB (which
 * the private side needs): privately on this device, with this signer's own
 * keys, and publicly from the company's service. Each side is read on its own, and one that could not
 * be read is said as that, never as nothing held. The private side keeps
 * what it found: amounts, nothing held yet, a record not believed, or why it
 * could not be read.
 */
export function useVaultMoney(company: string, vault: string, asked = 0): VaultMoney {
  const { person } = useSession();
  const [money, setMoney] = useState<VaultMoney>({ private: MONEY.reading, public: MONEY.reading });
  const [released, setReleased] = useState(0);
  useEffect(() => watchPrivateMoneyReadable(company, () => setReleased((n) => n + 1)), [company]);
  useEffect(() => {
    let alive = true;
    setMoney({ private: MONEY.reading, public: MONEY.reading });
    void readVaultPrivateMoney(person.id, company, vault).then((h) => { if (alive) setMoney((m) => ({ ...m, private: h })); });
    void readVaultPublicMoney(person.id, company, vault).then((h) => { if (alive) setMoney((m) => ({ ...m, public: h ?? MONEY.unreadable })); });
    return () => { alive = false; };
  }, [person.id, company, vault, asked, released]);
  return money;
}

/**
 * THE SENTENCE FOR A PRIVATE SIDE THAT HAS NO AMOUNT TO SHOW: nothing held
 * yet, a record that was not believed, or why it could not be read. Each
 * says only what is true of it: a pool never opened is not a failure, a
 * record no seat signed is not a read that failed, and a read that failed
 * names its reason and how to try again, which differs on a tile (open the
 * vault) and on the vault's page, where a read that a refresh cannot clear (no
 * keys open in this tab, no record on this device) names the step that clears
 * it, and the others its refresh button. `tile` says it is on a tile.
 */
export function PrivateMoneyUnshown({ money, tile = false }: { money: Exclude<VaultPrivateMoneyHeld, { of: typeof PRIVATE_MONEY.held }>; tile?: boolean }) {
  const t = useText();
  if (money.of === PRIVATE_MONEY.nothingYet) return <span data-private-money={money.of}>{t('vault.privateMoney.nothingYet')}</span>;
  if (money.of === PRIVATE_MONEY.notBelieved) {
    return <span data-private-money={money.of}>{tile ? t('vaults.privateMoney.notBelieved') : t('vault.privateMoney.notBelieved')}</span>;
  }
  const why = {
    [COULD_NOT_READ.noKeys]: t('vault.privateMoney.why.noKeys'),
    [COULD_NOT_READ.walletRefused]: t('vault.privateMoney.why.walletRefused'),
    [COULD_NOT_READ.chain]: t('vault.privateMoney.why.chain'),
    [COULD_NOT_READ.layout]: t('vault.privateMoney.why.layout'),
    [COULD_NOT_READ.record]: t('vault.privateMoney.why.record'),
    [COULD_NOT_READ.other]: t('vault.privateMoney.why.other'),
  }[money.why];
  const next = money.why === COULD_NOT_READ.noKeys ? t('vault.privateMoney.next.noKeys')
    : money.why === COULD_NOT_READ.record ? t('vault.privateMoney.next.record') : t('vault.privateMoney.next.again');
  return <span data-unreadable="private" data-why={money.why}>{tile ? t('vaults.privateMoney.cannotRead', { why }) : t('vault.privateMoney.cannotRead', { why, next })}</span>;
}

/**
 * A VAULT'S MONEY ON ITS TILE: each token it holds on a line of its own,
 * with its Private or Public pill, never added together. A side being read is
 * a bar; the private side says nothing is held yet, that its record was not
 * believed, or why it could not be read, and the public side that it could not
 * be read; a token the registry does not know is counted on either side.
 */
function VaultMoneyLines({ money }: { money: VaultMoney }) {
  const t = useText();
  const priv = money.private;
  const pub = money.public;
  const holdsNone = priv !== MONEY.reading && priv.of === PRIVATE_MONEY.held && typeof pub !== 'string'
    && priv.amounts.length === 0 && priv.unrecognised === 0 && pub.amounts.length === 0 && pub.unrecognised === 0;
  return (
    <span className="flex flex-col gap-1" data-money-lines>
      {priv === MONEY.reading ? <AmountLoading /> : null}
      {priv === MONEY.reading || priv.of === PRIVATE_MONEY.held ? null : <span className="text-muted-foreground"><PrivateMoneyUnshown money={priv} tile /></span>}
      {priv === MONEY.reading || priv.of !== PRIVATE_MONEY.held ? null : priv.amounts.map((a) => (
        <span key={a.symbol} className="flex flex-wrap items-center gap-1.5" data-held={a.symbol} data-visibility="private"><Amount value={a} kind={AMOUNT_KIND.held} /><PrivatePill /></span>
      ))}
      {priv === MONEY.reading || priv.of !== PRIVATE_MONEY.held || priv.unrecognised === 0 ? null : <span data-unrecognised={priv.unrecognised} data-side="private">{t('vault.privateMoney.unrecognised', { count: priv.unrecognised })}</span>}
      {pub === MONEY.reading ? <AmountLoading /> : null}
      {pub === MONEY.unreadable ? <span className="text-muted-foreground" data-unreadable="public">{t('vaults.publicMoney.unreadable')}</span> : null}
      {typeof pub === 'string' ? null : (
        <>
          {pub.amounts.map((a) => <span key={a.symbol} data-held={a.symbol} data-visibility="public"><Amount value={a} kind={AMOUNT_KIND.held} /></span>)}
          {pub.unrecognised === 0 ? null : <span data-unrecognised={pub.unrecognised} data-side="public">{t('vault.publicMoney.unrecognised', { count: pub.unrecognised })}</span>}
        </>
      )}
      {holdsNone ? <span className="text-muted-foreground" data-holds-none>{t('vaults.money.none')}</span> : null}
    </span>
  );
}

/**
 * A VAULT'S TILE, the kit's stat tile, linking to the vault's page: its name,
 * with the Pending pill when it waits on something, where it stands when it
 * does not, when it was created, and each token it holds on a line with
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
      title={<span className="flex flex-wrap items-center gap-2"><span><VaultName company={company} vault={vault} number={index + 1} /></span><PendingPill vault={vault} /></span>}
      tagline={isPending(vault.standing) ? undefined : <span data-standing={vault.standing}>{says(vault.standing)}</span>}
      subtext={t('vaults.tile.created', { date: day(vault.createdAt) })}
    >
      <span className="pt-2"><VaultMoneyLines money={money} /></span>
    </StatTile>
  );
}
