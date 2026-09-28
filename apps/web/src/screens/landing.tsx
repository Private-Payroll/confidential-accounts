import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, useText } from 'vaults-ui';
import { OF, REFUSAL, signIn, type SignInRefusal } from '../adapters/session.js';
import { useVisitor } from '../visitor.js';

/**
 * THE LANDING PAGE: on one side what the product is, on the other the two ways
 * in. Both sign in with the person's own account; "Get started" takes a person
 * with no company on to setting one up, and "Log in" takes them back to where
 * they were going, or, on a person's first sign-in with no company, on to
 * setting one up too.
 */
export function Landing() {
  const t = useText();
  const { signedInNow } = useVisitor();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ why: SignInRefusal; retryAfterSeconds: number | null } | null>(null);

  const start = async (firstTime: boolean): Promise<void> => {
    setRefusal(null);
    setBusy(true);
    const r = await signIn({ name: t('app.title'), purpose: t('signIn.purpose') });
    setBusy(false);
    if (r.of === OF.refused) { setRefusal({ why: r.why, retryAfterSeconds: r.retryAfterSeconds }); return; }
    await signedInNow(firstTime || r.firstTime);
  };

  return (
    <main className="grid min-h-svh md:grid-cols-2" data-screen="landing">
      <section className="flex flex-col justify-center gap-4 bg-muted p-8 md:p-16">
        <h1 className="text-3xl font-semibold tracking-tight">{t('app.title')}</h1>
        <p className="max-w-md text-lg">{t('landing.what')}</p>
        <p className="max-w-md text-sm text-muted-foreground">{t('landing.privacy')}</p>
      </section>
      <section className="flex flex-col justify-center gap-4 p-8 md:p-16">
        <Card className="max-w-sm">
          <CardHeader>
            <CardTitle>{t('landing.new.title')}</CardTitle>
            <CardDescription>{t('landing.new.body')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" disabled={busy} onClick={() => { void start(true); }} data-action="get-started">{t('landing.getStarted')}</Button>
          </CardContent>
        </Card>
        <Card className="max-w-sm">
          <CardHeader>
            <CardTitle>{t('landing.returning.title')}</CardTitle>
            <CardDescription>{t('landing.returning.body')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" variant="outline" disabled={busy} onClick={() => { void start(false); }} data-action="log-in">{t('landing.logIn')}</Button>
          </CardContent>
        </Card>
        <p className="max-w-sm text-xs text-muted-foreground">{t('landing.howSigningInWorks')}</p>
        {refusal === null ? null : <SignInRefused why={refusal.why} retryAfterSeconds={refusal.retryAfterSeconds} />}
      </section>
    </main>
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
