import { useState, type ReactNode } from 'react';
import { Separator, Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarInset, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar, useText } from 'vaults-ui';
import { EVERY_PAGE, pagesByShortcut, PAGES, VIEWS, type Page, type PageId, type Text } from '../pages.js';
import { go } from '../router.js';
import { computerIsDark, MODES, themeFor } from '../preferences.js';
import { useSession } from '../session.js';
import { SHORTCUT, useShortcuts } from '../shortcuts.js';
import { CompanyRecordsProvider } from '../records/company-records.js';
import { AccountMenu } from './account-menu.js';
import { CommandBar, CommandBarButton, type Command } from './command-bar.js';
import { CompanySwitcher } from './company-switcher.js';
import { Menu } from './menu.js';
import { PanelProvider, RightPanel, usePanel } from './right-panel.js';
import { ShortcutsHelp } from './shortcuts-help.js';
import { ViewBanner } from './view-banner.js';

/**
 * THE FRAME EVERY PAGE OF A SIGNED-IN PERSON SITS IN: the company switcher,
 * the menu and the account menu down the start of the page, which fold to
 * icons; a bar across the top with the page's name and the command bar's
 * button; the page; and the right-hand panel, closed until a page opens it.
 * The shown company's records are read once here, for every page and for the
 * menu's counts and the switcher's names.
 */
export function Shell({ current, children }: { current: PageId | null; children?: ReactNode }) {
  return (
    <SidebarProvider>
      <PanelProvider>
        <CompanyRecordsProvider>
          <Frame current={current}>{children}</Frame>
        </CompanyRecordsProvider>
      </PanelProvider>
    </SidebarProvider>
  );
}

function Frame({ current, children }: { current: PageId | null; children?: ReactNode }) {
  const t = useText();
  const session = useSession();
  const { toggleSidebar } = useSidebar();
  const panel = usePanel();
  const [commandBar, setCommandBar] = useState(false);
  const [help, setHelp] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const { viewer, preferences, choose, chooseView, signOut } = session;
  const shownDark = themeFor(preferences.mode, computerIsDark()) === MODES[1];

  const toggle = viewer.view === VIEWS.company
    ? { name: (t: Text) => t('view.toEmployee'), run: () => chooseView(VIEWS.employee) }
    : { name: (t: Text) => t('view.toCompany'), run: () => chooseView(VIEWS.company) };
  const table: Record<string, Omit<Command, 'id'> | null> = {
    light: { name: (t) => t('command.light'), words: (t) => t('command.appearance.words'), shortcut: shownDark ? SHORTCUT.lightOrDark : undefined, run: () => choose({ mode: MODES[0] }) },
    dark: { name: (t) => t('command.dark'), words: (t) => t('command.appearance.words'), shortcut: shownDark ? undefined : SHORTCUT.lightOrDark, run: () => choose({ mode: MODES[1] }) },
    system: { name: (t) => t('command.system'), words: (t) => t('command.appearance.words'), run: () => choose({ mode: MODES[2] }) },
    switchView: viewer.signs ? toggle : null,
    switchCompany: { name: (t) => t('command.switchCompany'), shortcut: SHORTCUT.switchCompany, run: () => setSwitcher(true) },
    everyShortcut: { name: (t) => t('shortcuts.title'), words: (t) => t('command.shortcuts.words'), shortcut: SHORTCUT.everyShortcut, run: () => setHelp(true) },
    signOut: { name: (t) => t('account.signOut'), run: signOut },
  };
  const commands: Command[] = Object.entries(table).flatMap(([id, c]) => (c === null ? [] : [{ id, ...c }]));

  const toPages = Object.fromEntries(Object.entries(pagesByShortcut(EVERY_PAGE, viewer)).map(([s, id]) => [s, () => go(id as PageId)]));
  useShortcuts({
    ...toPages,
    commandBar: () => setCommandBar(true),
    everyShortcut: () => setHelp(true),
    toggleMenu: toggleSidebar,
    switchCompany: () => setSwitcher(true),
    lightOrDark: () => choose({ mode: shownDark ? MODES[0] : MODES[1] }),
    close: panel.shown === null ? undefined : panel.close,
  }, session.mac);

  const page = current === null ? null : PAGES[current] as Page;
  return (
    <>
      <Sidebar collapsible="icon" data-menu>
        <SidebarHeader><CompanySwitcher open={switcher} onOpenChange={setSwitcher} /></SidebarHeader>
        <SidebarContent><Menu current={current} /></SidebarContent>
        <SidebarFooter><AccountMenu showShortcuts={() => setHelp(true)} /></SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger />
          <Separator orientation="vertical" className="me-1 data-vertical:h-4 data-vertical:self-center" />
          <span className="truncate text-sm font-medium" data-page-name>{page === null ? null : page.name(t)}</span>
          <div className="ms-auto"><CommandBarButton onOpen={() => setCommandBar(true)} /></div>
        </header>
        <ViewBanner />
        <div className="flex-1 p-6" data-page-body>{children}</div>
      </SidebarInset>
      <RightPanel />
      <CommandBar open={commandBar} onOpenChange={setCommandBar} commands={commands} />
      <ShortcutsHelp open={help} onOpenChange={setHelp} />
    </>
  );
}
