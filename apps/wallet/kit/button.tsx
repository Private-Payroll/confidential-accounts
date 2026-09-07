import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.js';

/**
 * BUTTON — six variants, four sizes, and no other way to make one.
 *
 * The shapes are shadcn's (default / secondary / outline / ghost / destructive
 * / link); the values are this repository's tokens, which is the split
 * THE RULE asks for: *"where a shadcn component and this repo's
 * conventions disagree on style, the repo wins; where they disagree on
 * behaviour or accessibility, shadcn wins."*
 *
 * EVERY VARIANT STATES ITS OWN BACKGROUND, BORDER, PADDING, RADIUS, WEIGHT AND
 * COLOUR, and that is not verbosity. `app.css` styles the `button` ELEMENT —
 * this app predates utilities and eleven screens rely on those rules. A kit
 * button that left any of them unsaid would inherit the ordinary button's, as
 * The old `+` did before `nav.tsx` learned to say `border-0 p-0`.
 *
 * `md` IS 44px, NOT 36px. shadcn's default is a mouse's height; this app is
 * being built to native conventions from the start (by design,
 * the iOS path) and 44px is the smallest thing a finger may be asked to hit.
 * `sm` exists for controls sitting inside a row that is already a touch
 * target.
 *
 * NO HOVER-ONLY AFFORDANCE ANYWHERE. Hover changes colour; it never reveals a
 * control. On a phone there is no hover and a revealed control is an invisible
 * one.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const BASE = [
  'inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap',
  'font-sans align-middle no-underline',
  'transition-colors duration-(--motion-quick)',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
  'disabled:pointer-events-none disabled:opacity-55',
  'aria-disabled:pointer-events-none aria-disabled:opacity-55',
].join(' ');

const VARIANT: Record<ButtonVariant, string> = {
  primary: [
    'border border-accent bg-accent text-accent-ink font-semibold',
    'hover:border-accent-strong hover:bg-accent-strong',
  ].join(' '),
  secondary: [
    'border border-line-strong bg-raised text-ink font-medium',
    'hover:border-faint hover:bg-sunken',
  ].join(' '),
  outline: [
    'border border-line-strong bg-transparent text-ink font-medium',
    'hover:border-faint hover:bg-sunken',
  ].join(' '),
  ghost: [
    'border border-transparent bg-transparent text-muted font-medium',
    'hover:border-line hover:bg-sunken hover:text-ink',
  ].join(' '),
  /* Transparent on purpose. A filled red button is the easiest thing on a
   * screen to press by accident, and everything this word is attached to in
   * this wallet is irreversible. */
  danger: [
    'border border-bad-border bg-transparent text-bad font-medium',
    'hover:bg-bad-dim',
  ].join(' '),
  link: [
    'border border-transparent bg-transparent text-accent font-medium',
    'underline-offset-4 hover:text-accent-strong hover:underline',
  ].join(' '),
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'min-h-9 rounded-tight px-3 py-1.5 text-sm',
  md: 'min-h-touch rounded-tight px-4 py-2 text-base',
  lg: 'min-h-12 rounded-card px-6 py-3 text-base',
  icon: 'size-touch rounded-tight p-0',
};

/**
 * `link` takes NO size padding, and the reason is the whole point of `cn.ts`:
 * with no `tailwind-merge`, `p-0` written after `px-4` does not beat it —
 * Tailwind's emission order decides, and the shorthand loses. So the padding
 * is never emitted rather than emitted and argued with.
 */
function classesFor(variant: ButtonVariant, size: ButtonSize, extra?: string): string {
  const sized = variant === 'link' ? 'min-h-9 text-base' : SIZE[size];
  return cn(BASE, VARIANT[variant], sized, extra);
}

/**
 * THE SAME CLASSES, FOR A CONTROL THIS FILE DOES NOT RENDER, and it is
 * additive: nothing about `Button` or `ButtonLink` moves.
 *
 * `ui.tsx`'s `CopyButton` owns behaviour this kit has no business duplicating
 * — a clipboard write, a confirmation that expires, and the lesson that
 * the confirmation must clear when the VALUE changes. The send screen needs
 * that button to look like the kit's, and there were only two ways to get
 * there: copy the class list into the screen, which puts a second answer to
 * "what does a button look like" outside this file, or export the one answer.
 *
 * **THE KIT STILL DECIDES.** A caller passes a variant and a size and gets
 * whatever those mean today; it does not get to assemble its own.
 */
export function buttonClasses(
  variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra?: string,
): string {
  return classesFor(variant, size, extra);
}

export interface ButtonLook {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

type ButtonProps = ButtonLook & ButtonHTMLAttributes<HTMLButtonElement>;

export function Button({
  variant = 'secondary', size = 'md', className, type = 'button', ...rest
}: ButtonProps): ReactNode {
  /* eslint-disable-next-line react/button-has-type -- `type` is defaulted above. */
  return <button type={type} className={classesFor(variant, size, className)} {...rest} />;
}

type ButtonLinkProps = ButtonLook & AnchorHTMLAttributes<HTMLAnchorElement>;

/**
 * The same button as an anchor — for navigation, which is what `href` means.
 * A `<button onClick={() => location.hash = …}>` is not a link: it cannot be
 * opened in a new tab, copied, or reached by a screen reader's link list.
 */
export function ButtonLink({
  variant = 'secondary', size = 'md', className, ...rest
}: ButtonLinkProps): ReactNode {
  return <a className={classesFor(variant, size, className)} {...rest} />;
}
