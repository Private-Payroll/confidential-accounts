import type { ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Tabs, TabsList, TabsTrigger, useText } from 'vaults-ui';
import { outerOf, pagesInside, PAGES, type Page, type PageId } from '../pages.js';
import { go, PageLink, useCurrentPage } from '../router.js';

/**
 * SETTINGS: its sections, read from the one list, as the kit's tabs across the
 * top, and the section open below them. Each tab is a link to its section's
 * own address. At Settings itself, with no section open, the space below asks
 * the person to choose one. A tab carries no Coming soon pill: a section not
 * built yet says so in its own heading. The same screen serves the company's settings and
 * a person's own, each listing its own sections.
 */
export function Settings({ children }: { children?: ReactNode }) {
  const t = useText();
  const { id, page } = useCurrentPage();
  const section = outerOf(page as Page) ?? id;
  const sections = pagesInside(section);
  return (
    <div className="flex flex-col gap-6" data-screen="settings">
      <h1 className="text-xl font-semibold">{PAGES[section].name(t)}</h1>
      {/* Each tab is a link to its own address, so the arrow keys only move between tabs; pressing one goes there. */}
      <Tabs value={id} onValueChange={(v) => go(v as PageId)} activationMode="manual">
        <TabsList aria-label={PAGES[section].name(t)} data-settings-sections>
          {sections.map((s) => (
            <TabsTrigger key={s.id} value={s.id} asChild data-settings-section={s.id}>
              <PageLink to={s.id} aria-current={s.id === id ? 'page' : undefined}>
                <HugeiconsIcon icon={s.icon} strokeWidth={2} className="size-4 shrink-0" />
                <span>{s.name(t)}</span>
              </PageLink>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="min-w-0">
        {children ?? <p className="text-sm text-muted-foreground" data-settings-overview>{t('settings.choose')}</p>}
      </div>
    </div>
  );
}
