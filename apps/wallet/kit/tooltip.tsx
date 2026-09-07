import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * TOOLTIP — fetched from the shadcn registry, restyled onto this repo's tokens.
 *
 * PROVENANCE. This file was fetched from the shadcn registry on 21 Aug 2026,
 * and the fetch printed
 * the registry payload verbatim BEFORE writing it; the original is in
 * that printed record, so every line below can be diffed against what
 * arrived rather than taken on trust.
 *
 * WHAT WAS CHANGED, AND IT IS ONLY CLASS STRINGS. THE RULE: *"where a
 * shadcn component and this repo's conventions disagree on style, the repo
 * wins; where they disagree on BEHAVIOUR or ACCESSIBILITY, shadcn wins."* Every
 * Radix part, prop, default and `data-slot` is exactly as fetched — that is the
 * half worth having, and it is the half a hand-written tooltip gets wrong.
 * Three style substitutions:
 *
 *   `bg-foreground` / `text-background`  ->  `bg-ink` / `text-bg`
 *       Same idea — a tooltip is INVERTED so it reads as chrome rather than as
 *       part of the page — spelled in the colour roles this repo has. It does
 *       not have shadcn's, and inventing `--color-foreground` as an alias of
 *       `--color-ink` would be two names for one token, which is how a palette
 *       stops being a palette.
 *
 *   `rounded-md`  ->  `rounded-tight`
 *       This repo's radius scale has three steps and `md` is not one of them.
 *
 *   `animate-in fade-in-0 zoom-in-95 slide-in-from-*` and the `animate-out`
 *   half  ->  the shell's own `shell-fade` keyframe, behind `motion-safe:`.
 *       Those utilities come from `tw-animate-css`, a package this repo does
 *       not have and did not add: the design says **motion lives
 *       in the shell, not in screens, so there is one place to tune it and one
 *       place to respect `prefers-reduced-motion`.** A component carrying its
 *       own animation vocabulary is a second place. The exit animation is gone
 *       rather than reproduced — Radix unmounts the content, and a tooltip that
 *       fades out is not worth a `@keyframes` nobody else uses.
 *
 * `TooltipProvider` IS NOT MOUNTED APP-WIDE. shadcn's docs say to wrap the
 * whole app; this wallet wraps only the desktop rail (`shell/nav.tsx`), because
 * that is the only place a tooltip exists. A provider around every screen would
 * put a context around the securing ceremony to serve a control that ceremony
 * does not have.
 */

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-tight bg-ink px-3 py-1.5 text-xs text-balance text-bg",
          "motion-safe:animate-[shell-fade_var(--motion-quick)_var(--motion-ease)]",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-ink fill-ink" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
