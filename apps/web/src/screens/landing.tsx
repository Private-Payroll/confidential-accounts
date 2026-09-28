import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, Building03Icon } from '@hugeicons/core-free-icons';
import { Alert, AlertDescription, AlertTitle, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, useText } from 'vaults-ui';
import { OF, REFUSAL, signIn, type SignInRefusal } from '../adapters/session.js';
import { HOME, VIEWS } from '../pages.js';
import { go } from '../router.js';
import { useSessionIfAny, type Session } from '../session.js';
import { STEP } from '../setup/step-ids.js';
import { startSetupAt } from '../setup/asked.js';
import { CompanyFacts } from '../shell/company-facts.js';
import { useVisitor } from '../visitor.js';

/**
 * THE LANDING PAGE: on one side what the product is, on the other the way in.
 * For a visitor, the way in is signing in: "Get started" and "Log in" both
 * sign in with the person's own account. Once they have, the same page, at the
 * same address, shows in the same place every company they sign for, each
 * opening that company, and "Create a company", which starts the setup
 * wizard. With no company yet it shows only "Create a company".
 */
export function Landing() {
  const t = useText();
  const session = useSessionIfAny();
  return (
    <main className="grid min-h-svh md:grid-cols-2" data-screen="landing" data-signed-in={session !== null}>
      <section className="flex flex-col justify-center gap-4 bg-muted p-8 md:p-16">
        <h1 className="text-3xl font-semibold tracking-tight">{t('app.title')}</h1>
        <p className="max-w-md text-lg">{t('landing.what')}</p>
        <p className="max-w-md text-sm text-muted-foreground">{t('landing.privacy')}</p>
      </section>
      <section className="flex flex-col justify-center gap-4 p-8 md:p-16">
        {session === null ? <SignIn /> : <ChooseACompany session={session} />}
      </section>
    </main>
  );
}

/**
 * THE PERSON'S COMPANIES, from the application's one list, in the order the
 * service gave them, and "Create a company". Each company is shown by what
 * the service lists of it, as the company switcher shows it.
 */
function ChooseACompany({ session }: { session: Session }) {
  const t = useText();
  const open = (id: string): void => { session.chooseCompany(id); session.chooseView(VIEWS.company); };
  const create = (): void => { startSetupAt(STEP.createCompany, true); go(HOME.setup); };
  return (
    <div className="flex max-w-sm flex-col gap-3" data-choose-a-company>
      <h2 className="text-lg font-semibold">{session.companies.length === 0 ? t('landing.choose.none') : t('landing.choose.title')}</h2>
      {session.companies.length === 0 ? null : (
        <ul className="flex flex-col gap-2" data-companies>
          {session.companies.map((c) => (
            <li key={c.id}>
              <Button variant="outline" className="h-auto w-full justify-start gap-3 py-2" onClick={() => open(c.id)} data-company={c.id}>
                <HugeiconsIcon icon={Building03Icon} strokeWidth={2} className="size-4" />
                <CompanyFacts company={c} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button className="w-full" variant={session.companies.length === 0 ? 'default' : 'ghost'} onClick={create} data-action="create-company">
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} className="size-4" />
        {t('switcher.create')}
      </Button>
    </div>
  );
}

/** The two ways in for a visitor, both signing in with their account. */
function SignIn() {
  const t = useText();
  const { signedInNow } = useVisitor();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ why: SignInRefusal; retryAfterSeconds: number | null } | null>(null);

  const start = async (): Promise<void> => {
    setRefusal(null);
    setBusy(true);
    const r = await signIn({ name: t('app.title'), purpose: t('signIn.purpose') });
    setBusy(false);
    if (r.of === OF.refused) { setRefusal({ why: r.why, retryAfterSeconds: r.retryAfterSeconds }); return; }
    await signedInNow();
  };

  return (
      <>
        <Card className="max-w-sm">
          <CardHeader>
            <CardTitle>{t('landing.new.title')}</CardTitle>
            <CardDescription>{t('landing.new.body')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" disabled={busy} onClick={() => { void start(); }} data-action="get-started">{t('landing.getStarted')}</Button>
          </CardContent>
        </Card>
        <Card className="max-w-sm">
          <CardHeader>
            <CardTitle>{t('landing.returning.title')}</CardTitle>
            <CardDescription>{t('landing.returning.body')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" variant="outline" disabled={busy} onClick={() => { void start(); }} data-action="log-in">{t('landing.logIn')}</Button>
          </CardContent>
        </Card>
        <p className="max-w-sm text-xs text-muted-foreground">{t('landing.howSigningInWorks')}</p>
        {refusal === null ? null : <SignInRefused why={refusal.why} retryAfterSeconds={refusal.retryAfterSeconds} />}
      </>
  );
}

/** Why signing in did not happen, and what to do about it, in the person's language. */
function SignInRefused({ why, retryAfterSeconds }: { why: SignInRefusal; retryAfterSeconds: number | null }) {
  const t = useText();
  const says: Record<SignInRefusal, string> = {
    [REFUSAL.notSetUp]: t('signIn.refused.notSetUp'),
    [REFUSAL.noWindow]: t('signIn.refused.noWindow'),
    [REFUSAL.windowGone]: t('signIn.refused.windowGone'),
    [REFUSAL.declined]: t('signIn.refused.declined'),
    [REFUSAL.expired]: t('signIn.refused.expired'),
    [REFUSAL.silent]: t('signIn.refused.silent'),
    [REFUSAL.gaveUp]: t('signIn.refused.gaveUp'),
    [REFUSAL.didNotFinish]: t('signIn.refused.didNotFinish'),
    [REFUSAL.refused]: t('signIn.refused.refused'),
    [REFUSAL.tooMany]: retryAfterSeconds === null ? t('signIn.refused.tooMany') : t('signIn.refused.tooManyWait', { count: Math.ceil(retryAfterSeconds / 60) }),
    [REFUSAL.unavailable]: t('signIn.refused.unavailable'),
    [REFUSAL.unreachable]: t('signIn.refused.unreachable'),
  };
  return (
    <Alert className="max-w-sm" data-refusal={why}>
      <AlertTitle>{t('signIn.refused.title')}</AlertTitle>
      <AlertDescription>{says[why]}</AlertDescription>
    </Alert>
  );
}
