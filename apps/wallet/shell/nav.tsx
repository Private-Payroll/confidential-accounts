import type { ReactNode } from 'react';
import { DropdownMenu as Menu } from 'radix-ui';
import { GLYPH, Icon } from '../kit/icon.js';
import type { IconSvgElement } from '../kit/icon.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../kit/tooltip.js';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader,
  SidebarMenu, SidebarMenuItem, sidebarMenuButtonVariants, useSidebar,
} from '../kit/sidebar.js';
import { hrefOf } from '../routes.js';
import type { RouteName } from '../routes.js';
import type { Identity, Secret } from 'midnight-identity';
import { AccountChip } from './account.js';
import { ThemePicker } from './theme.js';
import type { Theme, ThemeChoice } from './themes.js';

/**
 * THE NAVIGATION — four places and one action.
 *
 *     Home  ·  Activity  ·  ( + )  ·  Explore  ·  Settings
 *
 * FOUR PLACES IS THE CEILING: 44px targets plus a
 * centre action leave no room, and growth goes into Explore rather than into
 * the bar — which is the thing that usually rots a wallet's navigation.
 *
 * THE ORDER IS DATA. It is the array below and nothing else reads it in a
 * fixed order; reordering the places is editing a list.
 *
 * THE `+` IS NOT A PLACE. On the desktop sidebar it sits ABOVE the list as a
 * filled button, because an action that looks like a destination gets pressed
 * as one; on mobile it is the centre of the bar.
 *
 * THE LAYOUT SWITCH IS A MEDIA QUERY — `wide:` at 900px, in CSS, never a
 * JavaScript measurement. A JS switch flashes on load and stutters on resize,
 * and this app is meant to be wrapped in a native shell where neither is
 * survivable. `kit/sidebar.tsx`'s header records that the payload's own
 * `useIsMobile()` was dropped for exactly this reason.
 *
 * ============================================================================
 * THE RAIL IS NOW shadcn's `sidebar-07`, AND WHAT MOVED IS FINDABILITY
 * ============================================================================
 *
 * The old rail folded, remembered, and tooltipped its icons. A person could not
 * find the control. Three things changed and only the first is the fix:
 *
 *   **THE TRIGGER LEFT THE SIDEBAR.** It was the first of three controls in a
 *   group at the BOTTOM of the column it collapses, wearing the word "Narrow".
 *   It is now in the PLACE HEADER at the top left — outside the sidebar,
 *   first in the tab order of the header, visible at both widths, with
 *   Cmd/Ctrl+B beside it. That is where `sidebar-07` puts it and where every
 *   application that has one puts it. It is rendered by `ui.tsx`, not here,
 *   because a control that folds a column from inside that column is the
 *   failure being fixed.
 *
 *   **THE WALLET SWITCHER MOVED INTO THE FOOTER**, where `sidebar-07` puts its
 *   user menu and where it was asked for. On a phone there is no sidebar, so
 *   the chip stays in the place header there — the same two-layout split the
 *   places themselves have, and the same one the theme and lock controls
 *   already had.
 *
 *   **THE CURRENT PLACE USES THE BLOCK'S OWN ACTIVE STATE** — `data-active`,
 *   which `sidebarMenuButtonVariants` styles — rather than a hand-written
 *   `aria-current` branch. `aria-current="page"` is still on the link, because
 *   that is the fact; `data-active` is how it is drawn.
 *
 * WHAT DID NOT CHANGE, and both are pinned by `rail.test.tsx`:
 *
 *   **The accessible name never changes.** Folded or not, every link carries
 *   its word — as visible text when there is room and as `aria-label` when
 *   there is not. A sidebar that folded its labels out of the accessibility
 *   tree would read as four unnamed links.
 *
 *   **A folded link gets a tooltip and an unfolded one does not.** The links
 *   are styled with the block's `sidebarMenuButtonVariants` and wrapped in
 *   `TooltipTrigger` here rather than through `SidebarMenuButton`'s `tooltip`
 *   prop. `kit/sidebar.tsx` carries the measurement that forced it: `asChild`
 *   on the button plus `asChild` on the tooltip trigger is two nested Radix
 *   `Slot`s, the inner one wins, and the rendered link comes out
 *   `data-slot="sidebar-menu-button"` — which is present whether or not a
 *   tooltip exists, so accepting it would turn this claim into a test that
 *   passes with the tooltips deleted.
 *
 * THE BOTTOM BAR DOES NOT FOLD AND HAS NO TOOLTIPS. There is no hover on a
 * phone (*"no hover-only affordances anywhere"*),
 * and a tooltip that only appears on hover is an invisible one there.
 */

interface Place {
  readonly route: RouteName;
  readonly label: string;
  readonly icon: IconSvgElement;
}

export const PLACES: readonly Place[] = [
  { route: 'home', label: 'Home', icon: GLYPH.home },
  { route: 'activity', label: 'Activity', icon: GLYPH.activity },
  { route: 'explore', label: 'Explore', icon: GLYPH.explore },
  { route: 'settings', label: 'Settings', icon: GLYPH.settings },
];

/**
 * THE ACTION MENU. Send is the only entry that exists, and the shape below is
 * why adding the next one is a line rather than a redesign.
 *
 * NOT HERE, AND NOT BY OVERSIGHT: there is no Swap. `initSwap` is half of a
 * two-party atomic exchange, not a capability this wallet has, and a menu
 * item for it would be either a dead end or an invented feature.
 */
interface Action {
  readonly route: RouteName;
  readonly label: string;
  readonly says: string;
  readonly icon: IconSvgElement;
}

const ACTIONS: readonly Action[] = [
  {
    route: 'send',
    label: 'Send',
    says: 'Pay an address from the wallet that is open',
    icon: GLYPH.send,
  },
];

function ActionMenu({ side, trigger }: {
  readonly side: 'top' | 'right';
  readonly trigger: ReactNode;
}): ReactNode {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>{trigger}</Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          side={side}
          /* Beside the sidebar's button it hangs from the button's own top
           * edge; above the bar's it is centred on it. */
          align={side === 'right' ? 'start' : 'center'}
          sideOffset={10}
          className={[
            'z-50 min-w-56 rounded-card border border-line bg-raised p-1.5 shadow-lg',
            'motion-safe:data-[state=open]:animate-[shell-fade_var(--motion-quick)_var(--motion-ease)]',
          ].join(' ')}
        >
          {ACTIONS.map((action) => (
            <Menu.Item key={action.route} asChild>
              <a
                href={hrefOf(action.route)}
                className={[
                  'flex min-h-touch cursor-pointer items-center gap-3 rounded-tight px-3 py-2',
                  'text-ink no-underline outline-none',
                  'data-highlighted:bg-sunken data-highlighted:text-ink',
                ].join(' ')}
              >
                <Icon glyph={action.icon} className="text-accent" />
                <span>
                  <span className="block text-sm font-semibold">{action.label}</span>
                  <span className="block text-xs text-muted">{action.says}</span>
                </span>
              </a>
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

const NEW_ACTION_LABEL = 'New action — send';

/** The sidebar's `+`: a filled button, above the list. Folded, it is the glyph
 * alone and keeps its name. */
function RailAction({ collapsed }: { readonly collapsed: boolean }): ReactNode {
  return (
    <ActionMenu
      side="right"
      trigger={(
        <button
          type="button"
          aria-label={NEW_ACTION_LABEL}
          className={[
            'flex min-h-touch items-center justify-center gap-2 rounded-card',
            'border-0 bg-accent px-3 py-2 font-semibold text-accent-ink',
            'transition-colors duration-(--motion-quick) hover:bg-accent-strong',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
            collapsed ? 'w-touch self-center px-0' : 'w-full',
          ].join(' ')}
        >
          <Icon glyph={GLYPH.newAction} />
          {!collapsed && <span>New</span>}
        </button>
      )}
    />
  );
}

/** The bar's `+`: the centre of the five, and visibly not a destination. */
function BarAction(): ReactNode {
  return (
    <ActionMenu
      side="top"
      trigger={(
        <button
          type="button"
          aria-label={NEW_ACTION_LABEL}
          className={[
            /* `p-0` and the explicit border are not decoration: this repo's
             * stylesheet styles the `button` ELEMENT — padding, border,
             * background — and a shell control that does not state its own
             * inherits an ordinary button's. The `+` was a 9px glyph in a
             * 44px circle before this line existed. */
            'flex size-touch shrink-0 items-center justify-center rounded-full border-0 p-0',
            'bg-accent text-accent-ink',
            'transition-colors duration-(--motion-quick) hover:bg-accent-strong',
          ].join(' ')}
        >
          <Icon glyph={GLYPH.newAction} className="size-6" />
        </button>
      )}
    />
  );
}

/**
 * A PLACE IN THE SIDEBAR. The link is the element — an `<a>` through the
 * block's `asChild`, so it can be opened in a new tab, copied, and appears in
 * a screen reader's link list, which a `<button onClick={…hash…}>` cannot.
 */
function SidebarPlace({ place, current, collapsed }: {
  readonly place: Place;
  readonly current: boolean;
  readonly collapsed: boolean;
}): ReactNode {
  const link = (
    <a
      href={hrefOf(place.route)}
      aria-current={current ? 'page' : undefined}
      data-sidebar="menu-button"
      data-active={current}
      data-place={place.route}
      /* The name is on the element in EVERY state, so a folded sidebar is not
       * a row of anonymous links to anything that is not looking at pixels. */
      aria-label={collapsed ? place.label : undefined}
      className={sidebarMenuButtonVariants({})}
    >
      <Icon glyph={place.icon} />
      {!collapsed && <span>{place.label}</span>}
    </a>
  );
  return (
    <SidebarMenuItem>
      {collapsed
        ? (
          <Tooltip>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>{place.label}</TooltipContent>
          </Tooltip>
        )
        : link}
    </SidebarMenuItem>
  );
}

/** A place in the BOTTOM BAR — a different shape, and never folded. */
function BarPlace({ place, current }: {
  readonly place: Place;
  readonly current: boolean;
}): ReactNode {
  return (
    <a
      href={hrefOf(place.route)}
      aria-current={current ? 'page' : undefined}
      data-place={place.route}
      className={[
        'flex min-h-touch min-w-touch flex-1 flex-col items-center justify-center gap-0.5',
        'rounded-tight text-xs no-underline',
        'transition-colors duration-(--motion-quick)',
        current
          ? 'bg-accent-dim font-semibold text-accent'
          : 'text-muted hover:bg-sunken hover:text-ink',
      ].join(' ')}
    >
      <Icon glyph={place.icon} />
      <span>{place.label}</span>
    </a>
  );
}

/**
 * DESKTOP. Home first, the `+` above the list, the wallet switcher in the
 * footer, and the two things that are neither a place nor an action — theme
 * and lock — under it.
 *
 * THE FOLD CONTROL IS NOT HERE. `ui.tsx` renders it in the place header. That
 * is the change.
 */
export function Rail({ current, identity, secret, theme, choice, onTheme, onLock }: {
  readonly current: RouteName;
  readonly identity: Identity;
  readonly secret: Secret;
  readonly theme: Theme;
  readonly choice: ThemeChoice;
  readonly onTheme: (next: ThemeChoice) => void;
  readonly onLock: (() => void) | null;
}): ReactNode {
  const { state } = useSidebar();
  const collapsed = state === 'collapsed';
  return (
    <Sidebar>
      <SidebarHeader>
        <a
          href={hrefOf('home')}
          aria-label="Midnight Identity — home"
          className={['wordmark py-1', collapsed ? 'justify-center px-0' : 'px-2'].join(' ')}
        >
          <span className="moon" aria-hidden="true" />
          {!collapsed && 'Midnight Identity'}
        </a>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="gap-3 pb-0">
          <RailAction collapsed={collapsed} />
          {/* `data-collapsed` names the state of the NAVIGATION for anything
            * reading the DOM; `data-state` on the sidebar root drives the CSS.
            * They are not two spellings of one fact — one is the nav's, one is
            * the group root's, and the `group-data-*` variants need it there. */}
          <nav
            aria-label="Places"
            data-collapsed={collapsed ? 'true' : 'false'}
          >
            <SidebarMenu>
              {PLACES.map((place) => (
                <SidebarPlace
                  key={place.route}
                  place={place}
                  current={place.route === current}
                  collapsed={collapsed}
                />
              ))}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        {/* The switcher lives here now. */}
        <AccountChip identity={identity} secret={secret} variant="sidebar" />
        <div className={collapsed ? 'flex flex-col gap-1' : 'flex items-center gap-1'}>
          <ThemePicker choice={choice} theme={theme} onChoose={onTheme} wide={!collapsed} />
          {onLock !== null && <LockControl collapsed={collapsed} onLock={onLock} />}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

/** Lock — neither a place nor an action, and the one control here whose word
 * is short enough to keep at every width. */
function LockControl({ collapsed, onLock }: {
  readonly collapsed: boolean;
  readonly onLock: () => void;
}): ReactNode {
  const button = (
    <button
      type="button"
      onClick={onLock}
      aria-label="Lock the wallet"
      className={[
        'flex min-h-touch items-center gap-2 rounded-tight border border-transparent',
        'bg-transparent py-2 text-sm font-normal text-muted',
        'transition-colors duration-(--motion-quick)',
        'hover:border-line hover:bg-sunken hover:text-ink',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        collapsed ? 'w-touch justify-center self-center px-0' : 'flex-1 px-2',
      ].join(' ')}
    >
      <Icon glyph={GLYPH.lock} />
      {!collapsed && <span className="truncate">Lock</span>}
    </button>
  );
  if (!collapsed) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>Lock the wallet</TooltipContent>
    </Tooltip>
  );
}

/** MOBILE. `env(safe-area-inset-bottom)` is not a nicety: without it the bar
 * sits under the iPhone home indicator, which is the single commonest tell of
 * a wrapped web app. */
export function BottomBar({ current }: { readonly current: RouteName }): ReactNode {
  const [first, second, third, fourth] = PLACES;
  return (
    <nav
      aria-label="Places"
      className={[
        'sticky bottom-0 z-30 flex items-center gap-1 border-t border-line bg-raised px-2 pt-1',
        'pb-[calc(0.25rem+env(safe-area-inset-bottom))]',
        'wide:hidden',
        'print:hidden',
      ].join(' ')}
    >
      {first && <BarPlace place={first} current={first.route === current} />}
      {second && <BarPlace place={second} current={second.route === current} />}
      <BarAction />
      {third && <BarPlace place={third} current={third.route === current} />}
      {fourth && <BarPlace place={fourth} current={fourth.route === current} />}
    </nav>
  );
}
