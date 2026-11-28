import type { AlertTone, BadgeTone } from '../components/status.js';

/* ---------- the specimens ---------- */

/* The looks a screen asks for, by the names this page has always shown, and
 * the kit's variant and size each one is drawn with. */
export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';
export const KIT_VARIANT = {
  primary: 'default',
  secondary: 'outline',
  outline: 'outline',
  ghost: 'ghost',
  danger: 'destructive',
  link: 'link'
} as const satisfies Record<ButtonVariant, string>;
export const KIT_SIZE = { sm: 'sm', md: 'default', lg: 'lg', icon: 'icon' } as const satisfies Record<
  ButtonSize,
  string
>;

export const BUTTON_VARIANTS: readonly ButtonVariant[] = ['primary', 'secondary', 'outline', 'ghost', 'danger', 'link'];
export const BUTTON_SIZES: readonly ButtonSize[] = ['sm', 'md', 'lg', 'icon'];

export const BADGE_TONES: readonly BadgeTone[] = ['neutral', 'accent', 'pending', 'sent', 'failed', 'warning'];

export const ALERT_TONES: readonly AlertTone[] = ['info', 'success', 'warning', 'danger'];

export const COLOUR_ROLES: readonly { readonly token: string; readonly note: string }[] = [
  { token: '--color-bg', note: 'the page' },
  { token: '--color-raised', note: 'a card, the rail' },
  { token: '--color-sunken', note: 'a field, a well' },
  { token: '--color-line', note: 'ordinary borders' },
  { token: '--color-line-strong', note: 'a control’s border' },
  { token: '--color-ink', note: 'text' },
  { token: '--color-muted', note: 'secondary text' },
  { token: '--color-faint', note: 'labels, hints' },
  { token: '--color-accent', note: 'one accent, and only one' },
  { token: '--color-accent-strong', note: 'its hover' },
  { token: '--color-pending', note: 'a payment with no answer yet' },
  { token: '--color-good', note: 'sent, secured, verified' },
  { token: '--color-warn', note: 'at risk' },
  { token: '--color-bad', note: 'failed, dangerous' }
];

export const TYPE_STEPS: readonly { readonly cls: string; readonly name: string }[] = [
  { cls: 'text-xs', name: 'text-xs — 0.75rem' },
  { cls: 'text-sm', name: 'text-sm — 0.875rem' },
  { cls: 'text-base', name: 'text-base — 1rem' },
  { cls: 'text-lg', name: 'text-lg — 1.125rem' },
  { cls: 'text-xl', name: 'text-xl — 1.25rem' },
  { cls: 'text-2xl', name: 'text-2xl — 1.5rem' },
  { cls: 'text-[2.75rem]', name: 'text-display — 2.75rem' }
];

/* The five chart colours. They are a PALETTE entry and not a chart
 * component: shadcn's charts arrive later through `add chart`, and what had to
 * be settled now was whether the ramp agrees with the rest of the palette. */
export const CHART_STEPS = ['1', '2', '3', '4', '5'] as const;

/* Six variants stay, four are the default, and **the label
 * on this page is the enforcement** — because this page is what a person
 * building a screen reads first. */
export const BY_REQUEST_ONLY: readonly ButtonVariant[] = ['outline', 'link'];
