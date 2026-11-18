import type { ReactNode } from 'react';
import { Button, Card, CardContent, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, Separator, Skeleton, Tooltip, TooltipContent, TooltipTrigger } from 'vaults-ui';
import { DialogClose } from 'vaults-ui/components/dialog';
import { SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider } from 'vaults-ui/components/sidebar';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from 'vaults-ui/components/table';
import { GLYPH, Glyph } from '../glyphs.js';
import { Chapter, Spec } from './kit-parts.js';

export function TableChapter(): ReactNode {
  return (
    <>
      <Chapter
        id="table"
        title="Table"
        says="For things genuinely compared down a column. It scrolls inside its own box, so the
              page never scrolls sideways."
      >
        <Table>
          <TableCaption>Where this account’s pieces are — an invented example.</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Piece</TableHead>
              <TableHead>Where it is</TableHead>
              <TableHead>Locked with</TableHead>
              <TableHead className="text-right">Last verified</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>1</TableCell>
              <TableCell>A printed copy</TableCell>
              <TableCell className="text-muted-foreground">Nothing — the paper is the lock</TableCell>
              <TableCell className="text-right">21 Aug 2026</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>2</TableCell>
              <TableCell>A cloud account of mine</TableCell>
              <TableCell className="text-muted-foreground">A password</TableCell>
              <TableCell className="text-right">21 Aug 2026</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>3</TableCell>
              <TableCell>A second device</TableCell>
              <TableCell className="text-muted-foreground">A passkey</TableCell>
              <TableCell className="text-right text-warn">Never</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Chapter>
    </>
  );
}

export function SkeletonChapter(): ReactNode {
  return (
    <>
      <Chapter
        id="skeleton"
        title="Skeleton and Separator"
        says="A skeleton says something is arriving. When nothing is arriving, the honest failure
              state has words — a skeleton must never be what a person is left looking at."
      >
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <Spec label="Skeleton — a balance card that has not answered yet">
            <Card>
              <CardContent  aria-busy="true">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="mt-3 h-8 w-48" />
                <Skeleton className="mt-3 h-3 w-full" />
                <Skeleton className="mt-2 h-3 w-2/3" />
              </CardContent>
            </Card>
          </Spec>
          <Spec label="Separator — horizontal and vertical">
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="m-0 text-sm text-muted-foreground">Above the rule</p>
              <Separator className="my-3" />
              <p className="m-0 text-sm text-muted-foreground">Below the rule</p>
              <div className="mt-4 flex h-10 items-center gap-3">
                <span className="text-sm text-muted-foreground">left</span>
                <Separator orientation="vertical" />
                <span className="text-sm text-muted-foreground">right</span>
              </div>
            </div>
          </Spec>
        </div>
      </Chapter>
    </>
  );
}

export function TooltipChapter(): ReactNode {
  return (
    <>
      <Chapter
        id="tooltip"
        title="Tooltip"
        says="The one component FETCHED rather than written. It exists because the
              desktop rail folds to icons, and a glyph with no word beside it needs a label
              that a keyboard can reach."
      >
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="outline" size="icon" aria-label="Send">
                  <Glyph icon={GLYPH.send} className="size-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>Send</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="sm">Hover me, or Tab to me</Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={8}>
                Radix opens this on focus as well as hover
              </TooltipContent>
            </Tooltip>
          </div>
        </>
        <p className="muted small" style={{ marginTop: '1rem' }}>
          Restyled onto this repo’s tokens and nothing else: <code>bg-ink</code>/
          <code>text-bg</code> for shadcn’s <code>bg-foreground</code>/
          <code>text-background</code>; <code>rounded-tight</code> for{' '}
          <code>rounded-md</code>; and the shell’s own <code>shell-fade</code> for a set of
          animation utilities this repo does not install. Every Radix part is as fetched —
          the original payload was printed in full before it was written.
        </p>
      </Chapter>
    </>
  );
}

export function DialogChapter(): ReactNode {
  return (
    <>
      <Chapter
        id="dialog"
        title="Dialog"
        says="The component FETCHED — shadcn's dialog, on Radix. It is a BOTTOM
              SHEET below 900px and a centred panel above, which is the shape
              shell/account.tsx has shipped all along rather than a second one."
      >
        <div className="flex flex-wrap gap-3">
          <Dialog>
            <DialogTrigger asChild>
              <Button type="button" variant="outline">Open a dialog</Button>
            </DialogTrigger>
            <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>A dialog</DialogTitle>
                <DialogDescription>
                  Radix traps focus inside this panel, closes it on Escape, locks the
                  page behind it, and returns focus to the control that opened it.
                  Every one of those is a thing a hand-rolled panel gets wrong quietly.
                </DialogDescription>
              </DialogHeader>
              <p className="m-0 text-sm text-muted-foreground">
                Nothing on this page does anything — this dialog holds text and a way
                out, and the way out is the specimen.
              </p>
              <DialogFooter showCloseButton />
            </DialogContent>
          </Dialog>

          <Dialog>
            <DialogTrigger asChild>
              <Button type="button" variant="outline">…with no close button</Button>
            </DialogTrigger>
            <DialogContent showCloseButton={false} className="max-h-[calc(100svh-2rem)] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>No corner control</DialogTitle>
                <DialogDescription>
                  `showCloseButton={'{false}'}` is for a panel whose only way out should
                  be a deliberate one. Escape and the overlay still close it, so this is
                  never a trap.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="default">Done</Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        <p className="muted small" style={{ marginTop: '1rem' }}>
          Eleven substitutions, all named in <code>kit/dialog.tsx</code> and measured against the installed Tailwind.{' '}
          The one that matters:{' '}
          <code>data-[state=open]:bg-accent</code> EMITS A RULE here and it is the WRONG
          one — shadcn means a neutral hover surface by <code>accent</code> and this
          repo means the indigo. Eleven of the payload’s class names emit nothing at
          all, six of them animation utilities from a package this repo does not
          install; the shell’s own <code>shell-fade</code> and <code>shell-rise</code>
          replace those.
        </p>
      </Chapter>
    </>
  );
}

export function SidebarChapter(): ReactNode {
  return (
    <>
      <Chapter
        id="sidebar"
        title="Sidebar"
        says="The block FETCHED — shadcn's sidebar-07. What is drawn below is
              static: the live one is the app's frame, and it is looked at by opening the
              app rather than by visiting a workshop page."
      >
        <SidebarProvider className="min-h-0 w-auto flex-wrap gap-6">
          {([false, true] as const).map((collapsed) => (
            <div
              key={String(collapsed)}
              /* The block's own contract, set by hand rather than by the
               * provider: `group` plus `data-collapsible` is what every
               * `group-data-[collapsible=icon]` variant inside reacts to. That
               * is the whole mechanism, and showing both states side by side is
               * only possible because it is an ATTRIBUTE and not a hook. */
              className="group rounded-xl border bg-sidebar text-sidebar-foreground"
              data-state={collapsed ? 'collapsed' : 'expanded'}
              data-collapsible={collapsed ? 'icon' : ''}
              style={{ width: collapsed ? '4.75rem' : '14rem' }}
            >
              <SidebarHeader>
                <span className="wordmark px-2 py-1">
                  <span className="moon" aria-hidden="true" />
                  {!collapsed && 'Midnight Identity'}
                </span>
              </SidebarHeader>
              <SidebarGroup>
                <SidebarMenu>
                  {([
                    ['Home', GLYPH.home, true],
                    ['Activity', GLYPH.activity, false],
                    ['Explore', GLYPH.explore, false],
                    ['Settings', GLYPH.settings, false],
                  ] as const).map(([label, glyph, active]) => (
                    <SidebarMenuItem key={label}>
                      <SidebarMenuButton asChild isActive={active}>
                        <span>
                          <Glyph icon={glyph} />
                          {!collapsed && <span>{label}</span>}
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            </div>
          ))}
        </SidebarProvider>
        <p className="muted small" style={{ marginTop: '1rem' }}>
          Every specimen here is a <code>&lt;span&gt;</code>, not a link or a button:
          nothing on this page navigates, and the live sidebar’s rows are anchors.
          The eight <code>--sidebar-*</code> colour roles the payload declares were
          never admitted — the fetch’s own guard caught the write and restored{' '}
          <code>app.css</code> by hash. What is above is this repository’s own tokens,
          and <code>kit/sidebar.tsx</code> lists all nine substitutions.
        </p>
      </Chapter>
    </>
  );
}
