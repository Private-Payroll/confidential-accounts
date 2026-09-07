import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * `cn` — THE REAL ONE, at the path shadcn's own output imports.
 *
 * Every component the CLI writes begins `import { cn } from
 * "@/lib/utils"`, so this file's PATH is part of the contract with the
 * registry rather than a preference; `components.json` names it as
 * `aliases.utils`. `src/app/kit/cn.ts` re-exports this and nothing else, so
 * there is exactly one joiner in the repository.
 *
 * IT IS `twMerge(clsx(...))`, WHICH IS A BEHAVIOUR CHANGE AND THE POINT OF IT.
 * The old joiner only flattened, and documented the cost in full: **`className` on
 * a kit component was ADDITIVE, not an override** — a caller's `p-8` lost to a
 * component's own `px-4`, because Tailwind's emission order decided and the
 * shorthand emits first. `tailwind-merge` resolves the conflict instead, so the
 * later class wins, which is what every caller already expected. That guidance
 * still holds — a look is chosen with `variant` and `size`, and a look the
 * variants do not have is a new variant argued once — but it is now guidance
 * rather than something enforced by the joiner's incapacity.
 *
 * THE TWO EXTENSIONS BELOW ARE MEASURED, NOT ASSUMED, and one that looked
 * necessary was removed after measuring. `tailwind-merge` groups classes by the
 * names Tailwind ships with; this repo's tokens are its own. Removing the block
 * below and running `src/app/kit/cn.test.ts` fails exactly two tests:
 *
 *   radius   `rounded-tight` and `rounded-card` are unknown SUFFIXES, so both
 *            survive the merge and the winner goes back to being emission
 *            order — the bug this file exists to remove.
 *   spacing  same, for `min-h-touch` and `size-touch`.
 *
 * A THIRD ONE — a list of the colour roles from `@theme` — WAS WRITTEN AND THEN
 * DELETED, because with it removed not one test changed: `tailwind-merge`
 * already treats `bg-*` and `text-*` as colour groups whatever the suffix is.
 * It would have been a list that had to be kept in step with `app.css` for ever
 * and did nothing, which is worse than no list — a maintained thing that has no
 * effect is read by the next person as a thing that does.
 */

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      radius: ['tight', 'card', 'pill'],
      spacing: ['touch'],
    },
  },
});

export type { ClassValue };

export function cn(...inputs: readonly ClassValue[]): string {
  return twMerge(clsx(inputs));
}
