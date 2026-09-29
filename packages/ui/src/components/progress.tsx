import * as React from "react"
import { cn } from "vaults-ui/lib/utils"
import { Progress as ProgressPrimitive } from "radix-ui"

/** One step of what is being done: its id, set as `data-mark` on its mark, and whether it is done. */
export interface ProgressStep {
  id: string
  done: boolean
}

/**
 * HOW FAR SOMETHING HAS COME, ONE MARK PER STEP, each filled when its step is
 * done, whatever order the steps were done in. Built on the primitive, so it
 * is announced as a progress bar of the steps done out of all of them. The
 * caller passes `getValueLabel` with the words to announce ("2 of 5 steps
 * done"), in the person's language; without it the primitive announces a
 * percentage.
 *
 * Marks rather than a bar slid along by a measured length, so nothing is set
 * inline and every shade is the theme's.
 */
function Progress({
  className,
  steps,
  ...props
}: Omit<React.ComponentProps<typeof ProgressPrimitive.Root>, "value" | "max" | "children"> & { steps: readonly ProgressStep[] }) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={steps.filter((s) => s.done).length}
      max={Math.max(1, steps.length)}
      className={cn("flex w-full items-center gap-1", className)}
      {...props}
    >
      {steps.map((s) => (
        <span
          key={s.id}
          data-slot="progress-mark"
          data-mark={s.id}
          data-filled={s.done}
          className="h-1.5 flex-1 rounded-full bg-muted data-[filled=true]:bg-primary"
        />
      ))}
    </ProgressPrimitive.Root>
  )
}

export { Progress }
