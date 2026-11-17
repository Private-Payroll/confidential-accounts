import type { ReactNode } from 'react';
import { Button, Card, CardContent, Section } from 'vaults-ui';
import { dustFromSpecks, exactSpecks, exactStars, nightFromStars } from '../chain/amount.js';
import type { SendFacts } from '../chain/send.js';
import { GLYPH, Glyph } from '../glyphs.js';
import { Bytes, PROVING_USUALLY_MS, asClock, shortUnshieldedOrPayee } from './send-parts.js';

/**
 * THE CONFIRMATION — read back from the balanced transaction, and the one
 * place the irreversibility sentence lives. §4: what is shown here is what
 * WILL HAPPEN, not what was typed; where the two could disagree, the engine
 * has already refused rather than let this card render.
 *
 * EVERY ONE OF THOSE SENTENCES IS KEPT AND ONLY WHAT CARRIES THEM CHANGES.
 * The four facts are four labelled rows in the order they were in — to,
 * amount, fee, what the balance becomes — because that is the order somebody
 * checks them in, and reordering it to look better is exactly what
 * the design forbids.
 *
 * TWO SENTENCES SIT BELOW THE CARD AND THEY ARE NOT THE SAME SENTENCE. The
 * first is §4's irreversibility line, said ONCE and only here. The second is
 * the other: how long this will hold somebody on this screen. Both belong BEFORE
 * the button, and neither may be moved after it.
 */
export function ConfirmCard({ facts, owner, onSend, onCancel }: {
  readonly facts: SendFacts;
  readonly owner: string;
  readonly onSend: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  return (
    <Section list={false} box={false} aria-label="Look at what will happen." title="Look at what will happen.">
      <Card>
        <CardContent className="flex flex-col divide-y divide-border">
          <ToFact facts={facts} />
          <AmountFact facts={facts} />
          <FeeFact facts={facts} />
          <AfterFact facts={facts} owner={owner} />
        </CardContent>
      </Card>

      {/* Said ONCE, plainly, BEFORE — and never afterwards. */}
      <p className="m-0 max-w-prose text-sm font-medium text-warn-text">
        Sending cannot be undone. There is no cancel and no refund on a chain —
        money that leaves comes back only if its recipient chooses to return it.
      </p>
      {/* The other thing somebody needs before pressing, and it is a different
        * fact from the one above: how long this will hold them here. */}
      <p className="m-0 max-w-prose text-sm text-muted-foreground">
        Building the proof takes around {asClock(PROVING_USUALLY_MS)} on a laptop and
        longer on a phone, and this screen has to stay open the whole time.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="default" onClick={onSend}>Send it</Button>
        <Button type="button" variant="outline" onClick={onCancel}>Don&rsquo;t send</Button>
      </div>
    </Section>
  );
}

function ToFact({ facts }: { readonly facts: SendFacts }): ReactNode {
  return (
    <Fact label="To">
      <p className="m-0 font-mono text-sm break-all text-foreground">
        {shortUnshieldedOrPayee(facts)}
      </p>
      <p className="m-0 mt-1.5 text-sm text-muted-foreground">
        {facts.kind === 'shielded'
          ? 'A shielded address — a private payment.'
          : 'An unshielded address — an ordinary, visible NIGHT transfer.'}
        {' '}Check <strong className="font-medium text-foreground">both ends</strong> against
        what you were given.
      </p>
      <details className="group mt-2">
        <summary
          className={[
            'inline-flex cursor-pointer list-none items-center gap-1.5 text-sm',
            'text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden',
          ].join(' ')}
        >
          <Glyph
            icon={GLYPH.next}
            className="size-4 transition-transform group-open:rotate-90"
          />
          Show the whole address
        </summary>
        <Bytes>{facts.recipientBech32}</Bytes>
      </details>
    </Fact>
  );
}

function AmountFact({ facts }: { readonly facts: SendFacts }): ReactNode {
  return (
    <Fact label="Amount">
      <p className="m-0 text-3xl tracking-tight font-semibold tabular-nums text-foreground">
        {nightFromStars(facts.stars)}{' '}
        <span className="text-base font-medium text-muted-foreground">tNIGHT</span>
      </p>
      <p className="m-0 mt-1.5 text-sm text-muted-foreground">
        Exactly {exactStars(facts.stars)}.{' '}
        {facts.readBack === 'transaction'
          ? 'Read back out of the built transaction — this is what will actually move.'
          : 'A shielded amount cannot be read back off the transaction — it is '
            + 'encrypted to its recipient, which is the privacy working. This is the '
            + 'one value the transaction was built from; the fee below was read back.'}
      </p>
    </Fact>
  );
}

function FeeFact({ facts }: { readonly facts: SendFacts }): ReactNode {
  return (
    <Fact label="The fee, in DUST">
      <p className="m-0 text-sm text-foreground">
        {dustFromSpecks(facts.feeSpecks)} tDUST
        <span className="text-xs text-muted-foreground"> — exactly {exactSpecks(facts.feeSpecks)}, read
        back from the transaction&rsquo;s own dust spends</span>
      </p>
    </Fact>
  );
}

function AfterFact({ facts, owner }: { readonly facts: SendFacts; readonly owner: string }): ReactNode {
  return (
    <Fact label={`${owner} afterwards`}>
      <p className="m-0 text-sm text-foreground">
        {facts.kind === 'shielded' ? 'Shielded' : 'Unshielded'} NIGHT:{' '}
        {nightFromStars(facts.nightBefore)} →{' '}
        <strong className="font-semibold">{nightFromStars(facts.nightAfter)}</strong>{' '}
        tNIGHT
        <span className="text-xs text-muted-foreground"> ({exactStars(facts.nightAfter)})</span>
      </p>
      <p className="m-0 mt-1 text-sm text-foreground">
        DUST: {dustFromSpecks(facts.dustBefore)} →{' '}
        <strong className="font-semibold">{dustFromSpecks(facts.dustAfter)}</strong>{' '}
        tDUST
        <span className="text-xs text-muted-foreground"> — and it grows back from the registered NIGHT</span>
      </p>
    </Fact>
  );
}

/** One labelled fact on the confirmation. The label is an `h3` under the
 * section's `h2` — the ladder the kit's `Section` sets out. */
function Fact({ label, children }: {
  readonly label: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <h3 className="m-0 mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </h3>
      {children}
    </div>
  );
}
