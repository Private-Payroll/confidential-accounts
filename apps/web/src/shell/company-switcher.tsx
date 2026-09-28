import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, Building03Icon, QrCodeIcon, Tick02Icon, UnfoldMoreIcon } from '@hugeicons/core-free-icons';
import {
  ComingSoon, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
  formatDate, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useLanguage, usePopupSide, useSidebar, useText,
} from 'vaults-ui';
import type { Company } from '../adapters/session.js';
import { VIEWS } from '../pages.js';
import { useSession } from '../session.js';
import { SHORTCUT } from '../shortcuts.js';
import { ShortcutKeys } from './shortcut-keys.js';

/** How a company's date is written: the day, in the person's language. */
const DAY = { dateStyle: 'medium' } as const;

/**
 * THE COMPANY SWITCHER, AT THE TOP OF THE LEFT MENU: every company the person
 * signs for, in the order the service lists them, then "Create a company" and
 * "Join with a code", both Coming soon.
 *
 * NO LIST HERE IS RANKED BY MONEY, and none is ranked at all: a company is
 * shown where the service lists it. A company's name is sealed, and opens only
 * with the person's account, which is not asked here; until then each company
 * is shown by what the service lists of it, when it was made and how many of
 * its signers must approve, and its name is Coming soon. The last two anyone
 * can look up, and the list says so.
 */
export function CompanySwitcher({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useText();
  const language = useLanguage();
  const { companies, company, chooseCompany, viewer } = useSession();
  const { isMobile } = useSidebar();
  const { end } = usePopupSide();
  const shown = companies.find((c) => c.id === company) ?? null;
  const described = (c: Company) => t('switcher.company', { date: formatDate(new Date(c.createdAt), language, DAY) });
  const approvals = (c: Company) => t('switcher.approvals', { needed: c.approvalsNeeded, count: c.signers });
  const employee = viewer.view === VIEWS.employee;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu open={open} onOpenChange={onOpenChange}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground" data-action="company-switcher">
              <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <HugeiconsIcon icon={Building03Icon} strokeWidth={2} className="size-4" />
              </span>
              <span className="grid flex-1 text-start text-sm leading-tight">
                <span className="truncate font-medium">{shown === null ? t('app.title') : described(shown)}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {employee ? t('switcher.yourPay') : shown === null ? t('switcher.noCompany') : approvals(shown)}
                </span>
              </span>
              <HugeiconsIcon icon={UnfoldMoreIcon} strokeWidth={2} className="ms-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-64 rounded-lg" side={isMobile ? 'bottom' : end} align="start" sideOffset={4} data-company-switcher>
            <DropdownMenuLabel className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{employee ? t('switcher.companiesThatPayYou') : t('switcher.companies')}</span>
              <ShortcutKeys id={SHORTCUT.switchCompany} bare />
            </DropdownMenuLabel>
            {employee ? (
              <div className="flex items-center justify-between gap-3 px-2 py-1.5 text-sm" data-companies-that-pay>
                <span className="text-muted-foreground">{t('switcher.companiesThatPayYou')}</span>
                <ComingSoon explanation={t('switcher.companiesThatPaySoon')} />
              </div>
            ) : (
              <>
                {companies.map((c) => (
                  <DropdownMenuItem key={c.id} onSelect={() => chooseCompany(c.id)} className="gap-2 p-2" data-company={c.id}>
                    <span className="flex size-6 items-center justify-center rounded-md border">
                      <HugeiconsIcon icon={Building03Icon} strokeWidth={2} className="size-3.5" />
                    </span>
                    <span className="grid flex-1 leading-tight">
                      <span>{described(c)}</span>
                      <span className="text-xs text-muted-foreground">{approvals(c)}</span>
                    </span>
                    {c.id === company ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-4" /> : null}
                  </DropdownMenuItem>
                ))}
                {companies.length === 0 ? null : (
                  <>
                    <div className="flex items-center justify-between gap-3 px-2 py-1.5 text-xs text-muted-foreground" data-company-names>
                      <span>{t('switcher.names')}</span>
                      <ComingSoon explanation={t('switcher.namesSoon')} />
                    </div>
                    <p className="px-2 pb-1.5 text-xs text-muted-foreground" data-public-facts>{t('switcher.publicFacts')}</p>
                  </>
                )}
              </>
            )}
            <DropdownMenuSeparator />
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground" data-action="create-company">
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} className="size-4" />
              <span className="flex-1">{t('switcher.create')}</span>
              <ComingSoon explanation={t('switcher.createSoon')} />
            </div>
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground" data-action="join-with-a-code">
              <HugeiconsIcon icon={QrCodeIcon} strokeWidth={2} className="size-4" />
              <span className="flex-1">{t('switcher.join')}</span>
              <ComingSoon explanation={t('switcher.joinSoon')} />
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
