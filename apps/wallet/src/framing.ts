import { useEffect, useState } from 'react';
import { framingOf } from 'midnight-identity/profile/channel';
import type { ChannelWindow, Framing } from 'midnight-identity/profile/channel';
import { EMBEDDER } from './config.js';

/**
 * **WHERE THIS WALLET IS, AND WHAT CAN BE OBSERVED ABOUT WHETHER A PRESS ON IT WAS SEEN.**
 *
 * A wallet in a window of its own is drawn by the operating system: nothing a
 * page does can shrink it, cover it or hide it, and the address bar above it is
 * the one thing on the screen no page can write. **A framed wallet has none of
 * that.** The page around it decides how large it is, what is drawn over it and
 * whether it is on screen at all. From inside the frame, three of those can be
 * observed and are: its size, whether its tab is showing, and how long the
 * request has been in front of the person. The rest cannot, and is said below.
 */

/** Decided once per document: a frame does not move between pages. */
export const FRAMING: Framing = framingOf(window as unknown as ChannelWindow, EMBEDDER);

/** Smaller than this and the approval screen cannot show what is being approved. */
export const MIN_FRAME_WIDTH = 280;
export const MIN_FRAME_HEIGHT = 360;
/**
 * **HOW LONG A REQUEST MUST HAVE BEEN ON SCREEN BEFORE A PRESS COUNTS.** A button
 * put under the pointer the instant before a click is the oldest trick a page
 * framing somebody else's button has. The wait restarts when a new request
 * arrives and whenever the frame is resized or its tab hidden; it does not see
 * the frame being moved, faded or covered, which nothing inside a frame can.
 */
export const DWELL_MS = 700;

export interface WhatCanBeSeen {
  readonly framing: Framing;
  readonly width: number;
  readonly height: number;
  readonly documentVisible: boolean;
  /** How long it has been continuously seen, by every measure above. */
  readonly seenForMs: number;
}

export type Consent =
  | { readonly ok: true }
  | { readonly ok: false; readonly says: string };

/**
 * **THE VISIBILITY GUARD. A PURE RULE, SO EVERY REFUSAL IN IT CAN BE WATCHED FAILING.**
 *
 * In a window of its own every press is allowed, exactly as before. In a frame
 * each measure below must hold, and each refusal names what would make the
 * press possible - the person is never told only that it did not work.
 *
 * **WHAT IT DOES NOT MEASURE: THE FRAME BEING COVERED, FADED OR MOVED.** The one browser
 * signal for that - `IntersectionObserver`'s `trackVisibility` - was built in
 * and taken out again, on a measurement: in Chromium it reports every element
 * of a framed document as not visible the moment that document has scrolled at
 * all, including a button entirely in view, and an approval screen is taller
 * than the frame it sits in. A guard that refuses every honest press after a
 * scroll is a guard people learn to route around. **What stands against a page
 * covering the frame is that the only page allowed to hold it is this product's
 * own**, which the channel's asker check enforces in every browser and a
 * `frame-ancestors` header enforces wherever the serving host sends it.
 */
export function consentFor(seen: WhatCanBeSeen): Consent {
  if (seen.framing.of === 'top') return { ok: true };
  if (seen.framing.of === 'refused') return { ok: false, says: seen.framing.why };
  if (!seen.documentVisible) {
    return { ok: false, says: 'this wallet is not on screen, so nothing on it can be approved.' };
  }
  if (seen.width < MIN_FRAME_WIDTH || seen.height < MIN_FRAME_HEIGHT) {
    return {
      ok: false,
      says: 'this wallet is being shown too small to read what you would be approving. Make the '
        + 'window larger, or open your wallet in its own tab.',
    };
  }
  if (seen.seenForMs < DWELL_MS) {
    return { ok: false, says: 'this wallet has only just appeared. Read it, then press.' };
  }
  return { ok: true };
}

/**
 * **THE GUARD, MEASURED LIVE.** Re-read on every resize and every change of tab
 * visibility, and the dwell restarts whenever any measure stops holding - so a
 * frame that was hidden and shown again waits again.
 *
 * The framing is the screen's own - the same one its channel answers by - so
 * the guard and the asker check can never disagree about where the wallet is.
 */
export function useConsent(framing: Framing = FRAMING, request: unknown = null): Consent {
  const [consent, setConsent] = useState<Consent>(() => (framing.of === 'top'
    ? { ok: true }
    : { ok: false, says: 'this wallet has only just appeared. Read it, then press.' }));

  useEffect(() => {
    if (framing.of === 'top') {
      setConsent({ ok: true });
      return undefined;
    }
    let since: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const measure = (): void => {
      const base = {
        framing,
        width: window.innerWidth,
        height: window.innerHeight,
        documentVisible: document.visibilityState === 'visible',
      };
      const holds = consentFor({ ...base, seenForMs: Number.POSITIVE_INFINITY }).ok;
      const now = performance.now();
      if (!holds) since = null;
      else if (since === null) since = now;
      const verdict = consentFor({ ...base, seenForMs: since === null ? 0 : now - since });
      setConsent(verdict);
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (holds && !verdict.ok) timer = setTimeout(measure, DWELL_MS - (now - (since ?? now)) + 10);
    };

    window.addEventListener('resize', measure);
    document.addEventListener('visibilitychange', measure);
    measure();
    return () => {
      window.removeEventListener('resize', measure);
      document.removeEventListener('visibilitychange', measure);
      if (timer !== null) clearTimeout(timer);
    };
  }, [framing, request]);

  return consent;
}
