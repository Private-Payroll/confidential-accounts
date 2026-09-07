import type { ReactNode } from 'react';
import { cn } from './cn.js';
import { Icon } from './icon.js';
import type { IconSvgElement } from './icon.js';

/**
 * ACTION TILE — an entry point into something, as a tile rather than a row.
 *
 * The shortcuts were a card titled *"Do something"* with four
 * list rows in it; they should be tiles, and they should sit ABOVE the money
 * rather than under it. **The tile shape is in the kit and not in
 * `screens/home.tsx`** because the design says so and because Explore
 * raises the same row later: a shape built inside one screen is a shape the
 * next screen copies.
 *
 * IT IS THE RIGHT ELEMENT FOR WHAT IT DOES — `kit/list-row.tsx`'s rule, and
 * the same reason. A tile that NAVIGATES is an `<a>`, so it can be opened in a
 * new tab and appears in a screen reader's link list; a tile that ACTS is a
 * `<button>`, so Space and Enter both work. Getting that wrong is invisible
 * with a mouse and immediate without one — and on Home it is load-bearing
 * beyond accessibility: **Send is a link because one surface approves anything
 * that moves money**, and a tile that could quietly become a button is a tile
 * that could quietly become a second approval path.
 *
 * NOTHING ABOUT AN ACTION CHANGES BY BECOMING A TILE. This component takes a
 * glyph, a label and a line of text; it has no idea whether what it points at
 * is a route, a popup or a place that is not built. That stays the caller's,
 * which is why moving the shortcuts here did not have to touch a single one of
 * the rules on them.
 *
 * 44px MINIMUM AND NO HOVER-ONLY AFFORDANCE, like every other interactive
 * thing in this kit: hover changes the surface and reveals nothing, because a
 * control that appears on hover does not exist on a phone.
 */

export interface ActionTileProps {
  readonly glyph: IconSvgElement;
  readonly label: string;
  /** One short line under the label. Truncated to one line on purpose — the
   * full sentence belongs on whatever the tile leads to. */
  readonly says?: string;
  /**
   * LET THE LINE WRAP, FOR A TILE THAT LEADS NOWHERE.
   *
   * The truncation above rests on one assumption: that there is a screen
   * behind the tile where the full sentence lives. Explore's six tiles are
   * `ActionTile`s with no `href` and no `onClick` — they lead nowhere, on
   * purpose, because none of the six exists yet — so the sentence has no
   * second home and a truncated one is a sentence nobody can read.
   *
   * DEFAULT-OFF, so every tile already shipped keeps the one-line shape it was
   * argued into. A row of tiles is a grid, and grid items stretch, so a
   * wrapping line makes every tile in its row taller together rather than
   * making one tile ragged.
   */
  readonly saysWraps?: boolean;
  readonly href?: string;
  readonly onClick?: () => void;
  /** The one tile in a row that is the ordinary thing to do wears the accent
   * on its glyph. Everything else is quiet — four accented tiles is no
   * hierarchy at all. */
  readonly tone?: 'accent' | 'quiet';
  readonly trailing?: ReactNode;
  readonly className?: string;
}

const SHARED = [
  'flex min-h-touch flex-col items-start gap-2 rounded-card border px-3 py-3 text-left',
  'border-line bg-raised font-normal no-underline',
  'transition-colors duration-(--motion-quick)',
].join(' ');

/**
 * THE HOVER BELONGS TO A TILE THAT DOES SOMETHING.
 *
 * A tile with neither `href` nor `onClick` renders as a `div` and always did;
 * what it also did was light up under the pointer and carry a focus ring it
 * could never show, because these two lines were in `SHARED`. Explore's six
 * tiles are the first non-interactive ones in the app, and six things that
 * respond to a pointer and then do nothing is an interface promising a screen
 * that does not exist. The look of every tile that navigates or acts is
 * unchanged.
 */
const INTERACTIVE = [
  'hover:border-line-strong hover:bg-sunken',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
].join(' ');

export function ActionTile({
  glyph, label, says, saysWraps = false, href, onClick, tone = 'quiet', trailing, className,
}: ActionTileProps): ReactNode {
  const look = cn(SHARED, (href !== undefined || onClick !== undefined) && INTERACTIVE, className);
  const body = (
    <>
      <span className="flex w-full items-start gap-2">
        <Icon glyph={glyph} className={tone === 'accent' ? 'text-accent' : 'text-muted'} />
        {trailing !== undefined && <span className="ml-auto shrink-0">{trailing}</span>}
      </span>
      <span className="min-w-0 w-full">
        <span className="block truncate text-sm font-semibold text-ink">{label}</span>
        {says !== undefined && (
          <span className={cn('block text-xs text-muted', !saysWraps && 'truncate')}>
            {says}
          </span>
        )}
      </span>
    </>
  );
  if (href !== undefined) return <a href={href} className={look}>{body}</a>;
  if (onClick !== undefined) {
    return <button type="button" onClick={onClick} className={look}>{body}</button>;
  }
  return <div className={look}>{body}</div>;
}

/**
 * The row the tiles sit in. Two across on a phone and four across on a desktop
 * — the set on Home is four, and the design fixes it at four,
 * so this grid is not a general-purpose one and does not pretend to be.
 */
export function ActionTiles({ children, className }: {
  readonly children: ReactNode;
  readonly className?: string;
}): ReactNode {
  return (
    <div className={cn('grid grid-cols-2 gap-3 wide:grid-cols-4', className)}>{children}</div>
  );
}
