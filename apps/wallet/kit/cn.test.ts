import { describe, expect, it } from 'vitest';
import { cn } from './cn.js';
import { cn as cnFromLib } from '../lib/utils.js';

/*
 * `cn` — §1, and the three things that have to be true at once.
 *
 *   1. IT IS ONE FUNCTION. `@/lib/utils` is the path shadcn's output imports
 *      from; `kit/cn.js` is the path twelve hand-written components import
 *      from. If those ever became two implementations, the design system would
 *      have two answers to "what does className do", and only one of them would
 *      be written down.
 *   2. A CALLER'S CLASS NOW WINS. There was no `tailwind-merge` and it documented the
 *      cost: `className` was ADDITIVE, so a component's own `px-4` beat a
 *      caller's `p-8` on Tailwind's emission order. Every assertion below with
 *      two conflicting classes in it is that limitation, pinned as removed.
 *   3. THIS REPO'S OWN SCALES ARE PART OF THE MERGE. `tailwind-merge` knows
 *      Tailwind's names, not `rounded-card`, `min-h-touch` or `bg-raised`. An
 *      unknown class is carried through rather than merged — safe, and useless,
 *      because the winner would be emission order again. `lib/utils.ts`
 *      declares the three custom scales; these are the tests that go red when a
 *      token is added to `app.css` and not to that list.
 */

describe('the class joiner', () => {
  it('is the same function on both paths — one joiner, two spellings', () => {
    expect(cn).toBe(cnFromLib);
  });

  it('still flattens and drops falsy parts, exactly as before', () => {
    expect(cn('a', false, 'b')).toBe('a b');
    expect(cn('a', null, undefined, 'b')).toBe('a b');
  });

  it('lets a later class beat an earlier one — the old limitation, removed', () => {
    expect(cn('px-4 py-2', 'p-8')).toBe('p-8');
    expect(cn('text-sm', 'text-base')).toBe('text-base');
  });

  it('merges this repo’s radius scale — rounded-tight | card | pill', () => {
    expect(cn('rounded-tight', 'rounded-card')).toBe('rounded-card');
    expect(cn('rounded-pill', 'rounded-none')).toBe('rounded-none');
  });

  it('merges the one custom spacing step — touch, the 44px minimum', () => {
    expect(cn('min-h-touch', 'min-h-12')).toBe('min-h-12');
    expect(cn('size-touch', 'size-5')).toBe('size-5');
  });

  it('merges the colour ROLES, which is what every kit variant is built from', () => {
    expect(cn('bg-raised', 'bg-accent')).toBe('bg-accent');
    expect(cn('text-muted', 'text-bad')).toBe('text-bad');
    /* A width and a colour are different properties and both survive — the
     * merge is per-property, not per-prefix. */
    expect(cn('border border-line', 'border-bad-border')).toBe('border border-bad-border');
  });

  it('leaves classes it cannot possibly know about alone', () => {
    expect(cn('wallet-bar', 'piece-card')).toBe('wallet-bar piece-card');
  });
});
