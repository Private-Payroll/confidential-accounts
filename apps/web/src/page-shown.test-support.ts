import { act } from '@testing-library/react';

/*
 * WAITING FOR A PAGE, THE ONE WAY EVERY TEST OF THIS APPLICATION DOES IT.
 *
 * A page's screen loads when the page is first opened, and its records are
 * read after that, so how many turns a page takes to appear is not a number a
 * test can know. A test that opens a page waits here, a turn at a time, until
 * what it is about to read is on screen, and fails, saying what it waited
 * for, when that does not come in time. It never reads after a fixed number
 * of turns.
 */

/** How long a test waits for something to be on screen before it fails. */
export const WAIT_MS = 5_000;

/** Wait until `find` finds something, and hand it back; fail, naming `what`, if it has not appeared within `ms`. */
export async function untilShown<T extends Element>(find: () => T | null, what: string, ms = WAIT_MS): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found !== null) return found;
    if (Date.now() >= end) throw new Error(`not on screen after ${ms} ms: ${what}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
}

/**
 * Wait until the page drawn in `container` is on screen: its screen drawn,
 * and nothing in it still loading or being read. Hands back the screen.
 */
export function untilPageShown(container: ParentNode, ms = WAIT_MS): Promise<HTMLElement> {
  return untilShown(
    () => (container.querySelector('[data-loading], [data-reading]') === null ? container.querySelector<HTMLElement>('[data-screen]') : null),
    'a page with its screen drawn and nothing still loading or being read',
    ms,
  );
}
