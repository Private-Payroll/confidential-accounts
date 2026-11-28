/*
 * The sign-in screen and the screen for details or an invitation.
 * The first asks one question and sends nothing about the person; the second lists each detail asked for, what the wallet holds for it, the key an invitation is sealed to, and what the person declined.
 */
import type { ReactNode } from 'react';
import { RECEIVING_ADDRESS } from 'midnight-identity/profile/attributes';
import { Button, Section } from 'vaults-ui';
import { StatusAlert } from '../components/status.js';
import { FACT_TEXT } from './approve-text.js';
import type { Row } from './approve-rows.js';
import { ConsentRefused } from './approve-consent-refused.js';
import type { AskedScreen } from './approve-shape.js';
import { rowView } from './approve-rows-view.js';
import type { DisclosureRequest, JoinRequest, SignInRequest } from 'midnight-identity/profile/request';

function joinSealedTo(v: { readonly join: JoinRequest }): ReactNode {
  const { join } = v;
  return (
    <Section
      list={false}
      box={false}
      aria-label="Where what you send can be read"
      title="Where what you send can be read"
      description="An invitation is answered in a sealed envelope. This is the key it is sealed to."
    >
      <p className="m-0 text-sm text-muted-foreground">
        What you approve below is sealed on this device before it leaves it. The page that asked carries it; only
        whoever holds this key can open it.
      </p>
      <p className="m-0 text-sm text-muted-foreground" style={{ marginTop: '0.75rem' }}>
        The key it will be sealed to, in full
      </p>
      <p className={`m-0 font-mono break-all text-foreground ${FACT_TEXT}`} data-inbox-key>
        {join.inboxPublicKey}
      </p>
      <p className="m-0 text-sm text-muted-foreground">
        This wallet cannot check that this key belongs to the company you think you are joining. It can only show it to
        you. If you do not recognise who invited you, send nothing.
      </p>
    </Section>
  );
}

function sentWarning(
  v: AskedScreen<DisclosureRequest | JoinRequest> & { readonly join: JoinRequest | null }
): ReactNode {
  const { request, join } = v;
  return (
    <StatusAlert tone="warning" role={null} title="What is sent, is sent">
      {join === null ? (
        <p className="m-0">
          {`${request.requester.origin} will keep their own copy of whatever you send. `}
          This wallet can stop sending them anything new later. Nothing can take back what has gone.
        </p>
      ) : (
        <p className="m-0" data-join-warning>
          Whoever holds that key will keep their own copy of whatever you send. Sealing it decides who can read it on
          the way and nothing about what they do with it afterwards. This wallet can stop sending them anything new
          later. Nothing can take back what has gone.
        </p>
      )}
    </StatusAlert>
  );
}

function missingNotice(v: { readonly join: JoinRequest | null; readonly missingRequired: readonly Row[] }): ReactNode {
  const { join, missingRequired } = v;
  return join !== null && missingRequired.some((r) => r.attribute === RECEIVING_ADDRESS) ? (
    <StatusAlert tone="warning" title="You have said not to send where you are paid">
      <p className="m-0" data-join-no-address>
        You can accept anyway, and they are told you declined it. But nothing in what you send says where to pay you, so
        whoever opens it cannot pay you and will have to ask you again some other way.
      </p>
      {missingRequired.length > 1 && (
        <p className="m-0">
          {`They also require ${missingRequired
            .filter((row) => row.attribute !== RECEIVING_ADDRESS)
            .map((row) => row.definition?.render.label ?? row.attribute)
            .join(', ')}.`}
        </p>
      )}
    </StatusAlert>
  ) : (
    <p className="m-0 text-sm text-muted-foreground" data-missing-required>
      {`They require ${missingRequired.map((row) => row.definition?.render.label ?? row.attribute).join(', ')}. `}
      {join === null
        ? 'You can send anyway, and they are told what you declined.'
        : 'You can accept anyway, and they are told what you declined.'}
    </p>
  );
}

function disclosureButtons(
  v: AskedScreen<DisclosureRequest | JoinRequest> & { readonly join: JoinRequest | null }
): ReactNode {
  const { setChannelState, channel, request, consent, approve, join } = v;
  return (
    <div className="flex flex-wrap gap-2">
      {/* Observed, not claimed, on the button as on the question. */}
      <Button
        size="lg"
        type="button"
        variant="default"
        onClick={approve}
        disabled={!consent.ok}
        data-approve
        {...(join === null ? {} : { 'data-join': '' })}
      >
        {join === null
          ? `Send these to ${request.requester.origin}`
          : `Accept, and send these to ${request.requester.origin}`}
      </Button>
      <Button
        size="lg"
        type="button"
        variant="ghost"
        data-decline
        onClick={() => {
          channel?.refuse('declined');
          setChannelState({ of: 'waiting' });
        }}
      >
        {join === null ? 'Send nothing' : 'Do not accept'}
      </Button>
      <ConsentRefused consent={consent} />
    </div>
  );
}

/**
 * A sign-in is not the disclosure screen with an empty list: a screen listing nothing is one a person cannot read an
 * answer off. It asks one question, whether this site may know it is the person, and names the site and the wallet
 * that answers. There is nothing to tick, so a remembered grant pre-ticks nothing, and the answer still waits for a
 * press, here or in the locked wallet's window: a site that could sign a person in without one could act as them,
 * which is a larger power than reading one attribute.
 */
export function signInView(v: AskedScreen<SignInRequest>): ReactNode {
  const { setChannelState, channel, request, consent, approve, whoIsAsking, whichWallet } = v;
  return (
    <>
      <h1>Sign in</h1>

      {whoIsAsking}

      {whichWallet(
        'Which wallet answers',
        'Signing in tells them this wallet’s address and proves you hold it. It is ' +
          'the same address they would pay, which is the point — but it is a fact about ' +
          'you and it does not come back.'
      )}

      <Section
        list={false}
        box={false}
        aria-label="What you are agreeing to"
        title="What you are agreeing to"
        description="Nothing about you is sent. This is one question and one answer."
      >
        {/*
         * **THE QUESTION IS BUILT FROM THE OBSERVED ORIGIN.** This change
         * does to this screen what was done to unlock. It used to be built
         * from `request.requester.name` — the one field on the whole ask
         * that the ASKER chose — so a page served from `payroll-b.example`
         * calling itself *Payroll A* was asked about in the wallet's own
         * voice as *"Do you want Payroll A to know it is you?"*. The name is
         * still shown, in the card above, labelled as what they call
         * themselves.
         */}
        <p className="m-0 text-base text-foreground" data-sign-in-question>
          {`Do you want ${request.requester.origin} to know it is you?`}
        </p>
        <p className="m-0 text-sm text-muted-foreground">
          There is nothing to tick here and nothing to choose. They asked to be told that the person in front of them
          owns this wallet, and pressing the button below is the whole of the answer.
        </p>
      </Section>

      {/* §6 — NO REVOCATION LANGUAGE, ANYWHERE. */}
      <StatusAlert tone="warning" role={null} title="What they learn, they keep">
        <p className="m-0">
          {`${request.requester.origin} will keep a signed statement that you were here, `}
          and the address it was signed by. This wallet can stop signing you in to them later. Nothing can take back
          what has gone.
        </p>
      </StatusAlert>

      <div className="flex flex-wrap gap-2">
        {/* THE BUTTON IS THE QUESTION'S RULE AGAIN. The rule names the button
         * as well as the headline: a person who skims reads those and
         * nothing else, so neither may be written in the asker's own words. */}
        <Button
          size="lg"
          type="button"
          variant="default"
          onClick={approve}
          disabled={!consent.ok}
          data-approve
          data-sign-in
        >
          {`Sign in to ${request.requester.origin}`}
        </Button>
        <Button
          size="lg"
          type="button"
          variant="ghost"
          data-decline
          onClick={() => {
            channel?.refuse('declined');
            setChannelState({ of: 'waiting' });
          }}
        >
          Do not sign in
        </Button>
        <ConsentRefused consent={consent} />
      </div>
    </>
  );
}

/**
 * One screen for a disclosure and for an invitation. A join's rows are a disclosure's rows: the same wants, the same
 * item-by-item approval, the same `rowsFor` and the same rows, so the heading, the wallet sentence, the closing
 * warning and the buttons each come as a pair and are drawn once, and the one section a join adds names the key its
 * answer is sealed to. Two copies of this screen would be two places for the observed origin to stop being shown.
 * What makes a join its own kind is the door its answer leaves by: a disclosure is answered in the clear to the page
 * that asked, an acceptance is sealed (`sealToInbox`, in `midnight-identity/profile/inbox`) to a key the ask carries
 * and is readable by whoever holds it, who need not be that page. A join answered in the clear would leak the
 * receiving address while looking finished.
 */
export function disclosureView(v: AskedScreen<DisclosureRequest | JoinRequest>): ReactNode {
  const { problem, request, rows, missingRequired, whoIsAsking, whichWallet } = v;
  /*
   * **THE JOIN, NARROWED ONCE, HERE.** Everything below renders for both
   * kinds; this is the only handle on the field a join has and the disclosure
   * does not, and it exists so that the render reads `join !== null` rather
   * than re-testing `request.kind` in four places that could drift apart.
   */
  const join = request.kind === 'join' ? request : null;

  return (
    <>
      {/* OBSERVED, NOT CLAIMED, ON THE HEADING AS ON THE BUTTON. A
       * person who skims reads these two and nothing else, so neither may be
       * written in the asker's own words. The disclosure's heading names no
       * origin because it names no party at all; the join's does, because an
       * invitation is FROM somebody and the only party this wallet observed
       * is the page. */}
      {join === null ? (
        <h1>Share your details</h1>
      ) : (
        <h1 data-join-heading>
          {'Accept the invitation from '}
          <span className="font-mono break-all">{request.requester.origin}</span>
        </h1>
      )}

      {whoIsAsking}

      {/*
       * **THE SEAL, SAID BEFORE THE LIST RATHER THAN AFTER IT.**
       *
       * It is not a reassurance and it is not decoration: it is the one fact
       * that makes the rows below different from the same rows on a
       * disclosure. What is approved here does not travel to the page that
       * asked; it travels THROUGH it, readable only by whoever holds this
       * key. **And this wallet cannot check whose key it is** -- the same
       * unchecked-claim shape once accepted for `company` on an unlock, and
       * said out loud there for the same reason.
       *
       * **THE KEY IS SHOWN WHOLE AND NOT AS A FINGERPRINT.** The twenty
       * characters exist so a person can COMPARE a value against one they
       * were told out of band, and nobody is told an inbox key out of band --
       * it is published by the company's software, not read down a phone. A
       * fingerprint here would be a comparison ritual with nothing to compare
       * against, which teaches that checking is theatre. The full value is
       * shown because it is what decides who can read the address, and a
       * thing that decides that is not the protocol's private business.
       */}
      {join !== null && joinSealedTo({ join })}

      {whichWallet(
        join === null ? 'Which wallet is this about' : 'Which wallet you are joining as',
        join === null
          ? 'The details you send are signed by this wallet, so whoever receives them can ' +
              'check that the person telling them these facts is the person they are about ' +
              'to pay.'
          : 'What you send is signed by this wallet, so whoever opens it can check that the ' +
              'person telling them these facts is the person they are about to pay. It is ' +
              'also the wallet any address below is worked out from.'
      )}

      <Section
        list={false}
        box={false}
        aria-label="What they are asking for"
        title="What they are asking for"
        description="Approve each one. Saying no to an optional detail is a normal answer and they are told which ones you declined."
      >
        {problem !== null && (
          <StatusAlert tone="danger" title="Not added">
            {problem}
          </StatusAlert>
        )}
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {rows.map((row) => {
            return rowView({ ...v, row });
          })}
        </ul>
      </Section>

      {/* SAID ONCE, BEFORE, AND IT IS NOT DECORATION. §6.
       *
       * **THE JOIN'S SENTENCE IS THE SAME WARNING AND A DIFFERENT
       * PARTY.** On a disclosure the keeper is the page. On a join it is
       * whoever holds the inbox key, who may not be the page, and naming the
       * page would be this wallet telling somebody the wrong thing about who
       * ends up holding their address. **Sealing is not a smaller warning** --
       * it decides who can read on the way and nothing about what a reader
       * keeps -- so the second half of the sentence does not soften. */}
      {sentWarning({ ...v, join })}

      {/*
       * **A DECLINED ADDRESS ON AN INVITATION IS A CONSEQUENCE, NOT A
       * HINT, AND THE TWO HALVES OF THAT ARE CHOSEN TOGETHER.**
       *
       * `profile/request.ts` refuses an invitation that never ASKS for
       * `receiving-address`, required. This screen still lets the person
       * DECLINE it, because every row here is refusable and a surface with one
       * row that cannot be refused is a surface with a coerced answer (§6).
       * **Those are not in tension: the refusal is about a message this wallet
       * cannot answer, and the decline is about an answer a person is entitled
       * to give.**
       *
       * What that costs is that a person can accept an invitation and send
       * nowhere to be paid, which is honest and is useless to the receiver.
       * **So it is SAID, in the consequence's own words, rather than left to
       * the ordinary muted line** -- which reads *you can send anyway, and
       * they are told what you declined* and is true of a first name and
       * badly wrong here. The alternative was making this one row
       * unrefusable, and that would be the first coerced answer on this
       * surface.
       */}
      {missingRequired.length > 0 && missingNotice({ join, missingRequired })}

      {disclosureButtons({ ...v, join })}
    </>
  );
}
