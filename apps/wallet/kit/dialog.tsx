import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { GLYPH, Icon } from "./icon.js"
import { Button } from "./button.js"

/**
 * DIALOG — fetched from the shadcn registry, and restyled onto this repo's
 * tokens.
 *
 * PROVENANCE. This file was fetched from the shadcn registry on 21 Aug 2026,
 * and the fetch printed
 * the registry payload verbatim BEFORE writing it; the original is in
 * that printed record and kept whole, unmodified
 * (sha256 `90a75b48…`), so every line below can
 * be diffed against what arrived rather than taken on trust. `dialog` resolved
 * to ONE item and ONE file — the whole closure, printed at step 2 of that
 * report — and its only declared dependency is `radix-ui`, which this repo
 * already pins at 1.6.7. `package.json` and `package-lock.json` are unchanged
 * by the run, and `app.css` is byte-identical (`be7e2edd…` before and after).
 *
 * WHY THIS FILE AT ALL. The design: the kit had no Dialog, and
 * `shell/account.tsx` reached past the kit into Radix directly — the only
 * dialog in the repository. Home needs two more (Receive, and Earn's "coming
 * soon"), and three hand-rolled dialogs is three chances to get focus trapping,
 * escape, scroll locking and the hiding of everything behind the panel slightly
 * differently.
 * The design names `dialog` on the Radix list for exactly that reason:
 * *"the behaviour is hard and getting it wrong is a keyboard trap."*
 *
 * ============================================================================
 * WHAT WAS SUBSTITUTED — eleven, and every one is named
 * ============================================================================
 *
 * A token report compiles `app.css` with the installed Tailwind
 * and lists which of this payload's class names emit a rule in this repo. The
 * substitutions below come from that measurement, not from reading.
 *
 *   1. `bg-background` -> `bg-raised`. EMITS NOTHING here: shadcn's role names
 *      are not this repo's. A dialog is a raised surface, which is the role
 *      `--color-raised` exists for, and it is what `shell/account.tsx` already
 *      uses for this exact panel.
 *
 *   2. `text-muted-foreground` -> `text-muted`. EMITS NOTHING. Same family.
 *
 *   3. `data-[state=open]:bg-accent` -> `data-[state=open]:bg-sunken`.
 *      **THIS IS THE DANGEROUS ONE, AND IT IS WHY THE CHECK EXISTS.** It EMITS
 *      A RULE here — the wrong one. shadcn's `accent` is the quiet grey a
 *      control goes when you hover it; ours is the indigo brand accent
 *      (the collision table). Left alone, the close button
 *      floods with indigo for as long as the dialog is open, and nothing about
 *      that fails loudly enough to be caught by looking.
 *
 *   4. THE FOCUS RING. `ring-offset-background`, `focus:ring-2`,
 *      `focus:ring-ring`, `focus:ring-offset-2` and `focus:outline-hidden` ->
 *      `focus-visible:outline-2 focus-visible:outline-offset-2
 *      focus-visible:outline-accent`. Most of those emit nothing, and every
 *      other control in this kit uses the outline. Two focus styles in one
 *      interface is a worse outcome than either — the substitution
 *      `kit/sidebar.tsx` made, for the same reason.
 *
 *      It is also `focus-visible:` rather than `focus:`. Radix moves focus INTO
 *      the dialog when it opens; under `focus:` the close button wears a ring
 *      the moment the panel appears whether or not anybody is on a keyboard.
 *
 *   5. THE ANIMATION UTILITIES -> the shell's own keyframes. `animate-in`,
 *      `animate-out`, `fade-in-0`, `fade-out-0`, `zoom-in-95` and `zoom-out-95`
 *      all EMIT NOTHING: they belong to `tw-animate-css`, which this repo does
 *      not install. `app.css` already defines `shell-fade` and `shell-rise` for
 *      this exact panel, and the design says motion lives in the
 *      shell so there is one place to tune it and one place to respect
 *      `prefers-reduced-motion` — which `motion-safe:` does at the call site.
 *
 *   6. `duration-200` -> `duration-(--motion-calm)`. The literal emits, and
 *      that is the problem: a duration written into a component is a duration
 *      the shell cannot tune.
 *
 *   7. `rounded-lg` -> `rounded-card`, `rounded-xs` -> `rounded-tight`. Both
 *      EMIT — as Tailwind's own default radii rather than this repo's anchor —
 *      so leaving them would have been two more steps arriving by accident in a
 *      scale that has three.
 *
 *   8. `border` -> `border border-line`. A bare `border` takes Tailwind's
 *      default border colour, which is not a role this repo names.
 *
 *   9. `sm:` (40rem) -> `wide:` (56.25rem). Tailwind's default breakpoint is
 *      not this app's layout switch; `--breakpoint-wide` is, and below it the
 *      bottom bar takes over.
 *
 *  10. `XIcon` FROM `lucide-react` -> `GLYPH.close` through `kit/icon.tsx`.
 *      **A finding, and a second data point rather than a repeat.**
 *      `components.json` sets `iconLibrary: "hugeicons"`. That proved it is not
 *      honoured for a BLOCK; this proves it for a SINGLE COMPONENT too, so the
 *      setting is broken unconditionally and every fetched payload needs its
 *      icons read. This time the CLI did NOT re-add `lucide-react` to
 *      `package.json` — the import simply does not resolve, and that was the
 *      one error the checkpoint's typecheck reported.
 *
 *  11. THE CENTRED PANEL -> A BOTTOM SHEET BELOW THE LAYOUT SWITCH.
 *      shadcn centres at every width. `shell/account.tsx` has shipped a bottom
 *      sheet on the phone and a centred panel above 900px, and that
 *      is the shape already in use. A centred modal on a phone puts its controls out of the thumb's
 *      reach and over the keyboard; the sheet also respects
 *      `env(safe-area-inset-bottom)`, which the design calls the
 *      single most common tell of a wrapped web app. **This is not a second
 *      shape. It is the one shape, moved out of `shell/account.tsx` and into
 *      the kit so the switcher, Receive and Earn cannot drift apart.**
 *
 * WHAT IS UNTOUCHED, AND IT IS THE HALF WORTH HAVING: every Radix part and
 * every `data-slot`; `showCloseButton` and its `sr-only` label; Header, Footer,
 * Title and Description as separate parts; and `DialogFooter`'s own
 * `showCloseButton`. All of that is focus trapping, escape handling, scroll
 * locking, and the title/description wiring — the things a hand-rolled panel
 * gets wrong quietly.
 *
 * ONE MECHANISM IS NOT WHAT IT LOOKS LIKE, AND IT WAS MEASURED RATHER THAN
 * ASSUMED: **Radix does not write `aria-modal` on the panel.** It marks every
 * sibling of the portal `aria-hidden="true"` while the dialog is open and
 * removes it on close — which is the stronger of the two, because `aria-modal`
 * asks a screen reader to ignore the rest of the page and `aria-hidden` tells
 * it to. `dialog.test.tsx` pins the attribute that is actually there.
 *
 * ONE THING NEITHER THE PAYLOAD NOR THIS FILE ENFORCES, AND IT IS WORSE THAN IT
 * LOOKS — READ IN THE SHIPPED SOURCE RATHER THAN IN THE DOCS. A `DialogContent`
 * with no `DialogTitle` inside it does not warn. It does not throw. It renders
 * a modal with **no accessible name at all**:
 *
 *     "aria-labelledby": context.titlePresent ? context.titleId : void 0
 *     (@radix-ui/react-dialog/dist/index.mjs:233)
 *
 * `titlePresent` counts the `DialogTitle`s that mounted (`setTitleCount`,
 * `:251`), so a missing title is an omitted attribute and nothing else — no
 * console message in this version. A screen reader announces "dialog" and stops.
 * Nothing here makes it a compile error either. Every call site in this
 * repository passes a title, and `dialog.test.tsx` is what keeps that true
 * rather than this sentence.
 *
 * TWO IMPORT PATHS ARE SPELLED THIS REPO'S WAY AND NOTHING WAS REMOVED WITH
 * THEM: `@/kit/button` (which the CLI had already rewritten from
 * `@/registry/new-york-v4/ui/button`) is `./button.js`, and the icon comes
 * through `./icon.js`. `@/lib/utils` is left exactly as fetched, because that
 * alias resolves here — it is the one the config change was made for.
 */

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-40 bg-black/55",
        "motion-safe:data-[state=open]:animate-[shell-fade_var(--motion-calm)_var(--motion-ease)]",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 grid max-h-[85vh] gap-3 overflow-y-auto",
          "rounded-t-card border border-line bg-raised p-4 shadow-lg outline-none",
          "pb-[calc(1rem+env(safe-area-inset-bottom))]",
          "duration-(--motion-calm)",
          "motion-safe:data-[state=open]:animate-[shell-rise_var(--motion-calm)_var(--motion-ease)]",
          "wide:inset-x-auto wide:top-1/2 wide:bottom-auto wide:left-1/2 wide:w-[26rem]",
          "wide:max-w-[calc(100%-2rem)] wide:-translate-x-1/2 wide:-translate-y-1/2",
          "wide:rounded-card wide:pb-4",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            aria-label="Close"
            className={cn(
              "absolute top-3 right-3 flex size-touch items-center justify-center",
              "rounded-tight border-0 bg-transparent p-0 text-muted",
              "transition-colors duration-(--motion-quick) hover:text-ink",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              "disabled:pointer-events-none",
              "data-[state=open]:bg-sunken data-[state=open]:text-muted",
              "wide:top-4 wide:right-4"
            )}
          >
            <Icon glyph={GLYPH.close} />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1 pr-11 text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 wide:flex-row wide:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("m-0 text-base leading-tight font-semibold text-ink", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("m-0 text-sm text-muted", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
