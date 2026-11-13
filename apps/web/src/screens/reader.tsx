import { useEffect, useRef, useState } from 'react';
import {
  Alert, AlertDescription, AlertTitle, Button, EmptyState, PageHeader, PageLayout, Section, SectionRow, Spinner, Textarea, useText,
} from 'vaults-ui';
import { Invoice01Icon } from '@hugeicons/core-free-icons';
import { ActRefused } from '../act-refused.js';
import { ACTED } from '../adapters/refusals.js';
import { readerCodeFromTheWallet, type ReaderCode } from '../adapters/reader-join-code.js';
import {
  askForReaderKeys, openAsReader, readerLinkOf, readOpened, READER_WHY, rememberWhyNotOpen, takeWhyNotOpen, type ReaderOpened, type ReaderWhy,
} from '../adapters/reader-open.js';
import { READER_OF, type ReaderCompany, type ReaderLink } from '../adapters/reader-records.js';
import { READ } from '../adapters/reads.js';
import { OF, signIn, type SignInRefusal } from '../adapters/session.js';
import { PAGE } from '../pages.js';
import { Approvals, ProposalStatus, ProposalWhat, ProposalsNotRead, RunMoney, RunStatus, useMonth } from '../records/parts.js';
import { go, useCurrentPage } from '../router.js';
import { useSession, useSessionIfAny } from '../session.js';
import { useVisitor } from '../visitor.js';
import { signInRefusedSays } from './landing.js';

type Words = ReturnType<typeof useText>;
type Open = Extract<ReaderCompany, { readonly of: typeof READER_OF.open }>;
type NotOpen = Exclude<ReaderOpened, { readonly of: typeof READER_OF.open }>;

const WHY_SAYS = (t: Words): Record<ReaderWhy, string> => ({
  [READER_WHY.noGrant]: t('reader.why.no-grant'), [READER_WHY.takenAway]: t('reader.why.taken-away'), [READER_WHY.notAReaderHere]: t('reader.why.not-a-reader-here'), [READER_WHY.notRead]: t('reader.why.not-read'),
  [READER_WHY.notOnChain]: t('reader.why.not-on-chain'), [READER_WHY.notACompany]: t('reader.why.not-a-company'), [READER_WHY.unreached]: t('reader.why.unreached'),
  [READER_WHY.notTheCompanys]: t('reader.why.not-the-companys'), [READER_WHY.noKeys]: t('reader.why.no-keys'), [READER_WHY.other]: t('reader.why.other'),
});

/** What a company that did not open says: the page's own phrase for the reason, or the wallet's refusal in the app's. */
function NotOpened({ closed }: { closed: NotOpen }) {
  const t = useText();
  if (closed.of === ACTED.refused) return <ActRefused why={closed.why} />;
  return (
    <Alert data-reader-closed={closed.why}>
      <AlertTitle>{t('reader.closed.title')}</AlertTitle>
      <AlertDescription>{WHY_SAYS(t)[closed.why]}</AlertDescription>
    </Alert>
  );
}

function NoLink() {
  const t = useText();
  return <div data-screen="reader-no-link"><Alert data-reader-no-link><AlertDescription>{t('reader.noLink')}</AlertDescription></Alert></div>;
}

function CodeMaker({ person, link }: { person: string; link: ReaderLink }) {
  const t = useText();
  const [waiting, setWaiting] = useState(false);
  const [made, setMade] = useState<ReaderCode | null>(null);
  const make = (): void => {
    if (waiting) return;
    setWaiting(true);
    setMade(null);
    void readerCodeFromTheWallet(person, link, t('app.title')).then((r) => { setWaiting(false); setMade(r); });
  };
  return (
    <Section title={t('reader.code.title')} description={t('reader.code.hint')} list={false} data-reader-code>
      <div><Button disabled={waiting} data-action="make-code" onClick={make}>{t('reader.code.make')}</Button></div>
      {waiting ? <p className="flex items-center gap-2 text-sm" role="status"><Spinner aria-label={t('reader.waiting')} />{t('reader.waiting')}</p> : null}
      {made?.of === ACTED.done ? <Textarea readOnly value={made.text} aria-label={t('reader.code.label')} data-field="reader-code-text" /> : null}
      {made?.of === ACTED.refused ? <ActRefused why={made.why} /> : null}
    </Section>
  );
}

function OpenButton({ person, params }: { person: string; params: Record<string, string> }) {
  const t = useText();
  const session = useSession();
  const [waiting, setWaiting] = useState(false);
  const [closed, setClosed] = useState<NotOpen | null>(() => takeWhyNotOpen(params.id ?? ''));
  const link = readerLinkOf(params);
  const open = (): void => {
    if (link === null || waiting) return;
    setWaiting(true);
    setClosed(null);
    void askForReaderKeys(person, link).then((asked) => {
      if (asked.of === 'held') { session.readerOpened?.(); go(PAGE.reader, false, params); return; }
      setWaiting(false);
      setClosed(asked);
    });
  };
  return (
    <Section title={t('reader.open.title')} description={t('reader.open.hint')} list={false} data-reader-open>
      {closed === null ? null : <NotOpened closed={closed} />}
      <div><Button disabled={waiting} data-action="open-company" onClick={open}>{t('reader.open.press')}</Button></div>
      {waiting ? <p className="flex items-center gap-2 text-sm" role="status"><Spinner aria-label={t('reader.waiting')} />{t('reader.waiting')}</p> : null}
    </Section>
  );
}

/** A visitor's sign-in on the reader's link, as the joining page does it. */
function VisitorSignIn() {
  const t = useText();
  const { signedInNow } = useVisitor();
  const [signingIn, setSigningIn] = useState(false);
  const [refusal, setRefusal] = useState<{ readonly why: SignInRefusal; readonly retryAfterSeconds: number | null } | null>(null);
  const start = (): void => {
    setRefusal(null);
    setSigningIn(true);
    void signIn({ name: t('app.title'), purpose: t('signIn.purpose') }).then(async (r) => {
      if (r.of === OF.refused) { setSigningIn(false); setRefusal({ why: r.why, retryAfterSeconds: r.retryAfterSeconds }); return; }
      await signedInNow();
    });
  };
  return (
    <div className="flex flex-col gap-3" data-reader-sign-in>
      <p className="text-sm text-muted-foreground">{t('reader.signIn.why')}</p>
      {refusal === null ? null : (
        <Alert data-refusal={refusal.why}>
          <AlertTitle>{t('signIn.refused.title')}</AlertTitle>
          <AlertDescription>{signInRefusedSays(t, refusal.why, refusal.retryAfterSeconds)}</AlertDescription>
        </Alert>
      )}
      <div><Button disabled={signingIn} data-action="sign-in" onClick={start}>{t('reader.signIn.press')}</Button></div>
    </div>
  );
}

/** The page a reader's link opens: the reader's code to give a signer, and the company to open once access is given. */
export function ReaderSignUp() {
  const t = useText();
  const { params } = useCurrentPage();
  const session = useSessionIfAny();
  const link = readerLinkOf(params);
  if (link === null) return session === null ? <PageLayout><NoLink /></PageLayout> : <NoLink />;
  const page = (
    <div className="flex flex-col gap-6" data-screen="reader-sign-up">
      <PageHeader title={t('reader.signUp.title')} />
      <p className="text-sm text-muted-foreground">{t('reader.signUp.intro')}</p>
      {session === null ? <VisitorSignIn /> : (
        <>
          <CodeMaker person={session.person.id} link={link} />
          <OpenButton person={session.person.id} params={params} />
        </>
      )}
    </div>
  );
  return session === null ? <PageLayout>{page}</PageLayout> : page;
}

function RunsSection({ runs }: { runs: Open['runs'] }) {
  const t = useText();
  const month = useMonth();
  const rows = runs.of === READ.read ? runs.value.rows : [];
  const unread = runs.of === READ.read ? runs.value.unreadable.length : 0;
  return (
    <Section
      title={t('reader.runs.title')} count={rows.length} data-reader-runs
      empty={<EmptyState icon={Invoice01Icon}>{runs.of === 'not-in-access' ? t('reader.runs.notInAccess') : runs.of === READ.read ? t('reader.runs.none') : t('reader.runs.unreadable')}</EmptyState>}
    >
      {rows.map((r) => (
        <SectionRow key={r.id} data-run={r.id}>
          <div className="flex min-w-0 flex-wrap items-center gap-4">
            <span className="font-medium">{month(r.period)}</span>
            <span className="text-muted-foreground">{t('payroll.people', { count: r.payees.length })}</span>
            <RunMoney run={r} />
            <RunStatus run={r} />
          </div>
        </SectionRow>
      ))}
      {unread === 0 ? null : <SectionRow data-runs-not-opened={unread}>{t('reader.runs.someNotOpened', { count: unread })}</SectionRow>}
    </Section>
  );
}

function ProposalsSection({ proposals }: { proposals: Open['proposals'] }) {
  const t = useText();
  const rows = proposals.of === READ.read ? proposals.value : [];
  return (
    <Section
      title={t('reader.proposals.title')} count={rows.length} data-reader-proposals
      empty={<EmptyState icon={Invoice01Icon}>{proposals.of === 'not-in-access' ? t('reader.proposals.notInAccess') : proposals.of === READ.read ? t('reader.proposals.none') : t('reader.proposals.unreadable')}</EmptyState>}
    >
      {rows.map((p) => (
        <SectionRow key={p.id} data-proposal={p.id}>
          <div className="flex min-w-0 flex-wrap items-center gap-4">
            <span className="font-medium"><ProposalWhat row={p} /></span>
            <Approvals row={p} />
            <ProposalStatus row={p} />
          </div>
        </SectionRow>
      ))}
      <ProposalsNotRead rows={rows} />
    </Section>
  );
}

/** What the reader's page is showing: the company being read, open, or a refusal beside what was shown before. Compared by the code. */
const SHOWN = { reading: 'reading', open: 'open', refused: 'refused' } as const;
type Shown = { readonly of: typeof SHOWN.reading } | { readonly of: typeof SHOWN.open; readonly company: Open } | { readonly of: typeof SHOWN.refused; readonly closed: NotOpen; readonly company: Open | null };

/** A reader's company: what its access lets it read, read with the keys the wallet gave this visit, and a check of the access on the press of a button. */
export function Reader() {
  const t = useText();
  const { params } = useCurrentPage();
  const session = useSession();
  const link = readerLinkOf(params);
  const [shown, setShown] = useState<Shown>({ of: SHOWN.reading });
  const [checking, setChecking] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  /* Access that no longer opens clears what was shown, tells the viewer, and sends the reader to the page that says why. */
  const leave = (closed: NotOpen): void => {
    if (link === null) return;
    setShown({ of: SHOWN.reading });
    rememberWhyNotOpen(link.id, closed);
    session.readerOpened?.();
    go(PAGE.readerSignUp, true, params);
  };
  const take = (opened: ReaderOpened): void => {
    if (!alive.current) return;
    if (opened.of === READER_OF.open) setShown({ of: SHOWN.open, company: opened.company });
    else leave(opened);
  };
  useEffect(() => { if (link !== null) void readOpened(link).then(take); }, [params.id]);
  const check = (): void => {
    if (link === null || checking) return;
    setChecking(true);
    void openAsReader(session.person.id, link).then((opened) => {
      if (!alive.current) return;
      setChecking(false);
      /* A wallet that could not be asked says nothing of the access: what is shown stays, and the reason is told. */
      if (opened.of === ACTED.refused) setShown((s) => ({ of: SHOWN.refused, closed: opened, company: s.of === 'open' ? s.company : s.of === 'refused' ? s.company : null }));
      else take(opened);
    });
  };
  if (link === null) return <NoLink />;
  const company = shown.of === 'open' ? shown.company : shown.of === 'refused' ? shown.company : null;
  return (
    <div className="flex flex-col gap-6" data-screen="reader">
      <PageHeader title={t('reader.company', { end: link.label.slice(-6) })} />
      <p className="text-sm text-muted-foreground">{t('reader.company.hint')}</p>
      {shown.of === 'reading' ? <p className="flex items-center gap-2 text-sm" role="status" data-reader-reading><Spinner aria-label={t('reader.reading')} />{t('reader.reading')}</p> : null}
      {shown.of === 'refused' ? <NotOpened closed={shown.closed} /> : null}
      {company === null ? null : (
        <>
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground" data-reader-as-of>{t('reader.asof')}</p>
            <div><Button variant="outline" disabled={checking} data-action="check-access" onClick={check}>{t('reader.check')}</Button></div>
            {checking ? <p className="flex items-center gap-2 text-sm" role="status"><Spinner aria-label={t('reader.waiting')} />{t('reader.waiting')}</p> : null}
          </div>
          <RunsSection runs={company.runs} />
          <ProposalsSection proposals={company.proposals} />
        </>
      )}
    </div>
  );
}
