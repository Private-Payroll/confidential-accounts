import type { ReactNode } from 'react';
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarMenu,
  SidebarMenuButton, SidebarMenuItem, Tooltip, TooltipContent, TooltipTrigger, useSidebar,
} from 'vaults-ui';
import { GLYPH, Glyph } from '../glyphs.js';
import type { IconSvgElement } from '../glyphs.js';
import { hrefOf } from '../routes.js';
import type { RouteName } from '../routes.js';
import type { Identity, Secret } from 'midnight-identity';
import { AccountChip } from './account.js';
import { ThemePicker } from './theme.js';
import type { Theme, ThemeChoice } from './themes.js';

/**
 * THE NAVIGATION - four places and one action.
 *
 *     Home  ·  Activity  ·  ( + )  ·  Explore  ·  Settings
 *
 * FOUR PLACES IS THE CEILING: a phone's bar has room for four and a centre
 * action, and growth goes into Explore rather than into the bar.
 *
 * THE ORDER IS DATA. It is the array below and nothing else reads it in a
 * fixed order; reordering the places is editing a list.
 *
 * THE `+` IS NOT A PLACE. In the sidebar it sits above the list as a filled
 * button, because an action that looks like a destination gets pressed as one;
 * on a phone it is the centre of the bar.
 *
 * THE SIDEBAR IS THE KIT'S, in its inset layout: the menu on the frame, the
 * page an inset panel beside it, folding to icons. It is the same sidebar the
 * payroll application uses, so the two read as one product. The control that
 * folds it is in the page's header, outside the column it folds.
 *
 * ON A PHONE THERE IS NO SIDEBAR. The places are a bar along the bottom
 * instead, and the switcher, theme and lock move into the page's header.
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

interface Action {
  readonly route: RouteName;
  readonly label: string;
  readonly says: string;
  readonly icon: IconSvgElement;
}

/** What `+` offers. Send is the one action a wallet takes today. */
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        side={side}
        align={side === 'right' ? 'start' : 'center'}
        sideOffset={10}
        className="w-auto min-w-56"
      >
        {ACTIONS.map((action) => (
          <DropdownMenuItem key={action.route} asChild>
            <a href={hrefOf(action.route)} className="gap-3 py-2">
              <Glyph icon={action.icon} className="text-primary" />
              <span>
                <span className="block text-sm font-medium">{action.label}</span>
                <span className="block text-xs text-muted-foreground">{action.says}</span>
              </span>
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const NEW_ACTION_LABEL = 'New action — send';

function RailAction({ collapsed }: { readonly collapsed: boolean }): ReactNode {
  return (
    <ActionMenu
      side="right"
      trigger={(
        <Button
          type="button"
          aria-label={NEW_ACTION_LABEL}
          size={collapsed ? 'icon' : 'default'}
          className={collapsed ? 'self-center' : 'w-full'}
        >
          <Glyph icon={GLYPH.newAction} />
          {!collapsed && <span>New</span>}
        </Button>
      )}
    />
  );
}

function BarAction(): ReactNode {
  return (
    <ActionMenu
      side="top"
      trigger={(
        <Button type="button" aria-label={NEW_ACTION_LABEL} size="icon-lg" className="size-11 rounded-full">
          <Glyph icon={GLYPH.newAction} className="size-5" />
        </Button>
      )}
    />
  );
}

/**
 * A place in the sidebar. Folded, it keeps its name as the link's own label
 * and shows it beside the icon on hover and focus.
 */
function SidebarPlace({ place, current, collapsed }: {
  readonly place: Place;
  readonly current: boolean;
  readonly collapsed: boolean;
}): ReactNode {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={current} tooltip={place.label}>
        <a
          href={hrefOf(place.route)}
          aria-current={current ? 'page' : undefined}
          data-place={place.route}
          aria-label={collapsed ? place.label : undefined}
        >
          <Glyph icon={place.icon} />
          {!collapsed && <span>{place.label}</span>}
        </a>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** A place in the phone's bar: the icon over its name. */
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
        'flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-0.5',
        'rounded-md text-xs no-underline transition-colors',
        current
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
      ].join(' ')}
    >
      <Glyph icon={place.icon} className="size-5" />
      <span>{place.label}</span>
    </a>
  );
}

/**
 * The sidebar. Its fold state is the wallet's own remembered preference,
 * handed to the kit's sidebar by the shell.
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
    <Sidebar collapsible="icon" variant="inset">
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
        <SidebarGroup className="gap-3">
          <RailAction collapsed={collapsed} />
          {/* `data-collapsed` names the state of the navigation for anything
              that reads it, rather than a class name it would have to know. */}
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
        <AccountChip identity={identity} secret={secret} variant="sidebar" />
        <div className={collapsed ? 'flex flex-col gap-1' : 'flex items-center gap-1'}>
          <ThemePicker choice={choice} theme={theme} onChoose={onTheme} wide={!collapsed} />
          {onLock !== null && <LockControl collapsed={collapsed} onLock={onLock} />}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function LockControl({ collapsed, onLock }: {
  readonly collapsed: boolean;
  readonly onLock: () => void;
}): ReactNode {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size={collapsed ? 'icon' : 'default'}
      onClick={onLock}
      aria-label="Lock the wallet"
      className={collapsed ? 'self-center text-muted-foreground' : 'flex-1 justify-start text-muted-foreground'}
    >
      <Glyph icon={GLYPH.lock} />
      {!collapsed && <span className="truncate">Lock</span>}
    </Button>
  );
  if (!collapsed) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>Lock the wallet</TooltipContent>
    </Tooltip>
  );
}

/** The phone's bar of places, with the action in its centre. */
export function BottomBar({ current }: { readonly current: RouteName }): ReactNode {
  const [first, second, third, fourth] = PLACES;
  return (
    <nav
      aria-label="Places"
      className={[
        'sticky bottom-0 z-30 flex items-center gap-1 border-t bg-sidebar px-2 pt-1',
        'pb-[calc(0.25rem+env(safe-area-inset-bottom))]',
        'md:hidden',
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
