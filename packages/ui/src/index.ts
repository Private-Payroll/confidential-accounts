/**
 * THE COMPONENT KIT THE NEW PAYROLL APPLICATION IS BUILT FROM.
 *
 * What an application uses is re-exported here. An amount reaches a screen
 * only through `Amount` or `Balance`: the formatter behind them is not
 * re-exported, and the application's source rules refuse any other import of it.
 */
export { KitProvider } from './kit-provider.js';
export { LanguageProvider, useLanguage, useText, type LanguageProviderProps } from './i18n/provider.js';
export { FALLBACK, chooseLanguage, directionOf, languagesFrom, type Language, type Messages } from './i18n/languages.js';
export { formatDate, formatNumber } from './format/intl.js';
export type { TokenAmount } from './format/token-amount.js';
export { Amount, type AmountProps, type Visibility } from './components/amount.js';
export { Balance, type BalanceProps, type Holding } from './components/balance.js';
export { PublicPill, type AmountKind } from './components/public-pill.js';
export { ComingSoon, type ComingSoonProps } from './components/coming-soon.js';
export { ConfirmInYourAccount, type ConfirmInYourAccountProps } from './components/confirm-in-your-account.js';
export { Badge } from './components/badge.js';
export { Button } from './components/button.js';
export { Popover, PopoverContent, PopoverTrigger } from './components/popover.js';
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/tooltip.js';
export { BASE_COLORS, DEFAULT_BASE_COLOR, THEMES, type BaseColor, type Theme } from './theme/base-colors.js';
