import type { ReactNode } from 'react';
import { cn } from 'vaults-ui/lib/utils';
import {
  Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle,
} from 'vaults-ui/components/item';
import { Glyph } from '../glyphs.js';
import type { IconSvgElement } from '../glyphs.js';

/**
 * THE WALLET'S ROWS AND TILES, EACH ONE OF THE KIT'S ITEMS.
 *
 * A row is one thing in a list: a wallet, a device, a setting that leads
 * somewhere. A tile is one of Home's shortcuts. Both are the kit's `item`,
 * given the wallet's own shape - what leads, what it is called, what it says,
 * what trails - so every list and every shortcut draws the same way.
 *
 * A row that goes somewhere is a link, one that does something is a button,
 * and one that is only read is neither; the item takes the element it is.
 */

export interface RowItemProps {
  readonly leading?: ReactNode;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly trailing?: ReactNode;
  readonly meta?: ReactNode;
  readonly href?: string;
  readonly onClick?: () => void;
  /** The row that is chosen now, marked for sight and for a screen reader. */
  readonly current?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function RowItem({
  leading, title, subtitle, trailing, meta, href, onClick, current, disabled, className,
}: RowItemProps): ReactNode {
  const interactive = (href !== undefined || onClick !== undefined) && disabled !== true;
  const look = cn(
    'flex-nowrap text-start',
    current === true && 'bg-muted',
    interactive && 'cursor-pointer hover:bg-muted',
    disabled === true && 'pointer-events-none opacity-50',
    className,
  );

  const body = (
    <>
      {leading !== undefined && <ItemMedia>{leading}</ItemMedia>}
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="block w-full truncate">{title}</ItemTitle>
        {subtitle !== undefined && (
          <ItemDescription className="block truncate text-xs">{subtitle}</ItemDescription>
        )}
      </ItemContent>
      {(trailing !== undefined || meta !== undefined) && (
        <ItemActions className="shrink-0 flex-col items-end gap-0.5 text-end">
          {trailing !== undefined && <span className="block text-sm font-medium">{trailing}</span>}
          {meta !== undefined && <span className="block text-xs text-muted-foreground">{meta}</span>}
        </ItemActions>
      )}
    </>
  );

  const variant = current === true ? 'outline' : 'default';
  if (href !== undefined) {
    return (
      <Item asChild size="sm" variant={variant} className={look}>
        <a href={href} aria-current={current === true ? 'true' : undefined}>{body}</a>
      </Item>
    );
  }
  if (onClick !== undefined) {
    return (
      <Item asChild size="sm" variant={variant} className={look}>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled === true}
          aria-current={current === true ? 'true' : undefined}
        >
          {body}
        </button>
      </Item>
    );
  }
  return <Item size="sm" variant={variant} className={look}>{body}</Item>;
}

/** Rows one under another, a rule between each. */
export function RowItems({ children, className }: {
  readonly children: ReactNode;
  readonly className?: string;
}): ReactNode {
  return <div className={cn('flex flex-col divide-y', className)}>{children}</div>;
}

export interface ShortcutTileProps {
  readonly glyph: IconSvgElement;
  readonly label: string;
  readonly says?: string;
  /** Whether what it says may wrap, where a short line would lose its sense. */
  readonly saysWraps?: boolean;
  readonly href?: string;
  readonly onClick?: () => void;
  /** The one tile in a row that is the thing most people came for. */
  readonly tone?: 'accent' | 'quiet';
  readonly trailing?: ReactNode;
  readonly className?: string;
}

/** A shortcut: its glyph, its name, and a line on what it does. */
export function ShortcutTile({
  glyph, label, says, saysWraps = false, href, onClick, tone = 'quiet', trailing, className,
}: ShortcutTileProps): ReactNode {
  const look = cn(
    'flex-col flex-nowrap items-start gap-2 bg-card text-start shadow-xs',
    (href !== undefined || onClick !== undefined) && 'cursor-pointer hover:bg-muted',
    className,
  );
  const body = (
    <>
      <span className="flex w-full items-start gap-2">
        <ItemMedia variant="icon" className={tone === 'accent' ? 'text-primary' : 'text-muted-foreground'}>
          <Glyph icon={glyph} />
        </ItemMedia>
        {trailing !== undefined && <span className="ms-auto shrink-0">{trailing}</span>}
      </span>
      <span className="w-full min-w-0">
        <span className="block truncate text-sm font-medium">{label}</span>
        {says !== undefined && (
          <span className={cn('block text-xs text-muted-foreground', !saysWraps && 'truncate')}>
            {says}
          </span>
        )}
      </span>
    </>
  );
  if (href !== undefined) {
    return <Item asChild variant="outline" className={look}><a href={href}>{body}</a></Item>;
  }
  if (onClick !== undefined) {
    return <Item asChild variant="outline" className={look}><button type="button" onClick={onClick}>{body}</button></Item>;
  }
  return <Item variant="outline" className={look}>{body}</Item>;
}

/** Shortcuts in a grid: two across on a phone, four on a wider screen. */
export function ShortcutTiles({ children, className }: {
  readonly children: ReactNode;
  readonly className?: string;
}): ReactNode {
  return (
    <div className={cn('grid grid-cols-2 gap-3 md:grid-cols-4', className)}>
      {children}
    </div>
  );
}
