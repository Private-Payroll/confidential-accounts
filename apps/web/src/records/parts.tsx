import { useEffect, useState, type ReactNode } from 'react';
import { SquareLock02Icon } from '@hugeicons/core-free-icons';
import { Alert, AlertDescription, AlertTitle, Amount, AMOUNT_KIND, AmountFigureOnly, AmountLoading, Badge, Button, EmptyState, formatDate, PageLoading, PrivatePill, StatTile, useLanguage, useText, type AmountKind, type TokenAmount } from 'vaults-ui';
import { isPending, PendingPill, useStandingSays, VaultName } from './vault-pending.js';
import { ADMIT_BY, companyPagesOpen, INVITED, OPENED, PAID, READ, readVaultPublicMoney, STANDING, visibilityKnown, type AdmitBy, type CompanyRecords, type InvitationRow, type Paid, type PersonRow, type PersonStanding, type ProposalRow, type Read, type RunRow, type VaultRow, type VendorRow } from '../adapters/company-records.js';
import { COULD_NOT_READ, PRIVATE_MONEY, readVaultPrivateMoney, watchPrivateMoneyReadable, type VaultPrivateMoney as VaultPrivateMoneyHeld } from '../adapters/vault-private-money.js';
import type { VaultPublicMoney as VaultPublicMoneyHeld } from '../adapters/vault-public-money.js';
import { PERSON_KIND, type PersonKind } from '../adapters/person-acts.js';
import type { ActRefusal } from '../adapters/refusals.js';
import { ActRefused } from '../act-refused.js';
import { AdmitPerson } from '../actions/admit.js';
import { PAGE } from '../pages.js';
import { PageLink } from '../router.js';
import { useSession } from '../session.js';
import { usePanel } from '../shell/right-panel.js';
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

/**
 * A calendar date (the start, end and leaving dates: `YYYY-MM-DD`) shown as written. It is built and shown in UTC, so it
 * never moves a day with the viewer's zone, which `useDay` does with a string it reads as UTC midnight. Anything else gives ''.
 */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const CALENDAR_DAY = { ...DAY, timeZone: MONTH.timeZone } as const;
export function useCalendarDay(): (date: string) => string {
  const language = useLanguage();
  return (date) => {
    if (!CALENDAR_DATE.test(date)) return '';
    const d = new Date(Date.parse(date));
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date ? '' : formatDate(d, language, CALENDAR_DAY);
  };
}

/** A calendar date as the day it is, or as written when it is not one; the one way a date of a record is written in a phrase. */
export function useDayAsWritten(): (date: string) => string {
  const calendar = useCalendarDay();
  return (date) => calendar(date) || date;
}

/** A calendar date of a record shown as the day it is, or Not set when the record holds none. */
export function CalendarDate({ date }: { date: string | null }) {
  const t = useText();
  const written = useDayAsWritten();
  return date === null ? <>{t('people.notSet')}</> : <time dateTime={date}>{written(date)}</time>;
}

/** A moment (an ISO UTC time) shown with its date and time in the viewer's own zone. Anything that is not a moment gives ''. */
const MOMENT = { dateStyle: 'medium', timeStyle: 'short' } as const;
export function useMoment(): (at: string) => string {
  const language = useLanguage();
  return (at) => {
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? '' : formatDate(d, language, MOMENT);
  };
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

/** One person or vendor who accepted and is waiting for the fingerprint check: what the one admit control is asked for. */
interface WaitingOne { readonly id: string; readonly name: string; readonly kind: PersonKind; readonly admitBy: AdmitBy }


/**
 * Everyone waiting for the check, employees first and then vendors, from the two whole-or-nothing reads: unreadable if either could not be
 * read or left someone out, so a list or a count is never taken for everyone when it is not.
 */
export function waitingRead(records: CompanyRecords): Read<readonly WaitingOne[]> {
  const { people, vendors } = records;
  if (people.of === READ.unreadable || vendors === undefined || vendors.of === READ.unreadable) return { of: READ.unreadable };
  const waiting = <T extends { standing: PersonStanding }>(rows: readonly T[]): T[] => rows.filter((r) => r.standing === STANDING.waitingForCheck);
  return {
    of: READ.read,
    value: [
      ...waiting(people.value).map((p) => ({ id: p.id, name: p.name, kind: PERSON_KIND.employee, admitBy: p.admitBy })),
      ...waiting(vendors.value.vendors).map((v) => ({ id: v.id, name: v.name, kind: PERSON_KIND.vendor, admitBy: v.admitBy })),
    ],
  };
}


/** The words for who an invitation is for, used by the sent links and by the people waiting for the check: one set, so the two lists say the same. */
export function useInvitedKindSays(): Record<InvitationRow['kind'], string> {
  const t = useText();
  return { [INVITED.signer]: t('invitations.kind.signer'), [INVITED.employee]: t('invitations.kind.employee'), [INVITED.vendor]: t('invitations.kind.vendor') };
}


/** A person or vendor waiting for the check: their name, and under it whether they are to be paid as an employee or as a vendor. */
export function WaitingName({ one }: { one: WaitingOne }) {
  const says = useInvitedKindSays();
  return (
    <span className="flex flex-col">
      <span className="font-medium">{one.name}</span>
      <span className="text-xs text-muted-foreground" data-kind={one.kind}>{says[one.kind]}</span>
    </span>
  );
}


/** THE FINGERPRINT CHECK, FROM A LIST: opens the one admit control (`AdmitPerson`) in the right-hand panel, where its answer survives the records being read again. Named for what the person is asked to do: check a fingerprint, or admit on a wallet's signed claim. */
export function CheckFingerprint({ one, size = 'default' }: { one: WaitingOne; size?: 'default' | 'sm' }) {
  const t = useText();
  const panel = usePanel();
  const open = (): void => panel.open({ title: t('people.admit.title'), description: one.name, body: <AdmitPerson person={one} /> });
  return <Button size={size} onClick={open} data-action="check-fingerprint">{one.admitBy === ADMIT_BY.fingerprint ? t('people.checkFingerprint') : t('people.admit.button')}</Button>;
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

/** Where a person stands, in the page's words: the badge the People page's list and a person's panel both show. */
export function StandingBadge({ standing }: { standing: PersonStanding }) {
  const t = useText();
  const says: Record<PersonStanding, string> = {
    [STANDING.invited]: t('people.standing.invited'),
    [STANDING.waitingForCheck]: t('people.standing.waitingForCheck'),
    [STANDING.active]: t('people.standing.active'),
    [STANDING.leaver]: t('people.standing.left'),
  };
  return <Badge variant="outline" data-standing={standing}>{says[standing]}</Badge>;
}


/**
 * An amount somebody is paid: with the Public pill when their address says the payment is public, and with none when no address decides that
 * yet (`visibilityKnown`), so a person with no payment address is never told their amounts are public, nor private. The figure and its symbol
 * are shown either way; the words beside it (`PaidWords`) say no address is set.
 */
export function PayAmount({ amount, paid }: { amount: TokenAmount; paid: Paid }) {
  if (visibilityKnown(paid)) return <Amount value={amount} kind={AMOUNT_KIND.toBePaid} />;
  return <span className="inline-flex items-center gap-1" data-pay-unset><AmountFigureOnly value={amount} /><span dir="ltr">{amount.symbol}</span></span>;
}

/** A person's pay, or that their token is not one this app knows. */
export function PayOf({ person }: { person: PersonRow }) {
  const t = useText();
  return person.pay === null ? <>{t('records.unrecognisedOne')}</> : <PayAmount amount={person.pay} paid={person.paid} />;
}

/** How a vendor is paid: one-off payments, or a monthly amount in a token, or a monthly amount in a token this app does not know, which is not shown. A vendor paid one-off has no token (`asset` is set for monthly terms only). */
export function TermsOf({ vendor }: { vendor: VendorRow }) {
  const t = useText();
  if (vendor.asset === null) return <span data-terms-of>{t('invite.terms.oneOff')}</span>;
  return (
    <span data-terms-of>
      {t('vendors.terms.monthly')} {vendor.monthly === null ? t('records.unrecognisedOne') : <PayAmount amount={vendor.monthly} paid={vendor.paid} />}
    </span>
  );
}

/** The marks the notice of what the belief check left out is found by on each page, which tests read and a person never sees. */
export const BELIEF = { people: 'data-people-belief', vendors: 'data-vendors-belief' } as const;

/**
 * What this device's belief check left out of a page's people or vendors, said once above the list: the records it does not believe, counted
 * because it can name none; the records that do not read as a person's (`refused`); and the active ones it believes and will not pay, each with
 * why, who are in the list too, marked. Nothing when nothing was left out. The page gives the words, one sentence for each.
 */
export function BeliefLeftOut({ mark, title, notBelieved, refused = [], notPayable }: {
  mark: (typeof BELIEF)[keyof typeof BELIEF]; title: string; notBelieved: { readonly count: number; readonly words: string } | null;
  refused?: readonly { readonly id: string; readonly words: string }[]; notPayable: readonly { readonly id: string; readonly words: string }[];
}) {
  if (notBelieved === null && refused.length === 0 && notPayable.length === 0) return null;
  const marks: Record<string, true> = { [mark]: true };
  return (
    <Alert {...marks}>
      <AlertTitle>{title}</AlertTitle>
      {notBelieved === null ? null : <AlertDescription data-not-believed={notBelieved.count}>{notBelieved.words}</AlertDescription>}
      {refused.map((r) => <AlertDescription key={r.id} data-refused={r.id}>{r.words}</AlertDescription>)}
      {notPayable.map((n) => <AlertDescription key={n.id} data-not-payable={n.id}>{n.words}</AlertDescription>)}
    </Alert>
  );
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
