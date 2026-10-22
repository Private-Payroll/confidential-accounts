import { cn } from "vaults-ui/lib/utils"
import { HugeiconsIcon } from "@hugeicons/react"
import { Loading03Icon } from "@hugeicons/core-free-icons"

function Spinner({ className, ...props }: Omit<React.ComponentProps<"svg">, "aria-label" | "strokeWidth"> & { "aria-label": string }) {
  return (
    <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} data-slot="spinner" role="status" className={cn("size-4 animate-spin", className)} {...props} />
  )
}

export { Spinner }
