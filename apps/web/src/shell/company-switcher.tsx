import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, Building03Icon, QrCodeIcon, Tick02Icon, UnfoldMoreIcon } from '@hugeicons/core-free-icons';
import {
  ComingSoon, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, usePopupSide, useSidebar, useText,
} from 'vaults-ui';
import { HOME, VIEWS } from '../pages.js';
import { go } from '../router.js';
import { useSession } from '../session.js';
import { STEP } from '../setup/step-ids.js';
import { startSetupAt } from '../setup/asked.js';
import { useCompanyRecords } from '../records/company-records.js';
import { CompanyFacts, useCompanyWords } from './company-facts.js';
import { SHORTCUT } from '../shortcuts.js';
import { ShortcutKeys } from './shortcut-keys.js';

/**
 * THE COMPANY SWITCHER, AT THE TOP OF THE LEFT MENU: every company the person
 * signs for, in the order the service lists them, then "Create a company",
 * which starts the setup wizard, and "Join with a code", Coming soon. It reads
 * the application's one list of companies, as the landing page does.
 *
 * NO LIST HERE IS RANKED BY MONEY, and none is ranked at all: a company is
 * shown where the service lists it. A company's name is sealed, and opens only
 * with the keys saved for the person, which their account opens; each company
 * is shown by its name once it is open, and always by how many of its
 * signers must approve, of how many there are, which the service lists.
 */
export function CompanySwitcher({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useText();
  const words = useCompanyWords();
  const { companies, company, chooseCompany, viewer } = useSession();
  const { names } = useCompanyRecords();
  const { isMobile } = useSidebar();
  const { end } = usePopupSide();
  const shown = companies.find((c) => c.id === company) ?? null;
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
                <span className="truncate font-medium" data-shown-name={shown !== null && names.has(shown.id) ? true : undefined}>{shown === null ? t('app.title') : names.get(shown.id) ?? words.unnamed}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {employee ? t('switcher.yourPay') : shown === null ? t('switcher.noCompany') : words.approvals(shown)}
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
                    <CompanyFacts company={c} name={names.get(c.id) ?? null} />
                    {c.id === company ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-4" /> : null}
                  </DropdownMenuItem>
                ))}
                {companies.every((c) => names.has(c.id)) ? null : (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground" data-company-names="locked">{t('switcher.namesLocked')}</p>
                )}
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => { startSetupAt(STEP.createCompany, true); go(HOME.setup); }} className="gap-2 p-2" data-action="create-company">
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} className="size-4" />
              <span className="flex-1">{t('switcher.create')}</span>
            </DropdownMenuItem>
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
