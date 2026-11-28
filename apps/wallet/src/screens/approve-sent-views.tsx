/*
 * The screens shown after an answer went: for an unlock key, a keyring, a sign-in, an accepted invitation and a disclosure.
 * Each says what was sent, to whom and when, and what the page can do with it now.
 */
import type { ReactNode } from 'react';
import type { Ask } from 'midnight-identity/profile/request';
/* A RENDERING of the company's label and its account together. It is not, and must never
 * become, an input to anything derived; `midnight-identity/profile/fingerprint` says why. */
import { companyFingerprint } from 'midnight-identity/profile/fingerprint';
import { displayNameOf } from '../accounts/subwallets.js';
import { loadSubwallets } from '../accounts/storage.js';
import { StatusAlert } from '../components/status.js';
import { hrefOf } from '../routes.js';
import { dateOf } from './approve-text.js';
import type { ScreenAnswered } from './approve-shape.js';
import type { JoinRequest, KeyringRequest, SignInRequest, UnlockRequest } from 'midnight-identity/profile/request';

export function unlockSentView(v: ScreenAnswered<UnlockRequest>): ReactNode {
  const { problem, sentAt, request } = v;
  return (
    <>
      <h1>They have the key</h1>
      {/* The sentence shown afterwards was written in the asker's
       * own words too. It names what was OBSERVED and what was OPENED.
       *
       * **and the company is named by its fingerprint rather than
       * by sixty-four characters of hex threaded through the middle of a
       * sentence**, which is how the picture of this screen read. The full
       * address is still here, underneath, on a line of its own where it can
       * wrap without breaking a sentence in half. */}
      <div data-key-given>
        <p className="lede m-0">
          {`On ${dateOf(sentAt)} you gave `}
          <span className="font-mono break-all">{request.requester.origin}</span>
          {' the key to the records company '}
          <span className="font-mono tracking-wide" data-given-fingerprint>
            {request.account !== null ? companyFingerprint(request.company, request.account) : request.company}
          </span>
          {' keeps for you.'}
        </p>
        <p className="m-0 text-sm text-muted-foreground" style={{ marginTop: '0.5rem' }}>
          That company’s account in full
        </p>
        <p className="m-0 font-mono break-all text-sm text-muted-foreground">{request.account}</p>
        <p className="m-0 text-sm text-muted-foreground" style={{ marginTop: '0.5rem' }}>
          And its label
        </p>
        <p className="m-0 font-mono break-all text-sm text-muted-foreground">{request.company}</p>
      </div>
      {/* §6 — NO REVOCATION LANGUAGE, ANYWHERE. And here it binds hardest:
       * a disclosure hands over a fact somebody already knew about
       * themselves; this hands over the ability to read. */}
      <StatusAlert tone="info" role={null} title="What they can do now">
        <p className="m-0">
          {`${request.requester.origin} can open those records from now on, and this `}
          wallet cannot see them doing it. You can refuse the next time they ask. Nothing takes back a key that has
          gone.
        </p>
      </StatusAlert>
      {problem !== null && (
        <StatusAlert tone="warning" title="One thing did not save">
          {problem}
        </StatusAlert>
      )}
      <p style={{ marginTop: '1.5rem' }}>
        <a href={hrefOf('profile')}>My profile</a>
      </p>
    </>
  );
}

export function keyringSentView(v: ScreenAnswered<KeyringRequest>): ReactNode {
  const { problem, sentAt, givenCompany, request } = v;
  return (
    <>
      <h1>They have the key</h1>
      <div data-keyring-given>
        <p className="lede m-0">
          {`On ${dateOf(sentAt)} you gave `}
          <span className="font-mono break-all">{request.requester.origin}</span>
          {' the key to the keys this wallet saved under the account name it gave'}
          {request.company !== null
            ? ', and the key to the records one company keeps for you.'
            : request.drawLabel
              ? ', and your keys for the new company it is setting up.'
              : '.'}
        </p>
        {givenCompany !== null && (
          <>
            {givenCompany.account !== null && (
              <>
                <p className="m-0 text-sm text-muted-foreground" style={{ marginTop: '0.5rem' }}>
                  The company&rsquo;s fingerprint
                </p>
                <p className="m-0 font-mono tracking-wide" data-given-fingerprint>
                  {companyFingerprint(givenCompany.company, givenCompany.account)}
                </p>
              </>
            )}
            <p className="m-0 text-sm text-muted-foreground" style={{ marginTop: '0.5rem' }}>
              {request.drawLabel ? 'The label this wallet made up for it' : 'Its label'}
            </p>
            <p className="m-0 font-mono break-all text-sm text-muted-foreground" data-keyring-label>
              {givenCompany.company}
            </p>
            {givenCompany.account === null && (
              <p className="m-0 text-sm text-muted-foreground">
                The company has no account on the chain yet, so there is no fingerprint yet.
              </p>
            )}
          </>
        )}
      </div>
      <StatusAlert tone="info" role={null} title="What they can do now">
        <p className="m-0">
          {`${request.requester.origin} can use the keys this wallet saved under that account name from now on - `}
          for every company that account belongs to - and this wallet cannot see them doing it. You can refuse the next
          time they ask. Nothing takes back a key that has gone.
        </p>
      </StatusAlert>
      {problem !== null && (
        <StatusAlert tone="warning" title="One thing did not save">
          {problem}
        </StatusAlert>
      )}
      <p style={{ marginTop: '1.5rem' }}>
        <a href={hrefOf('profile')}>My profile</a>
      </p>
    </>
  );
}

export function signInSentView(v: ScreenAnswered<SignInRequest>): ReactNode {
  const { secret, subwallet, problem, sentAt, request } = v;
  return (
    <>
      {/* **THIS WALLET SAYS WHAT IT DID, NOT WHAT IT ACHIEVED.**
       *
       * It read `Signed in`, and on the first walk-through of the two
       * applications that heading was on the screen while the payroll tab
       * was refusing the answer it had just been handed. **The wallet was
       * telling the truth about itself and the words were about somebody
       * else's outcome** — one it does not observe and cannot: the answer
       * crosses a channel to a different origin, which verifies it and may
       * refuse it.
       *
       * So the heading names the ACT and the SITE it was done for. The
       * alternative — the requester telling the wallet how it went, and the
       * wallet waiting to say anything until it knows — is a protocol
       * change, and it is not this. */}
      <h1 data-signed-in-heading>
        {'You signed in to '}
        <span className="font-mono break-all">{request.requester.origin}</span>
      </h1>
      {/* The sentence afterwards names what was OBSERVED. It used to
       * name what the page called itself, which is the one field on the ask
       * the asker chose. */}
      <p className="lede" data-signed-in>
        {`On ${dateOf(sentAt)} you signed in to `}
        <span className="font-mono break-all">{request.requester.origin}</span>
        {` as ${displayNameOf(subwallet, loadSubwallets(secret).names)}.`}
      </p>
      {/* §6 — NO REVOCATION LANGUAGE, ANYWHERE. */}
      <StatusAlert tone="info" role={null} title="What they know now">
        <p className="m-0">
          {`${request.requester.origin} now holds a signed statement that the owner of `}
          this wallet address was here. You can stop signing in to them. Nothing can take back what has gone.
        </p>
      </StatusAlert>
      {problem !== null && (
        <StatusAlert tone="warning" title="One thing did not save">
          {problem}
        </StatusAlert>
      )}
      <p style={{ marginTop: '1.5rem' }}>
        <a href={hrefOf('profile')}>My profile</a>
      </p>
    </>
  );
}

export function joinSentView(v: ScreenAnswered<JoinRequest>): ReactNode {
  const { problem, sentAt, request } = v;
  return (
    <>
      {/* **THIS WALLET SAYS WHAT IT DID, NOT WHAT IT ACHIEVED.**
       * It accepted and it sealed. Whether the company can pay anybody is
       * an outcome on a machine this wallet does not observe, and a heading
       * that claimed it would be the sentence it was written for. */}
      <h1 data-accepted-heading>
        {'You accepted the invitation from '}
        <span className="font-mono break-all">{request.requester.origin}</span>
      </h1>
      <p className="lede" data-accepted>
        {`On ${dateOf(sentAt)} you sent what you approved to `}
        <span className="font-mono break-all">{request.requester.origin}</span>
        {', sealed so that only whoever holds the key below can read it.'}
      </p>
      <p className="m-0 text-sm text-muted-foreground" style={{ marginTop: '0.5rem' }}>
        The key it was sealed to, in full
      </p>
      <p className="m-0 font-mono break-all text-sm text-muted-foreground" data-sealed-to>
        {request.inboxPublicKey}
      </p>
      {/* §6 -- NO REVOCATION LANGUAGE, ANYWHERE. And the honest half of the
       * seal: it decides WHO CAN READ, and it decides nothing at all about
       * what a reader does next. */}
      <StatusAlert tone="info" role={null} title="What is sent, is sent">
        <p className="m-0">
          Whoever holds that key keeps their own copy of what you just sent, which is normally what you want &mdash; it
          is how they pay you. Sealing it decided who could read it on the way, and nothing more. You can stop sending
          them anything new. Nothing can take back what has gone.
        </p>
      </StatusAlert>
      {problem !== null && (
        <StatusAlert tone="warning" title="One thing did not save">
          {problem}
        </StatusAlert>
      )}
      <p style={{ marginTop: '1.5rem' }}>
        <a href={hrefOf('profile')}>My profile</a>
      </p>
    </>
  );
}

export function detailsSentView(v: ScreenAnswered<Ask>): ReactNode {
  const { problem, sentAt, request } = v;
  return (
    <>
      <h1>Sent</h1>
      {/* Observed, not claimed. */}
      <p className="lede" data-details-sent>
        {`On ${dateOf(sentAt)} you sent details to `}
        <span className="font-mono break-all">{request.requester.origin}</span>
        {'.'}
      </p>
      {/* §6 — NO REVOCATION LANGUAGE, ANYWHERE. */}
      <StatusAlert tone="info" role={null} title="What is sent, is sent">
        <p className="m-0">
          {request.requester.origin} keeps their own copy of what you just sent, which is normally what you want — it is
          how they pay you. You can stop sending them anything new. Nothing can take back what has gone.
        </p>
      </StatusAlert>
      {problem !== null && (
        <StatusAlert tone="warning" title="One thing did not save">
          {problem}
        </StatusAlert>
      )}
      <p style={{ marginTop: '1.5rem' }}>
        <a href={hrefOf('profile')}>My profile</a>
      </p>
    </>
  );
}
