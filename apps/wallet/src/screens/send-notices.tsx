import type { ReactNode } from 'react';
import { Button, Card, CardContent, Section } from 'vaults-ui';
import { NETWORK } from '../config.js';
import { networkRecord } from '../../../../src/core/networks.js';
import type { ownedAddressFor } from '../accounts/owned-address.js';
import type { RehearsalScenario } from '../chain/rehearsal.js';
import type { SendWiring } from '../chain/send-context.js';
import { StatusBadge } from '../components/status.js';
import { hrefOf } from '../routes.js';
import { Mark } from '../shell/mark.js';
import { PROVING_USUALLY_MS, asClock } from './send-parts.js';

type Mode = 'live' | 'rehearsal';

/** Who is paying: the wallet the money leaves. */
export function PayingWalletCard({ owned }: {
  readonly owned: ReturnType<typeof ownedAddressFor>;
}): ReactNode {
  return (
    <header className="flex flex-col gap-3">
      <h1 className="m-0">Send</h1>
      <Card>
        <CardContent className="flex items-start gap-3">
          <Mark address={owned.address.bech32} account={owned.account} size={32} />
          <div className="min-w-0 flex-1">
            <p className="m-0 text-base font-semibold text-foreground">{owned.name}</p>
            {owned.owner !== owned.name && (
              <p className="m-0 text-xs text-muted-foreground">{owned.slot}</p>
            )}
            <p className="m-0 mt-1 text-sm text-muted-foreground">
              Money leaves <strong className="font-medium text-foreground">{owned.owner}</strong>
              {' '}— the wallet open on{' '}
              <a
                className="text-primary underline-offset-4 hover:underline"
                href={hrefOf('home')}
              >
                the home screen
              </a>
              , where switching happens.
            </p>
          </div>
        </CardContent>
      </Card>
    </header>
  );
}

/** What a real send means, said before anything is pressed. */
export function LiveNotice({ inFlight, switchMode }: {
  readonly inFlight: boolean;
  readonly switchMode: (next: Mode) => void;
}): ReactNode {
  const network = networkRecord(NETWORK).label;
  return (
    <Section
      list={false} box={false}
      aria-label={`This is real. ${network}`}
      title={(
        <span className="flex flex-wrap items-center gap-2">
          This is real.
          <StatusBadge tone="warning">{network}</StatusBadge>
        </span>
      )}
    >
      <Card>
        <CardContent className="flex flex-col gap-3">
          <p className="m-0 text-sm text-muted-foreground">
            Sending here moves real tNIGHT on {network}, pays a real fee in DUST, and
            cannot be taken back. Two hosts can be dialled, and nothing is asked of
            either until you press: checking a payment syncs this wallet from the
            indexer, and sending submits through the {network} node. The proof is
            built in this browser, from circuit key material served by this
            wallet&rsquo;s own origin and verified against pinned fingerprints
            before use — no third party is asked for it.
          </p>
          {/*
            * SAID BEFORE THEY START, NOT AFTER THEY ARE TRAPPED —
            * Somebody who knows this takes a while and
            * needs the screen open can choose their moment; somebody told
            * halfway through a proof can only sit there.
            */}
          <p className="m-0 text-sm text-muted-foreground">
            Proving happens in this browser and can take minutes — the screen keeps
            its own clock and says which stage it is at.{' '}
            <strong className="font-medium text-foreground">
              You have to stay on this screen while it works.
            </strong>{' '}
            The proof is built in this tab and nothing is submitted until it is
            finished, so closing the tab or letting the phone sleep sends nothing —
            it throws the work away and it starts again from the form. Pick a moment
            when you can leave this open for {asClock(PROVING_USUALLY_MS)} or so.
          </p>
          {!inFlight && (
            <p className="m-0">
              <Button type="button" variant="ghost" size="sm" onClick={() => switchMode('rehearsal')}>
                Practise on a pretend chain first
              </Button>
            </p>
          )}
        </CardContent>
      </Card>
    </Section>
  );
}

/** The rehearsal banner, with the scenario picker. */
export function RehearsalNotice({ inFlight, scenario, setScenario, wiring, switchMode }: {
  readonly inFlight: boolean;
  readonly scenario: RehearsalScenario;
  readonly setScenario: (next: RehearsalScenario) => void;
  readonly wiring: SendWiring;
  readonly switchMode: (next: Mode) => void;
}): ReactNode {
  return (
    <Section
      list={false} box={false}
      aria-label="A rehearsal, not a real send rehearsal"
      title={(
        <span className="flex flex-wrap items-center gap-2">
          A rehearsal, not a real send
          <StatusBadge tone="accent">rehearsal</StatusBadge>
        </span>
      )}
    >
      <Card>
        <CardContent className="flex flex-col gap-4">
          <p className="m-0 text-sm text-muted-foreground">
            Everything below runs the real send flow against a{' '}
            <strong className="font-medium text-foreground">
              pretend chain inside this browser
            </strong>{' '}
            — real coin selection, a real fee, and a block that really rejects a
            malformed transaction. Nothing talks to the network and no real money can
            move here.
          </p>
          {/*
            * THE SCENARIO PICKER SURVIVES THE RESTYLE, and the design
            * says why in one sentence: *"a restyle that loses the
            * picker loses the only way anybody has ever seen the dangerous
            * middle."* It is also how those states are photographed.
            *
            * `data-scenarios` replaces the old `send-scenarios` class: the
            * fact under test is that the FIELDSET disables in flight, and
            * a data attribute is a handle rather than a style.
            */}
          <fieldset
            data-scenarios=""
            className={[
              'm-0 flex flex-col gap-1 rounded-md border border-border',
              'bg-muted px-4 pt-2 pb-3 disabled:opacity-55',
            ].join(' ')}
            disabled={inFlight}
          >
            <legend className="px-1 text-xs font-medium text-muted-foreground">What to rehearse</legend>
            <ScenarioChoice
              checked={scenario === 'ordinary'}
              onChoose={() => setScenario('ordinary')}
            >
              A send that works
            </ScenarioChoice>
            <ScenarioChoice
              checked={scenario === 'slow-proving'}
              onChoose={() => setScenario('slow-proving')}
            >
              Slow proving — the proof takes minutes, as it may on the real chain
            </ScenarioChoice>
            <ScenarioChoice
              checked={scenario === 'submission-fails'}
              onChoose={() => setScenario('submission-fails')}
            >
              The worst case — the proof succeeds and the network never answers
            </ScenarioChoice>
          </fieldset>
          {!inFlight && wiring.live && (
            <p className="m-0">
              <Button type="button" variant="ghost" size="sm" onClick={() => switchMode('live')}>
                Back to real sending
              </Button>
            </p>
          )}
        </CardContent>
      </Card>
    </Section>
  );
}

/** One rehearsal scenario. A real radio in a real fieldset — the fieldset is
 * what disables the whole set in one attribute while a send is in flight. */
function ScenarioChoice({ checked, onChoose, children }: {
  readonly checked: boolean;
  readonly onChoose: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm text-foreground">
      <input
        type="radio"
        name="scenario"
        className="size-4 shrink-0 accent-primary"
        checked={checked}
        onChange={onChoose}
      />
      {children}
    </label>
  );
}
