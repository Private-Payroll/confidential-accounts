import { useId } from 'react';
import type { ReactNode } from 'react';
import { cn } from './cn.js';

/**
 * SECTION — a titled region of a page, and the two things Settings needed that
 * nothing in the kit had.
 *
 * THE RULE: *"Section headings and the danger section's treatment
 * may need something new; if so it goes in the kit and in `#/kit` beside its
 * siblings, not inline in the screen."* Both are here, and they are one
 * component because they are one shape with one variable.
 *
 * IT IS A `<section>` WITH A REAL HEADING AND `aria-labelledby`, WHICH IS THE
 * WHOLE REASON IT IS A COMPONENT. A settings page is a column of regions, and
 * a screen reader's landmark list is how somebody without a mouse skips to the
 * one they want. A `<div>` with a bold paragraph on top looks identical and is
 * one undifferentiated wall of controls to a rotor. The `id` is generated, so
 * two sections on one page cannot collide and no screen has to invent one.
 *
 * `CardTitle` IS AN `h3` AND THIS IS AN `h2`, ON PURPOSE. A place's own
 * heading is the `h1`; a section of it is an `h2`; a card inside a section is
 * an `h3`. That ladder is what makes heading navigation work, and it is the
 * kind of thing that goes wrong invisibly if every screen decides for itself.
 *
 * THE DEFAULT TONE DRAWS NO BOX. The page is the column; the cards inside a
 * section carry the surfaces. A border around every section would be a card
 * inside a card by the second one.
 *
 * `danger` IS THE ONE THAT IS NOT COSMETIC. The design asks for the
 * destructive section to be *"bottom of the page, visually apart"* — apart is
 * the job of this tone, and it is here rather than in the screen so the next
 * destructive surface looks like this one instead of like whatever that
 * afternoon produced. It is NOT `Alert tone="danger"`: an alert is a sentence
 * that has just become true and takes `role="alert"`; this is a region of a
 * page that is always there, and announcing it on every render would be the
 * screen-reader equivalent of a notification that will not stop.
 */

export type SectionTone = 'default' | 'danger';

export function Section({ title, description, tone = 'default', children, className }: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly tone?: SectionTone;
  readonly children?: ReactNode;
  readonly className?: string;
}): ReactNode {
  const headingId = useId();
  const danger = tone === 'danger';
  return (
    <section
      aria-labelledby={headingId}
      data-tone={tone}
      className={cn(
        'flex flex-col gap-3',
        danger && 'rounded-card border border-bad-border bg-bad-dim p-4',
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <h2
          id={headingId}
          className={cn('m-0 text-base font-semibold', danger ? 'text-bad' : 'text-ink')}
        >
          {title}
        </h2>
        {description !== undefined && (
          <p className="m-0 max-w-prose text-sm text-muted">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}
