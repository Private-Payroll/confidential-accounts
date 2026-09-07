/**
 * THE KIT — one import site, so a screen never reaches into a component file.
 *
 * The components live in this repository, as shadcn
 * intends, and `apps/wallet/src/shell/` already worked that way. This is the same
 * arrangement for the pieces screens are built from rather than the pieces the
 * frame is built from.
 *
 * WHAT IS HERE IS THE WHOLE LIST AND IT IS CLOSED. Adding to it is a decision
 * with a round behind it, the way adding a token is — otherwise "one kit"
 * becomes a folder of whatever each screen needed that afternoon, which is the
 * thing the gallery at `#/kit` exists to prevent.
 *
 * TWO WERE ADDED, AND BOTH ARE NAMED IN THE DESIGN RATHER THAN CHOSEN HERE:
 *
 *   `Icon` (`./icon.js`) — the seam. §2 replaced lucide with HugeIcons, whose
 *     glyphs are DATA rather than components; this is the one file in the
 *     repository that imports an icon package, so the next swap is one file
 *     instead of five.
 *
 *   `Tooltip` (`./tooltip.js`) — FETCHED, not written. §3's collapsed rail
 *     shows glyphs with no words beside them, and a tooltip that behaves on a
 *     keyboard is exactly the kind of thing the design says to take
 *     from Radix rather than hand-roll.
 */

export { cn } from './cn.js';
export type { ClassValue } from './cn.js';
export { GLYPH, Icon, glyphFor } from './icon.js';
export type { GlyphName, IconSvgElement } from './icon.js';
export { Button, ButtonLink, buttonClasses } from './button.js';
export type { ButtonSize, ButtonVariant } from './button.js';
export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './card.js';
export { Input, Textarea } from './input.js';
export { Label } from './label.js';
export { Badge } from './badge.js';
export type { BadgeTone } from './badge.js';
export { Skeleton } from './skeleton.js';
export { Separator } from './separator.js';
export { Alert } from './alert.js';
export type { AlertTone } from './alert.js';
export { EmptyState } from './empty-state.js';
export { ListRow, ListRows } from './list-row.js';
/* WRITTEN, not fetched, and named in the design rather than
 * chosen here: *"section headings and the danger section's treatment may need
 * something new; if so it goes in the kit."* Settings is a column of titled
 * regions and one of them is destructive, and both of those are shapes the
 * screens after it raise again. */
export { Section } from './section.js';
export type { SectionTone } from './section.js';
export type { ListRowProps } from './list-row.js';
/* WRITTEN, not fetched: forty lines of markup and tokens, which is
 * the design's own test for what is a dependency and what is not.
 * The design moves Home's shortcuts out of a card and into tiles, and the shape
 * goes here rather than into `screens/home.tsx` because Explore raises the
 * same row later — a shape built inside one screen is a shape the next screen
 * copies. */
export { ActionTile, ActionTiles } from './action-tile.js';
export type { ActionTileProps } from './action-tile.js';
export {
  Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow,
} from './table.js';
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip.js';
/* FETCHED, not written, and named in the design as this change's one
 * gap. `shell/account.tsx` was the only dialog in the repository and it reached
 * past this kit into Radix directly; Home adds two more (Receive, and Earn's
 * "coming soon"), and three hand-rolled panels is three chances to get focus
 * trapping, escape, scroll locking and the hiding of the page behind them
 * slightly differently.
 * `kit/dialog.tsx` names all eleven substitutions made to the payload. */
export {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogOverlay, DialogPortal, DialogTitle, DialogTrigger,
} from './dialog.js';
/* FETCHED, not written, as part of the `sidebar-07` block, and the only
 * one of that block's twelve items adopted. It is the FRAME rather than
 * something a screen is built from, which is why `shell/nav.tsx` composes it;
 * it is listed here because it is a kit component and the kit is one list. */
export {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent,
  SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
  SidebarProvider, SidebarSeparator, SidebarTrigger, sidebarMenuButtonVariants, useSidebar,
} from './sidebar.js';
