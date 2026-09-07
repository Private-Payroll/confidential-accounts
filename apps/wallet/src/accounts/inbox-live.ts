import { useSyncExternalStore } from 'react';
import { inboxKeypair } from 'midnight-identity/profile/inbox';
import type { InboxHost } from 'midnight-identity/profile/inbox';
import { startInboxPolling } from 'midnight-identity/profile/inbox-poll';
import type { InboxPolling, InboxState } from 'midnight-identity/profile/inbox-poll';
import type { Identity } from 'midnight-identity';
import { INBOX_HOST } from '../config.js';

/**
 * THE INBOX, FOR EXACTLY AS LONG AS THE WALLET IS OPEN.
 *
 * ── WHY THE LIFETIME IS THE PHASE AND NOT A SCREEN ────────────────────────
 *
 * *"Poll while the wallet is open."* A poller owned by the card would stop the
 * moment somebody walked to Settings, which is not what the agreement says and
 * is not what a person would expect of an inbox. So the lifetime is owned by
 * `app/app.tsx`'s unlocked branch — the same place that holds the identity the
 * inbox key is derived from — and the card SUBSCRIBES to what it finds.
 *
 * ── AND WHY THERE IS A MODULE-LEVEL STORE, WHICH IS NORMALLY A SMELL ──────
 *
 * `shell/wallets.ts` is the precedent and its argument is the same one: two
 * surfaces need one fact, and the alternative is threading it through props
 * that exist for no other reason. **The difference here, and it is the thing to
 * be careful about, is that this store holds a person's notices** — so it is
 * emptied by the same teardown that stops the poller, and `forgetInbox()` is
 * called by that teardown rather than left to a garbage collector. A store that
 * survived the phase would be a locked wallet's contents readable by whatever
 * renders next.
 *
 * **NOTHING HERE STARTS ANYTHING ON ITS OWN.** Importing this module registers
 * no timer, no listener and no worker. The only thing that starts a poller is
 * `openInbox`, and the only caller of that is the unlocked branch of `app.tsx`.
 */

/**
 * WHAT THE CARD RENDERS FROM. `InboxState`'s four arms, plus the one this
 * application knows and the poller cannot: **there is no host in this build.**
 *
 * That is not a failure and it must not be shown as one. A failed ask means a
 * host was asked and did not answer; `no-host` means nothing was asked, because
 * there is nowhere to ask. The same distinction, one arm further out.
 */
export type InboxView = { readonly of: 'no-host' } | InboxState;

export interface InboxSnapshot {
  readonly view: InboxView;
  /** What the screen NAMES as the thing being asked. Null when there is none. */
  readonly host: string | null;
}

const NOTHING: InboxSnapshot = Object.freeze({
  view: { of: 'no-host' } as const, host: null,
});

let snapshot: InboxSnapshot = NOTHING;
let live: InboxPolling | null = null;

const listeners = new Set<() => void>();

/* Iterated over a COPY — `shell/wallets.ts`'s reason: a subscriber that
 * unmounts while being notified would otherwise mutate the set mid-iteration. */
const changed = (): void => { for (const l of [...listeners]) l(); };

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

/** The card, and anything else that wants to know. Read-only by construction. */
export function useInbox(): InboxSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/** Ask on purpose. **The refresh control the agreement requires.** */
export function refreshInbox(): void {
  live?.refresh();
}

/**
 * STOP, AND FORGET. Called by the unlocked phase's teardown and by nothing
 * else. **Both halves matter**: stopping without forgetting leaves a person's
 * notices in a module a locked browser can still render from.
 */
export function forgetInbox(): void {
  live?.stop();
  live = null;
  snapshot = NOTHING;
  changed();
}

/**
 * START, FOR THIS UNLOCKED PHASE.
 *
 * `host` is a parameter with a default rather than a direct read of `config`,
 * so a test drives a real transport without a real network — the same seam
 * `screens/approve.tsx` takes its `view` on, and for the same reason.
 *
 * **IT RETURNS ITS OWN TEARDOWN**, so the caller cannot start one and forget
 * to stop it: `useEffect` hands the return value straight back.
 */
export function openInbox(
  identity: Identity,
  unlocked: () => boolean,
  host: InboxHost | null = INBOX_HOST,
): () => void {
  if (host === null) {
    snapshot = NOTHING;
    changed();
    return () => { forgetInbox(); };
  }
  const keys = inboxKeypair(identity);
  live = startInboxPolling({
    host,
    keys,
    unlocked,
    onState: (view) => {
      snapshot = Object.freeze({ view, host: host.describes });
      changed();
    },
  });
  return () => { forgetInbox(); };
}
