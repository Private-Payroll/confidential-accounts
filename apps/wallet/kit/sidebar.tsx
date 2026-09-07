import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"
import { GLYPH, Icon } from "./icon.js"
import { Separator } from "./separator.js"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip.js"
import { useRail } from "../shell/rail.js"

/**
 * SIDEBAR — fetched from the shadcn registry as part of the `sidebar-07`
 * block, and restyled onto this repo's tokens.
 *
 * PROVENANCE. This file was fetched from the shadcn registry on 21 Aug 2026,
 * and the fetch printed
 * the registry payload verbatim BEFORE writing it; the original is in
 * that printed record and kept whole, unmodified
 * (sha256 `f3132b72…`), so every line below
 * can be diffed against what arrived rather than taken on trust. The block
 * resolved to twelve items; this is the only one adopted, and the other eleven
 * are kept rather than deleted, with a verdict each in
 * the change's entry.
 *
 * WHY THIS FILE AT ALL. An earlier rail was hand-rolled. It was wired,
 * persisted, tooltipped and correct, and a person could not find the control
 * that folds it — the first human usability result this project has had. The
 * arrangement asked for was `sidebar-07`. What is worth having from it is the
 * ARRANGEMENT (a trigger in the header, the switcher in the footer, an obvious
 * active state) and the ATTRIBUTE CONTRACT that makes the collapsed state pure
 * CSS: `data-state`, `data-collapsible`, and the `group-data-[collapsible=icon]`
 * variants every part below reacts to. Those are kept exactly.
 *
 * ============================================================================
 * WHAT WAS REMOVED, AND WHY EACH ONE IS UNREACHABLE HERE RATHER THAN UNWANTED
 * ============================================================================
 *
 * The design says a maintained thing that has no effect is read by the
 * next person as a thing that does, and `noUnusedLocals` is on — so parts of
 * the payload that cannot run in this app are gone rather than kept dark.
 *
 *   `useIsMobile()` and the whole MOBILE BRANCH. The hook is a JAVASCRIPT
 *     LAYOUT SWITCH: `useState<boolean|undefined>(undefined)` then a
 *     `useEffect` that measures `window.innerWidth`, so the first paint is
 *     always the desktop answer and it flips afterwards.
 *     The design forbids exactly this by name — *"the switch is
 *     a CSS media query, around 900px — never a JavaScript layout switch,
 *     which flashes on load and stutters on resize"* — and gives the reason:
 *     this app is meant to be wrapped in a native shell, where neither is
 *     survivable. Below the breakpoint this wallet does not show a sidebar at
 *     all; it shows the BOTTOM BAR (`shell/nav.tsx`). So the `Sheet` branch has
 *     no call site, and `sheet` was not adopted with it.
 *
 *   `SidebarInset`. It renders a `<main>`. This app has exactly one `<main>`,
 *     which `app.tsx` focuses on every navigation so a screen reader starts at
 *     the new screen's heading, and `shell.test.tsx` claim 4 pins the
 *     count at one because a second silently steals that focus.
 *
 *   `SidebarRail`. A 16px strip with `tabIndex={-1}` that reveals itself on
 *     hover. That is the same failure with a different shape — a control that
 *     works and cannot be found — and by design: *"no
 *     hover-only affordances anywhere."* The trigger lives in the place header
 *     instead, visible at every width.
 *
 *   `SidebarMenuSkeleton`. Calls `Math.random()` at render. A component whose
 *     output differs run to run makes the screenshot set unreproducible, and
 *     this wallet's pictures are its evidence.
 *
 *   `SidebarInput`, `SidebarMenuAction` (`showOnHover`), `SidebarMenuBadge`,
 *     `SidebarGroupAction`. No call site: there is no search box in this
 *     sidebar and no per-row action.
 *
 *   `SidebarMenuSub`, `SidebarMenuSubItem`, `SidebarMenuSubButton`. Sub-
 *     navigation, which this wallet deliberately does not have:
 *     *"four places is the ceiling, on purpose …
 *     growth goes into Explore, not into the bar — which is the thing that
 *     usually rots a wallet's navigation."* A collapsible nav tree IS that
 *     mechanism, so `collapsible` was not adopted either.
 *
 *   The `floating` and `inset` VARIANTS and the `offcanvas`/`none` COLLAPSIBLE
 *     modes. One shape, one collapse behaviour; the rest were branches nothing
 *     selects.
 *
 * ============================================================================
 * WHAT WAS SUBSTITUTED — nine, and every one is named
 * ============================================================================
 *
 *   1. THE EIGHT `--sidebar-*` COLOUR ROLES -> this repo's own tokens.
 *      *"Do not let a second palette in beside the one
 *      app.css defines. One set of roles, one accent, one radius anchor."*
 *      `sidebar` declares those eight in `cssVars`; the fetch's own
 *      guard caught the write and restored `app.css` (hash `be7e2edd…` before
 *      and after), so they never landed. The mapping is:
 *          bg-sidebar                      -> bg-raised
 *          text-sidebar-foreground         -> text-ink
 *          bg-sidebar-accent               -> bg-sunken
 *          text-sidebar-accent-foreground  -> text-ink
 *          border-sidebar-border           -> border-line
 *          ring-sidebar-ring               -> outline-accent (see 4)
 *          bg-sidebar-primary              -> bg-accent
 *          text-sidebar-primary-foreground -> text-accent-ink
 *      This was MEASURED rather than assumed to be necessary:
 *      A token report compiles `app.css` with the installed
 *      Tailwind and lists the class names in these payloads that emit NO RULE
 *      in this repo. All eight `--sidebar-*` names are among the 29. A class
 *      that emits nothing fails silently, which is the worst way for a
 *      stylesheet to be wrong.
 *
 *      `--sidebar-width` and `--sidebar-width-icon` STAY, and they are not an
 *      exception to that rule: they are WIDTHS, set inline by the provider and
 *      read by the layout below. The ban is on a second palette.
 *
 *   2. `rounded-md` -> `rounded-tight`, `rounded-lg` -> `rounded-card`.
 *      This repo's radius scale has three steps and `md`/`lg` are not among
 *      them. THE RULE: *"if a screen needs a value the scale does not
 *      have, the answer is the nearest step on the scale, not a new value."*
 *      Tailwind's own `rounded-md` DOES emit here — it resolves to
 *      `--radius-md`, Tailwind's default rather than this repo's anchor — so
 *      leaving it would have been a fourth step arriving by accident.
 *
 *   3. `md:` (768px) -> `wide:` (900px). Tailwind's default breakpoint is not
 *      this app's layout switch; `--breakpoint-wide` in `app.css` is, and the
 *      bottom bar takes over below it.
 *
 *   4. THE FOCUS RING. shadcn uses `ring-2 ring-sidebar-ring`; every other
 *      control in this kit uses `focus-visible:outline-2
 *      focus-visible:outline-offset-2 focus-visible:outline-accent`. Two focus
 *      styles in one interface is a worse outcome than either of them.
 *
 *   5. `PanelLeftIcon` FROM `lucide-react` -> `GLYPH.collapseRail` through
 *      `kit/icon.tsx`. **This is a finding, not a preference.**
 *      `components.json` sets `iconLibrary: "hugeicons"`; it was recorded that the
 *      setting was written and had never been exercised, and that the next
 *      `add` of a component with icons in it would be the first real test. It
 *      was, and it FAILED — the registry emitted a lucide import anyway, and
 *      the CLI re-added `lucide-react` to `package.json` as `^1.33.0`, a range,
 *      undoing an earlier removal. Both were reversed by hand. Every future
 *      fetched component needs its icons checked rather than trusted.
 *
 *   6. `document.cookie` -> `shell/prefs.ts`, through the existing `useRail()`.
 *      A cookie is a third place this app keeps state, and unlike
 *      `localStorage` it is attached to every request to whatever host serves
 *      the built site. `shell/prefs.ts` already holds the argument for why UI
 *      preferences are kept out of `storage.ts` — they must not arrive under a
 *      key a "forget everything" is expected to clear — and the rail's fold is
 *      already stored there under `identity-ui:rail`.
 *
 *   7. `TooltipProvider delayDuration={0}` -> `250`. Measured: a
 *      pointer crossing four stacked targets at zero delay flashes every one of
 *      them, and Radix's own skip-delay keeps the SECOND tooltip instant once a
 *      person is reading them.
 *
 *   8. `SidebarMenuButton`'s DEFAULT SIZE, `h-8` (32px) -> `min-h-touch`
 *      (44px). shadcn's height is a mouse's. This sidebar shows at 900px and
 *      up, which includes an iPad in landscape — a touch device that gets the
 *      sidebar rather than the bottom bar — and 44px is the smallest thing a
 *      finger may be asked to hit (the iOS path).
 *      Same decision, same reason, as `kit/button.tsx`'s `md`.
 *
 *   9. `print:hidden` ON THE ROOT. The print blanket — `body * { visibility:
 *      hidden }` with only the armed piece card exempt — must still leave a
 *      recovery sheet with one card on it, and the navigation may never reach
 *      the printed page.
 *
 * WHAT IS UNTOUCHED, AND IT IS THE HALF WORTH HAVING: every `data-slot` and
 * `data-sidebar` attribute, the `data-state`/`data-collapsible` contract, the
 * `group-data-*` variant mechanics, `asChild` through `Slot.Root`, the `cva`
 * variant tables, `SidebarMenuButton`'s tooltip-when-collapsed with its
 * `hidden={state !== "collapsed"}`, and the Cmd/Ctrl+B shortcut — which is
 * itself a findability win and part of why this block was asked for.
 */

/* 14rem rather than the payload's 16: this rail carries four words, and it was
 * measured at 14 (`w-56`). The icon width is `4.75rem`, which is a 44px
 * target plus the padding either side — the payload's `3rem` is a 32px one. */
const SIDEBAR_WIDTH = "14rem"
const SIDEBAR_WIDTH_ICON = "4.75rem"
const SIDEBAR_KEYBOARD_SHORTCUT = "b"

type SidebarContextProps = {
  state: "expanded" | "collapsed"
  open: boolean
  toggleSidebar: () => void
}

const SidebarContext = React.createContext<SidebarContextProps | null>(null)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.")
  }

  return context
}

/**
 * THE PROVIDER. `open` is the rail preference, so the fold is remembered
 * across reloads by the file that already remembered it — there is one place
 * this is stored, `shell/prefs.ts` under `identity-ui:rail`, and
 * `rail.test.tsx` reads it there.
 */
function SidebarProvider({
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const rail = useRail()
  const open = !rail.collapsed
  const toggle = rail.toggle
  const toggleSidebar = React.useCallback(() => toggle(), [toggle])

  /* Kept from the payload: a control with a shortcut is a control people find
   * twice. It is mounted with the provider, which `ui.tsx` renders only for a
   * PLACE — so Cmd/Ctrl+B does nothing inside a ceremony, which is the same
   * rule the rest of the navigation follows. */
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        toggleSidebar()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [toggleSidebar])

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = open ? "expanded" : "collapsed"

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({ state, open, toggleSidebar }),
    [state, open, toggleSidebar]
  )

  return (
    <SidebarContext.Provider value={contextValue}>
      <TooltipProvider delayDuration={250}>
        <div
          data-slot="sidebar-wrapper"
          style={
            {
              "--sidebar-width": SIDEBAR_WIDTH,
              "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
              ...style,
            } as React.CSSProperties
          }
          className={cn(
            "group/sidebar-wrapper flex min-h-svh w-full flex-col wide:flex-row",
            className
          )}
          {...props}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  )
}

/**
 * THE SIDEBAR ITSELF. In normal flow rather than `fixed`: this app's frame is
 * already a flex row and the place header inside it is `sticky`, which a fixed
 * sidebar plus a spacer div would have had to be reconciled with for no gain.
 * The width transition and the `group-data-[collapsible=icon]` contract are
 * the payload's.
 */
function Sidebar({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const { state } = useSidebar()

  return (
    <div
      className="group peer hidden shrink-0 text-ink wide:block print:hidden"
      data-state={state}
      data-collapsible={state === "collapsed" ? "icon" : ""}
      data-variant="sidebar"
      data-side="left"
      data-slot="sidebar"
    >
      <div
        data-slot="sidebar-container"
        className={cn(
          "sticky top-0 h-svh w-(--sidebar-width) border-r border-line",
          "transition-[width] duration-(--motion-calm) ease-(--motion-ease)",
          "motion-reduce:transition-none",
          "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
          className
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className="flex h-full w-full flex-col bg-raised"
        >
          {children}
        </div>
      </div>
    </div>
  )
}

/**
 * THE TRIGGER — and this is the change's acceptance test, so its PLACEMENT is
 * not this component's business. `sidebar-07` puts it in the page header at the
 * top left, OUTSIDE the sidebar, which is where every application that has one
 * puts it and where a person looks for it. `ui.tsx`'s place header renders it and
 * nothing inside the sidebar does, because a control that folds a column while
 * living inside that column is the same failure.
 *
 * It states what it will DO and what it CONTROLS: `aria-expanded` and
 * `aria-controls`, so a screen reader is told there is a region and whether it
 * is open. shadcn's version carries an `sr-only` "Toggle Sidebar" and no
 * relationship at all.
 */
function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<"button">) {
  const { toggleSidebar, open } = useSidebar()
  /* There is no visible word here — it is an icon button — so the accessible
   * name is the whole sentence and the tooltip shows the same one, which is
   * what keeps WCAG 2.5.3 satisfied without a label the rail has no room for.
   * It says what pressing it will DO, not what the sidebar currently is. */
  const label = open ? "Hide the sidebar" : "Show the sidebar"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-sidebar="trigger"
          data-slot="sidebar-trigger"
          aria-label={label}
          aria-expanded={open}
          aria-controls="sidebar"
          className={cn(
            /* The explicit border, background and padding are not decoration:
             * `app.css` styles the `button` ELEMENT, and a shell control that
             * does not state its own inherits an ordinary button's. */
            "flex size-touch shrink-0 items-center justify-center rounded-tight",
            "border border-transparent bg-transparent p-0 text-muted",
            "transition-colors duration-(--motion-quick)",
            "hover:border-line hover:bg-sunken hover:text-ink",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            className
          )}
          onClick={(event) => {
            onClick?.(event)
            toggleSidebar()
          }}
          {...props}
        >
          <Icon glyph={open ? GLYPH.collapseRail : GLYPH.expandRail} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>{label}</TooltipContent>
    </Tooltip>
  )
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn("flex flex-col gap-2 p-3", className)}
      {...props}
    />
  )
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn("mt-auto flex flex-col gap-2 border-t border-line p-3", className)}
      {...props}
    />
  )
}

function SidebarSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="sidebar-separator"
      data-sidebar="separator"
      decorative
      className={cn("mx-2 w-auto", className)}
      {...props}
    />
  )
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden",
        className
      )}
      {...props}
    />
  )
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn("relative flex w-full min-w-0 flex-col p-3", className)}
      {...props}
    />
  )
}

function SidebarGroupLabel({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "div"

  return (
    <Comp
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={cn(
        "flex h-8 shrink-0 items-center rounded-tight px-2 text-xs font-medium text-faint",
        "transition-[margin,opacity] duration-(--motion-calm) ease-linear",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "[&>svg]:size-4 [&>svg]:shrink-0",
        "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
        className
      )}
      {...props}
    />
  )
}

function SidebarGroupContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      className={cn("w-full text-sm", className)}
      {...props}
    />
  )
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn("m-0 flex w-full min-w-0 list-none flex-col gap-1 p-0", className)}
      {...props}
    />
  )
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn("group/menu-item relative list-none", className)}
      {...props}
    />
  )
}

const sidebarMenuButtonVariants = cva(
  [
    "peer/menu-button flex w-full items-center gap-3 overflow-hidden rounded-tight p-2",
    "text-left text-sm no-underline",
    "transition-colors duration-(--motion-quick)",
    "group-data-[collapsible=icon]:size-touch! group-data-[collapsible=icon]:justify-center",
    "group-data-[collapsible=icon]:self-center group-data-[collapsible=icon]:p-0!",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
    "disabled:pointer-events-none disabled:opacity-50",
    "aria-disabled:pointer-events-none aria-disabled:opacity-50",
    /* THE CURRENT PLACE IS OBVIOUS, using the block's own
     * active state. Same three properties the old rail used for `aria-current`,
     * now driven by the payload's `data-active` contract. */
    "data-[active=true]:bg-accent-dim data-[active=true]:font-semibold",
    "data-[active=true]:text-accent",
    "[&>span:last-child]:truncate [&>svg]:size-5 [&>svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        default: "border border-transparent bg-transparent text-muted hover:bg-sunken hover:text-ink",
        outline:
          "border border-line bg-bg text-ink hover:border-line-strong hover:bg-sunken",
      },
      size: {
        /* 44px, not shadcn's 32 — substitution 8 in this file's header. */
        default: "min-h-touch text-sm",
        sm: "min-h-9 text-xs",
        lg: "min-h-14 text-sm group-data-[collapsible=icon]:p-0!",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/**
 * `sidebarMenuButtonVariants` IS EXPORTED, AND THE REASON IS A MEASUREMENT.
 *
 * `SidebarMenuButton`'s own `tooltip` prop wraps the button in
 * `TooltipTrigger asChild`. With `asChild` ALSO set on the button — which is
 * how a nav link has to be an `<a>` — that is two nested Radix `Slot`s, and
 * the INNER one wins: the rendered element comes out
 * `data-slot="sidebar-menu-button"`, not `"tooltip-trigger"`. Measured, not
 * assumed: `rail.test.tsx` went red with *expected 'sidebar-menu-button' to be
 * 'tooltip-trigger'*.
 *
 * That is not a cosmetic difference. `data-slot="tooltip-trigger"` is the ONLY
 * checkable evidence in the DOM that a folded link has a tooltip at all —
 * Radix renders the content only while it is open, so nothing else can be
 * asserted without simulating a hover. `data-slot="sidebar-menu-button"` is
 * present whether or not a tooltip was ever attached, so accepting shadcn's
 * shape would turn *"every folded place is a tooltip trigger"* into a test
 * that passes with the tooltips deleted. The design calls a looser
 * matcher what it is.
 *
 * So `shell/nav.tsx` styles its links with this table and does its own
 * one-level `TooltipTrigger` wrap, which is exactly what was done and what the
 * test pins. Everything else about the button — the variants, the sizes, the
 * `group-data-[collapsible=icon]` sizing, `data-active` — is the block's,
 * unchanged, because it is this table.
 */
function SidebarMenuButton({
  asChild = false,
  isActive = false,
  variant = "default",
  size = "default",
  tooltip,
  className,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean
  isActive?: boolean
  tooltip?: string | React.ComponentProps<typeof TooltipContent>
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const Comp = asChild ? Slot.Root : "button"
  const { state } = useSidebar()

  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  )

  if (!tooltip) {
    return button
  }

  if (typeof tooltip === "string") {
    tooltip = {
      children: tooltip,
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent
        side="right"
        align="center"
        hidden={state !== "collapsed"}
        {...tooltip}
      />
    </Tooltip>
  )
}

export {
  Sidebar,
  sidebarMenuButtonVariants,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
}
