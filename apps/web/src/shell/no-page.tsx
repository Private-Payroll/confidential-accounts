import { HugeiconsIcon } from '@hugeicons/react';
import { Home01Icon, UnavailableIcon } from '@hugeicons/core-free-icons';
import { Button, EmptyState, useText } from 'vaults-ui';
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
    <div className="flex flex-col gap-6" data-screen="no-page">
      <EmptyState
        icon={UnavailableIcon}
        title={t('noPage.title')}
        action={<Button asChild variant="outline"><PageLink to={home}><HugeiconsIcon icon={Home01Icon} strokeWidth={2} data-icon="inline-start" />{t('noPage.home')}</PageLink></Button>}
      >
        {t('noPage.body')}
      </EmptyState>
    </div>
  );
}
