import { Button, useText } from 'vaults-ui';
import { PageLink } from '../router.js';
import type { PageId } from '../pages.js';

/**
 * AN ADDRESS THAT OPENS NOTHING FOR THIS PERSON: one no page is at, or, for a
 * signed-in person, a page that is not theirs to open. The two are said the
 * same way, so this screen never tells a person that a page exists which is not
 * theirs. A visitor at a page's address is taken to the landing page instead,
 * to sign in and go on to it.
 */
export function NoPage({ home }: { home: PageId }) {
  const t = useText();
  return (
    <section className="flex flex-col items-start gap-3" data-screen="no-page">
      <h1 className="text-xl font-semibold">{t('noPage.title')}</h1>
      <p className="max-w-prose text-sm text-muted-foreground">{t('noPage.body')}</p>
      <Button asChild variant="outline"><PageLink to={home}>{t('noPage.home')}</PageLink></Button>
    </section>
  );
}
