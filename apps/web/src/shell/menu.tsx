import { HugeiconsIcon } from '@hugeicons/react';
import { ComingSoon, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useText } from 'vaults-ui';
import { EVERY_PAGE, isBuilt, MENU_GROUPS, mayOpen, outerOf, PAGES, type MenuGroup, type Page, type PageId, type Text } from '../pages.js';
import { PageLink } from '../router.js';
import { useSession } from '../session.js';

/** The pages the menu shows for a viewer, by group, in the list's order: only pages with a group, and only those the viewer may open. */
export function menuFor(viewer: Parameters<typeof mayOpen>[1]): { group: MenuGroup; pages: (Page & { id: PageId })[] }[] {
  return (Object.keys(MENU_GROUPS) as MenuGroup[])
    .map((group) => ({ group, pages: EVERY_PAGE.filter((p) => p.group === group && mayOpen(p, viewer)) }))
    .filter((g) => g.pages.length > 0);
}

/**
 * THE LEFT MENU'S PAGES, READ FROM THE ONE LIST. A page not built yet carries
 * the Coming soon pill after its name; folded to icons, each page's name is
 * shown when its icon is pointed at.
 */
export function Menu({ current }: { current: PageId | null }) {
  const t = useText();
  const { viewer } = useSession();
  const open = current === null ? null : (outerOf(PAGES[current] as Page) ?? current);
  return (
    <>
      {menuFor(viewer).map(({ group, pages }) => {
        const heading: ((t: Text) => string) | null = MENU_GROUPS[group];
        return (
          <SidebarGroup key={group} data-menu-group={group}>
            {heading === null ? null : <SidebarGroupLabel>{heading(t)}</SidebarGroupLabel>}
            <SidebarGroupContent>
              <SidebarMenu>
                {pages.map((p) => (
                  <SidebarMenuItem key={p.id} className="flex items-center gap-1" data-menu-page={p.id}>
                    <SidebarMenuButton asChild isActive={open === p.id} tooltip={p.name(t)} className="h-auto min-h-8 min-w-0 flex-1">
                      <PageLink to={p.id} aria-current={open === p.id ? 'page' : undefined}>
                        <HugeiconsIcon icon={p.icon} strokeWidth={2} />
                        <span className="whitespace-normal!">{p.name(t)}</span>
                      </PageLink>
                    </SidebarMenuButton>
                    {isBuilt(p) ? null : (
                      <div className="shrink-0 pe-1 group-data-[collapsible=icon]:hidden">
                        <ComingSoon explanation={(p.shows as { comingSoon: (t: Text) => string }).comingSoon(t)} />
                      </div>
                    )}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        );
      })}
    </>
  );
}
