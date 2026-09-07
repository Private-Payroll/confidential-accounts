/**
 * THE CLASS JOINER — one function, and it now lives somewhere else.
 *
 * §1 moves the real implementation to `@/lib/utils`, because that is the
 * path every component the shadcn CLI writes imports it from — `components.json`
 * names it as `aliases.utils` and the registry's output is not negotiable about
 * it. This file stays because twelve kit components and `kit/index.ts` import
 * from it, and because ONE `cn` is the whole point: two joiners with different
 * behaviour, one used by hand-written components and one by fetched ones, is a
 * design system with two answers to the same question.
 *
 * WHAT CHANGED, AND IT IS A BEHAVIOUR CHANGE. The old joiner only flattened, and
 * said so at length: **`className` on a kit component was ADDITIVE, not an
 * override.** `tailwind-merge` is now installed, so it is an override — a
 * caller's `p-8` beats a component's `px-4`, which is what callers always
 * expected. The rule written to live without it still holds as GUIDANCE (a
 * look is chosen with `variant` and `size`; a new look is a new variant, argued
 * once) — it is no longer enforced by the joiner's incapacity.
 *
 * `export { cn }` rather than a wrapper: `apps/wallet/kit/alias.test.ts` asserts
 * `cn` reached through `@/kit/cn` and through `./cn.js` is the SAME function
 * object, which is how "one joiner" is pinned rather than asserted.
 */

export { cn } from '../lib/utils.js';
export type { ClassValue } from '../lib/utils.js';
