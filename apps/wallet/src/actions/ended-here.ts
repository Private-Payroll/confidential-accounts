import type { ActEnded } from 'midnight-identity/profile/channel';
import type { Words } from './definition.js';

/**
 * HOW THE LAST ACTION IN THIS WINDOW ENDED, KEPT FOR THE SCREEN AFTER IT.
 *
 * An action locks the wallet when it ends, so the screen that ran it is gone
 * by the time its outcome is shown; this holds the outcome for the locked
 * window to show instead. It holds counts and words, never a key, and lives
 * only as long as the window.
 */
export interface EndedHere {
  readonly ended: ActEnded;
  /** Why a stopped action stopped, or what a done action gave its window to show. */
  readonly says: Words | null;
  /** A step was still running when the action ended: it is cut off from the keys, but may still be finishing. */
  readonly abandoned: boolean;
}

let last: EndedHere | null = null;

export function keepTheEnd(end: EndedHere): void { last = end; }
export function theEndHere(): EndedHere | null { return last; }
export function forgetTheEnd(): void { last = null; }
