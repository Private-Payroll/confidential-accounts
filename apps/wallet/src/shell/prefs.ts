/**
 * WHERE THE INTERFACE KEEPS ITS OWN PREFERENCES — and why it is not
 * `storage.ts`.
 *
 * §3 gave the shell a second thing to remember (whether the rail is
 * collapsed) beside the first (which theme). The argument for keeping them out
 * of `storage.ts` was written once, in `shell/theme.tsx`, and duplicating it
 * would have been the first step towards it being true in one place and not the
 * other. So it lives here, once, and both read through this file.
 *
 * `storage.ts` holds WALLET STATE: sealed, fingerprinted to a secret, and
 * `forgetEverything()` clears exactly what it wrote. Which theme a browser is
 * in and whether a rail is folded are neither. They survive locking, they mean
 * nothing to another machine, and — this is the half that matters — **they must
 * not arrive under a key that a "forget everything" is expected to clear.** A
 * person pressing that button is asking about their money, and a wallet that
 * answered by also resetting the theme would be telling them it had done
 * something it had not.
 *
 * `storage.ts` is frozen this change in any case, so this
 * is not a workaround for a locked file; it is where these belong.
 *
 * EVERY READ AND EVERY WRITE IS WRAPPED. A browser with storage switched off
 * still gets a wallet and still gets a theme — it just does not get to keep the
 * choice. A preference layer that can throw is a preference layer that can take
 * the whole app down over a cosmetic setting.
 */

const NAMESPACE = 'identity-ui:';

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(NAMESPACE + key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(NAMESPACE + key);
    else localStorage.setItem(NAMESPACE + key, value);
  } catch {
    /* Unstored, still applied. */
  }
}
