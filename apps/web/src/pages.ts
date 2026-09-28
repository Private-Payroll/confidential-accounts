import type { ComponentType, ReactNode } from 'react';
import type { IconSvgElement } from '@hugeicons/react';
import {
  Activity01Icon, Analytics01Icon, ArrowDataTransferHorizontalIcon, Building03Icon, CheckListIcon, CreditCardIcon, DocumentValidationIcon, File01Icon,
  Folder01Icon, GridViewIcon, Home01Icon, Invoice01Icon, Key01Icon, LanguageSquareIcon, MailSend01Icon, MoneyReceive01Icon, Notification01Icon,
  PaintBoardIcon, PolicyIcon, Rocket01Icon, SafeIcon, Settings01Icon, ShieldUserIcon, UserAccountIcon, UserGroupIcon, UserIcon,
} from '@hugeicons/core-free-icons';
import type { useText } from 'vaults-ui';
import { Appearance } from './screens/appearance.js';
import { Landing } from './screens/landing.js';
import { LanguageSettings } from './screens/language.js';
import { Settings } from './screens/settings.js';

/**
 * EVERY PAGE OF THE APPLICATION, IN ONE LIST.
 *
 * Each page is one entry: its address, its name, its icon, the menu group it
 * sits in, who may open it, and either its screen or what it will be while it
 * is not built yet. The left menu, the command bar, the keyboard shortcuts,
 * the Settings screen and the router all read this list and nothing else, for
 * the company's pages and for a person's own, so adding a page is one entry
 * here, its phrases in the language files, and its screen.
 *
 * A PAGE NOT BUILT YET IS IN THE LIST, SHOWN AS COMING SOON, with a line on
 * what it will be. The screen that builds it replaces the line with the
 * screen, and every place that lists the page follows.
 *
 * Names and explanations are asked for by their key in the language files,
 * so every language names a page the same way the menu does. Going to a page
 * is by the command bar or the menu; a page may name a shortcut of its own,
 * from the application's one table of shortcuts, and none does yet.
 */

/** The phrase for a key, in the language shown, as `useText` gives it. */
export type Text = ReturnType<typeof useText>;

/**
 * Who may open a page. A visitor is anyone not signed in. A company page is
 * for a person who signs for a company, in the company view; an employee page
 * is for anyone signed in, in the view of their own pay. A page for anyone
 * signed in is reached from both views.
 */
export type Audience = 'visitor' | 'signed-in' | 'company' | 'employee';

/** The groups of the left menu, in the order it shows them. The first and the last have no heading. */
export const MENU_GROUPS = {
  top: null,
  money: (t: Text) => t('menu.group.money'),
  people: (t: Text) => t('menu.group.people'),
  compliance: (t: Text) => t('menu.group.compliance'),
  bottom: null,
} as const satisfies Record<string, ((t: Text) => string) | null>;

export type MenuGroup = keyof typeof MENU_GROUPS;

/** A screen, shown at its page's address; a screen that holds other pages shows the one opened inside it. */
export type Screen = ComponentType<{ children?: ReactNode }>;

export interface Page {
  /** The address the page is reached at. Written the same in every language, and never shown as wording. */
  path: string;
  /** Its name, as the menu, the command bar and the page's own heading say it. */
  name: (t: Text) => string;
  /** Other words the command bar finds it by, such as "theme" for Appearance. */
  words?: (t: Text) => string;
  icon: IconSvgElement;
  /** The menu group it sits in; null when it is reached another way (a section's page, the landing page). */
  group: MenuGroup | null;
  /** The id of the page it is shown inside, such as Settings for Appearance. The list's test holds it to a page in the list. */
  inside?: string;
  audience: Audience;
  /** Its screen, or, while it is not built, what it will be. */
  shows: { screen: Screen } | { comingSoon: (t: Text) => string };
  /** A shortcut of its own, from the table in `shortcuts.ts`. */
  shortcut?: string;
}

/**
 * THE LIST. The order is the menu's order within each group, and the order a
 * section lists its pages in.
 */
export const PAGES = {
  landing: {
    path: '/', name: (t) => t('page.landing.name'), icon: Home01Icon, group: null, audience: 'visitor',
    shows: { screen: Landing },
  },
  join: {
    path: '/join', name: (t) => t('page.join.name'), icon: MailSend01Icon, group: null, audience: 'visitor',
    shows: { comingSoon: (t) => t('page.join.soon') },
  },
  setup: {
    path: '/setup', name: (t) => t('page.setup.name'), words: (t) => t('page.setup.words'), icon: Rocket01Icon, group: null, audience: 'signed-in',
    shows: { comingSoon: (t) => t('page.setup.soon') },
  },

  home: {
    path: '/home', name: (t) => t('page.home.name'), icon: Home01Icon, group: 'top', audience: 'company',
    shows: { comingSoon: (t) => t('page.home.soon') },
  },
  proposals: {
    path: '/proposals', name: (t) => t('page.proposals.name'), words: (t) => t('page.proposals.words'), icon: CheckListIcon, group: 'top', audience: 'company',
    shows: { comingSoon: (t) => t('page.proposals.soon') },
  },
  payroll: {
    path: '/payroll', name: (t) => t('page.payroll.name'), icon: Invoice01Icon, group: 'money', audience: 'company',
    shows: { comingSoon: (t) => t('page.payroll.soon') },
  },
  vaults: {
    path: '/vaults', name: (t) => t('page.vaults.name'), icon: SafeIcon, group: 'money', audience: 'company',
    shows: { comingSoon: (t) => t('page.vaults.soon') },
  },
  transactions: {
    path: '/transactions', name: (t) => t('page.transactions.name'), icon: ArrowDataTransferHorizontalIcon, group: 'money', audience: 'company',
    shows: { comingSoon: (t) => t('page.transactions.soon') },
  },
  reports: {
    path: '/reports', name: (t) => t('page.reports.name'), icon: Analytics01Icon, group: 'money', audience: 'company',
    shows: { comingSoon: (t) => t('page.reports.soon') },
  },
  people: {
    path: '/people', name: (t) => t('page.people.name'), icon: UserGroupIcon, group: 'people', audience: 'company',
    shows: { comingSoon: (t) => t('page.people.soon') },
  },
  invitations: {
    path: '/invitations', name: (t) => t('page.invitations.name'), icon: MailSend01Icon, group: 'people', audience: 'company',
    shows: { comingSoon: (t) => t('page.invitations.soon') },
  },
  disclosures: {
    path: '/disclosures', name: (t) => t('page.disclosures.name'), icon: DocumentValidationIcon, group: 'compliance', audience: 'company',
    shows: { comingSoon: (t) => t('page.disclosures.soon') },
  },
  policies: {
    path: '/policies', name: (t) => t('page.policies.name'), icon: PolicyIcon, group: 'compliance', audience: 'company',
    shows: { comingSoon: (t) => t('page.policies.soon') },
  },
  activity: {
    path: '/activity', name: (t) => t('page.activity.name'), icon: Activity01Icon, group: 'compliance', audience: 'company',
    shows: { comingSoon: (t) => t('page.activity.soon') },
  },
  apps: {
    path: '/apps', name: (t) => t('page.apps.name'), icon: GridViewIcon, group: 'bottom', audience: 'company',
    shows: { comingSoon: (t) => t('page.apps.soon') },
  },
  settings: {
    path: '/settings', name: (t) => t('page.settings.name'), icon: Settings01Icon, group: 'bottom', audience: 'company',
    shows: { screen: Settings },
  },
  settingsCompany: {
    path: '/settings/company', name: (t) => t('page.settingsCompany.name'), icon: Building03Icon, group: null, inside: 'settings', audience: 'company',
    shows: { comingSoon: (t) => t('page.settingsCompany.soon') },
  },
  settingsSigners: {
    path: '/settings/signers', name: (t) => t('page.settingsSigners.name'), icon: ShieldUserIcon, group: null, inside: 'settings', audience: 'company',
    shows: { comingSoon: (t) => t('page.settingsSigners.soon') },
  },
  settingsRoles: {
    path: '/settings/roles', name: (t) => t('page.settingsRoles.name'), icon: Key01Icon, group: null, inside: 'settings', audience: 'company',
    shows: { comingSoon: (t) => t('page.settingsRoles.soon') },
  },
  settingsAppearance: {
    path: '/settings/appearance', name: (t) => t('page.settingsAppearance.name'), words: (t) => t('page.settingsAppearance.words'), icon: PaintBoardIcon, group: null, inside: 'settings', audience: 'company',
    shows: { screen: Appearance },
  },
  settingsLanguage: {
    path: '/settings/language', name: (t) => t('page.settingsLanguage.name'), words: (t) => t('page.settingsLanguage.words'), icon: LanguageSquareIcon, group: null, inside: 'settings', audience: 'company',
    shows: { screen: LanguageSettings },
  },
  settingsAccount: {
    path: '/settings/account', name: (t) => t('page.settingsAccount.name'), icon: UserAccountIcon, group: null, inside: 'settings', audience: 'company',
    shows: { comingSoon: (t) => t('page.settingsAccount.soon') },
  },
  settingsNotifications: {
    path: '/settings/notifications', name: (t) => t('page.settingsNotifications.name'), icon: Notification01Icon, group: null, inside: 'settings', audience: 'company',
    shows: { comingSoon: (t) => t('page.settingsNotifications.soon') },
  },
  settingsBilling: {
    path: '/settings/billing', name: (t) => t('page.settingsBilling.name'), icon: CreditCardIcon, group: null, inside: 'settings', audience: 'company',
    shows: { comingSoon: (t) => t('page.settingsBilling.soon') },
  },

  payHome: {
    path: '/pay', name: (t) => t('page.payHome.name'), icon: Home01Icon, group: 'top', audience: 'employee',
    shows: { comingSoon: (t) => t('page.payHome.soon') },
  },
  payslips: {
    path: '/pay/payslips', name: (t) => t('page.payslips.name'), icon: File01Icon, group: 'top', audience: 'employee',
    shows: { comingSoon: (t) => t('page.payslips.soon') },
  },
  paymentsReceived: {
    path: '/pay/payments', name: (t) => t('page.paymentsReceived.name'), icon: MoneyReceive01Icon, group: 'top', audience: 'employee',
    shows: { comingSoon: (t) => t('page.paymentsReceived.soon') },
  },
  myDetails: {
    path: '/pay/details', name: (t) => t('page.myDetails.name'), icon: UserIcon, group: 'top', audience: 'employee',
    shows: { comingSoon: (t) => t('page.myDetails.soon') },
  },
  documents: {
    path: '/pay/documents', name: (t) => t('page.documents.name'), icon: Folder01Icon, group: 'top', audience: 'employee',
    shows: { comingSoon: (t) => t('page.documents.soon') },
  },
  paySettings: {
    path: '/pay/settings', name: (t) => t('page.settings.name'), icon: Settings01Icon, group: 'bottom', audience: 'employee',
    shows: { screen: Settings },
  },
  payAppearance: {
    path: '/pay/settings/appearance', name: (t) => t('page.settingsAppearance.name'), words: (t) => t('page.settingsAppearance.words'), icon: PaintBoardIcon, group: null, inside: 'paySettings', audience: 'employee',
    shows: { screen: Appearance },
  },
  payLanguage: {
    path: '/pay/settings/language', name: (t) => t('page.settingsLanguage.name'), words: (t) => t('page.settingsLanguage.words'), icon: LanguageSquareIcon, group: null, inside: 'paySettings', audience: 'employee',
    shows: { screen: LanguageSettings },
  },
  payAccount: {
    path: '/pay/settings/account', name: (t) => t('page.settingsAccount.name'), icon: UserAccountIcon, group: null, inside: 'paySettings', audience: 'employee',
    shows: { comingSoon: (t) => t('page.settingsAccount.soon') },
  },
  payNotifications: {
    path: '/pay/settings/notifications', name: (t) => t('page.settingsNotifications.name'), icon: Notification01Icon, group: null, inside: 'paySettings', audience: 'employee',
    shows: { comingSoon: (t) => t('page.settingsNotifications.soon') },
  },
} as const satisfies Record<string, Page>;

export type PageId = keyof typeof PAGES;

/** Every page, with its id, in the list's order. */
export const EVERY_PAGE: readonly (Page & { id: PageId })[] = (Object.keys(PAGES) as PageId[]).map((id) => ({ id, ...(PAGES[id] as Page) }));

/** The two views a signed-in person can be in: their company's, or their own pay. */
export const VIEWS = { company: 'company', employee: 'employee' } as const;

export type View = (typeof VIEWS)[keyof typeof VIEWS];

/** Where each view begins, where a visitor begins, and where a person with no company yet sets one up. */
export const HOME = { company: 'home', employee: 'payHome', visitor: 'landing', newCompany: 'setup' } as const satisfies Record<View | 'visitor' | 'newCompany', PageId>;

/** Where each view's own settings are. */
export const SETTINGS_OF = { company: 'settings', employee: 'paySettings' } as const satisfies Record<View, PageId>;

/** Who is looking: whether they are signed in, which view they are in, and whether they sign for a company. */
export interface Viewer {
  signedIn: boolean;
  view: View;
  /** They sign for at least one company, so the company view is theirs. */
  signs: boolean;
}

/**
 * WHETHER `viewer` MAY OPEN `page`. The one answer the router, the menu, the
 * command bar and the shortcuts all ask, so no way in shows a page the others
 * would refuse.
 */
export function mayOpen(page: Pick<Page, 'audience'>, viewer: Viewer): boolean {
  if (page.audience === 'visitor') return !viewer.signedIn;
  if (!viewer.signedIn) return false;
  if (page.audience === 'signed-in') return true;
  if (page.audience === 'company') return viewer.view === 'company' && viewer.signs;
  return viewer.view === 'employee' || !viewer.signs;
}

/** The view a person is shown: the company's when they sign for one and have not switched to their pay. */
export function viewFor(signs: boolean, chosen: View): View {
  return signs ? chosen : VIEWS.employee;
}

/** The pages shown inside `id`, in the list's order. */
export const pagesInside = (id: PageId): (Page & { id: PageId })[] => EVERY_PAGE.filter((p) => p.inside === id);

/** The page `page` is shown inside, or none. */
export const outerOf = (page: Page): PageId | undefined => page.inside as PageId | undefined;

/**
 * THE PAGES A VIEWER CAN GO TO BY A SHORTCUT OF THEIR OWN: each page that
 * names one and that the viewer may open, by the shortcut's id. A page the
 * viewer may not open has no shortcut for them.
 */
export function pagesByShortcut(pages: readonly (Page & { id: PageId })[], viewer: Viewer): Partial<Record<string, PageId>> {
  const out: Partial<Record<string, PageId>> = {};
  for (const p of pages) if (p.shortcut !== undefined && mayOpen(p, viewer)) out[p.shortcut] = p.id;
  return out;
}

/** Whether a page is built: it has a screen rather than a line on what it will be. */
export const isBuilt = (page: Page): page is Page & { shows: { screen: Screen } } => (page.shows as { screen?: Screen }).screen !== undefined;
