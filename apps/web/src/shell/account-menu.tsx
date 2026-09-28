import { HugeiconsIcon } from '@hugeicons/react';
import { KeyboardIcon, LanguageSquareIcon, Logout01Icon, Settings01Icon, UnfoldMoreIcon, UserSwitchIcon } from '@hugeicons/core-free-icons';
import {
  Avatar, AvatarFallback, ComingSoon, DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, usePopupSide, useSidebar, useText,
} from 'vaults-ui';
import { LANGUAGES, languageName } from '../languages.js';
import { SETTINGS_OF, VIEWS } from '../pages.js';
import { FOLLOW_BROWSER, MODE_NAMES, MODES, type Mode } from '../preferences.js';
import { go } from '../router.js';
import { useSession } from '../session.js';
import { SHORTCUT } from '../shortcuts.js';
import { ShortcutKeys } from './shortcut-keys.js';

/** The first letter of a name, for the avatar when there is no picture. */
const initial = (name: string): string => Array.from(name.trim())[0]?.toUpperCase() ?? '';

/**
 * THE ACCOUNT MENU, AT THE FOOT OF THE LEFT MENU: who is signed in, what is
 * Coming soon of the account, light and dark, the language, switching between
 * the company view and the person's own pay, Settings, the shortcuts, and
 * signing out.
 *
 * THE ACCOUNT'S ADDRESSES AND BALANCES ARE SHOWN COMING SOON. They will be read
 * through the person's account with their approval, and the account has no
 * request for them yet.
 */
export function AccountMenu({ showShortcuts }: { showShortcuts: () => void }) {
  const t = useText();
  const { person, viewer, chooseView, preferences, choose, signOut } = useSession();
  const { isMobile } = useSidebar();
  const { end } = usePopupSide();
  const other = viewer.view === VIEWS.company ? VIEWS.employee : VIEWS.company;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground" data-action="account-menu">
              <Avatar className="size-8 rounded-lg"><AvatarFallback className="rounded-lg">{initial(person.name)}</AvatarFallback></Avatar>
              <span className="grid flex-1 text-start text-sm leading-tight">
                <span className="truncate font-medium">{person.name}</span>
                <span className="truncate text-xs text-muted-foreground">{viewer.view === VIEWS.company ? t('view.company') : t('view.employee')}</span>
              </span>
              <HugeiconsIcon icon={UnfoldMoreIcon} strokeWidth={2} className="ms-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-64 rounded-lg" side={isMobile ? 'bottom' : end} align="end" sideOffset={4} data-account-menu>
            <DropdownMenuLabel className="font-normal">
              <span className="block truncate text-sm font-medium">{person.name}</span>
              <span className="block text-xs text-muted-foreground">{t('account.signedIn')}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <div className="flex flex-col gap-1.5 px-2 py-1.5 text-sm" data-account-details>
              {[t('account.privateAddress'), t('account.publicAddress'), t('account.balances')].map((name) => (
                <div key={name} className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{name}</span>
                  <ComingSoon explanation={t('account.detailsSoon')} />
                </div>
              ))}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">{t('appearance.mode.title')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={preferences.mode} onValueChange={(m) => choose({ mode: m as Mode })}>
              {MODES.map((m) => (
                <DropdownMenuRadioItem key={m} value={m} data-mode={m}>{MODE_NAMES[m](t)}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-action="language">
                <HugeiconsIcon icon={LanguageSquareIcon} strokeWidth={2} />
                {t('language.title')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={preferences.language ?? FOLLOW_BROWSER} onValueChange={(v) => choose({ language: v === FOLLOW_BROWSER ? null : v })}>
                  <DropdownMenuRadioItem value={FOLLOW_BROWSER}>{t('language.followBrowser')}</DropdownMenuRadioItem>
                  {LANGUAGES.map((l) => (
                    <DropdownMenuRadioItem key={l.tag} value={l.tag} lang={l.tag} data-language={l.tag}>{languageName(l.tag)}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {viewer.signs ? (
                <DropdownMenuItem onSelect={() => chooseView(other)} data-action="switch-view">
                  <HugeiconsIcon icon={UserSwitchIcon} strokeWidth={2} />
                  {other === VIEWS.employee ? t('view.toEmployee') : t('view.toCompany')}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => go(SETTINGS_OF[viewer.view])}>
                <HugeiconsIcon icon={Settings01Icon} strokeWidth={2} />
                {t('page.settings.name')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={showShortcuts}>
                <HugeiconsIcon icon={KeyboardIcon} strokeWidth={2} />
                {t('shortcuts.title')}
                <DropdownMenuShortcut><ShortcutKeys id={SHORTCUT.everyShortcut} bare /></DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={signOut} data-action="sign-out">
              <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} />
              {t('account.signOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
