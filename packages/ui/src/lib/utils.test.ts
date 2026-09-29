import { describe, expect, it } from 'vitest';
import { cn } from 'vaults-ui/lib/utils';

/*
 * THE KIT'S ONE CLASS JOINER. A part's own classes come first and the caller's
 * after, and where the two say different things about one property the
 * caller's wins - which is what lets a screen hand a kit part a status colour
 * or a width without the part's own class quietly winning instead.
 */
describe('the class joiner', () => {
  /* RED WHEN: the joiner only concatenates, and the earlier class survives. */
  it('lets a later class replace an earlier one that sets the same thing', () => {
    expect(cn('px-4', 'p-8')).toBe('p-8');
    expect(cn('bg-card', 'bg-warn-dim')).toBe('bg-warn-dim');
    expect(cn('grid-cols-2 md:grid-cols-4', 'md:grid-cols-3')).toBe('grid-cols-2 md:grid-cols-3');
  });

  /* RED WHEN: a falsy part is written into the class list. */
  it('drops what is not a class', () => {
    expect(cn('a', false, null, undefined, '', 'b')).toBe('a b');
  });
});
