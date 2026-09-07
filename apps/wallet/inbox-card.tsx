import type { ReactNode } from 'react';
import type { Notice, NoticeKind, Opening } from 'midnight-identity/profile/inbox';
import { POLL_EVERY_MS } from 'midnight-identity/profile/inbox-poll';
import { refreshInbox, useInbox } from './inbox-live.js';
import type { InboxSnapshot } from './inbox-live.js';
import { CopyButton } from './ui.js';
import {
  Alert, Button, Card, CardContent, CardDescription, CardFooter, CardHeader,
  CardTitle, EmptyState, GLYPH,
} from './kit/index.js';

/**
 * WHAT IS WAITING FOR YOU SOMEWHERE ELSE.
 *
 * ── THIS CARD IS NOT AN APPROVAL SURFACE AND IT MUST NOT LOOK LIKE ONE ────
 *
 * `profile/inbox.ts`'s boundary block is the reason, and it is worth having the
 * consequence written where the pixels are: **an inbox item carries no ask**,
 * because an observed origin cannot be produced by a channel nobody opened. So
 * everything on this card is a REPORT and nothing on it is a decision. Four
 * things keep it that way, and all four are deliberate rather than incidental:
 *
 *   1. **NO ROW IS PRESSABLE.** A notice is a `div`, not a `ListRow` with an
 *      `onClick` and not a link. There is nothing to press because there is
 *      nothing here that could be agreed to.
 *   2. **THE ONLY BUTTON ON THE CARD ASKS THE HOST**, and it is the refresh
 *      control the agreement requires. It changes nothing anybody else can see.
 *   3. **EVERY ROW SAYS WHERE TO GO AND THAT THIS WALLET HAS NOT CHECKED IT.**
 *      The sentence is on the row, not in a footnote.
 *   4. **THIS WALLET DOES NOT LINK TO A SENDER'S ORIGIN.** `screens/approve.tsx`
 *      prints an origin as monospace text at every one of its thirty sites and
 *      links to none of them; here the reason is stronger, because the origin
 *      arrived inside a blob a stranger sealed. **A wallet that offers a button
 *      to a stranger's address is a wallet that helps somebody land on the wrong
 *      one.** It is text, whole, beside a copy control.
 *
 * ── NOTHING A SENDER SUPPLIES IS DRAWN AS MARKUP ──────────────────────────
 *
 * The same rule enforced on the approval surface, with the same mutation
 * behind it (mutation 05). `from.name`, `says` and
 * `where` are the sender's own words and every one of them is a text child of
 * an element. There is no `dangerouslySetInnerHTML` on this path and a test
 * fails the moment there is.
 *
 * ── AND THE SENTENCE THAT IS HALF THE POINT OF THE CHANGE ──────────────────
 *
 * THE RULE: *"THE SCREEN SAYS WHAT THE HOST LEARNS… Not a privacy
 * policy, not a tooltip: a sentence where the thing happens."* The model is
 * `screens/home.tsx:427`'s balance footer — *"asks the indexer at
 * {INDEXER_HOST}, which learns this wallet's addresses"* — and this is the same
 * sentence for a thing that asks on a timer instead of on a press, so it has
 * more to admit: the cadence, that the host cannot read the contents, that it
 * learns when you look and how often, **that every company writes to ONE
 * address so the host can tell they are all writing to the same person**, and
 * that nothing is asked when the wallet is shut. The last of those five is the
 * one the opaque-per-company round removes, and it is named here so that round
 * has a sentence to delete rather than a property to discover.
 */

/**
 * ONE SENTENCE PER KIND, LOOKED UP BY NAME.
 *
 * `Record<NoticeKind, string>` rather than a `switch`: a kind added to
 * `NOTICE_KINDS` with no sentence is a typecheck failure here, not a blank row
 * on somebody's screen. `inbox-card.test.tsx` also walks `NOTICE_KINDS` and
 * asserts every one of them has an entry, so the property survives a `Record`
 * being loosened.
 */
export const NOTICE_SAYS: Record<NoticeKind, string> = {
  invitation: 'A company has invited you to join it.',
  proposal: 'A payment is waiting for someone to approve it.',
  seat: 'You have been made a signer.',
};

const asMoment = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });

/**
 * ONE NOTICE. Every field on it is the sender's, and the row says so rather
 * than leaving a person to assume this wallet checked any of it.
 */
function NoticeRow({ notice }: { readonly notice: Notice }): ReactNode {
  return (
    <div className="rounded-tight border border-line p-3" data-notice={notice.kind}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink">{NOTICE_SAYS[notice.kind]}</span>
        {/* CLAIMED, and said so. The sender's clock, not this browser's. */}
        <span className="text-xs text-faint">said to be from {asMoment(notice.at)}</span>
      </div>
      {/* TEXT CHILDREN. The sender's own words about itself — the rule,
        * which the approval surface applies to `requester.name`: a claim is
        * never drawn larger than a fact, and here there is no fact to draw. */}
      <p className="mb-0 mt-2 text-sm text-ink">
        {notice.from.name} <span className="text-faint">({notice.from.rdns})</span> says this
        is waiting for you.
      </p>
      {notice.says !== undefined && (
        <p className="mb-0 mt-1 text-sm text-muted">{notice.says}</p>
      )}
      <p className="mb-0 mt-2 text-xs text-muted" data-go-there-yourself>
        Nothing here approves anything and nothing has been sent. To act on it, go to
        this address yourself — this wallet has not checked that it belongs to whoever
        wrote to you, and does not link to it:
      </p>
      <p className="mb-0 mt-1 flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm break-all" data-notice-where>{notice.where}</span>
        <CopyButton text={notice.where} label="Copy the address" copied="Copied" />
      </p>
    </div>
  );
}

/**
 * AN ITEM NOBODY CAN OPEN. **REPORTED, NEVER DROPPED.**
 *
 * *"Could not read and nothing there are different facts and must not be
 * merged. A person with an item nobody can open should be told, not shown an
 * empty list."* `openAll` returns one entry per item so that this row exists to
 * be rendered; this is the half a person sees.
 */
function UnopenableRow({ opening }: {
  readonly opening: Extract<Opening, { of: 'unopenable' }>;
}): ReactNode {
  return (
    <Alert tone="warning" title="Something is here that this wallet cannot open" role={null}>
      <p className="m-0 text-sm" data-unopenable-why>{opening.why}</p>
      <p className="m-0 text-sm text-muted">
        It is not being hidden and it is not empty — it is here, and this wallet could
        not read it. The host cannot read it either.
      </p>
      <p className="m-0 text-xs text-faint">
        The host calls it <span className="font-mono break-all">{opening.id}</span>, which
        is the host&rsquo;s own reference and not anything the sender wrote.
      </p>
    </Alert>
  );
}

/**
 * THE SENTENCE. See the header. It is in the footer of the card that does the
 * asking, beside the control that asks on purpose, and nowhere else.
 */
function WhatTheHostLearns({ host }: { readonly host: string }): ReactNode {
  const seconds = Math.round(POLL_EVERY_MS / 1000);
  return (
    <p className="m-0 text-xs text-muted" data-what-the-host-learns>
      While this wallet is open it asks {host} for your inbox about every {seconds} seconds,
      and <em>Check now</em> asks again. {host} cannot read a word of what it holds — every
      item is sealed to this wallet and opened here. What it does learn is when you look and
      how often, and that everything written to you is written to one address, so it can
      tell that every company writing to you is writing to the same person. Nothing is
      asked when the wallet is shut.
    </p>
  );
}

/** Split out so the card renders one thing per state and nothing decides twice. */
function Body({ view }: { readonly view: InboxSnapshot['view'] }): ReactNode {
  if (view.of === 'no-host') {
    return (
      /* `EmptyState` puts its children inside its own `<p>` (`kit/empty-state.tsx`),
       * so the words go in as text rather than as a second paragraph. */
      <EmptyState icon={GLYPH.inbox} title="Nothing is being asked">
        This build has no inbox host. Nothing is polled, nothing is sent, and there is
        nowhere for an item to come from — which is a different thing from an inbox that
        is empty, and a different thing again from a host that did not answer.
      </EmptyState>
    );
  }
  if (view.of === 'never-asked') {
    return <p className="m-0 text-sm text-muted">Not asked yet.</p>;
  }
  if (view.of === 'asking') {
    return <p className="m-0 text-sm text-muted">Asking&hellip;</p>;
  }
  if (view.of === 'failed') {
    return (
      <Alert tone="danger" title="The inbox could not be reached" role={null}>
        <p className="m-0 text-sm">{view.why}</p>
        <p className="m-0 text-sm text-muted">
          This is not an empty inbox. It is a question that got no answer, so nothing is
          known either way about what is waiting.
        </p>
      </Alert>
    );
  }
  if (view.openings.length === 0) {
    return (
      <EmptyState icon={GLYPH.inbox} title="Nothing is waiting">
        Asked at {asMoment(view.at)} and the host held nothing for you.
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {view.openings.map((opening, at) => (
        <div key={`${opening.id}-${String(at)}`}>
          {opening.of === 'notice'
            ? <NoticeRow notice={opening.notice} />
            : <UnopenableRow opening={opening} />}
        </div>
      ))}
      <p className="m-0 text-xs text-faint">Asked at {asMoment(view.at)}.</p>
    </div>
  );
}

export function InboxCard(): ReactNode {
  const { view, host } = useInbox();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Waiting for you elsewhere</CardTitle>
        <CardDescription>
          Sealed notices that something is waiting. Nothing on this card approves
          anything — each one names a place to go, and the approval happens there.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Body view={view} />
      </CardContent>
      <CardFooter className="flex flex-col items-start gap-2">
        {host === null
          ? (
            <p className="m-0 text-xs text-muted" data-no-host-yet>
              When an inbox host exists, this is where this card will name it and say what
              it learns by being asked.
            </p>
          )
          : (
            <>
              <Button size="sm" onClick={() => { refreshInbox(); }}>Check now</Button>
              <WhatTheHostLearns host={host} />
            </>
          )}
      </CardFooter>
    </Card>
  );
}
