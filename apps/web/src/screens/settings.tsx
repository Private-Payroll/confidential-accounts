import type { ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ComingSoon, useText } from 'vaults-ui';
import { isBuilt, outerOf, pagesInside, PAGES, type Page, type Text } from '../pages.js';
import { PageLink, useCurrentPage } from '../router.js';

/**
 * SETTINGS: its sections, read from the one list, down the start of the page,
 * and the section open beside them. At Settings itself, with no section open,
 * the space beside them asks the person to choose one. The same screen serves
 * the company's settings and a person's own, each listing its own sections.
 */
export function Settings({ children }: { children?: ReactNode }) {
  const t = useText();
  const { id, page } = useCurrentPage();
  const section = outerOf(page as Page) ?? id;
  const sections = pagesInside(section);
  return (
    <div className="flex flex-col gap-6 md:flex-row" data-screen="settings">
      <nav className="flex shrink-0 flex-col gap-1 md:w-72" aria-label={PAGES[section].name(t)}>
        <h1 className="px-2 pb-2 text-xl font-semibold">{PAGES[section].name(t)}</h1>
        {sections.map((s) => (
          <div key={s.id} className="flex items-center gap-2" data-settings-section={s.id}>
            <PageLink
              to={s.id} aria-current={s.id === id ? 'page' : undefined}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent aria-[current=page]:bg-accent aria-[current=page]:font-medium"
            >
              <HugeiconsIcon icon={s.icon} strokeWidth={2} className="size-4 shrink-0" />
              <span>{s.name(t)}</span>
            </PageLink>
            {isBuilt(s) ? null : <ComingSoon explanation={(s.shows as { comingSoon: (t: Text) => string }).comingSoon(t)} />}
          </div>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        {children ?? <p className="text-sm text-muted-foreground" data-settings-overview>{t('settings.choose')}</p>}
      </div>
    </div>
  );
}
