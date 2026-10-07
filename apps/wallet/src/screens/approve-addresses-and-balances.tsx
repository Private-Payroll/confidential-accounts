import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Identity } from 'midnight-identity/keys/derivation';
import type { AddressesAndBalancesRequest } from 'midnight-identity/profile/request';
import type { Channel } from 'midnight-identity/profile/channel';
import {
  AddressesAndBalancesRefused, addressesAndBalancesAnswerFor, type AddressesAndBalancesShown, type HeldAmount, type Visibility,
} from 'midnight-identity/profile/addresses-and-balances';
import { Button, Section } from 'vaults-ui';
import { BalanceEnginesContext } from '../chain/balance-context.js';
import type { BalanceState } from '../chain/balance.js';
import { GIVE_UP_AFTER_MS, NIGHT_RAW } from '../chain/balance.js';
import { NIGHT_UNSHIELDED_RAW } from '../chain/unshielded.js';
import { nightFromStars } from '../chain/amount.js';
import { otherTokenLines, shortColour, smallestUnits } from '../chain/shielded-tokens.js';
import type { OwnedAddress } from '../accounts/owned-address.js';
import { StatusAlert } from '../components/status.js';
import { hrefOf } from '../routes.js';
import type { Consent } from '../framing.js';

/**
 * THE SCREEN FOR A PAGE ASKING WHERE ONE OF THIS PERSON'S WALLETS RECEIVES,
 * AND WHAT IT HOLDS.
 *
 * The page is served by a service that is not trusted with anybody's money, so
 * **nothing about it leaves this wallet without one press here, every time a
 * page asks.** The screen shows exactly what the press hands over: the wallet's
 * private and public receiving addresses, and every token it holds on each
 * side, each marked private or public, with the moment each side was read.
 *
 * **WHAT IT READS IS THE WALLET'S OWN.** The addresses are the chosen wallet's
 * own (`owned`, the one value every other screen here derives from), and the
 * amounts are read by the same balance engines the wallet's own balance screen
 * runs, from the network, when this screen opens. Only a figure read after the
 * screen opened is shown: a side whose engine gives up, or that has not been
 * read within the engines' own give-up time, is shown as not known, and handed
 * over as not known, never as zero. (An engine that replayed a saved figure
 * stops reporting failures, so the screen keeps a clock of its own.)
 *
 * Nothing is signed, and nothing here can pay anything.
 */

/** What one side of the wallet is doing while the screen reads it. */
type Side =
  | { readonly of: 'reading' }
  | { readonly of: 'read'; readonly asOf: number; readonly amounts: readonly HeldAmount[] }
  | { readonly of: 'not-read' };

/** One side's amounts, from its engine's figure: NIGHT under its own identifier, then every other token above zero. */
const amountsOf = (
  visibility: Visibility, nightToken: string, synced: Extract<BalanceState, { name: 'synced' }>,
): readonly HeldAmount[] => [
  { token: nightToken, amount: synced.night.toString(), visibility },
  ...otherTokenLines(synced.others ?? {}).map(([token, amount]) => ({ token, amount: amount.toString(), visibility })),
];

/**
 * **BOTH SIDES OF ONE WALLET, READ AFRESH.** Each engine is started when the
 * screen opens or the wallet changes, and stopped as soon as its side has
 * settled, or when the screen goes. A figure an engine replays from its saved
 * state carries an older moment and is not taken: only one read after this
 * screen opened is.
 */
function useBothSides(identity: Identity, account: number, now: () => number): { private: Side; public: Side } {
  const engines = useContext(BalanceEnginesContext);
  const [sides, setSides] = useState<{ account: number; private: Side; public: Side }>(
    { account, private: { of: 'reading' }, public: { of: 'reading' } });
  useEffect(() => {
    setSides({ account, private: { of: 'reading' }, public: { of: 'reading' } });
    const openedAt = now();
    const stops: (() => void)[] = [];
    const watch = (visibility: Visibility, nightToken: string, start: typeof engines.shielded): void => {
      let settled = false;
      let stop: (() => void) | null = null;
      /* The screen's own deadline: a side not read afresh by then is not known. */
      const deadline = setTimeout(() => settle({ of: 'not-read' }), GIVE_UP_AFTER_MS);
      const settle = (side: Side): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        setSides((was) => (was.account === account ? { ...was, [visibility]: side } : was));
        stop?.();
      };
      stop = start(identity, account, (state) => {
        if (state.name === 'synced' && state.asOf >= openedAt && state.others !== undefined) {
          settle({ of: 'read', asOf: state.asOf, amounts: amountsOf(visibility, nightToken, state) });
        } else if (state.name === 'failed') {
          settle({ of: 'not-read' });
        }
      });
      if (settled) stop();
      stops.push(() => { clearTimeout(deadline); if (!settled) { settled = true; stop?.(); } });
    };
    watch('private', NIGHT_RAW, engines.shielded);
    watch('public', NIGHT_UNSHIELDED_RAW, engines.unshielded);
    return () => { for (const s of stops) s(); };
  }, [engines, identity, account, now]);
  return sides.account === account
    ? { private: sides.private, public: sides.public }
    : { private: { of: 'reading' }, public: { of: 'reading' } };
}

/** What the press hands over, once both sides have settled; null while either is still being read. */
export const shownFrom = (owned: OwnedAddress, sides: { private: Side; public: Side }): AddressesAndBalancesShown | null => {
  if (sides.private.of === 'reading' || sides.public.of === 'reading') return null;
  const asOf = (side: Side): number | null => (side.of === 'read' ? side.asOf : null);
  const amounts = (side: Side): readonly HeldAmount[] => (side.of === 'read' ? side.amounts : []);
  return {
    addresses: { private: owned.address.bech32, public: owned.unshieldedBech32 },
    balances: [...amounts(sides.private), ...amounts(sides.public)],
    read: { private: asOf(sides.private), public: asOf(sides.public) },
  };
};

/** One amount, in words: NIGHT is named; any other token is shown by its smallest units and its identifier. */
const sayAmount = (a: HeldAmount): ReactNode => (a.token === (a.visibility === 'private' ? NIGHT_RAW : NIGHT_UNSHIELDED_RAW)
  ? <>{nightFromStars(BigInt(a.amount))} tNIGHT</>
  : <>{smallestUnits(BigInt(a.amount))} of token <span title={a.token}>{shortColour(a.token)}</span></>);

const moment = (ms: number): string => new Date(ms).toLocaleString();

function SideShown({ visibility, address, side, shown }: {
  readonly visibility: Visibility; readonly address: string; readonly side: Side; readonly shown: AddressesAndBalancesShown | null;
}): ReactNode {
  const title = visibility === 'private' ? 'Private' : 'Public';
  /* What is listed is what the press sends: once both sides are read it is read from the very value the press hands over. */
  const amounts = shown === null
    ? (side.of === 'read' ? side.amounts : [])
    : shown.balances.filter((b) => b.visibility === visibility);
  return (
    <div className="flex flex-col gap-1" data-side={visibility}>
      <p className="m-0 text-sm text-muted-foreground">{`${title} address`}</p>
      <p className="m-0 font-mono break-all text-sm" data-side-address>{address}</p>
      <p className="m-0 text-sm text-muted-foreground">{`${title} balance`}</p>
      {side.of === 'reading' && (
        <p className="m-0 text-sm text-muted-foreground" data-side-reading>Reading this from the network.</p>
      )}
      {side.of === 'not-read' && (
        <p className="m-0 text-sm text-warn-text" data-side-not-read>
          {`This wallet could not read your ${visibility} balance, so the page is told it is not known rather than shown a figure. To try again, close this window and ask again from the page.`}
        </p>
      )}
      {side.of === 'read' && (
        <>
          <ul className="m-0 list-none p-0 text-sm" data-side-amounts>
            {amounts.map((a) => <li key={a.token} data-token={a.token}>{sayAmount(a)}</li>)}
          </ul>
          <p className="m-0 text-xs text-muted-foreground" data-side-as-of>{`As of ${moment(side.asOf)}`}</p>
        </>
      )}
    </div>
  );
}

type Stage = { of: 'ready' } | { of: 'refused'; says: string } | { of: 'sent'; at: number; shown: AddressesAndBalancesShown };

/** One side as it was handed over, for the screen that says what went. */
const sideSent = (shown: AddressesAndBalancesShown, visibility: Visibility): Side => {
  const asOf = shown.read[visibility];
  return asOf === null ? { of: 'not-read' } : { of: 'read', asOf, amounts: shown.balances.filter((b) => b.visibility === visibility) };
};

export function ApproveAddressesAndBalances({
  request, identity, owned, channel, consent, whoIsAsking, whichWallet, onDecline, onBusy, now = Date.now,
}: {
  readonly request: AddressesAndBalancesRequest;
  readonly identity: Identity;
  /** The wallet chosen on screen: its addresses are the ones shown and sent. */
  readonly owned: OwnedAddress;
  readonly channel: Channel | null;
  readonly consent: Consent;
  readonly whoIsAsking: ReactNode;
  readonly whichWallet: ReactNode;
  readonly onDecline: () => void;
  /** Told when the wallet may no longer be changed: once the page has its answer. */
  readonly onBusy?: (locked: boolean) => void;
  readonly now?: () => number;
}): ReactNode {
  const [stage, setStage] = useState<Stage>({ of: 'ready' });
  const sides = useBothSides(identity, owned.account, now);
  const shown = shownFrom(owned, sides);
  /* Focus follows the press to what it did, so a keyboard or screen-reader user is told. */
  const sentHeading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { if (stage.of === 'sent') sentHeading.current?.focus(); }, [stage.of]);

  /* The press hands over `shown` - the value this render listed - and nothing else. */
  const show = useCallback((): void => {
    if (!consent.ok || stage.of !== 'ready' || channel === null || shown === null) return;
    try {
      const at = now();
      const sent = channel.answer(addressesAndBalancesAnswerFor(request, shown, at));
      if (sent === false) {
        setStage({ of: 'refused', says: 'This page had already been answered, so nothing more was shown to it. Close this window and ask again from the page.' });
        return;
      }
      onBusy?.(true);
      setStage({ of: 'sent', at, shown });
    } catch (e) {
      setStage({
        of: 'refused',
        says: e instanceof AddressesAndBalancesRefused
          ? 'This wallet could not finish reading your balances, so nothing has been shown to the page. Close this window and ask again from the page.'
          : 'Nothing has been shown to the page. Close this window and ask again from the page.',
      });
    }
  }, [consent, stage, channel, shown, now, request, onBusy]);

  if (stage.of === 'sent') {
    /* What went, as it went: the answer is kept with the stage, and a later reading never changes this screen. */
    return (
      <>
        <h1 ref={sentHeading} tabIndex={-1} data-shown-heading>{`You showed ${request.requester.origin} your wallet’s addresses and balances`}</h1>
        <p className="lede" data-shown>
          {`On ${moment(stage.at)} this wallet showed the page the addresses and balances below. Nothing was signed and nothing was paid.`}
        </p>
        <SideShown visibility="private" address={stage.shown.addresses.private} side={sideSent(stage.shown, 'private')} shown={stage.shown} />
        <SideShown visibility="public" address={stage.shown.addresses.public} side={sideSent(stage.shown, 'public')} shown={stage.shown} />
        <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('home')}>&larr; Your wallet</a></p>
      </>
    );
  }

  return (
    <>
      <h1 data-headline>{`Show ${request.requester.origin} your wallet’s addresses and balances`}</h1>
      {stage.of === 'refused' && (
        <StatusAlert tone="danger" title="Nothing was shown to the page">
          <p className="m-0" data-addresses-refused>{stage.says}</p>
        </StatusAlert>
      )}
      {whichWallet}
      <Section
        list={false} box={false} aria-label="What the page will see" title="What the page will see"
        description="Exactly this, and only after you press. The page can keep it."
      >
        <SideShown visibility="private" address={owned.address.bech32} side={sides.private} shown={shown} />
        <SideShown visibility="public" address={owned.unshieldedBech32} side={sides.public} shown={shown} />
        <p className="m-0 text-sm text-muted-foreground" data-nothing-signed>
          Nothing is signed, and nothing can be paid with this. The page cannot see your private balance unless you press
          Show them, and once it has both addresses it can tell they belong to the same person.
        </p>
      </Section>
      {whoIsAsking}
      <div className="flex flex-wrap gap-2">
        <Button
          size="lg" type="button" variant="default" onClick={show} data-approve data-show-addresses
          disabled={!consent.ok || stage.of !== 'ready' || channel === null || shown === null}
        >
          Show them
        </Button>
        <Button size="lg" type="button" variant="ghost" data-decline onClick={onDecline}>
          Do not show them
        </Button>
      </div>
    </>
  );
}
