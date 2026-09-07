import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { cn } from './cn.js';

/**
 * INPUT and TEXTAREA — one set of field classes, two elements.
 *
 * `bg-bg` RATHER THAN A SURFACE COLOUR, in both themes: the page background is
 * darker than a card in dark and greyer than a card in light, so a field reads
 * as recessed either way without a second pair of tokens.
 *
 * THE ERROR STATE IS `aria-invalid`, NOT A PROP. A red border that a screen
 * reader cannot see is decoration; `aria-invalid` is the fact, and the colour
 * is CSS reacting to it. That is the same discipline as the shell's Radix
 * `data-state` animation — the attribute is the truth and the style follows.
 *
 * It takes `--color-bad` and NOT `--color-bad-border`, which is the token the
 * `.error` panel and `Alert` use. Looked at on the gallery in both themes, the
 * dim border (0.35 alpha in dark) sat too close to `line-strong` (0.18) to
 * read as a state on a single control. A large panel can carry a soft edge
 * because its fill and its icon say the same thing; a field has only the edge.
 *
 * `mono` IS FOR ADDRESSES AND BYTES. It is a prop rather than a class at the
 * call site because it changes size as well as family, and the two have to
 * move together.
 */

const FIELD = [
  'block w-full rounded-tight border border-line-strong bg-bg px-3 py-2',
  'font-sans text-base text-ink placeholder:text-faint',
  'transition-colors duration-(--motion-quick)',
  'hover:border-faint',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
  'disabled:cursor-default disabled:bg-sunken disabled:text-muted disabled:opacity-55',
  'read-only:text-muted',
  'aria-invalid:border-bad aria-invalid:hover:border-bad',
].join(' ');

const MONO = 'font-mono text-sm tracking-tight';

export interface FieldLook {
  /** Addresses, identifiers, piece bytes — anything compared character by
   * character. */
  readonly mono?: boolean;
}

export function Input(
  { className, mono, ...rest }: FieldLook & InputHTMLAttributes<HTMLInputElement>,
): ReactNode {
  return (
    <input
      className={cn(FIELD, 'min-h-touch', mono === true && MONO, className)}
      {...rest}
    />
  );
}

export function Textarea(
  { className, mono, ...rest }: FieldLook & TextareaHTMLAttributes<HTMLTextAreaElement>,
): ReactNode {
  return (
    <textarea
      className={cn(FIELD, 'min-h-24 leading-relaxed', mono === true && MONO, className)}
      {...rest}
    />
  );
}
