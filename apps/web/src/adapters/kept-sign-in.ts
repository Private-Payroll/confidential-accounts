import type { SignInCarried } from 'vaults-web-shared/keyring.js';

/*
 * THE ADDRESS A SIGN-IN IN THIS TAB WAS FOR, AND WHOM IT WAS FOR, KEPT IN THE
 * TAB'S OWN STORAGE, which a reload keeps and closing the tab clears.
 *
 * The service does not say the address again after a reload, and a person's
 * first keys are saved only under the key of the account that holds the
 * address they signed in as. Kept here, it is handed back to the keyring when
 * the tab picks the sign-in up again, so a person creating their first company
 * after a reload is not asked to sign in a second time. The keyring takes it
 * only for the person the service says is signed in now. It is an address and
 * an id, both of which the page already holds while the person is signed in;
 * nothing kept here opens anything. Kept as JSON, which only this folder writes.
 */

/** Where the sign-in is kept in the tab's own storage. */
const KEPT = { signIn: 'private-vaults.signed-in-as' } as const;

/** The sign-in kept in `storage`, or null when there is none or what is kept is not one. */
export function readSignIn(storage: Pick<Storage, 'getItem'> | null): SignInCarried | null {
  const text = storage?.getItem(KEPT.signIn) ?? null;
  if (text === null) return null;
  let kept: unknown;
  try { kept = JSON.parse(text); } catch { return null; }
  const k = (kept ?? {}) as { personId?: unknown; address?: unknown };
  return typeof k.personId === 'string' && k.personId !== '' && typeof k.address === 'string' && k.address !== ''
    ? { personId: k.personId, address: k.address } : null;
}

/** Keep `signIn` in `storage`, or forget what is kept when it is null. A browser that refuses keeps nothing. */
export function keepSignIn(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, signIn: SignInCarried | null): void {
  try {
    if (signIn === null) storage?.removeItem(KEPT.signIn);
    else storage?.setItem(KEPT.signIn, JSON.stringify({ personId: signIn.personId, address: signIn.address }));
  } catch { /* kept for this page only, which is nothing after a reload */ }
}
