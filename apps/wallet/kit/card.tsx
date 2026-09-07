import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.js';

/**
 * CARD — header, content, footer.
 *
 * IT DOES NOT USE THE CLASS NAME `card`. `app.css` already owns `.card` and
 * eleven screens are built on it; a kit component wearing the same name would
 * inherit that rule's padding and margin and then fight it. The values below
 * are the same tokens `.card` reads, so the two look alike on purpose while
 * being independent — which is what lets later work move screens onto the
 * kit one at a time instead of all at once.
 *
 * `CardTitle` is an `h3` because a card is almost never the top heading on a
 * screen; the place's `h1` is. Pass `as` nothing — if a card needs to be an
 * `h2`, that is a layout decision for the screen, made by putting a real
 * heading above the card.
 */

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>): ReactNode {
  return (
    <div
      className={cn('rounded-card border border-line bg-raised text-ink', className)}
      {...rest}
    />
  );
}

/**
 * THE HEADER'S ACTION SLOT, and it is a SLOT rather than a button.
 *
 * THE RULE: *"the kit decides where the control sits and how it
 * looks at each size, screens decide what goes in it."* So this file owns the
 * position — right edge, top-aligned with the TITLE and not centred against a
 * title-plus-description block, which is what makes a one-line header and a
 * three-line one look like the same component — and owns nothing about what
 * the control is. Two callers land here, both a chevron to
 * the place a card is a preview of) and a third is known and dated (the money
 * card's refresh control, later). **A slot that only accepted a chevron would
 * be reopened the week the refresh icon arrives**, which is why the type is
 * `ReactNode` and there is no `href`, no `label` and no `icon` prop here.
 *
 * ONE CONTROL, NOT A TOOLBAR. `action` is singular on purpose: a header that
 * can hold three controls becomes a place where a screen puts its overflow,
 * and then every card's header is a different shape. A card that needs more
 * than one control needs a `CardFooter`, which already exists and already
 * sits on a rule.
 *
 * WITH NO `action`, THE MARKUP IS BYTE-IDENTICAL TO WHAT IT WAS. That is not
 * tidiness either: the design freezes the money card — *"its own
 * markup, copy, states and data shape do not change in this change by a single
 * character"* — and its `CardHeader` is one of the elements that freeze covers.
 * The early return below is what makes "the kit grew a slot" not also mean
 * "the frozen card's DOM moved".
 *
 * THE CONTROL IS NOT WRAPPED IN ANYTHING THAT STYLES IT. It sits in a plain
 * flex cell, so `Button variant="ghost" size="icon"` and `ButtonLink` arrive
 * looking like themselves — the kit already decided what those look like, and
 * deciding again here would be two answers to one question.
 */
export function CardHeader(
  { className, action, children, ...rest }:
  HTMLAttributes<HTMLDivElement> & { readonly action?: ReactNode },
): ReactNode {
  if (action === undefined) {
    return (
      <div className={cn('flex flex-col gap-1 px-5 pt-5 pb-3', className)} {...rest}>
        {children}
      </div>
    );
  }
  return (
    <div className={cn('flex items-start gap-3 px-5 pt-5 pb-3', className)} {...rest}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
      {/* `-mt-1 -mr-2` pulls a 44px control back so its GLYPH lines up with the
        * title's cap height rather than its box lining up with the text box —
        * the touch target is unchanged, only the optical alignment. */}
      <div data-card-action="" className="-mt-1 -mr-2 shrink-0">{action}</div>
    </div>
  );
}

export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>): ReactNode {
  return <h3 className={cn('m-0 text-base font-semibold text-ink', className)} {...rest} />;
}

export function CardDescription(
  { className, ...rest }: HTMLAttributes<HTMLParagraphElement>,
): ReactNode {
  return <p className={cn('m-0 text-sm text-muted', className)} {...rest} />;
}

export function CardContent({ className, ...rest }: HTMLAttributes<HTMLDivElement>): ReactNode {
  return <div className={cn('px-5 pb-5', className)} {...rest} />;
}

/** Sits on a rule, so the actions read as a separate thing from the content
 * above them rather than as the last paragraph of it. */
export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>): ReactNode {
  return (
    <div
      className={cn('flex flex-wrap items-center gap-2 border-t border-line px-5 py-3', className)}
      {...rest}
    />
  );
}
