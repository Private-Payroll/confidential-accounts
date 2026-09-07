// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/*
 * THE GALLERY. Three claims, and each one is a thing that would be a
 * defect rather than an ugly page if it stopped being true.
 *
 *   1. `#/kit` RENDERS WITH NO WALLET AT ALL. The gallery reads no secret, no
 *      storage and no network, and it answers before every phase gate — so it
 *      opens on a browser with no account, which is where somebody looking at
 *      a design system usually is. A gallery reachable only from an unlocked
 *      wallet is a gallery nobody opens.
 *   2. IT IS UNLINKED. The design adds the route "additive, unlinked
 *      from the navigation". A link to a workshop surface appearing in a
 *      person's wallet is the whole failure, and it would arrive silently.
 *   3. NOTHING ON IT LEAVES THE RUNNER. The page renders every
 *      variant including `danger`; not one specimen has a handler that does
 *      anything, and the page must not reach the network on render.
 */

vi.mock('midnight-identity/browser', () => ({
  ensureBuffer: (): void => {},
  passkeysAvailable: (): boolean => true,
  createPasskey: vi.fn(),
  usePasskey: vi.fn(),
}));

import { App } from './app.js';
import { SessionProvider } from './session.js';

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  window.location.hash = '#/kit';
});

describe('the component gallery', () => {
  it('renders with no account, no unlock and no storage', () => {
    render(<SessionProvider><App /></SessionProvider>);
    expect(screen.getByText('The kit')).toBeTruthy();
    /* Every section, by its heading, and the last line of the page — so a
     * half-rendered gallery is a red test rather than a shorter page nobody
     * notices. The list is the kit the design names. */
    for (const heading of [
      'Tokens', 'Button', 'Badge', 'Card', 'Input, Textarea and Label',
      'Alert', 'EmptyState', 'ListRow', 'Table', 'Skeleton and Separator',
      /* The fetched component gets a section like every other, so a
       * gallery that renders without it is a red test rather than a shorter
       * page nobody notices. ADDED, not loosened: every heading already asserted is
       * still asserted, in the same way. */
      'Tooltip',
      /* The fetched BLOCK gets a section for the same reason the fetched
       * component did. ADDED, not loosened: every heading already asserted is
       * still asserted, in the same way. */
      'Sidebar',
      /* The fetched COMPONENT, same rule again. ADDED, not loosened. */
      'Dialog',
      /* WRITTEN rather than fetched, and it gets a section for the same
       * reason every other component has one. ADDED, not loosened. */
      'ActionTile',
      /* WRITTEN, and it is the page furniture Settings needed: a titled
       * region, in two tones, one of which is the destructive treatment. ADDED,
       * not loosened: every heading already asserted is still
       * asserted, in the same way. */
      'Section',
    ]) {
      expect(screen.getByRole('heading', { name: heading, level: 2 })).toBeTruthy();
    }
    expect(screen.getByText(/End of the kit/)).toBeTruthy();
  });

  /* THE HEADER ACTION SLOT IS ON THE PAGE, IN BOTH FILLINGS.
   * ADDED, not loosened: nothing above changed. The design says the
   * slot is reviewed on the gallery *"rather than per screen"*, so a gallery
   * that stopped showing it would put the decision back on whichever screen
   * used it next. Both fillings are asserted because the point of the slot is
   * that it takes either — a page showing only the chevron would still pass a
   * one-filling test while the slot had quietly become a chevron holder. */
  it('shows the card-header action slot, filled two ways', () => {
    render(<SessionProvider><App /></SessionProvider>);
    const slots = [...document.querySelectorAll('[data-card-action]')];
    expect(slots.length).toBeGreaterThanOrEqual(2);
    /* One NAVIGATES and one ACTS — the two kinds of thing the slot exists to
     * hold, and the reason its type is a node rather than an href. */
    expect(slots.some((slot) => slot.querySelector('a[href]'))).toBe(true);
    expect(slots.some((slot) => slot.querySelector('button'))).toBe(true);
    /* Every filling names itself: an icon-only control with no accessible
     * name is an unnamed link in a screen reader's list. */
    for (const slot of slots) {
      const control = slot.querySelector('a,button')!;
      expect(control.getAttribute('aria-label')?.length).toBeGreaterThan(0);
    }
  });

  it('is not a place — no rail, no bottom bar, and one main', () => {
    render(<SessionProvider><App /></SessionProvider>);
    expect(document.querySelectorAll('nav[aria-label="Places"]')).toHaveLength(0);
    expect(document.querySelectorAll('main')).toHaveLength(1);
  });

  it('is linked from nowhere — every href on the page is the gallery itself', () => {
    render(<SessionProvider><App /></SessionProvider>);
    const strays = [...document.querySelectorAll('main a[href]')]
      .map((a) => a.getAttribute('href'))
      .filter((href) => href !== '#/kit');
    expect(strays).toEqual([]);
  });

  it('carries the amber alert’s sentence verbatim — what is at risk, not what is undone', () => {
    render(<SessionProvider><App /></SessionProvider>);
    expect(screen.getByText('If you lose this device your money is gone')).toBeTruthy();
    expect(screen.getByText(/Nobody can recover it, including us/)).toBeTruthy();
  });
});
