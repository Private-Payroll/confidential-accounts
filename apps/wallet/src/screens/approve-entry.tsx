import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { framingOf, listen } from 'midnight-identity/profile/channel';
import { EMBEDDER } from '../config.js';
import type { ChannelState, ChannelWindow } from 'midnight-identity/profile/channel';
import { hrefOf } from '../routes.js';
import { useSession } from '../session.js';
import type { Phase } from '../session.js';
import { ErrorNote, Moon, StatusNote } from '../components/ui.js';

/**
 * **A WINDOW OPENED FOR A REQUEST, WITH NO WALLET IN IT.**
 *
 * ── THE STATE THIS FILE EXISTS FOR ────────────────────────────────────────
 *
 * **The most common person this product will ever have is somebody who has just
 * been hired, has never heard of it, and is opening a link a colleague sent
 * them.** They have no wallet. Until this file, `#/approve` in that browser
 * rendered the ordinary welcome screen: a correct screen for somebody who
 * wandered in, and the wrong one for somebody whose employer's page is sitting
 * behind this window waiting for an answer. **The state had no words.**
 *
 * ── AND THE HALF THAT IS NOT WORDS, WHICH IS THE HALF THAT WAS BROKEN ─────
 *
 * `profile/channel.ts`'s `listen` does two things: it captures the request, and
 * **it tells the asking page that a wallet is listening.** Only `Approve` called
 * it, and `Approve` renders only when an account is unlocked — so in every phase
 * but that one **nothing was ever said to the page that opened this window.**
 *
 * The asking side gives a wallet **twenty seconds** to say it is listening
 * (`READY_TIMEOUT_MS` on the asking side) and five minutes to answer once
 * it has. Twenty seconds is a page load. **It is not making a passkey, and it is
 * certainly not reading a screen for the first time and deciding to make a
 * wallet** — so an invitee who did exactly what this screen asks would have
 * come back to an offer that had already given up on them. Saying *I am here*
 * from every entry phase is what turns that into the five-minute window, and it
 * is why this component wraps the ordinary entry screens rather than replacing
 * only the welcome one.
 *
 * **NOTHING IS ANSWERED FROM HERE.** There is no key in this browser to answer
 * with, and there is no path in this file that could: it holds a channel open
 * and renders words. When a wallet arrives, `App` swaps this for `Approve`,
 * which opens its own channel — and the asking page re-sends the request when it
 * hears that second *I am here*, which is what makes *the ask carries on* true
 * rather than hopeful.
 *
 * ── THERE IS NO "WAY BACK" HERE, BECAUSE THERE IS NOTHING TO GO BACK TO ───
 *
 * The wallet is a DIALOG. The page that asked never navigated anywhere:
 * it is still on screen, behind this window, with the offer still on it. A round
 * that built a return journey would be building a way back to a page nobody
 * left. This screen says so, because a person who has just been sent to make a
 * wallet reasonably wonders where their offer went.
 */

/** What `entryFor` would have rendered for this phase, when the words below
 * are not the right ones. Passed in rather than derived, so `app.tsx` keeps
 * the one decision about which screen a phase means. */
export interface ApproveEntryProps {
  readonly phase: Phase;
  readonly entry: ReactNode;
  /** The window this listens on. Injected so a test can drive a real origin. */
  readonly view?: ChannelWindow;
  readonly now?: () => number;
  /** The one page allowed to frame this wallet. Injected so a test can frame it. */
  readonly embedder?: string | null;
}

export function ApproveEntry({
  phase, entry, view, now = Date.now, embedder = EMBEDDER,
}: ApproveEntryProps): ReactNode {
  const { createAccount, busy, error } = useSession();
  const [channelState, setChannelState] = useState<ChannelState>({ of: 'waiting' });

  useEffect(() => {
    const target = view ?? (window as unknown as ChannelWindow);
    const channel = listen(target, now, setChannelState, embedder);
    return () => channel.stop();
  }, [view, now, embedder]);

  /*
   * **THE ORIGIN, WHICH IS A FACT, AND NOT THE NAME, WHICH IS A CLAIM.**
   *
   * The asking page also sends what it calls itself, and every other surface in
   * this wallet shows that beside the origin the browser observed, never larger
   * than it. There is nothing on this screen for a person to weigh a claim
   * against — they are not approving anything here — so the claim is simply not
   * rendered. What is worth saying is that the window belongs to a page, and
   * which one.
   */
  const askedBy = channelState.of === 'request'
    ? channelState.request.requester.origin : null;

  /*
   * **A FRAMED WALLET SHOWS NO CONTROL UNTIL THE PAGE IT WAS BUILT FOR HAS
   * SPOKEN.** The entry screens carry buttons that make a passkey, add a wallet
   * or start again, and a page that framed this wallet without being allowed to
   * could otherwise put them under somebody's pointer - in a browser that does
   * not report a frame's ancestors, the first message is the first moment the
   * asker's origin is observed at all. So until a request has been accepted from
   * the allowed page, a framed entry is a waiting line and nothing else.
   */
  const framed = framingOf(view ?? (window as unknown as ChannelWindow), embedder).of === 'framed';
  if (framed && channelState.of !== 'request') {
    return (
      <>
        <h1 data-waiting-for-ask>Waiting for the request</h1>
        <p className="lede">
          The page around this wallet is still preparing what it wants to ask. Nothing has been
          sent and nothing has been signed.
        </p>
      </>
    );
  }

  if (phase.name !== 'welcome') return entry;

  return (
    <>
      <div className="hero">
        <Moon large />
        <h1>You have no wallet yet.</h1>
        <p className="lede" data-no-wallet-for-a-request>
          {askedBy === null
            ? 'The page that opened this window is asking you for something, and there is '
            : framed
              ? `${askedBy} is asking you for something, and there is `
              : `${askedBy} opened this window to ask you for something, and there is `}
          nothing in this browser to answer with. Make one here — it takes one touch — and
          the question is still waiting when you come back to it.
        </p>
        <p className="muted small">
          {framed
            ? 'Nothing has been sent and nothing has been agreed.'
            : 'Nothing has been sent and nothing has been agreed. The page that asked is still '
              + 'open behind this window, exactly where you left it.'}
        </p>
        <div className="actions">
          <button
            type="button"
            className="primary big"
            onClick={() => { void createAccount(); }}
            disabled={busy !== null}
          >
            Create your wallet
          </button>
          <StatusNote message={busy} />
          <ErrorNote message={error} />
        </div>
      </div>

      <section className="card">
        <h2>Already have a wallet?</h2>
        <p className="muted small">
          It is in the browser you made it in. A wallet made in another browser, or on
          another machine, is not in this one — these are the two ways it gets here.
        </p>
        <div className="step">
          <div className="dot" aria-hidden="true">→</div>
          <div className="body">
            <h2>
              <a href={hrefOf('add-device')}>Move it onto this machine</a>
            </h2>
            <p className="muted small">
              Scan a code shown by a device that already has it, then compare two digits.
            </p>
          </div>
        </div>
        <div className="step">
          <div className="dot" aria-hidden="true">→</div>
          <div className="body">
            <h2>
              <a href={hrefOf('recover')}>Recover it from pieces</a>
            </h2>
            <p className="muted small">
              Gather enough of the pieces you placed, and the account comes back —
              even on a machine that never had it.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
