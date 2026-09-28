import { Suspense, useCallback, useEffect, useState } from 'react';
import { Button, Skeleton, useText } from 'vaults-ui';
import { OF, signOut as endSignIn, whoIsSignedIn, type Company, type Person, type WhoIsSignedIn } from './adapters/session.js';
import { HOME, isBuilt, mayOpen, outerOf, PAGES, VIEWS, viewFor, type Page, type PageId, type Params, type View, type Viewer } from './pages.js';
import type { Preferences } from './preferences.js';
import { go, homeOf, RESOLVED, resolve, useAddress, CurrentPageProvider } from './router.js';
import { SessionProvider, type Session } from './session.js';
import { AccountFrame } from './shell/account-frame.js';
import { ComingSoonPage } from './shell/coming-soon-page.js';
import { NoPage } from './shell/no-page.js';
import { Shell } from './shell/shell.js';
import { VisitorProvider } from './visitor.js';

/** Where the page is while the service is first asked who is signed in. */
const LOADING = { of: 'loading' } as const;

export interface AppProps {
  preferences: Preferences;
  choose: (change: Partial<Preferences>) => void;
  mac: boolean;
}

/**
 * THE APPLICATION: who is signed in, the page their address opens, and the
 * frame it is shown in. A visitor sees the landing page; a signed-in person
 * sees the menu and the page; nothing is shown until the service has said
 * which.
 */
export function App({ preferences, choose, mac }: AppProps) {
  const [who, setWho] = useState<WhoIsSignedIn | typeof LOADING>(LOADING);
  const [chosenView, setChosenView] = useState<View>(VIEWS.company);
  const [company, setCompany] = useState<string | null>(null);
  const address = useAddress();

  const ask = useCallback(async () => { setWho(await whoIsSignedIn()); }, []);
  useEffect(() => { void ask(); }, [ask]);

  const signedIn = who.of === OF.signedIn ? who : null;
  const companies: readonly Company[] = signedIn?.companies ?? [];
  const signs = companies.length > 0;
  const viewer: Viewer = { signedIn: signedIn !== null, view: viewFor(signs, chosenView), signs };
  const shown = company !== null && companies.some((c) => c.id === company) ? company : companies[0]?.id ?? null;

  /*
   * An address a visitor may not open takes them to the landing page, and the
   * page they asked for is kept, so signing in goes on to it. A signed-in
   * person at the landing page sees it change in place: their companies, and
   * "Create a company". Any other page they may not open, such as a page of
   * the other view, shows as no page.
   */
  const resolved = resolve(address, viewer);
  const ready = who.of === OF.signedIn || who.of === OF.nobody;
  useEffect(() => {
    if (!ready) return;
    if (resolved.of === RESOLVED.notYours && !viewer.signedIn) { wanted = resolved.id; go(HOME.visitor, true); }
  }, [ready, resolved.of, resolved.of === RESOLVED.nothing ? null : resolved.id, viewer.signedIn, viewer.view]);

  /*
   * After signing in, the person goes on to the page they asked for before,
   * when they may open it; otherwise they stay where they are, and the landing
   * page shows their companies in place of the sign-in.
   */
  const signedInNow = useCallback(async () => {
    const next = await whoIsSignedIn();
    setWho(next);
    const signsNow = next.of === OF.signedIn && next.companies.length > 0;
    const after: Viewer = { signedIn: next.of === OF.signedIn, view: viewFor(signsNow, VIEWS.company), signs: signsNow };
    setChosenView(VIEWS.company);
    const target: PageId = wanted !== null && mayOpen(PAGES[wanted], after) ? wanted : HOME.visitor;
    wanted = null;
    go(target, true);
  }, []);

  /* The one list of companies, asked for again after one is created; the new one is shown. */
  const companiesChanged = useCallback(async (choose?: string) => {
    const next = await whoIsSignedIn();
    setWho(next);
    if (choose !== undefined) { setCompany(choose); setChosenView(VIEWS.company); }
  }, []);

  const signOut = useCallback(async () => {
    const r = await endSignIn();
    setWho({ of: OF.nobody });
    setCompany(null);
    go(HOME.visitor, true);
    return r.of === OF.signedOut;
  }, []);

  if (who.of === LOADING.of) return <div className="min-h-svh bg-background" aria-busy={true} />;
  if (who.of === OF.unreachable) return <><ServiceUnreachable retry={() => { void ask(); }} /><AccountFrame /></>;
  if (who.of === OF.recordsApart) return <RecordsApart signOut={() => { void signOut(); }} />;

  const page = resolved.of === RESOLVED.page ? <PageView id={resolved.id} params={resolved.params} /> : <NoPage home={homeOf(viewer)} />;

  if (signedIn === null) {
    return (
      <VisitorContext signedInNow={signedInNow}>
        {page}
        <AccountFrame />
      </VisitorContext>
    );
  }

  const session: Session = {
    person: signedIn.person as Person, companies, company: shown, chooseCompany: setCompany, viewer,
    chooseView: (view) => { setChosenView(view); go(HOME[viewFor(signs, view)]); },
    preferences, choose, signOut: () => { void signOut(); }, mac, companiesChanged,
  };
  /* The landing page is a page of its own for a signed-in person too, outside the menu, as it is for a visitor. */
  if (resolved.of === RESOLVED.page && resolved.id === HOME.visitor) {
    return (
      <SessionProvider session={session}>
        {page}
        <AccountFrame />
      </SessionProvider>
    );
  }
  return (
    <SessionProvider session={session}>
      <Shell current={resolved.of === RESOLVED.page ? resolved.id : null}>{page}</Shell>
      <AccountFrame />
    </SessionProvider>
  );
}

/** The page a visitor asked for before signing in, gone on to once they have. Kept for this tab only. */
let wanted: PageId | null = null;

/**
 * A PAGE, shown inside the pages it sits in: Appearance is shown inside
 * Settings. A page not built yet shows what it will be. A screen loaded on
 * demand shows a placeholder the shape of a page while it loads.
 */
export function PageView({ id, params = {} }: { id: PageId; params?: Params }) {
  const page = PAGES[id];
  const own = isBuilt(page) ? <page.shows.screen /> : <ComingSoonPage id={id} />;
  const inside = outerOf(page as Page);
  const framed = inside === undefined ? own : <OuterPage id={inside}>{own}</OuterPage>;
  return <CurrentPageProvider id={id} params={params}><Suspense fallback={<PageLoading />}>{framed}</Suspense></CurrentPageProvider>;
}

function OuterPage({ id, children }: { id: PageId; children: React.ReactNode }) {
  const page = PAGES[id];
  if (!isBuilt(page)) return <>{children}</>;
  const Outer = page.shows.screen;
  return <Outer>{children}</Outer>;
}

/** What a page shows while its screen loads: the shape of a heading and a few rows, and nothing that could be read as an answer. */
export function PageLoading() {
  return (
    <div className="flex flex-col gap-3" aria-busy={true} data-loading>
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-full max-w-prose" />
      <Skeleton className="h-4 w-2/3 max-w-prose" />
    </div>
  );
}

/* ---------------- a visitor ---------------- */

function VisitorContext({ signedInNow, children }: { signedInNow: () => Promise<void>; children?: React.ReactNode }) {
  return <VisitorProvider signedInNow={signedInNow}>{children}</VisitorProvider>;
}

/* ---------------- when the service cannot answer ---------------- */

function ServiceUnreachable({ retry }: { retry: () => void }) {
  const t = useText();
  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-4 p-6" data-screen="service-unreachable">
      <h1 className="text-xl font-semibold">{t('service.unreachable.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('service.unreachable.body')}</p>
      <div><Button onClick={retry}>{t('service.unreachable.retry')}</Button></div>
    </main>
  );
}

function RecordsApart({ signOut }: { signOut: () => void }) {
  const t = useText();
  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-4 p-6" data-screen="records-apart">
      <h1 className="text-xl font-semibold">{t('service.recordsApart.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('service.recordsApart.body')}</p>
      <div><Button variant="outline" onClick={signOut}>{t('account.signOut')}</Button></div>
    </main>
  );
}
