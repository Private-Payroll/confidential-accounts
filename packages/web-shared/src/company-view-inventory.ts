/**
 * **EVERY PLACE A COMPANY IS READ OR CHANGED FROM.** Each wallet action the wallet registers, and each screen, action
 * panel, part of the shell and step of setting a company up that the page draws, with the file it is in and how it
 * reads: a company through one view of it (`company`), before the person is one of its members or before it exists,
 * with no view to hold its reads to (`before`), as a reader holding read keys only (`reader`), or nothing of any company
 * (`none`). The count of what each place reads is taken from this list, so a place left off it is a place whose reads
 * nobody holds to one view; the check that the records are read one way refuses a place missing from it, and an entry
 * for a place that no longer exists.
 */

/** What kind of place reads the company. */
export type PlaceKind = 'wallet action' | 'screen' | 'action panel' | 'shell' | 'setup';

/** How a place reads: through a company's view, before there is one to read, as a reader, or not at all. */
type PlaceReads = 'company' | 'before' | 'reader' | 'none';

/** One place a company is read or changed from. */
export interface Place {
  readonly kind: PlaceKind;
  /** The wallet action's intent, or the file's name for a part of the page. */
  readonly name: string;
  /** The file it is in, from the repository's root. */
  readonly file: string;
  readonly reads: PlaceReads;
  /** For a screen: the pages it draws, by their names in the page list. */
  readonly pages?: readonly string[];
}

export const COMPANY_VIEW_INVENTORY: readonly Place[] = Object.freeze([
  { kind: 'wallet action', name: 'finish-company', file: 'apps/wallet/src/actions/finish-company.ts', reads: 'before' },
  { kind: 'wallet action', name: 'give-vault-keys', file: 'apps/wallet/src/actions/give-vault-keys.ts', reads: 'company' },
  { kind: 'wallet action', name: 'create-vault', file: 'apps/wallet/src/actions/create-vault.ts', reads: 'company' },
  { kind: 'wallet action', name: 'private-deposit', file: 'apps/wallet/src/actions/private-deposit.ts', reads: 'company' },
  { kind: 'wallet action', name: 'one-off-payment', file: 'apps/wallet/src/actions/one-off-payment.ts', reads: 'company' },
  { kind: 'wallet action', name: 'claim-by-address', file: 'apps/wallet/src/actions/claim-by-address.ts', reads: 'before' },
  { kind: 'wallet action', name: 'join-by-code', file: 'apps/wallet/src/actions/join-by-code.ts', reads: 'before' },
  { kind: 'wallet action', name: 'seat-invited', file: 'apps/wallet/src/actions/seat-invited.ts', reads: 'before' },
  { kind: 'wallet action', name: 'invite', file: 'apps/wallet/src/actions/invite.ts', reads: 'company' },
  { kind: 'wallet action', name: 'approve-proposal', file: 'apps/wallet/src/actions/approve-proposal.ts', reads: 'company' },
  { kind: 'wallet action', name: 'change-threshold', file: 'apps/wallet/src/actions/change-threshold.ts', reads: 'company' },
  { kind: 'wallet action', name: 'retire-vault', file: 'apps/wallet/src/actions/retire-vault.ts', reads: 'company' },
  { kind: 'wallet action', name: 'set-spending-policy', file: 'apps/wallet/src/actions/set-policy.ts', reads: 'company' },
  { kind: 'wallet action', name: 'set-policy-bar', file: 'apps/wallet/src/actions/set-policy.ts', reads: 'company' },
  { kind: 'wallet action', name: 'remove-signer', file: 'apps/wallet/src/actions/remove-signer.ts', reads: 'company' },
  { kind: 'wallet action', name: 'rotate-vault-secrets', file: 'apps/wallet/src/actions/rotate-vault-secrets.ts', reads: 'company' },
  { kind: 'wallet action', name: 'raise-run', file: 'apps/wallet/src/actions/raise-run.ts', reads: 'company' },
  { kind: 'wallet action', name: 'pay-run', file: 'apps/wallet/src/actions/pay-run.ts', reads: 'company' },
  { kind: 'wallet action', name: 'withdraw-proposal', file: 'apps/wallet/src/actions/withdraw-proposal.ts', reads: 'company' },
  { kind: 'wallet action', name: 'recovery', file: 'apps/wallet/src/actions/recovery.ts', reads: 'company' },
  { kind: 'wallet action', name: 'admit-signer', file: 'apps/wallet/src/actions/admit-signer.ts', reads: 'company' },
  { kind: 'wallet action', name: 'admit-person', file: 'apps/wallet/src/actions/admit-person.ts', reads: 'company' },
  { kind: 'wallet action', name: 'change-person', file: 'apps/wallet/src/actions/change-person.ts', reads: 'company' },
  { kind: 'wallet action', name: 'choose-company-service', file: 'apps/wallet/src/actions/choose-company-service.ts', reads: 'company' },
  { kind: 'wallet action', name: 'grant-read', file: 'apps/wallet/src/actions/grant-read.ts', reads: 'company' },
  { kind: 'wallet action', name: 'set-recovery-window', file: 'apps/wallet/src/actions/set-recovery-window.ts', reads: 'company' },
  { kind: 'wallet action', name: 'reader-keys', file: 'apps/wallet/src/actions/reader-keys.ts', reads: 'reader' },
  { kind: 'wallet action', name: 'change-role', file: 'apps/wallet/src/actions/change-role.ts', reads: 'company' },
  { kind: 'wallet action', name: 'drop-role-change', file: 'apps/wallet/src/actions/change-role.ts', reads: 'none' },
  { kind: 'wallet action', name: 'repair-company-key', file: 'apps/wallet/src/actions/repair-company-key.ts', reads: 'company' },
  { kind: 'wallet action', name: 'withdraw-waiting-signer', file: 'apps/wallet/src/actions/withdraw-waiting-signer.ts', reads: 'company' },
  { kind: 'wallet action', name: 'reissue-invitation', file: 'apps/wallet/src/actions/reissue-invitation.ts', reads: 'company' },
  { kind: 'wallet action', name: 'take-reissue', file: 'apps/wallet/src/actions/take-reissue.ts', reads: 'before' },
  { kind: 'wallet action', name: 'add-signer-by-code', file: 'apps/wallet/src/actions/add-signer-by-code.ts', reads: 'company' },
  { kind: 'wallet action', name: 'raise-waiting-signer', file: 'apps/wallet/src/actions/raise-waiting-signer.ts', reads: 'company' },
  { kind: 'screen', name: 'appearance', file: 'apps/web/src/screens/appearance.tsx', reads: 'none', pages: ['settingsAppearance', 'payAppearance'] },
  { kind: 'screen', name: 'apps', file: 'apps/web/src/screens/apps.tsx', reads: 'none', pages: ['apps'] },
  { kind: 'screen', name: 'home', file: 'apps/web/src/screens/home.tsx', reads: 'company', pages: ['home'] },
  { kind: 'screen', name: 'invitations', file: 'apps/web/src/screens/invitations.tsx', reads: 'company', pages: ['invitations'] },
  { kind: 'screen', name: 'join', file: 'apps/web/src/screens/join.tsx', reads: 'before', pages: ['join'] },
  { kind: 'screen', name: 'landing', file: 'apps/web/src/screens/landing.tsx', reads: 'none', pages: ['landing'] },
  { kind: 'screen', name: 'language', file: 'apps/web/src/screens/language.tsx', reads: 'none', pages: ['settingsLanguage', 'payLanguage'] },
  { kind: 'screen', name: 'payroll', file: 'apps/web/src/screens/payroll.tsx', reads: 'company', pages: ['payroll'] },
  { kind: 'screen', name: 'people', file: 'apps/web/src/screens/people.tsx', reads: 'company', pages: ['people'] },
  { kind: 'screen', name: 'policies', file: 'apps/web/src/screens/policies.tsx', reads: 'company', pages: ['policies'] },
  { kind: 'screen', name: 'proposals', file: 'apps/web/src/screens/proposals.tsx', reads: 'company', pages: ['proposals'] },
  { kind: 'screen', name: 'reader', file: 'apps/web/src/screens/reader.tsx', reads: 'reader', pages: ['readerSignUp', 'reader'] },
  { kind: 'screen', name: 'recovery', file: 'apps/web/src/screens/recovery.tsx', reads: 'company', pages: ['settingsRecovery'] },
  { kind: 'screen', name: 'roles', file: 'apps/web/src/screens/roles.tsx', reads: 'company', pages: ['settingsRoles'] },
  { kind: 'screen', name: 'run', file: 'apps/web/src/screens/run.tsx', reads: 'company', pages: ['run'] },
  { kind: 'screen', name: 'service', file: 'apps/web/src/screens/service.tsx', reads: 'company', pages: ['settingsService'] },
  { kind: 'screen', name: 'settings-sections', file: 'apps/web/src/screens/settings-sections.tsx', reads: 'company', pages: ['settingsCompany', 'settingsSigners'] },
  { kind: 'screen', name: 'settings', file: 'apps/web/src/screens/settings.tsx', reads: 'none', pages: ['settings', 'paySettings'] },
  { kind: 'screen', name: 'setup', file: 'apps/web/src/screens/setup.tsx', reads: 'before', pages: ['setup'] },
  { kind: 'screen', name: 'super-admins', file: 'apps/web/src/screens/super-admins.tsx', reads: 'company', pages: ['settingsSuperAdmins', 'superAdminsByLink'] },
  { kind: 'screen', name: 'vault', file: 'apps/web/src/screens/vault.tsx', reads: 'company', pages: ['vault'] },
  { kind: 'screen', name: 'vaults', file: 'apps/web/src/screens/vaults.tsx', reads: 'company', pages: ['vaults'] },
  { kind: 'screen', name: 'vendors', file: 'apps/web/src/screens/vendors.tsx', reads: 'company', pages: ['vendors'] },
  { kind: 'action panel', name: 'account-tokens', file: 'apps/web/src/actions/account-tokens.tsx', reads: 'none' },
  { kind: 'action panel', name: 'admit', file: 'apps/web/src/actions/admit.tsx', reads: 'company' },
  { kind: 'action panel', name: 'approve', file: 'apps/web/src/actions/approve.tsx', reads: 'company' },
  { kind: 'action panel', name: 'change-threshold', file: 'apps/web/src/actions/change-threshold.tsx', reads: 'company' },
  { kind: 'action panel', name: 'committee-change', file: 'apps/web/src/actions/committee-change.tsx', reads: 'company' },
  { kind: 'action panel', name: 'create-company', file: 'apps/web/src/actions/create-company.tsx', reads: 'before' },
  { kind: 'action panel', name: 'create-vault', file: 'apps/web/src/actions/create-vault.tsx', reads: 'company' },
  { kind: 'action panel', name: 'deposit', file: 'apps/web/src/actions/deposit.tsx', reads: 'company' },
  { kind: 'action panel', name: 'finish-company', file: 'apps/web/src/actions/finish-company.tsx', reads: 'before' },
  { kind: 'action panel', name: 'invite', file: 'apps/web/src/actions/invite.tsx', reads: 'company' },
  { kind: 'action panel', name: 'one-off', file: 'apps/web/src/actions/one-off.tsx', reads: 'company' },
  { kind: 'action panel', name: 'pay-run', file: 'apps/web/src/actions/pay-run.tsx', reads: 'company' },
  { kind: 'action panel', name: 'person-panel', file: 'apps/web/src/actions/person-panel.tsx', reads: 'company' },
  { kind: 'action panel', name: 'raise-run', file: 'apps/web/src/actions/raise-run.tsx', reads: 'company' },
  { kind: 'action panel', name: 'recovery-window', file: 'apps/web/src/actions/recovery-window.tsx', reads: 'company' },
  { kind: 'action panel', name: 'retire-vault', file: 'apps/web/src/actions/retire-vault.tsx', reads: 'company' },
  { kind: 'action panel', name: 'retry-run', file: 'apps/web/src/actions/retry-run.tsx', reads: 'company' },
  { kind: 'action panel', name: 'signers', file: 'apps/web/src/actions/signers.tsx', reads: 'company' },
  { kind: 'action panel', name: 'start-again', file: 'apps/web/src/actions/start-again.tsx', reads: 'before' },
  { kind: 'action panel', name: 'vendor-panel', file: 'apps/web/src/actions/vendor-panel.tsx', reads: 'company' },
  { kind: 'action panel', name: 'withdraw', file: 'apps/web/src/actions/withdraw.tsx', reads: 'company' },
  { kind: 'shell', name: 'account-frame', file: 'apps/web/src/shell/account-frame.tsx', reads: 'before' },
  { kind: 'shell', name: 'account-menu', file: 'apps/web/src/shell/account-menu.tsx', reads: 'none' },
  { kind: 'shell', name: 'coming-soon-page', file: 'apps/web/src/shell/coming-soon-page.tsx', reads: 'none' },
  { kind: 'shell', name: 'command-bar', file: 'apps/web/src/shell/command-bar.tsx', reads: 'none' },
  { kind: 'shell', name: 'company-facts', file: 'apps/web/src/shell/company-facts.tsx', reads: 'company' },
  { kind: 'shell', name: 'company-switcher', file: 'apps/web/src/shell/company-switcher.tsx', reads: 'company' },
  { kind: 'shell', name: 'create-menu', file: 'apps/web/src/shell/create-menu.tsx', reads: 'none' },
  { kind: 'shell', name: 'focused-frame', file: 'apps/web/src/shell/focused-frame.tsx', reads: 'none' },
  { kind: 'shell', name: 'menu', file: 'apps/web/src/shell/menu.tsx', reads: 'company' },
  { kind: 'shell', name: 'no-page', file: 'apps/web/src/shell/no-page.tsx', reads: 'none' },
  { kind: 'shell', name: 'right-panel', file: 'apps/web/src/shell/right-panel.tsx', reads: 'none' },
  { kind: 'shell', name: 'shell', file: 'apps/web/src/shell/shell.tsx', reads: 'company' },
  { kind: 'shell', name: 'shortcut-keys', file: 'apps/web/src/shell/shortcut-keys.tsx', reads: 'none' },
  { kind: 'shell', name: 'shortcuts-help', file: 'apps/web/src/shell/shortcuts-help.tsx', reads: 'none' },
  { kind: 'shell', name: 'view-banner', file: 'apps/web/src/shell/view-banner.tsx', reads: 'none' },
  { kind: 'shell', name: 'session', file: 'apps/web/src/session.tsx', reads: 'before' },
  { kind: 'setup', name: 'asked', file: 'apps/web/src/setup/asked.ts', reads: 'before' },
  { kind: 'setup', name: 'creation-on-demand', file: 'apps/web/src/setup/creation-on-demand.ts', reads: 'before' },
  { kind: 'setup', name: 'standing', file: 'apps/web/src/setup/standing.ts', reads: 'before' },
  { kind: 'setup', name: 'step-ids', file: 'apps/web/src/setup/step-ids.ts', reads: 'before' },
  { kind: 'setup', name: 'steps', file: 'apps/web/src/setup/steps.ts', reads: 'before' },
]);
