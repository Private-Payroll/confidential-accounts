/*
 * The screens shown before there is anything to approve: a request that was swapped for another, a wallet record that cannot be opened, a request refused before it was seen, and a wait for the request.
 */
import type { ReactNode } from 'react';
import type { Opened } from 'midnight-identity/profile/seal';
import type { Ask } from 'midnight-identity/profile/request';
import type { ChannelState, ChannelWindow } from 'midnight-identity/profile/channel';
import { StatusAlert } from '../components/status.js';
import { hrefOf } from '../routes.js';
import { sayingForUnopenable } from '../lib/unopenable-details.js';
import type { Screen, ScreenAsking } from './approve-shape.js';

/* An ask that differs from the one approved before the passkey has already been refused; it is said, never shown
 * with a button. */
export function swappedView(v: ScreenAsking<Ask>): ReactNode {
  const { request, say } = v;
  return (
    <>
      <h1 data-not-what-was-approved>{say('ask.swapped-title')}</h1>
      <StatusAlert tone="danger" title={say('ask.swapped-title')}>
        <p className="m-0">{say('ask.swapped', { origin: request.requester.origin })}</p>
      </StatusAlert>
    </>
  );
}

/*
 * ── THE THREE STATES THAT DO NOT KNOW WHICH KIND OF ASK THIS IS ──────────
 *
 * **FOUND BY LOOKING AT THE PICTURE, NOT BY READING THE CODE.** The first
 * walk photographed a refused SIGN-IN under the heading *Share your details*,
 * because the heading was written when there was only one kind of ask and a
 * refused request has no parsed kind to read. The screen was naming one of
 * two kinds and had a even chance of naming the wrong one — a heading
 * asserting something nobody checked, which is this project's oldest class.
 *
 * So these three say the thing that is true in ALL of them and name no kind.
 */
/* **ONLY THIS WALLET'S OWN RECORD REACHES THIS.** Another wallet's details in
 * this browser are kept under their own name and never stop this one answering. */
export function unopenableView(v: { readonly opened: Extract<Opened, { of: 'unopenable' }> }): ReactNode {
  const { opened } = v;
  const saying = sayingForUnopenable(opened);
  return (
    <>
      <h1>Nothing has been shared</h1>
      <StatusAlert tone={saying.tone} title={saying.title}>
        <p className="m-0" data-unopenable-why>{saying.sentence}</p>
        <p className="m-0">Nothing has been sent and nothing has been changed.</p>
      </StatusAlert>
    </>
  );
}

export function refusedView(v: { readonly channelState: Extract<ChannelState, { of: 'refused' }> }): ReactNode {
  const { channelState } = v;
  return (
    <>
      <h1>Nothing has been shared</h1>
      <StatusAlert tone="danger" title="This request was refused before you saw it">
        <p className="m-0">{channelState.error.message}</p>
      </StatusAlert>
      <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('home')}>← Your wallet</a></p>
    </>
  );
}

export function noRequestView(v: Pick<Screen, 'view' | 'framing'>): ReactNode {
  const { view, framing } = v;
  /*
   * **TWO WAYS TO BE HERE WITH NOTHING TO SHOW, AND THEY ARE NOT THE SAME
   * SCREEN.**
   *
   * The requester now opens this window **while it is still handling the
   * person's click** — before it has asked its own server for a nonce —
   * because a browser only grants that permission for the length of a press,
   * and both paths used to spend it on a round trip first. Chromium forgave
   * that; Safari and Firefox refuse it outright.
   *
   * So this window is now routinely open for a moment with the ask still in
   * flight, and *Nothing is asking* would be a wallet telling somebody the
   * press they just made did nothing. **`window.opener` is what tells the two
   * apart, and the browser fills it in** — the same property `channel.ts`
   * already refuses messages on, read the other way. A page cannot set it on
   * a window it did not open, so it cannot make this wallet claim to be
   * waiting for it.
   *
   * It says nothing about WHO is asking, because at this moment this wallet
   * does not know: the origin is observed on the first message and not
   * before. A screen that named the requester here would be naming a guess.
   */
  const here = view ?? (window as unknown as ChannelWindow);
  /* **OR THE PAGE THIS WALLET WAS BUILT TO SIT INSIDE.** A frame has no
   * `opener`, so without this a framed wallet said *Nothing is asking* under
   * a live request. Only the ALLOWED embedder counts: a stranger's frame is
   * refused before this screen renders at all. */
  if (here.opener || framing.of === 'framed') {
    return (
      <>
        <h1 data-waiting-for-ask>Waiting for the request</h1>
        <p className="lede">
          The application that opened this window is still preparing what it wants to
          ask. Nothing has been sent and nothing has been signed.
        </p>
        <p className="m-0 text-sm text-muted-foreground">
          When it arrives, this wallet will tell you where the page actually came
          from — and nothing leaves here until you press something.
        </p>
        <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('home')}>← Your wallet</a></p>
      </>
    );
  }
  return (
    <>
      <h1>Nothing is asking</h1>
      <p className="lede">
        Nothing is asking for anything. This screen appears when an application opens
        your wallet to sign you in, or to ask for details about you — it will name
        itself, and this wallet will tell you where it actually came from.
      </p>
      <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('home')}>← Your wallet</a></p>
    </>
  );
}
